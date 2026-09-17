// PocketGB — APU: 4 channels (pulse x2, wave, noise), frame sequencer, stereo output ring
'use strict';

const DUTY_TABLES = [
  [0,0,0,0,0,0,0,1], // 12.5%
  [1,0,0,0,0,0,0,1], // 25%
  [1,0,0,0,0,1,1,1], // 50%
  [0,1,1,1,1,1,1,0], // 75%
];

const RING_SIZE = 32768; // power of two, interleaved stereo
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];
const MAX_VOL = 15;

class APU {
  constructor() {
    this._mixLR = new Float32Array(2); // reused mix output (no per-sample allocation)
    this.reset();
  }

  reset() {
    this.enabled = true;
    this.ring = new Float32Array(RING_SIZE * 2); // interleaved L,R
    this.readPos = 0; this.writePos = 0;
    this.cycleAcc = 0;
    this.outputRate = this.outputRate || 44100; // survive APU power cycles
    this.sampleEvery = 4194304 / this.outputRate; // T-cycles per output sample

    this.seqStep = 0;
    this.seqAcc = 0;
    this.seqEvery = 8192; // T-cycles (the frame sequencer steps every 8192 T-cycles)

    this.nr50 = 0x77; this.nr51 = 0xF3;

    const mk = () => ({
      // shared channel fields
      on: false, dac: false,
      freq: 0, timer: 0,
      // pulse
      duty: 0, dutyPos: 0,
      len: 0, lenEnable: false,
      envVol: 0, envDir: 0, envPeriod: 0, envTimer: 0,
      // sweep (ch1)
      sweepEnable: false, sweepNeg: false, sweepShift: 0, sweepTimer: 0, sweepFreq: 0,
      // wave
      volumeShift: 0, pos: 0,
      // noise
      lfsr: 0x7FFF, divCode: 0, widthMode: false,
      wave: new Uint8Array(32),
      outL: 0, outR: 0,
    });
    this.ch = [mk(), mk(), mk(), mk()];
    this.ch[0].sweepCapable = true;

    this.nr52 = 0xF1; // power on, ch1 on (post-boot-ish)
    this.ch[0].on = true; this.ch[0].dac = true;
    this.waveRam = new Uint8Array(16);
  }

  // ---- ring buffer ----
  pushSample(l, r) {
    const next = (this.writePos + 1) & (RING_SIZE - 1);
    if (next === this.readPos) { this.readPos = (this.readPos + 1) & (RING_SIZE - 1); } // drop oldest
    this.ring[this.writePos * 2] = l;
    this.ring[this.writePos * 2 + 1] = r;
    this.writePos = next;
  }
  available() {
    return (this.writePos - this.readPos + RING_SIZE) & (RING_SIZE - 1);
  }
  pull(outL, outR) {
    if (this.readPos === this.writePos) return false;
    outL[0] = this.ring[this.readPos * 2];
    outR[0] = this.ring[this.readPos * 2 + 1];
    this.readPos = (this.readPos + 1) & (RING_SIZE - 1);
    return true;
  }

  // Drain up to n stereo frames into separate-channel buffers (AudioWorklet
  // pump path). One call per block instead of per-sample closure overhead.
  // Returns the number of frames actually pulled (0 = underrun).
  pullBlock(outL, outR) {
    const n = outL.length;
    let avail = (this.writePos - this.readPos + RING_SIZE) & (RING_SIZE - 1);
    const count = avail < n ? avail : n;
    for (let i = 0; i < count; i++) {
      outL[i] = this.ring[this.readPos * 2];
      outR[i] = this.ring[this.readPos * 2 + 1];
      this.readPos = (this.readPos + 1) & (RING_SIZE - 1);
    }
    return count;
  }

  // Match sample generation to the audio device's actual rate (e.g. 48k on macOS).
  // Prevents a systematic underrun when the device rate differs from 44100.
  setOutputRate(rate) {
    if (!rate || rate === this.outputRate) return;
    this.outputRate = rate;
    this.sampleEvery = 4194304 / rate;
  }

  // ---- main tick ----
  // Receives T-cycles (4.19 MHz master clock), matching the CPU/PPU. Channels
  // only matter when they produce output samples (~every 95 T-cycles), so
  // advance them in per-sample bursts instead of once per T-cycle.
  tick(tCycles) {
    let remaining = tCycles;
    const ch0 = this.ch[0], ch1 = this.ch[1], ch2 = this.ch[2], ch3 = this.ch[3];
    while (remaining > 0) {
      // distance to the next output sample boundary (sampleEvery is fractional)
      const toSample = this.sampleEvery - this.cycleAcc;
      const n = toSample < remaining ? toSample : remaining;
      if (this.enabled) {
        this.advanceChannel(ch0, n);
        this.advanceChannel(ch1, n);
        this.advanceChannel(ch2, n);
        this.advanceChannel(ch3, n);
        this.seqAcc += n;
        // epsilon: seqAcc sums fractional chunk sizes, so exact multiples of
        // seqEvery can land a few ulps short — don't defer the step to a
        // later tick because of float representation.
        while (this.seqAcc >= this.seqEvery - 1e-6) { this.seqAcc -= this.seqEvery; this.frameSequencer(); }
      }
      this.cycleAcc += n;
      remaining -= n;
      if (this.cycleAcc >= this.sampleEvery) {
        this.cycleAcc -= this.sampleEvery;
        const s = this.mix();
        this.pushSample(s[0], s[1]);
      }
    }
  }

  // Advance channel phase counters by n T-cycles.
  advanceChannel(c, n) {
    if (c === this.ch[3]) {
      // Noise: LFSR shifts at 524288 Hz / divisor → divisor × 8 T-cycles
      const period = NOISE_DIV[c.divCode] * 8;
      c.timer += n;
      while (c.timer >= period) {
        c.timer -= period;
        const b = (c.lfsr & 1) ^ ((c.lfsr >> 1) & 1);
        c.lfsr = (c.lfsr >> 1) | (b << 14);
        if (c.widthMode) c.lfsr = (c.lfsr & ~0x40) | (b << 6);
      }
      return;
    }
    if (c !== this.ch[2]) {
      // Pulse: one duty step every (2048 - freq) T-cycles (f = 131072/(2048-n) Hz)
      const p = Math.max(1, 2048 - c.freq);
      c.timer += n;
      while (c.timer >= p) {
        c.timer -= p;
        c.dutyPos = (c.dutyPos + 1) & 7;
      }
    } else {
      // Wave: one of 32 samples every (2048 - freq)×2 T-cycles (f = 65536/(2048-n) Hz)
      const p = Math.max(1, Math.floor((2048 - c.freq) * 2));
      c.timer += n;
      while (c.timer >= p) {
        c.timer -= p;
        c.pos = (c.pos + 1) & 31;
      }
    }
  }

  // True when nothing time-dependent can happen soon (used to fast-forward HALT).
  isIdle() {
    if (!this.enabled) return true;
    // Any enabled+DAC-on channel sounds; frame sequencer events also matter.
    for (const c of this.ch) if (c.on && c.dac) return false;
    return true;
  }

  frameSequencer() {
    const s = this.seqStep;
    if (s % 2 === 0) for (const c of this.ch) this.tickLength(c);
    if (s === 2 || s === 6) this.tickSweep(this.ch[0]);
    if (s === 7) for (const c of this.ch) this.tickEnvelope(c);
    this.seqStep = (s + 1) & 7;
  }

  tickChannel(c) {
    if (c === this.ch[3]) { this.tickNoise(c); return; }
    if (c !== this.ch[2]) {
      // Pulse: one duty step every (2048 - freq) T-cycles (f = 131072/(2048-n) Hz)
      const p = Math.max(1, 2048 - c.freq);
      c.timer++;
      if (c.timer >= p) {
        c.timer = 0;
        c.dutyPos = (c.dutyPos + 1) & 7;
      }
    } else {
      // Wave: one of 32 samples every (2048 - freq)×2 T-cycles (f = 65536/(2048-n) Hz)
      const p = Math.max(1, Math.floor((2048 - c.freq) * 2));
      c.timer++;
      if (c.timer >= p) {
        c.timer = 0;
        c.pos = (c.pos + 1) & 31;
      }
    }
  }

  tickLength(c) {
    if (c.lenEnable && c.len > 0) {
      c.len--;
      if (c.len === 0) c.on = false;
    }
  }

  tickEnvelope(c) {
    if (c.envPeriod === 0) return;
    c.envTimer++;
    if (c.envTimer >= c.envPeriod) {
      c.envTimer = 0;
      if (c.envDir && c.envVol < 15) c.envVol++;
      else if (!c.envDir && c.envVol > 0) c.envVol--;
    }
  }

  tickSweep(c) {
    if (!c.sweepEnable) return;
    c.sweepTimer--;
    if (c.sweepTimer <= 0) {
      c.sweepTimer = c.sweepPeriod || 8;
      if (c.sweepShift > 0) {
        const nf = c.sweepFreq + (c.sweepFreq >> c.sweepShift) * (c.sweepNeg ? -1 : 1);
        if (nf > 2047) { c.on = false; c.sweepEnable = false; }
        else if (nf >= 0) {
          c.sweepFreq = nf; c.freq = nf;
          const nf2 = c.sweepFreq + (c.sweepFreq >> c.sweepShift) * (c.sweepNeg ? -1 : 1);
          if (nf2 > 2047) { c.on = false; c.sweepEnable = false; }
        }
      }
    }
  }

  tickNoise(c) {
    const div = [8, 16, 32, 48, 64, 80, 96, 112][c.divCode];
    const period = div * 8; // divisor × 8 T-cycles
    c.timer++;
    if (c.timer >= period) {
      c.timer -= period;
      const b = (c.lfsr & 1) ^ ((c.lfsr >> 1) & 1);
      c.lfsr = (c.lfsr >> 1) | (b << 14);
      if (c.widthMode) c.lfsr = (c.lfsr & ~0x40) | (b << 6);
    }
  }

  // Writes stereo sample into this._mixLR (reused — no per-sample allocation).
  mix() {
    const out = this._mixLR;
    if (!this.enabled) { out[0] = 0; out[1] = 0; return out; }
    let l = 0, r = 0;
    const nr51 = this.nr51;
    const ch = this.ch;
    for (let i = 0; i < 4; i++) {
      const c = ch[i];
      let sample = 0;
      if (c.on && c.dac) {
        if (i < 2) sample = DUTY_TABLES[c.duty][c.dutyPos] ? c.envVol : 0;
        else if (i === 2) {
          const byte = this.waveRam[c.pos >> 1];
          const nib = (c.pos & 1) ? (byte & 0xF) : (byte >> 4);
          sample = nib >> c.volumeShift;
        } else {
          sample = (c.lfsr & 1) ? 0 : c.envVol;
        }
      }
      const routing = (nr51 >> (i * 2)) & 3; // bit0: right, bit1: left
      const vol = i < 2 ? 1 : 0.8;
      if (routing & 1) r += sample * vol;
      if (routing & 2) l += sample * vol;
    }
    const masterL = ((this.nr50 >> 4) & 7) + 1;
    const masterR = (this.nr50 & 7) + 1;
    l = (l / (MAX_VOL * MAX_VOL)) * (masterL / 8);
    r = (r / (MAX_VOL * MAX_VOL)) * (masterR / 8);
    out[0] = l * 2.2 < -1 ? -1 : (l * 2.2 > 1 ? 1 : l * 2.2);
    out[1] = r * 2.2 < -1 ? -1 : (r * 2.2 > 1 ? 1 : r * 2.2);
    return out;
  }

  // ---- register IO ----
  read(a) {
    const c = this.ch;
    switch (a) {
      case 0xFF10: { const s = c[0]; return (s.sweepPeriod << 4) | (s.sweepNeg ? 8 : 0) | s.sweepShift; }
      case 0xFF11: { const s = c[0]; return (s.duty << 6) | 0x3F; }
      case 0xFF12: { const s = c[0]; return (s.envVol << 4) | (s.envDir ? 8 : 0) | s.envPeriod; }
      case 0xFF13: return 0xFF;
      case 0xFF14: return (c[0].lenEnable ? 0x40 : 0) | 0xBF;
      case 0xFF16: { const s2 = c[1]; return (s2.duty << 6) | 0x3F; }
      case 0xFF17: { const s2 = c[1]; return (s2.envVol << 4) | (s2.envDir ? 8 : 0) | s2.envPeriod; }
      case 0xFF18: return 0xFF;
      case 0xFF19: return (c[1].lenEnable ? 0x40 : 0) | 0xBF;
      case 0xFF1A: return c[2].dac ? 0xFF : 0x3F;
      case 0xFF1B: return 0xFF;
      case 0xFF1C: return (c[2].volumeShift << 5) | 0x1F;
      case 0xFF1D: return 0xFF;
      case 0xFF1E: return (c[2].lenEnable ? 0x40 : 0) | 0xBF;
      case 0xFF20: return 0xFF;
      case 0xFF21: { const s4 = c[3]; return (s4.envVol << 4) | (s4.envDir ? 8 : 0) | s4.envPeriod; }
      case 0xFF22: { const s4 = c[3]; return (s4.divCode << 4) | (s4.widthMode ? 8 : 0); }
      case 0xFF23: return (c[3].lenEnable ? 0x40 : 0) | 0xBF;
      case 0xFF24: return this.nr50;
      case 0xFF25: return this.nr51;
      case 0xFF26: {
        let v = 0x70 | (this.enabled ? 0x80 : 0);
        for (let i = 0; i < 4; i++) if (c[i].on) v |= (1 << i);
        return v;
      }
      default:
        if (a >= 0xFF30 && a <= 0xFF3F) return this.waveRam[a - 0xFF30];
        return 0xFF;
    }
  }

  write(a, v) {
    v &= 0xFF;
    const c = this.ch;
    if (!this.enabled) {
      if (a !== 0xFF26 && !(a >= 0xFF30 && a <= 0xFF3F)) return; // powered off: only NR52 + waveram writable
    }
    switch (a) {
      case 0xFF10: { const s = c[0]; s.sweepPeriod = (v >> 4) & 7; s.sweepNeg = !!(v & 8); s.sweepShift = v & 7; return; }
      case 0xFF11: { const s = c[0]; s.duty = (v >> 6) & 3; s.len = 64 - (v & 0x3F); return; }
      case 0xFF12: { const s = c[0]; s.envVol = (v >> 4) & 0xF; s.envInitial = s.envVol; s.envDir = !!(v & 8); s.envPeriod = v & 7; s.dac = (v & 0xF8) !== 0; if (!s.dac) s.on = false; return; }
      case 0xFF13: c[0].freq = (c[0].freq & 0x700) | v; return;
      case 0xFF14: {
        const s = c[0];
        s.freq = (s.freq & 0xFF) | ((v & 7) << 8);
        s.lenEnable = !!(v & 0x40);
        if (v & 0x80) this.trigger(s);
        return;
      }
      case 0xFF16: { const s2 = c[1]; s2.duty = (v >> 6) & 3; s2.len = 64 - (v & 0x3F); return; }
      case 0xFF17: { const s2 = c[1]; s2.envVol = (v >> 4) & 0xF; s2.envInitial = s2.envVol; s2.envDir = !!(v & 8); s2.envPeriod = v & 7; s2.dac = (v & 0xF8) !== 0; if (!s2.dac) s2.on = false; return; }
      case 0xFF18: c[1].freq = (c[1].freq & 0x700) | v; return;
      case 0xFF19: {
        const s2 = c[1];
        s2.freq = (s2.freq & 0xFF) | ((v & 7) << 8);
        s2.lenEnable = !!(v & 0x40);
        if (v & 0x80) this.trigger(s2);
        return;
      }
      case 0xFF1A: { c[2].dac = !!(v & 0x80); if (!c[2].dac) c[2].on = false; return; }
      case 0xFF1B: { c[2].len = 256 - v; return; }
      case 0xFF1C: { c[2].volumeShift = (v >> 5) & 3; if (c[2].volumeShift === 3) c[2].volumeShift = 4; return; }
      case 0xFF1D: c[2].freq = (c[2].freq & 0x700) | v; return;
      case 0xFF1E: {
        const s3 = c[2];
        s3.freq = (s3.freq & 0xFF) | ((v & 7) << 8);
        s3.lenEnable = !!(v & 0x40);
        if (v & 0x80) this.trigger(s3);
        return;
      }
      case 0xFF20: { c[3].len = 64 - (v & 0x3F); return; }
      case 0xFF21: { const s4 = c[3]; s4.envVol = (v >> 4) & 0xF; s4.envInitial = s4.envVol; s4.envDir = !!(v & 8); s4.envPeriod = v & 7; s4.dac = (v & 0xF8) !== 0; if (!s4.dac) s4.on = false; return; }
      case 0xFF22: { const s4 = c[3]; s4.divCode = (v >> 4) & 7; s4.widthMode = !!(v & 8); return; }
      case 0xFF23: { c[3].lenEnable = !!(v & 0x40); if (v & 0x80) this.trigger(c[3]); return; }
      case 0xFF24: this.nr50 = v; return;
      case 0xFF25: this.nr51 = v; return;
      case 0xFF26: {
        const on = !!(v & 0x80);
        if (on && !this.enabled) this.reset(); // power on clears registers (DMG)
        this.enabled = on;
        return;
      }
      default:
        if (a >= 0xFF30 && a <= 0xFF3F) { this.waveRam[a - 0xFF30] = v; return; }
        return;
    }
  }

  trigger(c) {
    c.on = c.dac;
    if (c !== this.ch[2] && c.len === 0) c.len = 64;
    if (c === this.ch[2] && c.len === 0) c.len = 256;
    c.envTimer = 0;
    c.envVol = c.envInitial ?? c.envVol;
    if (c === this.ch[3]) { c.lfsr = 0x7FFF; c.timer = 0; }
    if (c === this.ch[2]) { c.pos = 0; c.timer = 0; }
    if (c === this.ch[0]) {
      c.sweepFreq = c.freq;
      c.sweepTimer = c.sweepPeriod || 8;
      c.sweepEnable = c.sweepShift > 0 || c.sweepPeriod > 0;
      if (c.sweepShift > 0) {
        const nf = c.sweepFreq + (c.sweepFreq >> c.sweepShift) * (c.sweepNeg ? -1 : 1);
        if (nf > 2047) c.on = false;
      }
    }
    c.timer = c.timer || 0;
  }
}

if (typeof module !== 'undefined') module.exports = { APU };
