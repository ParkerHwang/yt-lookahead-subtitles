// Offscreen document fallback/host for chrome.tabCapture audio stream capture & delay
let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let activeTabId = null;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function stopCapture() {
  try {
    workletNode?.disconnect();
  } catch {}
  try {
    sourceNode?.disconnect();
  } catch {}
  try {
    mediaStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  if (audioCtx) {
    try {
      await audioCtx.close();
    } catch {}
  }
  audioCtx = null;
  mediaStream = null;
  sourceNode = null;
  workletNode = null;
  activeTabId = null;
}

async function startCapture({ streamId, tabId, generationId, mediaTime, playbackRate }) {
  await stopCapture();
  activeTabId = tabId;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  audioCtx = new AudioContext({ latencyHint: 'playback' });
  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'lookahead-audio-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  workletNode.port.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'asrChunk') {
      chrome.runtime.sendMessage({
        target: 'content-relay',
        tabId: activeTabId,
        payload: {
          type: 'asrChunk',
          generationId: msg.generationId,
          chunkId: msg.chunkId,
          chunkStartMediaTime: msg.chunkStartMediaTime,
          chunkEndMediaTime: msg.chunkEndMediaTime,
          playbackRate: msg.playbackRate,
          sampleRate: msg.sampleRate,
          pcmBase64: arrayBufferToBase64(msg.pcmBuffer),
        },
      });
    } else if (msg.type === 'clock') {
      chrome.runtime.sendMessage({
        target: 'content-relay',
        tabId: activeTabId,
        payload: msg,
      });
    }
  };

  sourceNode.connect(workletNode);
  workletNode.connect(audioCtx.destination);
  workletNode.port.postMessage({
    type: 'configure',
    generationId,
    mode: 'buffering',
    mediaTime,
    playbackRate,
    capturePaused: false,
    viewerPaused: false,
  });

  return { ok: true, sampleRate: audioCtx.sampleRate };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  (async () => {
    switch (message.action) {
      case 'startCapture': {
        const res = await startCapture(message.payload);
        sendResponse(res);
        break;
      }
      case 'workletCmd': {
        if (workletNode) {
          workletNode.port.postMessage(message.payload);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'stopCapture': {
        await stopCapture();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown_action' });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err.message });
  });

  return true;
});
