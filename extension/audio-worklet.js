/**
 * AudioWorkletProcessor that:
 * 1. Captures incoming audio frames from either createMediaElementSource or tabCapture.
 * 2. Buffers stereo audio into a sample-accurate delay ring buffer (suppressing live output
 *    until `playing` mode begins, and tracking exact `mediaTime` per 128-frame quantum).
 * 3. Resamples mono audio down to 16kHz Int16 PCM and emits VAD-aware ASR chunks (3.0s-4.5s)
 *    with exact [chunkStartMediaTime, chunkEndMediaTime] tags ahead of viewer playback.
 */
class LookaheadAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.srcSampleRate = sampleRate; // Global in AudioWorkletGlobalScope
    this.maxBlocks = Math.ceil((35 * this.srcSampleRate) / 128);
    this.ringLeft = new Float32Array(this.maxBlocks * 128);
    this.ringRight = new Float32Array(this.maxBlocks * 128);
    this.ringMediaTime = new Float64Array(this.maxBlocks);
    this.ringRate = new Float32Array(this.maxBlocks);

    this.writeBlock = 0;
    this.readBlock = 0;
    this.bufferedBlocks = 0;

    this.mode = 'idle'; // 'idle' | 'buffering' | 'playing'
    this.viewerPaused = false;
    this.capturePaused = false;
    this.captureMediaTime = 0;
    this.playbackRate = 1.0;
    this.generationId = 0;
    this.hasSyncedMediaTime = false;
    this.lastBlockMediaTime = 0;

    // 16kHz downsampler & ASR chunk accumulator
    this.targetSampleRate = 16000;
    this.resampleRatio = this.srcSampleRate / this.targetSampleRate;
    this.resamplePhase = 0;
    this.asrBuffer = new Int16Array(this.targetSampleRate * 6);
    this.asrLen = 0;
    this.asrChunkStartMediaTime = null;
    this.asrChunkEndMediaTime = 0;
    this.asrOverlapSamples = Math.round(this.targetSampleRate * 0.35);
    this.minChunkSamples = Math.round(this.targetSampleRate * 2.4);
    this.maxChunkSamples = Math.round(this.targetSampleRate * 3.6);
    this.silenceWindowSamples = 0;
    this.silenceCutSamples = Math.round(this.targetSampleRate * 0.14);
    this.chunkSeq = 0;

    this.inputRmsAcc = 0;
    this.inputRmsCount = 0;
    this.telemetryCounter = 0;

    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'configure': {
        this.generationId = msg.generationId ?? this.generationId;
        this.mode = msg.mode || 'buffering';
        this.viewerPaused = Boolean(msg.viewerPaused);
        this.capturePaused = Boolean(msg.capturePaused);
        this.playbackRate = Number(msg.playbackRate || 1.0);
        if (typeof msg.mediaTime === 'number' && Number.isFinite(msg.mediaTime)) {
          this.captureMediaTime = msg.mediaTime;
          this.hasSyncedMediaTime = true;
        }
        break;
      }
      case 'sync': {
        if (typeof msg.mediaTime === 'number' && Number.isFinite(msg.mediaTime)) {
          const diff = msg.mediaTime - this.captureMediaTime;
          if (!this.hasSyncedMediaTime || Math.abs(diff) > 0.4) {
            this.captureMediaTime = msg.mediaTime;
            this.hasSyncedMediaTime = true;
          } else if (Math.abs(diff) > 0.04) {
            this.captureMediaTime += diff * 0.2;
          }
        }
        if (typeof msg.playbackRate === 'number' && msg.playbackRate > 0) {
          this.playbackRate = msg.playbackRate;
        }
        if (typeof msg.capturePaused === 'boolean') {
          this.capturePaused = msg.capturePaused;
        }
        if (typeof msg.viewerPaused === 'boolean') {
          this.viewerPaused = msg.viewerPaused;
        }
        break;
      }
      case 'setMode': {
        this.mode = msg.mode;
        if (typeof msg.viewerPaused === 'boolean') {
          this.viewerPaused = msg.viewerPaused;
        }
        break;
      }
      case 'flush': {
        this.generationId = msg.generationId ?? this.generationId + 1;
        this.writeBlock = 0;
        this.readBlock = 0;
        this.bufferedBlocks = 0;
        this.mode = msg.mode || 'buffering';
        this.viewerPaused = Boolean(msg.viewerPaused);
        this.capturePaused = Boolean(msg.capturePaused);
        this.playbackRate = Number(msg.playbackRate || 1.0);
        this.captureMediaTime = Number(msg.mediaTime || 0);
        this.hasSyncedMediaTime = typeof msg.mediaTime === 'number';
        this.asrLen = 0;
        this.asrChunkStartMediaTime = null;
        this.asrChunkEndMediaTime = 0;
        this.silenceWindowSamples = 0;
        this.resamplePhase = 0;
        break;
      }
      case 'forceEmitAsr': {
        if (this.asrLen >= Math.round(this.targetSampleRate * 0.12)) {
          this.emitAsrChunk(false);
        }
        break;
      }
    }
  }

  emitAsrChunk(keepOverlap = true) {
    if (this.asrLen <= 0 || this.asrChunkStartMediaTime === null) return;
    const emittedSamples = this.asrLen;
    const pcmCopy = new Int16Array(this.asrBuffer.subarray(0, emittedSamples));
    const startT = this.asrChunkStartMediaTime;
    const endT = this.asrChunkEndMediaTime;
    const chunkId = ++this.chunkSeq;

    this.port.postMessage(
      {
        type: 'asrChunk',
        generationId: this.generationId,
        chunkId,
        chunkStartMediaTime: startT,
        chunkEndMediaTime: endT,
        playbackRate: this.playbackRate,
        sampleRate: this.targetSampleRate,
        pcmBuffer: pcmCopy.buffer,
      },
      [pcmCopy.buffer]
    );

    if (keepOverlap && emittedSamples > this.asrOverlapSamples) {
      const keepStart = emittedSamples - this.asrOverlapSamples;
      this.asrBuffer.copyWithin(0, keepStart, emittedSamples);
      this.asrLen = this.asrOverlapSamples;
      const totalSpan = Math.max(0, endT - startT);
      const overlapFrac = this.asrOverlapSamples / emittedSamples;
      this.asrChunkStartMediaTime = endT - totalSpan * overlapFrac;
      this.silenceWindowSamples = 0;
    } else {
      this.asrLen = 0;
      this.asrChunkStartMediaTime = null;
      this.asrChunkEndMediaTime = 0;
      this.silenceWindowSamples = 0;
    }
  }

  pushAsrFrames(monoBlock, blockStartMediaTime, blockEndMediaTime) {
    const n = monoBlock.length;
    while (this.resamplePhase < n) {
      const idx0 = Math.floor(this.resamplePhase);
      const idx1 = Math.min(n - 1, idx0 + 1);
      const frac = this.resamplePhase - idx0;
      const sample = monoBlock[idx0] * (1 - frac) + monoBlock[idx1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      const i16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

      if (this.asrChunkStartMediaTime === null) {
        const progress = idx0 / n;
        this.asrChunkStartMediaTime =
          blockStartMediaTime + (blockEndMediaTime - blockStartMediaTime) * progress;
      }

      if (this.asrLen < this.asrBuffer.length) {
        this.asrBuffer[this.asrLen++] = i16;
      }

      const progressEnd = Math.min(1, (idx0 + 1) / n);
      this.asrChunkEndMediaTime =
        blockStartMediaTime + (blockEndMediaTime - blockStartMediaTime) * progressEnd;

      if (Math.abs(clamped) < 0.012) {
        this.silenceWindowSamples++;
      } else {
        this.silenceWindowSamples = 0;
      }

      if (
        this.asrLen >= this.maxChunkSamples ||
        (this.asrLen >= this.minChunkSamples && this.silenceWindowSamples >= this.silenceCutSamples)
      ) {
        this.emitAsrChunk(true);
      }

      this.resamplePhase += this.resampleRatio;
    }
    this.resamplePhase -= n;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const outLeft = output && output[0];
    const outRight = output && output[1];
    const frames = outLeft ? outLeft.length : 128;

    const inLeft = input && input[0];
    const inRight = input && input[1] ? input[1] : inLeft;

    let blockMaxAbs = 0;
    let blockSumSq = 0;

    if (inLeft && inLeft.length === frames && !this.capturePaused && this.mode !== 'idle' && this.mode !== 'passthrough') {
      const blockStartMedia = this.captureMediaTime;
      const mediaDelta = (frames / this.srcSampleRate) * this.playbackRate;
      const blockEndMedia = blockStartMedia + mediaDelta;

      // Measure input energy
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const l = inLeft[i];
        const r = inRight ? inRight[i] : l;
        const m = (l + r) * 0.5;
        mono[i] = m;
        const abs = Math.abs(m);
        if (abs > blockMaxAbs) blockMaxAbs = abs;
        blockSumSq += m * m;
      }
      this.inputRmsAcc += blockSumSq;
      this.inputRmsCount += frames;

      // Push into delay ring buffer
      if (this.bufferedBlocks >= this.maxBlocks) {
        // Drop oldest block if ring overflows
        this.readBlock = (this.readBlock + 1) % this.maxBlocks;
        this.bufferedBlocks--;
      }
      const wOffset = this.writeBlock * 128;
      this.ringLeft.set(inLeft, wOffset);
      if (inRight) {
        this.ringRight.set(inRight, wOffset);
      } else {
        this.ringRight.set(inLeft, wOffset);
      }
      this.ringMediaTime[this.writeBlock] = blockStartMedia;
      this.ringRate[this.writeBlock] = this.playbackRate;
      this.writeBlock = (this.writeBlock + 1) % this.maxBlocks;
      this.bufferedBlocks++;

      this.captureMediaTime = blockEndMedia;
      this.pushAsrFrames(mono, blockStartMedia, blockEndMedia);
    }

    // Pop delayed audio for viewer output ONLY in playing mode and when not paused
    let viewerMediaTime = null;
    if (this.mode === 'passthrough') {
      if (inLeft && outLeft) outLeft.set(inLeft);
      else if (outLeft) outLeft.fill(0);
      if (inRight && outRight) outRight.set(inRight);
      else if (inLeft && outRight) outRight.set(inLeft);
      else if (outRight) outRight.fill(0);
      viewerMediaTime = this.captureMediaTime;
      this.lastBlockMediaTime = viewerMediaTime;
    } else if (this.mode === 'playing' && !this.viewerPaused && this.bufferedBlocks > 0) {
      const rOffset = this.readBlock * 128;
      viewerMediaTime = this.ringMediaTime[this.readBlock];
      this.lastBlockMediaTime = viewerMediaTime;
      if (outLeft) {
        outLeft.set(this.ringLeft.subarray(rOffset, rOffset + frames));
      }
      if (outRight) {
        outRight.set(this.ringRight.subarray(rOffset, rOffset + frames));
      }
      this.readBlock = (this.readBlock + 1) % this.maxBlocks;
      this.bufferedBlocks--;
    } else {
      if (outLeft) outLeft.fill(0);
      if (outRight) outRight.fill(0);
      if (this.bufferedBlocks > 0) {
        viewerMediaTime = this.ringMediaTime[this.readBlock];
      } else {
        viewerMediaTime = this.lastBlockMediaTime;
      }
    }

    this.telemetryCounter++;
    if (this.telemetryCounter >= 12) {
      // ~32ms telemetry cadence at 48kHz
      const rms =
        this.inputRmsCount > 0 ? Math.sqrt(this.inputRmsAcc / this.inputRmsCount) : 0;
      this.inputRmsAcc = 0;
      this.inputRmsCount = 0;
      this.telemetryCounter = 0;

      const bufferedWallSec = (this.bufferedBlocks * 128) / this.srcSampleRate;
      const bufferedMediaLead =
        this.bufferedBlocks > 0
          ? Math.max(0, this.captureMediaTime - this.ringMediaTime[this.readBlock])
          : 0;

      this.port.postMessage({
        type: 'clock',
        generationId: this.generationId,
        mode: this.mode,
        viewerMediaTime,
        captureMediaTime: this.captureMediaTime,
        bufferedWallSec,
        bufferedMediaLead,
        inputRms: rms,
      });
    }

    return true;
  }
}

registerProcessor('lookahead-audio-processor', LookaheadAudioProcessor);
