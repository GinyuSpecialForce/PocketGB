'use strict';
// Headless regression tests for Renderer.blit() (src/ui/renderer.js).
//
// The SGB branch of blit() (sgb && !isColor) wrote remapped pixels into
// this.px but never uploaded them: octx.putImageData + frameCount++ lived
// inside the non-SGB else branch, so with an SGB layer attached present()
// kept drawing a stale frame forever. The fake 2D canvas below COPIES
// putImageData source bytes into its backing store (like the real DOM), so
// a missing upload shows up as wrong pixels instead of silently passing.
const { test } = require('node:test');
const assert = require('node:assert');

class FakeImageData {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

function fakeCanvas(w, h) {
  const canvas = { width: w || 0, height: h || 0, _backing: null, _puts: 0 };
  const ctx = {
    imageSmoothingEnabled: false,
    createImageData: (w2, h2) => new FakeImageData(w2, h2),
    putImageData(img) {
      canvas._backing = new Uint8ClampedArray(img.data.length);
      canvas._backing.set(img.data); // copy: a real canvas does not alias
      canvas._puts++;
    },
    drawImage(src) { return src; },
    fillRect() {},
  };
  canvas.getContext = (type) => (type === '2d' ? ctx : null);
  return canvas;
}

// Load the real Renderer with a fake document providing createElement /
// getElementById (the module reads document at construction time only).
function makeRenderer() {
  const visible = fakeCanvas(160, 144);
  globalThis.document = {
    createElement: () => fakeCanvas(),
    getElementById: () => null,
  };
  try {
    delete require.cache[require.resolve('../src/ui/renderer.js')];
    const { Renderer } = require('../src/ui/renderer.js');
    const { SGB } = require('../src/core/sgb.js');
    return { r: new Renderer(visible), visible, SGB };
  } finally {
    delete globalThis.document;
  }
}

test('SGB blit uploads remapped pixels to the offscreen canvas', () => {
  const { r, visible, SGB } = makeRenderer();
  const sgb = new SGB(); // mask 0, default attr map → mapShade path
  r.setSGB(sgb);
  const fb = new Uint8Array(160 * 144);
  for (let i = 0; i < fb.length; i++) fb[i] = i & 3;
  r.blit(fb, false);
  assert.strictEqual(visible._puts, 0, 'blit uploads via the offscreen, not the visible canvas');
  const off = r.offscreen;
  assert.ok(off._puts >= 1, 'offscreen got a putImageData upload');
  const px = new Uint32Array(off._backing.buffer);
  let diff = 0;
  for (let i = 0; i < px.length; i++) if (px[i] !== r.px[i]) diff++;
  assert.strictEqual(diff, 0, 'offscreen matches the remapped framebuffer exactly');
});

test('SGB screen mask still uploads (black frame replaces stale content)', () => {
  const { r, SGB } = makeRenderer();
  const sgb = new SGB();
  r.setSGB(sgb);
  // First paint something non-black via the plain DMG path.
  const fb = new Uint8Array(160 * 144).fill(0); // shade 0 = lightest
  r.blit(fb, false);
  const px0 = new Uint32Array(r.offscreen._backing.buffer);
  assert.notStrictEqual(px0[0], 0xFF000000, 'sanity: plain path painted lightest');
  // Now mask the screen solid black and blit again — the upload must happen.
  sgb.mask = 2;
  r.blit(fb, false);
  const px1 = new Uint32Array(r.offscreen._backing.buffer);
  for (let i = 0; i < px1.length; i++) assert.strictEqual(px1[i], 0xFF000000);
});
