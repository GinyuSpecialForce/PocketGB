// PocketGB — movie recording/replay (TAS-lite)
//
// Format ("PGBM"): JSON meta + anchor save-state + per-frame 1-byte pressed
// masks. Recording anchors to a save-state + ROM identity so replay is exact.
// Mask bits (1 = pressed): 0=A 1=B 2=Select 3=Start 4=Right 5=Left 6=Up 7=Down
// — same order as joypad.js's JOY_* constants.
'use strict';

class MovieRecorder {
  constructor() { this.reset(); }
  reset() {
    this.frames = [];      // one byte per emulated frame
    this.recording = false;
    this.meta = null;
  }
  start(gb) {
    this.reset();
    this.recording = true;
    this.meta = {
      v: 1,
      rom: movieRomId(gb),
      created: Date.now(),
      state: gb.saveState(),     // anchor: replay always starts here
    };
  }
  observe(mask) {
    if (this.recording) this.frames.push(mask & 0xFF);
  }
  stop() {
    this.recording = false;
    return this.serialize();
  }
  serialize() {
    const json = JSON.stringify({ v: this.meta.v, rom: this.meta.rom, created: this.meta.created, frames: this.frames.length });
    const enc = new TextEncoder();
    const jsonBytes = enc.encode(json);
    const stateLen = this.meta.state.length;
    const total = 8 + jsonBytes.length + 4 + stateLen + this.frames.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set([0x50, 0x47, 0x42, 0x4D], 0); // "PGBM"
    dv.setUint32(4, jsonBytes.length, true);
    out.set(jsonBytes, 8);
    const o1 = 8 + jsonBytes.length;
    dv.setUint32(o1, stateLen, true);
    out.set(this.meta.state, o1 + 4);
    const o2 = o1 + 4 + stateLen;
    for (let i = 0; i < this.frames.length; i++) out[o2 + i] = this.frames[i];
    return out;
  }
}

class MoviePlayer {
  constructor() { this.reset(); }
  reset() {
    this.frames = null;
    this.pos = 0;
    this.playing = false;
    this.romId = null;
    this.anchorState = null;
    this.total = 0;
  }
  // returns error string or null on success
  load(bytes, gb) {
    try {
      if (bytes.length < 12 || bytes[0] !== 0x50 || bytes[1] !== 0x47 || bytes[2] !== 0x42 || bytes[3] !== 0x4D) {
        return 'not a PocketGB movie';
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const jsonLen = dv.getUint32(4, true);
      const json = new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen));
      const meta = JSON.parse(json);
      const o1 = 8 + jsonLen;
      const stateLen = dv.getUint32(o1, true);
      this.anchorState = bytes.slice(o1 + 4, o1 + 4 + stateLen);
      this.frames = bytes.slice(o1 + 4 + stateLen);
      this.romId = meta.rom;
      this.pos = 0;
      this.playing = false;
      this.total = meta.frames;
      if (this.frames.length < meta.frames) return 'truncated movie file';
      if (this.romId !== movieRomId(gb)) return `movie is for ${this.romId}`;
      return null;
    } catch {
      return 'corrupt movie file';
    }
  }
  start(gb) {
    if (!this.anchorState) return 'no movie loaded';
    gb.loadState(new Uint8Array(this.anchorState));
    this.playing = true;
    this.pos = 0;
    return null;
  }
  // per-frame: returns the pressed mask to apply, or null when done
  next() {
    if (!this.playing || this.pos >= this.frames.length) { this.playing = false; return null; }
    return this.frames[this.pos++];
  }
  get progress() { return this.total ? this.pos / this.total : 0; }
}

// mask ↔ joypad state-object conversion
const MASK_KEYS = ['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down'];
function maskToState(mask) {
  const s = {};
  for (let i = 0; i < 8; i++) s[MASK_KEYS[i]] = !!(mask & (1 << i));
  return s;
}
function stateToMask(state) {
  let m = 0;
  for (let i = 0; i < 8; i++) if (state && state[MASK_KEYS[i]]) m |= (1 << i);
  return m;
}

function movieRomId(gb) {
  // ROM identity: title + size + dense FNV-1a over the content (fast enough
  // at ROM sizes; a sparse stride can miss single-byte hack diffs)
  const r = gb.cart.rom;
  let title = '';
  for (let i = 0x134; i <= 0x142; i++) { const ch = r[i]; if (ch >= 32 && ch < 127) title += String.fromCharCode(ch); }
  let h = 0x811C9DC5;
  for (let i = 0; i < r.length; i++) { h ^= r[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${title.trim()}|${r.length}|${h.toString(36)}`;
}

if (typeof module !== 'undefined') module.exports = { MovieRecorder, MoviePlayer, movieRomId, maskToState, stateToMask };
if (typeof window !== 'undefined') window.PocketMovie = { MovieRecorder, MoviePlayer, movieRomId, maskToState, stateToMask };
