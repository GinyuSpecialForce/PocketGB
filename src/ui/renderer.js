// PocketGB — renderer: canvas display with DMG palette, LCD effects, scaling
'use strict';

const DMG_PALETTE = [
  [155, 188, 15],   // 0 lightest
  [139, 172, 15],   // 1
  [48, 98, 48],     // 2
  [15, 56, 15],     // 3 darkest
];

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = 160; this.offscreen.height = 144;
    this.octx = this.offscreen.getContext('2d');
    this.imageData = this.octx.createImageData(160, 144);
    this.palRGB = new Uint32Array(4);
    this.setPalette(DMG_PALETTE);

    // ---- LCD effects ----
    this.effects = { ghosting: false, scanlines: false };
    this.ghostStrength = 0.45;   // how much of the previous frame bleeds through
    this.prevPx = null;          // previous frame's pixel buffer (Uint32Array)
    this.scanCanvas = document.createElement('canvas');
    this.scanCanvas.width = 160; this.scanCanvas.height = 144;
    this._buildScanlines();

    this.frameCount = 0;
  }

  setPalette(colors) {
    // canvas is little-endian ABGR packing
    for (let i = 0; i < 4; i++) {
      const [r, g, b] = colors[i];
      this.palRGB[i] = (0xFF << 24) | (b << 16) | (g << 8) | r;
    }
  }

  setEffects(e) {
    this.effects.ghosting = !!e.ghosting;
    this.effects.scanlines = !!e.scanlines;
    if (!this.effects.ghosting && this.prevPx) { this.prevPx = null; }
  }

  // Pre-render the scanline overlay once (every other row darkened ~18%).
  _buildScanlines() {
    const c = this.scanCanvas.getContext('2d');
    const img = c.createImageData(160, 144);
    const px = new Uint32Array(img.data.buffer);
    for (let y = 0; y < 144; y++) {
      const dark = (y & 1) === 1;
      // black with alpha 46/255 ≈ 18%
      const v = dark ? 0x2E000000 : 0x00000000;
      for (let x = 0; x < 160; x++) px[y * 160 + x] = v;
    }
    c.putImageData(img, 0, 0);
  }

  // fb is either a shade-index buffer (DMG, 1 byte/pixel) or a BGR555 color
  // buffer (CGB, 1 uint32/pixel). Blends ghosting with the previous frame.
  blit(fb, isColor) {
    if (!fb) return;
    if (!this.px) this.px = new Uint32Array(this.imageData.data.buffer);
    const px = this.px;
    const ghost = this.effects.ghosting && this.prevPx;
    if (isColor) {
      if (ghost) {
        const g = this.ghostStrength, ig = 1 - g, prev = this.prevPx;
        for (let i = 0; i < px.length; i++) {
          const cur = rgb555to888(fb[i]), old = prev[i];
          const r = (((cur & 0xFF) * ig + (old & 0xFF) * g) | 0);
          const gc = ((((cur >>> 8) & 0xFF) * ig + ((old >>> 8) & 0xFF) * g) | 0);
          const b = ((((cur >>> 16) & 0xFF) * ig + ((old >>> 16) & 0xFF) * g) | 0);
          px[i] = 0xFF000000 | (b << 16) | (gc << 8) | r;
        }
      } else {
        for (let i = 0; i < px.length; i++) px[i] = rgb555to888(fb[i]);
      }
    } else if (ghost) {
      // Mix each channel with the previous frame (LCD response-time ghosting).
      const g = this.ghostStrength;
      const ig = 1 - g;
      const prev = this.prevPx;
      for (let i = 0; i < px.length; i++) {
        const cur = this.palRGB[fb[i] & 3], old = prev[i];
        const r = (((cur & 0xFF) * ig + (old & 0xFF) * g) | 0);
        const gc = ((((cur >>> 8) & 0xFF) * ig + ((old >>> 8) & 0xFF) * g) | 0);
        const b = ((((cur >>> 16) & 0xFF) * ig + ((old >>> 16) & 0xFF) * g) | 0);
        px[i] = 0xFF000000 | (b << 16) | (gc << 8) | r;
      }
    } else {
      for (let i = 0; i < px.length; i++) px[i] = this.palRGB[fb[i] & 3];
    }
    if (this.effects.ghosting) {
      if (!this.prevPx) this.prevPx = new Uint32Array(px.length);
      this.prevPx.set(px);
    }
    this.octx.putImageData(this.imageData, 0, 0);
    this.frameCount++;
  }

  present() {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
    if (this.effects.scanlines) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.scanCanvas, 0, 0, this.canvas.width, this.canvas.height);
      ctx.imageSmoothingEnabled = false;
    }
  }

  drawBlank() {
    const px = new Uint32Array(this.imageData.data.buffer);
    px.fill(this.palRGB[0]);
    this.octx.putImageData(this.imageData, 0, 0);
    this.present();
  }
}

// Expand BGR555 to an xRGB888 canvas pixel (little-endian ABGR packing)
function rgb555to888(c) {
  const r5 = c & 0x1F, g5 = (c >> 5) & 0x1F, b5 = (c >> 10) & 0x1F;
  const r = (r5 << 3) | (r5 >> 2), g = (g5 << 3) | (g5 >> 2), b = (b5 << 3) | (b5 >> 2);
  return 0xFF000000 | (b << 16) | (g << 8) | r;
}

if (typeof module !== 'undefined') module.exports = { Renderer, DMG_PALETTE };
