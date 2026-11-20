import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadQueueModule() {
  const code = fs.readFileSync(
    new URL('../../extension/queue-engine.js', import.meta.url),
    'utf8'
  );
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.YTLookaheadQueue;
}

describe('LookaheadQueueEngine & VideoCueCache', () => {
  it('preserves ordinary caption event boundaries as separate potential turns', () => {
    const { parseYouTubeJson3Captions } = loadQueueModule();
    const cues = parseYouTubeJson3Captions({
      events: [
        { tStartMs: 1000, dDurationMs: 1200, segs: [{ utf8: '今日は' }] },
        { tStartMs: 2250, dDurationMs: 1400, segs: [{ utf8: '東京に' }] },
        { tStartMs: 3700, dDurationMs: 1300, segs: [{ utf8: '来ました。' }] },
        { tStartMs: 6500, dDurationMs: 1800, segs: [{ utf8: 'すごいですね！' }] },
      ],
    });
    assert.equal(cues.length, 4);
    assert.equal(cues[0].id, 'C0001');
    assert.equal(cues[0].mediaStart, 1);
    assert.equal(cues[0].text, '今日は');
    assert.equal(cues[3].mediaStart, 6.5);
  });

  it('prioritizes upcoming lines, adapts lookahead window, reuses rewind cache, and fences stale generations', () => {
    const { LookaheadQueueEngine, VideoCueCache } = loadQueueModule();
    const cache = new VideoCueCache();
    const engine = new LookaheadQueueEngine({ cache });

    engine.resetForSession('vid1', 1);
    const added = engine.addSourceLines(
      [
        { text: 'こんにちは', mediaStart: 62.0, mediaEnd: 64.0 },
        { text: '元気ですか', mediaStart: 64.1, mediaEnd: 66.5 },
        { text: 'はい元気です', mediaStart: 66.6, mediaEnd: 69.0 },
      ],
      1,
      60.0
    );
    assert.equal(added.length, 3);

    // First batch should be <= 2 lines for fast startup
    const b1 = engine.pickNextTranslationBatch(60.0);
    assert.equal(b1.lines.length, 2);
    assert.equal(b1.lines[0].id, 'L0001');

    // Stale generation result must be rejected
    const staleRes = engine.applyTranslationResult(
      999,
      { translations: [{ id: 'L0001', ko: 'stale' }] },
      60.0
    );
    assert.equal(staleRes.accepted, false);

    // Valid generation result updates cache and computes positive lead
    const okRes = engine.applyTranslationResult(
      1,
      {
        translations: [
          { id: 'L0001', ko: '안녕하세요' },
          { id: 'L0002', ko: '잘 지내세요?' },
        ],
        inferenceMs: 900,
      },
      60.2
    );
    assert.equal(okRes.accepted, true);
    assert.equal(okRes.updated[0].leadSec, 1.8);
    assert.equal(okRes.updated[1].leadSec, 3.9);

    // Adaptive window grows at 1.5x speed
    const lead1x = engine.getTargetLeadSec(1.0);
    const lead15x = engine.getTargetLeadSec(1.5);
    assert.ok(lead15x > lead1x);

    // Rewind cache reports covered horizon and reloads cues immediately
    assert.ok(cache.getCoveredHorizonFrom('vid1', 62.5) >= 3.5);
    const gen2 = engine.bumpGeneration('vid1');
    assert.equal(gen2, 2);
    const loadedCount = engine.loadCachedCues('vid1', 62.0);
    assert.equal(loadedCount, 2);
    assert.equal(engine.getActiveCueAt(62.5).ko, '안녕하세요');
    assert.equal(engine.getActiveCueAt(62.5).cacheHit, true);
  });
});

it('merges only explicit rolling continuations and uses word offsets without losing short replies', () => {
  const { parseYouTubeJson3Captions } = loadQueueModule();
  const cues = parseYouTubeJson3Captions({ events: [
    { tStartMs: 1000, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: 'This is', tOffsetMs: 200 }] },
    { tStartMs: 2000, dDurationMs: 2000, wWinId: 1, aAppend: 1, segs: [{ utf8: ' great' }] },
    { tStartMs: 4000, dDurationMs: 400, segs: [{ utf8: 'Yeah!' }] },
    { tStartMs: 4450, dDurationMs: 400, segs: [{ utf8: 'Yeah!' }] },
  ] }, { sourceLanguage: 'en', kind: 'asr' });
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'This is great');
  assert.equal(cues[0].mediaStart, 1.2);
  assert.equal(cues[0].sourceLanguage, 'en');
  const engine = new (loadQueueModule().LookaheadQueueEngine)();
  engine.resetForSession('panel', 1);
  engine.addSourceLines(cues, 1);
  assert.equal(engine.lines.length, 3);
});

it('chooses selected source or original language and preserves simultaneous known speakers', () => {
  const { selectCaptionTrack, parseYouTubeJson3Captions, LookaheadQueueEngine } = loadQueueModule();
  const tracks = [
    { languageCode: 'ja', baseUrl: 'ja' },
    { languageCode: 'es', baseUrl: 'es', isOriginal: true },
    { languageCode: 'en', baseUrl: 'en', isSelected: true },
  ];
  assert.equal(selectCaptionTrack(tracks).languageCode, 'en');
  tracks[2].isTranslated = true;
  assert.equal(selectCaptionTrack(tracks).languageCode, 'es');
  const cues = parseYouTubeJson3Captions({ events: [
    { tStartMs: 1000, dDurationMs: 2000, speakerId: 'A', segs: [{ utf8: 'Sí' }] },
    { tStartMs: 1500, dDurationMs: 2000, speakerId: 'B', segs: [{ utf8: 'Sí' }] },
  ] }, { sourceLanguage: 'es' });
  const engine = new LookaheadQueueEngine();
  engine.resetForSession('panel', 1);
  engine.addSourceLines(cues, 1);
  engine.applyTranslationResult(1, { translations: cues.map(cue => ({ id: cue.id, ko: '맞아' })) }, 0);
  assert.equal(engine.getActiveCuesAt(1.2).length, 1);
  assert.equal(engine.getActiveCuesAt(1.6).length, 2);
  assert.equal(engine.getActiveCuesAt(3.05).length, 1, 'timestamp grace must not invent overlap');
  const batch = engine.pickNextTranslationBatch(0);
  assert.equal(batch, null);
});

it('includes previous Korean and available following source without delaying a translation batch', () => {
  const { LookaheadQueueEngine } = loadQueueModule();
  const engine = new LookaheadQueueEngine();
  engine.resetForSession('panel', 1);
  engine.addSourceLines(Array.from({ length: 5 }, (_, i) => ({
    id: 'c' + i, text: 'reply ' + i, mediaStart: i * 2, mediaEnd: i * 2 + 1.5,
    sourceLanguage: 'en', speakerId: i % 2 ? 'B' : 'A',
  })), 1);
  const first = engine.pickNextTranslationBatch(0);
  assert.equal(first.followingLines.length, 2);
  engine.applyTranslationResult(1, { translations: first.lines.map(cue => ({ id: cue.id, ko: '응' })) }, 0);
  const next = engine.pickNextTranslationBatch(3);
  assert.equal(next.contextLines[0].ko, '응');
  assert.equal(next.lines[0].sourceLanguage, 'en');
});

it('splits embedded explicit speakers using their segment offsets and keeps unknown segments in one turn', () => {
  const { parseYouTubeJson3Captions } = loadQueueModule();
  const cues = parseYouTubeJson3Captions({ events: [{
    tStartMs: 10000, dDurationMs: 4000, segs: [
      { utf8: 'Yes', tOffsetMs: 200, speakerId: 'A', languageCode: 'en' },
      { utf8: ', exactly', tOffsetMs: 500 },
      { utf8: 'Sí', tOffsetMs: 1600, speakerId: 'B', languageCode: 'es' },
    ],
  }] });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Yes, exactly');
  assert.equal(cues[0].speakerId, 'A');
  assert.equal(cues[0].mediaStart, 10.2);
  assert.equal(cues[0].mediaEnd, 11.6);
  assert.equal(cues[1].sourceLanguage, 'es');
  assert.equal(cues[1].mediaStart, 11.6);
  assert.equal(cues[1].mediaEnd, 14);
  const unknown = parseYouTubeJson3Captions({ events: [{
    tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world', tOffsetMs: 900 }],
  }] });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].speakerId, null);
});

it('keeps explicitly distinct simultaneous speakers inside one JSON3 event', () => {
  const { parseYouTubeJson3Captions, LookaheadQueueEngine } = loadQueueModule();
  const cues = parseYouTubeJson3Captions({ events: [{
    tStartMs: 1000, dDurationMs: 2000, segs: [
      { utf8: 'Wait!', speakerId: 'A' }, { utf8: 'No!', speakerId: 'B' },
    ],
  }] }, { sourceLanguage: 'en' });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].mediaStart, cues[1].mediaStart);
  assert.equal(cues[0].mediaEnd, cues[1].mediaEnd);
  assert.notEqual(cues[0].id, cues[1].id);
  const engine = new LookaheadQueueEngine();
  engine.resetForSession('overlap', 1);
  engine.addSourceLines(cues, 1);
  engine.applyTranslationResult(1, { translations: cues.map(cue => ({ id: cue.id, ko: cue.text })) }, 0);
  assert.equal(engine.getActiveCuesAt(1.5).length, 2);
});

it('selects 12 or 24 wall seconds while retaining safe ring headroom at faster playback', () => {
  const { LookaheadQueueEngine } = loadQueueModule();
  const engine = new LookaheadQueueEngine();
  assert.equal(engine.getTargetLeadSec(1), 12);
  engine.setLookAheadMode('extended');
  assert.equal(engine.getTargetLeadSec(1), 24);
  assert.equal(engine.getTargetLeadSec(1.5), 36);
  engine.recordTranslateTiming(100000);
  assert.ok(engine.getTargetLeadSec(1.5) / 1.5 <= 26);
  assert.ok(engine.getTargetLeadSec(1.5) / 1.5 < 35);
});

it('counts only contiguous translated speech and never bridges silence or a pending overlapping turn', () => {
  const { LookaheadQueueEngine } = loadQueueModule();
  const engine = new LookaheadQueueEngine();
  engine.resetForSession('video', 1);
  engine.addSourceLines([
    { id: 'A', text: 'First', mediaStart: 60, mediaEnd: 62 },
    { id: 'B', text: 'Second', mediaStart: 62, mediaEnd: 64 },
    { id: 'C', text: 'Later', mediaStart: 70, mediaEnd: 72 },
  ], 1);
  engine.applyTranslationResult(1, { translations: [{ id: 'A', ko: '처음' }, { id: 'C', ko: '나중' }] }, 60);
  assert.equal(engine.getReadyHorizonAhead(60), 2);
  assert.equal(engine.getReadyHorizonAhead(65), 0);
  engine.applyTranslationResult(1, { translations: [{ id: 'B', ko: '다음' }] }, 60);
  assert.equal(engine.getReadyHorizonAhead(60), 4);
  engine.addSourceLines([{ id: 'D', text: 'Overlapping', mediaStart: 61, mediaEnd: 63 }], 1);
  assert.equal(engine.getReadyHorizonAhead(60), 1);
});

it('prefers an authored original over generated captions for the same audio and clears other-target cached translations', () => {
  const { selectCaptionTrack, LookaheadQueueEngine } = loadQueueModule();
  const selected = selectCaptionTrack([
    { baseUrl: 'auto', languageCode: 'en', kind: 'asr', isSelected: true },
    { baseUrl: 'creator', languageCode: 'en', isOriginal: true },
  ]);
  assert.equal(selected.baseUrl, 'creator');
  const queue = new LookaheadQueueEngine();
  queue.resetForSession('source', 1);
  queue.addSourceLines([{ id: 'C1', text: 'Hello', mediaStart: 60, mediaEnd: 62, sourceLanguage: 'en' }], 1);
  queue.setTargetLanguage('es');
  const spanish = queue.pickNextTranslationBatch(60);
  queue.applyTranslationResult(1, { targetLanguage: 'es', translations: [{ id: 'C1', ko: 'Hola' }] }, 60, spanish.translationRevision);
  assert.equal(queue.cache.getCuesFrom('source', 60).length, 1);
  queue.setTargetLanguage('fr');
  assert.equal(queue.lines[0].text, 'Hello');
  assert.equal(queue.lines[0].ko, null);
  assert.equal(queue.cache.getCuesFrom('source', 60).length, 0);
  assert.equal(queue.applyTranslationResult(1, {
    targetLanguage: 'es', translations: [{ id: 'C1', ko: 'Viejo' }],
  }, 60, spanish.translationRevision).accepted, false);
});
