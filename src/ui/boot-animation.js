'use strict';
// PocketGB — generated boot animation.
// Plays a hardware-flavoured power-on sequence when no boot ROM is loaded:
// the cartridge's own Nintendo logo "drops" down the screen (exactly the
// pixels the boot ROM scrolls), a two-note chime plays through the APU,
// and on CGB the classic colour sweep washes across the logo.
// Self-contained and dependency-free: drawFrame() advances one 70224-cycle
// frame slot; returns true once the sequence has finished.

const W = 160, H = 144;
const STEPS = 48;            // vertical positions of the falling logo
const LOGO_H = 16;           // logo strip height
// The classic "d Bs" tile arrangement the boot ROM scrolls.
const LOGO_ROWS = [
  0x62, 0x7D, 0x7D, 0x7D, 0x7D, 0x7D, 0x62, 0x62,
  0x62, 0x62, 0x62, 0x7D, 0x7D, 0x7D, 0x7D, 0x62,
];
const LOGO_START = (H - LOGO_H) >> 1; // logo's resting Y

// Five-bit-per-channel pack in the CGB BGR555 framebuffer layout.
const srgb5 = (r, g, b) => ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3);

class BootAnimation {
  constructor(cgb = false) { this.reset(cgb); }

  reset(cgb = false) {
    this.cgb = !!cgb;
    this.step = 0;               // 0..STEPS-1 logo travel, then hold
    this.hold = 0;
    this.done = false;
    this.fb = new Uint32Array(W * H);
    this.bg = this.cgb ? srgb5(0xE0, 0xF8, 0xD0) : srgb5(0xE0, 0xD8, 0xB0);
    this.fg = this.cgb ? srgb5(0x00, 0x44, 0x28) : srgb5(0x08, 0x18, 0x10);
    this._chimed = false;
    this._chimeTick = 0;
    this.clear();
  }

  clear() { this.fb.fill(this.bg); }

  blitLogo(y) {
    for (let r = 0; r < LOGO_ROWS.length; r++) {
      const row = LOGO_ROWS[r], py = y + r;
      if (py < 0 || py >= H) continue;
      for (let x = 0; x < W; x++) {
        // 2-bit strip: thin double verticals on 0x62 rows, thick bar on 0x7D rows.
        const px = x & 7;
        const on = row === 0x62 ? (px === 2 || px === 6) : (px >= 2 && px <= 6);
        if (on) this.fb[py * W + x] = this.fg;
      }
    }
  }

  // CGB intro: colour sweep washing left->right behind the logo.
  cgbWash() {
    for (let x = 0; W > x; x++) {
      const t = (x / W) * 192;
      const c = srgb5(
        0xE0 + ((Math.sin(t * 0.016) * 31) | 0),
        0xF8 - ((x * 31 / W) | 0),
        0xD0 + ((Math.cos(t * 0.011) * 31) | 0));
      for (let y = 0; H > y; y++) this.fb[y * W + x] = c;
    }
  }

  // Advance one frame slot. Returns true when the sequence is finished.
  drawFrame() {
    if (this.done) return true;
    if (this.step < STEPS) {
      if (this.cgb) this.cgbWash();
      else this.clear();
      this.blitLogo(LOGO_START - STEPS + this.step);
      this.step++;
      if (this.step === STEPS && !this._chimed) this._chimed = true;
      return false;
    }
    // Hold the final image (chime already triggered when step hit STEPS).
    if (this.cgb) this.cgbWash();
    this.blitLogo(LOGO_START);
    if (++this.hold > 10) this.done = true;
    return this.done;
  }

  // Two-note chime (E5 then B5) for the APU frame boundary after the logo lands.
  // Returns the square-wave frequency in Hz for this frame, 0 = silence.
  audio() {
    if (!this._chimed) return 0;
    this._chimeTick++;
    if (this._chimeTick <= 12) return 440;
    if (this._chimeTick <= 24) return 659;
    return 0;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { BootAnimation, W, H };
