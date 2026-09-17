// PocketGB — PPU (dot-driven scanline renderer, DMG)
// Draw path is a faithful port of mGBA's software renderer (the reference
// implementation dmg-acid2 targets): BG/window pixels are pushed as the PPU
// advances through mode 3, so mid-scanline LCDC/WX/SCX writes take effect at
// the right dot; the window internal-Y follows mGBA's UpdateWindow algorithm;
// sprites are picked (first 10, sorted by X then OAM index) at line start of
// the compositing edge and drawn with hardware priority rules.
'use strict';

const SCREEN_W = 160, SCREEN_H = 144;
const MODE_HBLANK = 0, MODE_VBLANK = 1, MODE_OAM = 2, MODE_DRAW = 3;
const DOTS_PER_LINE = 456;
const OBJ_MARK = 0x20;   // row[x] has an OBJ pixel
const OBJ_PRIO = 0x100;  // OBJ pixel has BG-priority attribute

class PPU {
  constructor(interrupt) {
    this.interrupt = interrupt;
    this.vram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xA0);
    this.framebuffer = new Uint8Array(SCREEN_W * SCREEN_H); // shade indices 0-3 (0 = lightest)
    this.row = new Uint16Array(SCREEN_W);    // mgba-style working row (BG color or OBJ-marked)
    this.bgRow = new Uint8Array(SCREEN_W);   // plain BG/window color per pixel (for final mix)
    this.sortedSprites = [];
    this.frameReady = false;
    this.reset();
  }

  reset() {
    this.lcdc = 0x91; this.stat = 0x85; // post-boot
    this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
    this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF;
    this.wy = 0; this.wx = 0; this.dma = 0;
    this.wly = 0;              // legacy window line counter (kept for API compat)
    this.statLine = false;     // previous ORed STAT interrupt line state (edge detect)
    this.dot = 0;              // dot within current line
    this.mode = MODE_OAM;
    this.currentWy = 0;        // window internal Y adjustment (mgba semantics)
    this.hasWindow = false;    // window activated this frame
    this.frameComplete = false;
    this.lastX = 0;            // next BG/window pixel to push this line
    this.lastY = SCREEN_H;
  }

  writeLCDC(v) {
    const wasOn = (this.lcdc & 0x80) !== 0;
    const isOn = (v & 0x80) !== 0;
    if (!wasOn && isOn) {
      // Power on: reset line/dot counters, mode 0
      this.lcdc = v;
      this.ly = 0; this.dot = 0; this.wly = 0;
      this.currentWy = 0; this.hasWindow = false;
      this.lastX = 0; this.lastY = SCREEN_H;
      this.setMode(MODE_HBLANK);
      return;
    }
    if (wasOn && this.mode === MODE_DRAW) this.pushDots(); // flush pixels drawn with old regs
    const oldWy = this.wy;
    const wasWin = this._inWindow();
    this.lcdc = v;
    this._updateWindow(wasWin, this._inWindow(), oldWy);
    if (wasOn && !isOn) {
      // Power off: LY=0, mode 0, screen cleared
      this.ly = 0; this.dot = 0; this.wly = 0;
      this.currentWy = 0; this.hasWindow = false;
      this.lastX = 0; this.lastY = SCREEN_H;
      this.setMode(MODE_HBLANK);
      this.framebuffer.fill(0);
      this.frameReady = true;
    }
  }

  writeSTAT(v) {
    this.stat = (this.stat & 0x87) | (v & 0x78);
    this.updateStatLine();
  }

  setMode(m) {
    this.mode = m;
    this.stat = (this.stat & 0xFC) | m;
    this.updateStatLine();
    if (m === MODE_VBLANK) this.interrupt.requestInterrupt(0);
  }

  // STAT interrupt: rising edge of the ORed interrupt line (coincidence, or the
  // relevant mode being active). Level-based re-checks must NOT re-fire while
  // coincidence stays true across a line's mode transitions.
  updateStatLine() {
    const coin = (this.ly === this.lyc);
    this.stat = (this.stat & ~0x04) | (coin ? 0x04 : 0);
    const s = this.stat;
    const line = (coin && (s & 0x40)) ||
                 ((s & 0x20) && this.mode === MODE_OAM) ||
                 ((s & 0x10) && this.mode === MODE_VBLANK) ||
                 ((s & 0x08) && this.mode === MODE_HBLANK);
    if (line && !this.statLine) this.interrupt.requestInterrupt(1);
    this.statLine = !!line;
  }

  readVRAM(a) { return this.vram[a - 0x8000]; }
  writeVRAM(a, v) { this.vram[a - 0x8000] = v; }
  readOAM(a) { return this.oam[a - 0xFE00]; }
  writeOAM(a, v) { this.oam[a - 0xFE00] = v; }

  // True when the PPU has no read-sensitive timing coming up soon (halt-skip ok).
  isIdle() {
    if (!(this.lcdc & 0x80)) return true;
    return (this.stat & 0x68) === 0; // mode0 OAM, mode0 HBLANK, LYC interrupts all off
  }

  // ---- mid-scanline register-write support (mgba semantics) ----

  _inWindow() {
    return (this.lcdc & 0x20) !== 0 && this.wx < SCREEN_W + 7;
  }

  // Adjust the window internal-Y when the window turns on/off mid-frame.
  // Ported from mGBA GBVideoSoftwareRendererUpdateWindow.
  _updateWindow(before, after, oldWy) {
    if (this.lastY >= SCREEN_H || !(after || before)) return;
    if (!this.hasWindow && this.lastX === SCREEN_W && this.lastY !== oldWy) return;
    if (this.lastY >= oldWy) {
      if (!after) {
        this.currentWy -= this.lastY;
        this.hasWindow = true;
      } else if (!before) {
        if (!this.hasWindow) {
          this.currentWy = this.lastY - this.wy;
          if (this.lastY >= this.wy && this.lastX > this.wx) ++this.currentWy;
        } else {
          this.currentWy += this.lastY;
        }
      } else if (this.wy !== oldWy) {
        this.currentWy += oldWy - this.wy;
        this.hasWindow = true;
      }
    }
  }

  writeWY(v) {
    if (this.mode === MODE_DRAW) this.pushDots();
    const oldWy = this.wy;
    const was = this._inWindow();
    this.wy = v;
    this._updateWindow(was, this._inWindow(), oldWy);
  }

  writeWX(v) {
    if (this.mode === MODE_DRAW) this.pushDots();
    const oldWy = this.wy;
    const was = this._inWindow();
    this.wx = v;
    this._updateWindow(was, this._inWindow(), oldWy);
  }

  writeSCX(v) {
    if (this.mode === MODE_DRAW) this.pushDots();
    this.scx = v;
  }

  writeSCY(v) {
    if (this.mode === MODE_DRAW) this.pushDots();
    this.scy = v;
  }

  // ---- dot pipeline ----

  tick(mCycles) {
    if (!(this.lcdc & 0x80)) return; // LCD off: timing frozen
    let remaining = mCycles;
    while (remaining > 0) {
      if (this.mode === MODE_DRAW) {
        const n = Math.min(remaining, 252 - this.dot);
        this.dot += n; remaining -= n;
        if (this.dot >= 252) {
          this.pushDots();          // finish the line's pixels
          this._compositeLine();    // sprites + palette commit for this line
          this.setMode(MODE_HBLANK);
        }
      } else {
        // OAM(0-79) / HBLANK(252-455): no pixel pushing, advance to boundary
        const boundary = this.mode === MODE_OAM ? 80 : DOTS_PER_LINE;
        const n = Math.min(remaining, boundary - this.dot);
        this.dot += n; remaining -= n;
        if (this.dot >= boundary) {
          if (this.mode === MODE_OAM) this.setMode(MODE_DRAW);
          else this.lineDone();
        }
      }
    }
  }

  // Push BG/window pixels up to the current dot (x = dot - 80 - 6).
  pushDots() {
    if (this.mode !== MODE_DRAW) return;
    const endX = Math.min(SCREEN_W, this.dot - 80 - 6);
    const startX = this.lastX;
    if (endX <= startX) return;
    this._drawRange(startX, endX, this.ly);
  }

  // Port of mGBA GBVideoSoftwareRendererDrawRange.
  _drawRange(startX, endX, y) {
    this.lastY = y;
    this.lastX = endX;
    if (startX >= endX) return;

    const lcdc = this.lcdc;
    const bgEnable = (lcdc & 0x01) !== 0;
    const winEnable = (lcdc & 0x20) !== 0;
    const winY = this.wy + this.currentWy;
    const wx = this.wx - 7;

    if (winEnable && winY === y && wx <= endX) this.hasWindow = true;
    const winActive = winEnable && this.hasWindow && wx <= endX;

    if (!bgEnable) {
      this.row.fill(0, startX, endX);
      this.bgRow.fill(0, startX, endX);
    }
    if (bgEnable && winActive) {
      if (wx > 0 && bgEnable) {
        this._drawBackground(startX, Math.min(wx, endX), this.scx, this.scy + y, (lcdc & 0x08) ? 0x1C00 : 0x1800);
      }
      this._drawBackground(Math.max(wx, startX), endX, -wx, y - winY, (lcdc & 0x40) ? 0x1C00 : 0x1800);
    } else if (bgEnable) {
      this._drawBackground(startX, endX, this.scx, this.scy + y, (lcdc & 0x08) ? 0x1C00 : 0x1800);
    }
  }

  // Port of mGBA GBVideoSoftwareRendererDrawBackground (DMG only).
  // Colors land in this.row[x] (0-3) and this.bgRow[x].
  _drawBackground(startX, endX, sx, sy, mapBase) {
    if (startX >= endX) return;
    const vram = this.vram;
    const signedTiles = (this.lcdc & 0x10) === 0;
    const topY = ((sy >> 3) & 31) * 32;
    const yInTile = sy & 7;
    const rowOff = yInTile * 2;
    const row = this.row, bgRow = this.bgRow;
    for (let x = startX; x < endX; x++) {
      const col = ((x + sx) >> 3) & 31;
      const tile = vram[mapBase + topY + col];
      const addr = (signedTiles ? 0x1000 + (((tile << 24) >> 24) * 16) : tile * 16) + rowOff;
      const bit = 7 - ((x + sx) & 7);
      const color = (((vram[addr + 1] >> bit) & 1) << 1) | ((vram[addr] >> bit) & 1);
      row[x] = color;
      bgRow[x] = color;
    }
  }

  // Sprites + palette commit. Runs once per line at the mode3→HBlank edge,
  // using the register/OAM-visible state at scan end (dmg-acid2 writes OAM
  // only during HBlank).
  _compositeLine() {
    const y = this.ly;
    if (y >= SCREEN_H) return;
    const rowOff = y * SCREEN_W;

    // Un-pushed tail (LCD just turned on mid-line etc.): color 0
    if (this.lastX < SCREEN_W) {
      this.row.fill(0, this.lastX);
      this.bgRow.fill(0, this.lastX);
    }

    this._cleanOAM(y);
    const lcdc = this.lcdc;
    if ((lcdc & 0x02) && y < SCREEN_H) {
      for (let s = 0; s < this.sortedSprites.length; s++) {
        this._drawObj(this.sortedSprites[s], y, (lcdc & 0x04) !== 0);
      }
    }

    const bgp = this.bgp, obp0 = this.obp0, obp1 = this.obp1;
    const fb = this.framebuffer, row = this.row, bgRow = this.bgRow;
    for (let x = 0; x < SCREEN_W; x++) {
      const v = row[x];
      let shade;
      if (v & OBJ_MARK) {
        const color = v & 3;
        const bg = bgRow[x];
        if (color !== 0 && !(v & OBJ_PRIO && bg !== 0)) {
          shade = ((v & 0x80) ? obp1 : obp0) >> (color * 2) & 3;
        } else {
          shade = (bgp >> (bg * 2)) & 3;
        }
      } else {
        shade = (bgp >> ((v & 3) * 2)) & 3;
      }
      fb[rowOff + x] = shade;
    }
  }

  // Port of mGBA _cleanOAM: first 10 sprites in OAM order, then sorted by
  // X (then OAM index). Lower sort key = higher priority.
  _cleanOAM(y) {
    const oam = this.oam;
    const h = (this.lcdc & 0x04) ? 16 : 8;
    const ids = [];
    for (let i = 0; i < 40 && ids.length < 10; i++) {
      const oy = oam[i * 4];
      if (y < oy - 16 || y >= oy - 16 + h) continue;
      ids.push((oam[i * 4 + 1] << 7) | i);
    }
    ids.sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) ids[i] &= 0x7F;
    this.sortedSprites = ids;
  }

  // Port of mGBA GBVideoSoftwareRendererDrawObj (DMG only).
  _drawObj(i, y, h16) {
    const oam = this.oam, vram = this.vram, row = this.row, bgRow = this.bgRow;
    const objX = oam[i * 4 + 1];
    const ix = objX - 8;
    let startX = Math.max(0, ix);
    const endX = Math.min(SCREEN_W, objX);
    if (startX >= endX) return;
    const objY = oam[i * 4];
    const tile = oam[i * 4 + 2];
    const attr = oam[i * 4 + 3];
    const xFlip = (attr & 0x20) !== 0;
    const yFlip = (attr & 0x40) !== 0;
    const priority = (attr & 0x80) !== 0;
    const palBit = (attr & 0x10) ? 0x80 : 0;

    let tileOffset = 0, bottomY;
    if (yFlip) {
      bottomY = 7 - ((y - objY - 16) & 7);
      if (h16 && y - objY < -8) tileOffset++;
    } else {
      bottomY = (y - objY - 16) & 7;
      if (h16 && y - objY >= -8) tileOffset++;
    }
    // 8x16 mode ignores tile bit 0: the pair is (tile & 0xFE, +1).
    const objTile = (h16 ? (tile & 0xFE) : tile) + tileOffset;
    const base = objTile * 16 + bottomY * 2;
    const lo = vram[base], hi = vram[base + 1];

    for (let x = startX; x < endX; x++) {
      const bit = xFlip ? ((x - objX) & 7) : (7 - ((x - objX) & 7));
      const color = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      if (!color) continue;
      const current = row[x];
      if (current & OBJ_MARK) continue;                 // higher-priority OBJ already here
      if (priority && (bgRow[x] & 3) !== 0) continue;   // BG-priority sprite hidden behind BG colors 1-3
      row[x] = OBJ_MARK | color | palBit | (priority ? OBJ_PRIO : 0);
    }
  }

  lineDone() {
    this.dot = 0;
    this.ly++;
    this.lastX = 0;
    if (this.ly === SCREEN_H) {
      this.setMode(MODE_VBLANK);
      this.frameComplete = true;
      this.frameReady = true;
      this.currentWy = 0;
      this.hasWindow = false;
      this.lastY = SCREEN_H;
    } else if (this.ly > 153) {
      this.ly = 0;
      this.setMode(MODE_OAM);
      this.frameComplete = false;
    } else {
      this.setMode(MODE_OAM);
    }
  }
}

PPU.SCREEN_W = SCREEN_W;
PPU.SCREEN_H = SCREEN_H;

if (typeof module !== 'undefined') module.exports = { PPU, SCREEN_W, SCREEN_H };
