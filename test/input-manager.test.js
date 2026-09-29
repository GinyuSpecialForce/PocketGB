'use strict';
// Headless tests for InputManager (src/ui/input.js).
//
// Regression 1: pollGamepad()'s `next` literal doubles as the diff baseline
// against padState. It omitted l/r while PAD_BUTTONS maps buttons 4/5 to
// them, so a gamepad shoulder press went down but never came up — the key
// was added dynamically on press, then vanished from the fresh baseline on
// release, and the diff loop never reset padState.l/r.
//
// Regression 2: F7 (instant replay) was dispatched in handle() but missing
// from RESERVED, so the codeToButton lookup ate it before the hotkey branch.
const { test } = require('node:test');
const assert = require('node:assert');

function makeInputManager() {
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0; // constructor must not loop
  delete require.cache[require.resolve('../src/ui/input.js')];
  const { InputManager } = require('../src/ui/input.js');
  return new InputManager();
}

function setNavigator(v) {
  // Node ≥21 ships a getter-only global navigator; replace via defineProperty.
  Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true });
}

function fakePad(pressedIdx) {
  const buttons = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: i === pressedIdx, value: i === pressedIdx ? 1 : 0 });
  return { buttons, axes: [0, 0] };
}

test('gamepad L/R release clears padState (shoulder buttons do not stick)', () => {
  setNavigator({ getGamepads: () => [fakePad(4)] });
  const im = makeInputManager();
  im.pollGamepad();
  assert.strictEqual(im.padState.l, true, 'L pressed via gamepad button 4');
  setNavigator({ getGamepads: () => [fakePad(-1)] });
  im.pollGamepad();
  assert.strictEqual(im.padState.l, false, 'L released — must not stick');
  // and the same for R (button 5)
  setNavigator({ getGamepads: () => [fakePad(5)] });
  im.pollGamepad();
  assert.strictEqual(im.padState.r, true);
  setNavigator({ getGamepads: () => [fakePad(-1)] });
  im.pollGamepad();
  assert.strictEqual(im.padState.r, false, 'R released — must not stick');
});

test('F7 dispatches the instant-replay hotkey', () => {
  const im = makeInputManager();
  const seen = [];
  im.onHotkey((a) => seen.push(a));
  im.handle({ code: 'F7', target: {}, preventDefault() {} }, true);
  assert.deepStrictEqual(seen, ['instant-replay']);
  // hotkeys are not remappable: F7 must be filtered out of bindings
  const { DEFAULT_BINDINGS } = require('../src/ui/input.js');
  assert.ok(!JSON.stringify(DEFAULT_BINDINGS).includes('F7'));
});
