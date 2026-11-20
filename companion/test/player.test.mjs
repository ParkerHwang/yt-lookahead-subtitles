import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function source(name) {
  return fs.readFileSync(new URL(`../../extension/${name}`, import.meta.url), 'utf8');
}

function createPlayer(accountResponse) {
  const elements = [];
  const windowListeners = new Map();
  const requests = [];
  const documentListeners = new Map();
  const workletMessages = [];
  let nowMs = 1000;
  let playCalls = 0;
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.style = {};
      this.listeners = new Map();
      this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
      elements.push(this);
    }
    appendChild() {}
    prepend() {}
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    getContext() { return {}; }
    querySelector() { return null; }
  }
  const rightControls = new Element('controls');
  const container = new Element('video-container');
  const player = new Element('player');
  player.querySelector = (selector) => {
    if (selector === '.ytp-right-controls') return rightControls;
    if (selector === '.html5-video-container') return container;
    return null;
  };
  const video = {
    currentTime: 60, playbackRate: 1, paused: true, duration: 900,
    addEventListener() {}, removeEventListener() {},
    pause() { this.paused = true; },
    play() { playCalls++; this.paused = false; return Promise.resolve(); },
  };
  const sandbox = {
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    console, URL, performance: { now() { return nowMs; } }, setTimeout, clearTimeout,
    clearInterval, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    location: { href: 'https://www.youtube.com/watch?v=demo' },
    document: {
      documentElement: new Element('root'),
      addEventListener(name, handler) { documentListeners.set(name, handler); },
      getElementById(id) { return id === 'movie_player' ? player : null; },
      querySelector() { return video; },
      createElement(tag) { return new Element(tag); },
    },
    MutationObserver: class { observe() {} },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(request) { requests.push(request); return typeof accountResponse === 'function' ? accountResponse(request) : accountResponse; },
      },
    },
    addEventListener(name, handler) { windowListeners.set(name, handler); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source('subtitle-languages.js'), sandbox);
  vm.runInContext(source('queue-engine.js'), sandbox);
  vm.runInContext(source('language-tracker.js'), sandbox);
  const testableContent = source('content.js').replace(/\}\)\(\);\s*$/, `
    globalThis.testPipeline = { state, queueEngine, checkBufferingReady, triggerResync,
      renderFrameAndSubtitleLoop, recordTranslationFailure, recordAsrFailure, recordAsrCoverage, hasAsrCoverage,
      waitForCaptionTranslation, checkCaptionReady, onVideoPause, onVideoPlay, onVideoSeeking, onVideoSeeked, probeCaptionTracks,
      handleAudioWorkletMessage, languageTracker, setLookAheadMode, playbackMetrics, setTargetLanguage, pumpTranslationQueue };
  })();`);
  vm.runInContext(testableContent, sandbox);
  return {
    toggle: elements.find((element) => element.className === 'ytp-button yt-lookahead-btn'),
    elements, requests, windowListeners, documentListeners, video, workletMessages, player,
    location: sandbox.location,
    pipeline: sandbox.testPipeline,
    setNow(value) { nowMs = value; },
    activate() {
      video.paused = false;
      const { state, queueEngine } = sandbox.testPipeline;
      Object.assign(state, { active: true, sourceMode: 'asr-delayed', phase: 'buffering',
        generationId: 1, viewerMediaTime: 60, captureMediaTime: 74, bufferedMediaLead: 14,
        targetDelaySec: 8.5, bufferingSince: 1000, boundVideo: video,
        workletNode: { port: { postMessage(message) { workletMessages.push(message); } } },
      });
      queueEngine.resetForSession('demo', 1);
    },
    get playCalls() { return playCalls; },
  };
}

it('ignores page-synthesized clicks and has no public pipeline command event', async () => {
  const fixture = createPlayer({ ok: true, data: { activeAccount: null } });
  fixture.toggle.listeners.get('click')({ isTrusted: false, stopPropagation() {} });
  await new Promise(setImmediate);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.playCalls, 0);
  assert.equal(fixture.windowListeners.has('yt-lookahead-cmd'), false);
});

for (const [name, response, expected] of [
  ['pairing required', { ok: false, data: { error: 'pairing_required' } }, /이 컴퓨터를 연결/],
  ['offline', { ok: false }, /보조 앱 연결 필요/],
  ['signed out', { ok: true, data: { activeAccount: null } }, /ChatGPT 로그인 필요/],
  ['plan permission missing', { ok: true, data: { activeAccount: { signedIn: true, planUsageEnabled: false } } }, /구독 사용 허용 필요/],
]) {
  it(`checks ${name} before changing playback or sending speech`, async () => {
    const fixture = createPlayer(response);
    fixture.toggle.listeners.get('click')({ isTrusted: true, stopPropagation() {} });
    await new Promise(setImmediate);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].payload.path, '/api/auth/status');
    assert.equal(fixture.requests[0].payload.method, 'POST');
    assert.equal(fixture.playCalls, 0);
    assert.ok(fixture.elements.some((element) => expected.test(element.textContent || '')));
  });
}

it('keeps translations from distant seek sessions with reused source IDs', () => {
  const sandbox = {};
  vm.runInNewContext(source('queue-engine.js'), sandbox);
  const { VideoCueCache } = sandbox.YTLookaheadQueue;
  const cache = new VideoCueCache();
  for (const [mediaStart, text] of [[60, '最初'], [62, '続き'], [760, '後半']]) {
    cache.upsertCue('v', { id: 'L0001', text, ko: text, mediaStart, mediaEnd: mediaStart + 2 });
  }
  assert.equal(cache.ensureVideo('v').cues.length, 3);
  assert.equal(cache.getCuesFrom('v', 60).length, 2);
  assert.equal(cache.getCuesFrom('v', 760).length, 1);
  assert.equal(new Set(cache.ensureVideo('v').cues.map((cue) => cue.id)).size, 3);
  cache.upsertCue('v', { id: 'L0002', text: 'simulation', ko: '[SIMULATED]', mediaStart: 64, mediaEnd: 66, simulated: true });
  assert.equal(cache.ensureVideo('v').cues.length, 3);
});

it('flushes short final speech and drains delayed audio after source ends', () => {
  let Processor;
  const messages = [];
  class WorkletBase {
    constructor() { this.port = { postMessage(message) { messages.push(message); } }; }
  }
  vm.runInNewContext(source('audio-worklet.js'), {
    AudioWorkletProcessor: WorkletBase,
    sampleRate: 16000,
    registerProcessor(_name, implementation) { Processor = implementation; },
  });
  const worklet = new Processor();
  worklet.handleMessage({ type: 'flush', generationId: 7, mode: 'buffering', mediaTime: 60 });
  const input = new Float32Array(128).fill(0.4);
  for (let frame = 0; frame < 25; frame++) {
    worklet.process([[input]], [[new Float32Array(128), new Float32Array(128)]]);
  }
  worklet.handleMessage({ type: 'forceEmitAsr' });
  const chunks = messages.filter((message) => message.type === 'asrChunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].generationId, 7);
  assert.ok(Math.abs(chunks[0].chunkEndMediaTime - 60.2) < 0.01);
  worklet.handleMessage({ type: 'sync', capturePaused: true, viewerPaused: false });
  worklet.handleMessage({ type: 'setMode', mode: 'playing' });
  const left = new Float32Array(128);
  worklet.process([[]], [[left, new Float32Array(128)]]);
  assert.ok(left.every((sample) => Math.abs(sample - 0.4) < 0.00001));
  assert.equal(worklet.bufferedBlocks, 24);
});

it('holds detected dialogue until its translation is ready even beyond the former hard cap', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, queueEngine, checkBufferingReady } = fixture.pipeline;
  queueEngine.addSourceLines([{ text: 'まだです', mediaStart: 60.5, mediaEnd: 63 }], 1, 60);
  state.asrProcessedThrough = 74;
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'buffering');
  assert.equal(fixture.workletMessages.length, 0);
  queueEngine.applyTranslationResult(1, { translations: [{ id: 'L0001', ko: '아직이에요' }] }, 60);
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'playing');
  assert.equal(fixture.workletMessages.at(-1).mode, 'playing');
});

it('plays silence only after speech recognition has covered the upcoming interval', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, checkBufferingReady } = fixture.pipeline;
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'buffering');
  state.asrProcessedThrough = 64;
  state.asrCompletedIntervals = [[60, 64]];
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'playing');
});

it('automatically holds the viewer while delayed speech translation catches up', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, queueEngine, renderFrameAndSubtitleLoop, checkBufferingReady } = fixture.pipeline;
  state.phase = 'playing';
  state.bufferedMediaLead = 8.5;
  state.asrProcessedThrough = 70;
  fixture.pipeline.recordAsrCoverage(60, 70);
  queueEngine.addSourceLines([{ text: '遅いです', mediaStart: 60.5, mediaEnd: 63 }], 1, 60);
  renderFrameAndSubtitleLoop();
  assert.equal(state.phase, 'resyncing');
  assert.equal(state.targetDelaySec, 12);
  assert.equal(state.rebufferCount, 1);
  assert.equal(fixture.workletMessages.at(-1).mode, 'buffering');
  queueEngine.recordTranslateTiming(5000);
  queueEngine.applyTranslationResult(1, { translations: [{ id: 'L0001', ko: '늦네요' }] }, 60);
  state.bufferedMediaLead = state.targetDelaySec;
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'playing');
});

it('restores the viewer position and a recoverable error after bounded buffering expires', async () => {
  const fixture = createPlayer();
  fixture.activate();
  fixture.video.currentTime = 84;
  fixture.setNow(27_000);
  fixture.pipeline.checkBufferingReady(fixture.video);
  await new Promise(setImmediate);
  assert.equal(fixture.pipeline.state.active, false);
  assert.equal(fixture.video.currentTime, 60);
  assert.equal(fixture.workletMessages.at(-1).mode, 'passthrough');
  assert.ok(fixture.elements.some((element) => /다시 눌러주세요/.test(element.textContent || '')));
});

it('restores playback after repeated recognition or translation errors', async () => {
  for (const failure of ['recordAsrFailure', 'recordTranslationFailure']) {
    const fixture = createPlayer();
    fixture.activate();
    fixture.video.currentTime = 74;
    fixture.pipeline[failure]('offline');
    fixture.pipeline[failure]('offline');
    assert.equal(fixture.pipeline.state.active, true);
    fixture.pipeline[failure]('offline');
    await new Promise(setImmediate);
    assert.equal(fixture.pipeline.state.active, false);
    assert.equal(fixture.video.currentTime, 60);
    assert.equal(fixture.workletMessages.at(-1).mode, 'passthrough');
  }
});

it('bases trusted relative seek keys on the viewer clock while preserving native absolute seeks', () => {
  const fixture = createPlayer();
  fixture.activate();
  const keydown = fixture.documentListeners.get('keydown');
  const event = (key, trusted = true) => ({ key, isTrusted: trusted, preventDefault() {}, stopImmediatePropagation() {} });
  fixture.video.currentTime = 74;
  keydown(event('ArrowLeft'));
  assert.equal(fixture.video.currentTime, 55);
  keydown(event('ArrowRight'));
  assert.equal(fixture.video.currentTime, 65);
  fixture.video.currentTime = 760;
  keydown(event('1'));
  assert.equal(fixture.video.currentTime, 760);
  keydown(event('ArrowLeft', false));
  assert.equal(fixture.video.currentTime, 760);
});

it('keeps auth errors visible and never resumes a buffer through them', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, checkBufferingReady } = fixture.pipeline;
  state.authError = { code: 'reauth_required' };
  state.asrProcessedThrough = 90;
  state.bufferedMediaLead = 20;
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'buffering');
  assert.equal(fixture.workletMessages.length, 0);
});

it('excludes deliberate user pauses from the buffering timeout', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, checkBufferingReady } = fixture.pipeline;
  fixture.video.paused = true;
  fixture.setNow(2000);
  checkBufferingReady(fixture.video);
  fixture.setNow(62_000);
  checkBufferingReady(fixture.video);
  assert.equal(state.active, true);
  fixture.video.paused = false;
  checkBufferingReady(fixture.video);
  assert.equal(state.active, true);
  assert.equal(state.bufferingSince, 61_000);
});

it('keeps failed speech-recognition gaps uncovered when later chunks finish first', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { recordAsrCoverage, hasAsrCoverage } = fixture.pipeline;
  recordAsrCoverage(66, 70);
  recordAsrCoverage(60, 63.6);
  assert.equal(hasAsrCoverage(63.5, 66.5), false);
  recordAsrCoverage(63.25, 66.85);
  assert.equal(hasAsrCoverage(63.5, 66.5), true);
});

it('stops translation when the underlying YouTube media fails and leaves its error screen available', async () => {
  const fixture = createPlayer();
  fixture.activate();
  fixture.video.error = { code: 2 };
  fixture.pipeline.renderFrameAndSubtitleLoop();
  await new Promise(setImmediate);
  assert.equal(fixture.pipeline.state.active, false);
  assert.match(fixture.pipeline.state.error, /YouTube 재생 오류/);
  assert.equal(fixture.playCalls, 0);
});

it('recognizes the visible nested YouTube error after a source reset and offers the viewer timestamp', async () => {
  const fixture = createPlayer();
  fixture.activate();
  fixture.video.paused = true;
  fixture.video.currentTime = 0;
  fixture.pipeline.state.viewerMediaTime = 84.021;
  const overlay = { textContent: '다시 시도해 보세요', getBoundingClientRect: () => ({ height: 0 }) };
  fixture.player.querySelector = selector => selector === '.ytp-error' ? overlay : null;
  fixture.pipeline.renderFrameAndSubtitleLoop();
  assert.equal(fixture.pipeline.state.active, true, 'hidden template must not interrupt a pause');
  overlay.getBoundingClientRect = () => ({ height: 100 });
  fixture.pipeline.renderFrameAndSubtitleLoop();
  await new Promise(setImmediate);
  assert.equal(fixture.pipeline.state.active, false);
  assert.equal(fixture.playCalls, 0);
  const button = fixture.elements.find(el => el.textContent === '이 위치에서 다시 열기');
  assert.ok(button);
  let target;
  fixture.location.assign = value => { target = value; };
  button.listeners.get('click')({ isTrusted: false, stopPropagation() {} });
  assert.equal(target, undefined);
  button.listeners.get('click')({ isTrusted: true, stopPropagation() {} });
  assert.equal(target, 'https://www.youtube.com/watch?v=demo&t=84s');
});

it('waits for translated current caption turns before resuming and keeps a deliberate pause', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, queueEngine, waitForCaptionTranslation, checkCaptionReady, onVideoPause } = fixture.pipeline;
  state.sourceMode = 'caption-track';
  const cues = [
    { id: 'C1', text: 'Are you serious?', mediaStart: 60, mediaEnd: 61.4, sourceLanguage: 'en', speakerId: 'A' },
    { id: 'C2', text: 'Sí', mediaStart: 61.4, mediaEnd: 62, sourceLanguage: 'es', speakerId: 'B' },
  ];
  queueEngine.addSourceLines(cues, 1);
  waitForCaptionTranslation(fixture.video, true);
  checkCaptionReady(fixture.video);
  assert.equal(fixture.video.paused, true);
  assert.equal(fixture.playCalls, 0);
  onVideoPause(); // The pause initiated by the subtitle barrier.
  onVideoPause(); // A subsequent deliberate pause must cancel auto-resume.
  queueEngine.applyTranslationResult(1, { translations: [{ id: 'C1', ko: '진짜야?' }, { id: 'C2', ko: '응.' }] }, 60);
  checkCaptionReady(fixture.video);
  assert.equal(state.phase, 'playing');
  assert.equal(fixture.playCalls, 0);
});

it('caption seeking fences old translations and waits at the destination', async () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, queueEngine, onVideoSeeking, onVideoSeeked } = fixture.pipeline;
  state.sourceMode = 'caption-track';
  state.phase = 'playing';
  state.captionCues = [
    { id: 'C1', text: 'Hello', mediaStart: 60, mediaEnd: 62 },
    { id: 'C2', text: 'Hola', mediaStart: 120, mediaEnd: 122 },
  ];
  queueEngine.addSourceLines(state.captionCues, 1);
  fixture.video.currentTime = 120;
  onVideoSeeking();
  assert.equal(state.generationId, 2);
  assert.equal(fixture.video.paused, true);
  assert.equal(queueEngine.applyTranslationResult(1, { translations: [{ id: 'C2', ko: '오래된 결과' }] }, 120).accepted, false);
  await onVideoSeeked();
  assert.equal(state.phase, 'buffering');
  assert.equal(fixture.playCalls, 0);
});


it('ignores stale page response tracks after YouTube navigates to another video', () => {
  const stale = { videoDetails: { videoId: 'previous' }, captions: {
    playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'old', languageCode: 'ja' }] },
  } };
  const sandbox = {
    URL, location: { href: 'https://www.youtube.com/watch?v=current' },
    document: { getElementById() { return { getPlayerResponse() { return stale; } }; } },
    ytInitialPlayerResponse: stale,
    addEventListener(_type, handler) { sandbox.receiver = handler; },
    postMessage(message) { sandbox.reply = message; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source('page-probe.js'), sandbox);
  vm.runInContext(`receiver({ source: window, data: {
    source: 'yt-lookahead-content', action: 'probeCaptions', requestId: 'probe'
  } })`, sandbox);
  assert.equal(sandbox.reply.videoId, 'current');
  assert.equal(sandbox.reply.tracks.length, 0);
});

function inspectSourceTracks({ audioTracks, selectedAudio, selectedCaption, captionTracks, defaultAudioTrackIndex = 0, extraResponse = {}, includeAudioLanguage = false }) {
  const response = { ...extraResponse, videoDetails: { ...extraResponse.videoDetails, videoId: 'current' }, captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: captionTracks || [
        { languageCode: 'ja', vssId: '.ja', baseUrl: 'ja' },
        { languageCode: 'en', vssId: '.en', baseUrl: 'en' },
      ], audioTracks, defaultAudioTrackIndex,
    },
  } };
  const sandbox = {
    URL, location: { href: 'https://www.youtube.com/watch?v=current' },
    document: { getElementById() { return {
      getPlayerResponse() { return response; },
      getAudioTrack() { return selectedAudio; },
      getOption() { return selectedCaption; },
    }; } },
    addEventListener(_type, handler) { sandbox.receiver = handler; },
    postMessage(message) { sandbox.reply = message; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source('page-probe.js'), sandbox);
  vm.runInContext(`receiver({ source: window, data: {
    source: 'yt-lookahead-content', action: 'probeCaptions', requestId: 'probe'
  } })`, sandbox);
  return includeAudioLanguage ? sandbox.reply : sandbox.reply.tracks;
}

it('uses the selected dubbed audio caption mapping with CC off', () => {
  const tracks = inspectSourceTracks({
    audioTracks: [
      { audioTrackId: 'original-ja', defaultCaptionTrackIndex: 0, captionTrackIndices: [0] },
      { audioTrackId: 'dub-en', defaultCaptionTrackIndex: 1, captionTrackIndices: [1] },
    ],
    selectedAudio: { id: 'dub-en', languageCode: 'en' },
  });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].languageCode, 'en');
  assert.equal(tracks[0].isOriginal, true);
});

it('falls back to automatic ASR for an unmapped dub and retains the single-audio caption path', () => {
  const audioTracks = [
    { defaultCaptionTrackIndex: 0, captionTrackIndices: [0] },
    { defaultCaptionTrackIndex: 1, captionTrackIndices: [1] },
  ];
  assert.equal(inspectSourceTracks({ audioTracks, selectedAudio: { id: 'unmapped-dub' } }).length, 0);
  const matching = inspectSourceTracks({
    audioTracks, selectedAudio: { id: 'unmapped-dub', languageCode: 'en' },
    selectedCaption: { vssId: '.en', languageCode: 'en' },
  });
  assert.equal(matching.length, 1);
  assert.equal(matching[0].languageCode, 'en');
  const single = inspectSourceTracks({
    audioTracks: [audioTracks[0]], selectedAudio: { id: 'single-original' },
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].languageCode, 'ja');
});

it('does not derive audio language from caption language, track display name or und', () => {
  const result = inspectSourceTracks({
    audioTracks: [{ defaultCaptionTrackIndex: 0, captionTrackIndices: [0] }],
    selectedAudio: { id: 'und', displayName: 'Japanese' }, includeAudioLanguage: true,
  });
  assert.equal(result.audioLanguage, null);
  const tagged = inspectSourceTracks({
    audioTracks: [{ audioTrackId: 'dub-en', defaultCaptionTrackIndex: 1, captionTrackIndices: [1] }],
    selectedAudio: { id: 'dub-en', languageCode: 'en-US' }, includeAudioLanguage: true,
    extraResponse: { videoDetails: { defaultAudioLanguage: 'ja' } },
  });
  assert.equal(tagged.audioLanguage, 'en');
});

it('withholds short unknown-language chunks until one merged confident startup transcript', async () => {
  const fixture = createPlayer({ ok: true, data: {
    detectedLanguage: 'ja', detectedLanguageProbability: 0.92, durationAudioSec: 10.1,
    skippedSilence: false, inferenceMs: 500,
    segments: [{ text: '本当にそうですね', mediaStart: 60, mediaEnd: 62 }],
  } });
  fixture.activate();
  fixture.pipeline.languageTracker.reset({ videoId: 'demo', audioId: 'und', generationId: 1 });
  const pcm = new Int16Array(57600).fill(3000);
  const pcmBase64 = Buffer.from(pcm.buffer).toString('base64');
  for (let i = 0; i < 2; i++) {
    await fixture.pipeline.handleAudioWorkletMessage({
      type: 'asrChunk', generationId: 1, chunkId: i + 1, sampleRate: 16000,
      playbackRate: 1, pcmBase64, chunkStartMediaTime: 60 + i * 3.25,
      chunkEndMediaTime: 63.6 + i * 3.25,
    });
  }
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.pipeline.queueEngine.lines.length, 0);
  await fixture.pipeline.handleAudioWorkletMessage({
    type: 'asrChunk', generationId: 1, chunkId: 3, sampleRate: 16000,
    playbackRate: 1, pcmBase64, chunkStartMediaTime: 66.5, chunkEndMediaTime: 70.1,
  });
  const asr = fixture.requests.filter(request => request.payload.path === '/api/asr');
  assert.equal(asr.length, 1);
  assert.equal(asr[0].payload.body.language, 'auto');
  assert.equal(Buffer.from(asr[0].payload.body.pcmBase64, 'base64').length / 32000, 10.1);
  assert.equal(fixture.pipeline.state.sourceLanguage, 'ja');
  assert.equal(fixture.pipeline.queueEngine.lines[0].text, '本当にそうですね');
  const generation = fixture.pipeline.queueEngine.bumpGeneration('demo');
  fixture.pipeline.languageTracker.reset({ videoId: 'demo', audioId: 'und', generationId: generation });
  assert.equal(fixture.pipeline.languageTracker.language, 'ja');
  fixture.pipeline.languageTracker.reset({ videoId: 'demo', audioId: 'new-track', generationId: generation + 1 });
  assert.equal(fixture.pipeline.languageTracker.language, 'auto');
});

it('continues a verified silent startup without locking a language or blocking later voiced evidence', async () => {
  const fixture = createPlayer({ ok: true, data: {
    durationAudioSec: 10.1, skippedSilence: true, segments: [], inferenceMs: 0,
  } });
  fixture.activate();
  fixture.pipeline.state.languageWarmup = true;
  fixture.pipeline.languageTracker.reset({ videoId: 'demo', audioId: 'und', generationId: 1 });
  const pcmBase64 = Buffer.alloc(57600 * 2).toString('base64');
  for (let i = 0; i < 3; i++) {
    await fixture.pipeline.handleAudioWorkletMessage({
      type: 'asrChunk', generationId: 1, chunkId: i + 1, sampleRate: 16000,
      playbackRate: 1, pcmBase64, chunkStartMediaTime: 60 + i * 3.25,
      chunkEndMediaTime: 63.6 + i * 3.25,
    });
  }
  assert.equal(fixture.pipeline.state.phase, 'playing');
  assert.equal(fixture.pipeline.languageTracker.language, 'auto');
  assert.equal(fixture.pipeline.languageTracker.probeInFlight, false);
  assert.equal(fixture.pipeline.queueEngine.lines.length, 0);
  assert.equal(fixture.requests.filter(request => request.payload.path === '/api/asr').length, 1);
});

it('bounds automatic language startup by wall time below audio ring capacity at faster speed', async () => {
  const fixture = createPlayer();
  fixture.activate();
  fixture.pipeline.state.languageWarmup = true;
  fixture.pipeline.state.bufferedMediaLead = 46;
  fixture.video.playbackRate = 1.5;
  fixture.setNow(31_500);
  fixture.pipeline.checkBufferingReady(fixture.video);
  assert.equal(fixture.pipeline.state.active, true);
  fixture.setNow(33_500);
  fixture.pipeline.checkBufferingReady(fixture.video);
  await new Promise(setImmediate);
  assert.equal(fixture.pipeline.state.active, false);
});

it('counts one resync while a translated tail spans the next missing audio interval', () => {
  const f = createPlayer();
  f.activate();
  const { state, queueEngine, checkBufferingReady, renderFrameAndSubtitleLoop } = f.pipeline;
  state.phase = 'playing';
  state.asrProcessedThrough = 60.5;
  state.asrCompletedIntervals = [[59, 60.5]];
  state.bufferedMediaLead = 19;
  queueEngine.addSourceLines([{id:'tail',text:'反応', mediaStart:59.9, mediaEnd:60.8}], 1, 60);
  queueEngine.applyTranslationResult(1, {translations:[{id:'tail',ko:'반응'}]}, 60);
  renderFrameAndSubtitleLoop();
  for (let frame=0; frame<60; frame++) {
    checkBufferingReady(f.video);
    renderFrameAndSubtitleLoop();
  }
  assert.equal(state.rebufferCount, 1);
  assert.equal(state.phase, 'resyncing');
  state.asrCompletedIntervals = [[59, 66]];
  checkBufferingReady(f.video);
  assert.equal(state.phase, 'playing');
});

it('holds the source near ring capacity through a slow translation and resumes the same session', async () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, queueEngine, checkBufferingReady, onVideoPause } = fixture.pipeline;
  state.phase = 'resyncing';
  state.bufferedMediaLead = 43.5;
  state.bufferedWallSec = 29;
  state.asrCompletedIntervals = [[60, 100]];
  fixture.video.playbackRate = 1.5;
  queueEngine.addSourceLines([{ id: 'wait', text: '次の話', mediaStart: 60, mediaEnd: 64 }], 1);
  fixture.setNow(7_000);
  checkBufferingReady(fixture.video);
  assert.equal(state.active, true);
  assert.equal(fixture.video.paused, true);
  assert.ok(state.sourceHold);
  onVideoPause();
  fixture.setNow(14_000);
  checkBufferingReady(fixture.video);
  assert.equal(state.active, true, 'crossing old lead guard must not discard subtitles');
  queueEngine.applyTranslationResult(1, { translations: [{ id: 'wait', ko: '다음 얘기' }] }, 60);
  checkBufferingReady(fixture.video);
  assert.equal(state.phase, 'playing');
  assert.equal(state.sourceHold, null);
  assert.equal(fixture.playCalls, 1);
  assert.equal(fixture.video.paused, false);
});

it('does not auto-resume a held source after a deliberate pause and still bounds provider stalls', async () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, checkBufferingReady, onVideoPause } = fixture.pipeline;
  state.bufferedWallSec = 29;
  state.asrCompletedIntervals = [[60, 100]];
  fixture.pipeline.queueEngine.addSourceLines([{ id: 'pending', text: '待つ', mediaStart: 60, mediaEnd: 64 }], 1);
  checkBufferingReady(fixture.video);
  onVideoPause(); // Our own source pause.
  onVideoPause(); // A subsequent deliberate pause.
  fixture.pipeline.queueEngine.applyTranslationResult(1, { translations: [{ id: 'pending', ko: '기다려' }] }, 60);
  checkBufferingReady(fixture.video);
  assert.equal(fixture.playCalls, 0);
  assert.equal(state.active, true);

  const stalled = createPlayer();
  stalled.activate();
  stalled.pipeline.state.bufferedWallSec = 29;
  stalled.pipeline.checkBufferingReady(stalled.video);
  stalled.pipeline.onVideoPause();
  stalled.setNow(27_000);
  stalled.pipeline.checkBufferingReady(stalled.video);
  await new Promise(setImmediate);
  assert.equal(stalled.pipeline.state.active, false);
});

it('clears an app-owned source hold when seeking and cancels its resume intent on user pause', () => {
  const fixture = createPlayer();
  fixture.activate();
  const { state, checkBufferingReady, onVideoPause, onVideoSeeking } = fixture.pipeline;
  state.bufferedWallSec = 29;
  fixture.pipeline.queueEngine.addSourceLines([{ id: 'pending', text: '待つ', mediaStart: 60, mediaEnd: 64 }], 1);
  checkBufferingReady(fixture.video);
  onVideoPause();
  onVideoSeeking();
  assert.equal(state.sourceHold, null);
  assert.equal(state.resumeSourceAfterSeek, true);
  assert.equal(state.generationId, 2);
  onVideoPause();
  assert.equal(state.resumeSourceAfterSeek, false);
  assert.equal(fixture.playCalls, 0);
});

it('extended preparation re-buffers once without seeking and restores the native preload hint', () => {
  const fixture = createPlayer();
  fixture.activate();
  fixture.video.preload = 'metadata';
  fixture.pipeline.state.phase = 'playing';
  fixture.pipeline.state.bufferedWallSec = 14;
  const startTime = fixture.video.currentTime;
  fixture.pipeline.setLookAheadMode('extended');
  assert.equal(fixture.pipeline.state.targetDelaySec, 24);
  assert.equal(fixture.pipeline.state.phase, 'resyncing');
  assert.equal(fixture.pipeline.state.rebufferCount, 1);
  assert.equal(fixture.video.preload, 'auto');
  assert.equal(fixture.video.currentTime, startTime);
  fixture.pipeline.setLookAheadMode('extended');
  assert.equal(fixture.pipeline.state.rebufferCount, 1);
  fixture.pipeline.setLookAheadMode('balanced');
  assert.equal(fixture.video.preload, 'metadata');
  assert.equal(fixture.pipeline.state.targetDelaySec, 12);
});

it('reports retained audio and video separately and does not count unavailable local frames as native prepared media', () => {
  const fixture = createPlayer();
  fixture.activate();
  const state = fixture.pipeline.state;
  fixture.video.currentTime = 74;
  fixture.video.buffered = { length: 1, start() { return 60; }, end() { return 120; } };
  state.captureMediaTime = 74;
  state.bufferedMediaLead = 14;
  state.encodedQueue = Array.from({ length: 421 }, (_, index) => ({ mediaTime: 60 + index / 30 }));
  let metrics = fixture.pipeline.playbackMetrics(true);
  assert.equal(metrics.sourceBufferedAheadSec, 46);
  assert.equal(metrics.localAudioLeadSec, 14);
  assert.equal(metrics.localVideoLeadSec, 14);
  assert.equal(metrics.nativeBufferedAheadSec, 60);
  state.encodedQueue = state.encodedQueue.filter(frame => frame.mediaTime < 65 || frame.mediaTime > 66);
  metrics = fixture.pipeline.playbackMetrics(true);
  assert.ok(metrics.localVideoLeadSec < 5.1);
  assert.ok(metrics.nativeBufferedAheadSec < 5.1);
  assert.equal(metrics.readyHorizonAhead, 0);
});

it('translates an uploaded English-only caption into Spanish and fences an in-flight target change at the same playhead', async () => {
  const pending = [];
  const fixture = createPlayer(request => new Promise(resolve => pending.push({ request, resolve })));
  fixture.activate();
  fixture.video.paused = true;
  const { state, queueEngine, setTargetLanguage, playbackMetrics } = fixture.pipeline;
  state.phase = 'playing';
  state.sourceMode = 'caption-track';
  state.sourceLanguage = 'en';
  state.captionSourceKind = 'authored';
  state.captionCues = [
    { id: 'C1', text: 'Hello there', mediaStart: 60, mediaEnd: 62, sourceLanguage: 'en' },
    { id: 'C2', text: 'Yes, welcome', mediaStart: 62, mediaEnd: 64, sourceLanguage: 'en' },
  ];
  queueEngine.addSourceLines(state.captionCues, 1, 60);
  const playhead = fixture.video.currentTime;
  setTargetLanguage('es');
  assert.equal(pending[0].request.payload.body.targetLanguage, 'es');
  assert.equal(pending[0].request.payload.body.lines[0].text, 'Hello there');
  assert.equal(fixture.requests.some(request => request.payload.path === '/api/asr'), false);
  const spanish = pending.shift();
  setTargetLanguage('fr');
  assert.equal(pending[0].request.payload.body.targetLanguage, 'fr');
  const french = pending.shift();
  spanish.resolve({ ok: true, data: {
    translations: [{ id: 'C1', ko: 'Hola' }, { id: 'C2', ko: 'Sí' }],
    targetLanguage: 'es', inferenceMs: 200,
  } });
  await new Promise(setImmediate);
  assert.equal(queueEngine.lines[0].ko, null);
  assert.equal(fixture.video.currentTime, playhead);
  french.resolve({ ok: true, data: {
    translations: [{ id: 'C1', ko: 'Bonjour' }, { id: 'C2', ko: 'Bienvenue' }],
    targetLanguage: 'fr', inferenceMs: 200,
  } });
  await new Promise(setImmediate);
  assert.equal(queueEngine.lines[0].ko, 'Bonjour');
  assert.equal(fixture.video.currentTime, playhead);
  assert.equal(fixture.playCalls, 0, 'language selection preserves the viewer pause');
  assert.equal(playbackMetrics(true).targetLanguage, 'fr');
  assert.ok(fixture.elements.some(element => element.textContent === '프랑스어 자막'));
});

it('retains the only uploaded English subtitle track on a Japanese original without a track mapping', () => {
  const tracks = inspectSourceTracks({audioTracks: [], selectedAudio:{id:'ja.4',languageCode:'ja',isDefault:true},
    captionTracks:[{languageCode:'en',vssId:'.en',baseUrl:'en'}]});
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].languageCode,'en');
});

it('continues playback when extended preload is ahead of ASR but the viewer interval is covered', () => {
  const f = createPlayer();
  f.activate();
  const {state,renderFrameAndSubtitleLoop,recordAsrCoverage} = f.pipeline;
  Object.assign(state,{phase:'playing',viewerMediaTime:373.2,captureMediaTime:397.2,
    bufferedMediaLead:24,asrProcessedThrough:376,asrInFlight:6});
  recordAsrCoverage(350,376);
  renderFrameAndSubtitleLoop();
  assert.equal(state.active,true);
  assert.equal(state.phase,'playing');
  assert.equal(state.error,null);
});

it('selects the verified authored track through normal player caption controls', () => {
  const calls = [];
  const timers = [];
  let selected = false;
  const originalFetch = () => {};
  const originalOpen = () => {};
  const button = {
    getAttribute() { return selected ? 'true' : 'false'; },
    click() { selected = !selected; calls.push(['click']); },
  };
  const response = { videoDetails: { videoId: 'current' }, captions: {
    playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', vssId: '.en', baseUrl: 'https://www.youtube.com/api/timedtext?v=current&lang=en' },
    ], audioTracks: [{ captionTrackIndices: [0] }] },
  } };
  const player = {
    getPlayerResponse() { return response; },
    loadModule(name) { calls.push(['loadModule', name]); },
    setOption(name, field, value) { calls.push(['setOption', name, field, value.languageCode]); selected = true; },
  };
  const sandbox = {
    URL, location: { href: 'https://www.youtube.com/watch?v=current' },
    document: {
      getElementById() { return player; },
      querySelector() { return button; },
    },
    fetch: originalFetch,
    XMLHttpRequest: { prototype: { open: originalOpen } },
    setTimeout(handler) { timers.push(handler); },
    addEventListener(_type, handler) { sandbox.receiver = handler; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source('page-probe.js'), sandbox);
  vm.runInContext(`receiver({ source: window, data: { source: 'yt-lookahead-content',
    action: 'triggerCaptionFetch', videoId: 'current', languageCode: 'en', vssId: '.en', kind: ''
  } })`, sandbox);
  assert.deepEqual(calls.slice(0, 2), [
    ['loadModule', 'captions'], ['setOption', 'captions', 'track', 'en'],
  ]);
  assert.equal(sandbox.fetch, originalFetch);
  assert.equal(sandbox.XMLHttpRequest.prototype.open, originalOpen);
  timers[0]();
  assert.equal(selected, false);
});
