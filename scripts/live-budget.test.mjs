import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAudioChunk, authorizeTranslation } from './live-budget.mjs';

const chunk = {
  videoId: 'sulOYazBsvg',
  chunkStartMediaTime: 60,
  chunkEndMediaTime: 63.6,
  sampleRate: 16000,
  playbackRate: 1,
  pcmFormat: 'i16',
  pcmBase64: Buffer.alloc(16000 * 2 * 3.6).toString('base64'),
};
test('live limiter counts repeated/overlapping chunks toward the full 180-second budget', () => {
  let submitted = 0;
  for (let index = 0; index < 50; index++) {
    const result = authorizeAudioChunk(chunk, submitted);
    submitted += result.duration;
  }
  assert.ok(submitted <= 180 + 1e-9);
  assert.throws(() => authorizeAudioChunk(chunk, submitted), /cumulative_audio_cap/);
});
test('live limiter rejects another video, outside timestamps, and changed playback format', () => {
  assert.throws(() => authorizeAudioChunk({ ...chunk, videoId: 'other' }, 0), /scope/);
  assert.throws(() => authorizeAudioChunk({ ...chunk, chunkStartMediaTime: 59.9 }, 0), /window/);
  assert.throws(() => authorizeAudioChunk({ ...chunk, chunkEndMediaTime: 240.1 }, 0), /window/);
  assert.throws(() => authorizeAudioChunk({ ...chunk, playbackRate: 1.5 }, 0), /format/);
});
test('translation lines have timestamps and contextual lines match previously authorized source', () => {
  const line = { mediaStart: 70, mediaEnd: 72, text: 'テスト', id: 'one' };
  const known = new Map();
  authorizeTranslation({ videoId: chunk.videoId, generationId: 1, lines: [line], contextLines: [] }, known);
  const next = { ...line, id: 'two', mediaStart: 73, mediaEnd: 75 };
  const context = { id: 'one', text: 'テスト' };
  authorizeTranslation({ videoId: chunk.videoId, generationId: 1, lines: [next], contextLines: [context] }, known);
  assert.throws(() => authorizeTranslation({ videoId: chunk.videoId, generationId: 2, lines: [next], contextLines: [context] }, known), /context_not_previously_authorized/);
  assert.throws(() => authorizeTranslation({ videoId: chunk.videoId, generationId: 1, lines: [next], contextLines: [{...context, text: 'changed'}] }, known), /context_not_previously_authorized/);
  assert.throws(() => authorizeTranslation({ videoId: chunk.videoId, lines: [{ ...line, mediaStart: 59 }], contextLines: [] }, known), /window/);
});

import { createLiveBudget } from './live-budget.mjs';
const panelVideo = '2LSJpvd9MwI';
const panelLine = { id: 'p1', text: 'そうですね', mediaStart: 100, mediaEnd: 104 };
test('caption-only panel requests count interval union including lookahead while repeats stay within one clip', () => {
  const budget = createLiveBudget({ videoId: panelVideo, start: 100, end: 155, priorSeconds: 109.54 });
  const body = { videoId: panelVideo, generationId: 1, lines: [panelLine], followingLines: [{ id: 'p2', text: 'Yes', mediaStart: 103, mediaEnd: 106 }] };
  budget.prepareTranslation(body);
  assert.equal(budget.cumulativeSeconds, 115.54);
  budget.prepareTranslation(body);
  assert.equal(budget.cumulativeSeconds, 115.54);
  assert.throws(() => budget.prepareTranslation({ ...body, videoId: 'other' }), /scope/);
  assert.throws(() => budget.prepareTranslation({ ...body, lines: [{ ...panelLine, mediaEnd: 156 }] }), /window|source_id_changed/);
  assert.throws(() => budget.prepareTranslation({ ...body, lines: [{ ...panelLine, text: 'changed' }] }), /source_id_changed/);
});
test('optional prior and following context outside a clip is removed before forwarding', () => {
  const budget = createLiveBudget({ videoId: panelVideo, start: 100, end: 140, priorSeconds: 109.54 });
  const safe = budget.prepareTranslation({ videoId: panelVideo, generationId: 1, lines: [panelLine],
    contextLines: [{ id: 'outside', text: 'old' }], followingLines: [{ id: 'next', text: 'outside', mediaStart: 139, mediaEnd: 142 }] });
  assert.deepEqual(safe.contextLines, []);
  assert.deepEqual(safe.followingLines, []);
});
test('audio plus disjoint captions cannot conceal additional source duration', () => {
  const budget = createLiveBudget({ videoId: panelVideo, start: 60, end: 170, priorSeconds: 109.54 });
  const panelChunk = { ...chunk, videoId: panelVideo };
  for (let i = 0; i < 10; i++) budget.authorizeAudio(panelChunk);
  assert.ok(Math.abs(budget.cumulativeSeconds - 145.54) < 1e-8);
  budget.prepareTranslation({ videoId: panelVideo, lines: [{ ...panelLine, mediaStart: 100, mediaEnd: 130 }] });
  assert.ok(Math.abs(budget.cumulativeSeconds - 175.54) < 1e-8);
  assert.throws(() => budget.prepareTranslation({ videoId: panelVideo, lines: [{ id: 'p2', text: 'more', mediaStart: 130, mediaEnd: 136 }] }), /cumulative_source_cap/);
  assert.ok(Math.abs(budget.cumulativeSeconds - 175.54) < 1e-8);
});

test('audio timestamps must match PCM duration and allowed clock drift is charged conservatively', () => {
  const oneSecond = { ...chunk, chunkStartMediaTime: 60, chunkEndMediaTime: 130,
    pcmBase64: Buffer.alloc(16000 * 2).toString('base64') };
  assert.throws(() => authorizeAudioChunk(oneSecond, 0), /audio_duration_mismatch/);
  const drifted = { ...chunk, chunkEndMediaTime: 63.63 };
  const result = authorizeAudioChunk(drifted, 0);
  assert.ok(Math.abs(result.duration - 3.63) < 1e-9);
  assert.equal(result.pcmDuration, 3.6);
  const budget = createLiveBudget({ videoId: chunk.videoId, start: 60, end: 140 });
  for (let i = 0; i < 10; i++) budget.authorizeAudio(drifted);
  assert.ok(Math.abs(budget.cumulativeSeconds - 36.3) < 1e-8);
  assert.ok(Math.abs(budget.submittedAudioSeconds - 36) < 1e-8);
  assert.throws(() => authorizeAudioChunk(drifted, 176.4), /cumulative_audio_cap/);
});

test('extended allowance is restricted to the panel and accepts bounded voiced startup audio', () => {
  assert.throws(() => createLiveBudget({ videoId: chunk.videoId, start: 60, end: 240, panelExtraSeconds: 180 }), /extra_allowance/);
  const panel = createLiveBudget({ videoId: panelVideo, start: 225, end: 407, priorSeconds: 154.14, panelExtraSeconds: 180 });
  const warmup = { ...chunk, videoId: panelVideo, chunkStartMediaTime: 225, chunkEndMediaTime: 235.133,
    pcmBase64: Buffer.alloc(16000 * 2 * 10.1).toString('base64') };
  const accepted = panel.authorizeAudio(warmup);
  assert.ok(Math.abs(accepted.duration - 10.133) < 1e-8);
  assert.throws(() => panel.authorizeAudio({ ...warmup, chunkEndMediaTime: 237.1,
    pcmBase64: Buffer.alloc(16000 * 2 * 12.1).toString('base64') }), /invalid_audio_chunk/);
});

import { createInteractiveClipBinding } from './live-budget.mjs';
test('normal setup delay binds one 180-second viewer clip at the actual activation time', () => {
  const binding = createInteractiveClipBinding({ videoId: panelVideo, earliestStart: 225, latestStart: 255,
    clipSeconds: 180, processingSeconds: 182, priorSeconds: 154.14, panelExtraSeconds: 180 });
  assert.throws(() => binding.requireBudget(), /activation_binding_required/);
  const bound = binding.bind({ videoId: panelVideo, viewerMediaTime: 231.112, nativePlayback: { duration: 1300 } });
  assert.equal(bound.start, 231.112);
  assert.ok(Math.abs(bound.end - 411.112) < 1e-8);
  assert.ok(Math.abs(bound.end - bound.start - 180) < 1e-8);
  assert.ok(Math.abs(bound.processingEnd - 413.112) < 1e-8);
  assert.ok(Math.abs(bound.budget.cumulativeSeconds - 154.14) < 1e-8);
  assert.equal(binding.bind({ videoId: panelVideo, viewerMediaTime: 240, nativePlayback: { duration: 1300 } }), bound);
  assert.throws(() => binding.bind({ videoId: 'other', viewerMediaTime: 240, nativePlayback: { duration: 1300 } }), /scope/);
  assert.equal(binding.requireBudget(), bound.budget);
  bound.budget.prepareTranslation({ videoId: panelVideo, lines: [{ ...panelLine, mediaStart: 231.112, mediaEnd: 235 }] });
  assert.throws(() => bound.budget.prepareTranslation({ videoId: panelVideo, lines: [{ ...panelLine, id: 'outside', mediaStart: 225, mediaEnd: 230 }] }), /window/);
});
test('activation outside the selected panel segment or video duration never creates a spending budget', () => {
  const make = () => createInteractiveClipBinding({ videoId: panelVideo, earliestStart: 225, latestStart: 255,
    clipSeconds: 180, processingSeconds: 182, priorSeconds: 154.14, panelExtraSeconds: 180 });
  const binding = make();
  assert.throws(() => binding.bind({ videoId: panelVideo, viewerMediaTime: 260, nativePlayback: { duration: 1300 } }), /selected_segment/);
  assert.throws(() => binding.requireBudget(), /binding_required/);
  assert.throws(() => make().bind({ videoId: panelVideo, viewerMediaTime: 231.112, nativePlayback: { duration: 400 } }), /video_duration/);
});
