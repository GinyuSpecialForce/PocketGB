// PocketGB — mGBA machine adapter.
//
// Wraps the mGBA WebAssembly core (vendored at vendor/mgba/) behind the same
// machine surface app.js drives for GB/CGB: loadROM, runFrame, joypad state,
// battery saves, save states, and audio sample output. The canvas used for
// mGBA's own video output is a detached canvas; the readable framebuffer from
// Module.ctx/glReadPixels is normalized into a 240x160 BGR555 Uint16Array so
// the existing Renderer blit path works unchanged.
//
// mGBA core: https://github.com/mgba-emu/mgba (MPL-2.0), wasm build from
// https://github.com/thenick775/mgba-wasm (MPL-2.0). See license.txt.
'use strict';

const GBA_W = 240, GBA_H = 160;

// mGBA button names -> the app's joypad state object keys.
const BTN_BY_STATE = [
  ['a', 'A'], ['b', 'B'], ['select', 'Select'], ['start', 'Start'],
  ['right', 'Right'], ['left', 'Left'], ['up', 'Up'], ['down', 'Down'],
  ['r', 'R'], ['l', 'L'],
];

// The wasm build exposes no cheat-write API: Module.autoLoadCheats() is the
// only entry point, and mCoreAutoloadCheats (called from loadGame) parses
// <rom-basename>.cheats out of filePaths().cheatsPath. mCheatParseFile APPENDS
// sets, so re-calling autoLoadCheats duplicates every set — the only clean
// re-apply path is quitGame() + loadGame(). All cheats go through one file,
// /data/cheats/game.cheats (our ROM is always /data/games/game.gba), written
// BEFORE loadGame. One mGBA set per cheat line keeps toggling exact:
// "!disabled" sets are never applied.
const CHEATS_PATH = '/data/cheats/game.cheats';

class MgbaMachine {
  // Monotonic save-state clock (process-wide): every fresh saveState gets the
  // next number, so consumers can tell whether a value came from a state
  // newer than the one they last read.
  static _stateClock = 0;

  constructor(Module) {
    this.Module = Module;
    this.ready = false;
    this.romPath = null;
    this.saveName = null;
    this.saveType = null;
    this.cheats = []; // { code, enabled } — app-owned source of truth; synced to the core via .cheats file
    this._frozen = new Map(); // addr -> value, re-applied every frame (needs memory access)
    // Fresh-state clock for the cheat finder (see _stateClock): 0 until the
    // first saveState(), reset to 0 on discontinuities.
    this._stateStamp = 0;
    this._coreFrameSerial = 0; // bumped by the core's videoFrameEnded callback
    this._harvestedSerial = -1;
    this._serialTrust = undefined; // undefined = probe not started yet
    this.framebuffer = new Uint16Array(GBA_W * GBA_H);
    this.ppu = {
      framebuffer: this.framebuffer,
      colorFramebuffer: this.framebuffer,
      cgb: true,
      frameComplete: false,
    };
    // joypad-shaped shim: app.js calls gb.joypad.setState(state)
    this.joypad = { setState: (s) => this.setInput(s) };
    // serial shim: GBA link via mGBA is not wired; keep no-ops so printer/net UI stays inert
    this.serial = { onSend: null, receiveByte() {}, reset() {} };
    this.cart = null; // set at loadROM: minimal save/sav surface used by app.js
    this._fpsTarget = 60;
  }

  // ---- ROM loading -------------------------------------------------------
  // bytes: Uint8Array of a .gba ROM. saveBytes: optional .sav contents.
  // cheatList: [{ code, enabled }] — validated GBA cheats, written to the
  // .cheats file mGBA parses inside loadGame.
  loadROM(bytes, saveBytes, cheatList) {
    if (cheatList) this.cheats = cheatList.map((c) => ({ code: String(c.code || ''), enabled: !!c.enabled }));
    this._cheatsAtBoot = this.cheats.length; // sets the core device starts with
    const Module = this.Module;
    const romPath = '/data/games/game.gba';
    Module.FS.writeFile(romPath, bytes);
    if (saveBytes && saveBytes.length) {
      Module.FS.writeFile('/data/saves/game.sav', saveBytes);
    }
    this._writeCheatsFile(); // must exist before loadGame: mCoreAutoloadCheats reads it there
    const ok = Module.loadGame(romPath, '/data/saves/game.sav');
    if (!ok) throw new Error('mGBA failed to load the GBA ROM');
    this.romPath = romPath;
    this.saveName = Module.saveName || '/data/saves/game.sav';
    this.ready = true;
    // Frame-completion stamp: lets runFrame() skip the glReadPixels pass on
    // ticks where the core has not finished a new frame since the last
    // harvest. Must be (re)registered AFTER loadGame — the callback table
    // lives on the core object, which loadGame creates (and quitGame in the
    // cheat-reload path destroys). The runFrame() skip stays safe regardless:
    // it self-probes and falls back to harvest-every-tick if this ever fails.
    try {
      Module.addCoreCallbacks({
        videoFrameEnded: () => { this._coreFrameSerial++; },
      });
    } catch { /* callback unsupported: harvest just runs every tick */ }
    // fresh core: re-run the frame-serial trust probe
    this._serialTrust = undefined;
    this._harvestedSerial = -1;
    this.cart = {
      rom: bytes,
      dirty: false,
      battery: true,
      serializeSav: () => this.getSav(),
    };
  }

  getSav() {
    try {
      const data = this.Module.getSave();
      return data ? new Uint8Array(data) : new Uint8Array(0);
    } catch { return new Uint8Array(0); }
  }

  loadSav(bytes) { /* handled at loadROM; mGBA reads /data/saves/game.sav */ }

  // ---- cheats -------------------------------------------------------------
  // list: [{ code, enabled }] — already validated GBA-format codes.
  _writeCheatsFile() {
    const Module = this.Module;
    const G = (typeof window !== 'undefined' && window.PocketCheat) || null;
    const lines = [];
    for (const c of this.cheats || []) {
      const code = String(c.code || '').trim().toUpperCase();
      if (!code) continue;
      if (G && G.parseGbaCheatLine && !G.parseGbaCheatLine(code)) continue; // defense in depth: never hand garbage to the core
      lines.push(`${c.enabled === false ? '!disabled\n' : ''}# cheat\n${code}`);
    }
    const text = lines.join('\n');
    try {
      if (text) Module.FS.writeFile(CHEATS_PATH, text); else Module.FS.unlink(CHEATS_PATH);
    } catch { /* file absent — nothing to remove */ }
  }

  // Register the app's cheat list and apply it to the running core.
  //   - boot had no cheats: the core device has no sets, so re-parsing the just
  //     written file (autoLoadCheats) appends ours cleanly — no reload needed.
  //   - otherwise the sets already exist and mCheatParseFile APPENDS, so the
  //     list can only be applied faithfully by quitGame() + loadGame(); the
  //     running state is round-tripped through the auto save state so gameplay
  //     continues untouched (this also clears sets when the list empties).
  // Returns 'applied' | 'reloaded' | error string.
  applyCheats(list) {
    if (!this.ready) return 'no game';
    this.cheats = (list || []).map((c) => ({ code: String(c.code || ''), enabled: !!c.enabled }));
    this._writeCheatsFile();
    this._stateStamp = 0; // the emulated side is about to change discontinuously
    const atBoot = this._cheatsAtBoot || 0;
    const now = this.cheats.length;
    if (atBoot === 0 && now === 0) return 'applied'; // nothing ever loaded
    if (atBoot === 0) {
      try { this.Module.autoLoadCheats(); } catch { /* file is in place for next boot */ }
      this._cheatsAtBoot = now;
      return 'applied';
    }
    this._cheatsAtBoot = now;
    let state = null;
    try { state = this.saveState(); } catch { /* before first frame — nothing to carry */ }
    this.Module.quitGame();
    const ok = this.Module.loadGame(this.romPath, '/data/saves/game.sav');
    if (!ok) { this.ready = false; return 'cheat reload failed'; }
    if (state) { try { this.loadState(state); } catch { /* stale state — fresh boot is fine */ } }
    return 'reloaded';
  }

  // ---- memory access (capability-detected) ---------------------------------
  // The vendored wasm build exports no bus peek/poke, so GBA RAM is opaque to
  // the app. A rebuilt core that exports busRead8/busWrite8 lights this up
  // automatically — no other code change needed. Everything that wants GBA
  // memory (cheat finder freezes, RetroAchievements logic, scripting) goes
  // through here and must tolerate null.
  _ensureMemoryAccess() {
    if (this._mem !== undefined) return this._mem;
    const M = this.Module;
    try {
      if (typeof M.cwrap === 'function' && typeof M._malloc === 'function') {
        const r8 = M.cwrap('busRead8', 'number', ['number']);
        const w8 = M.cwrap('busWrite8', null, ['number', 'number']);
        r8(0x02000000); // probe: a missing export throws inside cwrap/call
        this._mem = { read8: (a) => r8(a) & 0xFF, write8: (a, v) => w8(a, v & 0xFF) };
        return this._mem;
      }
    } catch { /* not exported in this build */ }
    this._mem = null;
    return null;
  }

  get hasMemoryAccess() { return this.ready && !!this._ensureMemoryAccess(); }

  readMemory(addr) {
    const m = this._ensureMemoryAccess();
    return m ? m.read8(addr >>> 0) : null;
  }

  writeMemory(addr, value) {
    const m = this._ensureMemoryAccess();
    if (m) m.write8(addr >>> 0, value & 0xFF);
  }

  // RAM freezes: addresses re-written every frame (the cheat-finder's freeze
  // on GBA). Applied in runFrame before the framebuffer harvest. Independent
  // of the .cheats-file codes — these need live memory access.
  freezeRam(addr, value) { this._frozen.set(addr >>> 0, value & 0xFF); this._applyFrozen(); }
  unfreezeRam(addr) { this._frozen.delete(addr >>> 0); }
  clearFrozenRam() { this._frozen.clear(); }
  _applyFrozen() {
    const m = this._ensureMemoryAccess();
    if (!m) return;
    for (const [a, v] of this._frozen) m.write8(a, v);
  }

  // ---- input -------------------------------------------------------------
  // The glue's Module.buttonPress re-runs cwrap() (building a fresh closure
  // and arg-conversion table) on EVERY call — 20 constructions per frame at
  // 60fps is constant GC pressure. cwrap once per button and reuse; ids are
  // the glue's keyBindings order (a=0…l=9), which BTN_BY_STATE matches.
  _ensureButtons() {
    if (this._btn !== undefined) return this._btn;
    const M = this.Module;
    try {
      if (typeof M.cwrap === 'function') {
        const press = M.cwrap('buttonPress', null, ['number']);
        const unpress = M.cwrap('buttonUnpress', null, ['number']);
        this._btn = { press, unpress };
        return this._btn;
      }
    } catch { /* export missing: fall through */ }
    this._btn = null;
    return null;
  }

  setInput(state) {
    const Module = this.Module;
    if (!this.ready) return;
    const btn = this._ensureButtons();
    for (let i = 0; i < BTN_BY_STATE.length; i++) {
      const key = BTN_BY_STATE[i][0];
      if (state[key]) {
        if (btn) btn.press(i); else Module.buttonPress(BTN_BY_STATE[i][1]);
      } else {
        if (btn) btn.unpress(i); else Module.buttonUnpress(BTN_BY_STATE[i][1]);
      }
    }
  }

  // ---- frame stepping ----------------------------------------------------
  // mGBA runs its own main loop (rAF-driven) and paints to its canvas;
  // runFrame() harvests the latest completed frame from that loop by reading
  // back the framebuffer. Both loops run on the same 60Hz rAF cadence, so the
  // picture is at most one core-frame old regardless of registration order —
  // and when the core's videoFrameEnded callback IS observed firing, the
  // serial check skips the 2-3ms glReadPixels pass on duplicate ticks (120Hz
  // displays) and guarantees no partial frames are read mid-paint.
  // The skip is self-verifying: until the callback is OBSERVED to fire
  // (20-tick probe) every tick harvests, and if it ever stops the machine
  // reverts to harvest-every-tick. A silent callback must never freeze the
  // picture — this build's callback never fires (verified live), so the
  // fallback path is the one that runs here.
  runFrame() {
    if (!this.ready) return null;
    this._applyFrozen(); // cheat-finder freezes ride the core's own frame
    if (this._serialTrust === undefined) {
      this._serialTrust = null; // null = probing, unknown
      this._serialProbeStart = this._coreFrameSerial;
      this._serialProbes = 0;
    }
    if (this._serialTrust === null) {
      if (this._coreFrameSerial !== this._serialProbeStart) this._serialTrust = true;
      else if (++this._serialProbes > 20) this._serialTrust = false; // callback dead
    }
    const fresh = this._serialTrust === false || this._harvestedSerial !== this._coreFrameSerial;
    if (fresh) {
      this._harvestedSerial = this._coreFrameSerial;
      this._readFramebuffer();
      this.ppu.frameComplete = true;
    }
    return this.framebuffer;
  }

  _readFramebuffer() {
    const gl = this.Module.ctx || (this.Module.GL && this.Module.GL.currentContext);
    if (!gl) return;
    try {
      const w = gl.drawingBufferWidth || GBA_W;
      const h = gl.drawingBufferHeight || GBA_H;
      if (!this._pixBuf || this._pixBuf.length !== w * h * 4) {
        this._pixBuf = new Uint8Array(w * h * 4);
        this._pix32 = new Uint32Array(this._pixBuf.buffer); // one LE load per pixel
      }
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._pixBuf);
      const p32 = this._pix32;
      const fb = this.framebuffer;
      let o = 0;
      for (let y = 0; y < GBA_H; y++) {
        // glReadPixels yields bottom-up rows; flip while expanding RGBA→BGR555
        const srcRow = (h - 1 - y) * w;
        for (let x = 0; x < GBA_W; x++) {
          const px = p32[srcRow + x];
          const r = (px & 255) >> 3, g = ((px >>> 8) & 255) >> 3, b = ((px >>> 16) & 255) >> 3;
          fb[o++] = (b << 10) | (g << 5) | r;
        }
      }
    } catch { /* keep last frame */ }
  }

  // ---- audio -------------------------------------------------------------
  // mGBA's SDL2 audio uses a ScriptProcessorNode routed to its own AudioContext.
  // The app's AudioManager drives GB audio through an AudioWorklet; for GBA we
  // let mGBA's own output run and simply report the rate app.js expects for
  // pacing math. Mute toggles mGBA's volume — this build's scale is 0..1
  // (verified live: getVolume() returns 1 after unmuting), 0 silences.
  get apu() {
    const self = this;
    return {
      outputRate: 48000,
      available: () => 0,
      pull: () => false,
      pullBlock: () => new Float32Array(0),
      setOutputRate() {},
      tick() {},
      reset() {},
      // mute passthrough used by app.js setMuted
      setMuted(m) { try { self.Module.setVolume(m ? 0 : 1); } catch { /* core not ready */ } },
    };
  }

  setMuted(m) { try { this.Module.setVolume(m ? 0 : 1); } catch { /* not ready */ } }

  // ---- machine controls --------------------------------------------------
  reset() {
    if (this.ready) this.Module.quickReload();
  }

  setPaused(p) {
    if (!this.ready) return;
    if (p) this.Module.pauseGame(); else this.Module.resumeGame();
  }

  setFastForward(mult) {
    if (!this.ready) return;
    try { this.Module.setFastForwardMultiplier(mult); } catch { /* not ready */ }
  }

  // ---- save states -------------------------------------------------------
  // Byte-oriented surface (app.js stores/transfers the bytes itself). The
  // mGBA slot API names files after the ROM internally, so we drive the
  // auto-save-state API instead and move the bytes through its known path:
  // /autosave/<rom>_auto.ss via forceAutoSaveState()/getAutoSaveState().
  // forceAutoSaveState() returns false before the core's first completed
  // frame, but a boot-time auto state may already exist — read it regardless
  // and only fail when there is truly nothing to return.
  saveState() {
    if (!this.ready) throw new Error('no game');
    try { this.Module.forceAutoSaveState(); } catch { /* before first frame */ }
    const auto = this.Module.getAutoSaveState();
    if (!auto || !auto.data || !auto.data.length) throw new Error('save state failed');
    this._stateStamp = ++MgbaMachine._stateClock; // new observation window
    return new Uint8Array(auto.data);
  }

  loadState(bytes) {
    if (!this.ready) return;
    const path = this.Module.autoSaveStateName;
    if (path) this.Module.FS.writeFile(path, bytes);
    this.Module.loadAutoSaveState();
    this._stateStamp = 0; // discontinuity: stamp comparisons must not straddle it
  }

  // Monotonic counter bumped by every fresh saveState; other consumers (the
  // cheat finder) compare stamps to tell whether a value came from a state
  // newer than the one they last read.
  stateStamp() { return this._stateStamp; }

  destroy() {
    try { if (this.ready) this.Module.quitGame(); } catch { /* already gone */ }
    this.ready = false;
  }
}

// Factory: loads the vendored mGBA wasm module and binds it to a detached
// canvas. Resolves with a ready MgbaMachine. Must be called from the renderer
// (the core needs WebGL canvas + threads + cross-origin isolation).
async function createMgbaMachine(canvas) {
  // The core is an ES module loaded by index.html; it lands on window.mGBA
  // asynchronously. Wait briefly for it (module scripts run after classic ones).
  if (typeof window === 'undefined') throw new Error('mGBA adapter requires the renderer');
  if (!window.mGBA) {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('mGBA core failed to load (vendor/mgba/mgba.js)')), 15000);
      window.addEventListener('mgba-ready', () => { clearTimeout(to); resolve(); }, { once: true });
    });
  }
  const Module = await window.mGBA({
    canvas,
    // mGBA paints via WebGL; without preserveDrawingBuffer the drawing buffer is
    // cleared after compositing and our framebuffer readback would be blank.
    webglContextAttributes: { preserveDrawingBuffer: true },
  });
  await Module.FSInit();
  Module.setCoreSettings({
    audioSampleRate: 48000,
    // 2048 samples ≈ 43ms: the ScriptProcessorNode runs on the main thread,
    // so a busy frame can starve 1024 samples (21ms) into audible underruns.
    audioBufferSize: 2048,
    // Drive emulation off rAF (videoSync), NOT the audio clock: Chromium keeps
    // AudioContexts suspended until a user gesture, and audioSync throttles the
    // main loop on audio consumption — with a suspended context the core stalls.
    videoSync: true,
    audioSync: false,
    timestepSync: true,
    // The app implements its own rewind via save states (src/ui/rewind.js);
    // the core's built-in rewind buffer only costs CPU.
    rewindEnable: false,
    // The core's own auto-save-state timer writes mGBA state files to IDBFS
    // mid-play (periodic main-thread stall); the app owns persistence —
    // resume points, manual saves, quit flushes — so this stays off.
    autoSaveStateEnable: false,
  });
  const machine = new MgbaMachine(Module);
  return machine;
}

if (typeof module !== 'undefined') module.exports = { MgbaMachine, createMgbaMachine, GBA_W, GBA_H };
if (typeof window !== 'undefined') { window.MgbaMachine = MgbaMachine; window.createMgbaMachine = createMgbaMachine; }
