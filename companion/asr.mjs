const DEFAULT_WHISPER_URL = process.env.WHISPER_SERVER_URL || 'http://127.0.0.1:8178';

const HALLUCINATION_ONLY_RE =
  /^(?:ご視聴ありがとうございました|チャンネル登録お願いします|チャンネル登録よろしくお願いします|最後までご視聴いただきありがとうございました|お疲れ様でした|ありがとうございました|ではまた|字幕.*?|[\[\(（【]?(?:音楽|拍手|笑い|効果音|無音|BGM)[\]\)）】]?|[♪♫〜ー.。、,!！?？\s]+)$/u;

/**
 * Encode 16kHz mono PCM16 samples into a standard RIFF/WAV buffer.
 * @param {Int16Array} pcm16
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWavMono16(pcm16, sampleRate = 16000) {
  const dataByteLength = pcm16.byteLength;
  const buffer = Buffer.allocUnsafe(44 + dataByteLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataByteLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataByteLength, 40);
  Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).copy(buffer, 44);
  return buffer;
}

/**
 * Convert base64 Float32 or Int16 PCM payload to Int16Array and compute normalized RMS.
 * @param {string} base64Pcm
 * @param {'f32'|'i16'} format
 */
export function decodePcmPayload(base64Pcm, format = 'i16') {
  const raw = Buffer.from(base64Pcm, 'base64');
  if (format === 'f32') {
    const sampleCount = Math.floor(raw.byteLength / 4);
    const f32 = new Float32Array(raw.buffer, raw.byteOffset, sampleCount);
    const i16 = new Int16Array(sampleCount);
    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      sumSq += s * s;
      i16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return {
      pcm16: i16,
      rms: sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0,
      durationSec: sampleCount / 16000,
    };
  }

  const sampleCount = Math.floor(raw.byteLength / 2);
  const i16 = new Int16Array(sampleCount);
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const v = raw.readInt16LE(i * 2);
    i16[i] = v;
    const norm = v / 32768;
    sumSq += norm * norm;
  }
  return {
    pcm16: i16,
    rms: sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0,
    durationSec: sampleCount / 16000,
  };
}

function splitSegmentWithWords(seg) {
  const text = String(seg.text ?? '').trim();
  const startAudio = Math.max(0, Number(seg.start ?? 0));
  const endAudio = Math.max(startAudio + 0.2, Number(seg.end ?? startAudio + 0.5));
  const words = Array.isArray(seg.words) ? seg.words : [];

  if (words.length < 4 || (text.length <= 26 && endAudio - startAudio <= 3.2)) {
    return [{ text, start: startAudio, end: endAudio }];
  }

  const pieces = [];
  let bufText = '';
  let pieceStart = null;
  let prevEnd = startAudio;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const token = String(w.word ?? '');
    if (!token) continue;
    const wStart = Math.max(startAudio, Number(w.start ?? prevEnd));
    const wEnd = Math.max(wStart + 0.04, Number(w.end ?? wStart + 0.08));

    if (pieceStart === null) pieceStart = wStart;
    const gap = wStart - prevEnd;

    // Split on notable pause before adding next word if current buffer already has substance
    if (gap >= 0.38 && bufText.trim().length >= 8) {
      pieces.push({ text: bufText.trim(), start: pieceStart, end: Math.max(pieceStart + 0.2, prevEnd) });
      bufText = token;
      pieceStart = wStart;
      prevEnd = wEnd;
      continue;
    }

    bufText += token;
    prevEnd = wEnd;

    const trimmed = bufText.trim();
    const isSentenceEnd = /[。？！?!]$/.test(trimmed);
    const isClauseSplit = /[、,]$/.test(trimmed) && trimmed.length >= 14;
    const remainingWords = words.length - 1 - i;

    if ((isSentenceEnd || isClauseSplit) && remainingWords >= 2 && trimmed.length >= 6) {
      pieces.push({ text: trimmed, start: pieceStart, end: Math.max(pieceStart + 0.2, wEnd) });
      bufText = '';
      pieceStart = null;
    }
  }

  if (bufText.trim()) {
    pieces.push({
      text: bufText.trim(),
      start: pieceStart ?? startAudio,
      end: Math.max((pieceStart ?? startAudio) + 0.2, prevEnd),
    });
  }

  return pieces.length > 0 ? pieces : [{ text, start: startAudio, end: endAudio }];
}

/**
 * Filter Whisper segments and map audio-relative timestamps onto exact YouTube media time.
 */
export function normalizeWhisperSegments(rawResult, options = {}) {
  const {
    chunkStartMediaTime = 0,
    chunkEndMediaTime = 0,
    chunkDurationAudioSec = 0,
    playbackRate = 1.0,
    rms = 0.05,
  } = options;

  const effectiveRate =
    chunkDurationAudioSec > 0 && chunkEndMediaTime > chunkStartMediaTime
      ? (chunkEndMediaTime - chunkStartMediaTime) / chunkDurationAudioSec
      : playbackRate || 1.0;

  const segments = Array.isArray(rawResult?.segments) ? rawResult.segments : [];
  const normalized = [];

  for (const seg of segments) {
    const rawText = String(seg.text ?? '').trim();
    if (!rawText) continue;
    const noSpeechProb = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0;
    const avgLogprob = typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0;

    if (noSpeechProb > 0.78 && rms < 0.015) continue;
    if (HALLUCINATION_ONLY_RE.test(rawText) && (rms < 0.012 || noSpeechProb > 0.5 || avgLogprob < -1.0)) {
      continue;
    }

    const subPieces = splitSegmentWithWords(seg);
    for (const sub of subPieces) {
      if (!sub.text || (HALLUCINATION_ONLY_RE.test(sub.text) && rms < 0.012)) continue;
      const startAudio = Math.max(0, sub.start);
      const estimatedEnd = Math.max(startAudio + 0.2, sub.end);
      const endAudio = chunkDurationAudioSec > 0 ? Math.min(estimatedEnd, chunkDurationAudioSec) : estimatedEnd;
      // Whisper can put a whole word in the last timestamp step, beyond the samples it heard.
      if (endAudio < estimatedEnd && endAudio - startAudio <= 0.020001) continue;
      const mediaStart = chunkStartMediaTime + startAudio * effectiveRate;
      const mediaEnd = chunkStartMediaTime + endAudio * effectiveRate;

      normalized.push({
        text: sub.text,
        mediaStart: Number(mediaStart.toFixed(3)),
        mediaEnd: Number(mediaEnd.toFixed(3)),
        audioStart: Number(startAudio.toFixed(3)),
        audioEnd: Number(endAudio.toFixed(3)),
        noSpeechProb,
        avgLogprob,
      });
    }
  }

  // Fallback if whisper-server returns top-level text without segments
  if (segments.length === 0 && typeof rawResult?.text === 'string') {
    const text = rawResult.text.trim();
    if (text && !(HALLUCINATION_ONLY_RE.test(text) && rms < 0.012)) {
      const span =
        chunkEndMediaTime > chunkStartMediaTime
          ? chunkEndMediaTime - chunkStartMediaTime
          : chunkDurationAudioSec * effectiveRate;
      normalized.push({
        text,
        mediaStart: Number(chunkStartMediaTime.toFixed(3)),
        mediaEnd: Number((chunkStartMediaTime + Math.max(0.4, span)).toFixed(3)),
        audioStart: 0,
        audioEnd: chunkDurationAudioSec,
        noSpeechProb: 0,
        avgLogprob: 0,
      });
    }
  }

  return normalized;
}

/**
 * Transcribe a 16kHz mono PCM chunk via local whisper-server.
 */
export async function transcribeChunk({
  pcmBase64,
  pcmFormat = 'i16',
  sampleRate = 16000,
  chunkStartMediaTime = 0,
  chunkEndMediaTime = 0,
  playbackRate = 1.0,
  prompt = '',
  language = 'auto',
  whisperUrl = DEFAULT_WHISPER_URL,
  signal,
  detectOnly = false,
}) {
  const requestedLanguage = String(language || 'auto').toLowerCase().split(/[-_]/)[0];
  if (requestedLanguage !== 'auto' && !/^[a-z]{2,3}$/.test(requestedLanguage)) {
    throw new Error('Invalid source language');
  }
  const startedAt = performance.now();
  const { pcm16, rms, durationSec } = decodePcmPayload(pcmBase64, pcmFormat);

  if (pcm16.length < sampleRate * 0.2) {
    return {
      segments: [],
      skippedSilence: true,
      requestedLanguage,
      detectedLanguage: null,
      detectedLanguageProbability: null,
      rms,
      durationAudioSec: durationSec,
      inferenceMs: 0,
    };
  }

  if (rms < 0.0022) {
    return {
      segments: [],
      skippedSilence: true,
      requestedLanguage,
      detectedLanguage: null,
      detectedLanguageProbability: null,
      rms,
      durationAudioSec: durationSec,
      inferenceMs: 0,
    };
  }

  const wavBuffer = encodeWavMono16(pcm16, sampleRate);
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'chunk.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0.0');
  form.append('language', requestedLanguage);
  if (detectOnly) form.append('detect_language', 'true');
  if (requestedLanguage !== 'auto' && prompt && prompt.trim()) {
    form.append('prompt', prompt.trim().slice(-120));
  }

  const resp = await fetch(`${whisperUrl.replace(/\/$/, '')}/inference`, {
    method: 'POST',
    body: form,
    signal,
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error(`whisper-server HTTP ${resp.status}: ${bodyText.slice(0, 300)}`);
  }

  const rawResult = await resp.json();
  const inferenceMs = Math.round(performance.now() - startedAt);
  const languageCandidates = Object.entries(rawResult.language_probabilities || {})
    .filter(([code, probability]) => /^[a-z]{2,3}$/.test(code) && Number.isFinite(probability))
    .sort((a, b) => b[1] - a[1]);
  const detectedLanguage = languageCandidates[0]?.[0] || null;
  const detectedLanguageProbability = detectedLanguage ? languageCandidates[0][1] : null;
  const segments = normalizeWhisperSegments(rawResult, {
    chunkStartMediaTime,
    chunkEndMediaTime,
    chunkDurationAudioSec: durationSec,
    playbackRate,
    rms,
  });

  return {
    segments,
    rawText: String(rawResult?.text ?? '').trim(),
    requestedLanguage,
    detectedLanguage,
    detectedLanguageProbability,
    skippedSilence: false,
    rms: Number(rms.toFixed(5)),
    durationAudioSec: Number(durationSec.toFixed(3)),
    inferenceMs,
  };
}

/**
 * Check if local whisper-server is reachable and ready.
 */
export async function checkWhisperHealth(whisperUrl = DEFAULT_WHISPER_URL) {
  try {
    const resp = await fetch(`${whisperUrl.replace(/\/$/, '')}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });
    return { ok: resp.ok, status: resp.status, url: whisperUrl };
  } catch (err) {
    return { ok: false, error: err.message, url: whisperUrl };
  }
}
