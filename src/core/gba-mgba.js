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
  constructor(Module) {
    this.Module = Module;
    this.ready = false;
    this.romPath = null;
    this.saveName = null;
    this.saveType = null;
    this.cheats = []; // { code, enabled } — app-owned source of truth; synced to the core via .cheats file
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

  // ---- input -------------------------------------------------------------
  setInput(state) {
    const Module = this.Module;
    if (!this.ready) return;
    for (const [key, btn] of BTN_BY_STATE) {
      if (state[key]) Module.buttonPress(btn); else Module.buttonUnpress(btn);
    }
  }

  // ---- frame stepping ----------------------------------------------------
  // mGBA runs its own main loop (rAF-driven) and paints to the canvas it was
  // constructed with; runFrame() here just harvests the latest completed frame
  // from that loop by reading back the framebuffer.
  runFrame() {
    if (!this.ready) return null;
    this._readFramebuffer();
    this.ppu.frameComplete = true;
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
  // pacing math. Mute toggles mGBA's volume.
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
    return new Uint8Array(auto.data);
  }

  loadState(bytes) {
    if (!this.ready) return;
    const path = this.Module.autoSaveStateName;
    if (path) this.Module.FS.writeFile(path, bytes);
    this.Module.loadAutoSaveState();
  }

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
    audioBufferSize: 1024,
    // Drive emulation off rAF (videoSync), NOT the audio clock: Chromium keeps
    // AudioContexts suspended until a user gesture, and audioSync throttles the
    // main loop on audio consumption — with a suspended context the core stalls.
    videoSync: true,
    audioSync: false,
    timestepSync: true,
    // The app implements its own rewind via save states (src/ui/rewind.js);
    // the core's built-in rewind buffer only costs CPU.
    rewindEnable: false,
    autoSaveStateEnable: true,
  });
  return new MgbaMachine(Module);
}

if (typeof module !== 'undefined') module.exports = { MgbaMachine, createMgbaMachine, GBA_W, GBA_H };
if (typeof window !== 'undefined') { window.MgbaMachine = MgbaMachine; window.createMgbaMachine = createMgbaMachine; }
