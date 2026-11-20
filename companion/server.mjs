import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transcribeChunk, checkWhisperHealth } from './asr.mjs';
import { SiwcManager } from './siwc.mjs';
import {
  translateBatchWithChatGptPlan,
  requireTargetLanguage,
  translateBatchSimulated,
} from './translator.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.COMPANION_PORT || 17864);
const WHISPER_URL = process.env.WHISPER_SERVER_URL || 'http://127.0.0.1:8178';

export const EXTENSION_ORIGIN = 'chrome-extension://biahghfnkaenlchallpkncbmomlickfd';

function allowedOrigins(storeId) {
  const origins = new Set([EXTENSION_ORIGIN]);
  if (storeId !== undefined && storeId !== '') {
    if (!/^[a-p]{32}$/.test(storeId)) throw new Error('Invalid Chrome Web Store item ID');
    origins.add('chrome-extension://' + storeId);
  }
  return origins;
}

function setCorsHeaders(req, res, origins) {
  if (origins.has(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-YT-Client, X-YT-Pair, X-Test-Simulated-Translation');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function loadOrCreatePairingCode(configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(configDir, 'pairing.json');
  if (fs.existsSync(filePath)) {
    if (!fs.lstatSync(filePath).isFile()) throw new Error('Pairing file must be a regular file');
    const { pairingCode } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof pairingCode !== 'string' || !/^[a-f0-9]{64}$/.test(pairingCode)) {
      throw new Error('Invalid pairing file');
    }
    fs.chmodSync(filePath, 0o600);
    return pairingCode;
  }
  const pairingCode = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(filePath, JSON.stringify({ pairingCode }) + '\n', { mode: 0o600, flag: 'wx' });
  return pairingCode;
}

function pairingMatches(supplied, expected) {
  if (typeof supplied !== 'string') return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

function clientAbortSignal(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function renderCallbackPage({ ok, title, message, account }) {
  const color = ok ? '#10b981' : '#ef4444';
  const subInfo = account
    ? `<p class="meta">Account: <strong>${escapeHtml(account.email || account.subject)}</strong> · ChatGPT Plan Usage: <strong>${account.planUsageEnabled ? 'Enabled' : 'Not enabled'}</strong></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f1117; color: #f3f4f6; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { max-width: 440px; padding: 28px; border-radius: 14px; background: #181c26; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 20px 50px rgba(0,0,0,0.45); }
    .badge { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${color}; margin-right: 8px; }
    h1 { font-size: 18px; margin: 0 0 10px; display: flex; align-items: center; }
    p { font-size: 14px; line-height: 1.5; color: #cbd5e1; margin: 8px 0; }
    .meta { font-size: 13px; color: #94a3b8; }
    a { color: #6ee7b7; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span class="badge"></span>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${subInfo}
    <p class="meta">You can close this tab and return to YouTube and the extension popup.</p>
  </div>
</body>
</html>`;
}

export function createCompanionServer(options = {}) {
  const origins = allowedOrigins(options.storeExtensionId ?? process.env.YT_SUB_STORE_EXTENSION_ID);
  const siwc = options.siwc || new SiwcManager();
  const pairingCode = options.pairingCode || loadOrCreatePairingCode(siwc.configDir);
  const whisperUrl = options.whisperUrl || WHISPER_URL;
  const allowSimulated =
    options.allowSimulated ?? process.env.ALLOW_SIMULATED_TRANSLATION === '1';

  let activePort = options.port || DEFAULT_PORT;

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(req, res, origins);

    const addr = server.address();
    if (addr && typeof addr === 'object' && addr.port) activePort = addr.port;
    if (req.headers.host !== `${HOST}:${activePort}` || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      sendJson(res, 403, { error: 'host_not_allowed' });
      return;
    }
    const url = new URL(req.url, `http://${HOST}:${activePort}`);
    const publicGet = req.method === 'GET' && ['/health', '/auth/callback'].includes(url.pathname);
    if (!publicGet && !origins.has(req.headers.origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!publicGet && (req.method !== 'POST' || req.headers['x-yt-client'] !== '1')) {
      sendJson(res, 403, { error: 'extension_request_required' });
      return;
    }
    if (!publicGet && !pairingMatches(req.headers['x-yt-pair'], pairingCode)) {
      sendJson(res, 403, { error: 'pairing_required' });
      return;
    }
    if (req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      sendJson(res, 415, { error: 'json_required' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const whisper = await checkWhisperHealth(whisperUrl);
        sendJson(res, 200, {
          ok: true,
          port: activePort,
          application: 'lookahead-subtitles',
          pairingRequired: true,
          whisper,
          simulatedTranslationAllowed: allowSimulated,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/start') {
        const body = await readJsonBody(req);
        const accountKey = body.accountKey || null;
        const forceReconsent = body.forceReconsent === true;
        const { authUrl } = await siwc.startAuthorization({
          port: activePort,
          accountKey,
          forceReconsent,
        });
        sendJson(res, 200, { authUrl });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        try {
          const account = await siwc.handleCallback(url);
          if (account.planUsageEnabled) {
            sendHtml(
              res,
              200,
              renderCallbackPage({
                ok: true,
                title: "You're using your ChatGPT plan",
                message:
                  'Eligible subtitle translations in YouTube Lookahead Subtitles will use your ChatGPT plan. You can manage usage anytime in ChatGPT settings.',
                account,
              })
            );
          } else {
            sendHtml(
              res,
              200,
              renderCallbackPage({
                ok: false,
                title: 'Signed in without ChatGPT plan usage',
                message:
                  'Your identity sign-in succeeded, but permission to use your ChatGPT plan (chatgpt.tokens.use.direct) was not granted. Enable ChatGPT plan usage from the extension popup to translate subtitles.',
                account,
              })
            );
          }
        } catch (err) {
          sendHtml(
            res,
            400,
            renderCallbackPage({
              ok: false,
              title: 'Sign in with ChatGPT did not complete',
              message: err.message || 'Authorization failed.',
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/status') {
        const body = await readJsonBody(req);
        const status = siwc.getPublicStatus();
        let models = [];
        let modelsError = null;
        if (
          body.includeModels === true &&
          status.activeAccount?.signedIn &&
          status.activeAccount?.planUsageEnabled
        ) {
          try {
            models = await siwc.listModels(status.activeAccountKey);
          } catch (err) {
            modelsError = { code: err.code || 'models_error', message: err.message };
          }
        }
        sendJson(res, 200, {
          ...siwc.getPublicStatus(),
          models,
          modelsError,
          simulatedTranslationAllowed: allowSimulated,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/models') {
        const body = await readJsonBody(req);
        const accountKey = body.accountKey || null;
        const models = await siwc.listModels(accountKey);
        sendJson(res, 200, { models });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/confirm-welcome') {
        const body = await readJsonBody(req);
        sendJson(res, 200, siwc.confirmWelcome(body.accountKey || null));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/select-account') {
        const body = await readJsonBody(req);
        sendJson(res, 200, siwc.selectAccount(body.accountKey));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/select-model') {
        const body = await readJsonBody(req);
        sendJson(res, 200, siwc.selectModel(body.model, body.accountKey || null));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/signout') {
        const body = await readJsonBody(req);
        const result = await siwc.signOut(body.accountKey || null);
        sendJson(res, 200, { ...result, status: siwc.getPublicStatus() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/asr') {
        const body = await readJsonBody(req);
        if (!body.pcmBase64 || typeof body.pcmBase64 !== 'string') {
          sendJson(res, 400, { error: 'missing_pcmBase64' });
          return;
        }
        const signal = clientAbortSignal(res);

        const result = await transcribeChunk({
          pcmBase64: body.pcmBase64,
          pcmFormat: body.pcmFormat || 'i16',
          sampleRate: Number(body.sampleRate || 16000),
          chunkStartMediaTime: Number(body.chunkStartMediaTime || 0),
          chunkEndMediaTime: Number(body.chunkEndMediaTime || 0),
          playbackRate: Number(body.playbackRate || 1.0),
          prompt: body.prompt || '',
          language: body.language || 'auto',
          detectOnly: body.detectOnly === true,
          whisperUrl,
          signal,
        });

        sendJson(res, 200, {
          videoId: body.videoId || null,
          generationId: body.generationId ?? null,
          chunkId: body.chunkId ?? null,
          ...result,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/translate') {
        const body = await readJsonBody(req);
        const lines = Array.isArray(body.lines) ? body.lines : [];
        const contextLines = Array.isArray(body.contextLines) ? body.contextLines : [];
        const followingLines = Array.isArray(body.followingLines) ? body.followingLines : [];
        const targetLanguage = requireTargetLanguage(body.targetLanguage);
        if (lines.length === 0) {
          sendJson(res, 400, { error: 'missing_lines', inferenceAttempted: false });
          return;
        }

        const signal = clientAbortSignal(res);

        const simHeader = req.headers['x-test-simulated-translation'] === '1';
        if (allowSimulated && simHeader) {
          const simRes = await translateBatchSimulated({
            lines,
            signal,
          });
          sendJson(res, 200, {
            videoId: body.videoId || null,
            generationId: body.generationId ?? null,
            ...simRes,
          });
          return;
        }

        try {
          const trRes = await translateBatchWithChatGptPlan({
            siwc,
            accountKey: body.accountKey || null,
            model: body.model || null,
            lines,
            contextLines,
            followingLines,
            targetLanguage,
            signal,
          });
          sendJson(res, 200, {
            videoId: body.videoId || null,
            generationId: body.generationId ?? null,
            ...trRes,
          });
        } catch (err) {
          if (err.name === 'AbortError') return;
          const status = err.status || (err.code === 'not_signed_in' || err.code === 'reauth_required' ? 401 : err.code === 'plan_usage_not_enabled' ? 403 : 502);
          sendJson(res, status, {
            error: err.code || 'translation_failed',
            message: err.message,
            param: err.param || null,
            requestId: err.requestId || null,
            responseId: err.responseId || null,
            usage: err.usage || null,
            usageAccount: err.usageAccount || null,
            inferenceAttempted: err.inferenceAttempted === true,
            manageUsageUrl: 'https://chatgpt.com/settings/usage',
          });
        }
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      const status = err.status || (err instanceof SyntaxError ? 400 : 500);
      sendJson(res, status, {
        error: err.code || 'internal_error',
        message: err.message,
        inferenceAttempted: err.inferenceAttempted === true,
      });
    }
  });

  return { server, siwc, pairingCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, pairingCode } = createCompanionServer();
  server.listen(DEFAULT_PORT, HOST, () => {
    const addr = server.address();
    console.log(`[companion] listening on http://${HOST}:${addr.port}`);
    console.log(`Pairing code (paste into the extension): ${pairingCode}`);
  });
}
