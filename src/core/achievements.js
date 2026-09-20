// PocketGB — RetroAchievements client + runtime
//
// Achievements on RetroAchievements are logic over emulated memory. Each
// achievement's MemAddr string (e.g. "0xH001b3b=1_0xH001b4e>=99") is a tiny
// condition expression the runtime evaluates every frame; when all conditions
// of a group hit, the achievement is earned. This module:
//   1. logs in (dorequest.php r=login2) with username + web API token
//   2. identifies the loaded ROM by RA hash (r=patch&m=<hash>)
//   3. downloads the achievement set and compiles each MemAddr
//   4. evaluates every frame; on hit, posts the unlock (r=awardachievement)
//
// The condition language (subset implemented — covers the vast majority of
// sets): Core group `d0xH1234=5`, alt groups `..._SxT...` (AND-of-ORs),
// memrefs 0xH/W/D (1/2/4 bytes), 0m/0n BCD nibbles, comparisons = != < <= > >=,
// modifiers * / & | ^ + - with decimal or hex (0x) operands, and condition
// prefixes b (and-next), c (or-next) plus the standard alt-group separator.
'use strict';

const RA_HOST = 'https://retroachievements.org';

// ---- RA hash: the first 0x1FFFD0 bytes of the ROM as lowercase MD5 ----
function md5hex(u8) {
  // Node: native. Browser (preload/main only use this in Node): fallback none.
  const crypto = (typeof require !== 'undefined') ? require('crypto') : null;
  if (crypto && crypto.createHash) {
    return crypto.createHash('md5').update(Buffer.from(u8)).digest('hex');
  }
  throw new Error('md5 unavailable');
}
function raHash(rom) {
  const N = Math.min(rom.length, 0x1FFFD0);
  const slice = rom.subarray ? rom.subarray(0, N) : rom.slice(0, N);
  return md5hex(slice);
}

// ---- condition parsing ----
// One condition: { size, addr, op, val, flags, type } — type:
//   'std'  compare/modify chain;  'andnext' (b) / 'ornext' (c) prefixes.
const OPS = ['<=', '>=', '!=', '=', '<', '>'];
const MEMPREFIX = { H: 1, W: 2, D: 4 };

function parseMemref(s) {
  // d0xH001b3b / 0xH001b3b / 0m001b3 / p0xH...
  let i = 0;
  // optional unary/pointer prefixes we treat as a passthrough delta/multiplier
  let unary = null;
  while (i < s.length && 'dpm!~'.includes(s[i])) {
    unary = s[i];
    i++;
    if (s[i] === '0' && i + 1 < s.length && 'xmpn'.includes(s[i + 1]) === false) { /* keep */ }
  }
  if (s.startsWith('0x', i)) i += 2;
  const sizeCh = s[i];
  const size = MEMPREFIX[sizeCh];
  if (!size) return null;
  i++;
  const numMatch = /^[0-9a-fA-F]+/.exec(s.slice(i));
  if (!numMatch) return null;
  const addr = parseInt(numMatch[0], 16);
  return { size, addr, unary };
}

function parseValueOperand(s) {
  // A value operand is a memref or a number, each optionally followed by a
  // modifier ("*2", "+5", "&0x0f"…). Memrefs are distinctive (0x + size char,
  // or a d/p prefix, or 0m/0n) — try them first; whatever remains is numeric.
  const trimmed = s.trim();
  const head = trimmed.split(/[*/&|^+-]/)[0].trim();
  const mem = parseMemref(head);
  if (mem) {
    const rest = trimmed.slice(trimmed.split(/[*/&|^+-]/)[0].length).replace(/\s+/g, '');
    return { kind: 'mem', mem, op2: rest || null };
  }
  const numPart = /^(0x[0-9a-fA-F]+|\d+)/.exec(trimmed);
  if (!numPart) return null;
  const v = numPart[1].startsWith('0x') ? parseInt(numPart[1], 16) : parseInt(numPart[1], 10);
  const rest = trimmed.slice(numPart[1].length).replace(/\s+/g, '');
  return { kind: 'num', value: v, op2: rest || null };
}

// Compile a full MemAddr definition into groups of conditions.
// Scanner semantics (matching rcheevos): '_' ends a condition; 'S' ends a
// condition AND starts a new alt group (S can never appear inside a condition:
// it's not a hex digit or a memref prefix). Returns { groups } — groups[0] is
// the core AND-chain, the rest are OR branches (each fully ANDed).
function compileMemAddr(str) {
  const groups = [[]];
  let buf = '';
  const addCondition = (group, text) => {
    const c = text.trim();
    if (!c) return;
    let flags = { andNext: false, orNext: false };
    let body = c;
    // prefixes: b = and-next, c = or-next (never a leading hex digit)
    while (body.length > 1 && 'bc'.includes(body[0]) && !/^[0-9]/.test(body)) {
      if (body[0] === 'b') { flags.andNext = true; body = body.slice(1); }
      else { flags.orNext = true; body = body.slice(1); }
    }
    // split into left, comparison op, right (the LAST op in the string is the
    // comparison; anything inside operands was consumed by the operand parser)
    let op = null, left = body, right = null;
    for (const o of OPS) {
      const idx = body.lastIndexOf(o);
      if (idx > 0) { op = o; left = body.slice(0, idx); right = body.slice(idx + o.length); break; }
    }
    if (!op) {
      // bare memref: truthy when nonzero (rare but legal)
      const mem = parseMemref(body);
      if (!mem) return;
      group.push({ kind: 'mem', mem, op: '!=', val: { kind: 'num', value: 0, op2: null }, ...flags });
      return;
    }
    // parseValueOperand covers both pure memrefs and memref+modifier forms
    const l = parseValueOperand(left.trim());
    if (!l) return;
    const r = parseValueOperand(right.trim());
    if (!r) return;
    group.push({ ...l, op, val: r, ...flags });
  };
  const flush = () => { addCondition(groups[groups.length - 1], buf); buf = ''; };
  for (const ch of String(str)) {
    if (ch === '_') { flush(); continue; }
    if (ch === 'S') { flush(); groups.push([]); continue; }
    buf += ch;
  }
  flush();
  return { groups };
}

// ---- evaluation ----
function readMem(mm, size, addr) {
  let v = 0;
  // always through the MMU (banking + echo + HRAM); addresses outside RAM
  // simply read whatever the bus gives, same as rcheevos
  const b0 = mm.read(addr & 0xFFFF) & 0xFF;
  if (size === 1) return b0;
  const b1 = mm.read((addr + 1) & 0xFFFF) & 0xFF;
  v = b0 | (b1 << 8);
  if (size === 2) return v;
  const b2 = mm.read((addr + 2) & 0xFFFF) & 0xFF;
  const b3 = mm.read((addr + 3) & 0xFFFF) & 0xFF;
  return (v | (b2 << 16) | (b3 << 24)) >>> 0;
}

function evalOperand(opnd, mm) {
  if (opnd.kind === 'num') {
    let v = opnd.value;
    if (opnd.op2) v = applyOp2(v, opnd.op2);
    return v;
  }
  let v = readMem(mm, opnd.mem.size, opnd.mem.addr);
  if (opnd.mem.unary === 'd') { /* delta: needs prev-frame snapshot; treated as current (see runtime) */ }
  if (opnd.op2) v = applyOp2(v, opnd.op2);
  return v;
}
function applyOp2(v, spec) {
  const m = /^([*/&|^+-])(0x[0-9a-fA-F]+|\d+)$/.exec(spec);
  if (!m) return v;
  const n = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
  switch (m[1]) {
    case '*': return v * n;
    case '/': return n ? Math.floor(v / n) : 0;
    case '&': return v & n;
    case '|': return v | n;
    case '^': return v ^ n;
    case '+': return v + n;
    case '-': return v - n;
    default: return v;
  }
}

function evalCondition(cond, mm) {
  const l = evalOperand(cond, mm);
  const r = evalOperand(cond.val, mm);
  switch (cond.op) {
    case '=': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
    default: return false;
  }
}

// Evaluate a compiled set. Core group: all conditions (b/c prefixes break the
// AND chain — andNext: condition passes only if the NEXT one also passes).
// Alt groups: at least one full AND-chain must pass.
function evalGroups(compiled, mm) {
  const groups = compiled.groups;
  const core = groups[0];
  if (core.length) {
    for (let i = 0; i < core.length; i++) {
      const c = core[i];
      if (!evalCondition(c, mm)) return false;
      if (c.andNext && i + 1 < core.length && !evalCondition(core[i + 1], mm)) return false;
    }
  }
  for (let gi = 1; gi < groups.length; gi++) {
    const g = groups[gi];
    if (!g.length) continue;
    let hit = true;
    for (const c of g) if (!evalCondition(c, mm)) { hit = false; break; }
    if (hit) return true;
  }
  return groups.length === 1; // no alts: core alone decides
}

// ---- client (dorequest.php) ----
// The dorequest API is POST x-www-form-urlencoded (rcheevos posts it).
// awardachievement carries an MD5 signature: md5(achId + username + hardcore).
class RAClient {
  constructor({ username, token, host = RA_HOST, fetchImpl } = {}) {
    this.username = username;
    this.token = token;
    this.host = host.replace(/\/$/, '');
    this._fetch = fetchImpl || fetch;
    if (!this._fetch) throw new Error('fetch unavailable in this runtime');
  }

  async _post(params) {
    const body = new URLSearchParams(params).toString();
    const res = await this._fetch(`${this.host}/dorequest.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`RA HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.Error) throw new Error(json.Error);
    return json;
  }

  async login() {
    const j = await this._post({ r: 'login2', u: this.username, t: this.token });
    if (!j.Success !== false && j.Token) { /* rcheevos: Success true + Token */ }
    if (!j.Token) throw new Error(j.Error || 'login failed');
    this.token = j.Token; // server may refresh the token
    return { user: j.User || this.username, token: j.Token, score: j.Score | 0, softcore: j.SoftcoreScore | 0 };
  }

  async fetchGame(hash) {
    const j = await this._post({ r: 'patch', u: this.username, t: this.token, m: hash });
    const pd = j.PatchData;
    if (!pd) throw new Error('no PatchData for this hash');
    return {
      id: pd.ID,
      title: pd.Title,
      consoleId: pd.ConsoleID,
      achievements: (pd.Achievements || [])
        .filter((a) => a.Flags === 3) // 3 = core set (unofficial sets are 5)
        .map((a) => ({
          id: a.ID, title: a.Title, description: a.Description, points: a.Points,
          mem: a.MemAddr, badge: a.BadgeName,
        })),
    };
  }

  // md5(achId + username + hardcore(1|0)) — the v= parameter
  static awardSignature(achId, username, hardcore) {
    return md5hex(`${achId}${username}${hardcore ? 1 : 0}`);
  }

  async award(achId, { hardcore, gameHash } = {}) {
    const j = await this._post({
      r: 'awardachievement', u: this.username, t: this.token,
      a: achId, h: hardcore ? 1 : 0, m: gameHash || '',
      v: RAClient.awardSignature(achId, this.username, !!hardcore),
    });
    return { success: !!j.Success, error: j.Error || null };
  }

  async ping(gameId, gameHash, hardcore) {
    return this._post({ r: 'startsession', u: this.username, t: this.token, g: gameId, h: hardcore ? 1 : 0, m: gameHash || '' });
  }
}

// ---- runtime: per-frame evaluator wired to the live machine ----
class AchievementRuntime {
  constructor(client) {
    this.client = client;
    this.game = null;      // { id, title, achievements[] }
    this.hash = null;
    this.hardcore = false;
    this.enabled = false;
    this.state = new Map(); // achId -> { compiled, hit }
    this.pendingAwards = []; // { id } queue (posted from the app, serialized)
    this.listeners = [];   // (ach) => void — UI toast
  }

  onUnlock(cb) { this.listeners.push(cb); }

  // Returns error string or null. Compiles the set for the running ROM.
  async identify(machine, romBytes) {
    this.game = null;
    this.state.clear();
    this.enabled = false;
    if (!this.client) return 'not logged in';
    let hash;
    try { hash = raHash(romBytes); } catch (e) { return e.message; }
    let game;
    try { game = await this.client.fetchGame(hash); }
    catch (e) { return e.message; }
    this.hash = hash;
    this.game = game;
    for (const a of game.achievements) {
      let compiled;
      try { compiled = compileMemAddr(a.mem); } catch { continue; }
      this.state.set(a.id, { ach: a, compiled, hit: false });
    }
    this.enabled = true;
    try { await this.client.ping(game.id, hash, this.hardcore); } catch { /* offline play: keep evaluating */ }
    return null;
  }

  reset() { for (const s of this.state.values()) s.hit = false; this.pendingAwards.length = 0; }

  // Load a set identified in the MAIN process (ra-session IPC → {hash, game}).
  // The renderer never talks to the network itself (COEP), so identify() via
  // this.client is only used in Node/tests; the app uses this path.
  loadFromSession(hash, game, hardcore) {
    this.hash = hash;
    this.game = game;
    this.hardcore = !!hardcore;
    this.state.clear();
    for (const a of (game && game.achievements) || []) {
      let compiled;
      try { compiled = compileMemAddr(a.mem); } catch { continue; }
      this.state.set(a.id, { ach: a, compiled, hit: false });
    }
    this.enabled = this.state.size > 0;
  }

  // Once per frame from the app loop. m: machine with .mmu.
  frame(m) {
    if (!this.enabled || !this.game || !m || !m.mmu) return;
    for (const s of this.state.values()) {
      if (s.hit) continue;
      let hit = false;
      try { hit = evalGroups(s.compiled, m.mmu); } catch { continue; }
      if (hit) {
        s.hit = true;
        this.pendingAwards.push({ id: s.ach.id });
        for (const l of this.listeners) { try { l(s.ach); } catch { /* UI must not break emulation */ } }
      }
    }
  }
}

if (typeof module !== 'undefined') module.exports = {
  RAClient, AchievementRuntime, compileMemAddr, evalGroups, parseMemref, raHash,
  evalCondition, readMem, parseValueOperand,
};
if (typeof window !== 'undefined') window.PocketRA = { AchievementRuntime, compileMemAddr, evalGroups, RAClient };
