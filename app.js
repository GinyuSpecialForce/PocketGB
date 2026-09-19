// PocketGB — app controller (renderer side)
'use strict';
// romtitle.js exposes titleLooksBroken/basenameOf/extractRomTitle as classic
// script globals; app.js is renderer-only, so they are called bare here.

const gb = new GameBoy();
const renderer = new Renderer(document.getElementById('screen'));
const input = new InputManager();
const audio = new AudioManager();
const rewind = new RewindManager(gb);
const capture = new Capture(renderer, document.getElementById('screen'));
const debug = new DebugView(gb, renderer);
const apu = gb.apu;

let romInfo = null;
let bootAnim = null; // generated boot animation (null when idle/finished)
let bootChimePlayed = true; // one-shot guard for the boot chime
let paused = false;
let muted = false;
let forceDmg = false; // menu toggle: run CGB games in classic DMG mode
let romLoaded = false;
let turbo = false;
let rewinding = false;
let speed = 1;                 // emulation speed multiplier
let settingsLoaded = false;
let savTimer = null;
let fps = 0;
let linkHosting = 0; // port while hosting, 0 otherwise
let linkConnected = false;

// ---- elements ----
const $ = (id) => document.getElementById(id);
const elRomName = $('rom-name');
const elStatus = $('status');
const elLibrary = $('library');
const elLibGrid = $('library-grid');
const elBezel = $('bezel');
const elCenter = $('center');
const elCanvas = $('screen');
const elPalette = $('palette');
const elScale = $('scale');
const elSpeed = $('speed');
const elSettings = $('settings');
const elLinks = $('links');
const elTurboBadge = $('turbo-badge');

// ---- input wiring ----
input.onChange((state) => gb.joypad.setState(state));
input.onHotkey((action) => {
  if (action === 'turbo-on') setTurbo(true);
  else if (action === 'turbo-off') setTurbo(false);
  else if (action === 'rewind-on') setRewinding(true);
  else if (action === 'rewind-off') setRewinding(false);
  else if (action === 'cheats') toggleOverlay('ov-cheats');
  else if (action === 'effects') toggleOverlay('ov-effects');
  else if (action === 'keys') { renderBinds(); toggleOverlay('ov-keys'); }
  else if (action === 'practice-reset') practiceHotReset();
});

// ---- link cable ----
// Game Boy Printer: intercepts serial traffic when enabled (the printer and a
// link peer are mutually exclusive — one device sits on the cable at a time).
let printerEnabled = false;
let printer = null;
function setPrinterEnabled(on) {
  printerEnabled = on;
  if (on && window.GBPrinter) {
    printer = new GBPrinter();
    printer.onPrint = (png) => savePrinterImage(png);
    gb.serial.onSend = (b) => { printer.receiveByte(b); };
    setStatus('game boy printer attached');
  } else {
    printer = null;
    gb.serial.onSend = (b) => window.pocketgb.linkSend(b);
  }
  updateLinkStatus();
}
async function savePrinterImage(png) {
  const b64 = btoa(String.fromCharCode(...png));
  const name = `${(!titleLooksBroken(romInfo?.title) ? romInfo.title : 'printout').replace(/[^\w ]/g, '_')}-${printer.sheets}.png`;
  const p = await window.pocketgb.saveFile(name, b64);
  if (p) setStatus(`printed → ${p.split('/').pop()}`);
}
gb.serial.onSend = (b) => window.pocketgb.linkSend(b);
window.pocketgb.onLinkData((u8) => {
  for (const b of u8) gb.serial.receiveByte(b);
});
window.pocketgb.onLinkStatus((st) => {
  linkConnected = !!(st && st.connected);
  updateLinkStatus();
});
window.pocketgb.onLinkHosting((port) => {
  linkHosting = port;
  updateLinkStatus();
});
window.pocketgb.onLinkError((msg) => {
  const el = $('link-status');
  if (el) el.textContent = `link error: ${msg}`;
});

function updateLinkStatus() {
  const el = $('link-status');
  if (el) el.textContent = linkConnected
    ? `connected — ${linkHosting ? `hosting on ${linkHosting}` : 'joined as client'}`
    : (linkHosting ? `hosting on ${linkHosting} — waiting for peer…` : 'not connected');
}

async function doLinkHost() {
  const port = parseInt($('link-port').value, 10);
  await window.pocketgb.linkHost(Number.isFinite(port) ? port : 0);
  updateLinkStatus(); // actual port arrives via onLinkHosting
  setStatus('link hosting…');
}
async function doLinkJoin() {
  const port = parseInt($('link-port').value, 10);
  // optional opponent address: '192.168.1.20' or 'example.com' — blank means localhost
  const addrRaw = ($('link-addr').value || '').trim();
  const host = addrRaw && !/^[0-9.]+$|^localhost$/i.test(addrRaw) ? addrRaw : (addrRaw || '127.0.0.1');
  const st = await window.pocketgb.linkJoin(Number.isFinite(port) ? port : 8765, host);
  updateLinkStatus();
  setStatus(host === '127.0.0.1' ? 'link joining…' : `link joining ${host}…`);
}
function doLinkStop() {
  window.pocketgb.linkStop();
  linkHosting = 0;
  linkConnected = false;
  updateLinkStatus();
}

// the menu overlay has two panels: the button grid and the link-cable form
function showMenuPanel(id) {
  // panel switcher inside ov-menu: hide every box, show the requested one
  document.querySelectorAll('#ov-menu .box').forEach((b) => b.classList.add('hidden'));
  $(id).classList.remove('hidden');
}
$('btn-link').addEventListener('click', () => { updateLinkStatus(); showMenuPanel('link-panel'); });
$('link-back').addEventListener('click', () => showMenuPanel('menu-panel'));
$('link-host').addEventListener('click', doLinkHost);
$('link-join').addEventListener('click', doLinkJoin);
$('link-stop').addEventListener('click', doLinkStop);
$('link-close').addEventListener('click', () => { toggleOverlay('ov-menu'); showMenuPanel('menu-panel'); });
$('btn-more').addEventListener('click', () => { showMenuPanel('menu-panel'); toggleOverlay('ov-menu'); });
$('menu-close').addEventListener('click', () => toggleOverlay('ov-menu'));
// ---- menu launchpad: category tiles → submenu panels (swap in place) ----
const MENU_SUBS = { 'cat-game': 'sub-game', 'cat-options': 'sub-options', 'cat-capture': 'sub-capture', 'cat-hardware': 'sub-hardware' };
function openMenuSub(id) {
  document.querySelectorAll('#ov-menu .box').forEach((b) => b.classList.add('hidden'));
  $(id).classList.remove('hidden');
}
for (const [tile, sub] of Object.entries(MENU_SUBS)) {
  $(tile).addEventListener('click', () => openMenuSub(sub));
  $(tile).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenuSub(sub); } });
}
// every submenu's ‹ menu breadcrumb + back button return to the launchpad
for (const sub of Object.values(MENU_SUBS)) {
  const back = $(sub.replace('sub-', 'back-'));
  if (back) back.addEventListener('click', () => openMenuSub('menu-panel'));
  $(`${sub}-back`).addEventListener('click', () => openMenuSub('menu-panel'));
  $(`${sub}-close`).addEventListener('click', () => { toggleOverlay('ov-menu'); openMenuSub('menu-panel'); });
}
// Escape closes whichever overlay is open (bind-capture handles its own Escape);
// in the menu it goes BACK a level first, then closes.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.overlay.open');
  if (!open) return;
  if (open.id === 'ov-menu') {
    const hidden = $('menu-panel').classList.contains('hidden');
    if (hidden) { openMenuSub('menu-panel'); return; } // submenu → back to launchpad
  }
  toggleOverlay(open.id);
  if (open.id === 'ov-debug') debug.stop();
  if (open.id === 'ov-menu') showMenuPanel('menu-panel');
});

// ---- main loop ----
// Time-budgeted frame production: normally one frame per 60Hz tick, N frames
// when turbo/fast-speed is active. Rewind pauses production and pops states.
const FRAME_MS = 1000 / 60.0;
let lastFrameTime = 0;
let rewindRepeat = 0;

function loop(t) {
  requestAnimationFrame(loop);
  if (!romLoaded || paused) { lastFrameTime = t; return; }

  audio.pump(); // keep the audio thread's ring fed regardless of pacing below

  if (rewinding) {
    // ~15 steps/sec while held, paced independently of frame production
    if (rewind.step()) {
      renderer.blit(gb.ppu.colorFramebuffer || gb.ppu.framebuffer, gb.mmu.cgb);
      renderer.present();
      setStatus('rewinding');
    } else setStatus('start of rewind buffer');
    return;
  }

  if (t - lastFrameTime < FRAME_MS / speed - 1.5) return;
  lastFrameTime = Math.min(t, lastFrameTime + FRAME_MS / speed);

  // generated boot animation (no user boot ROM): falling logo + chime + CGB wash
  if (bootAnim) {
    if (!bootAnim.done) {
      bootAnim.drawFrame();
      playBootChime();
      renderer.blit(bootAnim.fb, gb.mmu.cgb);
      renderer.present();
      if (bootAnim.done) { bootAnim = null; lastFrameTime = t; }
      return;
    }
    bootAnim = null;
  }

  // debugger run-to-breakpoint: emulate as fast as possible until PC hits one
  if (dbgRunning) {
    for (let i = 0; i < 120 && dbgRunning; i++) { // bounded per frame: UI stays alive
      const hit = gb._breakpoints && gb._breakpoints.has(gb.cpu.pc);
      if (hit) { dbgRunning = false; setStatus(`breakpoint $${gb.cpu.pc.toString(16).toUpperCase().padStart(4, '0')}`); break; }
      gb.stepInstruction();
    }
    const fb2 = gb.ppu.colorFramebuffer || gb.ppu.framebuffer;
    renderer.blit(fb2, gb.mmu.cgb);
    renderer.present();
    return;
  }

  // Produce one frame per pacing tick minimum; produce extra frames in a
  // burst only while the audio buffer has room. The audio gate must never be
  // able to starve video: if the audio context is suspended or drains slowly,
  // the ring stays full — skipping production on that alone crawls at ~16 fps
  // (audio callbacks only fire 60–75×/s, never several times per video tick).
  const maxFrames = speed >= 4 ? 4 : speed >= 2 ? 2 : 1;
  const rate = apu.outputRate || 44100;
  const burst = audio.buffered() < rate * (turbo ? 0.02 : 0.15) ? maxFrames : 1;
  for (let i = 0; i < burst; i++) {
    // movie playback overrides live input for the frame; recording observes it
    if (moviePlayer.playing) {
      const mask = moviePlayer.next();
      if (mask === null) { setStatus('movie finished'); }
      else gb.joypad.setState(window.PocketMovie.maskToState(mask));
    }
    // ghost racer steps its own machine every produced frame so both
    // timelines advance at the same rate; blit() routes the framebuffer to
    // the ghost PiP panel (a separate canvas beside the game, never on top)
    if (ghost && ghost.active) {
      const gfb = ghost.step(0);
      if (gfb) renderer.ghostFrame = gfb;
      const pct = $('ghost-progress');
      if (pct) pct.textContent = `${Math.round(ghost.progress * 100)}%`;
      if (ghost.done) {
        // attempt over: keep the panel for the final picture, re-arm so the
        // next reset (F8) starts the next race
        ghost.hold();
        $('ghost-progress').textContent = 'armed';
        $('ghost-pip-label').textContent = 'ghost · armed';
        setStatus('ghost finished — you win');
      }
    }
    if (heatmap) heatmap.sample(gb.cpu.pc);
    const fb = gb.runFrame();
    if (movieRecorder.recording) {
      movieRecorder.observe(window.PocketMovie.stateToMask(input.state));
    }
    if (fb) {
      framesThisSecond++;
      if (i === burst - 1) { // present the last frame of the burst
        renderer.blit(fb, gb.mmu.cgb);
        renderer.present();
        capture.observe(fb, gb.mmu.cgb);
      }
    }
  }
  rewind.update(t);
  practice.onFrame();
  renderInputDisplay();

  if (t - fpsLast >= 500) {
    fps = Math.round(framesThisSecond * 1000 / (t - fpsLast));
    framesThisSecond = 0; fpsLast = t;
    if (!rewinding) setStatus(`${fps} fps`);
    elStatus.classList.toggle('live', fps >= 50);
  }
}
let framesThisSecond = 0, fpsLast = performance.now();
let dbgRunning = false;

// ---- movies (deterministic input record/replay) ----
const movieRecorder = window.PocketMovie ? new window.PocketMovie.MovieRecorder() : null;
const moviePlayer = window.PocketMovie ? new window.PocketMovie.MoviePlayer() : null;
$('btn-movie-rec').addEventListener('click', () => {
  if (!romLoaded) { setStatus('load a game first'); return; }
  if (movieRecorder.recording) {
    const bytes = movieRecorder.stop();
    const b64 = btoa(String.fromCharCode(...bytes));
    window.pocketgb.saveFile(`${(!titleLooksBroken(romInfo.title) ? romInfo.title : 'movie').replace(/[^\w ]/g, '_')}-${Math.floor(framesThisSecond)}.pgm`, b64).then((p) => {
      if (p) setStatus(`movie saved (${bytes.length} B)`);
    });
    $('btn-movie-rec').textContent = 'record movie';
  } else {
    movieRecorder.start(gb);
    setStatus('recording input — play, then press again to save');
    $('btn-movie-rec').textContent = 'stop & save';
  }
});
$('btn-movie-play').addEventListener('click', () => {
  if (!romLoaded) { setStatus('load a game first'); return; }
  let inp = document.getElementById('movie-file');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.id = 'movie-file'; inp.accept = '.pgm';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const buf = await f.arrayBuffer();
      const err = moviePlayer.load(new Uint8Array(buf), gb);
      if (err) { setStatus(err); return; }
      const startErr = moviePlayer.start(gb);
      if (startErr) { setStatus(startErr); return; }
      setStatus(`replaying ${moviePlayer.total} frames…`);
    });
  }
  inp.click();
});

// ---- cartridge heatmap ----
let heatmap = null;
function renderHeatmap() {
  const cv = $('heat-canvas');
  const sum = $('heat-summary');
  if (!cv || !heatmap) return;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#151317';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const snaps = heatmap.snapshot();
  if (!snaps.length) { sum.textContent = 'no samples yet'; return; }
  const banks = snaps.map((s) => s.bank);
  const maxBank = Math.max(...banks, 2);
  const rows = maxBank + 1;
  const rowH = Math.max(2, Math.floor(cv.height / rows));
  const cellsPerRow = Math.floor(cv.width / 2); // 512/2 = 256 buckets
  let maxHit = 1;
  for (const s of snaps) if (s.hot > maxHit) maxHit = s.hot;
  snaps.forEach((s, ri) => {
    const y = s.bank * rowH;
    for (let i = 0; i < s.buckets.length && i < cellsPerRow; i++) {
      const h = s.buckets[i];
      if (!h) continue;
      const t = Math.min(1, Math.log2(1 + h) / Math.log2(1 + maxHit));
      // dark purple → magenta → amber heat ramp
      const r = Math.floor(40 + 215 * t);
      const g = Math.floor(10 + 150 * t * t);
      const b = Math.floor(60 + 60 * (1 - t));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(i * 2, y, 2, rowH);
    }
  });
  const total = snaps.reduce((n, s) => n + s.touched, 0);
  sum.textContent = `${heatmap.frames} samples — ${snaps.length} bank(s) executed, ${total} hot regions; hottest: bank ${snaps[0].bank}`;
}
$('heat-clear').addEventListener('click', () => { if (heatmap) { heatmap.reset(); renderHeatmap(); setStatus('heatmap cleared'); } });

// ---- ghost racer (race a translucent replay of your own recorded run) ----
const ghost = window.PocketGhost ? new window.PocketGhost.GhostRacer(gb) : null;
$('btn-ghost').addEventListener('click', () => {
  if (!romLoaded || !ghost) { setStatus('load a game first'); return; }
  if (ghost.active || ghost.armed) {
    ghost.stop();
    renderer.ghostFrame = null;
    $('ghost-status').classList.remove('on');
    $('ghost-pip').classList.remove('on');
    $('ghost-startnow').textContent = 'start now';
    setStatus('ghost race ended');
    return;
  }
  // fresh input each pick: re-selecting the same file fires no `change` on a
  // reused input (classic file-picker gotcha)
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.pgm';
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    if (!f) return;
    const buf = await f.arrayBuffer();
    const err = ghost.load(new Uint8Array(buf)); // loads + ARMS (does not move)
    if (err) { setStatus(err); return; }
    $('ghost-status').classList.add('on');
    $('ghost-pip').classList.add('on');
    $('ghost-startnow').textContent = 'start now';
    $('ghost-progress').textContent = 'armed';
    $('ghost-pip-label').textContent = 'ghost · armed';
    setStatus('ghost armed — press reset (or F8) to start the race together, or "start now" to begin from the recording anchor');
  });
  inp.click();
});

// Race banner buttons: launch now from the anchor, or disarm entirely.
$('ghost-startnow').addEventListener('click', () => {
  if (!ghost || !ghost.waitingForReset) { setStatus('no ghost armed'); return; }
  const err = ghost.startNow();
  if (err) { setStatus(err); return; }
  $('ghost-startnow').textContent = 'restart';
  $('ghost-progress').textContent = '0%';
  $('ghost-pip-label').textContent = 'ghost';
  setStatus('ghost race on — both timelines start from the recording anchor');
});
$('ghost-cancel').addEventListener('click', () => {
  if (!ghost) return;
  ghost.stop();
  renderer.ghostFrame = null;
  $('ghost-status').classList.remove('on');
  $('ghost-pip').classList.remove('on');
  $('ghost-startnow').textContent = 'start now';
  setStatus('ghost disarmed');
});

// ---- debugger controls ----
function dbgPause() { dbgRunning = false; setPaused(true); }
function dbgStep(n = 1) {
  dbgPause();
  for (let i = 0; i < n; i++) gb.stepInstruction();
  const fb = gb.ppu.colorFramebuffer || gb.ppu.framebuffer;
  renderer.blit(fb, gb.mmu.cgb);
  renderer.present();
  setStatus(`stepped ×${n} — PC=$${gb.cpu.pc.toString(16).toUpperCase().padStart(4, '0')}`);
  if (typeof debug !== 'undefined' && debug) debug.render();
}
$('bp-add').addEventListener('click', () => {
  const raw = ($('bp-input').value || '').replace(/^\$|0x/gi, '').trim();
  const v = parseInt(raw, 16);
  if (!Number.isFinite(v)) { setStatus('bad breakpoint address'); return; }
  gb.addBreakpoint(v);
  setStatus(`breakpoint $${v.toString(16).toUpperCase().padStart(4, '0')} set`);
  if (typeof debug !== 'undefined' && debug) debug.render();
});
$('bp-clear').addEventListener('click', () => { gb.clearBreakpoints(); setStatus('breakpoints cleared'); if (typeof debug !== 'undefined' && debug) debug.render(); });
$('bp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('bp-add').click(); });
$('dbg-step').addEventListener('click', () => dbgStep(1));
$('dbg-step8').addEventListener('click', () => dbgStep(8));
$('dbg-run').addEventListener('click', () => { dbgRunning = true; setPaused(false); setStatus('running to breakpoint…'); });
$('disasm-follow').addEventListener('click', () => {
  if (!debug) return;
  debug.followPc = !debug.followPc;
  $('disasm-follow').textContent = `follow PC: ${debug.followPc ? 'on' : 'off'}`;
});

function setStatus(text) { elStatus.textContent = text; }
capture.setOnStatus(setStatus);

function setTurbo(on) {
  turbo = on;
  speed = on ? 4 : Number(elSpeed.value) || 1;
  elTurboBadge.classList.toggle('on', on);
}
function setRewinding(on) {
  rewinding = on && romLoaded;
  // Rewinding time-travels the live machine; the ghost cannot follow its own
  // timeline backwards, so the attempt ends and re-arms (next reset relaunches).
  if (on && ghost && ghost.active) {
    ghost.hold();
    $('ghost-progress').textContent = 'armed';
    $('ghost-pip-label').textContent = 'ghost · armed';
  }
  if (on) audio.setMuted(true);
  else { audio.setMuted(muted); setStatus(`${fps} fps`); }
}

// ---- settings persistence (global + per-game) ----
const PER_GAME_KEYS = ['palette', 'scale', 'effects', 'shaderPackPath'];
function settingsKey(key) { return romInfo ? `game:${romInfo.statesKey}:${key}` : `global:${key}`; }

async function loadSetting(key, fallback) {
  const all = await window.pocketgb.getSettings();
  const v = all[settingsKey(key)] ?? all[`global:${key}`] ?? fallback;
  return v;
}
function saveSetting(key, value) {
  window.pocketgb.setSetting(settingsKey(key), value);
}

// ---- ROM loading ----
async function loadRom(info) {
  romInfo = info;
  let romBytes = new Uint8Array(info.bytes);
  if (info.patch && window.PocketPatch) {
    const res = window.PocketPatch.applyPatch(romBytes, new Uint8Array(info.patch));
    if (res.ok) {
      romBytes = res.bytes;
      setStatus(`patched with ${info.patchName} (${res.format})`);
    } else {
      setStatus(`patch failed: ${res.error} — loading unpatched`);
    }
  }
  const savData = info.savePath ? await window.pocketgb.readSav(info.savePath) : null;
  // fresh game: stop any run-scoped features tied to the previous ROM
  if (ghost && ghost.active) { ghost.stop(); renderer.ghostFrame = null; }
  const gstat = $('ghost-status'); if (gstat) gstat.classList.remove('on');
  const gpip = $('ghost-pip'); if (gpip) gpip.classList.remove('on');
  if (moviePlayer) { moviePlayer.reset(); }
  if (movieRecorder && movieRecorder.recording) { movieRecorder.recording = false; $('btn-movie-rec').textContent = 'record movie'; }
  capture.resetHistory();
  // authentic boot ROM (user-supplied dump), cached from a previous session
  let bootBytes = null;
  try {
    const b64 = await loadSetting('bootrom', null);
    if (b64) bootBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch { bootBytes = null; }
  gb.loadROM(romBytes, savData ? new Uint8Array(savData) : null, forceDmg, bootBytes);
  renderer.setSGB(gb.sgb || null);
  heatmap = window.PocketHeat ? new window.PocketHeat.CartridgeHeatmap(gb.cart) : null;
  romLoaded = true;
  paused = false;
  rewinding = false;
  $('btn-pause').textContent = 'pause';
  elRomName.textContent = (!titleLooksBroken(info.title) ? info.title : null) || info.name;
  showScreen(true);
  bootChimePlayed = !!bootBytes; // chime only accompanies the generated animation
  bootAnim = bootBytes ? null : new BootAnimation(gb.mmu.cgb); // no user boot ROM → generated intro
  audio.attach(gb.apu);
  audio.start();
  audio.setMuted(muted);
  startSavTimer();
  // load cheats saved for this game
  const saved = await loadSetting('cheats', []);
  gb.cheats.restore(saved);
  renderCheatList();
  // per-game settings
  if (!settingsLoaded) { await initSettings(); settingsLoaded = true; }
  for (const key of PER_GAME_KEYS) await applySetting(key);
  resizeCanvas();
}

// Two-note boot chime (E5→B5) through the WebAudio context — used only by
// the generated boot animation; a real boot ROM plays its own through the APU.
function playBootChime() {
  if (bootChimePlayed || !audio.ctx || muted) return;
  const hz = bootAnim && bootAnim.audio();
  if (!hz) return;
  bootChimePlayed = true;
  const osc = audio.ctx.createOscillator();
  const g = audio.ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(659, audio.ctx.currentTime);
  g.gain.setValueAtTime(0.0001, audio.ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.12, audio.ctx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.ctx.currentTime + 0.35);
  osc.frequency.setValueAtTime(880, audio.ctx.currentTime + 0.12);
  osc.connect(g); g.connect(audio.ctx.destination);
  osc.start(); osc.stop(audio.ctx.currentTime + 0.4);
}

function startSavTimer() {
  if (savTimer) clearInterval(savTimer);
  savTimer = setInterval(() => {
    if (gb.cart && gb.cart.dirty && romInfo && romInfo.savePath) {
      window.pocketgb.writeSav(romInfo.savePath, gb.cart.serializeSav());
      gb.cart.dirty = false;
    }
  }, 3000);
}

function flushSav() {
  if (gb.cart && romInfo && romInfo.savePath && (gb.cart.dirty || gb.cart.battery)) {
    window.pocketgb.writeSav(romInfo.savePath, gb.cart.serializeSav());
    gb.cart.dirty = false;
  }
}

// ---- reset / pause / mute ----
function resetGame() {
  if (!romLoaded) return;
  const romBytes = gb.cart.rom;
  const sav = gb.cart.battery ? gb.cart.serializeSav() : null;
  // reuse the boot ROM the game was loaded with (gb._bootBytes) so an in-app
  // reset replays the authentic boot sequence, not the generated animation
  gb.loadROM(romBytes, sav, forceDmg, gb._bootBytes || null);
  renderer.setSGB(gb.sgb || null);
  heatmap = window.PocketHeat ? new window.PocketHeat.CartridgeHeatmap(gb.cart) : null;
  renderHeatmap();
  rewind.reset();
  practice.onReset(); // loadless timing: the timer restarts on hard reset
  // the starting gun: an armed ghost launches with this reset so both
  // timelines (and the timer) begin at the same moment
  if (ghost && ghost.waitingForReset) {
    const err = ghost.startNow();
    if (!err) {
      $('ghost-progress').textContent = '0%';
      $('ghost-pip-label').textContent = 'ghost';
      setStatus('reset — ghost race started');
    }
  } else setStatus('reset');
}

// ---- speedrun practice kit ----
// Loadless timer anchored to hard resets, per-frame counter, and a toggleable
// in-game HUD (timer + best split + frames + input display) that stays on
// screen while you play. NOTE: the ms clock formatter is named fmtMS — the
// game clock panel already owns `fmtClock` in this shared classic-script
// scope, and a second `function fmtClock` silently shadows it (that bug made
// the timer read "day NaN, undefined:undefined:undefined").
const practice = {
  running: false,
  hudOn: false,
  startedAt: 0,        // performance.now() when the current attempt began
  elapsed: 0,          // frozen ms when stopped
  frames: 0,           // emulated frames this attempt
  best: null,          // best finished-attempt ms this session
  onFrame() {
    if (!romLoaded) return;
    this.frames++;
    if (this.hudOn) this.paintHud();
  },
  paintHud() {
    const t = this.running ? performance.now() - this.startedAt : this.elapsed;
    const timer = $('hud-timer'), best = $('hud-best'), fr = $('hud-frames');
    if (timer) timer.textContent = fmtMS(t);
    if (best) best.textContent = this.best != null ? `best ${fmtMS(this.best)}` : 'best —';
    if (fr) fr.textContent = `${this.frames}f`;
  },
  onReset() {
    // A reset *finishes* the previous attempt (that's the loadless split),
    // then starts the next one.
    if (this.running && (this.best == null || performance.now() - this.startedAt < this.best)) {
      this.best = performance.now() - this.startedAt;
    }
    this.frames = 0;
    this.startedAt = performance.now();
    this.running = true;
    if (this.hudOn) this.paintHud();
  },
  stop() { if (this.running) { this.elapsed = performance.now() - this.startedAt; this.running = false; } if (this.hudOn) this.paintHud(); },
  display() { return this.running ? performance.now() - this.startedAt : this.elapsed; },
  setHud(on) {
    this.hudOn = on;
    const hud = $('practice-hud');
    if (hud) hud.classList.toggle('on', on);
    $('prac-toggle').textContent = `show timer: ${on ? 'on' : 'off'}`;
    saveSetting('practiceHud', on);
    if (on) this.paintHud();
  },
};
function fmtMS(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, cs = Math.floor(ms / 10) % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function practiceHotReset() {
  if (!romLoaded) return;
  resetGame();
  setStatus('practice: attempt reset (F8)');
}

// ---- input display (practice panel + HUD; polled from the frame loop) ----
const INPUT_LABELS = [['right', '→'], ['left', '←'], ['up', '↑'], ['down', '↓'], ['a', 'A'], ['b', 'B'], ['start', 'st'], ['select', 'se']];
function renderInputDisplay() {
  const box = $('prac-inputs');
  if (!box) return;
  if (!box.children.length) {
    for (const [key, label] of INPUT_LABELS) {
      const s = document.createElement('span');
      s.className = 'inkey'; s.dataset.btn = key; s.textContent = label;
      box.appendChild(s);
    }
  }
  for (const s of box.children) s.classList.toggle('on', !!input.state[s.dataset.btn]);
  const hud = $('hud-inputs');
  if (hud && practice.hudOn) {
    if (!hud.children.length) {
      for (const [key, label] of INPUT_LABELS) {
        const s = document.createElement('span');
        s.className = 'inkey'; s.dataset.btn = key; s.textContent = label;
        hud.appendChild(s);
      }
    }
    for (const s of hud.children) s.classList.toggle('on', !!input.state[s.dataset.btn]);
  }
}

function setPaused(p) {
  paused = p;
  $('btn-pause').textContent = p ? 'resume' : 'pause';
  // the ghost freezes/resumes with the game so the race stays in lockstep
  if (ghost) { if (p) ghost.pause(); else ghost.resume(); }
  if (!p) { audio.resume(); lastFrameTime = performance.now(); }
  else setStatus('paused');
}

function setMuted(m) {
  muted = m;
  if (!rewinding) audio.setMuted(m);
  $('btn-mute').textContent = m ? 'unmute' : 'mute';
}

// ---- save states ----
function statePath(slot) {
  return `${romInfo.statesDir}/${romInfo.statesKey}.${slot}.state`;
}
// Downscale the presented canvas to a 160×144 PNG for the state picker.
function makeThumbnail() {
  try {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 144;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(elCanvas, 0, 0, 160, 144);
    return c.toDataURL('image/png').split(',')[1];
  } catch { return null; }
}
function doSaveState(slot) {
  if (!romLoaded) return;
  window.pocketgb.writeState(statePath(slot), gb.saveState(), makeThumbnail());
  setStatus(`state ${slot} saved`);
}
async function doLoadState(slot) {
  if (!romLoaded) return;
  const data = await window.pocketgb.readState(statePath(slot));
  if (!data) { setStatus(`slot ${slot} empty`); return; }
  try {
    gb.loadState(new Uint8Array(data));
    rewind.reset();
    setStatus(`state ${slot} loaded`);
  } catch (err) {
    setStatus(`load failed: ${err.message}`);
  }
}

// ---- library ----
async function showLibrary() {
  // leaving the playing view: drop any open overlay (menu, cheats, debug…)
  for (const o of document.querySelectorAll('.overlay.open')) o.classList.remove('open');
  debug.stop();
  if (ghost) { ghost.stop(); renderer.ghostFrame = null; }
  const gstat = $('ghost-status'); if (gstat) gstat.classList.remove('on');
  const gpip2 = $('ghost-pip'); if (gpip2) gpip2.classList.remove('on');
  showScreen(false);
  elLibGrid.textContent = '';
  const recent = await window.pocketgb.getSettings().then((s) => s['recent'] || []);
  if (!recent.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no recent roms yet — drop one here or press import';
    elLibGrid.appendChild(d);
    return;
  }
  // Same key derivation as main.js's romKey(): base64url of the lowercased path.
  function statesKeyFor(p) {
    try {
      return btoa(p.toLowerCase()).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch { return null; } // non-latin1 path: no thumbnails, plain card
  }
  for (const r of recent.slice(0, 12)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.title = r.path;
    card.addEventListener('click', () => window.pocketgb.openRomPath(r.path));
    // hover actions: clear saves / remove from library (clicking them must not open the game)
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const trashBtn = document.createElement('button');
    trashBtn.textContent = 'saves';
    trashBtn.title = 'Delete this game\'s saves and save-states';
    trashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteConfirm({ mode: 'saves', entry: r });
    });
    const xBtn = document.createElement('button');
    xBtn.textContent = '✕';
    xBtn.title = 'Remove from library (keeps the ROM file on disk)';
    xBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteConfirm({ mode: 'rom', entry: r });
    });
    actions.appendChild(trashBtn);
    actions.appendChild(xBtn);
    const galBtn = document.createElement('button');
    galBtn.textContent = 'shots';
    galBtn.title = 'Screenshot gallery';
    galBtn.addEventListener('click', (e) => { e.stopPropagation(); openGallery(r); });
    actions.appendChild(galBtn);
    card.appendChild(actions);
    // cover art: user-chosen screenshot first, else newest save-state thumbnail
    const key = statesKeyFor(r.path);
    let thumbB64 = key ? await window.pocketgb.readCover(r.path, key) : null;
    // (custom cover present — the card shows it directly; no state fallback)
    if (!thumbB64 && key) {
      try {
        const states = await window.pocketgb.listStates(key);
        const best = states.filter((s) => s.hasThumb).sort((a, b) => b.mtime - a.mtime)[0];
        if (best) thumbB64 = await window.pocketgb.readThumbnail(`${key}.${best.slot}.state`);
      } catch { /* thumbnail is optional */ }
    }
    if (thumbB64) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = `data:image/png;base64,${thumbB64}`;
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'thumb';
      ph.textContent = 'no save';
      card.appendChild(ph);
    }
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = (!titleLooksBroken(r.title) ? r.title : null) || basenameOf(r.path);
    card.appendChild(label);
    elLibGrid.appendChild(card);
  }
}

function showScreen(visible) {
  elLibrary.classList.toggle('hidden', visible);
  elBezel.classList.toggle('visible', visible);
  elSettings.classList.toggle('visible', visible);
  elLinks.classList.toggle('visible', visible);
  // the play row (screen + ghost PiP panel) follows the bezel's visibility
  const playRow = document.getElementById('play-row');
  if (playRow) playRow.classList.toggle('visible', visible);
  if (visible) resizeCanvas();
}

// ---- library deletion (two-step confirm) ----
let pendingDelete = null;
function openDeleteConfirm({ mode, entry }) {
  pendingDelete = { mode, entry };
  const title = $('del-title');
  const text = $('del-text');
  const yes = $('del-yes');
  const name = (!titleLooksBroken(entry.title) ? entry.title : null) || basenameOf(entry.path);
  if (mode === 'rom') {
    title.textContent = `remove "${name}"?`;
    text.textContent = 'The game disappears from your recent list and won\'t show up when you run PocketGB. Its saves and save-states are deleted too. The ROM file itself stays on disk.';
    yes.textContent = 'remove';
  } else {
    title.textContent = `delete saves for "${name}"?`;
    text.textContent = 'Deletes the battery save and every save-state (including their thumbnails) for this game. The game stays in your library.';
    yes.textContent = 'delete saves';
  }
  $('ov-del').classList.add('open');
}
function closeDeleteConfirm() {
  pendingDelete = null;
  $('ov-del').classList.remove('open');
}
async function confirmDelete() {
  if (!pendingDelete) { closeDeleteConfirm(); return; }
  const { mode, entry } = pendingDelete;
  const res = (mode === 'rom')
    ? await window.pocketgb.deleteRom(entry.path)
    : await window.pocketgb.deleteSaves(entry.path);
  closeDeleteConfirm();
  if (!res || !res.ok) { setStatus('delete failed'); return; }
  if (mode === 'rom') {
    const n = res.removed ? (res.removed.sav + res.removed.states) : 0;
    setStatus(n ? `removed — deleted ${n} save file${n === 1 ? '' : 's'}` : 'removed from library');
  } else {
    const n = res.removed ? (res.removed.sav + res.removed.states) : 0;
    setStatus(`deleted ${n} save file${n === 1 ? '' : 's'}`);
  }
  showLibrary(); // refresh the grid in place
}

// ---- cheats UI ----
function toggleOverlay(id) {
  const el = $(id);
  const open = !el.classList.contains('open');
  for (const o of document.querySelectorAll('.overlay')) o.classList.remove('open');
  if (open) {
    el.classList.add('open');
    if (id === 'ov-cheats') renderCheatList();
    if (id === 'ov-keys') renderBinds();
  }
}

function renderCheatList() {
  const list = $('cheat-list');
  list.textContent = '';
  const cheats = gb.cheats.all();
  for (let i = 0; i < cheats.length; i++) {
    const c = cheats[i];
    const row = document.createElement('div');
    row.className = 'cheat' + (c.enabled ? '' : ' off');
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = c.code;
    code.title = c.kind === 'gs'
      ? `gameshark: write 0x${c.value.toString(16)} to 0x${c.addr.toString(16)}`
      : `game genie: 0x${c.addr.toString(16)} → 0x${c.value.toString(16)}${c.compare !== null ? ` (if 0x${c.compare.toString(16)})` : ''}`;
    const toggle = document.createElement('button');
    toggle.textContent = c.enabled ? 'on' : 'off';
    toggle.addEventListener('click', () => { gb.cheats.toggle(i); persistCheats(); renderCheatList(); });
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', () => { gb.cheats.remove(i); persistCheats(); renderCheatList(); });
    row.appendChild(code); row.appendChild(toggle); row.appendChild(del);
    list.appendChild(row);
  }
  if (!cheats.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'no cheats yet';
    list.appendChild(d);
  }
}

function persistCheats() {
  saveSetting('cheats', gb.cheats.serialize());
}

function addCheat() {
  const inp = $('cheat-input');
  const err = $('cheat-err');
  const text = inp.value.trim();
  if (!text) return;
  const res = gb.cheats.add(text);
  if (res.error) { err.textContent = res.error; return; }
  err.textContent = '';
  inp.value = '';
  persistCheats();
  renderCheatList();
}

// ---- effects UI ----
// Shader pack state: the parsed pack (or null = built-in LCD shader) plus the
// file path it came from (for per-pack persistence + hot reload).
let shaderPackPath = null;
async function applyShaderPackFromText(text, path, quiet) {
  const parsed = window.PocketShaderPack.parseShaderPack(text);
  if (parsed.error) {
    $('fx-pack-err').textContent = parsed.error;
    if (!quiet) setStatus(`shader pack rejected: ${parsed.error}`);
    return false; // keep whatever pack was active before
  }
  $('fx-pack-err').textContent = '';
  renderer.setShaderPack(parsed);
  shaderPackPath = path || null;
  if (!fxOn()) $('fx-shader').value = 'on'; // a pack only shows with the shader enabled
  saveEffects();
  saveSetting('shaderPackPath', shaderPackPath);
  if (!quiet) setStatus(`shader pack: ${parsed.name}`);
  return true;
}
function clearShaderPack(quiet) {
  renderer.setShaderPack(null);
  shaderPackPath = null;
  saveSetting('shaderPackPath', null);
  $('fx-pack-err').textContent = '';
  if (!quiet) setStatus('shader pack cleared — built-in LCD shader');
}
function fxOn() { return $('fx-shader').value === 'on'; }
async function loadSavedShaderPack() {
  const p = await loadSetting('shaderPackPath', null);
  if (!p || !window.pocketgb.readShaderPack) return;
  const res = await window.pocketgb.readShaderPack(p);
  if (res && res.ok) await applyShaderPackFromText(res.text, p, true);
  else if (res && res.error) $('fx-pack-err').textContent = `saved pack unavailable: ${res.error}`;
}
$('fx-pack-load').addEventListener('click', async () => {
  const res = await window.pocketgb.openShaderPack();
  if (!res) return; // canceled
  if (!res.ok) { $('fx-pack-err').textContent = res.error; return; }
  await applyShaderPackFromText(res.text, res.path);
});
$('fx-pack-clear').addEventListener('click', () => clearShaderPack());
if (window.pocketgb.onShaderPackChanged) {
  window.pocketgb.onShaderPackChanged(async (p) => {
    const res = await window.pocketgb.readShaderPack(p);
    if (res && res.ok) await applyShaderPackFromText(res.text, p, true);
  });
}

async function initEffects() {
  const fx = await loadSetting('effects', { ghosting: false, scanlines: false, shader: false, curvature: false });
  $('fx-ghost').value = fx.ghosting ? 'on' : 'off';
  $('fx-scan').value = fx.scanlines ? 'on' : 'off';
  $('fx-shader').value = fx.shader ? 'on' : 'off';
  $('fx-curve').value = fx.curvature ? 'on' : 'off';
  renderer.setEffects(fx);
  await loadSavedShaderPack();
}
function saveEffects() {
  const fx = {
    ghosting: $('fx-ghost').value === 'on',
    scanlines: $('fx-scan').value === 'on',
    shader: $('fx-shader').value === 'on',
    curvature: $('fx-curve').value === 'on',
  };
  renderer.setEffects(fx);
  saveSetting('effects', fx);
}

// ---- bindings UI ----
const BTN_LABELS = { up: 'up', down: 'down', left: 'left', right: 'right', a: 'A', b: 'B', start: 'start', select: 'select' };
let listeningBtn = null;

function renderBinds() {
  const list = $('bind-list');
  list.textContent = '';
  for (const btn of Object.keys(BTN_LABELS)) {
    const row = document.createElement('div');
    row.className = 'bindrow';
    const label = document.createElement('span');
    label.className = 'k';
    label.textContent = BTN_LABELS[btn];
    const keys = document.createElement('span');
    keys.className = 'keys';
    for (const code of input.bindings[btn]) {
      const b = document.createElement('button');
      b.textContent = prettyKey(code);
      b.addEventListener('click', () => startListening(btn, code, b));
      keys.appendChild(b);
    }
    const add = document.createElement('button');
    add.textContent = '+ add';
    add.addEventListener('click', () => startListening(btn, null, add));
    keys.appendChild(add);
    row.appendChild(label); row.appendChild(keys);
    list.appendChild(row);
  }
}

function startListening(btn, oldCode, buttonEl) {
  document.querySelectorAll('.listening').forEach((el) => el.classList.remove('listening'));
  buttonEl.classList.add('listening');
  buttonEl.textContent = 'press…';
  const handler = (e) => {
    e.preventDefault(); e.stopPropagation();
    window.removeEventListener('keydown', handler, true);
    buttonEl.classList.remove('listening');
    if (e.code === 'Escape') { renderBinds(); return; }
    const bindings = JSON.parse(JSON.stringify(input.bindings));
    if (oldCode) bindings[btn] = bindings[btn].filter((c) => c !== oldCode);
    if (!bindings[btn].includes(e.code)) bindings[btn].push(e.code);
    input.setBindings(bindings);
    renderBinds();
  };
  window.addEventListener('keydown', handler, true);
}

function prettyKey(code) {
  return code.replace(/^Key/, '').replace(/^Arrow/, '').replace(/^Digit/, '')
    .replace('Enter', '↵').replace('Shift', '⇧').replace('Left', 'L').replace('Right', 'R')
    .replace('Up', '↑').replace('Down', '↓');
}

// ---- palette / scale / speed settings ----
const PALETTES = {
  dmg: [[155, 188, 15], [139, 172, 15], [48, 98, 48], [15, 56, 15]],
  pocket: [[224, 224, 208], [148, 148, 140], [84, 84, 88], [32, 32, 36]],
  ember: [[249, 223, 168], [235, 161, 92], [180, 74, 58], [40, 22, 28]],
};
async function initSettings() {
  elPalette.value = await loadSetting('palette', 'dmg');
  elScale.value = String(await loadSetting('scale', 0));
  elSpeed.value = String(await loadSetting('speed', 1));
  speed = Number(elSpeed.value) || 1;
  applyPalette();
  resizeCanvas();
}
async function applySetting(key) {
  if (key === 'palette') { elPalette.value = await loadSetting('palette', 'dmg'); applyPalette(); }
  if (key === 'scale') { elScale.value = String(await loadSetting('scale', 0)); resizeCanvas(); }
  if (key === 'effects') {
    const fx = await loadSetting('effects', { ghosting: false, scanlines: false, shader: false, curvature: false });
    $('fx-ghost').value = fx.ghosting ? 'on' : 'off';
    $('fx-scan').value = fx.scanlines ? 'on' : 'off';
    $('fx-shader').value = fx.shader ? 'on' : 'off';
    $('fx-curve').value = fx.curvature ? 'on' : 'off';
    renderer.setEffects(fx);
  }
  if (key === 'shaderPackPath') {
    const p = await loadSetting('shaderPackPath', null);
    if (p && p !== shaderPackPath && window.pocketgb.readShaderPack) {
      const res = await window.pocketgb.readShaderPack(p);
      if (res && res.ok) { await applyShaderPackFromText(res.text, p, true); return; }
    }
    if (!p) clearShaderPack(true);
  }
}
function applyPalette() {
  renderer.setPalette(PALETTES[elPalette.value] || PALETTES.dmg);
}

// ---- resize (fit or fixed scale) ----
function resizeCanvas() {
  if (!elBezel.classList.contains('visible')) return;
  const rect = elCenter.getBoundingClientRect();
  const availW = rect.width - 24, availH = rect.height - 24;
  const fixed = Number(elScale.value) || 0;
  const scale = fixed > 0 ? fixed : Math.max(1, Math.min(Math.floor(availW / 160), Math.floor(availH / 144)));
  elCanvas.style.width = `${160 * scale}px`;
  elCanvas.style.height = `${144 * scale}px`;
}

// ---- IPC wiring ----
window.pocketgb.onRomOpened((info) => loadRom(info));
if (pocketgb.onUpdateStatus) pocketgb.onUpdateStatus((text) => setStatus(text)); // auto-updater progress
window.pocketgb.onReset(() => resetGame());
window.pocketgb.onPause((p) => setPaused(p));
window.pocketgb.onMute((m) => setMuted(m));
window.pocketgb.onForceDmg((on) => {
  forceDmg = on;
  if (romLoaded) resetGame(); // apply immediately: reload with the new mode
});
window.pocketgb.onSaveState((slot) => doSaveState(slot));
window.pocketgb.onLoadState((slot) => doLoadState(slot));
window.pocketgb.onAppQuitting(() => flushSav());

// ---- UI events ----
$('btn-open').addEventListener('click', () => window.pocketgb.openRomDialog());
$('btn-reset').addEventListener('click', resetGame);
$('btn-pause').addEventListener('click', () => setPaused(!paused));
$('btn-mute').addEventListener('click', () => setMuted(!muted));
$('btn-library').addEventListener('click', showLibrary);
$('del-yes').addEventListener('click', confirmDelete);
$('del-no').addEventListener('click', closeDeleteConfirm);

// ---- game clock (RTC) control ----
function fmtClock(t) {
  const p = (n) => String(n).padStart(2, '0');
  const day = t.dl + (t.dayCarry ? 512 : 0);
  return `day ${day}, ${p(t.hour)}:${p(t.min)}:${p(t.sec)}${t.halt ? ' (halted)' : ''}`;
}
async function openClockPanel() {
  toggleOverlay('ov-clock');
  if (!romLoaded || !gb.cart || !gb.cart.hasRtc) {
    $('clock-readout').textContent = romLoaded ? 'this game has no real-time clock' : 'load a game first';
    $('clock-rate').disabled = true;
    return;
  }
  $('clock-rate').disabled = false;
  $('clock-rate').value = String(gb.cart.rtcRate || 1);
  $('clock-readout').textContent = fmtClock(gb.cart.getRtcTime());
  clearInterval(clockTickTimer);
  clockTickTimer = setInterval(() => {
    if (romLoaded && gb.cart && gb.cart.hasRtc) $('clock-readout').textContent = fmtClock(gb.cart.getRtcTime());
  }, 1000);
}
function setGameHour(h) {
  if (!romLoaded || !gb.cart || !gb.cart.hasRtc) return;
  gb.cart.setRtcTime({ hour: h, min: 0, sec: 0 });
  $('clock-readout').textContent = fmtClock(gb.cart.getRtcTime());
}
let clockTickTimer = null;
$('btn-clock').addEventListener('click', openClockPanel);
$('btn-printer').addEventListener('click', () => {
  setPrinterEnabled(!printerEnabled);
  $('btn-printer').textContent = `printer: ${printerEnabled ? 'on' : 'off'}`;
});

// ---- boot ROM (authentic Nintendo boot animation/chime, user-supplied dump) ----
async function updateBootRomButton() {
  const b64 = await loadSetting('bootrom', null);
  $('btn-bootrom').textContent = `boot rom: ${b64 ? 'on' : 'off'}`;
}
$('btn-bootrom').addEventListener('click', async () => {
  const b64 = await loadSetting('bootrom', null);
  if (b64) {
    await saveSetting('bootrom', null);
    updateBootRomButton();
    setStatus('boot ROM disabled — using fast boot');
    return;
  }
  // pick a file via a hidden input (File API; no dialog changes needed)
  let inp = document.getElementById('bootrom-file');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.id = 'bootrom-file'; inp.accept = '.bin,.rom,.gb';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length !== 0x100 && bytes.length !== 0x900 && bytes.length !== 0x800) {
        setStatus('not a boot ROM (expected 256 B DMG or 2 KB CGB dump)');
        return;
      }
      await saveSetting('bootrom', btoa(String.fromCharCode(...bytes)));
      updateBootRomButton();
      setStatus(`boot ROM loaded (${bytes.length} B) — reload the game`);
    });
  }
  inp.click();
});
updateBootRomButton();
$('clock-close').addEventListener('click', () => { clearInterval(clockTickTimer); toggleOverlay('ov-clock'); });
$('clock-back').addEventListener('click', () => { clearInterval(clockTickTimer); toggleOverlay('ov-menu'); openMenuSub('sub-hardware'); });
$('clock-rate').addEventListener('change', () => {
  if (romLoaded && gb.cart && gb.cart.hasRtc) gb.cart.setRtcRate(parseInt($('clock-rate').value, 10) || 1);
});
$('clock-day').addEventListener('click', () => setGameHour(6));
$('clock-night').addEventListener('click', () => setGameHour(18));
$('clock-noon').addEventListener('click', () => setGameHour(12));
$('btn-cheats').addEventListener('click', () => toggleOverlay('ov-cheats'));
$('btn-finder').addEventListener('click', () => toggleOverlay('ov-finder'));
$('btn-effects').addEventListener('click', () => toggleOverlay('ov-effects'));
$('btn-keys').addEventListener('click', () => toggleOverlay('ov-keys'));
$('btn-debug').addEventListener('click', () => {
  const ov = $('ov-debug');
  const open = !ov.classList.contains('open');
  toggleOverlay('ov-debug');
  if (open) debug.start(); else debug.stop();
});
$('debug-close').addEventListener('click', () => { toggleOverlay('ov-debug'); debug.stop(); });

// screenshot: canvas → PNG data URL → save dialog in main.
// Every shot is also filed into the per-game gallery (shotsDir) and can be
// picked as the game's cover art from the library.
$('btn-shot').addEventListener('click', async () => {
  const dataUrl = capture.screenshot();
  const b64 = dataUrl.split(',')[1];
  if (romInfo && window.pocketgb.saveShot) {
    const res = await window.pocketgb.saveShot(romInfo.statesKey, b64);
    if (res && res.ok) setStatus('screenshot saved to gallery');
  }
  const name = `pocketgb-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  window.pocketgb.saveFile(name, b64).then((p) => {
    if (p) setStatus(`also saved ${p.split('/').pop()}`);
  });
});

// ---- screenshot gallery (filmstrip + cover art) ----
let galleryKey = null, galleryRomPath = null, galleryCoverFile = null;
async function openGallery(entry) {
  galleryKey = statesKeyForEntry(entry);
  galleryRomPath = entry.path;
  $('gal-game').textContent = entry.title || basenameOf(entry.path);
  $('ov-gallery').classList.add('open');
  await renderGallery();
}
function statesKeyForEntry(entry) {
  try {
    return btoa(entry.path.toLowerCase()).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch { return null; }
}
async function renderGallery() {
  const film = $('gal-film');
  film.textContent = '';
  if (!galleryKey) { film.textContent = 'gallery unavailable'; return; }
  const [shots, coverB64] = await Promise.all([
    window.pocketgb.listShots(galleryKey),
    window.pocketgb.readCover(galleryRomPath, galleryKey),
  ]);
  if (!shots.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no screenshots yet — press screenshot while playing';
    film.appendChild(d);
    return;
  }
  for (const s of shots) {
    const wrap = document.createElement('div');
    wrap.className = 'shot';
    const b64 = await window.pocketgb.readShot(galleryKey, s.file);
    if (!b64) continue;
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${b64}`;
    img.alt = s.file;
    wrap.appendChild(img);
    if (coverB64 && s.file === galleryCoverFile) {
      const star = document.createElement('span');
      star.className = 'cover-star'; star.textContent = '★';
      wrap.appendChild(star);
    }
    const acts = document.createElement('div');
    acts.className = 'shot-actions';
    const coverBtn = document.createElement('button');
    coverBtn.textContent = '★ cover';
    coverBtn.title = "Use this shot as the game's cover art";
    coverBtn.addEventListener('click', async () => {
      const r = await window.pocketgb.setCover(galleryRomPath, galleryKey, s.file);
      if (r && r.ok) { galleryCoverFile = s.file; setStatus('cover art updated'); await renderGallery(); }
    });
    const delBtn = document.createElement('button');      delBtn.textContent = 'del';
    delBtn.title = 'Delete this screenshot';
    delBtn.addEventListener('click', async () => {
      await window.pocketgb.deleteShot(galleryKey, s.file);
      await renderGallery();
    });
    acts.appendChild(coverBtn); acts.appendChild(delBtn);
    wrap.appendChild(acts);
    film.appendChild(wrap);
  }
}
$('gal-close').addEventListener('click', () => $('ov-gallery').classList.remove('open'));

// gif: toggle recording of the last/next ~10s of frames
let gifRecording = false;
$('btn-gif').addEventListener('click', () => {
  gifRecording = !gifRecording;
  $('btn-gif').textContent = gifRecording ? 'stop gif' : 'record gif';
  if (gifRecording) capture.startGif();
  else capture.stopGif();
});

// webm: record video+audio going forward via MediaRecorder
let webmRecording = false;
$('btn-webm').addEventListener('click', () => {
  if (!webmRecording) {
    const track = audio.getRecordingTrack();
    if (capture.startWebm(track ? [track] : null)) {
      webmRecording = true;
      $('btn-webm').textContent = 'stop video';
    } else {
      setStatus('video capture unavailable');
    }
  } else {
    webmRecording = false;
    $('btn-webm').textContent = 'record video';
    capture.stopWebm();
  }
});
$('cheat-add').addEventListener('click', addCheat);
$('cheat-clear').addEventListener('click', () => { gb.cheats.clear(); persistCheats(); renderCheatList(); });
$('cheat-close').addEventListener('click', () => toggleOverlay('ov-cheats'));

// ---- cheat finder (RAM scanner → GameShark freeze) ----
const finder = window.PocketCheat ? new window.PocketCheat.CheatFinder(() => gb.mmu) : null;
function parseFinderValue(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/.test(s) || /^[0-9a-f]{1,2}$/.test(s)) return parseInt(s.replace(/^0x/, ''), 16);
  if (/^\d{1,3}$/.test(s)) return parseInt(s, 10);
  return NaN; // malformed → distinct from "empty"
}
function renderFinderList() {
  const list = $('finder-list');
  const err = $('finder-err');
  err.textContent = '';
  if (!finder || !finder.candidates) { list.textContent = 'no search yet'; return; }
  list.textContent = '';
  const entries = [...finder.candidates.entries()].slice(0, 200);
  if (!entries.length) { list.textContent = 'no candidates — reset and try again'; return; }
  for (const [addr] of entries) {
    const row = document.createElement('div');
    row.className = 'finder-row';
    const val = finder.read(addr);
    const a = document.createElement('span');
    a.textContent = `$${addr.toString(16).toUpperCase().padStart(4, '0')} = ${val.toString(16).padStart(2, '0')} (${val})`;
    const freeze = document.createElement('button');
    freeze.className = 'sbutton'; freeze.textContent = 'freeze';
    freeze.title = 'add a GameShark code that holds this address at its current value';
    freeze.addEventListener('click', () => {
      const r = finder.freeze(addr, gb.cheats);
      if (r && !r.error) { persistCheats(); renderCheatList(); setStatus(`froze $${addr.toString(16).toUpperCase().padStart(4, '0')} — see cheats`); }
      else err.textContent = (r && r.error) || 'freeze failed';
    });
    const watch = document.createElement('button');
    watch.className = 'sbutton'; watch.textContent = 'watch';
    watch.title = 'poll this address live in the watch list';
    watch.addEventListener('click', () => {
      if (!finder.watches.some((w) => w.addr === addr)) finder.watches.push({ addr });
      renderFinderWatches();
    });
    row.appendChild(a); row.appendChild(watch); row.appendChild(freeze);
    list.appendChild(row);
  }
  if (finder.candidates.size > 200) {
    const more = document.createElement('div');
    more.className = 'hint';
    more.textContent = `…and ${finder.candidates.size - 200} more — narrow further`;
    list.appendChild(more);
  }
}
function renderFinderWatches() {
  const list = $('finder-list');
  let watchBox = document.getElementById('finder-watches');
  if (!finder.watches.length) { if (watchBox) watchBox.remove(); return; }
  if (!watchBox) {
    watchBox = document.createElement('div');
    watchBox.id = 'finder-watches';
    list.parentElement.insertBefore(watchBox, list);
  }
  watchBox.textContent = '';
  for (const w of finder.watches) {
    const row = document.createElement('div');
    row.className = 'finder-row watch';
    const val = finder.read(w.addr);
    const label = document.createElement('span');
    label.textContent = `watch $${w.addr.toString(16).toUpperCase().padStart(4, '0')} = ${val} (0x${val.toString(16).padStart(2, '0')})`;
    const un = document.createElement('button'); un.className = 'sbutton'; un.textContent = 'unwatch';
    un.addEventListener('click', () => { finder.watches = finder.watches.filter((x) => x.addr !== w.addr); renderFinderWatches(); });
    row.appendChild(label); row.appendChild(un);
    watchBox.appendChild(row);
  }
}
setInterval(() => { if ($('ov-finder').classList.contains('open')) renderFinderWatches(); }, 250);
$('finder-search').addEventListener('click', () => {
  if (!finder) return;
  const v = parseFinderValue($('finder-input').value);
  if (v === null) { const n = finder.search(null); setStatus(`search: all ${n} addresses (unknown init)`); renderFinderList(); return; }
  if (Number.isNaN(v) || v < 0 || v > 255) { $('finder-err').textContent = 'enter 0-255 (decimal or 0x hex)'; return; }
  const n = finder.search(v);
  setStatus(`search: ${n} candidates = ${v}`);
  renderFinderList();
});
$('finder-unknown').addEventListener('click', () => {
  if (!finder) return;
  const n = finder.search(null);
  setStatus(`search: all ${n} addresses (unknown init)`);
  renderFinderList();
});
$('finder-narrow').addEventListener('click', () => {
  const row = $('finder-narrow-row'), hint = $('finder-narrow-hint');
  const show = row.style.display === 'none';
  row.style.display = show ? 'flex' : 'none';
  hint.style.display = show ? 'block' : 'none';
});
$('finder-apply').addEventListener('click', () => {
  if (!finder || !finder.candidates) { $('finder-err').textContent = 'search first'; return; }
  const op = $('finder-op').value;
  if (op === 'changed' || op === 'unchanged') {
    const n = finder.narrow({ op });
    setStatus(`narrow (${op}): ${n} candidates`);
    renderFinderList();
    return;
  }
  const v = parseFinderValue($('finder-narrow-val').value);
  if (v === null || Number.isNaN(v) || v < 0 || v > 255) { $('finder-err').textContent = 'enter 0-255 for this filter'; return; }
  const n = finder.narrow({ op, value: v });
  setStatus(`narrow: ${n} candidates`);
  renderFinderList();
});
$('finder-reset').addEventListener('click', () => {
  if (!finder) return;
  finder.reset(); finder.watches = [];
  $('finder-list').textContent = 'no search yet';
  renderFinderWatches();
  setStatus('finder reset');
});
$('finder-close').addEventListener('click', () => toggleOverlay('ov-finder'));

// ---- practice panel controls ----
$('btn-practice').addEventListener('click', () => {
  $('prac-timer').textContent = fmtMS(practice.display());
  $('prac-frames').textContent = `frame ${practice.frames}`;
  toggleOverlay('ov-practice');
});
$('prac-toggle').addEventListener('click', () => practice.setHud(!practice.hudOn));
$('prac-start').addEventListener('click', () => {
  if (!romLoaded) { setStatus('load a game first'); return; }
  if (practice.running) return;
  practice.startedAt = performance.now();
  practice.running = true;
  practice.paintHud();
  setStatus('practice timer started');
});
$('prac-stop').addEventListener('click', () => {
  practice.stop();
  $('prac-timer').textContent = fmtMS(practice.elapsed);
  setStatus(`practice stopped at ${fmtMS(practice.elapsed)}${practice.best != null ? ` — best split ${fmtMS(practice.best)}` : ''}`);
});
$('prac-reset').addEventListener('click', () => practiceHotReset());
$('prac-close').addEventListener('click', () => toggleOverlay('ov-practice'));
$('fx-close').addEventListener('click', () => toggleOverlay('ov-effects'));
$('keys-close').addEventListener('click', () => toggleOverlay('ov-keys'));
$('bind-reset').addEventListener('click', () => { input.setBindings(DEFAULT_BINDINGS); renderBinds(); });
$('cheat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCheat(); });
$('fx-ghost').addEventListener('change', saveEffects);
$('fx-scan').addEventListener('change', saveEffects);
$('fx-shader').addEventListener('change', saveEffects);
$('fx-curve').addEventListener('change', saveEffects);

elPalette.addEventListener('change', () => { applyPalette(); saveSetting('palette', elPalette.value); });
elScale.addEventListener('change', () => { resizeCanvas(); saveSetting('scale', Number(elScale.value)); });
elSpeed.addEventListener('change', () => { speed = Number(elSpeed.value) || 1; window.pocketgb.setSetting(`global:speed`, speed); });
loadSetting('practiceHud', false).then((on) => { if (on) practice.setHud(true); }).catch(() => {});

window.addEventListener('keydown', () => audio.resume(), { once: false });
window.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || e.target === document.body) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); e.stopPropagation();
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  if (window.PocketPatch) {
    const romFile = files.find((f) => !window.PocketPatch.isPatchPath(f.name));
    const patchFile = files.find((f) => window.PocketPatch.isPatchPath(f.name));
    if (romFile) {
      const buf = await romFile.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length < 0x150) { setStatus('not a GB ROM'); return; }
      const title = window.PocketTitle.extractRomTitle(bytes) || romFile.name;
      const key = `drop-${hashName(romFile.name)}`;
      let patchBuf = null, patchName = null;
      if (patchFile) { patchBuf = await patchFile.arrayBuffer(); patchName = patchFile.name; }
      else {
        // ROM-hack convention: <rom>.ips/.ups/.bps sitting next to the ROM file
        const base = romFile.name.replace(/\.[^.]+$/, '');
        const siblings = files.filter((f) => f !== romFile);
        const sib = siblings.find((f) => ['.ips', '.ups', '.bps', '.aps', '.rup', '.ppf', '.vcdiff', '.xdelta'].some((ext) => f.name.toLowerCase() === (base + ext).toLowerCase()));
        if (sib) { patchBuf = await sib.arrayBuffer(); patchName = sib.name; }
      }
      await loadRom({
        name: romFile.name,
        title,
        bytes: buf,
        patch: patchBuf,
        patchName,
        savePath: `${key}.sav`,
        statesDir: 'drop',
        statesKey: key,
      });
      return;
    }
  }
  const file = files[0];
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length < 0x150) { setStatus('not a GB ROM'); return; }
  const title = window.PocketTitle.extractRomTitle(bytes) || file.name;
  const key = `drop-${hashName(file.name)}`;
  await loadRom({
    name: file.name,
    title,
    bytes: buf,
    savePath: `${key}.sav`,
    statesDir: 'drop',
    statesKey: key,
  });
});

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

window.addEventListener('resize', resizeCanvas);

// ---- boot ----
// automated-probe hook (inert in production: nothing reads window.probeHook)
window.probeHook = {
  showLibrary,
  showScreen: () => showScreen(false),
  getRecent: async () => (await window.pocketgb.getSettings()).recent || [],
  statePath,
  doSaveState,
  openDeleteConfirm,
  closeDeleteConfirm,
  confirmDelete,
};
(async () => {
  await initSettings();
  await initEffects();
  await showLibrary();
})();

// Start loop
requestAnimationFrame(loop);

// Debug/probe hook: devtools and test probes can reach the machine + renderer
// (classic-script consts aren't on window). Harmless in normal use.
window.__pgb = { get gb() { return gb; }, get renderer() { return renderer; }, get romLoaded() { return romLoaded; }, audio, fpsGetter: () => fps, loadRom };
window.__pgbProbeLoad = async (p) => {
  const r = await fetch('file://' + p);
  const bytes = new Uint8Array(await r.arrayBuffer());
  await loadRom({ path: p, bytes, title: p.split('/').pop() });
  return bytes.length;
};
window.__pgbProbeLoadB64 = async (p, b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await loadRom({ path: p, bytes, title: p.split('/').pop() });
  return bytes.length;
};
