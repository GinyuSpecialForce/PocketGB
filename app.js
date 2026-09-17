// PocketGB — app controller (renderer side)
'use strict';

const gb = new GameBoy();
const renderer = new Renderer(document.getElementById('screen'));
const input = new InputManager();
const audio = new AudioManager();
const rewind = new RewindManager(gb);
const capture = new Capture(renderer, document.getElementById('screen'));
const debug = new DebugView(gb, renderer);
const apu = gb.apu;

let romInfo = null;
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
});

// ---- link cable ----
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
  const st = await window.pocketgb.linkJoin(Number.isFinite(port) ? port : 8765);
  updateLinkStatus();
  setStatus('link joining…');
}
function doLinkStop() {
  window.pocketgb.linkStop();
  linkHosting = 0;
  linkConnected = false;
  updateLinkStatus();
}

// the menu overlay has two panels: the button grid and the link-cable form
function showMenuPanel(id) {
  $('menu-panel').classList.toggle('hidden', id === 'link-panel');
  $('link-panel').classList.toggle('hidden', id !== 'link-panel');
}
$('btn-link').addEventListener('click', () => { updateLinkStatus(); showMenuPanel('link-panel'); });
$('link-back').addEventListener('click', () => showMenuPanel('menu-panel'));
$('link-host').addEventListener('click', doLinkHost);
$('link-join').addEventListener('click', doLinkJoin);
$('link-stop').addEventListener('click', doLinkStop);
$('link-close').addEventListener('click', () => { toggleOverlay('ov-menu'); showMenuPanel('menu-panel'); });
$('btn-more').addEventListener('click', () => { showMenuPanel('menu-panel'); toggleOverlay('ov-menu'); });
$('menu-close').addEventListener('click', () => toggleOverlay('ov-menu'));
// Escape closes whichever overlay is open (bind-capture handles its own Escape)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.overlay.open');
  if (!open) return;
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

  // Produce one frame per pacing tick minimum; produce extra frames in a
  // burst only while the audio buffer has room. The audio gate must never be
  // able to starve video: if the audio context is suspended or drains slowly,
  // the ring stays full — skipping production on that alone crawls at ~16 fps
  // (audio callbacks only fire 60–75×/s, never several times per video tick).
  const maxFrames = speed >= 4 ? 4 : speed >= 2 ? 2 : 1;
  const rate = apu.outputRate || 44100;
  const burst = audio.buffered() < rate * (turbo ? 0.02 : 0.15) ? maxFrames : 1;
  for (let i = 0; i < burst; i++) {
    const fb = gb.runFrame();
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

  if (t - fpsLast >= 500) {
    fps = Math.round(framesThisSecond * 1000 / (t - fpsLast));
    framesThisSecond = 0; fpsLast = t;
    if (!rewinding) setStatus(`${fps} fps`);
    elStatus.classList.toggle('live', fps >= 50);
  }
}
let framesThisSecond = 0, fpsLast = performance.now();

function setStatus(text) { elStatus.textContent = text; }
capture.setOnStatus(setStatus);

function setTurbo(on) {
  turbo = on;
  speed = on ? 4 : Number(elSpeed.value) || 1;
  elTurboBadge.classList.toggle('on', on);
}
function setRewinding(on) {
  rewinding = on && romLoaded;
  if (on) audio.setMuted(true);
  else { audio.setMuted(muted); setStatus(`${fps} fps`); }
}

// ---- settings persistence (global + per-game) ----
const PER_GAME_KEYS = ['palette', 'scale'];
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
  const romBytes = new Uint8Array(info.bytes);
  const savData = info.savePath ? await window.pocketgb.readSav(info.savePath) : null;
  gb.loadROM(romBytes, savData ? new Uint8Array(savData) : null, forceDmg);
  romLoaded = true;
  paused = false;
  rewinding = false;
  $('btn-pause').textContent = 'pause';
  elRomName.textContent = info.title || info.name;
  showScreen(true);
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
  gb.loadROM(romBytes, sav, forceDmg);
  rewind.reset();
  setStatus('reset');
}

function setPaused(p) {
  paused = p;
  $('btn-pause').textContent = p ? 'resume' : 'pause';
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
    trashBtn.textContent = '🗑';
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
    card.appendChild(actions);
    // cover art: the newest save-state thumbnail for this game, if any
    const key = statesKeyFor(r.path);
    let thumbB64 = null;
    if (key) {
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
    label.textContent = r.title || r.path.split('/').pop();
    card.appendChild(label);
    elLibGrid.appendChild(card);
  }
}
function showScreen(visible) {
  elLibrary.classList.toggle('hidden', visible);
  elBezel.classList.toggle('visible', visible);
  elSettings.classList.toggle('visible', visible);
  elLinks.classList.toggle('visible', visible);
  if (visible) resizeCanvas();
}

// ---- library deletion (two-step confirm) ----
let pendingDelete = null;
function openDeleteConfirm({ mode, entry }) {
  pendingDelete = { mode, entry };
  const title = $('del-title');
  const text = $('del-text');
  const yes = $('del-yes');
  const name = entry.title || entry.path.split('/').pop();
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
async function initEffects() {
  const fx = await loadSetting('effects', { ghosting: false, scanlines: false, shader: false, curvature: false });
  $('fx-ghost').value = fx.ghosting ? 'on' : 'off';
  $('fx-scan').value = fx.scanlines ? 'on' : 'off';
  $('fx-shader').value = fx.shader ? 'on' : 'off';
  $('fx-curve').value = fx.curvature ? 'on' : 'off';
  renderer.setEffects(fx);
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
$('btn-cheats').addEventListener('click', () => toggleOverlay('ov-cheats'));
$('btn-effects').addEventListener('click', () => toggleOverlay('ov-effects'));
$('btn-keys').addEventListener('click', () => toggleOverlay('ov-keys'));
$('btn-debug').addEventListener('click', () => {
  const ov = $('ov-debug');
  const open = !ov.classList.contains('open');
  toggleOverlay('ov-debug');
  if (open) debug.start(); else debug.stop();
});
$('debug-close').addEventListener('click', () => { toggleOverlay('ov-debug'); debug.stop(); });

// screenshot: canvas → PNG data URL → save dialog in main
$('btn-shot').addEventListener('click', () => {
  const dataUrl = capture.screenshot();
  const name = `pocketgb-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  window.pocketgb.saveFile(name, dataUrl.split(',')[1]).then((p) => {
    setStatus(p ? `saved ${p.split('/').pop()}` : 'save canceled');
  });
});

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

window.addEventListener('keydown', () => audio.resume(), { once: false });
window.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || e.target === document.body) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); e.stopPropagation();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length < 0x150) { setStatus('not a GB ROM'); return; }
  let title = '';
  for (let i = 0x134; i <= 0x142; i++) { const ch = bytes[i]; if (ch >= 32 && ch < 127) title += String.fromCharCode(ch); }
  title = title.trim() || file.name;
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
