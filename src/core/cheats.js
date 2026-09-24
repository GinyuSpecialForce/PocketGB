// PocketGB — cheat engine: GameShark (RAM writes) + Game Genie (ROM patches)
//
// GB/CGB codes run through the in-process CheatEngine below (per-frame MMU
// writes / ROM read patches). GBA codes run through mGBA's own cheat engine
// (see gbaCheatsFile below): the wasm core exposes no memory write API, so
// codes are validated here, persisted per game, and handed to the core as a
// .cheats file loaded at boot.
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

// ---- GBA cheat formats (parsed for validation/description; mGBA applies) ----
// mGBA's GBACheatAddLine autodetects three line shapes:
//   "XXXXXXXX XXXXXXXX"  GameShark / Pro Action Replay (encrypted — mGBA
//                        decrypts using the ROM's CRC, so the operands are
//                        ciphertext and only the shape can be validated here)
//   "XXXXXXXX XXXX"      CodeBreaker v3 — high nibble of the first operand is
//                        the op type, the low 28 bits are the bus address
//                        (GBACheatAddCodeBreaker: address = op1 & 0x0FFFFFFF);
//                        codes after an M/ENCRYPT code are encrypted too
//   "XXXXXXXX:YY"        VBA-format raw write (address : byte, repeatable)
// Dashes and spaces are interchangeable separators; letter case is not.

// Parse a GBA cheat line → { format, address, value } or null.
// address/value describe the *effect* where the format makes that meaningful
// (VBA); for the encrypted AR/GS shape they describe the raw operands.
function parseGbaCheatLine(raw) {
  const s = String(raw).trim().toUpperCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  let m = /^([0-9A-F]{8}) ([0-9A-F]{8})$/.exec(s);
  if (m) {
    // Encrypted GameShark/AR: the operands are ciphertext, so no address check
    // is possible (or correct) — shape only, exactly like mGBA's autodetect.
    return { format: 'ar', address: parseInt(m[1], 16), value: parseInt(m[2], 16) };
  }
  m = /^([0-9A-F]{8}) ([0-9A-F]{4})$/.exec(s);
  if (m) {
    // CodeBreaker: high nibble = op type, low 28 bits = bus address. Encrypted
    // CB codes are legal too, so this is a display decode, not a filter.
    return { format: 'cb', address: parseInt(m[1], 16) & 0x0FFFFFFF, value: parseInt(m[2], 16) };
  }
  m = /^([0-9A-F]{8}):([0-9A-F]{2})$/.exec(s);
  if (m) {
    return { format: 'vba', address: parseInt(m[1], 16), value: parseInt(m[2], 16) };
  }
  return null;
}

const GBA_FORMAT_NAMES = { ar: 'GameShark / Pro Action Replay', cb: 'CodeBreaker v3', vba: 'VBA raw write' };

// Plain-language description of a GBA cheat line (mirrors describeCheat's job
// on GB: makes typos and wrong-game codes visible before they do damage).
function describeGbaCheat(entry) {
  const a = entry.address, v = entry.value;
  const hx = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
  const what = [`${GBA_FORMAT_NAMES[entry.format] || entry.format} code`];
  if (entry.format === 'vba') {
    let region = 'IWRAM (fast RAM)';
    if (a >= 0x02000000 && a < 0x02040000) region = 'EWRAM';
    else if (a >= 0x03000000 && a < 0x03008000) region = 'IWRAM (fast RAM)';
    else if (a >= 0x04000000 && a < 0x04000400) region = 'hardware I/O';
    else if (a >= 0x05000000 && a < 0x05000400) region = 'palette RAM';
    else if (a >= 0x06000000 && a < 0x06018000) region = 'VRAM';
    else if (a >= 0x07000000 && a < 0x07000400) region = 'OAM (sprite table)';
    what.push(`writes ${hx(v, 2)} (${v}) to ${region} at $${hx(a, 8)}`);
    if (a >= 0x04000000 && a < 0x04000400) what.push('⚠ I/O register: may fight the hardware itself');
  } else {
    // Encrypted AR/GS + CodeBreaker: the value's meaning depends on the code
    // type byte, so describe the shape and the most common intents.
    what.push(`mGBA applies this code (operands ${hx(entry.address, 8)} ${entry.format === 'ar' ? hx(v, 8) : hx(v, 4)})`);
    if (v === 0x63 || v === 0x0063) what.push('value 99 (classic max-count code)');
    if (v === 0xFF || v === 0x00FF) what.push('value 255 (often max)');
  }
  return what.join('; ');
}

// Serialize a validated GBA cheat list into mGBA's .cheats file format
// (mCheatParseFile: "# Name" opens a named set, "!disabled" before a set
// disables it, bare lines join the current set). One set per cheat keeps
// toggling exact: a disabled set is never applied by the core.
function gbaCheatsFile(cheats) {
  const blocks = [];
  for (const c of cheats || []) {
    if (!c || typeof c.code !== 'string' || !parseGbaCheatLine(c.code)) continue;
    blocks.push(`${c.enabled === false ? '!disabled\n' : ''}# cheat\n${c.code.trim().toUpperCase()}`);
  }
  return blocks.join('\n');
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

// ---- GBA cheat list (mGBA-backed) -----------------------------------------
// Mirrors CheatEngine's list surface (add/toggle/remove/clear/all/serialize/
// restore) but validates GBA code formats and never touches memory: applying
// happens inside mGBA via the synced .cheats file. Kept GB-independent so the
// two engines never share validation (a GB GameShark code is meaningless on
// GBA and vice versa).
class GbaCheatList {
  constructor() { this.codes = []; } // { code, format, address, value, enabled }

  add(raw) {
    const text = String(raw).trim().toUpperCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
    const parsed = parseGbaCheatLine(text);
    if (!parsed) {
      return { error: 'Not a valid GBA cheat code (GameShark/Pro Action Replay XXXXXXXX XXXXXXXX, CodeBreaker XXXXXXXX XXXX, or VBA XXXXXXXX:YY)' };
    }
    const entry = { code: text, enabled: true, ...parsed };
    this.codes.push(entry);
    return entry;
  }

  remove(index) { if (index >= 0 && index < this.codes.length) this.codes.splice(index, 1); }

  toggle(index) { const c = this.codes[index]; if (c) c.enabled = !c.enabled; }

  clear() { this.codes.length = 0; }

  all() { return this.codes.slice(); }

  serialize() { return this.codes.map((c) => ({ code: c.code, enabled: c.enabled })); }

  restore(list) {
    this.clear();
    for (const c of list || []) {
      if (!c || typeof c.code !== 'string') continue;
      const parsed = parseGbaCheatLine(c.code);
      if (parsed) this.codes.push({ code: c.code.trim().toUpperCase(), enabled: !!c.enabled, ...parsed });
    }
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

// Describe what a cheat does, in plain language. Pure function of the parsed
// code: what memory region it touches, whether it continuously overwrites RAM
// (GameShark) or patches ROM (Game Genie), and what a write of that value at
// that address plausibly means. The UI shows this under every code so a typo
// (or a code from the wrong game) is visible before it mangles a save.
function describeCheat(entry) {
  const region = (a) => {
    if (a < 0x8000) return 'ROM (Game Genie patch)';
    if (a < 0xA000) return 'VRAM (graphics)';
    if (a < 0xC000) return 'cartridge RAM (S-RAM)';
    if (a < 0xFE00) return 'work RAM';
    if (a < 0xFEA0) return 'OAM (sprite table)';
    if (a < 0xFF00) return 'unusable memory';
    if (a < 0xFF80) return 'hardware I/O';
    if (a < 0xFFFF) return 'high RAM';
    return 'interrupt enable';
  };
  const hx = (v, w) => v.toString(16).toUpperCase().padStart(w, '0');
  const what = [];
  if (entry.kind === 'gs') {
    const a = entry.addr, v = entry.value;
    what.push(`writes ${hx(v, 2)} (${v}) to ${region(a)} at $${hx(a, 4)} every frame`);
    if (v === 0x00) what.push('pins the value to zero');
    else if (v === 0x01) what.push('forces a value of 1 (often a counter/flag)');
    else if (v === 0x09) what.push('forces 9 (classic infinite-lives-style freeze)');
    else if (v === 0x63) what.push('forces 99 (classic max-count freeze)');
    else if (v === 0xFF) what.push('pins the value to 255/0xFF (often max, sometimes a mask)');
    if (a >= 0xC000 && a < 0xFE00 && v >= 0x30 && v <= 0x39) what.push('ASCII digit — may set a name/score character');
    if (a >= 0xFF00 && a < 0xFF80) what.push('⚠ I/O register: may fight the hardware itself');
    return what.join('; ');
  }
  // Game Genie: ROM patch — value replaces the byte at addr when compare matches.
  const v = entry.value, a = entry.addr;
  what.push(`replaces the ROM byte at $${hx(a, 4)} with ${hx(v, 2)}`);
  what.push(entry.compare !== null
    ? `only when the original byte is ${hx(entry.compare, 2)} (checked on every read)`
    : 'unconditionally (no compare) — affects every bank mapped there');
  if (a < 0x0100) what.push('⚠ inside the boot-ROM vector area — likely breaks startup');
  if (a >= 0x0048 && a <= 0x004F) what.push('⚠ interrupt vector region');
  return what.join('; ');
}

if (typeof module !== 'undefined') module.exports = { CheatEngine, GbaCheatList, parseGameShark, parseGameGenie, parseGbaCheatLine, gbaCheatsFile, describeGbaCheat, CheatFinder, gsFreezeCode, describeCheat };
if (typeof window !== 'undefined') window.PocketCheat = { CheatEngine, GbaCheatList, parseGameShark, parseGameGenie, parseGbaCheatLine, gbaCheatsFile, describeGbaCheat, CheatFinder, gsFreezeCode, describeCheat };
