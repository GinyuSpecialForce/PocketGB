// PocketGB — keyboard + gamepad input: remappable bindings, turbo, rewind, overlays
'use strict';

// Standard-gamepad mapping (Gamepad API "standard" layout)
const PAD_BUTTONS = {
  0: 'a',      // bottom face (A on Switch layout, B on Xbox layout — users can swap in bindings)
  1: 'b',      // right face
  2: 'select', // left face / share
  3: 'start',  // right face / options
  8: 'select', // back/share
  9: 'start',  // start/options
  12: 'up', 13: 'down', 14: 'left', 15: 'right', // d-pad
};
const PAD_AXES = { 0: ['left', 'right'], 1: ['up', 'down'] };

const DEFAULT_BINDINGS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  a: ['KeyX'], b: ['KeyZ'], start: ['Enter'], select: ['ShiftLeft', 'ShiftRight'],
};
if (typeof window !== 'undefined') window.DEFAULT_BINDINGS = DEFAULT_BINDINGS; // plain-script global

// Hotkeys are fixed (not remapped): Tab turbo, Backspace rewind, F2 cheats,
// F6 effects, F8 practice-reset, F10 keys. Listed here only so InputManager
// can ignore them when they collide with bindings.
const RESERVED = new Set(['Tab', 'Backspace', 'F2', 'F6', 'F8', 'F10']);

class InputManager {
  constructor() {
    this.state = { up: false, down: false, left: false, right: false, a: false, b: false, start: false, select: false };
    this.padState = { up: false, down: false, left: false, right: false, a: false, b: false, start: false, select: false };
    this.bindings = loadBindings();
    this.listeners = [];
    this.hotkeyListeners = [];
    this.gamepadEnabled = true;
    this._padPrev = '';
    window.addEventListener('keydown', (e) => this.handle(e, true));
    window.addEventListener('keyup', (e) => this.handle(e, false));
    window.addEventListener('blur', () => this.clearAll());
    this._padRAF = requestAnimationFrame(() => this.pollGamepad());
    // Focusing a text field releases held keys so a button pressed on the way
    // into the field can't get stuck down while the field swallows keyups.
    window.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) this.clearAll();
    });
  }

  // Gamepad: merged into the same state; last-pressed wins per button via OR.
  pollGamepad() {
    this._padRAF = requestAnimationFrame(() => this.pollGamepad());
    if (!this.gamepadEnabled) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const next = { up: false, down: false, left: false, right: false, a: false, b: false, start: false, select: false };
    for (const pad of pads) {
      if (!pad) continue;
      for (const [idx, btn] of Object.entries(PAD_BUTTONS)) {
        const b = pad.buttons[idx];
        if (b && (b.pressed || b.value > 0.5)) next[btn] = true;
      }
      if (pad.axes) {
        const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
        if (ax < -0.5) next.left = true; else if (ax > 0.5) next.right = true;
        if (ay < -0.5) next.up = true; else if (ay > 0.5) next.down = true;
      }
    }
    let changed = false;
    for (const k of Object.keys(next)) {
      if (this.padState[k] !== next[k]) { this.padState[k] = next[k]; changed = true; }
    }
    if (changed) this.emit();
  }

  emit() {
    // merge keyboard + gamepad states
    const merged = {};
    for (const k of Object.keys(this.state)) merged[k] = this.state[k] || this.padState[k];
    for (const l of this.listeners) l(merged);
  }

  handle(e, down) {
    // While the user is typing in a text field (cheat codes, breakpoints,
    // netplay address…), yield the whole keyboard: Backspace is bound to
    // rewind, arrows are the d-pad, Enter is Start, X/Z are A/B — all of
    // which would otherwise make the field unusable.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (RESERVED.has(e.code)) {
      // Fixed hotkeys live here so remapped game keys can never shadow them.
      if (e.code === 'Tab' || e.code === 'Backspace') {
        e.preventDefault();
        for (const l of this.hotkeyListeners) l(down ? (e.code === 'Tab' ? 'turbo-on' : 'rewind-on') : (e.code === 'Tab' ? 'turbo-off' : 'rewind-off'));
      } else if (down && (e.code === 'F2' || e.code === 'F6' || e.code === 'F8' || e.code === 'F10')) {
        e.preventDefault();
        const action = e.code === 'F2' ? 'cheats' : e.code === 'F6' ? 'effects' : e.code === 'F8' ? 'practice-reset' : 'keys';
        for (const l of this.hotkeyListeners) l(action);
      }
      return;
    }
    const btn = this.codeToButton(e.code);
    if (btn) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
      if (this.state[btn] !== down) {
        this.state[btn] = down;
        this.emit();
      }
    }
  }

  codeToButton(code) {
    for (const btn of Object.keys(this.bindings)) {
      if (this.bindings[btn].includes(code)) return btn;
    }
    return null;
  }

  setBindings(b) {
    // Release any buttons whose keys were just unbound, to avoid stuck input.
    for (const btn of Object.keys(this.state)) {
      if (!b[btn] || !b[btn].length) this.state[btn] = false;
    }
    this.bindings = normalizeBindings(b);
    saveBindings(this.bindings);
    for (const l of this.listeners) l(this.state);
  }

  clearAll() {
    for (const k of Object.keys(this.state)) this.state[k] = false;
    for (const k of Object.keys(this.padState)) this.padState[k] = false;
    this.emit();
  }

  onChange(cb) { this.listeners.push(cb); }
  onHotkey(cb) { this.hotkeyListeners.push(cb); }
}

function normalizeBindings(b) {
  const out = {};
  for (const btn of Object.keys(DEFAULT_BINDINGS)) {
    const list = Array.isArray(b?.[btn]) ? b[btn] : DEFAULT_BINDINGS[btn];
    out[btn] = list.filter((c) => typeof c === 'string' && c && !RESERVED.has(c));
    if (!out[btn].length) out[btn] = DEFAULT_BINDINGS[btn].slice();
  }
  return out;
}

function loadBindings() {
  try {
    const raw = localStorage.getItem('pocketgb.bindings');
    if (raw) return normalizeBindings(JSON.parse(raw));
  } catch (_) {}
  return normalizeBindings(DEFAULT_BINDINGS);
}

function saveBindings(b) {
  try { localStorage.setItem('pocketgb.bindings', JSON.stringify(b)); } catch (_) {}
}

if (typeof module !== 'undefined') module.exports = { InputManager, DEFAULT_BINDINGS };
