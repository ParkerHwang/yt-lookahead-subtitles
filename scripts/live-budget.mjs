/** Authorization limits for a single explicitly selected verification clip. */
export const AUTHORIZED_VIDEO_ID = 'sulOYazBsvg';
export const SOURCE_START = 60;
export const SOURCE_END = 240;
export const AUDIO_SECONDS_LIMIT = 180;
export const TEST_CASES = {
  radio: { videoId: AUTHORIZED_VIDEO_ID, priorSeconds: 0, captionless: true },
  boyfriend2: { videoId: '2LSJpvd9MwI', priorSeconds: 109.54, captionless: false, requiredModel: 'gpt-6-luna' },
};

const defaultScope = { videoId: AUTHORIZED_VIDEO_ID, start: SOURCE_START, end: SOURCE_END };
function withinWindow(start, end, scope) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= scope.start && end <= scope.end && end > start;
}
function checkVideo(body, scope) {
  if (body.videoId !== scope.videoId) throw new Error('video_outside_authorized_scope');
}
function mergeIntervals(intervals) {
  const merged = [];
  for (const interval of [...intervals].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}
const intervalSeconds = intervals => intervals.reduce((total, [start, end]) => total + end - start, 0);

export function authorizeAudioChunk(body, audioSecondsAlreadySubmitted, scope = defaultScope, totalLimit = AUDIO_SECONDS_LIMIT) {
  checkVideo(body, scope);
  const start = Number(body.chunkStartMediaTime), end = Number(body.chunkEndMediaTime);
  if (!withinWindow(start, end, scope)) throw new Error('audio_outside_authorized_window');
  if (body.pcmFormat !== 'i16' || body.sampleRate !== 16000 || body.playbackRate !== 1) throw new Error('unexpected_audio_format');
  const bytes = Buffer.from(body.pcmBase64 || '', 'base64').length;
  const duration = bytes / 2 / 16000;
  if (!duration || duration > 12 || bytes % 2 !== 0) throw new Error('invalid_audio_chunk');
  const span = end - start;
  // Capture timestamps are synchronized at roughly 40 ms intervals. Permit small clock drift only.
  if (Math.abs(span - duration) > 0.08 + 1e-9) throw new Error('audio_duration_mismatch');
  const chargedDuration = Math.max(duration, span);
  if (audioSecondsAlreadySubmitted + chargedDuration > totalLimit + 1e-9) throw new Error('cumulative_audio_cap');
  return { start, end, duration: chargedDuration, pcmDuration: duration };
}

export function authorizeTranslation(body, authorizedLines = new Map(), scope = defaultScope) {
  checkVideo(body, scope);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.some(line =>
    !withinWindow(Number(line.mediaStart), Number(line.mediaEnd), scope))) throw new Error('translation_outside_authorized_window');
  for (const line of body.contextLines || []) {
    if (authorizedLines.get(`${body.generationId}:${line.id}`) !== line.text) throw new Error('context_not_previously_authorized');
  }
  for (const line of body.followingLines || []) {
    if (!withinWindow(Number(line.mediaStart), Number(line.mediaEnd), scope)) throw new Error('following_outside_authorized_window');
  }
  for (const line of body.lines) authorizedLines.set(`${body.generationId}:${line.id}`, line.text);
}

export function createLiveBudget({ videoId, start, end, priorSeconds = 0, panelExtraSeconds = 0 }) {
  if (![0, 180].includes(panelExtraSeconds) || (panelExtraSeconds && videoId !== TEST_CASES.boyfriend2.videoId)) throw new Error('invalid_extra_allowance');
  const totalLimit = AUDIO_SECONDS_LIMIT + panelExtraSeconds;
  const scope = { videoId, start, end };
  if (!Object.values(TEST_CASES).some(test => test.videoId === videoId) || !Number.isFinite(start) || start < 0 ||
      !Number.isFinite(end) || end <= start || !Number.isFinite(priorSeconds) || priorSeconds < 0 || priorSeconds >= totalLimit) {
    throw new Error('invalid_test_scope');
  }
  let audioSeconds = 0;
  let pcmSeconds = 0;
  let sourceIntervals = [];
  let audioIntervals = [];
  const known = new Map();
  const knownBounds = new Map();
  function totalFor(intervals, audio = audioSeconds, audioCoverage = audioIntervals) {
    // Count repeated PCM submissions, while caption repeats and overlap consume one source interval.
    return priorSeconds + audio + intervalSeconds(intervals) - intervalSeconds(audioCoverage);
  }
  return {
    scope,
    get cumulativeSeconds() { return totalFor(sourceIntervals); },
    get submittedAudioSeconds() { return pcmSeconds; },
    authorizeAudio(body) {
      const result = authorizeAudioChunk(body, priorSeconds + audioSeconds, scope, totalLimit);
      const nextIntervals = mergeIntervals([...sourceIntervals, [result.start, result.end]]);
      const nextAudioIntervals = mergeIntervals([...audioIntervals, [result.start, result.end]]);
      if (totalFor(nextIntervals, audioSeconds + result.duration, nextAudioIntervals) > totalLimit + 1e-9) throw new Error('cumulative_source_cap');
      audioSeconds += result.duration;
      pcmSeconds += result.pcmDuration;
      audioIntervals = nextAudioIntervals;
      sourceIntervals = nextIntervals;
      return result;
    },
    prepareTranslation(body) {
      const bounded = { ...body,
        contextLines: (body.contextLines || []).filter(line => known.get(`${body.generationId}:${line.id}`) === line.text),
        followingLines: (body.followingLines || []).filter(line => withinWindow(Number(line.mediaStart), Number(line.mediaEnd), scope)),
      };
      // A repeated ID must never be reinterpreted as different source text in the same generation.
      for (const line of bounded.lines || []) {
        const key = `${body.generationId}:${line.id}`;
        const previous = knownBounds.get(key);
        if (previous && (previous.text !== line.text || previous.start !== line.mediaStart || previous.end !== line.mediaEnd)) throw new Error('source_id_changed');
      }
      const nextKnown = new Map(known);
      authorizeTranslation(bounded, nextKnown, scope);
      const intervals = [...bounded.lines, ...bounded.followingLines].map(line => [Number(line.mediaStart), Number(line.mediaEnd)]);
      const nextIntervals = mergeIntervals([...sourceIntervals, ...intervals]);
      if (totalFor(nextIntervals) > totalLimit + 1e-9) throw new Error('cumulative_source_cap');
      for (const line of bounded.lines) {
        const key = `${body.generationId}:${line.id}`;
        known.set(key, line.text);
        knownBounds.set(key, { text: line.text, start: line.mediaStart, end: line.mediaEnd });
      }
      sourceIntervals = nextIntervals;
      return bounded;
    },
  };
}

export function createInteractiveClipBinding({ videoId, earliestStart, latestStart, clipSeconds, processingSeconds, priorSeconds, panelExtraSeconds = 0 }) {
  let bound = null;
  return {
    get current() { return bound; },
    bind(sample) {
      if (sample.videoId !== videoId) throw new Error('video_outside_authorized_scope');
      if (bound) return bound;
      const start = Number(sample.viewerMediaTime);
      const duration = Number(sample.nativePlayback?.duration);
      if (!Number.isFinite(start) || start < earliestStart - 0.08 || start > latestStart + 0.08) throw new Error('activation_outside_selected_segment');
      if (!Number.isFinite(duration) || start + processingSeconds > duration) throw new Error('clip_outside_video_duration');
      bound = { start, end: start + clipSeconds, processingEnd: start + processingSeconds,
        budget: createLiveBudget({ videoId, start, end: start + processingSeconds, priorSeconds, panelExtraSeconds }) };
      return bound;
    },
    requireBudget() {
      if (!bound) throw new Error('activation_binding_required');
      return bound.budget;
    },
  };
}
