/** Test-only instrumentation for a fresh, ordinary Chrome for Testing profile. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function findChromeForTesting(supplied) {
  if (supplied) {
    if (!fs.existsSync(supplied)) throw new Error('Chrome for Testing executable is unavailable');
    return supplied;
  }
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const candidates = fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse();
  for (const name of candidates) {
    const executable = path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(executable)) return executable;
  }
  throw new Error('An installed Chrome for Testing executable was not found');
}

export function sanitizeInteractiveSample(value, expectedVideoId) {
  if (!value || value.videoId !== expectedVideoId) throw new Error('telemetry_video_outside_scope');
  const clean = { videoId: expectedVideoId };
  for (const field of ['viewerMediaTime','rawVideoCurrentTime','captureMediaTime','bufferedMediaLead','initialWaitSec','readyLinesCount','asrChunksSent','asrInFlight','rebufferCount','generationId','captionTracksCount','targetDelaySec','targetLeadSec','nativeBufferedAheadSec','sourceBufferedAheadSec','readyHorizonAhead','bufferedWallSec']) {
    clean[field] = typeof value[field] === 'number' && Number.isFinite(value[field]) ? value[field] : null;
  }
  for (const field of ['active','paused','simulatedTranslation','activationRequested']) clean[field] = value[field] === true;
  for (const field of ['phase','sourceMode','sourceLanguage','audioLanguage','detectedLanguage','error','visibleSubtitle','lookAheadMode','targetLanguage','audioTrackId']) {
    clean[field] = typeof value[field] === 'string' ? value[field].slice(0,500) : null;
  }
  clean.authError = value.authError ? { code: String(value.authError.code || 'auth_error').slice(0,100) } : null;
  clean.lines = (Array.isArray(value.lines) ? value.lines : []).slice(0,250).map(line => {
    const item = {};
    for (const field of ['id','text','ko','status','model','sourceLanguage','speaker']) if (typeof line[field] === 'string') item[field] = line[field].slice(0,500);
    for (const field of ['mediaStart','mediaEnd','leadSec','readyAtViewerTime','asrReadyAtViewerTime','inferenceMs','translateInferenceMs']) if (typeof line[field] === 'number' && Number.isFinite(line[field])) item[field] = line[field];
    item.simulated = line.simulated === true;
    return item;
  });
  clean.renderedHistory = (Array.isArray(value.renderedHistory) ? value.renderedHistory : []).slice(-250).map(line => {
    const item = {};
    for (const field of ['id','ja','ko']) if (typeof line[field] === 'string') item[field] = line[field].slice(0,500);
    for (const field of ['shownAtViewerTime','dialogueStart','dialogueEnd','timingOffsetSec','readyAtViewerTime','leadSec']) if (typeof line[field] === 'number' && Number.isFinite(line[field])) item[field] = line[field];
    return item;
  });
  const native = value.nativePlayback || {};
  clean.nativePlayback = {
    paused: native.paused === true,
    readyState: Number.isInteger(native.readyState) ? native.readyState : null,
    errorCode: Number.isInteger(native.errorCode) ? native.errorCode : null,
    errorVisible: native.errorVisible === true,
    duration: typeof native.duration === 'number' && Number.isFinite(native.duration) ? native.duration : null,
    title: typeof native.title === 'string' ? native.title.slice(0,250) : '',
    channel: typeof native.channel === 'string' ? native.channel.slice(0,100) : '',
  };
  return clean;
}

export function instrumentInteractiveExtension({ extensionDir, proxyUrl, pairingCode, videoId, processingSeconds = 182, lookAheadMode = 'balanced', targetLanguage = 'ko' }) {
  const backgroundPath = path.join(extensionDir, 'background.js');
  fs.appendFileSync(backgroundPath, `
// Isolated validation profile only. This is a one-run proxy pairing value, never a ChatGPT token.
const testPairingReady = chrome.storage.local.set({pairingCode:${JSON.stringify(pairingCode)},lookAheadMode:${JSON.stringify(lookAheadMode)},targetLanguage:${JSON.stringify(targetLanguage)}});
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (message?.target !== 'isolated-test-telemetry') return false;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab ||
      new URL(sender.url).origin !== 'https://www.youtube.com' ||
      new URL(sender.url).searchParams.get('v') !== ${JSON.stringify(videoId)}) return false;
  (async()=>{
    await testPairingReady;
    const response=await fetch(${JSON.stringify(proxyUrl + '/test/telemetry')},{method:'POST',
      headers:{'Content-Type':'application/json','X-YT-Client':'1','X-YT-Pair':${JSON.stringify(pairingCode)}},
      body:JSON.stringify(message.sample),credentials:'omit',redirect:'error'});
    sendResponse(await response.json());
  })().catch(()=>sendResponse({stopped:true}));
  return true;
});
`);
  const contentPath = path.join(extensionDir, 'content.js');
  fs.appendFileSync(contentPath, `
// Read-only collection and clip binding for the isolated validation profile.
(()=>{
  let finished=false;
  function snapshot(activationRequested=false){
    const sample=JSON.parse(document.getElementById('yt-lookahead-telemetry')?.textContent||'{}');
    sample.videoId=${JSON.stringify(videoId)};
    const video=document.querySelector('#movie_player video.html5-main-video');
    const overlay=document.querySelector('#movie_player .ytp-error');
    sample.nativePlayback={paused:video?.paused,readyState:video?.readyState,errorCode:video?.error?.code,
      errorVisible:Boolean(overlay?.textContent.trim()&&overlay.getBoundingClientRect().height),duration:video?.duration,
      title:document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()||document.title,
      channel:document.querySelector('#owner #channel-name a')?.textContent?.trim()||''};
    if(activationRequested){
      sample.activationRequested=true;
      sample.viewerMediaTime=video?.currentTime;
      if(Number.isFinite(video?.currentTime))globalThis.__ytLiveTestWindow=[video.currentTime,video.currentTime+${processingSeconds}];
    }
    return sample;
  }
  async function submit(sample){
    const result=await chrome.runtime.sendMessage({target:'isolated-test-telemetry',sample});
    if(result?.boundWindow)globalThis.__ytLiveTestWindow=result.boundWindow;
    if(result?.stopped){finished=true;clearInterval(timer);}
  }
  document.addEventListener('click',event=>{
    if(!event.isTrusted||finished||!event.target.closest?.('.yt-lookahead-btn'))return;
    if(location.pathname!=='/watch'||new URL(location.href).searchParams.get('v')!==${JSON.stringify(videoId)})return;
    const sample=snapshot();
    if(!sample.active)submit(snapshot(true)).catch(()=>{});
  },true);
  const timer=setInterval(async()=>{
    if(finished||location.pathname!=='/watch'||new URL(location.href).searchParams.get('v')!==${JSON.stringify(videoId)})return;
    try{await submit(snapshot());}catch{}
  },500);
})();
`);
}

export function launchInteractiveBrowser({ chromeBin, profileDir, extensionDir, url }) {
  return spawn(findChromeForTesting(chromeBin), [
    `--user-data-dir=${profileDir}`, `--load-extension=${extensionDir}`, '--new-window', url,
  ], { stdio: ['ignore','ignore','ignore'] });
}
