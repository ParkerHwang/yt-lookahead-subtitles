(() => {
  if (window.__ytLookaheadContentInstalled) return;
  window.__ytLookaheadContentInstalled = true;

  const { LookaheadQueueEngine, VideoCueCache, parseYouTubeJson3Captions, selectCaptionTrack } =
    globalThis.YTLookaheadQueue;

  const { normalizeTargetLanguage, targetLanguageName } = globalThis.YTSubtitleLanguages;
  const DECODER_LOOKAHEAD_SEC = 0.6;
  const MAX_BUFFERING_MS = 25_000;
  const MAX_FAILURES = 3;
  const elementSourceMap = new WeakMap();
  const globalCueCache = new VideoCueCache();
  const knownAudioTracks = new Map();
  const languageTracker = new globalThis.YTLookaheadLanguageTracker.LanguageTracker();
  const queueEngine = new LookaheadQueueEngine({
    cache: globalCueCache,
    minDelaySec: 8.5,
    maxDelaySec: 16.0,
    safetyMarginSec: 2.4,
  });

  const state = {
    active: false,
    starting: false,
    startAttempt: 0,
    videoId: null,
    generationId: 0,
    sourceMode: 'idle', // 'idle' | 'asr-delayed' | 'caption-track' | 'cached'
    phase: 'idle', // 'idle' | 'probing' | 'buffering' | 'seeking' | 'playing' | 'resyncing' | 'paused' | 'error'
    audioMode: 'element', // 'element' | 'tabCapture'
    audioCtx: null,
    workletNode: null,
    canvas: null,
    canvasCtx: null,
    previewFrameDrawn: false,
    encoder: null,
    decoder: null,
    encodedQueue: [],
    decodedFrames: [],
    lastEncoderConfigKey: '',
    lastFedChunkIndex: -1,
    lastKeyframeTime: -1,
    viewerMediaTime: 0,
    captureMediaTime: 0,
    bufferedMediaLead: 0,
    bufferedWallSec: null,
    sourceHold: null,
    resumeSourceAfterSeek: false,
    targetDelaySec: 12.0,
    lookAheadMode: 'balanced',
    targetLanguage: 'ko',
    preloadVideo: null,
    previousPreload: null,
    inputRms: 0,
    asrChunksSent: 0,
    asrInFlight: 0,
    endedWallAt: 0,
    bufferingSince: 0,
    bufferingSuspendedAt: 0,
    asrProcessedThrough: 0,
    asrCompletedIntervals: [],
    asrFailures: 0,
    translationFailures: 0,
    nextTranslationRetryAt: 0,
    rebufferCount: 0,
    inFlightTranslations: 0,
    prevPrompt: '',
    rvfcHandle: null,
    rafHandle: null,
    schedulerTimer: null,
    lastSyncAt: 0,
    startedWallAt: 0,
    playbackStartedAt: 0,
    initialWaitSec: null,
    captionTracks: [],
    sourceLanguage: 'auto',
    languageWarmup: false,
    audioLanguage: null,
    sourceAudioTrackId: null,
    captionTrackId: null,
    captionSourceKind: null,
    sourceCheckAt: 0,
    sourceCheckPending: false,
    captionCues: [],
    captionResumeAfterWait: false,
    captionInternalPause: false,
    preparationResume: false,
    simulatedTranslation: false,
    fallingBehind: false,
    authError: null,
    error: null,
    boundVideo: null,
    recovery: null,
    lastVisibleCueId: null,
    renderedHistory: [],
  };

  let toggleBtn = null;
  let toggleLabel = null;
  let statusPill = null;
  let statusTextEl = null;
  let resyncBtn = null;
  let subtitleLayer = null;
  let subtitleBox = null;
  let telemetryEl = null;
  let metricsCache = null;
  let metricsUpdatedAt = -Infinity;

  function getVideoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
    } catch {}
    return null;
  }

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function getVideo() {
    return document.querySelector('#movie_player video.html5-main-video');
  }

  function isAdShowing() {
    const player = getPlayer();
    return Boolean(player && player.classList.contains('ad-showing'));
  }

  function getCurrentViewerTime() {
    if (state.sourceMode === 'asr-delayed') {
      return state.viewerMediaTime;
    }
    const v = getVideo();
    return v ? v.currentTime : state.viewerMediaTime;
  }

  function bufferedRangeAhead(video, time) {
    if (!video?.buffered || !Number.isFinite(time)) return 0;
    try {
      for (let index = 0; index < video.buffered.length; index++) {
        const start = video.buffered.start(index);
        const end = video.buffered.end(index);
        if (start <= time + 0.05 && end > time) return Math.max(0, end - time);
      }
    } catch {}
    return 0;
  }

  function playbackMetrics(force = false) {
    if (!force && metricsCache && performance.now() - metricsUpdatedAt < 250) return metricsCache;
    const video = getVideo();
    const viewer = getCurrentViewerTime();
    const sourceAhead = bufferedRangeAhead(video, video?.currentTime);
    let nativeAhead = bufferedRangeAhead(video, viewer);
    let videoLead = 0;
    const audioLead = state.sourceMode === 'asr-delayed' ? Math.max(0, state.bufferedMediaLead) : 0;
    if (state.sourceMode === 'asr-delayed') {
      const frames = state.encodedQueue.length ? state.encodedQueue : state.decodedFrames;
      let end = viewer;
      for (const frame of frames) {
        const time = frame.mediaTime;
        if (time > end + 0.2) break;
        if (Number.isFinite(time) && time + 1 / 30 > end) end = time + 1 / 30;
      }
      videoLead = Math.max(0, Math.min(end, state.captureMediaTime) - viewer);
      const retainedLead = Math.min(audioLead, videoLead);
      const captureGap = Math.max(0, (video?.currentTime || 0) - viewer);
      nativeAhead = retainedLead + (retainedLead >= captureGap - 0.2 ? sourceAhead : 0);
    }
    const target = state.active && state.sourceMode === 'asr-delayed'
      ? state.targetDelaySec : queueEngine.getTargetLeadSec(video?.playbackRate || 1);
    metricsUpdatedAt = performance.now();
    metricsCache = {
      active: state.active, videoId: state.videoId, lookAheadMode: state.lookAheadMode,
      targetLanguage: state.targetLanguage, audioTrackId: state.sourceAudioTrackId,
      phase: state.phase, playbackRate: video?.playbackRate || 1,
      nativeBufferedAheadSec: Number(nativeAhead.toFixed(2)),
      sourceBufferedAheadSec: Number(sourceAhead.toFixed(2)),
      localAudioLeadSec: Number(audioLead.toFixed(2)),
      localVideoLeadSec: Number(videoLead.toFixed(2)),
      readyHorizonAhead: Number(queueEngine.getReadyHorizonAhead(viewer).toFixed(2)),
      translatedReadyAheadSec: Number(queueEngine.getReadyHorizonAhead(viewer).toFixed(2)),
      targetLeadSec: target,
      targetLeadWallSec: Number((target / (video?.playbackRate || 1)).toFixed(2)),
      sourceMode: state.sourceMode,
      preloadHintActive: Boolean(state.preloadVideo),
    };
    return metricsCache;
  }

  function restorePreloadHint() {
    if (state.preloadVideo && state.preloadVideo.preload === 'auto') {
      state.preloadVideo.preload = state.previousPreload;
    }
    state.preloadVideo = null;
    state.previousPreload = null;
  }

  function applyPreloadHint() {
    if (!state.active || state.lookAheadMode !== 'extended') {
      restorePreloadHint();
      return;
    }
    const video = getVideo();
    if (!video) return;
    if (state.preloadVideo !== video) {
      restorePreloadHint();
      state.previousPreload = video.preload;
      state.preloadVideo = video;
    }
    video.preload = 'auto';
  }

  function useCreatorCaptionText(viewerTime) {
    queueEngine.applyTranslationResult(state.generationId, {
      translations: queueEngine.lines.map(line => ({ id: line.id, ko: line.text })),
      targetLanguage: state.targetLanguage, simulated: false, model: 'creator-captions', inferenceMs: 0,
    }, viewerTime, queueEngine.translationRevision);
  }

  function subtitleLabel() {
    return targetLanguageName(state.targetLanguage) + ' 자막';
  }

  function setTargetLanguage(value) {
    const language = normalizeTargetLanguage(value);
    if (!language || language === state.targetLanguage) return;
    const video = getVideo();
    const resumeCaption = video && (!video.paused || state.captionResumeAfterWait);
    state.targetLanguage = language;
    queueEngine.setTargetLanguage(language);
    if (state.sourceMode === 'caption-track' && state.captionSourceKind !== 'asr' &&
        normalizeTargetLanguage(state.sourceLanguage) === language) {
      useCreatorCaptionText(video?.currentTime || 0);
    }
    state.inFlightTranslations = 0;
    state.translationFailures = 0;
    state.nextTranslationRetryAt = 0;
    state.authError = null;
    state.lastVisibleCueId = null;
    state.renderedHistory = [];
    subtitleBox?.classList.remove('visible');
    if (toggleLabel) toggleLabel.textContent = subtitleLabel();
    if (toggleBtn) toggleBtn.title = subtitleLabel() + ' (Look-Ahead)';
    metricsCache = null;
    if (state.active && video) {
      if (['caption-track', 'cached'].includes(state.sourceMode)) waitForCaptionTranslation(video, resumeCaption);
      else if (state.sourceMode === 'asr-delayed') triggerResync();
      setStatusPill(subtitleLabel() + ' 준비 중...', { show: true });
      pumpTranslationQueue();
    }
    updateTelemetryNode();
  }

  function setLookAheadMode(mode) {
    const next = mode === 'extended' ? 'extended' : 'balanced';
    if (state.lookAheadMode === next) return;
    metricsCache = null;
    state.lookAheadMode = next;
    queueEngine.setLookAheadMode(next);
    const video = getVideo();
    state.targetDelaySec = queueEngine.getTargetLeadSec(video?.playbackRate || 1);
    applyPreloadHint();
    if (state.active && state.sourceMode === 'asr-delayed' && next === 'extended') {
      const wallLead = state.bufferedWallSec ?? state.bufferedMediaLead / (video?.playbackRate || 1);
      if (wallLead + 0.25 < state.targetDelaySec / (video?.playbackRate || 1)) {
        triggerResync();
        setStatusPill('대화와 영상을 더 준비하는 중 · 잠시 후 이어집니다.', { show: true });
      }
    }
    updateTelemetryNode();
  }

  function updateTelemetryNode() {
    if (!telemetryEl) {
      telemetryEl = document.getElementById('yt-lookahead-telemetry');
      if (!telemetryEl) {
        telemetryEl = document.createElement('div');
        telemetryEl.id = 'yt-lookahead-telemetry';
        telemetryEl.style.display = 'none';
        document.documentElement.appendChild(telemetryEl);
      }
    }
    const v = getVideo();
    const viewerT = getCurrentViewerTime();
    const snapshot = {
      ...playbackMetrics(),
      active: state.active,
      videoId: state.videoId,
      generationId: state.generationId,
      sourceMode: state.sourceMode,
      phase: state.phase,
      audioMode: state.audioMode,
      playbackRate: v ? v.playbackRate : 1.0,
      paused: v ? v.paused : true,
      rawVideoCurrentTime: v ? Number(v.currentTime.toFixed(3)) : null,
      viewerMediaTime: Number(viewerT.toFixed(3)),
      captureMediaTime: Number(state.captureMediaTime.toFixed(3)),
      bufferedMediaLead: Number(state.bufferedMediaLead.toFixed(3)),
      bufferedWallSec: state.bufferedWallSec,
      sourceHeld: Boolean(state.sourceHold),
      targetDelaySec: state.targetDelaySec,
      readyHorizonAhead: Number(queueEngine.getReadyHorizonAhead(viewerT).toFixed(3)),
      fallingBehind: state.fallingBehind,
      inputRms: Number(state.inputRms.toFixed(5)),
      encodedQueueLen: state.encodedQueue.length,
      decodedFramesLen: state.decodedFrames.length,
      asrChunksSent: state.asrChunksSent,
      asrInFlight: state.asrInFlight,
      asrProcessedThrough: state.asrProcessedThrough,
      rebufferCount: state.rebufferCount,
      totalLines: queueEngine.lines.length,
      readyLinesCount: queueEngine.lines.filter((l) => l.status === 'ready').length,
      lines:
        queueEngine.lines.length <= 250
          ? queueEngine.lines
          : queueEngine.lines
              .filter((l) => l.mediaEnd >= viewerT - 30 && l.mediaStart <= viewerT + 60)
              .slice(0, 250),
      renderedHistory: state.renderedHistory.slice(-250),
      sourceLanguage: state.sourceLanguage,
      audioLanguage: state.audioLanguage,
      captionTracksCount: state.captionTracks.length,
      initialWaitSec: state.initialWaitSec,
      visibleSubtitle: subtitleBox?.classList.contains('visible') ? subtitleBox.textContent : '',
      simulatedTranslation: state.simulatedTranslation,
      authError: state.authError,
      error: state.error,
    };
    telemetryEl.textContent = JSON.stringify(snapshot);
  }

  function setStatusPill(text, { show = true, showResync = false, variant = 'normal' } = {}) {
    if (!statusPill || !statusTextEl) return;
    statusTextEl.textContent = text || '';
    statusPill.classList.toggle('visible', Boolean(show && text));
    statusPill.classList.toggle('warning', variant === 'warning');
    statusPill.classList.toggle('error', variant === 'error');
    if (resyncBtn) {
      resyncBtn.textContent = state.recovery ? '이 위치에서 다시 열기' : '다시 동기화';
      resyncBtn.style.display = showResync ? 'inline-block' : 'none';
    }
  }

  function probeCaptionTracks() {
    return new Promise((resolve) => {
      const requestId = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve([]);
      }, 1500);

      function onMsg(ev) {
        if (
          ev.source === window &&
          ev.data?.source === 'yt-lookahead-page-probe' &&
          ev.data.requestId === requestId
        ) {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          const tracks = ev.data.videoId === state.videoId && Array.isArray(ev.data.tracks) ? ev.data.tracks : [];
          tracks.audioLanguage = ev.data.videoId === state.videoId && typeof ev.data.audioLanguage === 'string'
            ? ev.data.audioLanguage : null;
          tracks.audioTrackId = ev.data.videoId === state.videoId && typeof ev.data.audioTrackId === 'string' ? ev.data.audioTrackId : null;
          resolve(tracks);
        }
      }

      window.addEventListener('message', onMsg);
      window.postMessage(
        { source: 'yt-lookahead-content', action: 'probeCaptions', requestId },
        '*'
      );
    });
  }

  async function tryLoadCaptionTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const picked = selectCaptionTrack(tracks);
    if (!picked || !picked.baseUrl) return null;

    // Try pot-signed URL captured passively by background webRequest first
    let candidateUrls = [];
    const checkCachedUrls = async () => {
      const res = await chrome.runtime
        .sendMessage({
          target: 'background',
          action: 'getTimedtextUrls',
          payload: { videoId: state.videoId },
        })
        .catch(() => null);
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      const matching = entries.find(entry => entry.lang === picked.languageCode && entry.kind === picked.kind);
      return matching ? [matching.url] : [];
    };

    candidateUrls = await checkCachedUrls();
    if (candidateUrls.length === 0) {
      // Wait briefly for initial YouTube pot-signed timedtext request, then toggle CC if needed
      for (let i = 0; i < 16; i++) {
        if (i === 5) {
          window.postMessage({ source: 'yt-lookahead-content', action: 'triggerCaptionFetch', videoId: state.videoId, languageCode: picked.languageCode, vssId: picked.vssId, kind: picked.kind }, '*');
        }
        await new Promise((r) => setTimeout(r, 250));
        candidateUrls = await checkCachedUrls();
        if (candidateUrls.length > 0) break;
      }
    }
    candidateUrls.push(picked.baseUrl);

    for (const rawUrl of candidateUrls) {
      try {
        const u = new URL(rawUrl);
        if (u.origin !== 'https://www.youtube.com' || u.pathname !== '/api/timedtext') continue;
        if (u.searchParams.get('v') && u.searchParams.get('v') !== state.videoId) continue;
        if (u.searchParams.has('tlang')) continue;
        u.searchParams.set('fmt', 'json3');
        const resp = await fetch(u.toString(), { credentials: 'include' });
        if (!resp.ok) continue;
        const txt = await resp.text();
        if (!txt) continue;
        const json = JSON.parse(txt);
        const cues = parseYouTubeJson3Captions(json, { sourceLanguage: picked.languageCode, kind: picked.kind });
        if (cues.length > 0) {
          return { track: picked, cues };
        }
      } catch {}
    }
    return null;
  }

  function triggerResync() {
    const video = getVideo();
    if (!state.active || state.sourceMode !== 'asr-delayed' || !video) return;
    if (state.phase === 'buffering' || state.phase === 'resyncing') return;
    state.fallingBehind = true;
    state.phase = 'resyncing';
    state.bufferingSince = performance.now();
    state.bufferingSuspendedAt = 0;
    state.rebufferCount++;
    state.targetDelaySec = queueEngine.getTargetLeadSec(video.playbackRate);
    sendWorkletCmd({ type: 'setMode', mode: 'buffering', viewerPaused: true });
    setStatusPill('다음 대사를 번역하는 중 · 잠시 후 이어집니다.', { show: true });
    updateTelemetryNode();
  }

  function ensurePlayerUi() {
    const player = getPlayer();
    if (!player) return false;

    const rightControls = player.querySelector('.ytp-right-controls');
    if (rightControls && !player.querySelector('.yt-lookahead-btn')) {
      toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'ytp-button yt-lookahead-btn';
      toggleBtn.title = subtitleLabel() + ' (Look-Ahead)';

      const dot = document.createElement('span');
      dot.className = 'yt-lookahead-dot';
      const label = document.createElement('span');
      label.textContent = subtitleLabel();
      toggleLabel = label;
      toggleBtn.appendChild(dot);
      toggleBtn.appendChild(label);

      toggleBtn.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        if (state.active || state.starting) {
          stopPipeline();
        } else {
          startPipeline().catch(handlePipelineError);
        }
      });
      rightControls.prepend(toggleBtn);
    }

    if (!player.querySelector('.yt-lookahead-status-pill')) {
      statusPill = document.createElement('div');
      statusPill.className = 'yt-lookahead-status-pill';
      statusTextEl = document.createElement('span');
      resyncBtn = document.createElement('button');
      resyncBtn.type = 'button';
      resyncBtn.className = 'yt-lookahead-resync-btn';
      resyncBtn.textContent = '다시 동기화';
      resyncBtn.style.display = 'none';
      resyncBtn.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        if (state.recovery && state.recovery.videoId === getVideoIdFromUrl()) {
          const url = new URL(location.href);
          url.searchParams.set('t', Math.floor(state.recovery.time) + 's');
          if (url.href === location.href) location.reload();
          else location.assign(url.href);
          return;
        }
        triggerResync();
      });
      statusPill.appendChild(statusTextEl);
      statusPill.appendChild(resyncBtn);
      player.appendChild(statusPill);
    }

    if (!player.querySelector('.yt-lookahead-subtitle-layer')) {
      subtitleLayer = document.createElement('div');
      subtitleLayer.className = 'yt-lookahead-subtitle-layer';
      subtitleBox = document.createElement('div');
      subtitleBox.className = 'yt-lookahead-subtitle-box';
      subtitleLayer.appendChild(subtitleBox);
      player.appendChild(subtitleLayer);
    }

    const container = player.querySelector('.html5-video-container');
    if (container && !container.querySelector('.yt-lookahead-canvas')) {
      state.canvas = document.createElement('canvas');
      state.canvas.className = 'yt-lookahead-canvas';
      state.canvas.style.display = 'none';
      container.appendChild(state.canvas);
      state.canvasCtx = state.canvas.getContext('2d', { alpha: false });
    }

    return true;
  }

  function syncCanvasLayout(video) {
    if (!state.canvas || !video) return;
    const cs = state.canvas.style;
    if (video.style.width) cs.width = video.style.width;
    if (video.style.height) cs.height = video.style.height;
    if (video.style.left) cs.left = video.style.left;
    if (video.style.top) cs.top = video.style.top;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      if (state.canvas.width !== video.videoWidth || state.canvas.height !== video.videoHeight) {
        state.canvas.width = video.videoWidth;
        state.canvas.height = video.videoHeight;
      }
    }
  }

  function clearDecodedFrames() {
    while (state.decodedFrames.length > 0) {
      const item = state.decodedFrames.shift();
      try {
        item.frame.close();
      } catch {}
    }
  }

  function destroyVideoCodecs() {
    if (state.encoder) {
      try {
        if (state.encoder.state !== 'closed') state.encoder.close();
      } catch {}
      state.encoder = null;
    }
    if (state.decoder) {
      try {
        if (state.decoder.state !== 'closed') state.decoder.close();
      } catch {}
      state.decoder = null;
    }
    state.encodedQueue = [];
    state.previewFrameDrawn = false;
    state.lastFedChunkIndex = -1;
    state.lastEncoderConfigKey = '';
    state.lastKeyframeTime = -1;
    clearDecodedFrames();
  }

  async function pickVideoCodec(width, height) {
    const candidates = [
      { codec: 'vp8', width, height, bitrate: 2_500_000, framerate: 30 },
      { codec: 'avc1.42001E', width, height, bitrate: 2_500_000, framerate: 30, avc: { format: 'annexb' } },
    ];
    for (const cfg of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return cfg;
      } catch {}
    }
    return { codec: 'vp8', width, height, bitrate: 2_000_000, framerate: 30 };
  }

  async function ensureVideoCodecs(width, height) {
    if (width <= 0 || height <= 0) return;
    const key = `${width}x${height}`;
    if (state.lastEncoderConfigKey === key && state.encoder && state.decoder) return;

    const gen = state.generationId;
    destroyVideoCodecs();
    const cfg = await pickVideoCodec(width, height);
    if (!state.active || state.generationId !== gen || state.sourceMode !== 'asr-delayed') return;
    state.lastEncoderConfigKey = key;

    state.decoder = new VideoDecoder({
      output: (frame) => {
        if (!state.active || state.generationId !== gen) {
          frame.close();
          return;
        }
        state.decodedFrames.push({
          mediaTime: frame.timestamp / 1_000_000,
          frame,
        });
        while (state.decodedFrames.length > 45) {
          const dropped = state.decodedFrames.shift();
          try {
            dropped.frame.close();
          } catch {}
        }
      },
      error: (err) => {
        console.warn('[yt-lookahead] VideoDecoder error:', err);
      },
    });
    state.decoder.configure({ codec: cfg.codec, optimizeForLatency: true });

    state.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (!state.active || state.generationId !== gen) return;
        const mediaTime = chunk.timestamp / 1_000_000;
        if (metadata?.decoderConfig && state.decoder?.state === 'configured') {
          try {
            state.decoder.configure(metadata.decoderConfig);
          } catch {}
        }
        state.encodedQueue.push({ chunk, mediaTime });
        while (
          state.encodedQueue.length > 2 &&
          state.encodedQueue[1].mediaTime < state.viewerMediaTime - 2.0
        ) {
          state.encodedQueue.shift();
          state.lastFedChunkIndex = Math.max(-1, state.lastFedChunkIndex - 1);
        }
      },
      error: (err) => {
        console.warn('[yt-lookahead] VideoEncoder error:', err);
      },
    });
    state.encoder.configure(cfg);
  }

  function startVideoCaptureLoop(video) {
    if (state.rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(state.rvfcHandle);
    }

    let encodingBusy = false;

    const onFrame = async (_now, metadata) => {
      if (!state.active) return;
      state.rvfcHandle = video.requestVideoFrameCallback(onFrame);

      if (state.sourceMode !== 'asr-delayed') return;
      if (state.phase === 'seeking' || isAdShowing() || video.paused || video.readyState < 2) return;
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return;

      syncCanvasLayout(video);
      state.captureMediaTime = metadata.mediaTime;

      if (encodingBusy) return;
      encodingBusy = true;
      let vf = null;
      const frameGeneration = state.generationId;
      try {
        await ensureVideoCodecs(video.videoWidth, video.videoHeight);
        if (!state.active || state.generationId !== frameGeneration) return;
        if (!state.encoder || state.encoder.state !== 'configured') return;

        const tsMicros = Math.round(metadata.mediaTime * 1_000_000);
        vf = new VideoFrame(video, { timestamp: tsMicros });

        if (
          (state.phase === 'buffering' || state.phase === 'resyncing') &&
          state.decodedFrames.length === 0 &&
          !state.previewFrameDrawn &&
          state.canvasCtx
        ) {
          state.canvasCtx.drawImage(vf, 0, 0, state.canvas.width, state.canvas.height);
          state.previewFrameDrawn = true;
        }

        const needKey =
          state.lastKeyframeTime < 0 || metadata.mediaTime - state.lastKeyframeTime >= 1.0;
        if (needKey) state.lastKeyframeTime = metadata.mediaTime;

        if (state.encoder.encodeQueueSize < 8) {
          state.encoder.encode(vf, { keyFrame: needKey });
        }
      } catch (err) {
        console.warn('[yt-lookahead] frame capture error:', err.message);
      } finally {
        if (vf) {
          try {
            vf.close();
          } catch {}
        }
        encodingBusy = false;
      }
    };

    state.rvfcHandle = video.requestVideoFrameCallback(onFrame);
  }

  function feedDecoderUpTo(targetMediaTime) {
    if (!state.decoder || state.decoder.state !== 'configured') return;
    while (state.lastFedChunkIndex + 1 < state.encodedQueue.length) {
      const nextIdx = state.lastFedChunkIndex + 1;
      const item = state.encodedQueue[nextIdx];
      if (item.mediaTime > targetMediaTime) break;
      if (state.decoder.decodeQueueSize > 12) break;
      try {
        if (nextIdx === 0 && item.chunk.type !== 'key') {
          state.lastFedChunkIndex = nextIdx;
          continue;
        }
        state.decoder.decode(item.chunk);
        state.lastFedChunkIndex = nextIdx;
      } catch {
        break;
      }
    }
  }

  function renderSubtitleForClock(viewerT) {
    if (!subtitleBox) return;
    const showAllowed =
      state.phase === 'playing' || state.phase === 'paused' || state.phase === 'resyncing';
    const activeCues = showAllowed ? queueEngine.getActiveCuesAt(viewerT) : [];
    if (!activeCues.length) {
      subtitleBox.classList.remove('visible');
      return;
    }
    const visibleId = activeCues.map(cue => cue.id).join('|');
    if (state.lastVisibleCueId !== visibleId) {
      const previousIds = new Set((state.lastVisibleCueId || '').split('|'));
      for (const cue of activeCues) {
        if (previousIds.has(cue.id)) continue;
        state.renderedHistory.push({
          id: cue.id, shownAtViewerTime: Number(viewerT.toFixed(3)),
          dialogueStart: cue.mediaStart, dialogueEnd: cue.mediaEnd,
          timingOffsetSec: Number((viewerT - cue.mediaStart).toFixed(3)),
          readyAtViewerTime: cue.readyAtViewerTime, leadSec: cue.leadSec,
          cacheHit: Boolean(cue.cacheHit), ja: cue.text, ko: cue.ko,
          sourceText: cue.text, sourceLanguage: cue.sourceLanguage, targetLanguage: state.targetLanguage,
        });
      }
      state.lastVisibleCueId = visibleId;
    }
    subtitleBox.textContent = activeCues.map(cue => cue.ko).join('\n');
    subtitleBox.style.whiteSpace = 'pre-line';
    subtitleBox.classList.add('visible');
  }

  function holdSourceAtCapacity(video) {
    const bufferedWall = state.bufferedWallSec ??
      state.bufferedMediaLead / Math.max(0.1, video.playbackRate || 1);
    const limit = state.languageWarmup ? 30 : 28;
    if (state.sourceHold || video.paused || video.ended || bufferedWall < limit) return;
    state.sourceHold = { video, generationId: state.generationId, resumeAllowed: true, pausePending: true };
    sendWorkletCmd({ type: 'sync', capturePaused: true, viewerPaused: true });
    video.pause();
  }

  function releaseSourceHold(video) {
    const hold = state.sourceHold;
    if (!hold) return;
    state.sourceHold = null;
    if (hold.resumeAllowed && hold.video === video && hold.generationId === state.generationId &&
        state.active && !video.error && getVideoIdFromUrl() === state.videoId) {
      video.play().catch(handlePipelineError);
    }
  }

  function checkBufferingReady(video) {
    if (!state.active || state.authError || state.sourceMode !== 'asr-delayed') return;
    if (state.phase !== 'buffering' && state.phase !== 'resyncing') return;
    holdSourceAtCapacity(video);
    const heldByUs = state.sourceHold?.video === video && state.sourceHold.generationId === state.generationId &&
      state.sourceHold.resumeAllowed;
    if ((video.paused && !video.ended && !heldByUs) || isAdShowing()) {
      if (!state.bufferingSuspendedAt) state.bufferingSuspendedAt = performance.now();
      return;
    }
    if (state.bufferingSuspendedAt) {
      state.bufferingSince += performance.now() - state.bufferingSuspendedAt;
      state.bufferingSuspendedAt = 0;
    }
    const warmupLimit = state.languageWarmup ? 32_000 : MAX_BUFFERING_MS;
    if (performance.now() - state.bufferingSince > warmupLimit) {
      handlePipelineError(new Error('자막 준비 시간이 길어 원래 재생으로 돌아왔습니다. 번역 자막을 다시 눌러주세요.'));
      return;
    }

    const viewerT = state.viewerMediaTime;
    const nearLines = queueEngine.lines.filter((line) =>
      line.mediaEnd >= viewerT - 0.25 && line.mediaStart <= viewerT + 2);
    const pendingSpeech = nearLines.some((line) => line.status !== 'ready');
    const endedAndSettled = video.ended && state.endedWallAt > 0 &&
      performance.now() - state.endedWallAt >= 250 && state.asrInFlight === 0;
    const coverageEnd = video.ended && Number.isFinite(video.duration)
      ? Math.min(video.duration, viewerT + 2) : viewerT + 2;
    const sourceCovered = hasAsrCoverage(viewerT, coverageEnd) &&
      (!video.ended || endedAndSettled);
    const nextSpeechReady = !pendingSpeech && (nearLines.some((line) => line.status === 'ready') || sourceCovered);
    const enoughBuffered = state.bufferedMediaLead >= state.targetDelaySec ||
      (video.ended && state.bufferedMediaLead > 0);

    // A translated line can extend beyond recognized audio. Wait for the same
    // one-second coverage that triggered the hold before restarting the viewer.
    const resumeEnd = video.ended && Number.isFinite(video.duration)
      ? Math.min(video.duration, viewerT + 1) : viewerT + 1;
    if (state.phase === 'resyncing' && !hasAsrCoverage(viewerT, resumeEnd)) return;
    if (!enoughBuffered || !nextSpeechReady) return;
    state.phase = 'playing';
    releaseSourceHold(video);
    state.languageWarmup = false;
    state.bufferingSince = 0;
    state.fallingBehind = false;
    if (state.initialWaitSec === null && state.startedWallAt > 0) {
      state.playbackStartedAt = performance.now();
      state.initialWaitSec = Number(((state.playbackStartedAt - state.startedWallAt) / 1000).toFixed(2));
    }
    sendWorkletCmd({
      type: 'setMode', mode: 'playing',
      viewerPaused: Boolean((video.paused && !video.ended) || isAdShowing()),
    });
    setStatusPill('', { show: false });
  }

  function stopOnPlayerError(video) {
    if (!state.active) return false;
    if (!video?.error) {
      if (video && !video.paused && video.readyState > 0) return false;
      const player = getPlayer();
      const overlay = player?.querySelector('.ytp-error');
      const visibleError = overlay?.textContent.trim() && overlay.getBoundingClientRect().height > 0;
      if (!visibleError && !player?.classList.contains('ytp-error')) return false;
    }
    const time = Number.isFinite(state.viewerMediaTime) ? Math.max(0, state.viewerMediaTime) : 0;
    const recovery = { videoId: state.videoId, time };
    stopPipeline({ restorePosition: false }).then(() => {
      if (state.active || state.starting || recovery.videoId !== getVideoIdFromUrl()) return;
      state.recovery = recovery;
      state.error = 'YouTube 재생 오류';
      const timestamp = Math.floor(time / 60) + ':' + String(Math.floor(time % 60)).padStart(2, '0');
      setStatusPill('YouTube 재생 오류 · 마지막 시청 위치 ' + timestamp,
        { show: true, showResync: true, variant: 'error' });
      updateTelemetryNode();
    });
    return true;
  }

  function waitForCaptionTranslation(video, resumeAfterWait) {
    state.phase = 'buffering';
    state.bufferingSince = performance.now();
    state.captionResumeAfterWait = resumeAfterWait;
    if (!video.paused) {
      state.captionInternalPause = true;
      video.pause();
    }
    setStatusPill('다음 대사를 번역하는 중 · 잠시 후 이어집니다.', { show: true });
  }

  function checkCaptionReady(video) {
    if (!state.active || !['caption-track', 'cached'].includes(state.sourceMode) || state.phase !== 'buffering') return;
    if (performance.now() - state.bufferingSince > MAX_BUFFERING_MS) {
      handlePipelineError(new Error('자막 번역을 확인해주세요. 번역 자막을 다시 눌러주세요.'));
      return;
    }
    const next = queueEngine.lines.filter(line => line.mediaEnd > video.currentTime && line.mediaStart <= video.currentTime + 2)
      .slice(0, 2);
    if (next.some(line => line.status !== 'ready')) return;
    const resume = state.captionResumeAfterWait;
    state.captionResumeAfterWait = false;
    state.phase = 'playing';
    if (state.initialWaitSec === null) {
      state.initialWaitSec = Number(((performance.now() - state.startedWallAt) / 1000).toFixed(2));
    }
    setStatusPill('', { show: false });
    if (resume) video.play().catch(handlePipelineError);
  }

  function checkSourceSelection() {
    if (!state.active || state.sourceCheckPending || performance.now() - state.sourceCheckAt < 2000) return;
    state.sourceCheckAt = performance.now();
    state.sourceCheckPending = true;
    const generation = state.generationId;
    probeCaptionTracks().then(tracks => {
      if (!state.active || generation !== state.generationId) return;
      const audioChanged = state.sourceAudioTrackId && tracks.audioTrackId &&
        state.sourceAudioTrackId !== tracks.audioTrackId ||
        state.audioLanguage && tracks.audioLanguage && state.audioLanguage !== tracks.audioLanguage;
      const selected = tracks.find(track => track.isSelected && !track.isTranslated);
      const captionChanged = state.sourceMode === 'caption-track' && selected?.vssId &&
        state.captionTrackId && selected.vssId !== state.captionTrackId;
      if (audioChanged || captionChanged) {
        globalCueCache.videos.delete(state.videoId);
        handlePipelineError(new Error('음성 또는 자막 언어가 바뀌었습니다. 번역 자막을 다시 눌러주세요.'));
      } else if (tracks.audioTrackId) {
        state.sourceAudioTrackId = tracks.audioTrackId;
        if (tracks.audioLanguage) {
          state.audioLanguage = tracks.audioLanguage;
          state.sourceLanguage = tracks.audioLanguage;
        }
      }
    }).catch(() => {}).finally(() => { state.sourceCheckPending = false; });
  }

  function renderFrameAndSubtitleLoop() {
    if (!state.active) return;
    state.rafHandle = requestAnimationFrame(renderFrameAndSubtitleLoop);

    const video = getVideo();
    if (stopOnPlayerError(video) || !video) return;
    checkSourceSelection();

    if (state.sourceMode === 'asr-delayed') {
      checkBufferingReady(video);
      if (!state.active) return;
      const now = performance.now();
      // The source intentionally leads the viewer by up to 24 seconds. A gap
      // measured against the source alone does not mean the viewer has run out.
      // The coverage check below holds the viewer and applies the stall deadline.
      if (now - state.lastSyncAt >= 40) {
        state.lastSyncAt = now;
        const capturePaused = video.paused || video.ended || isAdShowing() || state.phase === 'seeking';
        const viewerPaused =
          (video.paused && !video.ended) || isAdShowing() || state.phase === 'buffering' || state.phase === 'resyncing' || state.phase === 'seeking';
        sendWorkletCmd({
          type: 'sync',
          mediaTime: video.currentTime,
          playbackRate: video.playbackRate,
          capturePaused,
          viewerPaused,
        });
      }

      if (state.phase === 'playing') {
        feedDecoderUpTo(state.viewerMediaTime + DECODER_LOOKAHEAD_SEC);
        let chosenIdx = -1;
        for (let i = 0; i < state.decodedFrames.length; i++) {
          if (state.decodedFrames[i].mediaTime <= state.viewerMediaTime + 0.025) {
            chosenIdx = i;
          } else {
            break;
          }
        }
        if (chosenIdx >= 0 && state.canvasCtx && state.canvas) {
          const chosen = state.decodedFrames[chosenIdx];
          try {
            state.canvasCtx.drawImage(chosen.frame, 0, 0, state.canvas.width, state.canvas.height);
          } catch {}
          for (let i = 0; i < chosenIdx; i++) {
            const old = state.decodedFrames.shift();
            try {
              old.frame.close();
            } catch {}
          }
        }

        // Freeze the viewer clock while the source keeps filling the delay buffer.
        const upcomingEnd = Number.isFinite(video.duration)
          ? Math.min(video.duration, state.viewerMediaTime + 1) : state.viewerMediaTime + 1;
        if (queueEngine.hasPendingUpcomingSpeech(state.viewerMediaTime) ||
            !hasAsrCoverage(state.viewerMediaTime, upcomingEnd)) {
          triggerResync();
        }
      }
    } else if (state.sourceMode === 'cached') {
      checkCaptionReady(video);
      if (state.phase === 'playing' && !video.paused && queueEngine.hasPendingUpcomingSpeech(video.currentTime)) {
        waitForCaptionTranslation(video, true);
      }
      state.viewerMediaTime = video.currentTime;
      state.captureMediaTime = video.currentTime;
      const horizon = globalCueCache.getCoveredHorizonFrom(state.videoId, video.currentTime);
      const hasUpcomingCached = queueEngine.lines.some(
        (l) => l.mediaEnd > video.currentTime
      );
      if (horizon <= 0.25 && !hasUpcomingCached && !video.paused && !isAdShowing()) {
        // Crossed past cached section into unprocessed video: smoothly engage delayed ASR
        engageAsrDelayedFromCurrent(video).catch(handlePipelineError);
      }
    } else if (state.sourceMode === 'caption-track') {
      checkCaptionReady(video);
      if (state.phase === 'playing' && !video.paused && queueEngine.hasPendingUpcomingSpeech(video.currentTime)) {
        waitForCaptionTranslation(video, true);
      }
      state.viewerMediaTime = video.currentTime;
      state.captureMediaTime = video.currentTime + queueEngine.getReadyHorizonAhead(video.currentTime);
    }

    renderSubtitleForClock(getCurrentViewerTime());
    updateTelemetryNode();
  }

  async function pumpTranslationQueue() {
    if (!state.active || stopOnPlayerError(getVideo()) || state.phase === 'seeking' || state.authError ||
        performance.now() < state.nextTranslationRetryAt) return;
    const viewerT = getCurrentViewerTime();
    const pendingCount = queueEngine.lines.filter(
      (l) => l.status === 'pending' && l.mediaEnd >= viewerT - 0.3
    ).length;
    const maxInFlight = pendingCount >= 4 || state.sourceMode === 'caption-track' ? 2 : 1;

    while (state.inFlightTranslations < maxInFlight) {
      const horizon = state.sourceMode === 'caption-track' ? (state.lookAheadMode === 'extended' ? 90 : 45) : 30;
      const batch = queueEngine.pickNextTranslationBatch(viewerT, horizon);
      if (!batch) break;

      const genAtSend = batch.generationId;
      const revisionAtSend = batch.translationRevision;
      state.inFlightTranslations++;

      const headers = {};

      chrome.runtime
        .sendMessage({
          target: 'background',
          action: 'companionFetch',
          payload: {
            path: '/api/translate',
            method: 'POST',
            generationId: genAtSend,
            headers,
            body: {
              videoId: state.videoId,
              generationId: genAtSend,
              lines: batch.lines,
              contextLines: batch.contextLines,
              followingLines: batch.followingLines,
              targetLanguage: batch.targetLanguage,
            },
          },
        })
        .then(async (res) => {
          if (!state.active || genAtSend !== state.generationId || revisionAtSend !== queueEngine.translationRevision) return;
          state.inFlightTranslations = Math.max(0, state.inFlightTranslations - 1);

          if (!res?.ok) {
            if (res?.aborted) return;
            queueEngine.markBatchFailed(
              genAtSend,
              batch.lines.map((l) => l.id),
              res?.data
            );
            const code = res?.data?.error || `http_${res?.status}`;
            if (
              code === 'not_signed_in' ||
              code === 'reauth_required' ||
              code === 'plan_usage_not_enabled' ||
              code === 'subscription_sharing_usage_limit_exceeded' ||
              code === 'subscription_sharing_user_not_eligible' ||
              code === 'chatpass_v2_scope_not_authorized'
            ) {
              state.authError = { code, message: res?.data?.message || code };
              const label =
                code === 'subscription_sharing_usage_limit_exceeded'
                  ? 'ChatGPT 사용량 한도 도달 (팝업에서 사용량 관리 확인)'
                  : code === 'plan_usage_not_enabled'
                    ? 'ChatGPT 플랜 사용 권한 필요 (팝업에서 허용)'
                    : 'ChatGPT 로그인 필요 (확장 팝업에서 Continue with ChatGPT)';
              await handlePipelineError(new Error(label + ' · 이용 가능해지면 번역 자막을 다시 눌러주세요.'));
            } else {
              recordTranslationFailure(res?.data?.message || res?.error || 'Translation error');
            }
            updateTelemetryNode();
            return;
          }

          state.authError = null;
          state.translationFailures = 0;
          state.nextTranslationRetryAt = 0;
          state.error = null;

          const readyViewerT = getCurrentViewerTime();
          queueEngine.recordTranslateTiming(res.data.inferenceMs);
          queueEngine.applyTranslationResult(genAtSend, { ...res.data, targetLanguage: res.data.targetLanguage || batch.targetLanguage }, readyViewerT, revisionAtSend);

          const video = getVideo();
          if (video) {
            const measuredLead = queueEngine.getTargetLeadSec(video.playbackRate);
            state.targetDelaySec = state.phase === 'resyncing'
              ? Math.max(state.targetDelaySec, measuredLead) : measuredLead;
            checkBufferingReady(video);
            checkCaptionReady(video);
          }
          updateTelemetryNode();
          pumpTranslationQueue();
        })
        .catch((err) => {
          if (!state.active || genAtSend !== state.generationId || revisionAtSend !== queueEngine.translationRevision) return;
          state.inFlightTranslations = Math.max(0, state.inFlightTranslations - 1);
          queueEngine.markBatchFailed(
            genAtSend,
            batch.lines.map((l) => l.id),
            { message: err.message }
          );
          recordTranslationFailure(err.message);
        });
    }
  }

  function recordTranslationFailure(message) {
    state.error = message;
    state.translationFailures++;
    if (state.translationFailures >= MAX_FAILURES) {
      handlePipelineError(new Error('번역 연결을 확인해주세요. 번역 자막을 다시 누르면 재시도합니다.'));
      return;
    }
    state.nextTranslationRetryAt = performance.now() + 500 * 2 ** (state.translationFailures - 1);
    setStatusPill('번역 연결 재시도 중...', { show: true, variant: 'warning' });
  }

  function recordAsrFailure(message) {
    state.error = message;
    state.asrFailures++;
    if (state.asrFailures >= MAX_FAILURES) {
      handlePipelineError(new Error('음성 인식 연결을 확인해주세요. 번역 자막을 다시 누르면 재시도합니다.'));
      return;
    }
    setStatusPill('음성 인식 재시도 중...', { show: true, variant: 'warning' });
  }

  function hasAsrCoverage(fromTime, endTime) {
    return state.asrCompletedIntervals.some(([start, end]) => start <= fromTime + 0.1 && end >= endTime);
  }

  function recordAsrCoverage(startTime, endTime) {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return;
    const intervals = [...state.asrCompletedIntervals, [startTime, endTime]].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous && interval[0] <= previous[1] + 0.05) {
        previous[1] = Math.max(previous[1], interval[1]);
      } else {
        merged.push([...interval]);
      }
    }
    state.asrCompletedIntervals = merged;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  async function handleAudioWorkletMessage(msg) {
    if (!state.active || !msg) return;
    if (msg.generationId !== state.generationId) return;
    if (state.sourceMode !== 'asr-delayed') return;

    if (msg.type === 'clock') {
      if (typeof msg.viewerMediaTime === 'number' && Number.isFinite(msg.viewerMediaTime)) {
        state.viewerMediaTime = msg.viewerMediaTime;
      }
      if (typeof msg.captureMediaTime === 'number' && Number.isFinite(msg.captureMediaTime)) {
        state.captureMediaTime = msg.captureMediaTime;
      }
      state.bufferedMediaLead = Number(msg.bufferedMediaLead || 0);
      if (Number.isFinite(msg.bufferedWallSec)) state.bufferedWallSec = msg.bufferedWallSec;
      state.inputRms = Number(msg.inputRms || 0);

      const video = getVideo();
      if (video) checkBufferingReady(video);
      updateTelemetryNode();
      return;
    }

    if (msg.type === 'asrChunk') {
      msg = { ...msg, pcmBase64: msg.pcmBase64 || arrayBufferToBase64(msg.pcmBuffer) };
      if (!msg.fromLanguageTracker) {
        languageTracker.addChunk(msg);
        if (languageTracker.draining && languageTracker.language !== 'auto') return;
      }
      if (!state.audioLanguage && languageTracker.language === 'auto') {
        const probe = languageTracker.getProbeChunk();
        if (!probe) return;
        msg = { ...msg, ...probe, type: 'asrChunk', generationId: state.generationId, languageProbe: true };
        setStatusPill('대화 언어를 확인하는 중 · 잠시 후 자막이 시작됩니다.', { show: true });
      }
      const requestedLanguage = state.audioLanguage || languageTracker.language;
      const genAtSend = msg.generationId;
      state.asrChunksSent++;
      state.asrInFlight++;
      const pcmBase64 = msg.pcmBase64 || arrayBufferToBase64(msg.pcmBuffer);

      try {
        const res = await chrome.runtime.sendMessage({
          target: 'background',
          action: 'companionFetch',
          payload: {
            path: '/api/asr',
            method: 'POST',
            generationId: genAtSend,
            body: {
              videoId: state.videoId,
              generationId: genAtSend,
              chunkId: msg.chunkId,
              chunkStartMediaTime: msg.chunkStartMediaTime,
              chunkEndMediaTime: msg.chunkEndMediaTime,
              playbackRate: msg.playbackRate,
              sampleRate: msg.sampleRate,
              pcmFormat: 'i16',
              pcmBase64,
              prompt: requestedLanguage === 'auto' ? '' : state.prevPrompt,
              language: requestedLanguage,
            },
          },
        });

        if (!state.active || genAtSend !== state.generationId || state.sourceMode !== 'asr-delayed') {
          return;
        }
        if (!res?.ok) {
          if (msg.languageProbe) languageTracker.observe({ probe: true, detectedLanguage: null });
          if (!res?.aborted) {
            recordAsrFailure(res?.data?.message || res?.error || String(res?.status));
          }
          return;
        }

        languageTracker.observe({
          chunkId: msg.chunkId, detectedLanguage: res.data.detectedLanguage,
          detectedLanguageProbability: res.data.detectedLanguageProbability,
          durationAudioSec: res.data.durationAudioSec,
          rawText: res.data.rawText,
          skippedSilence: res.data.skippedSilence, probe: Boolean(msg.languageProbe),
        });
        if (msg.languageProbe && languageTracker.language === 'auto' && !res.data.skippedSilence) return;
        state.asrFailures = 0;
        state.asrProcessedThrough = Math.max(state.asrProcessedThrough, Number(msg.chunkEndMediaTime) || 0);
        recordAsrCoverage(Number(msg.chunkStartMediaTime), Number(msg.chunkEndMediaTime));
        const chunkSpanSec = Number(res.data.durationAudioSec || 3.2) * Number(msg.playbackRate || 1.0);
        if (!res.data.skippedSilence) {
          queueEngine.recordAsrTiming({
            chunkSpanSec,
            asrMs: res.data.inferenceMs,
          });
          const video = getVideo();
          if (video) {
            const measuredLead = queueEngine.getTargetLeadSec(video.playbackRate);
            state.targetDelaySec = state.phase === 'resyncing'
              ? Math.max(state.targetDelaySec, measuredLead) : measuredLead;
          }
        }

        state.sourceLanguage = state.audioLanguage || languageTracker.language;
        const segs = Array.isArray(res.data?.segments) ? res.data.segments : [];
        if (segs.length > 0) {
          const added = queueEngine.addSourceLines(
            segs.map((s) => ({ ...s, sourceLanguage: state.sourceLanguage === 'auto' ? null : state.sourceLanguage, inferenceMs: res.data.inferenceMs })),
            genAtSend,
            getCurrentViewerTime()
          );
          if (added.length > 0) {
            state.prevPrompt = (state.prevPrompt + ' ' + added.map((a) => a.text).join(' '))
              .trim()
              .slice(-100);
            pumpTranslationQueue();
          }
        }

        const video = getVideo();
        if (video) checkBufferingReady(video);
        updateTelemetryNode();
      } catch (err) {
        if (state.active && genAtSend === state.generationId) {
          if (msg.languageProbe) languageTracker.observe({ probe: true, detectedLanguage: null });
          recordAsrFailure(err.message);
        }
      } finally {
        if (state.active && genAtSend === state.generationId) {
          state.asrInFlight = Math.max(0, state.asrInFlight - 1);
          const video = getVideo();
          if (video) checkBufferingReady(video);
          if ((msg.languageProbe || msg.fromLanguageTracker) && languageTracker.language !== 'auto') {
            const pending = languageTracker.takePendingChunk();
            if (pending) handleAudioWorkletMessage({ ...pending, type: 'asrChunk',
              generationId: genAtSend, fromLanguageTracker: true });
          }
        }
      }
    }
  }

  function sendWorkletCmd(payload) {
    if (state.audioMode === 'element') {
      state.workletNode?.port.postMessage(payload);
    } else {
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'offscreenWorkletCmd',
        payload,
      }).catch(() => {});
    }
  }

  async function initElementAudio(video, generationId) {
    if (!state.audioCtx) {
      state.audioCtx = new AudioContext({ latencyHint: 'playback' });
    }
    if (state.audioCtx.state === 'suspended') {
      await state.audioCtx.resume();
    }
    if (!state.workletNode) {
      await state.audioCtx.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
      if (!state.active || state.generationId !== generationId) return false;
      state.workletNode = new AudioWorkletNode(state.audioCtx, 'lookahead-audio-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      state.workletNode.port.onmessage = (ev) => handleAudioWorkletMessage(ev.data);
    }

    if (!state.active || state.generationId !== generationId) return false;
    let sourceNode = elementSourceMap.get(video);
    if (!sourceNode) {
      sourceNode = state.audioCtx.createMediaElementSource(video);
      elementSourceMap.set(video, sourceNode);
    } else {
      try {
        sourceNode.disconnect();
      } catch {}
    }
    sourceNode.connect(state.workletNode);
    state.workletNode.connect(state.audioCtx.destination);
    return true;
  }

  async function engageAsrDelayedFromCurrent(video) {
    state.sourceMode = 'asr-delayed';
    state.phase = 'buffering';
    state.fallingBehind = false;
    state.prevPrompt = '';
    state.asrInFlight = 0;
    state.endedWallAt = 0;
    state.bufferingSince = performance.now();
    state.bufferingSuspendedAt = 0;
    state.asrProcessedThrough = video.currentTime;
    state.asrCompletedIntervals = [];
    state.asrFailures = 0;
    state.viewerMediaTime = video.currentTime;
    state.captureMediaTime = video.currentTime;
    state.targetDelaySec = queueEngine.getTargetLeadSec(video.playbackRate);
    destroyVideoCodecs();

    if (state.audioMode === 'element') {
      if (!(await initElementAudio(video, state.generationId))) return;
      sendWorkletCmd({
        type: 'flush',
        generationId: state.generationId,
        mode: 'buffering',
        mediaTime: video.currentTime,
        playbackRate: video.playbackRate,
        capturePaused: (video.paused && !video.ended) || isAdShowing(),
        viewerPaused: true,
      });
    } else {
      const res = await chrome.runtime.sendMessage({
        target: 'background',
        action: 'startTabCapture',
        payload: {
          generationId: state.generationId,
          mediaTime: video.currentTime,
          playbackRate: video.playbackRate,
        },
      });
      if (!res?.ok) throw new Error(res?.error || 'tabCapture failed');
    }

    if (state.canvas) {
      syncCanvasLayout(video);
      state.canvas.style.display = 'block';
    }
    setStatusPill('번역 자막 준비 중...', { show: true });
    startVideoCaptureLoop(video);
  }

  async function engageCachedFromCurrent(video) {
    state.sourceMode = 'cached';
    state.phase = 'playing';
    state.fallingBehind = false;
    state.viewerMediaTime = video.currentTime;
    state.captureMediaTime = video.currentTime;
    state.bufferedMediaLead = 0;
    if (state.initialWaitSec === null) state.initialWaitSec = 0;
    destroyVideoCodecs();
    if (state.canvas) state.canvas.style.display = 'none';

    if (state.audioCtx && state.workletNode) {
      sendWorkletCmd({
        type: 'flush',
        generationId: state.generationId,
        mode: 'passthrough',
        mediaTime: video.currentTime,
        playbackRate: video.playbackRate,
      });
    }
    queueEngine.loadCachedCues(state.videoId, video.currentTime);
    setStatusPill('캐시된 번역 자막 재생 중', { show: true });
    setTimeout(() => {
      if (state.sourceMode === 'cached' && state.phase === 'playing') {
        setStatusPill('', { show: false });
      }
    }, 1800);
  }

  function bindVideoEvents(video) {
    if (state.boundVideo === video) return;
    if (state.boundVideo) {
      state.boundVideo.removeEventListener('seeking', onVideoSeeking);
      state.boundVideo.removeEventListener('seeked', onVideoSeeked);
      state.boundVideo.removeEventListener('ratechange', onVideoRateChange);
      state.boundVideo.removeEventListener('pause', onVideoPause);
      state.boundVideo.removeEventListener('play', onVideoPlay);
      state.boundVideo.removeEventListener('ended', onVideoEnded);
    }
    state.boundVideo = video;
    video.addEventListener('seeking', onVideoSeeking);
    video.addEventListener('seeked', onVideoSeeked);
    video.addEventListener('ratechange', onVideoRateChange);
    video.addEventListener('pause', onVideoPause);
    video.addEventListener('play', onVideoPlay);
    video.addEventListener('ended', onVideoEnded);
  }

  function onVideoSeeking() {
    if (!state.active) return;
    metricsCache = null;
    state.resumeSourceAfterSeek = Boolean(state.sourceHold?.resumeAllowed);
    state.sourceHold = null;
    state.bufferedWallSec = null;
    if (state.sourceMode === 'caption-track') {
      const resume = !getVideo()?.paused || state.captionResumeAfterWait;
      const newGen = queueEngine.bumpGeneration(state.videoId);
      state.generationId = newGen;
      languageTracker.reset({ videoId: state.videoId, audioId: state.sourceAudioTrackId, generationId: newGen });
      state.inFlightTranslations = 0;
      state.translationFailures = 0;
      state.nextTranslationRetryAt = 0;
      queueEngine.addSourceLines(state.captionCues, newGen, getVideo()?.currentTime || 0);
      chrome.runtime.sendMessage({ target: 'background', action: 'abortGeneration',
        payload: { keepGenerationId: newGen } }).catch(() => {});
      subtitleBox?.classList.remove('visible');
      state.lastVisibleCueId = null;
      waitForCaptionTranslation(getVideo(), resume);
      return;
    }

    state.phase = 'seeking';
    state.fallingBehind = false;
    state.inFlightTranslations = 0;
    state.translationFailures = 0;
    state.nextTranslationRetryAt = 0;
    state.lastVisibleCueId = null;
    subtitleBox?.classList.remove('visible');
    const newGen = queueEngine.bumpGeneration(state.videoId);
    state.generationId = newGen;
    languageTracker.reset({ videoId: state.videoId, audioId: state.sourceAudioTrackId, generationId: newGen });
    chrome.runtime
      .sendMessage({
        target: 'background',
        action: 'abortGeneration',
        payload: { keepGenerationId: newGen },
      })
      .catch(() => {});

    destroyVideoCodecs();
    if (state.workletNode) {
      sendWorkletCmd({
        type: 'flush',
        generationId: newGen,
        mode: 'buffering',
        mediaTime: getVideo()?.currentTime || 0,
        playbackRate: getVideo()?.playbackRate || 1.0,
        capturePaused: true,
        viewerPaused: true,
      });
    }
    setStatusPill('이동한 구간부터 자막 준비 중...', { show: true });
    updateTelemetryNode();
  }

  async function onVideoSeeked() {
    if (!state.active) return;
    const video = getVideo();
    if (!video) return;

    if (state.sourceMode === 'caption-track') {
      pumpTranslationQueue();
      checkCaptionReady(video);
      updateTelemetryNode();
      return;
    }

    const resumeAfterSeek = state.resumeSourceAfterSeek;
    state.resumeSourceAfterSeek = false;
    const seekGeneration = state.generationId;
    state.startedWallAt = performance.now();
    state.initialWaitSec = null;

    const coveredAhead = globalCueCache.getCoveredHorizonFrom(state.videoId, video.currentTime);
    if (coveredAhead >= 5.0) {
      await engageCachedFromCurrent(video);
    } else {
      await engageAsrDelayedFromCurrent(video).catch(handlePipelineError);
    }
    if (resumeAfterSeek && state.active && seekGeneration === state.generationId && !video.error) {
      video.play().catch(handlePipelineError);
    }
    updateTelemetryNode();
  }

  function onVideoRateChange() {
    if (!state.active) return;
    const video = getVideo();
    if (!video) return;
    state.targetDelaySec = queueEngine.getTargetLeadSec(video.playbackRate);
    if (state.sourceMode === 'asr-delayed') {
      sendWorkletCmd({
        type: 'sync',
        mediaTime: video.currentTime,
        playbackRate: video.playbackRate,
      });
    }
  }

  function onVideoPause() {
    if (!state.active) return;
    if (state.sourceHold) {
      if (state.sourceHold.pausePending) state.sourceHold.pausePending = false;
      else state.sourceHold.resumeAllowed = false;
    } else {
      state.resumeSourceAfterSeek = false;
    }
    if (['caption-track', 'cached'].includes(state.sourceMode)) {
      if (state.captionInternalPause) state.captionInternalPause = false;
      else state.captionResumeAfterWait = false;
    }
    if (state.sourceMode === 'asr-delayed') {
      sendWorkletCmd({
        type: 'sync',
        capturePaused: true,
        viewerPaused: !getVideo()?.ended,
      });
    }
  }

  function onVideoPlay() {
    if (!state.active) return;
    const video = getVideo();
    if (!video) return;
    if (state.sourceHold && ['buffering', 'resyncing'].includes(state.phase)) {
      state.sourceHold.resumeAllowed = true;
      state.sourceHold.pausePending = true;
      video.pause();
      sendWorkletCmd({ type: 'sync', capturePaused: true, viewerPaused: true });
      return;
    }
    if (['caption-track', 'cached'].includes(state.sourceMode) && state.phase === 'buffering') {
      waitForCaptionTranslation(video, true);
      return;
    }
    if (state.sourceMode === 'asr-delayed') {
      sendWorkletCmd({
        type: 'sync',
        mediaTime: video.currentTime,
        playbackRate: video.playbackRate,
        capturePaused: isAdShowing(),
        viewerPaused:
          isAdShowing() || state.phase === 'buffering' || state.phase === 'resyncing' || state.phase === 'seeking',
      });
    }
  }

  function onVideoEnded() {
    if (state.active && state.sourceMode === 'asr-delayed') {
      state.endedWallAt = performance.now();
      sendWorkletCmd({ type: 'forceEmitAsr' });
      sendWorkletCmd({ type: 'sync', capturePaused: true, viewerPaused: false });
    }
  }

  async function handlePipelineError(error, options) {
    await stopPipeline(options);
    state.error = error?.message || '자막을 시작할 수 없습니다.';
    setStatusPill(`자막 준비 실패 · ${state.error}`, { show: true, variant: 'error' });
    updateTelemetryNode();
  }

  async function startPipeline() {
    const video = getVideo();
    if (!video) return { ok: false, error: 'no_video_element' };

    if (state.active || state.starting) return { ok: false, error: 'already_starting' };
    ensurePlayerUi();
    state.recovery = null;
    state.starting = true;
    const attempt = ++state.startAttempt;
    setStatusPill('ChatGPT 연결 확인 중...', { show: true });
    let authResponse;
    try {
      authResponse = await chrome.runtime.sendMessage({
        target: 'background',
        action: 'companionFetch',
        payload: { path: '/api/auth/status', method: 'POST', body: {} },
      });
    } catch {}
    if (attempt !== state.startAttempt) return { ok: false, error: 'cancelled' };
    state.starting = false;
    const account = authResponse?.data?.activeAccount;
    if (!authResponse?.ok || !account?.signedIn || !account?.planUsageEnabled) {
      const message = authResponse?.data?.error === 'pairing_required'
        ? '확장 프로그램 아이콘에서 이 컴퓨터를 연결해 주세요.'
        : !authResponse?.ok
        ? '보조 앱 연결 필요 · 보조 앱을 실행한 후 다시 눌러주세요.'
        : !account?.signedIn
          ? 'ChatGPT 로그인 필요 · 확장 아이콘에서 Continue with ChatGPT를 눌러주세요.'
          : 'ChatGPT 구독 사용 허용 필요 · 확장 아이콘에서 권한을 허용해주세요.';
      setStatusPill(message, { show: true, variant: 'error' });
      return { ok: false, error: 'chatgpt_preflight_failed' };
    }
    if (getVideo() !== video || getVideoIdFromUrl() !== state.videoId) {
      setStatusPill('영상이 바뀌었습니다. 번역 자막을 다시 눌러주세요.', { show: true });
      return { ok: false, error: 'video_changed' };
    }
    try {
      const preference = await chrome.runtime.sendMessage({ target: 'background', action: 'getPreferences' });
      if (attempt !== state.startAttempt) return { ok: false, error: 'cancelled' };
      if (['balanced', 'extended'].includes(preference?.preferences?.lookAheadMode)) setLookAheadMode(preference.preferences.lookAheadMode);
      if (preference?.preferences?.targetLanguage) setTargetLanguage(preference.preferences.targetLanguage);
    } catch {}
    bindVideoEvents(video);
    metricsCache = null;
    state.active = true;
    applyPreloadHint();
    state.generationId = queueEngine.bumpGeneration(getVideoIdFromUrl());
    state.videoId = getVideoIdFromUrl();
    state.phase = 'probing';
    state.sourceLanguage = 'auto';
    state.audioLanguage = null;
    state.sourceAudioTrackId = null;
    state.captionTrackId = null;
    state.sourceCheckAt = performance.now();
    state.captionCues = [];
    state.captionResumeAfterWait = false;
    state.audioMode = 'element';
    state.simulatedTranslation = false;
    state.asrChunksSent = 0;
    state.translationFailures = 0;
    state.nextTranslationRetryAt = 0;
    state.rebufferCount = 0;
    state.inFlightTranslations = 0;
    state.prevPrompt = '';
    state.fallingBehind = false;
    state.authError = null;
    state.error = null;
    state.lastVisibleCueId = null;
    state.renderedHistory = [];
    state.startedWallAt = performance.now();
    state.initialWaitSec = null;
    state.viewerMediaTime = video.currentTime;
    state.captureMediaTime = video.currentTime;

    toggleBtn?.classList.add('active');
    setStatusPill('자막 트랙 확인 중...', { show: true });

    const sessionGeneration = state.generationId;
    state.preparationResume = !video.paused;
    if (!video.paused) video.pause();
    const captionTracks = await probeCaptionTracks();
    if (!state.active || state.generationId !== sessionGeneration) return { ok: false, error: 'cancelled' };
    state.captionTracks = captionTracks;
    state.sourceAudioTrackId = state.captionTracks.audioTrackId || null;
    state.audioLanguage = state.captionTracks.audioLanguage || null;
    languageTracker.reset({ videoId: state.videoId, audioId: state.sourceAudioTrackId, generationId: sessionGeneration });
    state.sourceLanguage = state.audioLanguage || languageTracker.language;
    state.languageWarmup = state.sourceLanguage === 'auto';
    const previousAudio = knownAudioTracks.get(state.videoId);
    if (previousAudio && state.sourceAudioTrackId && previousAudio !== state.sourceAudioTrackId) {
      globalCueCache.videos.delete(state.videoId);
    }
    if (state.sourceAudioTrackId) knownAudioTracks.set(state.videoId, state.sourceAudioTrackId);
    if (!state.active || state.generationId !== sessionGeneration) return { ok: false, error: 'cancelled' };

    // 1. Check for existing timestamped YouTube caption track first
    if (state.captionTracks.length > 0) {
      try {
        const loaded = await tryLoadCaptionTrack(state.captionTracks);
        if (!state.active || state.generationId !== sessionGeneration) return { ok: false, error: 'cancelled' };
        if (loaded && loaded.cues.length > 0) {
          state.sourceMode = 'caption-track';
          state.sourceLanguage = loaded.track.languageCode || 'auto';
          state.captionTrackId = loaded.track.vssId || null;
          state.captionSourceKind = loaded.track.kind || 'authored';
          state.captionCues = loaded.cues;
          state.preparationResume = false;
          waitForCaptionTranslation(video, true);
          if (state.canvas) state.canvas.style.display = 'none';
          if (state.workletNode) {
            sendWorkletCmd({
              type: 'flush',
              generationId: state.generationId,
              mode: 'passthrough',
              mediaTime: video.currentTime,
              playbackRate: video.playbackRate,
            });
          }
          queueEngine.addSourceLines(loaded.cues, state.generationId, video.currentTime);
          if (loaded.track.kind !== 'asr' && normalizeTargetLanguage(loaded.track.languageCode) === state.targetLanguage) {
            useCreatorCaptionText(video.currentTime);
          }
          pumpTranslationQueue();
          state.schedulerTimer = setInterval(() => pumpTranslationQueue(), 300);
          state.rafHandle = requestAnimationFrame(renderFrameAndSubtitleLoop);
          updateTelemetryNode();
          return {
            ok: true,
            sourceMode: 'caption-track',
            sourceLanguage: state.sourceLanguage,
      audioLanguage: state.audioLanguage,
      captionTracksCount: state.captionTracks.length,
            cuesLoaded: loaded.cues.length,
          };
        }
      } catch (err) {
        console.warn('[yt-lookahead] caption track load failed, falling back to ASR:', err);
      }
    }

    // ASR needs the source running. Captions stay paused until their translation is ready.
    if (video.paused) await video.play().catch(handlePipelineError);
    state.preparationResume = false;
    if (!state.active || state.generationId !== sessionGeneration) return { ok: false, error: 'cancelled' };
    // 2. Check rewind cache before buffering
    const coveredAhead = globalCueCache.getCoveredHorizonFrom(state.videoId, video.currentTime);
    if (coveredAhead >= 5.0) {
      await engageCachedFromCurrent(video);
    } else {
      await engageAsrDelayedFromCurrent(video);
    }

    if (!state.active || state.generationId !== sessionGeneration) return { ok: false, error: 'cancelled' };
    state.schedulerTimer = setInterval(() => pumpTranslationQueue(), 300);
    state.rafHandle = requestAnimationFrame(renderFrameAndSubtitleLoop);
    updateTelemetryNode();

    return {
      ok: true,
      sourceMode: state.sourceMode,
      audioMode: state.audioMode,
      sourceLanguage: state.sourceLanguage,
      audioLanguage: state.audioLanguage,
      captionTracksCount: state.captionTracks.length,
    };
  }

  async function stopPipeline({ restorePosition = true } = {}) {
    const restoringVideo = getVideo();
    const restoreAt = restorePosition && state.active && state.sourceMode === 'asr-delayed' &&
      restoringVideo === state.boundVideo && getVideoIdFromUrl() === state.videoId
        ? state.viewerMediaTime : null;
    const resumeAfterRestore = restoringVideo && (!restoringVideo.paused || restoringVideo.ended ||
      state.sourceHold?.video === restoringVideo && state.sourceHold.resumeAllowed);
    state.sourceHold = null;
    state.resumeSourceAfterSeek = false;
    state.startAttempt++;
    state.starting = false;
    state.active = false;
    metricsCache = null;
    restorePreloadHint();
    const resumeCaption = state.preparationResume || ['caption-track', 'cached'].includes(state.sourceMode) && state.captionResumeAfterWait;
    state.preparationResume = false;
    state.captionResumeAfterWait = false;
    state.captionInternalPause = false;
    state.sourceMode = 'idle';
    if (resumeCaption && restorePosition && restoringVideo?.paused && !restoringVideo.error) restoringVideo.play().catch(() => {});
    state.phase = 'idle';
    state.fallingBehind = false;
    state.generationId++;
    queueEngine.bumpGeneration(state.videoId);
    chrome.runtime
      .sendMessage({
        target: 'background',
        action: 'abortGeneration',
        payload: { keepGenerationId: null },
      })
      .catch(() => {});

    if (restoreAt !== null && Number.isFinite(restoreAt)) {
      try {
        restoringVideo.currentTime = Math.max(0, restoreAt);
        if (resumeAfterRestore) restoringVideo.play().catch(() => {});
      } catch {}
    }

    toggleBtn?.classList.remove('active');
    setStatusPill('', { show: false });
    subtitleBox?.classList.remove('visible');

    if (state.schedulerTimer) {
      clearInterval(state.schedulerTimer);
      state.schedulerTimer = null;
    }

    const video = getVideo();
    if (video && state.rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(state.rvfcHandle);
    }
    state.rvfcHandle = null;
    if (state.rafHandle !== null) {
      cancelAnimationFrame(state.rafHandle);
      state.rafHandle = null;
    }

    if (state.canvas) {
      state.canvas.style.display = 'none';
    }
    destroyVideoCodecs();

    if (state.audioMode === 'element') {
      if (state.workletNode) {
        sendWorkletCmd({
          type: 'flush',
          generationId: state.generationId,
          mode: 'passthrough',
        });
      }
    } else {
      await chrome.runtime
        .sendMessage({ target: 'background', action: 'stopTabCapture' })
        .catch(() => {});
    }

    updateTelemetryNode();
    return { ok: true };
  }

  function checkVideoChanged() {
    const curId = getVideoIdFromUrl();
    if ((state.active || state.starting) && curId !== state.videoId) {
      stopPipeline();
    }
    if (state.recovery && state.recovery.videoId !== curId) {
      state.recovery = null;
      setStatusPill('', { show: false });
    }
    state.videoId = curId;
    ensurePlayerUi();
    updateTelemetryNode();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === 'player') {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
      if (message.action === 'preferencesChanged') {
        if (['balanced', 'extended'].includes(message.payload?.lookAheadMode)) setLookAheadMode(message.payload.lookAheadMode);
        if (normalizeTargetLanguage(message.payload?.targetLanguage)) setTargetLanguage(message.payload.targetLanguage);
        sendResponse({ ok: true, ...playbackMetrics(true) });
      } else if (message.action === 'getPlaybackStatus') {
        sendResponse({ ok: true, ...playbackMetrics(true) });
      }
      return false;
    }
    if (message?.from === 'offscreen-audio' && message.payload) {
      handleAudioWorkletMessage(message.payload);
      return false;
    }
    return false;
  });

  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || !state.active || state.sourceMode !== 'asr-delayed') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
    const video = getVideo();
    if (!video) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const offset = event.key === 'ArrowLeft' ? -5 : 5;
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.max(0, Math.min(end, state.viewerMediaTime + offset));
  }, true);

  const observer = new MutationObserver(() => {
    ensurePlayerUi();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', checkVideoChanged);
  window.addEventListener('popstate', checkVideoChanged);

  state.videoId = getVideoIdFromUrl();
  ensurePlayerUi();
  updateTelemetryNode();
})();
