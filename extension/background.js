import { companionRequest } from './companion-client.js';
import './subtitle-languages.js';
const { normalizeTargetLanguage } = globalThis.YTSubtitleLanguages;

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const activeRequestsByTab = new Map(); // tabId -> Map<requestId, { generationId, controller }>
// Only listen for a caption resource during a user-initiated track lookup.
const captionLookups = new Map();
const captionLookupMs = 8000;

const usageStorageKey = 'subtitleTokenMeter';
let meterState = { videos: {}, epochs: {}, meters: {} };
let meterSerial = Promise.resolve();
const meterReady = chrome.storage.session.get(usageStorageKey).then(stored => {
  if (stored[usageStorageKey]) meterState = stored[usageStorageKey];
}).catch(() => {});
const accountByTab = new Map();
const closedTabs = new Set();

async function accountFingerprint(accountKey) {
  if (typeof accountKey !== 'string' || !accountKey) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountKey));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function videoFromUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.youtube.com' && url.pathname === '/watch'
      ? url.searchParams.get('v') : null;
  } catch { return null; }
}

function meterScope(tabId, videoId) {
  if (meterState.videos[tabId] !== videoId) {
    meterState.videos[tabId] = videoId;
    meterState.epochs[tabId] = (meterState.epochs[tabId] || 0) + 1;
  }
  return { tabId, videoId, epoch: meterState.epochs[tabId] || 0 };
}

function validUsage(value) {
  if (!value || ![value.inputTokens, value.outputTokens, value.totalTokens]
      .every(number => Number.isSafeInteger(number) && number >= 0) ||
      value.totalTokens !== value.inputTokens + value.outputTokens) return null;
  return value;
}

async function recordTokenUsage(scope, account, result, fallbackId) {
  if (closedTabs.has(scope.tabId) || !account) return;
  await meterReady;
  meterSerial = meterSerial.catch(() => {}).then(async () => {
    if (closedTabs.has(scope.tabId)) return;
    const key = JSON.stringify([scope.tabId, scope.epoch, scope.videoId, account]);
    const meter = meterState.meters[key] ||= {
      videoId: scope.videoId, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, requests: 0, unknownRequests: 0, cachedDetailsMissing: false, seen: [], pending: {},
    };
    meter.pending ||= {};
    const pending = meter.pending[fallbackId];
    const id = result?.responseId || result?.requestId || fallbackId;
    const excluded = result?.simulated || result?.replayed || result?.inferenceAttempted === false;
    if (excluded || meter.seen.includes(id)) {
      if (pending) {
        meter.requests--;
        meter.unknownRequests--;
        delete meter.pending[fallbackId];
      }
      await chrome.storage.session.set({ [usageStorageKey]: meterState });
      return;
    }
    if (meter.seen.includes(fallbackId)) return;
    if (!pending) {
      meter.pending[fallbackId] = true;
      meter.requests++;
      meter.unknownRequests++;
    }
    // Persist an unknown request before submission so suspension cannot erase
    // usage that the provider may still be processing.
    if (!result?.pending) {
      delete meter.pending[fallbackId];
      meter.seen.push(id);
      if (id !== fallbackId) meter.seen.push(fallbackId);
      const usage = validUsage(result?.usage);
      if (usage) {
        meter.unknownRequests--;
        meter.inputTokens += usage.inputTokens;
        meter.outputTokens += usage.outputTokens;
        meter.totalTokens += usage.totalTokens;
        if (Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens >= 0 &&
            usage.cachedInputTokens <= usage.inputTokens) meter.cachedInputTokens += usage.cachedInputTokens;
        else meter.cachedDetailsMissing = true;
      }
    }
    await chrome.storage.session.set({ [usageStorageKey]: meterState });
  });
  await meterSerial;
}

async function readTokenUsage(tab, videoId) {
  await meterReady;
  const status = await companionRequest('/api/auth/status', { method: 'POST', body: {} });
  const account = await accountFingerprint(status.data?.activeAccount?.accountKey);
  if (!status.ok || !status.data?.activeAccount?.signedIn || !account) return null;
  const scope = meterScope(tab.id, videoId);
  await meterSerial;
  const key = JSON.stringify([tab.id, scope.epoch, videoId, account]);
  const meter = meterState.meters[key];
  if (!meter) return { videoId, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cachedInputTokens: 0, requests: 0, unknownRequests: 0, partial: false };
  const { seen, pending, cachedDetailsMissing, ...summary } = meter;
  return { ...summary, cachedInputTokens: cachedDetailsMissing ? null : meter.cachedInputTokens,
    partial: meter.unknownRequests > 0 };
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  captionLookups.delete(tabId);
  meterReady.then(() => {
    const videoId = videoFromUrl(change.url);
    meterScope(tabId, videoId);
    accountByTab.delete(tabId);
    return chrome.storage.session.set({ [usageStorageKey]: meterState });
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  closedTabs.add(tabId);
  captionLookups.delete(tabId);
  accountByTab.delete(tabId);
  abortTabRequests(tabId);
  meterReady.then(async () => {
    await meterSerial;
    delete meterState.videos[tabId];
    delete meterState.epochs[tabId];
    for (const key of Object.keys(meterState.meters)) {
      if (JSON.parse(key)[0] === tabId) delete meterState.meters[key];
    }
    await chrome.storage.session.set({ [usageStorageKey]: meterState });
  }).catch(() => {});
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const u = new URL(details.url);
      const vid = u.searchParams.get('v');
      const lookup = captionLookups.get(details.tabId);
      if (!lookup || lookup.videoId !== vid || u.pathname !== '/api/timedtext' || u.searchParams.has('tlang')) return;
      const list = lookup.entries;
      const entry = {
        url: details.url,
        lang: u.searchParams.get('lang') || '',
        kind: u.searchParams.get('kind') || '',
        capturedAt: Date.now(),
      };
      const filtered = list.filter((item) => item.lang !== entry.lang || item.kind !== entry.kind);
      filtered.unshift(entry);
      const trimmed = filtered.slice(0, 6);
      lookup.entries = trimmed;
    } catch {}
  },
  { urls: ['https://www.youtube.com/api/timedtext*'] }
);

function registerTabAbort(tabId, generationId, controller) {
  if (typeof tabId !== 'number') return () => {};
  if (!activeRequestsByTab.has(tabId)) {
    activeRequestsByTab.set(tabId, new Map());
  }
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRequestsByTab.get(tabId).set(reqId, { generationId, controller });
  return () => {
    activeRequestsByTab.get(tabId)?.delete(reqId);
  };
}

function abortTabRequests(tabId, keepGenerationId = null) {
  const map = activeRequestsByTab.get(tabId);
  if (!map) return;
  for (const [reqId, entry] of map.entries()) {
    if (keepGenerationId === null || entry.generationId !== keepGenerationId) {
      try {
        entry.controller.abort();
      } catch {}
      map.delete(reqId);
    }
  }
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture and synchronize delayed tab audio for look-ahead subtitle ASR.',
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;

  if (message.target === 'content-relay' && sender.url === chrome.runtime.getURL('offscreen.html') && typeof message.tabId === 'number') {
    chrome.tabs.sendMessage(message.tabId, {
      from: 'offscreen-audio',
      payload: message.payload,
    }).catch(() => {});
    return false;
  }

  if (message.target === 'background') {
    (async () => {
      const popup = sender.url === chrome.runtime.getURL('popup.html');
      const playerVideo = sender.frameId === 0 && sender.tab ? videoFromUrl(sender.url) : null;
      if (message.action === 'getPreferences') {
        if (!popup && !playerVideo) throw new Error('Unexpected preference source');
        const stored = await chrome.storage.local.get(['lookAheadMode', 'targetLanguage']);
        sendResponse({ ok: true, preferences: { lookAheadMode: stored.lookAheadMode === 'extended' ? 'extended' : 'balanced', targetLanguage: normalizeTargetLanguage(stored.targetLanguage) || 'ko' } });
        return;
      }
      if (message.action === 'getTokenUsage') {
        if (!popup && !playerVideo) throw new Error('Unexpected usage source');
        const [tab] = popup ? await chrome.tabs.query({ active: true, currentWindow: true }) : [sender.tab];
        const videoId = popup ? videoFromUrl(tab?.url) : playerVideo;
        if (!videoId || message.payload?.videoId && message.payload.videoId !== videoId) {
          sendResponse({ ok: true, usage: null }); return;
        }
        sendResponse({ ok: true, usage: await readTokenUsage(tab, videoId) });
        return;
      }

      if (!sender.tab || sender.frameId !== 0 || new URL(sender.url).origin !== 'https://www.youtube.com') {
        throw new Error('Unexpected message source');
      }

      switch (message.action) {
        case 'companionFetch': {
          const { path, method, body, generationId = null } = message.payload;
          if (method !== 'POST' || !['/api/translate', '/api/asr', '/api/auth/status'].includes(path)) {
            throw new Error('Unknown player action');
          }
          const videoId = videoFromUrl(sender.url);
          if (path !== '/api/auth/status' && body?.videoId !== videoId) throw new Error('Video scope mismatch');
          await meterReady;
          const scope = meterScope(sender.tab.id, videoId);
          const requestMeterId = crypto.randomUUID();
          let requestAccount = accountByTab.get(sender.tab.id) || null;
          let requestBody = body;
          const controller = new AbortController();
          const cleanup = registerTabAbort(sender.tab?.id, generationId, controller);
          let inferenceSubmitted = false;
          try {
            if (path === '/api/translate') {
              // Bind the inference and its meter to the same selected account, even if
              // the popup changes accounts while the local request is in flight.
              const auth = await companionRequest('/api/auth/status', { method: 'POST', body: {}, signal: controller.signal });
              const accountKey = body.accountKey || auth.data?.activeAccount?.accountKey;
              requestAccount = await accountFingerprint(accountKey);
              if (accountKey) requestBody = { ...body, accountKey };
            }
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            inferenceSubmitted = path === '/api/translate';
            if (inferenceSubmitted) {
              await recordTokenUsage(scope, requestAccount, { pending: true }, requestMeterId).catch(() => {});
            }
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const result = await companionRequest(path, {
              method, body: path === '/api/auth/status' ? {} : requestBody, signal: controller.signal,
            });
            if (path === '/api/translate') {
              const account = /^[a-f0-9]{64}$/.test(result.data.usageAccount || '') ? result.data.usageAccount : requestAccount;
              await recordTokenUsage(scope, account, result.data, requestMeterId).catch(() => {});
              const code = result.data.error;
              if (result.ok) await chrome.storage.local.remove('lastAuthError');
              else if (code) await chrome.storage.local.set({ lastAuthError: { code } });
            }
            if (path === '/api/auth/status' && result.ok) {
              const account = result.data.activeAccount;
              accountByTab.set(sender.tab.id, await accountFingerprint(account?.accountKey));
              result.data = { activeAccount: account && {
                signedIn: account.signedIn, planUsageEnabled: account.planUsageEnabled,
                accountKey: account.accountKey,
              }};
            }
            sendResponse(result);
          } catch (error) {
            if (inferenceSubmitted) await recordTokenUsage(scope, requestAccount, null, requestMeterId).catch(() => {});
            throw error;
          } finally {
            cleanup();
          }
          break;
        }

        case 'getTimedtextUrls': {
          const vid = message.payload?.videoId;
          if (!vid || vid !== playerVideo) throw new Error('Video scope mismatch');
          const tabId = sender.tab.id;
          const current = captionLookups.get(tabId);
          if (!current || current.videoId !== vid) {
            const lookup = { videoId: vid, entries: [] };
            captionLookups.set(tabId, lookup);
            setTimeout(() => {
              if (captionLookups.get(tabId) === lookup) captionLookups.delete(tabId);
            }, captionLookupMs);
          }
          sendResponse({ ok: true, entries: captionLookups.get(tabId).entries });
          break;
        }

        case 'abortGeneration': {
          if (typeof sender.tab?.id === 'number') {
            if (message.payload?.keepGenerationId == null) captionLookups.delete(sender.tab.id);
            abortTabRequests(sender.tab.id, message.payload?.keepGenerationId ?? null);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'startTabCapture': {
          const tabId = sender.tab.id;
          if (!tabId) throw new Error('Missing target tabId');
          await ensureOffscreenDocument();
          const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
          const res = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'startCapture',
            payload: {
              streamId,
              tabId,
              generationId: message.payload?.generationId ?? 1,
              mediaTime: message.payload?.mediaTime ?? 0,
              playbackRate: message.payload?.playbackRate ?? 1.0,
            },
          });
          sendResponse(res);
          break;
        }

        case 'offscreenWorkletCmd': {
          const res = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'workletCmd',
            payload: message.payload,
          });
          sendResponse(res);
          break;
        }

        case 'stopTabCapture': {
          const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
          });
          if (contexts.length > 0) {
            await chrome.runtime.sendMessage({
              target: 'offscreen',
              action: 'stopCapture',
            }).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown_background_action' });
      }
    })().catch((err) => {
      if (err.name === 'AbortError') {
        sendResponse({ ok: false, aborted: true, error: 'aborted' });
        return;
      }
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  return false;
});
