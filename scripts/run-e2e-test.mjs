/** Browser fixture acceptance. No real accounts, ASR, translation, or YouTube requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-lookahead-fixture-'));
const chromeBin = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { kind: 'SYNTHETIC_BROWSER_FIXTURE', runDir, limitations: ['Synthetic video with tone audio', 'Mocked Japanese transcription and Korean translation', 'No real YouTube, Whisper, OpenAI login, or subscription usage'], samples: [] };
const authoredCues = [
  { en:'Shall we watch it together?', es:'¿Lo vemos juntos?', fr:'On le regarde ensemble ?' },
  { en:'Yes, press play.', es:'Sí, dale al play.', fr:'Oui, lance la vidéo.' },
];
const authoredRequests = [];
let signedIn = false;
let asrCount = 0;
let translationCount = 0;
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-yt-client,x-yt-pair');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let raw = '';
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  let data;
  if (req.url === '/health') data = { ok: true, whisper: { ok: true } };
  else if (req.url === '/api/auth/status') data = { activeAccount: signedIn ? { signedIn: true, planUsageEnabled: true } : null, accounts: [] };
  else if (req.url === '/api/asr') {
    asrCount++;
    assert.ok(body.pcmBase64.length > 1000, 'real AudioWorklet must deliver PCM');
    const segments = [];
    // Fixed fixture dialogue timestamps are independent of how the player batches captured audio.
    for (let i = 0; i < 20; i++) {
      const start = i * 2 + 0.3;
      if (start >= body.chunkStartMediaTime && start < body.chunkEndMediaTime) {
        segments.push({text: 'テストの会話' + i, mediaStart: start, mediaEnd: Math.min(start + 1, body.chunkEndMediaTime)});
      }
    }
    data = { durationAudioSec: Buffer.from(body.pcmBase64, 'base64').length / 32_000,
      detectedLanguage: 'ja', detectedLanguageProbability: 0.96, inferenceMs: 50, segments };
  } else if (req.url === '/api/translate') {
    translationCount++;
    await sleep(120);
    const targetLanguage = body.targetLanguage || 'ko';
    const translations = body.lines.map(line => {
      const authored = authoredCues.find(cue => cue.en === line.text);
      if (authored) authoredRequests.push({ id: line.id, source: line.text, targetLanguage });
      return { id: line.id, ko: authored?.[targetLanguage] || `테스트 대사 ${line.id}` };
    });
    data = { translations, inferenceMs: 120, simulated: false, model: 'FIXTURE_ONLY' };
  } else { res.writeHead(404); res.end('{}'); return; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
const extPath = path.join(runDir, 'extension');
fs.cpSync(path.join(root, 'extension'), extPath, { recursive: true });
const transportFile = path.join(extPath, 'companion-client.js');
fs.writeFileSync(transportFile, fs.readFileSync(transportFile, 'utf8').replaceAll('http://127.0.0.1:17864', fixtureUrl));
report.transportPatch = `Temporary extension copy routes companion requests to ${fixtureUrl}`;

class Cdp {
  constructor(input, output) {
    this.next = 1; this.pending = new Map(); this.handlers = new Map(); this.input = input;
    let buffer = '';
    output.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
        } else this.handlers.get(message.method)?.(message.params, message.sessionId);
      }
    });
  }
  on(name, cb) { this.handlers.set(name, cb); }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async evaluate(session, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

const fixtureHtml = `<!doctype html><html><head><title>Look-ahead subtitle browser fixture</title><style>
body{margin:24px;background:#181818;color:white;font-family:Arial}#movie_player{position:relative;width:640px;height:405px;background:black}.html5-video-container{width:640px;height:360px;position:relative}video{width:640px;height:360px}.ytp-right-controls{position:absolute;bottom:0;right:0;height:40px}button{color:white;background:#333;padding:10px;border:0}
</style></head><body><h1>Synthetic captionless video fixture</h1><div id="movie_player"><div class="html5-video-container"><video class="html5-main-video" playsinline></video></div><div class="ytp-right-controls"></div></div><button id="prepare">Prepare synthetic media</button><p id="status">Ready to record</p><script>
document.getElementById('prepare').onclick=async()=>{
 const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');
 const ac=new AudioContext();await ac.resume();const dest=ac.createMediaStreamDestination();const osc=ac.createOscillator();const gain=ac.createGain();gain.gain.value=.15;osc.frequency.value=220;osc.connect(gain);gain.connect(dest);osc.start();
 const stream=canvas.captureStream(15);stream.addTrack(dest.stream.getAudioTracks()[0]);
 const chunks=[];const rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:200000});
 let frame=0;const draw=setInterval(()=>{ctx.fillStyle=frame%2?'#163f46':'#183e5c';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='30px Arial';ctx.fillText('Synthetic frame '+frame++,40,170)},66);
 rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
 rec.onstop=async()=>{clearInterval(draw);osc.stop();await ac.close();stream.getTracks().forEach(t=>t.stop());const v=document.querySelector('video');v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));v.onloadedmetadata=()=>{v.currentTime=1e9;v.onseeked=()=>{v.onseeked=null;v.currentTime=0;document.getElementById('status').textContent='Media ready';window.fixtureReady=true;}};};
 rec.start(500);document.getElementById('status').textContent='Recording 40-second synthetic video';setTimeout(()=>rec.stop(),40000);
};
</script></body></html>`;
let chrome;
try {
  chrome = spawn(chromeBin, [`--user-data-dir=${path.join(runDir, 'profile')}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--headless=new', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--window-size=1000,750', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let chromeErrors = ''; chrome.stderr.on('data', (c) => { chromeErrors += c.toString(); });
  const cdp = new Cdp(chrome.stdio[3], chrome.stdio[4]);
  await cdp.send('Browser.getVersion');
  const ext = await cdp.send('Extensions.loadUnpacked', { path: extPath });
  report.extensionId = ext.id;
  assert.equal(ext.id, 'biahghfnkaenlchallpkncbmomlickfd');
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((t) => t.type === 'page');
  const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, page); await cdp.send('Runtime.enable', {}, page);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.youtube.com/*' }] }, page);
  cdp.on('Fetch.requestPaused', async (evt, session) => {
    const url = new URL(evt.request.url);
    const isTrack = url.pathname === '/api/timedtext' && url.searchParams.get('lang') === 'en';
    const text = isTrack ? JSON.stringify({events: authoredCues.map((c,i) => ({
      tStartMs: i * 20000, dDurationMs: 20000, segs:[{utf8:c.en}],
    }))}) : url.pathname === '/watch' ? fixtureHtml : '';
    await cdp.send('Fetch.fulfillRequest', { requestId: evt.requestId, responseCode: 200, responseHeaders: [{name:'Content-Type',value:isTrack ? 'application/json' : 'text/html'}], body: Buffer.from(text).toString('base64') }, session);
  });
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails));
  const popup = await cdp.send('Target.createTarget', { url: `chrome-extension://${ext.id}/popup.html` });
  const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  await sleep(500);
  await cdp.evaluate(popupSession, `chrome.storage.local.set({pairingCode:'fixture-only'})`);
  await cdp.send('Target.closeTarget', {targetId:popup.targetId});
  await cdp.send('Page.navigate', { url: 'https://www.youtube.com/watch?v=FIXTURE_ONLY' }, page);
  async function waitFor(expression, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now()-start < timeoutMs) {
      const value = await cdp.evaluate(page, expression);
      if (value) return value;
      await sleep(200);
    }
    throw new Error(`Condition timed out: ${expression}`);
  }
  async function click(selector) {
    const point = await cdp.evaluate(page, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type,x:point.x,y:point.y,button:'left',clickCount:1}, page);
  }
  const telemetry = () => cdp.evaluate(page, `JSON.parse(document.getElementById('yt-lookahead-telemetry').textContent)`);
  await waitFor(`Boolean(document.querySelector('.yt-lookahead-btn'))`);
  await click('.yt-lookahead-btn');
  await waitFor(`document.querySelector('.yt-lookahead-status-pill').textContent.includes('ChatGPT 로그인 필요')`);
  const blocked = await telemetry();
  assert.equal(blocked.active, false); assert.equal(asrCount,0); assert.equal(translationCount,0);
  report.signedOut = { pass:true, status: await cdp.evaluate(page, `document.querySelector('.yt-lookahead-status-pill').textContent`), asrCount, translationCount };
  await cdp.evaluate(page, `document.querySelector('.yt-lookahead-btn').click();window.dispatchEvent(new CustomEvent('yt-lookahead-cmd',{detail:{action:'start'}}))`);
  await sleep(250); assert.equal((await telemetry()).active,false);
  report.syntheticPageCommandsBlocked = true;
  console.log('PASS signed-out trusted button and synthetic page command rejection');
  await click('#prepare');
  await waitFor('window.fixtureReady===true',45000);
  console.log('Synthetic video recorded');
  signedIn=true;
  await click('.yt-lookahead-btn');
  await waitFor(`JSON.parse(document.getElementById('yt-lookahead-telemetry').textContent).phase==='playing'`,20000);
  const started=await telemetry();
  assert.equal(started.sourceMode,'asr-delayed'); assert.ok(started.encodedQueueLen>0); assert.ok(asrCount>0);
  const endAt=Date.now()+7000;
  while(Date.now()<endAt){report.samples.push(await telemetry());await sleep(350)}
  const last=await telemetry();
  assert.ok(last.renderedHistory.length>=2,'Korean subtitles must be rendered');
  assert.ok(last.lines.filter(l=>l.status==='ready'&&l.leadSec>0).length>=3,'upcoming lines ready before playback');
  report.lookahead={pass:true, initialWaitSec:started.initialWaitSec, rawVideoCurrentTime:last.rawVideoCurrentTime, viewerMediaTime:last.viewerMediaTime, encodedQueueLen:last.encodedQueueLen, renderedHistory:last.renderedHistory, readyLines:last.lines.filter(l=>l.status==='ready'), asrCount,translationCount};
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'},page);fs.writeFileSync(path.join(runDir,'subtitles.png'),Buffer.from(shot.data,'base64'));
  const gen=last.generationId;
  await cdp.evaluate(page,`document.querySelector('video').currentTime=25`);
  await waitFor(`JSON.parse(document.getElementById('yt-lookahead-telemetry').textContent).generationId>${gen}`);
  await sleep(1000);
  const sought=await telemetry();
  assert.ok(sought.lines.every(l=>l.mediaStart>=24),'stale old-position cues discarded after seek');
  report.seek={pass:true,generationBefore:gen,generationAfter:sought.generationId,phase:sought.phase,lines:sought.lines};
  await click('.yt-lookahead-btn');
  const stopped=await telemetry();assert.equal(stopped.active,false);
  report.stop={pass:true,canvasHidden:await cdp.evaluate(page,`document.querySelector('.yt-lookahead-canvas').style.display==='none'`)};
  // The synthetic publisher supplies an English track. No Spanish or French track exists.
  const asrBeforeManual = asrCount;
  await cdp.evaluate(page, `(()=>{
    const player=document.getElementById('movie_player');
    player.getPlayerResponse=()=>({videoDetails:{videoId:'FIXTURE_ONLY'},
      captions:{playerCaptionsTracklistRenderer:{captionTracks:[{
        vssId:'.en',languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v=FIXTURE_ONLY&lang=en',
      }],audioTracks:[{defaultCaptionTrackIndex:0,captionTrackIndices:[0]}],defaultAudioTrackIndex:0}}});
    const v=document.querySelector('video');v.pause();v.currentTime=2;
  })()`);
  const settings = await cdp.send('Target.createTarget', {url:`chrome-extension://${ext.id}/popup.html`, background:true});
  const settingsSession = (await cdp.send('Target.attachToTarget', {targetId:settings.targetId,flatten:true})).sessionId;
  await sleep(250);
  async function selectTarget(tag) {
    await cdp.evaluate(settingsSession, `(async()=>{
      await chrome.storage.local.set({targetLanguage:${JSON.stringify(tag)}});
      const [tab]=await chrome.tabs.query({url:'https://www.youtube.com/watch*'});
      return chrome.tabs.sendMessage(tab.id,{target:'player',action:'preferencesChanged',payload:{targetLanguage:${JSON.stringify(tag)},lookAheadMode:'balanced'}});
    })()`);
  }
  await selectTarget('es');
  await click('.yt-lookahead-btn');
  await waitFor(`document.querySelector('.yt-lookahead-subtitle-box')?.textContent==='¿Lo vemos juntos?'`, 18000);
  const spanish = await telemetry();
  await selectTarget('fr');
  await waitFor(`document.querySelector('.yt-lookahead-subtitle-box')?.textContent==='On le regarde ensemble ?'`, 16000);
  const french = await telemetry();
  assert.equal(spanish.sourceMode,'caption-track');
  assert.equal(french.sourceMode,'caption-track');
  assert.equal(asrCount,asrBeforeManual);
  assert.ok(authoredRequests.some(r=>r.targetLanguage==='es') && authoredRequests.some(r=>r.targetLanguage==='fr'));
  report.uploadedTrack = { source:'en', testedTargets:['es','fr'], syntheticTranslations:true,
    originalCue:[0,20], spanish:spanish.visibleSubtitle, french:french.visibleSubtitle,
    additionalAsrRequests:asrCount-asrBeforeManual, sourceMode:french.sourceMode };
  await cdp.send('Target.closeTarget',{targetId:settings.targetId});
  report.runtimeErrors=errors; assert.equal(errors.length,0);
  report.pass=true;
  console.log(JSON.stringify({pass:true, report:path.join(runDir,'results.json'), lookahead:report.lookahead, seek:report.seek},null,2));
} catch(error){report.pass=false;report.error=error.stack;console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(runDir,'results.json'),JSON.stringify(report,null,2));chrome?.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));console.log(`Fixture evidence retained at ${runDir}`)}
