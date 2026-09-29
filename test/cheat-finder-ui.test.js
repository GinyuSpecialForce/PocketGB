'use strict';
// Headless tests for the cheat-finder panel controller (src/ui/cheat-finder.js).
// The panel is exercised the way app.js wires it — real CheatFinder/GBA cheat
// engine underneath, synthetic DOM, save states built like the real mGBA PNG
// (same builder idea as cheatfinder-snapshot.test.js) — so the freshness
// engine, freeze promotion, watch dedupe, and input handling are all verified
// without Electron.
const { test } = require('node:test');
const assert = require('node:assert');
const { CheatFinderPanel, GBA_SCAN_ADDRS, GBA_SCAN_RANGES, GBA_SCAN_TOTAL } = require('../src/ui/cheat-finder');
const { CheatFinder, CheatEngine, GbaCheatList, parseGbaCheatLine } = require('../src/core/cheats');
const { decodeState, LAYOUT } = require('../src/core/mgba-state');
const zlib = require('node:zlib');

// ---- synthetic mGBA state PNG with a controllable EWRAM/IWRAM byte ---------
// Built synchronously: the real MgbaMachine.saveState() returns PNG bytes
// sync (app.js and the panel read them without await), so the fake must too.
const MARK = 0x02000100;   // EWRAM bus address → payload ewram.at + 0x100
const IWRAM_MARK = 0x03000020;
function makeStatePng(ewByte) {
  const payload = new Uint8Array(LAYOUT.total);
  payload[LAYOUT.ewram.at + 0x100] = ewByte;
  payload[LAYOUT.iwram.at + 0x20] = 0x77; // constant IWRAM byte
  const zip = zlib.deflateSync(payload);
  const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const mk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const n = data.length;
    out[0] = (n >>> 24) & 255; out[1] = (n >>> 16) & 255; out[2] = (n >>> 8) & 255; out[3] = n & 255;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  };
  const ihdr = mk('IHDR', new Uint8Array(13));
  const gbAs = mk('gbAs', new Uint8Array(zip));
  const iend = mk('IEND', new Uint8Array(0));
  const png = new Uint8Array(8 + ihdr.length + gbAs.length + iend.length);
  png.set(sig, 0); let o = 8;
  for (const c of [ihdr, gbAs, iend]) { png.set(c, o); o += c.length; }
  return png;
}

// ---- synthetic app environment ---------------------------------------------
// A tree-aware DOM stand-in: textContent assignment clears children like the
// real DOM, appendChild/insertBefore maintain parent links, and inserted nodes
// register by id for getElementById. This lets the render paths execute for
// real in headless tests (a stub-only DOM silently skipped them once).
function makeDom() {
  const byId = {};
  function el(tag, id) {
    const classes = new Set(id === 'ov-finder' ? ['open'] : []);
    const e = {
      tag, id: id || '', value: '', style: {}, dataset: {},
      classes, listeners: {}, children: [], parentElement: null, _text: '',
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => { if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); } else if (on) classes.add(c); else classes.delete(c); },
      },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      click() { for (const fn of this.listeners.click || []) fn(); },
      appendChild(c) { c.parentElement = e; e.children.push(c); if (c.id) byId[c.id] = c; return c; },
      insertBefore(c, ref) {
        c.parentElement = e;
        const i = e.children.indexOf(ref);
        if (i >= 0) e.children.splice(i, 0, c); else e.children.push(c);
        if (c.id) byId[c.id] = c; // ids may be assigned after creation (like the watch box)
        return c;
      },
      remove() {
        if (e.parentElement) e.parentElement.children = e.parentElement.children.filter((x) => x !== e);
        if (e.id && byId[e.id] === e) delete byId[e.id];
      },
      get textContent() { return e._text + e.children.map((c) => c.textContent).join(''); },
      set textContent(v) { e._text = String(v); e.children = []; },
    };
    if (id) byId[id] = e;
    return e;
  }
  const root = el('root');
  return {
    _byId: byId,
    root,
    el,
    // Mounted ids (the ones app.js's $ hands the panel) live under a root so
    // parentElement exists — renderWatches inserts the watch box before the list.
    mount: (e) => root.appendChild(e),
    document: {
      createElement: (t) => el(t),
      getElementById: (id) => byId[id] || null,
      querySelectorAll: () => [], // in-place repaint spans: empty is a no-op
    },
  };
}

// A fake GBA machine with a mutable EWRAM byte, a monotonic state clock, and
// saveState() producing a real decodable state PNG.
function fakeGba() {
  return {
    _ewByte: 10,
    _stamp: 0,
    _saves: 0,
    _frozen: new Map(),
    saveState() { this._saves++; this._stamp++; return makeStatePng(this._ewByte); },
    stateStamp() { return this._stamp; },
    freezeRam(addr, v) { this._frozen.set(addr, v); },
    readMemory(addr) { return addr === MARK ? this._ewByte : 0x77; },
  };
}

// The app singleton stand-in: GBA-capable, snapshot mode (no memory access).
function fakeGb(machine) {
  return {
    isGba: true,
    hasMemoryAccess: false,
    _gba: machine,
    mmu: { read() { return 0xFF; } },
    cheats: new GbaCheatList(),
  };
}

// Wire a panel exactly like app.js does, plus handles on the test side. The
// fake document is installed globally so renderList/renderWatches run their
// real DOM branches (and torn down by the next makePanel).
function makePanel({ gb, machine, now }) {
  const dom = makeDom();
  global.document = dom.document;
  const els = {};
  const $ = (id) => { if (!els[id]) { els[id] = dom.el('div', id); dom.mount(els[id]); } return els[id]; };
  const status = [];
  const applied = [];
  const deps = {
    gb, $,
    setStatus: (s) => status.push(s),
    persistCheats: () => { gb.persisted = gb.cheats.serialize(); },
    renderCheatList: () => {},
    applyGbaCheats: () => applied.push(gb.cheats.serialize()),
    toggleOverlay: () => {},
    CheatFinder,
    parseGbaCheatLine,
    decodeState,
    romLoaded: () => true,
  };
  if (now) deps.now = now;
  const panel = new CheatFinderPanel(deps);
  panel.retarget();
  return { panel, $, els, dom, status, applied };
}

function textOf(els, id) {
  const el = els[id];
  return el ? String(el.textContent) : '';
}

// Poll until a condition holds (the background refresh decodes a state async;
// fixed sleeps race when the suite runs files in parallel).
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  return fn();
}



// ---- address set ------------------------------------------------------------
test('GBA scan address set: one typed array from one range table', () => {
  assert.strictEqual(GBA_SCAN_TOTAL, (0x02040000 - 0x02000000) + (0x03008000 - 0x03000000));
  assert.ok(GBA_SCAN_ADDRS instanceof Uint32Array);
  assert.strictEqual(GBA_SCAN_ADDRS.length, GBA_SCAN_TOTAL);
  assert.strictEqual(GBA_SCAN_ADDRS[0], 0x02000000);
  assert.strictEqual(GBA_SCAN_ADDRS[0x40000], 0x03000000, 'IWRAM follows EWRAM');
  assert.strictEqual(GBA_SCAN_ADDRS[GBA_SCAN_ADDRS.length - 1], 0x03007FFF);
  // ranges and typed array agree — the two representations cannot drift
  let i = 0;
  for (const [lo, hi] of GBA_SCAN_RANGES) for (let a = lo; a < hi; a++) assert.strictEqual(GBA_SCAN_ADDRS[i++], a);
});

// ---- freshness engine ---------------------------------------------------------
test('freshness: io refresh gated by cadence, one save in flight, forced by freeze', async () => {
  let t = 1000;
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel } = makePanel({ gb, machine, now: () => t });
  await panel.runStep(() => panel.finder.search(10), (n) => `search: ${n}`);
  const savesAfterScan = machine._saves;
  // tick immediately: cadence gate holds (last refresh was just now)
  panel.tick();
  await new Promise((r) => setTimeout(r, 5)); // let any scheduled io settle
  assert.strictEqual(machine._saves, savesAfterScan, 'no refresh within the cadence window');
  // advance past refreshMs: the tick schedules exactly one background refresh
  t += 2000;
  panel.tick();
  assert.strictEqual(machine._saves, savesAfterScan + 1, 'one fresh state per cadence window');
  // ioBusy gate: a second schedule while the first save is in flight is a no-op
  panel._scheduleIo(true);
  assert.strictEqual(machine._saves, savesAfterScan + 1, 'never two saves in flight');
  // cadence gate: a tick inside the window is also a no-op
  panel.tick();
  await until(() => !panel._ioBusy);
  assert.strictEqual(machine._saves, savesAfterScan + 1);
});

test('freshness: candidate rows mark staleness; watch rows carry the freeze verdict', async () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel } = makePanel({ gb, machine });
  await panel.runStep(() => panel.finder.search(10), (n) => `search: ${n}`);
  // The scan photographed the state at stamp N. Candidate row: fresh now.
  const fresh = panel.rowText(MARK, 10, false);
  assert.ok(fresh.includes('$02000100 = 0a (10)'), `candidate row format: ${fresh}`);
  assert.ok(!fresh.includes('stale'), 'fresh scan is not stale');
  // Age the machine clock behind its back (the photograph is now old)…
  machine._stamp++;
  assert.ok(panel.rowText(MARK, 10, false).includes('(stale)'), 'aged candidate row is marked stale');
  // …and a watch row on a frozen address reports the hold.
  panel._onFreezeClick(MARK, null);
  const code = gb.cheats.all()[0];
  assert.ok(code, 'freeze promoted a cheat into the GBA list');
  assert.strictEqual(code.format, 'vba');
  assert.strictEqual(code.address >>> 0, MARK);
  assert.strictEqual(code.value, 10);
  assert.deepStrictEqual(gb.persisted, gb.cheats.serialize(), 'freeze persists the list');
  assert.strictEqual(panel.finder.watches.length, 1, 'freeze auto-watches');
  // The freeze's forced refresh settles: the panel has re-photographed the
  // machine, so staleness clears and the stamp matches again.
  await until(() => !panel._ioBusy);
  assert.strictEqual(panel._stateStamp, machine._stamp, 'forced refresh re-photographed the machine');
  assert.ok(!panel.rowText(MARK, 10, false).includes('stale'), 'refresh clears staleness');
  // Watch-row verdicts (rowText formats the value it is handed): holding at
  // the frozen value, NOT holding once the game changes the byte.
  const line = panel.rowText(MARK, 10, true);
  assert.ok(line.includes('freeze holding'), `expected holding verdict, got: ${line}`);
  const line2 = panel.rowText(MARK, 42, true);
  assert.ok(line2.includes('freeze NOT holding (wants 10)'), `expected NOT holding, got: ${line2}`);
});

test('freeze forces a fresh state so the hold is verified immediately', async () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel } = makePanel({ gb, machine });
  await panel.runStep(() => panel.finder.search(10), () => 'ok');
  const savesBefore = machine._saves;
  panel._onFreezeClick(MARK, null);
  await until(() => !panel._ioBusy);
  assert.ok(machine._saves > savesBefore, 'freeze forces a refresh to verify the hold');
});

// ---- watch-row dedupe -------------------------------------------------------
test('watch rows: deduped in snapshot mode while addresses are unchanged, never in live mode', () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel } = makePanel({ gb, machine });
  panel.finder.watches.push({ addr: MARK });
  assert.strictEqual(panel._lastWatchKey, '', 'no dedupe key before the first render');
  panel.renderWatches();
  assert.strictEqual(panel._lastWatchKey, String(MARK));
  panel.renderWatches(); // same key again → skipped (the 250ms race guard)
  assert.strictEqual(panel._lastWatchKey, String(MARK));
  panel.finder.watches.push({ addr: IWRAM_MARK });
  panel.renderWatches();
  assert.strictEqual(panel._lastWatchKey, `${MARK},${IWRAM_MARK}`, 'address change rebuilds');
  // live mode / GB: never deduped (the rebuild IS the value poll)
  panel.finder.snapshotMode = false;
  panel.renderWatches();
  assert.strictEqual(panel._lastWatchKey, '');
});

test('renderList real-DOM path: rows carry the shared row text, capped at 200 + a more hint', async () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, dom } = makePanel({ gb, machine });
  await panel.runStep(() => panel.finder.search(null), () => 'ok'); // 294912 candidates
  const list = dom._byId['finder-list'];
  assert.strictEqual(list.children.length, 201, '200 rows + the more hint');
  const first = list.children[0];
  assert.strictEqual(first.className, 'finder-row');
  const span = first.children[0];
  assert.strictEqual(span.dataset.addr, '2000000', 'rows scan in address order');
  assert.strictEqual(span.textContent, '$02000000 = 00 (0)', 'candidate rows use the shared row text');
  assert.strictEqual(list.children[200].textContent, '…and 294712 more — narrow further');
  // empty candidates → message instead of rows
  panel.finder.candidates = new Map();
  panel.renderList();
  assert.strictEqual(list.textContent, 'no candidates — reset and try again');
});

test('renderWatches real-DOM path: creates the watch box once, inserts rows, removes it when empty', () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, dom } = makePanel({ gb, machine });
  panel.finder.watches.push({ addr: MARK });
  panel.renderWatches();
  const box = dom._byId['finder-watches'];
  assert.ok(box, 'watch box created on first render');
  assert.strictEqual(box.children.length, 1, 'one watch row inserted');
  assert.strictEqual(box.children[0].children[0].dataset.addr, MARK.toString(16), 'row carries the address');
  // snapshot mode: same address set → render skipped (no churn)
  panel.renderWatches();
  assert.strictEqual(dom._byId['finder-watches'], box, 'same box, no rebuild');
  assert.strictEqual(box.children.length, 1);
  // empty watches → box removed from the document
  panel.finder.watches = [];
  panel.renderWatches();
  assert.strictEqual(dom.document.getElementById('finder-watches'), null, 'watch box removed when empty');
});

// ---- freeze promotion details ------------------------------------------------
test('freeze: duplicate promotion adds no core reload and no duplicate code', () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, applied } = makePanel({ gb, machine });
  panel._onFreezeClick(MARK, null);
  const first = applied.length;
  assert.ok(first >= 1, 'applyGbaCheats ran for a new freeze');
  panel._onFreezeClick(MARK, null); // same code again → duplicate
  assert.strictEqual(applied.length, first, 'a duplicate needs no core reload');
  assert.strictEqual(gb.cheats.all().length, 1, 'no duplicate code stacked');
});

test('freeze on a memory-capable machine rides freezeRam; GB path adds a GameShark code', () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  gb.hasMemoryAccess = true; // live mode
  const { panel } = makePanel({ gb, machine });
  panel._onFreezeClick(MARK, null);
  assert.strictEqual(machine._frozen.get(MARK), 10, 'live freeze went through the machine');
  assert.strictEqual(gb.cheats.all().length, 0, 'no code added in live mode');

  // GB path: not GBA → freeze into the cheat engine as a GameShark code
  const gbOnly = fakeGb(machine);
  gbOnly.isGba = false;
  gbOnly.cheats = new CheatEngine();
  gbOnly.mmu = { read: (a) => (a === 0xC100 ? 63 : 0) };
  const p2 = new CheatFinderPanel({
    gb: gbOnly, $: () => null, setStatus: () => {}, persistCheats: () => {}, renderCheatList: () => {},
    applyGbaCheats: () => {}, toggleOverlay: () => {}, CheatFinder, parseGbaCheatLine, decodeState,
    romLoaded: () => true,
  });
  p2._onFreezeClick(0xC100, null);
  const added = gbOnly.cheats.all()[0];
  assert.ok(added && added.code === '013F00C1', `expected GameShark freeze code, got ${added && added.code}`);
});

// ---- value parsing -----------------------------------------------------------
test('parseValue: hex, decimal, empty vs malformed', () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel } = makePanel({ gb, machine });
  assert.strictEqual(panel.parseValue(''), null);
  assert.strictEqual(panel.parseValue('   '), null);
  assert.strictEqual(panel.parseValue('0x63'), 99);
  assert.strictEqual(panel.parseValue('63'), 99, 'bare 1-2 digit tokens are hex (the Emerald flow types 63 meaning 0x63)');
  assert.strictEqual(panel.parseValue('ff'), 255, 'hex letters');
  assert.strictEqual(panel.parseValue('100'), 100, '3-digit tokens are decimal');
  assert.strictEqual(panel.parseValue('255'), 255);
  // parseValue does not range-check (256 is a fine number); the handlers gate
  // the 0-255 window before scanning — covered in the input-handling tests.
  assert.strictEqual(panel.parseValue('256'), 256);
  assert.ok(Number.isNaN(panel.parseValue('zzz')), 'garbage is malformed');
});

// ---- availability gates -------------------------------------------------------
test('available(): snapshot GBA passes; a GBA with no surface explains itself; GB without a game is refused', () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, status } = makePanel({ gb, machine });
  assert.strictEqual(panel.available(), true, 'snapshot mode is available');

  const noSurfaceGb = fakeGb(machine);
  const { panel: p2, status: st2 } = makePanel({ gb: noSurfaceGb, machine });
  p2.deps.decodeState = null;
  assert.strictEqual(p2.available(), false);
  assert.ok(st2[st2.length - 1].includes('needs GBA memory access'), st2.join('|'));

  const gbOk = fakeGb(machine);
  gbOk.isGba = false; gbOk.hasMemoryAccess = true;
  const { panel: p3 } = makePanel({ gb: gbOk, machine });
  assert.strictEqual(p3.available(), true);

  const gbNo = fakeGb(machine);
  gbNo.isGba = false; gbNo.hasMemoryAccess = false;
  const { panel: p4, status: st4 } = makePanel({ gb: gbNo, machine });
  assert.strictEqual(p4.available(), false);
  assert.strictEqual(st4[st4.length - 1], 'load a game first');
});

// ---- runStep serialization + error surface ------------------------------------
test('runStep: errors land in the panel, busy flag released, status formatted via callback', async () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, els, status } = makePanel({ gb, machine });
  await panel.runStep(() => { throw new Error('no state yet'); }, () => 'never');
  assert.ok(textOf(els, 'finder-err').includes('finder: no state yet'), textOf(els, 'finder-err'));
  assert.strictEqual(panel._scanBusy, false, 'busy released after failure');
  await panel.runStep(async () => 1234, (n) => `found ${n} candidates`);
  assert.ok(status.includes('found 1234 candidates'), status.join('|'));
  assert.strictEqual(textOf(els, 'finder-err'), '', 'error cleared by a successful step');
});

// ---- input handling -------------------------------------------------------------
test('search with empty input = unknown init; malformed input reports in the panel', async () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, els, status } = makePanel({ gb, machine });
  panel._$('finder-input').value = '';
  await panel._onSearch();
  assert.ok(status.some((s) => s.includes('unknown init')), status.join('|'));
  assert.ok(panel.finder.candidates.size > 1000, 'unknown init takes the whole map');
  panel._$('finder-input').value = 'zzz';
  await panel._onSearch();
  assert.ok(textOf(els, 'finder-err').includes('enter 0-255'), textOf(els, 'finder-err'));
  panel._$('finder-input').value = '0a'; // hex 10 — MARK's byte
  await panel._onSearch();
  assert.strictEqual(panel.finder.candidates.size, 1);
  await until(() => !panel._ioBusy); // any freeze-side refresh must settle before teardown
});

test('narrow: changed/unchanged skip the value field; value filters validate first', async () => {
  const machine = fakeGba();
  const gb = fakeGb(machine);
  const { panel, els } = makePanel({ gb, machine });
  await panel.runStep(() => panel.finder.search(null), () => 'ok');
  assert.ok(panel.finder.candidates.size > 1000);
  panel._$('finder-op').value = 'changed';
  await panel._onApply();
  assert.strictEqual(panel.finder.candidates.size, 0, 'nothing changed between identical states');
  panel._$('finder-op').value = 'eq';
  panel._$('finder-narrow-val').value = 'zzz';
  await panel._onApply();
  assert.ok(textOf(els, 'finder-err').includes('enter 0-255'), textOf(els, 'finder-err'));
  panel._$('finder-narrow-val').value = '0a';
  await panel.runStep(() => panel.finder.search(10), () => 'ok');
  panel._$('finder-narrow-val').value = '0a';
  await panel._onApply();
  assert.strictEqual(panel.finder.candidates.size, 1, 'eq keeps MARK');
});
