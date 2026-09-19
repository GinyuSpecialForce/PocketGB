// PocketGB — cheat engine: GameShark (RAM writes) + Game Genie (ROM patches)
//
// GameShark GB format: TTVVLLHH — 8 hex digits:
//   TT      = device bank tag — IGNORED (mGBA discards it too). Most codes
//             use '01', but real published codes use other tags, e.g. Super
//             Mario Bros. Deluxe "Disable All Enemies" = 9120D2D2.
//   VV      = value written continuously,
//   LL HH   = address, little-endian (low byte first!). Pan Docs example:
//   010238CD → write 0x02 at 0xCD38 ('38' low, 'CD' high).
// Dashes/spaces are ignored.
//
// Game Genie GB format: XXXYYY or XXXYYYZZZ (dashes/spaces allowed).
//   Nibbles: [0..5] required, [6..8] optional compare.
//   value = n1 | n0<<4                       (plain hex)
//   addr  = (n2<<8) | (n3<<4) | n4 | ((~n5 & 0xF) << 12)   (high nibble complemented)
//   compare (9 digits): t = n8 | n6<<4; t = rotate right by 2; compare = t ^ 0xBA
//   Verified against documented example 068-5FF-E66 → addr 0x085F, value 0x06, compare 0x03.
'use strict';

const HEX = /^[0-9A-F]+$/;

// Parse a GameShark code → { addr, value, bank } or null.
function parseGameShark(raw) {
  const s = String(raw).toUpperCase().replace(/[^0-9A-F]/g, '');
  if (s.length !== 8 || !HEX.test(s)) return null;
  const value = parseInt(s.slice(2, 4), 16);
  const addr = parseInt(s.slice(6, 8) + s.slice(4, 6), 16); // address is little-endian
  if (addr < 0x8000) return null; // GameShark writes RAM only, never ROM/registers
  return { addr, value, bank: parseInt(s.slice(0, 2), 16) }; // bank tag kept for display
}

// Parse a Game Genie code → { addr, value, compare|null } or null.
function parseGameGenie(raw) {
  const s = String(raw).toUpperCase().replace(/[^0-9A-F]/g, '');
  if ((s.length !== 6 && s.length !== 9) || !HEX.test(s)) return null;
  const n = s.split('').map((c) => parseInt(c, 16));
  const value = n[1] | (n[0] << 4);
  const addr = (n[2] << 8) | (n[3] << 4) | n[4] | ((~n[5] & 0xF) << 12);
  if (addr < 0x0002) return null; // device cannot patch 0000-0001
  let compare = null;
  if (s.length === 9) {
    let t = n[8] | (n[6] << 4);
    t = ((t >> 2) | (t << 6)) & 0xFF; // rotate right by 2
    compare = t ^ 0xBA;
  }
  return { addr, value, compare };
}

class CheatEngine {
  constructor() {
    this.gsCodes = [];  // { code, addr, value, enabled }
    this.ggCodes = [];  // { code, addr, value, compare, enabled }
  }

  // Add a code in either format. Returns { type, ... } or { error }.
  add(raw) {
    const text = String(raw).trim();
    const gs = parseGameShark(text);
    if (gs) {
      const entry = { kind: 'gs', code: text.toUpperCase(), enabled: true, ...gs };
      this.gsCodes.push(entry);
      return entry;
    }
    const gg = parseGameGenie(text);
    if (gg) {
      const entry = { kind: 'gg', code: text.toUpperCase(), enabled: true, ...gg };
      this.ggCodes.push(entry);
      return entry;
    }
    return { error: 'Not a valid GameShark (8 hex digits: value + address, e.g. 010238CD) or Game Genie (XXXYYY[ZZZ]) code' };
  }

  remove(index) {
    // Index into the combined list shown in the UI (GS first, then GG).
    if (index < this.gsCodes.length) this.gsCodes.splice(index, 1);
    else this.ggCodes.splice(index - this.gsCodes.length, 1);
  }

  toggle(index) {
    const total = this.gsCodes.length + this.ggCodes.length;
    if (index < 0 || index >= total) return;
    if (index < this.gsCodes.length) this.gsCodes[index].enabled = !this.gsCodes[index].enabled;
    else this.ggCodes[index - this.gsCodes.length].enabled = !this.ggCodes[index - this.gsCodes.length].enabled;
  }

  clear() {
    this.gsCodes.length = 0;
    this.ggCodes.length = 0;
  }

  all() {
    return [...this.gsCodes, ...this.ggCodes];
  }

  serialize() {
    return this.all().map((c) => ({ code: c.code, enabled: c.enabled }));
  }

  // Rebuild from serialized list (keeps persisted state across restarts).
  restore(list) {
    this.clear();
    for (const c of list || []) {
      if (!c || typeof c.code !== 'string') continue;
      const gs = parseGameShark(c.code);
      if (gs) { this.gsCodes.push({ kind: 'gs', code: c.code.toUpperCase(), enabled: !!c.enabled, ...gs }); continue; }
      const gg = parseGameGenie(c.code);
      if (gg) this.ggCodes.push({ kind: 'gg', code: c.code.toUpperCase(), enabled: !!c.enabled, ...gg });
    }
  }

  // Once per frame: GameShark = continuous RAM writes.
  applyRAM(mmu) {
    for (const c of this.gsCodes) {
      if (!c.enabled) continue;
      mmu.write(c.addr, c.value);
    }
  }

  // Called on every ROM read (bank 0/1 region). Returns override byte or undefined.
  patchROM(addr, romByte) {
    for (const c of this.ggCodes) {
      if (!c.enabled || c.addr !== addr) continue;
      if (c.compare !== null && c.compare !== romByte) continue;
      return c.value;
    }
    return undefined;
  }
}

// ---- Cheat finder (RAM scanner) ------------------------------------------
// Search working RAM (C000-DFFF via mmu.read, so CGB banking applies) plus
// high RAM for an 8-bit value, narrow the candidate set by comparing snapshots,
// watch candidates live, and promote any hit to a real GameShark code that
// freezes the address. 8-bit covers essentially all GB game state (lives,
// coins above 255 live as BCD pairs, timers, positions); 16-bit searchers can
// scan twice: byte found, then narrow by "address ±1 unchanged".

class CheatFinder {
  constructor(mmuProvider) {
    this.getMmu = mmuProvider;   // () => mmu — game swaps must stay visible
    this.candidates = null;      // Map addr → last-seen value, or null
    this.prevSnapshot = null;    // Map addr → value at previous scan
    this.watches = [];           // [{ addr }] polled live by the UI
  }

  _scanAddresses() {
    const mmu = this.getMmu();
    const addrs = [];
    for (let a = 0xC000; a < 0xE000; a++) addrs.push(a);       // WRAM (8/32K, banking via readWRAM)
    for (let a = 0xFF80; a < 0xFFFE; a++) addrs.push(a);       // HRAM
    return { mmu, addrs };
  }

  // First search: value === null means "unknown initial value" (take all).
  // Returns the number of candidates.
  search(value) {
    const { mmu, addrs } = this._scanAddresses();
    this.candidates = new Map();
    for (const a of addrs) {
      const v = mmu.read(a) & 0xFF;
      if (value === null || v === (value & 0xFF)) this.candidates.set(a, v);
    }
    return this.candidates.size;
  }

  // Narrow: keep only candidates matching the filter.
  //   { op: 'eq'|'ne'|'lt'|'gt', value }  — compare against a typed value
  //   { op: 'changed'|'unchanged' }       — compare against the previous scan
  //   { op: 'plus'|'minus', value }       — delta since previous scan
  narrow(filter) {
    if (!this.candidates) return 0;
    const mmu = this.getMmu();
    const next = new Map();
    this.prevSnapshot = this.candidates;
    for (const [a, oldV] of this.candidates) {
      const v = mmu.read(a) & 0xFF;
      // oldV is the value at the previous scan — narrows are snapshots, and the
      // game plays in between, so deltas measure real movement since last scan.
      const keep =
        filter.op === 'changed' ? v !== oldV :
        filter.op === 'unchanged' ? v === oldV :
        filter.op === 'plus' ? (v - oldV + 256) % 256 === (filter.value & 0xFF) :
        filter.op === 'minus' ? (oldV - v + 256) % 256 === (filter.value & 0xFF) :
        filter.op === 'eq' ? v === (filter.value & 0xFF) :
        filter.op === 'ne' ? v !== (filter.value & 0xFF) :
        filter.op === 'lt' ? v < (filter.value & 0xFF) :
        filter.op === 'gt' ? v > (filter.value & 0xFF) : false;
      if (keep) next.set(a, v);
    }
    this.candidates = next;
    return next.size;
  }

  // Watch list: stable polling source for the UI (also survives rescans).
  read(addr) { const mmu = this.getMmu(); return mmu ? mmu.read(addr & 0xFFFF) & 0xFF : 0; }

  // Promote a candidate to a persistent GameShark code (freezes the address).
  freeze(addr, engine, value) {
    const mmu = this.getMmu();
    const v = (value !== undefined ? value : mmu.read(addr)) & 0xFF;
    return engine.add(gsFreezeCode(addr, v));
  }

  reset() { this.candidates = null; this.prevSnapshot = null; }
}

// Build the GameShark code string that freezes `addr` at `value`
// (01 VV LL HH — bank tag ignored by our decoder; kept conventional).
function gsFreezeCode(addr, value) {
  return ('01' + value.toString(16).padStart(2, '0') +
    (addr & 0xFF).toString(16).padStart(2, '0') + ((addr >> 8) & 0xFF).toString(16).padStart(2, '0')).toUpperCase();
}

if (typeof module !== 'undefined') module.exports = { CheatEngine, parseGameShark, parseGameGenie, CheatFinder, gsFreezeCode };
if (typeof window !== 'undefined') window.PocketCheat = { CheatEngine, parseGameShark, parseGameGenie, CheatFinder, gsFreezeCode };
