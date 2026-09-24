// PocketGB — movie recording/replay (TAS-lite)
//
// Format ("PGBM"): JSON meta + anchor save-state + per-frame 1-byte pressed
// masks. Recording anchors to a save-state + ROM identity so replay is exact.
// Mask bits (1 = pressed): 0=A 1=B 2=Select 3=Start 4=Right 5=Left 6=Up 7=Down
// — same order as joypad.js's JOY_* constants.
// v2 adds GBA shoulder buttons as bits 8/9 (L=bit 8, R=bit 9), expanding the
// per-frame mask to 2 bytes. Masks are written little-endian; GB movies (v1)
// never set bits 8+, so their 2-byte frames replay identically. Mismatched
// versions are rejected: a v1 movie predates GBA support, and its ROM identity
// is GB-header-derived, so it can never target a GBA game anyway.
'use strict';

class MovieRecorder {
  constructor() { this.reset(); }
  reset() {
    this.frames = [];      // 2 bytes (little-endian) per emulated frame
    this.recording = false;
    this.meta = null;
  }
  start(gb) {
    this.reset();
    this.recording = true;
    this.meta = {
      v: 2,
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
    const total = 8 + jsonBytes.length + 4 + stateLen + this.frames.length * 2;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out.set([0x50, 0x47, 0x42, 0x4D], 0); // "PGBM"
    dv.setUint32(4, jsonBytes.length, true);
    out.set(jsonBytes, 8);
    const o1 = 8 + jsonBytes.length;
    dv.setUint32(o1, stateLen, true);
    out.set(this.meta.state, o1 + 4);
    const o2 = o1 + 4 + stateLen;
    const dv2 = new DataView(out.buffer, o2);
    for (let i = 0; i < this.frames.length; i++) dv2.setUint16(i * 2, this.frames[i] & 0x3FF, true);
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
      if (meta.v !== 2) return 'movie format not supported'; // v1 predates GBA L/R masks
      const o1 = 8 + jsonLen;
      const stateLen = dv.getUint32(o1, true);
      this.anchorState = bytes.slice(o1 + 4, o1 + 4 + stateLen);
      this.frames = bytes.slice(o1 + 4 + stateLen);
      this.romId = meta.rom;
      this.pos = 0;
      this.playing = false;
      this.total = meta.frames;
      if (this.frames.length < meta.frames * 2) return 'truncated movie file';
      if (this.romId !== movieRomId(gb)) return `movie is for ${this.romId.split('|')[0] || 'another game'}`;
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
    return this.frames[this.pos++] | (this.frames[this.pos++] << 8);
  }
  get progress() { return this.total ? this.pos / this.total : 0; }
}

// mask ↔ joypad state-object conversion.
// Bits 0-7 match the GB joypad (order of joypad.js's JOY_* constants); bits
// 8/9 are the GBA shoulders, which the GB machine ignores but movies still
// round-trip so a recording made on either console replays faithfully.
const MASK_KEYS = ['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'l', 'r'];
function maskToState(mask) {
  const s = {};
  for (let i = 0; i < MASK_KEYS.length; i++) s[MASK_KEYS[i]] = !!(mask & (1 << i));
  return s;
}
function stateToMask(state) {
  let m = 0;
  for (let i = 0; i < MASK_KEYS.length; i++) if (state && state[MASK_KEYS[i]]) m |= (1 << i);
  return m;
}

function movieRomId(gb) {
  // ROM identity: title + size + dense FNV-1a over the content (fast enough
  // at ROM sizes; a sparse stride can miss single-byte hack diffs).
  // GBA headers carry a 12-byte game title at 0xA0 (0xAC-0xAF is the code);
  // GB headers use the 15-byte region starting at 0x134.
  const r = gb.cart.rom;
  const isGba = !!(gb.isGba || (r.length >= 0xB0 && r[4] === 0x24 && r[5] === 0xFF && r[6] === 0xAE && r[7] === 0x51));
  const tStart = isGba ? 0xA0 : 0x134, tEnd = isGba ? 0xAB : 0x142;
  let title = '';
  for (let i = tStart; i <= tEnd; i++) { const ch = r[i]; if (ch >= 32 && ch < 127) title += String.fromCharCode(ch); }
  let h = 0x811C9DC5;
  for (let i = 0; i < r.length; i++) { h ^= r[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${title.trim()}|${r.length}|${h.toString(36)}`;
}

if (typeof module !== 'undefined') module.exports = { MovieRecorder, MoviePlayer, movieRomId, maskToState, stateToMask };
if (typeof window !== 'undefined') window.PocketMovie = { MovieRecorder, MoviePlayer, movieRomId, maskToState, stateToMask };
