// MAIN world reads public player metadata. Caption/audio hints never grant permissions.
(() => {
  if (window.__ytLookaheadPageProbeInstalled) return;
  window.__ytLookaheadPageProbeInstalled = true;

  function audioLanguage(value) {
    if (typeof value !== 'string') return null;
    const code = value.toLowerCase().split('-')[0];
    return /^[a-z]{2,3}$/.test(code) && !['und', 'zxx', 'mul'].includes(code) ? code : null;
  }

  function inspectCaptions() {
    const videoId = new URL(location.href).searchParams.get('v');
    const player = document.getElementById('movie_player');
    let response;
    let selected;
    let selectedAudio;
    try { response = player?.getPlayerResponse?.(); } catch {}
    if (response?.videoDetails?.videoId !== videoId) {
      const initial = window.ytInitialPlayerResponse;
      response = initial?.videoDetails?.videoId === videoId ? initial : null;
    }
    try { selected = player?.getOption?.('captions', 'track'); } catch {}
    try { selectedAudio = player?.getAudioTrack?.(); } catch {}
    // A prior SPA response must not supply caption URLs for the new video.
    if (!response) return { videoId, tracks: [], audioTrackId: null };
    const renderer = response.captions?.playerCaptionsTracklistRenderer;
    const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];
    const audioTracks = Array.isArray(renderer?.audioTracks) ? renderer.audioTracks : [];
    const defaultAudio = audioTracks[renderer?.defaultAudioTrackIndex || 0];
    const selectedId = typeof selectedAudio?.id === 'string' ? selectedAudio.id : null;
    const mappedAudio = selectedId && audioTracks.find(track =>
      track.audioTrackId === selectedId || track.id === selectedId);
    const adaptiveFormats = response.streamingData?.adaptiveFormats;
    const taggedAudio = Array.isArray(adaptiveFormats) ? adaptiveFormats
      .filter(format => format.mimeType?.startsWith('audio/')).map(format => format.audioTrack).filter(Boolean) : [];
    const selectedFormat = selectedId && taggedAudio.find(track => track.id === selectedId);
    const defaultFormat = taggedAudio.find(track => track.audioIsDefault === true);
    const selectedIdLanguage = /^([a-z]{2,3}(?:-[a-zA-Z]{2,4})?)[.]\d+$/.exec(selectedId || '')?.[1];
    const selectedLanguage = audioLanguage(selectedAudio?.languageCode) || audioLanguage(mappedAudio?.languageCode) ||
      audioLanguage(selectedFormat?.languageCode) || audioLanguage(selectedIdLanguage);
    // Only explicit audio properties qualify. UI language, title and display names do not.
    const defaultLanguage = audioLanguage(defaultFormat?.languageCode) ||
      audioLanguage(/^([a-z]{2,3}(?:-[a-zA-Z]{2,4})?)[.]\d+$/.exec(defaultFormat?.id || '')?.[1]) ||
      audioLanguage(response.videoDetails?.defaultAudioLanguage) ||
      audioLanguage(response.microformat?.playerMicroformatRenderer?.defaultAudioLanguage);
    const unambiguousDefault = !selectedId || selectedId === 'und' && audioTracks.length <= 1 &&
      new Set(taggedAudio.map(track => track.id).filter(Boolean)).size <= 1;
    const confirmedAudioLanguage = selectedLanguage || (unambiguousDefault ? defaultLanguage : null);
    const sourceAudio = mappedAudio ||
      (!selectedId || audioTracks.length <= 1 && selectedAudio?.isDefault !== false ? defaultAudio : null);
    const singleOriginalAudio = audioTracks.length <= 1 &&
      new Set(taggedAudio.map(track => track.id).filter(Boolean)).size <= 1 &&
      selectedAudio?.isDefault !== false;
    const originalIndex = sourceAudio?.defaultCaptionTrackIndex;
    const compatibleIndices = Array.isArray(sourceAudio?.captionTrackIndices)
      ? sourceAudio.captionTrackIndices : Number.isInteger(originalIndex) ? [originalIndex] : null;
    const sameLanguage = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase().split('-')[0] === b.toLowerCase().split('-')[0];
    const isExplicitSelected = track => Boolean(selected && (
      selected.vssId && selected.vssId === track.vssId ||
      selected.languageCode === track.languageCode && selected.kind === track.kind));
    const mappingUnknown = Boolean(selectedId && !sourceAudio &&
      (audioTracks.length > 1 || selectedAudio?.isDefault === false));
    return {
      videoId,
      audioTrackId: selectedId,
      audioLanguage: confirmedAudioLanguage,
      tracks: tracks.map((track, index) => ({
        languageCode: track.languageCode || '',
        vssId: track.vssId || '', kind: track.kind || '',
        name: typeof track.name === 'string' ? track.name :
          track.name?.simpleText || track.name?.runs?.map(run => run.text).join('') || '',
        baseUrl: track.baseUrl || '',
        isSelected: isExplicitSelected(track),
        isOriginal: index === originalIndex,
        isTranslated: Boolean(track.translationLanguage || track.isTranslated),
        audioCompatible: mappingUnknown
          ? Boolean(isExplicitSelected(track) && sameLanguage(track.languageCode, selectedLanguage))
          : compatibleIndices ? compatibleIndices.includes(index)
            : singleOriginalAudio && track.kind !== 'asr' ? true
            : selectedLanguage ? Boolean(sameLanguage(track.languageCode, selectedLanguage)) : true,
      })).filter(track => track.audioCompatible),
    };
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'yt-lookahead-content') return;
    if (event.data.action === 'probeCaptions') {
      window.postMessage({ source: 'yt-lookahead-page-probe', requestId: event.data.requestId,
        ...inspectCaptions() }, '*');
    } else if (event.data.action === 'triggerCaptionFetch') {
      const requestedVideoId = event.data.videoId;
      if (requestedVideoId !== new URL(location.href).searchParams.get('v')) return;
      const requestedTrack = inspectCaptions().tracks.find(track =>
        track.languageCode === event.data.languageCode &&
        track.vssId === event.data.vssId && track.kind === (event.data.kind || ''));
      if (!requestedTrack) return;
      const player = document.getElementById('movie_player');
      const button = document.querySelector('.ytp-subtitles-button');
      const wasPressed = button?.getAttribute('aria-pressed') === 'true';
      try {
        player?.loadModule?.('captions');
        player?.setOption?.('captions', 'track', { languageCode: requestedTrack.languageCode,
          ...(requestedTrack.kind ? { kind: requestedTrack.kind } : {}) });
      } catch {}
      setTimeout(() => {
        if (requestedVideoId !== new URL(location.href).searchParams.get('v')) return;
        if (!wasPressed && button?.getAttribute('aria-pressed') === 'true') button.click();
      }, 2000);
    }
  });
})();
