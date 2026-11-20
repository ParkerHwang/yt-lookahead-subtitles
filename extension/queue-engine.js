(() => {
  const MAX_CACHE_CUES_PER_VIDEO = 2500;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function normalizeTextForOverlap(str) {
    return String(str || '')
      .replace(/[\s、。？！,.?!「」『』（）()]/g, '')
      .trim();
  }

  function sharedOverlapLength(prevText, nextText) {
    const a = normalizeTextForOverlap(prevText);
    const b = normalizeTextForOverlap(nextText);
    if (!a || !b) return 0;
    const maxLen = Math.min(a.length, b.length);
    for (let len = maxLen; len >= 3; len--) {
      if (a.endsWith(b.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /**
   * Parse YouTube timedtext `fmt=json3` payload into clean, timestamped subtitle lines.
   */
  function parseYouTubeJson3Captions(json, { sourceLanguage = null, kind = '' } = {}) {
    const events = Array.isArray(json?.events) ? json.events : [];
    const cues = [];
    for (const event of events) {
      if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
      const start = event.tStartMs / 1000;
      const duration = Number.isFinite(event.dDurationMs) && event.dDurationMs > 0
        ? event.dDurationMs / 1000 : 2.5;
      const groups = [];
      let group;
      for (const segment of event.segs) {
        const fragment = String(segment.utf8 || '');
        if (!fragment.trim() && !group) continue;
        const explicitSpeaker = segment.speakerId ?? event.speakerId;
        const speakerId = explicitSpeaker == null ? group?.speakerId ?? null : String(explicitSpeaker);
        const language = segment.languageCode || event.languageCode || sourceLanguage;
        const hasOffset = Number.isFinite(segment.tOffsetMs);
        const offset = hasOffset ? Math.max(0, segment.tOffsetMs) / 1000 : 0;
        if (group && group.speakerId === null && explicitSpeaker != null) group.speakerId = speakerId;
        if (!group || explicitSpeaker != null && speakerId !== group.speakerId) {
          group = { text: '', speakerId, sourceLanguage: language, offset, hasOffset };
          groups.push(group);
        }
        group.text += fragment;
      }
      for (let index = 0; index < groups.length; index++) {
        const item = groups[index];
        const text = item.text.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
        if (!text) continue;
        const next = groups[index + 1];
        const mediaStart = start + item.offset;
        const end = next?.hasOffset && next.offset > item.offset ? start + next.offset : start + duration;
        const cue = {
          text, mediaStart, mediaEnd: Math.max(mediaStart + 0.08, end),
          sourceLanguage: item.sourceLanguage, speakerId: item.speakerId,
          windowId: event.wWinId ?? null, captionKind: kind,
        };
        const previous = cues.at(-1);
        // aAppend is meaningful only for one continuing turn, not embedded speaker changes.
        if (groups.length === 1 && event.aAppend === 1 && previous && previous.windowId === cue.windowId &&
            previous.speakerId === cue.speakerId && cue.mediaStart <= previous.mediaEnd + 0.2 &&
            cue.mediaEnd - previous.mediaStart <= 4.2) {
          previous.text += (previous.text.endsWith(' ') || cue.text.startsWith(' ') ? '' : ' ') + cue.text;
          previous.mediaEnd = Math.max(previous.mediaEnd, cue.mediaEnd);
          continue;
        }
        if (kind === 'asr' && previous && previous.windowId === cue.windowId &&
            previous.speakerId === cue.speakerId && previous.mediaEnd > cue.mediaStart) {
          previous.mediaEnd = Math.max(previous.mediaStart + 0.08, cue.mediaStart);
        }
        cues.push(cue);
      }
    }
    return cues.map((cue, index) => ({
      ...cue, id: 'C' + String(index + 1).padStart(4, '0'),
      mediaStart: Number(cue.mediaStart.toFixed(3)), mediaEnd: Number(cue.mediaEnd.toFixed(3)),
    }));
  }

  function selectCaptionTrack(tracks) {
    const playable = Array.isArray(tracks) ? tracks.filter(track => track?.baseUrl && !track.isTranslated) : [];
    const selected = playable.find(track => track.isSelected);
    if (selected) {
      return selected.kind === 'asr'
        ? playable.find(track => track.kind !== 'asr' && track.languageCode === selected.languageCode) || selected
        : selected;
    }
    return playable.find(track => track.isOriginal && track.kind !== 'asr') ||
      playable.find(track => track.kind !== 'asr') ||
      playable.find(track => track.isOriginal) || playable[0] || null;
  }

  class VideoCueCache {
    constructor() {
      this.videos = new Map();
    }

    ensureVideo(videoId) {
      if (!this.videos.has(videoId)) {
        this.videos.set(videoId, { cues: [], intervals: [] });
      }
      return this.videos.get(videoId);
    }

    recordInterval(videoId, start, end) {
      if (!videoId || !(end > start)) return;
      const entry = this.ensureVideo(videoId);
      entry.intervals.push([start, end]);
      entry.intervals.sort((a, b) => a[0] - b[0]);

      const merged = [];
      for (const iv of entry.intervals) {
        if (merged.length === 0) {
          merged.push([...iv]);
        } else {
          const last = merged[merged.length - 1];
          if (iv[0] <= last[1] + 1.5) {
            last[1] = Math.max(last[1], iv[1]);
          } else {
            merged.push([...iv]);
          }
        }
      }
      entry.intervals = merged;
    }

    upsertCue(videoId, cue) {
      if (!videoId || !cue || !cue.ko || cue.simulated) return;
      const entry = this.ensureVideo(videoId);
      const existingIdx = entry.cues.findIndex(
        (c) =>
          Math.abs(c.mediaStart - cue.mediaStart) < 0.35 && c.text === cue.text &&
          c.sourceLanguage === (cue.sourceLanguage || null)
      );
      const stored = {
        id: `cache:${cue.mediaStart}:${cue.mediaEnd}:${cue.text}`,
        text: cue.text,
        ko: cue.ko,
        mediaStart: cue.mediaStart,
        mediaEnd: cue.mediaEnd,
        simulated: Boolean(cue.simulated),
        model: cue.model || null,
        sourceLanguage: cue.sourceLanguage || null,
        speakerId: cue.speakerId || null,
        windowId: cue.windowId ?? null,
      };
      if (existingIdx >= 0) {
        entry.cues[existingIdx] = stored;
      } else {
        entry.cues.push(stored);
        entry.cues.sort((a, b) => a.mediaStart - b.mediaStart);
        if (entry.cues.length > MAX_CACHE_CUES_PER_VIDEO) {
          entry.cues.shift();
        }
      }
      this.recordInterval(videoId, cue.mediaStart, cue.mediaEnd);
    }

    getCoveredHorizonFrom(videoId, timeSec) {
      const entry = this.videos.get(videoId);
      if (!entry) return 0;
      for (const [start, end] of entry.intervals) {
        if (timeSec >= start - 1.0 && timeSec <= end) {
          return Math.max(0, end - timeSec);
        }
      }
      return 0;
    }

    getCuesFrom(videoId, timeSec) {
      const entry = this.videos.get(videoId);
      if (!entry) return [];
      const coveredEnd = timeSec + this.getCoveredHorizonFrom(videoId, timeSec);
      return entry.cues
        .filter((c) => c.mediaEnd >= timeSec - 0.5 && c.mediaStart <= coveredEnd)
        .map((c) => ({ ...c, cacheHit: true, status: 'ready' }));
    }
  }

  class LookaheadQueueEngine {
    constructor(options = {}) {
      this.cache = options.cache || new VideoCueCache();
      this.videoId = null;
      this.generationId = 0;
      this.lines = [];
      this.lineById = new Map();
      this.nextSeq = 0;
      this.hasFirstReady = false;

      // Adaptive window EWMA state
      this.ewmaChunkSpanSec = 3.2;
      this.ewmaAsrSec = 1.6;
      this.ewmaTranslateSec = 1.0;
      this.minDelaySec = options.minDelaySec ?? 8.5;
      this.maxDelaySec = options.maxDelaySec ?? 16.0;
      this.safetyMarginSec = options.safetyMarginSec ?? 2.4;
      this.lookAheadMode = 'balanced';
      this.targetLanguage = 'ko';
      this.translationRevision = 0;
    }

    setTargetLanguage(targetLanguage) {
      if (this.targetLanguage === targetLanguage) return;
      this.targetLanguage = targetLanguage;
      this.translationRevision++;
      this.cache.videos.clear();
      this.hasFirstReady = false;
      for (const line of this.lines) {
        line.status = 'pending';
        line.ko = null;
        line.cacheHit = false;
        line.readyAtViewerTime = null;
        line.leadSec = null;
      }
    }

    resetForSession(videoId, generationId) {
      this.videoId = videoId;
      this.generationId = generationId;
      this.lines = [];
      this.lineById.clear();
      this.nextSeq = 0;
      this.hasFirstReady = false;
    }

    bumpGeneration(videoId = this.videoId) {
      this.generationId++;
      this.resetForSession(videoId, this.generationId);
      return this.generationId;
    }

    loadCachedCues(videoId, fromTimeSec) {
      const cached = this.cache.getCuesFrom(videoId, fromTimeSec);
      for (const item of cached) {
        this.lines.push({
          ...item,
          readyAtViewerTime: fromTimeSec,
          leadSec: Number((item.mediaStart - fromTimeSec).toFixed(3)),
          status: 'ready',
          cacheHit: true,
        });
        this.lineById.set(item.id, this.lines[this.lines.length - 1]);
      }
      if (cached.length > 0) {
        this.hasFirstReady = true;
      }
      return cached.length;
    }

    addSourceLines(rawSegments, generationId, discoveredAtViewerTime = 0) {
      if (generationId !== this.generationId) return [];
      const added = [];

      for (const seg of rawSegments) {
        const text = String(seg.text || '').trim();
        if (!text) continue;
        const mediaStart = Number(seg.mediaStart);
        const rawEnd = Number(seg.mediaEnd);
        if (!Number.isFinite(mediaStart) || mediaStart < 0 || !Number.isFinite(rawEnd)) continue;
        const mediaEnd = Math.max(mediaStart + 0.25, rawEnd);

        // Deduplicate overlap against previous source lines
        const prev = this.lines[this.lines.length - 1];
        if (prev && !seg.id && !(seg.speakerId && prev.speakerId && seg.speakerId !== prev.speakerId)) {
          const sameExact =
            normalizeTextForOverlap(prev.text) === normalizeTextForOverlap(text) &&
            Math.abs(prev.mediaStart - mediaStart) < 1.8 &&
            mediaStart < prev.mediaEnd && mediaEnd > prev.mediaStart;
          if (sameExact) continue;

          if (mediaStart < prev.mediaEnd + 0.25) {
            const overlapChars = sharedOverlapLength(prev.text, text);
            if (overlapChars >= 4 && overlapChars >= normalizeTextForOverlap(text).length * 0.7) {
              continue;
            }
          }
        }

        // Reuse cached translation if exact cue already translated
        const cachedMatch = this.cache
          .ensureVideo(this.videoId)
          .cues.find(
            (c) =>
              Math.abs(c.mediaStart - mediaStart) < 0.45 &&
              normalizeTextForOverlap(c.text) === normalizeTextForOverlap(text) &&
              (!seg.sourceLanguage || c.sourceLanguage === seg.sourceLanguage)
          );

        const id = seg.id || `L${String(++this.nextSeq).padStart(4, '0')}`;
        if (this.lineById.has(id)) continue;

        const line = {
          id,
          text,
          mediaStart: Number(mediaStart.toFixed(3)),
          mediaEnd: Number(mediaEnd.toFixed(3)),
          status: cachedMatch ? 'ready' : 'pending',
          ko: cachedMatch ? cachedMatch.ko : null,
          simulated: cachedMatch ? cachedMatch.simulated : false,
          model: cachedMatch ? cachedMatch.model : null,
          cacheHit: Boolean(cachedMatch),
          asrReadyAtViewerTime: Number(discoveredAtViewerTime.toFixed(3)),
          readyAtViewerTime: cachedMatch ? Number(discoveredAtViewerTime.toFixed(3)) : null,
          leadSec: cachedMatch
            ? Number((mediaStart - discoveredAtViewerTime).toFixed(3))
            : null,
          inferenceMs: seg.inferenceMs ?? null,
          sourceLanguage: seg.sourceLanguage || null,
          speakerId: seg.speakerId || null,
          windowId: seg.windowId ?? null,
        };

        if (cachedMatch) {
          this.hasFirstReady = true;
        }
        this.lines.push(line);
        this.lineById.set(id, line);
        added.push(line);
      }

      this.lines.sort((a, b) => a.mediaStart - b.mediaStart);
      return added;
    }

    /**
     * Pick the earliest untranslated lines the viewer will see next, plus preceding context.
     */
    pickNextTranslationBatch(viewerMediaTime, maxHorizonSec = 35) {
      const candidates = this.lines.filter(
        (l) =>
          l.status === 'pending' &&
          l.mediaEnd >= viewerMediaTime - 0.3 &&
          l.mediaStart <= viewerMediaTime + maxHorizonSec
      );
      if (candidates.length === 0) return null;

      // Smaller initial batch minimizes initial startup wait before playback resumes
      const maxBatchCount = this.hasFirstReady ? 3 : 2;
      const batch = [];
      for (const c of candidates) {
        if (batch.length >= maxBatchCount) break;
        if (batch.length > 0 && c.mediaStart - batch[0].mediaStart > 7.5) break;
        c.status = 'translating';
        batch.push(c);
      }

      const firstIdx = this.lines.indexOf(batch[0]);
      const describe = (line) => ({
        id: line.id, text: line.text, mediaStart: line.mediaStart, mediaEnd: line.mediaEnd,
        sourceLanguage: line.sourceLanguage, speakerId: line.speakerId,
      });
      const contextLines = this.lines.slice(Math.max(0, firstIdx - 3), firstIdx)
        .map(line => ({ ...describe(line), ...(line.status === 'ready' ? { ko: line.ko } : {}) }));
      const lastIdx = this.lines.indexOf(batch.at(-1));
      const followingLines = this.lines.slice(lastIdx + 1, lastIdx + 3)
        .filter(line => line.mediaStart <= viewerMediaTime + maxHorizonSec)
        .map(describe);
      return {
        generationId: this.generationId, targetLanguage: this.targetLanguage,
        translationRevision: this.translationRevision, lines: batch.map(describe),
        contextLines, followingLines,
      };
    }

    markBatchFailed(generationId, lineIds, errInfo) {
      if (generationId !== this.generationId) return false;
      for (const id of lineIds) {
        const line = this.lineById.get(id);
        if (line && line.status === 'translating') {
          line.status = 'pending';
          line.lastError = errInfo?.code || errInfo?.message || 'translation_error';
        }
      }
      return true;
    }

    applyTranslationResult(generationId, result, readyAtViewerTime, translationRevision = this.translationRevision) {
      if (generationId !== this.generationId || translationRevision !== this.translationRevision ||
          result.targetLanguage && result.targetLanguage !== this.targetLanguage) {
        return { accepted: false, updated: [] };
      }
      const updated = [];
      const translations = Array.isArray(result?.translations) ? result.translations : [];
      for (const item of translations) {
        const line = this.lineById.get(item.id);
        if (!line) continue;
        line.ko = item.ko;
        line.status = 'ready';
        line.simulated = Boolean(result.simulated);
        line.model = result.model || null;
        line.readyAtViewerTime = Number(readyAtViewerTime.toFixed(3));
        line.leadSec = Number((line.mediaStart - readyAtViewerTime).toFixed(3));
        line.translateInferenceMs = result.inferenceMs ?? null;
        this.hasFirstReady = true;
        this.cache.upsertCue(this.videoId, line);
        updated.push(line);
      }
      return { accepted: true, updated };
    }

    recordAsrTiming({ chunkSpanSec, asrMs }) {
      const alpha = 0.35;
      if (typeof chunkSpanSec === 'number' && chunkSpanSec > 0.3) {
        this.ewmaChunkSpanSec = (1 - alpha) * this.ewmaChunkSpanSec + alpha * chunkSpanSec;
      }
      if (typeof asrMs === 'number' && asrMs > 0) {
        this.ewmaAsrSec = (1 - alpha) * this.ewmaAsrSec + alpha * (asrMs / 1000);
      }
    }

    recordTranslateTiming(translateMs) {
      if (typeof translateMs === 'number' && translateMs > 0) {
        const alpha = 0.35;
        this.ewmaTranslateSec =
          (1 - alpha) * this.ewmaTranslateSec + alpha * (translateMs / 1000);
      }
    }

    setLookAheadMode(mode) {
      this.lookAheadMode = mode === 'extended' ? 'extended' : 'balanced';
    }

    getMaximumLeadSec(playbackRate = 1) {
      return 26 * Math.max(0.25, Number(playbackRate) || 1);
    }

    getTargetLeadSec(playbackRate = 1.0) {
      const rate = Math.max(0.25, Number(playbackRate || 1));
      const preferredWall = this.lookAheadMode === 'extended' ? 24 : 12;
      const measuredWall = this.ewmaChunkSpanSec + this.ewmaAsrSec +
        this.ewmaTranslateSec + this.safetyMarginSec;
      return Number((clamp(Math.max(preferredWall, measuredWall), preferredWall, 26) * rate).toFixed(2));
    }

    getActiveCuesAt(viewerMediaTime) {
      const candidates = this.lines.filter(line => line.status === 'ready' && line.ko &&
        viewerMediaTime >= line.mediaStart - 0.04 && viewerMediaTime <= line.mediaEnd + 0.18);
      if (!candidates.length) return [];
      let latest = candidates.at(-1);
      // A tiny chunk-edge fragment should not flash over an ongoing full utterance.
      const containing = candidates.find(line => line !== latest && !line.speakerId && !latest.speakerId &&
        line.mediaStart <= latest.mediaStart && line.mediaEnd >= latest.mediaEnd &&
        latest.mediaEnd - latest.mediaStart < 0.35 && line.mediaEnd - line.mediaStart > 1);
      if (containing) latest = containing;
      const otherSpeaker = latest.speakerId && candidates.find(line => line !== latest &&
        line.speakerId && line.speakerId !== latest.speakerId &&
        viewerMediaTime >= Math.max(line.mediaStart, latest.mediaStart) &&
        viewerMediaTime < Math.min(line.mediaEnd, latest.mediaEnd));
      return otherSpeaker ? [otherSpeaker, latest] : [latest];
    }

    getActiveCueAt(viewerMediaTime) {
      return this.getActiveCuesAt(viewerMediaTime).at(-1) || null;
    }

    getReadyHorizonAhead(viewerMediaTime) {
      let end = viewerMediaTime;
      for (const line of this.lines) {
        if (line.status === 'ready' && line.ko && line.mediaEnd > end && line.mediaStart <= end + 0.05) {
          end = line.mediaEnd;
        }
      }
      const blocked = this.lines.find(line => line.status !== 'ready' &&
        line.mediaEnd > viewerMediaTime && line.mediaStart < end);
      if (blocked) end = Math.max(viewerMediaTime, Math.min(end, blocked.mediaStart));
      return Math.max(0, end - viewerMediaTime);
    }

    hasPendingUpcomingSpeech(viewerMediaTime) {
      return this.lines.some(
        (l) =>
          (l.status === 'pending' || l.status === 'translating') &&
          l.mediaStart <= viewerMediaTime + 1.0 &&
          l.mediaEnd >= viewerMediaTime - 0.25
      );
    }
  }

  globalThis.YTLookaheadQueue = {
    LookaheadQueueEngine,
    VideoCueCache,
    parseYouTubeJson3Captions,
    selectCaptionTrack,
    sharedOverlapLength,
  };
})();
