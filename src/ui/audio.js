// PocketGB — Web Audio bridge.
//
// Preferred path: an AudioWorkletNode running on the AUDIO thread, fed from a
// ring the main thread pumps. This decouples audio continuity from main-thread
// jank (GC pauses, canvas presents, rewind snapshots) that used to make
// ScriptProcessorNode's main-thread callbacks miss their deadline and glitch.
//   - SharedArrayBuffer ring when SAB is available (zero copy, lock-free)
//   - otherwise small Float32Array blocks via port.postMessage (~344/s, cheap)
// Fallback path: the old ScriptProcessorNode (works everywhere, but its
// callback runs on the main thread), with a larger buffer for jank slack.
//
// Underruns never output silence-zip noise: the last sample is held.
'use strict';

// Worklet source is embedded as a string and added via a blob URL so no extra
// file/serve step is needed. No backticks or ${} inside, by design.
const AUDIO_WORKLET_SRC = `
class GBOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];      // postMessage mode: queued {l, r} block pairs
    this.sab = null;       // SAB mode: {hdr: Int32Array, data: Float32Array, mask}
    this.heldL = 0; this.heldR = 0;
    this.underrunFrames = 0;
    this.processCount = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'sab') {
        this.sab = {
          hdr: new Int32Array(d.hdr),        // [0]=writeCount, [1]=readCount
          data: new Float32Array(d.data),    // interleaved stereo
          mask: d.mask,
        };
      } else if (d.type === 'block') {
        this.blocks.push(d);
        if (this.blocks.length > 48) this.blocks.shift(); // bound the queue
      } else if (d.type === 'ping') {
        this.port.postMessage({ type: 'state', underrunFrames: this.underrunFrames });
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n = outL.length;
    let filled = 0;
    if (this.sab) {
      const { hdr, data, mask } = this.sab;
      let r = Atomics.load(hdr, 1);
      const w = Atomics.load(hdr, 0);
      while (filled < n && r < w) {
        const i = (r & mask) * 2;
        outL[filled] = data[i];
        outR[filled] = data[i + 1];
        r++; filled++;
      }
      Atomics.store(hdr, 1, r);
    } else {
      while (filled < n && this.blocks.length) {
        const b = this.blocks.shift();
        const l = b.l, r = b.r;
        for (let i = 0; i < l.length && filled < n; i++) {
          outL[filled] = l[i]; outR[filled] = r[i]; filled++;
        }
      }
    }
    if (filled < n) {
      // underrun: hold the last sample (inaudible compared to a zero drop)
      for (; filled < n; filled++) { outL[filled] = this.heldL; outR[filled] = this.heldR; }
      this.underrunFrames += n - filled;
      if (this.underrunFrames % 16384 < n) this.port.postMessage({ type: 'state', underrunFrames: this.underrunFrames });
    }
    if (n > 0) { this.heldL = outL[n - 1]; this.heldR = outR[n - 1]; }
    // Report queued backlog periodically so the main thread can pace
    // production (turbo/fast-forward) against real in-flight audio.
    if (!this.sab && (++this.processCount & 7) === 0) {
      this.port.postMessage({ type: 'depth', frames: this.blocks.length * 128 });
    }
    return true;
  }
}
registerProcessor('gb-output', GBOutputProcessor);
`;

const SAB_RING_FRAMES = 16384;  // stereo frames (~0.37 s @ 44.1 kHz)
const SAB_TARGET_FRAMES = 4096; // pump up to ~93 ms of slack ahead of the audio thread
const SP_BUFFER_FRAMES = 4096;  // ScriptProcessor fallback buffer (~93 ms)

class AudioManager {
  constructor() {
    this.ctx = null;
    this.node = null;        // AudioWorkletNode or ScriptProcessorNode
    this.gainNode = null;
    this.muted = false;
    this.apu = null;         // set later
    this.mode = 'none';      // 'worklet-sab' | 'worklet-blocks' | 'scriptprocessor' | 'none'
    this._workletBacklog = 0; // worklet's queued frames (depth messages)
    this.scratchL = new Float32Array(128);
    this.scratchR = new Float32Array(128);
    this.sab = null;         // { hdr, data, mask, writeCount }
    this.underrunFrames = 0;
    this._pumpTimer = null;
  }

  attach(apu) {
    this.apu = apu;
  }

  async start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.muted ? 0 : 0.6;
    this.gainNode.connect(this.ctx.destination);

    // Generate at the device's actual rate so the emulator produces exactly
    // what the device consumes (no chronic drift/underrun).
    if (this.apu && this.apu.setOutputRate) this.apu.setOutputRate(this.ctx.sampleRate);

    const workletOk = await this._startWorklet().catch(() => false);
    if (!workletOk) this._startScriptProcessor();

    // Recording tap: the output node (worklet or ScriptProcessor) is an
    // AudioNode, so a MediaStreamDestination branch carries exactly what's
    // heard — for MediaRecorder video captures.
    this.recDest = this.ctx.createMediaStreamDestination();
    this.node.connect(this.recDest);

    // Safety net: the rAF pump can stall with the tab hidden or the main
    // thread jammed; a cheap interval keeps the ring fed. It no-ops when full.
    if (!this._pumpTimer) this._pumpTimer = setInterval(() => this.pump(), 8);
  }

  async _startWorklet() {
    if (typeof AudioWorkletNode === 'undefined') return false;
    const blob = new Blob([AUDIO_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, 'gb-output', { outputChannelCount: [2] });
    this.node.port.onmessage = (e) => {
      if (e.data && e.data.type === 'state') this.underrunFrames = e.data.underrunFrames;
      else if (e.data && e.data.type === 'depth') this._workletBacklog = e.data.frames;
    };
    this.node.connect(this.gainNode);

    if (typeof SharedArrayBuffer !== 'undefined') {
      try {
        const hdr = new SharedArrayBuffer(8); // two Int32 counters
        const data = new SharedArrayBuffer(SAB_RING_FRAMES * 2 * 4);
        this.sab = {
          hdr: new Int32Array(hdr),          // [0]=writeCount, [1]=readCount
          data: new Float32Array(data),
          mask: SAB_RING_FRAMES - 1,
          writeCount: 0,
        };
        this.node.port.postMessage({ type: 'sab', hdr, data, mask: SAB_RING_FRAMES - 1 });
        this.mode = 'worklet-sab';
        return true;
      } catch (e) { /* fall through to block mode */ }
    }
    this.mode = 'worklet-blocks';
    return true;
  }

  _startScriptProcessor() {
    this.mode = 'scriptprocessor';
    this.node = this.ctx.createScriptProcessor(SP_BUFFER_FRAMES, 0, 2);
    this.node.onaudioprocess = (e) => this._fillSP(e);
    this.node.connect(this.gainNode);
  }

  // ScriptProcessor fallback: pull per-sample (older APU API), hold on underrun.
  _fillSP(e) {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    if (!this.apu) { outL.fill(0); outR.fill(0); return; }
    const lRef = [0], rRef = [0];
    for (let i = 0; i < outL.length; i++) {
      if (this.apu.pull(lRef, rRef)) {
        outL[i] = lRef[0]; outR[i] = rRef[0];
        this._heldL = lRef[0]; this._heldR = rRef[0];
      } else {
        outL[i] = this._heldL || 0; outR[i] = this._heldR || 0;
        this.underrunFrames++;
      }
    }
  }

  // Main-thread pump: move audio from the APU ring into the worklet's ring.
  // Called every rAF tick and on an 8 ms interval. Cheap when full.
  pump() {
    if (!this.apu) return;
    if (this.mode === 'worklet-sab') this._pumpSAB();
    else if (this.mode === 'worklet-blocks') this._pumpBlocks();
  }

  _pumpSAB() {
    const { hdr, data, mask } = this.sab;
    let w = this.sab.writeCount;
    const r = Atomics.load(hdr, 1);
    // Top up toward the target, in 128-frame quanta (the worklet quantum).
    while (w - r < SAB_TARGET_FRAMES && this.apu.available() > 0) {
      const count = this.apu.pullBlock(this.scratchL, this.scratchR);
      if (!count) break;
      for (let i = 0; i < count; i++) {
        const o = ((w + i) & mask) * 2;
        data[o] = this.scratchL[i];
        data[o + 1] = this.scratchR[i];
      }
      w += count;
      if (w - r > SAB_RING_FRAMES - 128) break; // never lap the reader
    }
    if (w !== this.sab.writeCount) {
      this.sab.writeCount = w;
      Atomics.store(hdr, 0, w);
    }
  }

  _pumpBlocks() {
    // Don't outrun the worklet's queue: stop feeding when in-flight audio is
    // already deep (keeps fast-forward from overflowing and dropping blocks).
    if (this._workletBacklog > 8192) return;
    // One 128-frame block per pump call; rAF (~60/s) + 8 ms timer (~125/s)
    // together provide ~185 blocks/s vs ~344 needed at worst — so send up to
    // three when running behind, still trivial overhead.
    for (let k = 0; k < 3; k++) {
      const count = this.apu.pullBlock(this.scratchL, this.scratchR);
      if (!count) return;
      const l = this.scratchL.slice(0, count);
      const r = this.scratchR.slice(0, count);
      this.node.port.postMessage({ type: 'block', l, r });
      this._workletBacklog += count;
      if (count < 128) return;
    }
  }

  // Total audio backlog in frames (ring + in-flight to the worklet). The frame
  // loop paces against this so a slow/stalled consumer throttles production.
  buffered() {
    if (this.mode === 'worklet-sab' && this.sab) {
      const r = Atomics.load(this.sab.hdr, 1);
      return (this.sab.writeCount - r) + (this.apu ? this.apu.available() : 0);
    }
    if (this.mode === 'worklet-blocks') {
      // Blocks in flight (per the worklet's periodic depth reports) plus
      // whatever hasn't been pumped out of the APU ring yet.
      return this._workletBacklog + (this.apu ? this.apu.available() : 0);
    }
    return this.apu ? this.apu.available() : 0;
  }

  setMuted(m) {
    this.muted = m;
    if (this.gainNode) this.gainNode.gain.value = m ? 0 : 0.6;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // An audio MediaStreamTrack mirroring the output, for video recording.
  getRecordingTrack() {
    if (!this.recDest) return null;
    return this.recDest.stream.getAudioTracks()[0] || null;
  }
}

if (typeof module !== 'undefined') module.exports = { AudioManager };
