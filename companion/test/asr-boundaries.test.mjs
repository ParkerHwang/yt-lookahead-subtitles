import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWhisperSegments } from '../asr.mjs';

const window = {
  chunkStartMediaTime: 66.388, chunkEndMediaTime: 70.018559,
  chunkDurationAudioSec: 3.6, playbackRate: 1, rms: 0.1,
};

test('uses only observed audio at the overlapping edge of a Whisper chunk', () => {
  const cues = normalizeWhisperSegments({ segments: [
    { text: '激しいんです。', start: 0, end: 3.63 },
    { text: '本善も有名ですし', start: 3.59, end: 3.79 },
  ] }, window);
  assert.deepEqual(cues.map(cue => cue.text), ['激しいんです。']);
  assert.equal(cues[0].audioEnd, 3.6);
  assert.equal(cues[0].mediaEnd, 70.019);
});

test('keeps an audible short reply and does not resurrect a wholly out-of-range segment', () => {
  const short = normalizeWhisperSegments({ segments: [{ text: 'はい', start: 3.40, end: 3.72 }] }, window);
  assert.equal(short.length, 1);
  assert.equal(short[0].audioEnd, 3.6);
  assert.deepEqual(normalizeWhisperSegments({ text: 'はい', segments: [
    { text: 'はい', start: 3.65, end: 3.85 },
  ] }, window), []);
  assert.equal(normalizeWhisperSegments({ text: 'はい' }, window).length, 1);
});
