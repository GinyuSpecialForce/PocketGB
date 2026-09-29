// PocketGB — cheat finder panel (RAM scanner → GameShark freeze / GBA RAM freeze)
//
// UI controller for the finder overlay. The scan engine itself is core
// (CheatFinder in src/core/cheats.js); this module owns everything the panel
// does around it: the freshness loop that keeps snapshot-mode values current,
// the watch rows and their freeze-hold verdicts, and freeze promotion into
// the shared cheat list. All app services arrive as injected deps, so the
// whole panel is testable headless (test/cheat-finder-ui.test.js).
//
// GB/CGB scans the in-process MMU. GBA memory is capability-detected: with
// the stock mGBA build it reports no memory access and the finder runs in
// SNAPSHOT mode — it decodes EWRAM/IWRAM out of freshly saved mGBA states
// (fixed layout, see mgba-state.js) and a freeze is promoted to a VBA-format
// cheat code that mGBA applies itself. If a memory-capable core is dropped
// in, the same GBA address set is scanned live and freezes ride the core
// every frame.
'use strict';

// The GBA scan set, stated once: EWRAM + IWRAM as ranges (live mode scans
// iterate it directly) and as a prebuilt typed array (snapshot scans use it
// as the address provider — 288K entries; a fresh Array every scan would
// churn the GC).
const GBA_SCAN_RANGES = [
  [0x02000000, 0x02040000], // EWRAM
  [0x03000000, 0x03008000], // IWRAM
];
const GBA_SCAN_TOTAL = GBA_SCAN_RANGES.reduce((n, [lo, hi]) => n + (hi - lo), 0);
const GBA_SCAN_ADDRS = (() => {
  const a = new Uint32Array(GBA_SCAN_TOTAL);
  let i = 0;
  for (const [lo, hi] of GBA_SCAN_RANGES) for (let x = lo; x < hi; x++) a[i++] = x;
  return a;
})();

class CheatFinderPanel {
  // deps: { gb, $, setStatus, persistCheats, renderCheatList, applyGbaCheats,
  //         toggleOverlay, CheatFinder, parseGbaCheatLine, decodeState,
  //         romLoaded, now?, refreshMs? } — gb is the GameBoy app singleton;
  // decodeState is window.PocketMgbaState.decodeState (null on a stock load
  // without the module → snapshot mode is unavailable).
  constructor(deps = {}) {
    this.deps = deps;
    this.gb = deps.gb;
    this.refreshMs = deps.refreshMs || 1500; // auto-refresh cadence while the panel is open
    this._now = deps.now || (() => Date.now());
    this._scanBusy = false;     // one scan/narrow at a time (snapshot decode ≈ 50ms)
    this._ioBusy = false;       // one background state refresh at a time
    this._stateStamp = -1;      // machine.stateStamp() of finder.snapshot
    this._lastRefresh = 0;
    this._lastWatchKey = '';    // watch-row dedupe key (snapshot mode only)
    this._timer = null;
    // The engine is shared with the GB path; retarget() re-points it at the
    // loaded console's memory surface.
    this.finder = deps.CheatFinder ? new deps.CheatFinder(() => deps.gb.mmu) : null;
    this._wireControls();
  }

  _$(id) { return this.deps.$ ? this.deps.$(id) : null; }

  snapshotModeActive() { return !!(this.finder && this.finder.snapshotMode); }

  _snapshotModePossible() {
    const gb = this.gb;
    return !!(gb.isGba && gb._gba && !gb.hasMemoryAccess && this.deps.decodeState);
  }

  // Capability check for every panel action. With no ROM loaded everything is
  // allowed (the overlay can be opened first); a GBA without memory access
  // and without a snapshot surface explains itself in the status line.
  available() {
    if (!(this.deps.romLoaded ? this.deps.romLoaded() : false)) return true;
    const gb = this.gb;
    if (gb.isGba) {
      if (gb.hasMemoryAccess) return true;
      if (this._snapshotModePossible()) return true;
      this.deps.setStatus('cheat finder needs GBA memory access — the bundled mGBA build does not expose it');
      return false;
    }
    if (!gb.hasMemoryAccess) { this.deps.setStatus('load a game first'); return false; }
    return true;
  }

  // Re-target the engine when the console changes between loads (called by
  // app.js after every ROM attach).
  retarget() {
    const f = this.finder;
    if (!f) return;
    const gb = this.gb;
    const note = this._$('finder-gba-note');
    f.reset();
    f.watches = [];
    this._lastWatchKey = '';  // next watch render must rebuild for the new console
    this._stateStamp = -1;
    this._lastRefresh = 0;
    if (gb.isGba && gb._gba && gb.hasMemoryAccess) {
      // live mode: memory-capable core — the same GBA set, read live
      f.snapshotMode = false;
      f.addressProvider = () => GBA_SCAN_ADDRS;
      f.gbaMachine = () => gb._gba;
      if (note) note.classList.add('hidden');
    } else if (this._snapshotModePossible()) {
      // snapshot mode: reads come from decoded save states
      f.snapshotMode = true;
      f.addressProvider = () => GBA_SCAN_ADDRS;
      f.snapshotProvider = async () => {
        const png = gb._gba.saveState(); // PNG bytes; throws before the first frame
        return this.deps.decodeState(png);
      };
      f.snapshotReader = (state, addr) => state.readBus(addr);
      f.gbaMachine = null;
      this._stateStamp = gb._gba.stateStamp();
      if (note) {
        note.textContent = 'GBA snapshot mode: the bundled mGBA core exposes no live memory, so scans read save states — search, play, then narrow until a few addresses remain. Values below refresh themselves every couple of seconds; freeze adds a VBA-format cheat code the core applies itself, and its watch row verifies the hold.';
        note.classList.remove('hidden');
      }
    } else {
      f.snapshotMode = false;
      f.addressProvider = null;
      f.gbaMachine = null;
      if (note) note.classList.toggle('hidden', !!(gb.isGba && !gb.hasMemoryAccess));
    }
  }

  // The menu button shows the limitation notice on GBA without live memory —
  // before the first retarget the static note text from index.html stands in.
  attachNoteForMenu() {
    const note = this._$('finder-gba-note');
    if (note) note.classList.toggle('hidden', !(this.gb.isGba && !this.gb.hasMemoryAccess));
  }

  // ---- reads -------------------------------------------------------------
  // Panel reads go through the GBA machine's peek when present (the stub
  // mmu.read would return 0xFF for everything); snapshot mode reads the last
  // decoded state; GB/CGB reads the emulated MMU directly.
  read(addr) {
    const gb = this.gb, f = this.finder;
    if (gb.isGba && gb._gba && gb.hasMemoryAccess) return gb._gba.readMemory(addr);
    if (gb.isGba && f && f.snapshotMode) return f.read(addr);
    return gb.mmu.read(addr);
  }

  // ---- snapshot-mode freshness engine --------------------------------------
  // A decoded state is a photograph: the moment it is taken it starts aging.
  // This keeps finder.snapshot fresh (one save+decode every couple of seconds
  // while the panel is open) and repaints every value readout in place — watch
  // rows show current values and verify freeze codes; candidate rows show the
  // value as of the last photograph, marked stale once a newer one exists.
  // Scan/narrow always force a fresh state first, so their numbers are honest.
  _scheduleIo(force) {
    const gb = this.gb, f = this.finder;
    if (!gb.isGba || !f || !f.snapshotMode) return;
    const machine = gb._gba;
    if (!machine || this._ioBusy) return; // never two saves in flight
    if (!force && (this._scanBusy || this._now() - this._lastRefresh < this.refreshMs)) return;
    this._lastRefresh = this._now();
    this._ioBusy = true;
    (async () => {
      const png = machine.saveState(); // throws before the first frame
      f.snapshot = await this.deps.decodeState(png);
      this._stateStamp = machine.stateStamp();
      this.updateReadouts();
    })().catch(() => { /* before the first frame there is nothing to refresh */ })
      .finally(() => { this._ioBusy = false; });
  }

  // Repaint the value text of rendered rows in place (no DOM rebuild — buttons
  // keep hover/focus and nothing flickers).
  updateReadouts() {
    if (!this.finder || !this.finder.snapshotMode) return;
    const spans = typeof document !== 'undefined' && document.querySelectorAll
      ? document.querySelectorAll('#finder-watches span[data-addr], #finder-list span[data-addr]')
      : [];
    for (const span of spans) {
      const addr = parseInt(span.dataset.addr, 16);
      const val = this.read(addr);
      if (val === null || Number.isNaN(val)) continue;
      span.textContent = this.rowText(addr, val, span.classList.contains('watch'));
    }
  }

  // One-line readout for a watched or candidate address: value, staleness,
  // and — on a watch row with a VBA freeze targeting it — whether the freeze
  // is holding. Both row kinds mark staleness (the photograph ages for
  // candidates and watches alike); only watches verify a freeze.
  rowText(addr, val, isWatch) {
    const s = `$${addr.toString(16).toUpperCase().padStart(8, '0')} = ${val.toString(16).padStart(2, '0')} (${val})`;
    const stale = this._stateStamp !== (this.gb._gba ? this.gb._gba.stateStamp() : -1);
    if (!isWatch) return `${s}${stale && !this._ioBusy ? ' (stale)' : ''}`;
    const v = this.frozenValueAt(addr);
    let verdict = '';
    if (v !== null) {
      verdict = val === v ? ' — freeze holding' : ` — freeze NOT holding (wants ${v})`;
    }
    return `${s}${verdict}${stale && !this._ioBusy ? ' (stale)' : ''}`;
  }

  // The value a VBA-format cheat code freezes `addr` at, or null.
  frozenValueAt(addr) {
    const parse = this.deps.parseGbaCheatLine;
    if (!parse) return null;
    for (const c of this.gb.cheats.serialize()) {
      const p = parse(c.code);
      if (p && p.format === 'vba' && (p.address >>> 0) === (addr >>> 0) && c.enabled !== false) return p.value & 0xFF;
    }
    return null;
  }

  parseValue(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (/^0x[0-9a-f]+$/.test(s) || /^[0-9a-f]{1,2}$/.test(s)) return parseInt(s.replace(/^0x/, ''), 16);
    if (/^\d{1,3}$/.test(s)) return parseInt(s, 10);
    return NaN; // malformed → distinct from "empty"
  }

  // ---- freeze promotion ----------------------------------------------------
  _onFreezeClick(addr, errEl) {
    const gb = this.gb, f = this.finder;
    let r;
    if (gb.isGba && !gb.hasMemoryAccess) {
      // snapshot mode: promote to a VBA code (XXXXXXXX:YY) in the cheat
      // list — mGBA applies it every frame; the value is the last one the
      // scan saw at this address.
      const v = this.read(addr) & 0xFF;
      const code = `${addr.toString(16).toUpperCase().padStart(8, '0')}:${v.toString(16).toUpperCase().padStart(2, '0')}`;
      r = gb.cheats.add(code);
      if (r && !r.error) {
        this.deps.persistCheats(); this.deps.renderCheatList();
        if (!r.duplicate) this.deps.applyGbaCheats(); // a duplicate needs no core reload
      }
      // Verify the hold in the panel itself (the fps ticker owns the status
      // bar): the watch row reports "freeze holding / NOT holding" as the
      // refresh loop reads the machine back.
      if (r && !r.error) {
        if (!f.watches.some((w) => w.addr === addr)) f.watches.push({ addr });
        this.renderWatches();
        this._scheduleIo(true); // verify the hold as soon as a fresh state lands
      }
    } else {
      const target = gb.isGba && gb._gba ? { freeze: (ad, v) => gb._gba.freezeRam(ad, v) } : gb.cheats;
      // The frozen value is the one the row showed: read through the same
      // peek the panel displays with (on a memory-capable GBA core the stub
      // mmu.read would return 0xFF for everything).
      r = f.freeze(addr, target, this.read(addr) & 0xFF);
      if (r && !r.error) { this.deps.persistCheats(); this.deps.renderCheatList(); }
    }
    const w = gb.isGba ? 8 : 4;
    if (r && !r.error) this.deps.setStatus(r.duplicate
      ? `$${addr.toString(16).toUpperCase().padStart(w, '0')} is already in your cheat list`
      : `froze $${addr.toString(16).toUpperCase().padStart(w, '0')} — see cheats`);
    else if (errEl) errEl.textContent = (r && r.error) || 'freeze failed';
  }

  // ---- render --------------------------------------------------------------
  // Candidates: one row per address (capped) with watch + freeze buttons.
  renderList() {
    const f = this.finder;
    const list = this._$('finder-list');
    const err = this._$('finder-err');
    if (!list) return;
    if (err) err.textContent = '';
    if (!f || !f.candidates) { list.textContent = 'no search yet'; return; }
    list.textContent = '';
    const entries = [...f.candidates.entries()].slice(0, 200);
    if (!entries.length) { list.textContent = 'no candidates — reset and try again'; return; }
    for (const [addr] of entries) {
      const row = document.createElement('div');
      row.className = 'finder-row';
      const val = this.read(addr);
      const a = document.createElement('span');
      a.dataset.addr = addr.toString(16);
      a.textContent = this.rowText(addr, val, false); // one row-text source for all three render paths
      const freeze = document.createElement('button');
      freeze.className = 'sbutton'; freeze.textContent = 'freeze';
      freeze.title = !this.gb.isGba
        ? 'add a GameShark code that holds this address at its current value'
        : (this.gb.hasMemoryAccess
          ? 'hold this GBA address at its current value (live RAM freeze)'
          : 'add a VBA-format cheat code that holds this address at its current value');
      freeze.addEventListener('click', () => this._onFreezeClick(addr, err));
      const watch = document.createElement('button');
      watch.className = 'sbutton'; watch.textContent = 'watch';
      watch.title = 'poll this address live in the watch list';
      watch.addEventListener('click', () => {
        if (!f.watches.some((x) => x.addr === addr)) f.watches.push({ addr });
        this.renderWatches();
      });
      row.appendChild(a); row.appendChild(watch); row.appendChild(freeze);
      list.appendChild(row);
    }
    if (f.candidates.size > 200) {
      const more = document.createElement('div');
      more.className = 'hint';
      more.textContent = `…and ${f.candidates.size - 200} more — narrow further`;
      list.appendChild(more);
    }
  }

  // While the panel is open the snapshot-mode watch list must never duplicate
  // rows: the 250ms tick and the in-place refresh engine can race (a fresh
  // state landing between repaints). Rebuild only when the address set changes
  // — values repaint in place via updateReadouts. GB/CGB (and live-mode GBA)
  // reads memory directly, so there the 250ms rebuild IS the value poll and
  // must not be deduped.
  renderWatches() {
    const f = this.finder;
    if (!f) return;
    if (f.snapshotMode) {
      const key = f.watches.map((w) => w.addr).join(',');
      if (key === this._lastWatchKey) return;
      this._lastWatchKey = key;
    } else {
      this._lastWatchKey = '';
    }
    const list = this._$('finder-list');
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !list || !list.parentElement) return; // headless / unmounted
    let watchBox = doc.getElementById('finder-watches');
    if (!f.watches.length) { if (watchBox) watchBox.remove(); return; }
    if (!watchBox) {
      watchBox = doc.createElement('div');
      watchBox.id = 'finder-watches';
      list.parentElement.insertBefore(watchBox, list);
    }
    watchBox.textContent = '';
    for (const w of f.watches) {
      const row = document.createElement('div');
      row.className = 'finder-row watch';
      const val = this.read(w.addr);
      const label = document.createElement('span');
      label.dataset.addr = w.addr.toString(16);
      label.classList.add('watch');
      label.textContent = this.gb.isGba && f.snapshotMode
        ? this.rowText(w.addr, val, true)
        : `watch $${w.addr.toString(16).toUpperCase().padStart(this.gb.isGba ? 8 : 4, '0')} = ${val} (0x${val.toString(16).padStart(2, '0')})`;
      const un = document.createElement('button'); un.className = 'sbutton'; un.textContent = 'unwatch';
      un.addEventListener('click', () => { f.watches = f.watches.filter((x) => x.addr !== w.addr); this.renderWatches(); });
      row.appendChild(label); row.appendChild(un);
      watchBox.appendChild(row);
    }
  }

  // ---- controls ------------------------------------------------------------
  _wireControls() {
    this._bind('finder-search', () => this._onSearch());
    this._bind('finder-unknown', () => this._onUnknown());
    this._bind('finder-apply', () => this._onApply());
    this._bind('finder-reset', () => this.reset());
    this._bind('finder-close', () => this.deps.toggleOverlay && this.deps.toggleOverlay('ov-finder'));
    this._bind('finder-narrow', () => {
      const row = this._$('finder-narrow-row'), hint = this._$('finder-narrow-hint');
      if (!row) return;
      const show = row.style.display === 'none';
      row.style.display = show ? 'flex' : 'none';
      if (hint) hint.style.display = show ? 'block' : 'none';
    });
  }

  _bind(id, fn) {
    const el = this._$(id);
    if (el && el.addEventListener) el.addEventListener('click', fn);
  }

  _requireIdle() { return this.available() && this.finder && !this._scanBusy; }

  async _onSearch() {
    const f = this.finder;
    if (!this._requireIdle()) return;
    const v = this.parseValue((this._$('finder-input') || {}).value);
    // empty input = unknown initial value (the dedicated button's behavior —
    // careless users hit search with the field untouched)
    if (v === null) { await this.runStep(() => f.search(null), (n) => `search: all ${n} addresses (unknown init)`); return; }
    if (Number.isNaN(v) || v < 0 || v > 255) {
      const err = this._$('finder-err');
      if (err) err.textContent = 'enter 0-255 (decimal or 0x hex), or clear the field for unknown-init';
      return;
    }
    await this.runStep(() => f.search(v), (n) => `search: ${n} candidates = ${v}`);
  }

  async _onUnknown() {
    if (!this._requireIdle()) return;
    await this.runStep(() => this.finder.search(null), (n) => `search: all ${n} addresses (unknown init)`);
  }

  async _onApply() {
    const f = this.finder;
    if (!this._requireIdle()) return;
    if (!f.candidates) {
      const err = this._$('finder-err');
      if (err) err.textContent = 'search first';
      return;
    }
    const op = (this._$('finder-op') || {}).value;
    if (op === 'changed' || op === 'unchanged') {
      await this.runStep(() => f.narrow({ op }), (n) => `narrow (${op}): ${n} candidates`);
      return;
    }
    const v = this.parseValue((this._$('finder-narrow-val') || {}).value);
    if (v === null || Number.isNaN(v) || v < 0 || v > 255) {
      const err = this._$('finder-err');
      if (err) err.textContent = 'enter 0-255 for this filter';
      return;
    }
    await this.runStep(() => f.narrow({ op, value: v }), (n) => `narrow: ${n} candidates`);
  }

  // Shared scan/narrow runner: snapshot-mode steps decode a save state
  // (~50ms) and can fail (no state yet) — serialize, report errors in the
  // panel, and keep the old render order (status text, then list).
  async runStep(step, fmt) {
    const f = this.finder;
    this._scanBusy = true;
    try {
      if (f.snapshotMode) this.deps.setStatus('reading save state…');
      const n = await step();
      if (f.snapshotMode && this.gb._gba) this._stateStamp = this.gb._gba.stateStamp(); // the scan's own state is the current photograph
      this.deps.setStatus(fmt(n));
      this.renderList();
    } catch (e) {
      const err = this._$('finder-err');
      if (err) err.textContent = 'finder: ' + (e && e.message ? e.message : e);
    } finally {
      this._scanBusy = false;
    }
  }

  reset() {
    if (!this.available() || !this.finder) return;
    this.finder.reset();
    this.finder.watches = [];
    const list = this._$('finder-list');
    if (list) list.textContent = 'no search yet';
    this.renderWatches();
    this.deps.setStatus('finder reset');
  }

  // ---- 250ms panel heartbeat (only while the overlay is open) ---------------
  startTicker(ms = 250) {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), ms);
  }

  stopTicker() {
    clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    const ov = this._$('ov-finder');
    if (!ov || !ov.classList.contains('open')) return;
    this.renderWatches();
    this.updateReadouts(); // repaints values + staleness between refreshes
    this._scheduleIo();    // self-gated to refreshMs; repaints in place
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CheatFinderPanel, GBA_SCAN_RANGES, GBA_SCAN_ADDRS, GBA_SCAN_TOTAL };
}
if (typeof window !== 'undefined') {
  window.PocketCheatFinder = { CheatFinderPanel, GBA_SCAN_RANGES, GBA_SCAN_ADDRS, GBA_SCAN_TOTAL };
}
