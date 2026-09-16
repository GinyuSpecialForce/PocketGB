// PocketGB — Web Audio bridge: ring buffer → ScriptProcessorNode
'use strict';

class AudioManager {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.gainNode = null;
    this.muted = false;
    this.apu = null; // set later
  }

  attach(apu) {
    this.apu = apu;
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.muted ? 0 : 0.6;
    this.gainNode.connect(this.ctx.destination);

    // Generate at the device's actual rate (48k on most macOS machines) so the
    // ring drains at the same rate the emulator produces — no chronic underrun.
    if (this.apu && this.apu.setOutputRate) this.apu.setOutputRate(this.ctx.sampleRate);

    // ScriptProcessorNode is deprecated but dead simple and works everywhere
    this.node = this.ctx.createScriptProcessor(2048, 0, 2);
    this.node.onaudioprocess = (e) => this.fill(e);
    this.node.connect(this.gainNode);
  }

  fill(e) {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    if (!this.apu) { outL.fill(0); outR.fill(0); return; }
    const lRef = [0], rRef = [0];
    for (let i = 0; i < outL.length; i++) {
      if (this.apu.pull(lRef, rRef)) {
        outL[i] = lRef[0];
        outR[i] = rRef[0];
      } else {
        outL[i] = 0; outR[i] = 0; // buffer underrun: silence
      }
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.gainNode) this.gainNode.gain.value = m ? 0 : 0.6;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}
