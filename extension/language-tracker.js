(() => {
  const SAMPLE_RATE = 16000;
  const MIN_PROBE_SECONDS = 8;
  const MAX_WINDOW_SECONDS = 12;
  const PROBE_INTERVAL_SECONDS = 30;
  const CONFIDENCE = 0.8;

  function decode(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function encode(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(text);
  }

  function transcriptScriptEvidence(text) {
    const letters = String(text || '').match(/\p{Letter}/gu) || [];
    const kana = letters.filter(letter => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(letter));
    const hangul = letters.filter(letter => /\p{Script=Hangul}/u.test(letter));
    const hiragana = letters.filter(letter => /\p{Script=Hiragana}/u.test(letter));
    if (letters.length < 12) return { language: null, ambiguous: true };
    if (kana.length >= 4 && hangul.length >= 4) return { language: null, ambiguous: true };
    if ((kana.length >= 8 && new Set(kana).size < 5) ||
        (hangul.length >= 8 && new Set(hangul).size < 5)) return { language: null, ambiguous: true };
    if (kana.length >= 8 && hiragana.length < 4) return { language: null, ambiguous: true };
    // Kana and Hangul distinguish these scripts. Han alone also occurs in several languages.
    if (kana.length >= 8 && new Set(kana).size >= 5 && hangul.length === 0) return { language: 'ja', ambiguous: false };
    if (hangul.length >= 8 && new Set(hangul).size >= 5 && kana.length === 0) return { language: 'ko', ambiguous: false };
    return { language: null, ambiguous: false };
  }

  class LanguageTracker {
    constructor() {
      this.identity = null;
      this.language = 'auto';
      this.reset({});
    }

    reset({ videoId = null, audioId = null, generationId = null } = {}) {
      const identity = JSON.stringify([videoId, audioId]);
      if (identity !== this.identity) {
        this.language = 'auto';
        this.lastDecision = null;
      }
      this.identity = identity;
      this.generationId = generationId;
      this.parts = [];
      this.nextId = 0;
      this.pendingEnd = null;
      this.lastProbeEnd = null;
      this.probeInFlight = false;
      this.draining = false;
      this.contraryLanguage = null;
      this.contraryVotes = 0;
    }

    addChunk(chunk) {
      const start = Number(chunk.chunkStartMediaTime);
      const end = Number(chunk.chunkEndMediaTime);
      if (chunk.sampleRate !== SAMPLE_RATE || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const bytes = decode(chunk.pcmBase64);
      if (!bytes.length || bytes.length % 2) return;
      const playbackRate = Number(chunk.playbackRate || 1);
      if (!Number.isFinite(playbackRate) || playbackRate <= 0) return;
      const previous = this.parts.at(-1);
      if (previous && (start > previous.end + 0.15 || previous.playbackRate !== playbackRate)) {
        this.parts = [];
        this.pendingEnd = null;
        this.probeInFlight = false;
        this.draining = false;
      }
      const priorEnd = this.parts.at(-1)?.end;
      const overlap = priorEnd === undefined ? 0 : Math.max(0, priorEnd - start);
      const trimBytes = Math.min(bytes.length, Math.round(overlap / (end - start) * bytes.length / 2) * 2);
      if (trimBytes >= bytes.length) return;
      const kept = bytes.slice(trimBytes);
      const keptStart = start + trimBytes / bytes.length * (end - start);
      this.parts.push({ start: keptStart, end, bytes: kept, playbackRate });
      while (this.language !== 'auto' && this.parts.length > 1 && end - this.parts[0].end >= MAX_WINDOW_SECONDS && (!this.draining || this.parts[0].end <= this.pendingEnd)) this.parts.shift();
    }

    combine(fromTime = -Infinity, maxSeconds = Infinity) {
      const parts = this.parts.filter(part => part.end > fromTime + 0.0001);
      if (!parts.length) return null;
      const first = parts[0];
      const fraction = Math.max(0, (fromTime - first.start) / (first.end - first.start));
      const trimBytes = Math.min(first.bytes.length, Math.round(fraction * first.bytes.length / 2) * 2);
      const arrays = [first.bytes.subarray(trimBytes), ...parts.slice(1).map(part => part.bytes)];
      const size = Math.min(arrays.reduce((sum, bytes) => sum + bytes.length, 0), maxSeconds * SAMPLE_RATE * 2);
      if (!size) return null;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of arrays) {
        const included = part.subarray(0, size - offset);
        bytes.set(included, offset);
        offset += included.length;
        if (offset === size) break;
      }
      const chunkStart = Math.max(first.start, fromTime);
      const span = parts.at(-1).end - chunkStart;
      const totalSize = arrays.reduce((sum, part) => sum + part.length, 0);
      return {
        chunkId: 'language-' + this.generationId + '-' + (++this.nextId),
        pcmBase64: encode(bytes), pcmFormat: 'i16', sampleRate: SAMPLE_RATE,
        playbackRate: first.playbackRate,
        chunkStartMediaTime: chunkStart,
        chunkEndMediaTime: chunkStart + span * size / totalSize,
        durationAudioSec: size / 2 / SAMPLE_RATE,
      };
    }

    getProbeChunk() {
      if (this.probeInFlight) return null;
      const chunk = this.combine(-Infinity, MAX_WINDOW_SECONDS);
      if (!chunk || chunk.durationAudioSec < MIN_PROBE_SECONDS) return null;
      if (this.language !== 'auto' && this.lastProbeEnd !== null &&
          chunk.chunkEndMediaTime - this.lastProbeEnd < PROBE_INTERVAL_SECONDS) return null;
      this.probeInFlight = true;
      this.lastProbeEnd = chunk.chunkEndMediaTime;
      if (this.language === 'auto') {
        this.pendingEnd = chunk.chunkEndMediaTime;
        this.draining = true;
      }
      return { ...chunk, language: 'auto' };
    }

    takePendingChunk() {
      if (this.language === 'auto' || this.pendingEnd === null) return null;
      const chunk = this.combine(this.pendingEnd, 5.5);
      if (chunk) this.pendingEnd = chunk.chunkEndMediaTime;
      else this.draining = false;
      return chunk;
    }

    observe({ detectedLanguage, detectedLanguageProbability, durationAudioSec, probe = false, skippedSilence = false, rawText } = {}) {
      if (!probe) return this.language;
      this.probeInFlight = false;
      if (skippedSilence && this.language === 'auto') {
        const boundary = this.lastProbeEnd;
        this.parts = this.parts.filter(part => part.end > boundary).map(part => {
          const trim = Math.max(0, Math.round((boundary - part.start) / (part.end - part.start) * part.bytes.length / 2) * 2);
          return { start: Math.max(boundary, part.start), end: part.end, bytes: part.bytes.slice(trim), playbackRate: part.playbackRate };
        });
        this.pendingEnd = null;
        this.draining = false;
        return this.language;
      }
      if (!Number.isFinite(durationAudioSec) || durationAudioSec < MIN_PROBE_SECONDS) return this.language;
      const evidence = rawText === undefined ? { language: null, ambiguous: false } : transcriptScriptEvidence(rawText);
      if (evidence.ambiguous) {
        this.lastDecision = { method: 'insufficient_or_mixed_transcript', language: this.language };
        return this.language;
      }
      const language = evidence.language || detectedLanguage;
      if (!evidence.language && (detectedLanguageProbability < CONFIDENCE || !Number.isFinite(detectedLanguageProbability))) return this.language;
      if (!/^[a-z]{2,3}$/.test(language || '')) return this.language;
      this.lastDecision = { method: evidence.language ? 'transcript_script' : 'audio_detection',
        detectedLanguage, language, detectorConfidence: detectedLanguageProbability ?? null };
      if (this.language === 'auto') {
        this.language = language;
        return this.language;
      }
      if (language === this.language) {
        this.contraryLanguage = null;
        this.contraryVotes = 0;
      } else {
        this.contraryVotes = language === this.contraryLanguage ? this.contraryVotes + 1 : 1;
        this.contraryLanguage = language;
        if (this.contraryVotes >= 2) {
          this.language = language;
          this.contraryLanguage = null;
          this.contraryVotes = 0;
        }
      }
      return this.language;
    }
  }

  globalThis.YTLookaheadLanguageTracker = { LanguageTracker, transcriptScriptEvidence };
})();
