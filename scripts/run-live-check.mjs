/** Explicitly capped live verification. Default invocation only reports sign-in readiness. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLiveBudget, createInteractiveClipBinding, TEST_CASES, authorizeAudioChunk } from './live-budget.mjs';
import { loadVerifiedReplay, mergeReplayTranslations, summarizeFreshUsage } from './verified-replay.mjs';
import { transcribeChunk } from '../companion/asr.mjs';
import { instrumentInteractiveExtension, launchInteractiveBrowser, sanitizeInteractiveSample } from './interactive-check.mjs';

const shellQuote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPANION = 'http://127.0.0.1:17864';
const EXT_ID = 'biahghfnkaenlchallpkncbmomlickfd';
const ORIGIN = `chrome-extension://${EXT_ID}`;
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Missing ' + name);
  return process.argv[index + 1];
}
const caseName = argument('--case', 'radio');
const selectedCase = TEST_CASES[caseName];
if (!selectedCase) throw new Error('Unknown test case');
const VIDEO_ID = selectedCase.videoId;
const interactive = process.argv.includes('--interactive');
const replayResultsPath = argument('--replay-results', null);
const replayAttestationPath = argument('--replay-attestation', null);
const lookAheadMode = argument('--lookahead', 'balanced');
const targetLanguage = argument('--target-language','ko');
assert.ok(!replayResultsPath || targetLanguage === 'ko','Verified replay is Korean/default audio only');
assert.ok(['balanced','extended'].includes(lookAheadMode), 'Unknown preload preference');
assert.ok(!replayResultsPath || (interactive && caseName === 'boyfriend2' && replayAttestationPath), 'Replay requires an attested interactive panel run');
const panelExtraSeconds = Number(argument('--panel-extra-seconds', '0'));
assert.ok([0, 180].includes(panelExtraSeconds) && (!panelExtraSeconds || caseName === 'boyfriend2'), 'Extra allowance is limited to the authorized Netflix panel');
const MAX_AUDIO_SECONDS = 180 + panelExtraSeconds;
const START = Number(argument('--start', '60'));
const CLIP_SECONDS = Number(argument('--seconds', caseName === 'radio' ? '180' : '35'));
const priorUsageProvided = typeof process.env.PRIOR_TEST_AUDIO_SECONDS === 'string' && process.env.PRIOR_TEST_AUDIO_SECONDS.trim() !== '';
if (process.argv.includes('--run') && !priorUsageProvided) {
  throw new Error('Set PRIOR_TEST_AUDIO_SECONDS to the externally tracked usage across every earlier run before --run');
}
const priorAudioSeconds = Number(priorUsageProvided ? process.env.PRIOR_TEST_AUDIO_SECONDS : selectedCase.priorSeconds);
assert.ok(Number.isFinite(START) && START >= 0 && START <= 24 * 3600, 'Invalid clip start');
assert.ok(Number.isFinite(CLIP_SECONDS) && CLIP_SECONDS > 0 && CLIP_SECONDS <= (caseName === 'radio' || panelExtraSeconds ? 180 : 40), 'Invalid clip duration');
assert.ok(Number.isFinite(priorAudioSeconds) && priorAudioSeconds >= selectedCase.priorSeconds && priorAudioSeconds < MAX_AUDIO_SECONDS, 'Invalid prior usage');
const remainingSeconds = MAX_AUDIO_SECONDS - priorAudioSeconds;
assert.ok(replayResultsPath || CLIP_SECONDS <= remainingSeconds, 'Clip exceeds the remaining authorized source budget');
const END = START + CLIP_SECONDS;
const PROCESSING_END = START + (replayResultsPath ? CLIP_SECONDS + 2 : Math.min(CLIP_SECONDS + (CLIP_SECONDS >= 120 ? 2 : 15), remainingSeconds));
let budget = interactive ? null : createLiveBudget({ videoId: VIDEO_ID, start: START, end: PROCESSING_END, priorSeconds: priorAudioSeconds, panelExtraSeconds });
const interactiveBinding = interactive ? createInteractiveClipBinding({ videoId: VIDEO_ID, earliestStart: START, latestStart: START + 30,
  clipSeconds: CLIP_SECONDS, processingSeconds: PROCESSING_END - START, priorSeconds: priorAudioSeconds, panelExtraSeconds }) : null;
let scopeStart = START;
let scopeEnd = PROCESSING_END;
const cumulativeSeconds = () => budget?.cumulativeSeconds ?? priorAudioSeconds;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const configDir = process.env.YT_SUB_CONFIG_DIR || path.join(os.homedir(), '.config', 'lookahead-subtitles');
let pairingCode;
try {
  pairingCode = JSON.parse(fs.readFileSync(path.join(configDir, 'pairing.json'), 'utf8')).pairingCode;
  assert.match(pairingCode, /^[a-f0-9]{64}$/);
} catch {
  console.error('Companion pairing is unavailable. Start the reviewed companion first.');
  process.exit(2);
}
const clientHeaders = { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-YT-Client': '1', 'X-YT-Pair': pairingCode };
let readiness;
let lockedAccountKey;
let selectedModel;
try {
  const res = await fetch(`${COMPANION}/api/auth/status`, { method: 'POST', headers: clientHeaders, body: '{}', signal: AbortSignal.timeout(5000) });
  const status = await res.json();
  readiness = res.ok && status.activeAccount?.signedIn && status.activeAccount?.planUsageEnabled;
  lockedAccountKey = status.activeAccountKey;
  selectedModel = status.activeAccount?.selectedModel;
  if (process.argv.includes('--run') && selectedCase.requiredModel && selectedModel !== selectedCase.requiredModel) {
    throw new Error('The panel test requires the selected GPT-6-Luna model');
  }
  if (!readiness) {
    console.log(JSON.stringify({ ready: false, reason: 'Complete Sign in with ChatGPT and allow plan usage in the reviewed extension before running this check.' }));
    process.exit(2);
  }
} catch {
  console.error('The reviewed companion could not be reached.');
  process.exit(2);
}
const replay = replayResultsPath ? loadVerifiedReplay({ reportPath:replayResultsPath, attestationPath:replayAttestationPath,
  activeAccountKey:lockedAccountKey,videoId:VIDEO_ID,model:selectedModel }) : null;
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ ready: true, paidInferenceStarted: false, maximumSourceSeconds: MAX_AUDIO_SECONDS, remainingSourceSeconds: remainingSeconds, priorUsageProvided, priorUsageIsExternallyTracked: true, replayEnabled: Boolean(replay), replayTranslatedCues: replay?.translatedCount, interactiveStartRange: interactive ? [START, START + 30] : null, bindsClipOnTrustedActivation: interactive, selectedModel, targetLanguage, lookAheadMode, testCase: caseName, clip: [START, END], processingWindow: [START, PROCESSING_END], command: `PRIOR_TEST_AUDIO_SECONDS=${priorAudioSeconds} node scripts/run-live-check.mjs --case ${caseName} --start ${START} --seconds ${CLIP_SECONDS}${panelExtraSeconds ? ` --panel-extra-seconds ${panelExtraSeconds}` : ''}${interactive ? ' --interactive' : ''} --lookahead ${lookAheadMode} --target-language ${targetLanguage}${replayResultsPath ? ' --replay-results ' + shellQuote(replayResultsPath) + ' --replay-attestation ' + shellQuote(replayAttestationPath) : ''} --run` }));
  process.exit(0);
}

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-lookahead-live-'));
const report = { kind: 'REAL_YOUTUBE_CHATGPT_PLAN', testCase: caseName, videoId: VIDEO_ID, allowedMediaWindow: [START, PROCESSING_END], viewingWindow: [START, END], maximumSourceSeconds: MAX_AUDIO_SECONDS, runDir, startedAt: new Date().toISOString(), events: [], samples: [], pass: false };
let stopped = false;
let stopReason = null;
let observedTargetEnd = END;
report.priorAudioSeconds = priorAudioSeconds;
report.selectedLookAheadMode = lookAheadMode;
report.selectedTargetLanguage = targetLanguage;
if (replay) report.replay = { ...replay.provenance, previouslySubmittedSourceCoverage:replay.sourceCoverage, retainedRecognizedCoverage:replay.recognizedCoverage, translatedCues:replay.translatedCount,
  note:'Replayed prior recognized cues and completed Korean translations are cached results, not fresh predictions. New local language probes are recorded separately.' };
let firstAsrAt = null;
let cutoffTimer;
const controllers = new Set();
process.once('SIGINT', () => stop('operator_stop'));
process.once('SIGTERM', () => stop('operator_stop'));

function stop(reason) {
  if (stopped) return;
  stopped = true; stopReason = reason;
  clearTimeout(cutoffTimer);
  for (const controller of controllers) controller.abort();
}
const proxyPairingCode = crypto.randomBytes(32).toString('hex');
const proxy = http.createServer(async (req, res) => {
  function json(status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  if (req.headers.origin !== ORIGIN) { json(403, { error: 'origin_not_allowed' }); return; }
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-YT-Client, X-YT-Pair');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const publicHealth = req.url === '/health' && req.method === 'GET';
  const allowedPost = req.method === 'POST' && ['/api/auth/status', '/api/asr', '/api/translate', ...(interactive ? ['/test/telemetry'] : [])].includes(req.url);
  if (!publicHealth && !allowedPost) { json(403, { error: 'live_check_route_denied' }); return; }
  if (stopped && !['/health', '/test/telemetry'].includes(req.url)) { json(409, { error: 'live_check_finished' }); return; }
  if (!publicHealth && (req.headers['x-yt-client'] !== '1' || req.headers['x-yt-pair'] !== proxyPairingCode)) { json(403, { error: 'pairing_required' }); return; }
  try {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8*1024*1024) throw new Error('body_too_large'); }
    let body = raw ? JSON.parse(raw) : {};
    if (interactive && req.url === '/test/telemetry') {
      const sample = sanitizeInteractiveSample(body, VIDEO_ID);
      report.samples.push(sample);
      report.interactiveLastSeen = Date.now();
      if (replay) {
        if (sample.audioTrackId === 'und' && sample.targetLanguage === 'ko') report.replayScopeVerified = true;
        else if (report.replayScopeVerified && sample.active) stop('replay_audio_or_target_changed');
      }
      if (sample.nativePlayback.channel === 'Netflix Japan') report.officialSourceVerified = true;
      if (!interactiveBinding.current && (sample.activationRequested || sample.active) &&
          (caseName !== 'boyfriend2' || report.officialSourceVerified)) {
        const bound = interactiveBinding.bind(sample);
        budget = bound.budget;
        scopeStart = bound.start;
        scopeEnd = bound.processingEnd;
        observedTargetEnd = bound.end;
        report.firstViewerMediaTime = bound.start;
        report.viewingWindow = [bound.start, bound.end];
        report.allowedMediaWindow = [bound.start, bound.processingEnd];
      }
      if (sample.active && !report.interactiveStartedAt) report.interactiveStartedAt = Date.now();
      if (sample.nativePlayback.errorVisible || sample.nativePlayback.errorCode) stop('native_player_error');
      else if (sample.error || sample.authError) stop(sample.authError?.code || 'pipeline_error');
      else if (sample.viewerMediaTime >= observedTargetEnd - 0.1 && report.interactiveStartedAt) stop('authorized_media_window_complete');
      json(200, { stopped, boundWindow: interactiveBinding.current ? [scopeStart, scopeEnd] : null });
      return;
    }
    if (req.url === '/api/asr' || req.url === '/api/translate') {
      if (body.videoId !== VIDEO_ID) throw new Error('video_outside_authorized_scope');
      if (interactive && !budget) {
        const waitUntil = Date.now() + 5000;
        while (!stopped && !budget && Date.now() < waitUntil) await sleep(50);
        if (!budget) throw new Error('activation_binding_required');
      }
      if (interactive && caseName === 'boyfriend2' && !report.officialSourceVerified) throw new Error('official_source_not_verified');
      if (replay && !report.replayScopeVerified) {
        const verifiedUntil = Date.now()+5000;
        while (!stopped && !report.replayScopeVerified && Date.now()<verifiedUntil) await sleep(50);
        if (!report.replayScopeVerified) throw new Error('replay_default_audio_and_ko_not_confirmed');
      }
      if (replay && body.targetLanguage && body.targetLanguage !== 'ko') throw new Error('replay_target_changed');
      if (firstAsrAt && Date.now() - firstAsrAt >= (CLIP_SECONDS + 90) * 1000) throw new Error('wall_clock_cap');
    }
    let replayedTranslations = [];
    let requestedTranslationLines = null;
    if (req.url === '/api/asr') {
      const startTime = Number(body.chunkStartMediaTime), endTime = Number(body.chunkEndMediaTime);
      // Validate full captured bytes first, then forward only samples inside this isolated test window.
      authorizeAudioChunk(body, 0, { videoId: VIDEO_ID, start: Math.min(scopeStart, startTime), end: Math.max(scopeEnd, endTime) }, MAX_AUDIO_SECONDS);
      if (startTime >= scopeEnd || endTime <= scopeStart) {
        report.events.push({ type: 'out_of_scope_audio_not_forwarded' });
        json(200, { segments: [], skippedSilence: true, inferenceMs: 0, validationScopeEnd: true });
        return;
      }
      if (startTime < scopeStart || endTime > scopeEnd) {
        const pcm = Buffer.from(body.pcmBase64, 'base64');
        const samples = pcm.length / 2, span = endTime - startTime;
        const first = Math.max(0, Math.ceil((scopeStart - startTime) / span * samples));
        const last = Math.min(samples, Math.floor((scopeEnd - startTime) / span * samples));
        body = { ...body, pcmBase64: pcm.subarray(first * 2, last * 2).toString('base64'),
          chunkStartMediaTime: startTime + first / samples * span, chunkEndMediaTime: startTime + last / samples * span };
        report.events.push({ type: 'audio_trimmed_to_scope' });
      }
      const replayStart = Number(body.chunkStartMediaTime), replayEnd = Number(body.chunkEndMediaTime);
      if (replay?.covered(replayStart, replayEnd)) {
        const localResult = await transcribeChunk(body);
        const cachedSegments = replay.asrSegments(replayStart,replayEnd);
        const newLocalSegments = (localResult.segments || []).filter(row=>!cachedSegments.some(cached=>
          row.mediaStart < cached.mediaEnd && row.mediaEnd > cached.mediaStart));
        const segments = [...cachedSegments,...newLocalSegments].sort((a,b)=>a.mediaStart-b.mediaStart);
        report.events.push({ type:'local_only_asr', start:replayStart,end:replayEnd,
          detectedLanguage:localResult.detectedLanguage,probability:localResult.detectedLanguageProbability,
          inferenceMs:localResult.inferenceMs,cachedSegments:cachedSegments.length,newLocalSegments:newLocalSegments.length,subscriptionCalls:0 });
        if (!body.language || body.language === 'auto') report.events.push({ type:'local_language_probe',start:replayStart,end:replayEnd,
          detectedLanguage:localResult.detectedLanguage,probability:localResult.detectedLanguageProbability,inferenceMs:localResult.inferenceMs,subscriptionCalls:0 });
        report.events.push({ type:'asr_replayed', start:replayStart,end:replayEnd,segments:cachedSegments.length,
          note:'Retained prior cues plus real local reprocessing for source gaps' });
        json(200,{ ...localResult, segments, replayed:true,localOnlyReprocessing:true });
        return;
      }
      const { start, end, duration } = budget.authorizeAudio(body);
      if (!firstAsrAt) { firstAsrAt = Date.now(); cutoffTimer = setTimeout(() => stop('wall_clock_cap'), (CLIP_SECONDS + 90) * 1000); }
      report.events.push({ type: 'asr_submitted', chunkId: body.chunkId, start, end, duration, cumulativeSourceSeconds: cumulativeSeconds() });
    }
    if (req.url === '/api/translate') {
      if (!firstAsrAt) {
        firstAsrAt = Date.now();
        cutoffTimer = setTimeout(() => stop('wall_clock_cap'), (CLIP_SECONDS + 90) * 1000);
      }
      requestedTranslationLines = body.lines;
      if (replay) {
        replayedTranslations = body.lines.map(line=>replay.translated(line)).filter(Boolean);
        const cachedIds = new Set(replayedTranslations.map(line=>line.id));
        body = { ...body,lines:body.lines.filter(line=>!cachedIds.has(line.id)),
          contextLines:(body.contextLines||[]).filter(line=>!replay.sourceText(line.text)),
          followingLines:(body.followingLines||[]).filter(line=>!replay.hasSource(line)) };
        if (replayedTranslations.length) report.events.push({ type:'translation_replayed',count:replayedTranslations.length,model:selectedModel });
        if (!body.lines.length) {
          json(200,{translations:replayedTranslations,model:selectedModel,simulated:false,inferenceMs:0,replayed:true});
          return;
        }
      }
      body = budget.prepareTranslation(body);
      body.accountKey = lockedAccountKey;
      body.model = selectedModel;
      report.events.push({ type:'translation_submitted', lineIds:body.lines.map(l=>l.id), starts:body.lines.map(l=>l.mediaStart) });
    }
    const controller = new AbortController(); controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const response = await fetch(COMPANION + req.url, { method:req.method, headers:publicHealth ? {} : clientHeaders, body:publicHealth ? undefined : JSON.stringify(body), signal:AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
      let data = await response.json();
      if (req.url === '/api/translate' && response.ok && replayedTranslations.length) {
        data = { ...data,translations:mergeReplayTranslations(requestedTranslationLines,replayedTranslations,data.translations),replayedLineCount:replayedTranslations.length };
      }
      if (req.url === '/api/translate') {
        report.events.push({ type:'translation_result', ok:response.ok, model:data.model, simulated:data.simulated, inferenceMs:data.inferenceMs, error:data.error,usage:data.usage || null });
        if (!response.ok || data.simulated) stop(data.error || 'unexpected_simulated_translation');
      }
      json(response.status, data);
    } finally { controllers.delete(controller); }
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'request_aborted' : error.message;
    if (!['request_aborted'].includes(reason)) stop(reason);
    if (!res.destroyed && !res.writableEnded) json(409, { error:'live_check_finished', message:reason });
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const extensionDir = path.join(runDir, 'extension');
fs.cpSync(path.join(ROOT, 'extension'), extensionDir, {recursive:true});
const transportFile = path.join(extensionDir, 'companion-client.js');
fs.writeFileSync(transportFile, fs.readFileSync(transportFile, 'utf8').replaceAll(COMPANION, proxyUrl));
report.temporaryTransportPatch = 'Routes requests through the in-process validation limiter';
// The copied queue restricts the test to the approved source interval. Shipped playback stays untouched.
const queuePath = path.join(extensionDir, 'queue-engine.js');
let queueSource = fs.readFileSync(queuePath, 'utf8');
const cueStart = '        const mediaStart = Number(seg.mediaStart);';
assert.ok(queueSource.includes(cueStart), 'Queue test window insertion point changed');
queueSource = queueSource.replace(cueStart, cueStart + `\n        if (mediaStart < (globalThis.__ytLiveTestWindow ? globalThis.__ytLiveTestWindow[0] - ${replay ? 12 : 0} : ${interactive ? START - 0.08 : START}) || Number(seg.mediaEnd) > (globalThis.__ytLiveTestWindow?.[1] ?? ${interactive ? PROCESSING_END + 30.08 : PROCESSING_END})) continue;`);
fs.writeFileSync(queuePath, queueSource);
report.temporaryCueWindow = [START, PROCESSING_END];
report.currentAsrHelperSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'companion','asr.mjs'))).digest('hex');
report.asrLibraryProvenance = 'Prior ASR helper digest was not recorded. Retained source cues preserve original timestamps; current local reprocessing uses the recorded current helper digest.';
report.sourceDigests = Object.fromEntries(['content.js','audio-worklet.js','queue-engine.js','background.js'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(extensionDir,file))).digest('hex')]));
class Cdp {
  constructor(input, output) {
    this.input=input;this.next=1;this.pending=new Map();this.handlers=new Map();let buffer='';
    output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(message.id){const p=this.pending.get(message.id);if(!p)continue;this.pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}else this.handlers.get(message.method)?.(message.params,message.sessionId);}});
  }
  on(name,handler){this.handlers.set(name,handler)}
  send(method,params={},sessionId){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout ${method}`))},15000);this.pending.set(id,{resolve,reject,timer});this.input.write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')})}
  async evaluate(session,expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
}
let chrome, cdp, page;
try {
  if (interactive) {
    instrumentInteractiveExtension({ extensionDir, proxyUrl, pairingCode: proxyPairingCode, videoId: VIDEO_ID, processingSeconds: PROCESSING_END - START, lookAheadMode, targetLanguage });
    report.mode = 'NORMAL_CHROME_FOR_TESTING_WINDOW_NO_DEBUGGING';
    report.runtimeErrors = [];
    report.visualEvidence = 'Use the visible desktop window for screenshot inspection';
    const url = `https://www.youtube.com/watch?v=${VIDEO_ID}&t=${START}s`;
    chrome = launchInteractiveBrowser({ chromeBin: process.env.CHROME_BIN, profileDir: path.join(runDir, 'profile'), extensionDir, url });
    chrome.once('error', () => stop('browser_launch_failed'));
    chrome.once('exit', () => stop('owned_browser_closed'));
    fs.writeFileSync(path.join(runDir, 'interactive-ready.json'), JSON.stringify({ videoId: VIDEO_ID, clip: [START, END], sourceWindow: [START, PROCESSING_END], mode: report.mode, url }));
    console.log(JSON.stringify({ interactiveWindowLaunched: true, waitingForTrustedSubtitleButton: true, videoId: VIDEO_ID, clip: [START, END], evidenceDirectory: runDir }));
    const actionDeadline = Date.now() + 120000;
    while (!stopped) {
      const now = Date.now();
      if (!report.interactiveStartedAt && now > actionDeadline) stop('subtitle_button_not_started');
      if (report.interactiveStartedAt && now - report.interactiveStartedAt > (CLIP_SECONDS + 100) * 1000) stop('interactive_wall_deadline');
      if (report.interactiveLastSeen && now - report.interactiveLastSeen > 15000) stop('telemetry_disconnected');
      if (report.samples.length && report.samples.length % 10 === 0) {
        const sample = report.samples.at(-1);
        console.log(JSON.stringify({ phase: sample.phase, viewer: sample.viewerMediaTime, source: sample.rawVideoCurrentTime, ready: sample.readyLinesCount, cumulativeSourceSeconds: cumulativeSeconds() }));
      }
      await sleep(500);
    }
    report.final = report.samples.at(-1) || {};
    report.observedSourceMode = report.final.sourceMode;
  } else {
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--user-data-dir=${path.join(runDir,'profile')}`,'--remote-debugging-pipe','--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--window-size=1280,840','about:blank'], {stdio:['ignore','ignore','ignore','pipe','pipe']});
  cdp=new Cdp(chrome.stdio[3],chrome.stdio[4]);
  report.browser=await cdp.send('Browser.getVersion');
  const loaded=await cdp.send('Extensions.loadUnpacked',{path:extensionDir});assert.equal(loaded.id,EXT_ID);
  const targets=await cdp.send('Target.getTargets');const target=targets.targetInfos.find(t=>t.type==='page');
  page=(await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  await cdp.send('Runtime.enable',{},page);await cdp.send('Page.enable',{},page);
  report.runtimeErrors = [];
  cdp.on('Runtime.exceptionThrown', event => {
    const error = event.exceptionDetails;
    const urls = [error.url, ...(error.stackTrace?.callFrames || []).map(frame => frame.url)].filter(Boolean);
    report.runtimeErrors.push({
      text: error.text,
      line: error.lineNumber,
      sources: urls.map(value => { try { return new URL(value).origin; } catch { return 'unknown'; } }),
      applicationError: urls.some(url => url.includes(EXT_ID)),
    });
  });
  const popup=await cdp.send('Target.createTarget',{url:`chrome-extension://${EXT_ID}/popup.html`});
  const popupSession=(await cdp.send('Target.attachToTarget',{targetId:popup.targetId,flatten:true})).sessionId;
  await sleep(500);await cdp.evaluate(popupSession,`chrome.storage.local.set({pairingCode:${JSON.stringify(proxyPairingCode)}})`);await cdp.send('Target.closeTarget',{targetId:popup.targetId});
  await cdp.send('Page.navigate',{url:`https://www.youtube.com/watch?v=${VIDEO_ID}&t=${START}s`},page);
  async function click(selector) {
    const point=await cdp.evaluate(page,`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r&&r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
    if (!point) return false;
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...point }, page);
    await sleep(200);
    const reachable = await cdp.evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.contains(document.elementFromPoint(${point.x}, ${point.y}))`);
    if (!reachable) return false;
    for (const type of ['mousePressed','mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 }, page);
    }
    return true;
  }
  const readyDeadline=Date.now()+90000;
  let identity;
  while(Date.now()<readyDeadline){
    identity=await cdp.evaluate(page,`(()=>{const p=document.getElementById('movie_player'),v=p?.querySelector('video.html5-main-video'),r=p?.getPlayerResponse?.();return{url:location.href,title:document.title,videoId:r?.videoDetails?.videoId,tracks:r?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length||0,author:r?.videoDetails?.author,captionLanguages:(r?.captions?.playerCaptionsTracklistRenderer?.captionTracks||[]).map(t=>t.languageCode),ad:Boolean(p?.classList.contains('ad-showing')||p?.classList.contains('ad-interrupting')),ready:Boolean(v&&v.readyState>=2&&document.querySelector('.yt-lookahead-btn')),srcOrigin:v?.currentSrc?new URL(v.currentSrc).origin:null}})()`);
    if(identity.ad)await click('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if(identity.ready&&!identity.ad&&identity.videoId===VIDEO_ID)break;
    await sleep(500);
  }
  report.identity=identity;
  assert.ok(identity?.ready&&!identity.ad&&identity.videoId===VIDEO_ID,'Genuine target YouTube video unavailable');
  if (caseName === 'boyfriend2') assert.equal(identity.author, 'Netflix Japan', 'Official Netflix Japan source expected');
  if (selectedCase.captionless) assert.equal(identity.tracks, 0, 'Captionless target now has selectable captions');
  const duration = await cdp.evaluate(page, `document.querySelector('video.html5-main-video')?.duration`);
  assert.ok(Number.isFinite(duration) && PROCESSING_END <= duration, 'Requested clip is outside video duration');
  // Use a normal player control for pause, then the player's own seek handling.
  if (!(await cdp.evaluate(page, `document.querySelector('video.html5-main-video')?.paused`))) await click('.ytp-play-button');
  await cdp.evaluate(page, `document.getElementById('movie_player').seekTo(${START}, true)`);
  await sleep(800);
  assert.ok(await click('.yt-lookahead-btn'),'Subtitle button is not visible');
  console.log(`Started ${caseName} live clip. Requested viewer seconds=${CLIP_SECONDS}, cumulative source cap=180s.`);
  const samplesDeadline=Date.now()+(CLIP_SECONDS + 45)*1000;
  while(Date.now()<samplesDeadline&&!stopped){
    const sample=await cdp.evaluate(page,`JSON.parse(document.getElementById('yt-lookahead-telemetry')?.textContent||'{}')`);
    report.samples.push(sample);
    if (!report.subtitleScreenshot && /[가-힣]/.test(sample.visibleSubtitle || '')) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
      report.subtitleScreenshot = path.join(runDir, 'live-subtitle.png');
      fs.writeFileSync(report.subtitleScreenshot, Buffer.from(shot.data, 'base64'));
    }
    if(sample.error||sample.authError){stop(sample.authError?.code||sample.error);break;}
    if(selectedCase.captionless && sample.captionTracksCount>0){stop('caption_track_detected');break;}
    if(sample.viewerMediaTime>=END-.1){stop('authorized_media_window_complete');break;}
    if(report.samples.length%10===0)console.log(JSON.stringify({phase:sample.phase,viewer:sample.viewerMediaTime,source:sample.rawVideoCurrentTime,ready:sample.readyLinesCount,sourceSeconds:Number(cumulativeSeconds().toFixed(2))}));
    await sleep(500);
  }
  stop(stopReason||'sample_deadline');
  const final=await cdp.evaluate(page,`JSON.parse(document.getElementById('yt-lookahead-telemetry')?.textContent||'{}')`);
  report.final=final;
  report.observedSourceMode = final.sourceMode;
  if(final.active)await click('.yt-lookahead-btn');
  await cdp.evaluate(page,`document.querySelector('video.html5-main-video')?.pause()`);
  const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'},page);fs.writeFileSync(path.join(runDir,'live-final.png'),Buffer.from(screenshot.data,'base64'));
  }
  const final = report.final || {};
  const readyLines=new Map();for(const sample of report.samples)for(const line of sample.lines||[])if(line.status==='ready')readyLines.set(line.id,line);
  const rendered=new Map();for(const sample of report.samples)for(const line of sample.renderedHistory||[])rendered.set(line.id,line);
  const lines=Array.from(readyLines.values());
  report.summary={requestedViewerSeconds:CLIP_SECONDS,observedViewerSeconds:Math.max(0,Number(final.viewerMediaTime||START)-(report.firstViewerMediaTime || START)),totalReady:lines.length,readyBeforeDialogue:lines.filter(l=>l.leadSec>0).length,rendered:rendered.size,initialWaitSec:report.samples.find(s=>s.initialWaitSec!==null)?.initialWaitSec,models:[...new Set(lines.map(l=>l.model))],consecutiveLines:lines.sort((a,b)=>a.mediaStart-b.mediaStart).slice(0,19),renderedSample:[...rendered.values()].slice(0,19)};
  const renderedAheadOnTime = [...rendered.values()].filter(cue =>
    cue.leadSec > 0 && Math.abs(cue.timingOffsetSec) <= 0.25
  ).length;
  report.summary.renderedAheadWithin250ms = renderedAheadOnTime;
  const normalEnd = ['authorized_media_window_complete', 'wall_clock_cap', 'cumulative_audio_cap'].includes(stopReason);
  const realTranslations = report.events.some(e => e.type === 'translation_result' && e.ok && e.simulated === false) || Boolean(replay && report.events.some(e=>e.type==='translation_replayed'));
  const reachedEndOfTest = Number(final.viewerMediaTime) >= observedTargetEnd - 0.25;
  report.summary.reachedEndOfTest = reachedEndOfTest;
  report.pass = normalEnd && reachedEndOfTest && renderedAheadOnTime >= 10 && realTranslations &&
    lines.every(line => !line.simulated) && report.runtimeErrors.every(error => !error.applicationError);
  report.summary.replayedAsrRequests = report.events.filter(event=>event.type==='asr_replayed').length;
  report.summary.localOnlyAsrRequests = report.events.filter(event=>event.type==='local_only_asr').length;
  report.summary.localLanguageProbes = report.events.filter(event=>event.type==='local_language_probe').length;
  report.summary.replayedTranslations = report.events.filter(event=>event.type==='translation_replayed').reduce((n,event)=>n+event.count,0);
  report.summary.liveTranslationRequests = report.events.filter(event=>event.type==='translation_result').length;
  report.summary.freshTokenUsage = summarizeFreshUsage(report.events);
  report.verdict = report.pass ? (replay ? (report.summary.freshTokenUsage.freshCalls ? 'replay_plus_live_playback_passed' : 'verified_replay_playback_passed') : 'all_fresh_live_check_passed') : rendered.size ? 'partial' : 'failed';
  if(!report.pass)process.exitCode=1;
} catch(error){report.error=error.message;stop(stopReason||'verification_error');process.exitCode=1;}
finally {
  stop(stopReason||'finished');
  if(cdp&&page)try{await cdp.evaluate(page,`document.querySelector('video.html5-main-video')?.pause()`)}catch{}
  chrome?.kill('SIGTERM');proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
  report.stopReason=stopReason;report.cumulativeSourceSeconds=cumulativeSeconds();report.submittedAudioSeconds=budget?.submittedAudioSeconds || 0;report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(runDir,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:report.pass,stopReason,cumulativeSourceSeconds:Number(cumulativeSeconds().toFixed(3)),summary:report.summary,evidence:path.join(runDir,'results.json'),error:report.error},null,2));
}
