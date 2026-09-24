// PocketGB — CGB PPU: extends the DMG scanline renderer with Game Boy Color
// features. Reuses the parent's dot pipeline, window logic, and sprite picking
// verbatim; overrides only the parts where CGB hardware differs:
//   - 16 KB VRAM in two banks (VBK), tile data/map fetched per bank
//   - BG map attributes byte (palette, bank, flips, BG-priority)
//   - BG/OBJ palette RAM (BCPS/BGPD, OCPS/OCPD) instead of BGP/OBP gray codes
//   - BGR555 colorFramebuffer (what the UI displays for CGB games)
//   - CGB priority model: no OBJ-priority attribute; BG "TO-BG" priority flag;
//     OBJ always wins over BG color 0; OBJ color 0 is always transparent
//   - HDMA/GDMA (FF51-FF55): HBlank-chained or general-purpose VRAM copies
'use strict';

const _BasePPU = (typeof PPU !== 'undefined') ? PPU : require('./ppu').PPU;

const _SCREEN_W = 160, _SCREEN_H = 144;
const _MODE_HBLANK = 0;
const _OBJ_MARK = 0x20; // row[x] has an OBJ pixel (same encoding as the DMG PPU)
// NOTE: underscore-prefixed on purpose — the renderer loads every core file as a
// classic script in one shared scope, and ppu.js already declares bare top-level
// SCREEN_W/SCREEN_H/MODE_HBLANK/OBJ_MARK, so any same-named const here would
// throw a SyntaxError at load and take out every script after it (app.js included).

class CgbPPU extends _BasePPU {
  constructor(interrupt) {
    super(interrupt);
    this._oamIds = [];             // scratch reused by _cleanOAM (no per-line alloc)
    this.vram = new Uint8Array(0x4000);         // two 8 KB banks
    this.colorFramebuffer = new Uint32Array(_SCREEN_W * _SCREEN_H); // BGR555
    this.bgpd = new Uint8Array(64);             // 8 BG palettes × 4 colors × 2 bytes
    this.ocpd = new Uint8Array(64);             // 8 OBJ palettes
    this.rowAttrs = new Uint16Array(_SCREEN_W);  // BG attribute per pixel (for OBJ priority)
    this.bgpi = 0; this.ocpi = 0;               // palette RAM indices (BCPS/OCPS)
    this.bcpsIncrement = false; this.ocpsIncrement = false;
    this.vbk = 0;
    this.opri = 0;                              // FF6C bit0: 0 = OAM-order priority, 1 = X-coordinate
    // HDMA engine
    this.hdma1 = 0; this.hdma2 = 0; this.hdma3 = 0; this.hdma4 = 0; // staging regs
    this.hdmaActive = false;
    this.hdmaBlocksLeft = 0;
    this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaLastLine = -1;
    this.mmu = null;                            // set by GameBoy.loadROM (HDMA source reads)
    this.resetCgb();
  }

  resetCgb() {
    this.vbk = 0;
    this.bgpi = 0; this.ocpi = 0;
    this.bcpsIncrement = false; this.ocpsIncrement = false;
    this.opri = 0;
    this.hdmaActive = false; this.hdmaBlocksLeft = 0;
    this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaLastLine = -1;
    // Power-on palette defaults (SameBoy-style ramp): BG white/orange, OBJ accent
    this.bgpd.set([0xFF, 0x7F, 0xFF, 0x7F, 0xFF, 0x7F, 0x9D, 0x36], 0);
    this.ocpd.set([0xFF, 0x7F, 0xFF, 0x7F, 0x3E, 0x22, 0x3F, 0x3F], 0);
  }

  // ---- VRAM banking (VBK / FF4F) ----
  get vramBankOffset() { return (this.vbk & 1) << 13; }

  readVBK() { return 0xFE | (this.vbk & 1); }

  writeVBK(v) { this.vbk = v & 1; }

  readVRAM(a) { return this.vram[this.vramBankOffset + (a - 0x8000)]; }
  writeVRAM(a, v) { this.vram[this.vramBankOffset + (a - 0x8000)] = v; }

  // ---- BG palette RAM (FF68/FF69) ----
  writeBGPI(v) { this.bgpi = v & 0x3F; this.bcpsIncrement = !!(v & 0x80); }
  readBGPD() { return this.bgpd[this.bgpi]; }
  writeBGPD(v) { this.bgpd[this.bgpi] = v; if (this.bcpsIncrement) this.bgpi = (this.bgpi + 1) & 0x3F; }

  // ---- OBJ palette RAM (FF6A/FF6B) ----
  writeOCPI(v) { this.ocpi = v & 0x3F; this.ocpsIncrement = !!(v & 0x80); }
  readOCPD() { return this.ocpd[this.ocpi]; }
  writeOCPD(v) { this.ocpd[this.ocpi] = v; if (this.ocpsIncrement) this.ocpi = (this.ocpi + 1) & 0x3F; }

  // ---- HDMA/GDMA (FF51-FF55) ----
  writeHDMA1(v) { this.hdma1 = v; }
  writeHDMA2(v) { this.hdma2 = v; }
  writeHDMA3(v) { this.hdma3 = v; }
  writeHDMA4(v) { this.hdma4 = v; }

  writeHDMA5(v) {
    if (v & 0x80) {
      if (v & 0x40) {
        if (this.hdmaActive) this.hdmaActive = false; // halt; resume with bit6=0
      } else if (this.hdmaActive) {
        // already running: no effect
      } else if (this.hdmaBlocksLeft > 0) {
        this.hdmaActive = true; // resume a halted transfer
        this.hdmaLastLine = -1;
      } else {
        this._startHdma((v & 0x7F) + 1); // fresh HBlank-chained transfer
      }
      return;
    }
    // General purpose DMA: (v & 0x7F) + 1 blocks of 16 bytes, copied at once
    // (CPU is stalled for the duration on hardware).
    this._startHdma((v & 0x7F) + 1);
    const mmu = this.mmu;
    if (mmu) {
      let s = this.hdmaSrc, d = this.hdmaDst;
      const bankOff = this.vramBankOffset; // dest 8000-9FFF routes through VBK
      for (let b = 0; b < this.hdmaBlocksLeft; b++) {
        for (let i = 0; i < 16; i++) {
          this.vram[bankOff + (d & 0x1FFF)] = mmu.read(s);
          s = (s + 1) & 0xFFFF; d = (d + 1) & 0xFFFF;
        }
      }
    }
    this.hdmaBlocksLeft = 0;
    this.hdmaActive = false;
  }

  _startHdma(blocks) {
    let src = ((this.hdma1 << 8) | (this.hdma2 & 0xF0)) & 0xFFFF;
    if (src >= 0xE000 && src < 0xFE00) src &= ~0x2000; // echo RAM reads WRAM
    this.hdmaSrc = src;
    this.hdmaDst = (((this.hdma3 & 0x1F) << 8) | (this.hdma4 & 0xF0)) + 0x8000;
    this.hdmaBlocksLeft = blocks & 0x7F;
    this.hdmaActive = true;
    this.hdmaLastLine = -1;
  }

  readHDMA5() {
    if (this.hdmaActive) return 0x80 | ((this.hdmaBlocksLeft - 1) & 0x7F);
    if (this.hdmaBlocksLeft > 0) return (this.hdmaBlocksLeft - 1) & 0x7F; // halted
    return 0xFF; // inactive or completed
  }

  // Called once per CPU instruction group (from GameBoy's tick loop). At most
  // one 16-byte block per line: during an HBlank-chained transfer the next
  // block only goes out in a later line's HBlank. With the LCD off the
  // transfer runs continuously at GDMA speed.
  hdmaTick() {
    if (!this.hdmaActive || this.hdmaBlocksLeft === 0) return;
    const lcdOn = (this.lcdc & 0x80) !== 0;
    if (lcdOn) {
      if (this.mode !== _MODE_HBLANK) return;
      if (this.ly === this.hdmaLastLine) return; // one block per line
    }
    const mmu = this.mmu;
    if (!mmu) return;
    this.hdmaLastLine = this.ly;
    let s = this.hdmaSrc, d = this.hdmaDst;
    const bankOff = this.vramBankOffset; // dest 8000-9FFF routes through VBK
    for (let i = 0; i < 16; i++) {
      this.vram[bankOff + (d & 0x1FFF)] = mmu.read(s);
      s = (s + 1) & 0xFFFF; d = (d + 1) & 0xFFFF;
    }
    this.hdmaSrc = s; this.hdmaDst = d;
    if (--this.hdmaBlocksLeft <= 0) this.hdmaActive = false;
  }

  reset() {
    super.reset();
    if (this.colorFramebuffer) this.resetCgb(); // guard: called from base constructor
  }

  // ---- rendering ----

  // CGB difference: the background is ALWAYS enabled — LCDC bit 0 is only the
  // master priority switch here (consumed in _drawObj/_compositeLine). The
  // base class gates BG drawing on that bit (DMG behavior), so re-implement
  // the range logic with bgEnable forced on.
  _drawRange(startX, endX, y) {
    this.lastY = y;
    this.lastX = endX;
    if (startX >= endX) return;
    const lcdc = this.lcdc;
    const winEnable = (lcdc & 0x20) !== 0;
    const winY = this.wy + this.currentWy;
    const wx = this.wx - 7;
    if (winEnable && winY === y && wx <= endX) this.hasWindow = true;
    const winActive = winEnable && this.hasWindow && wx <= endX;
    if (winActive) {
      if (wx > 0) {
        this._drawBackground(startX, Math.min(wx, endX), this.scx, this.scy + y, (lcdc & 0x08) ? 0x1C00 : 0x1800);
      }
      this._drawBackground(Math.max(wx, startX), endX, -wx, y - winY, (lcdc & 0x40) ? 0x1C00 : 0x1800);
    } else {
      this._drawBackground(startX, endX, this.scx, this.scy + y, (lcdc & 0x08) ? 0x1C00 : 0x1800);
    }
  }

  // BG tile attributes: bits 0-2 palette, 3 VRAM bank, 5 X-flip, 6 Y-flip,
  // 7 BG-priority (BG wins over OBJ colors 1+ even without OBJ priority flag).
  _drawBackground(startX, endX, sx, sy, mapBase) {
    if (startX >= endX) return;
    const vram = this.vram;
    const attrBank = 0x2000;                  // attribute map: bank 1, +0x2000
    const signedTiles = (this.lcdc & 0x10) === 0;
    const topY = ((sy >> 3) & 31) * 32;
    const yInTile = sy & 7;
    const row = this.row, bgRow = this.bgRow, attrs = this.rowAttrs;
    let x = startX;
    while (x < endX) {
      // Pixels stay in one tile column until the next 8px boundary.
      const groupEnd = (((x + sx) & ~7) + 8) - sx;
      const end = groupEnd > endX ? endX : groupEnd;
      const col = ((x + sx) >> 3) & 31;
      const mapIdx = mapBase + topY + col;
      // Tile number always comes from VRAM bank 0; the attribute map sits in
      // bank 1 at the same offset.
      const tileNum = vram[mapIdx];
      const attr = vram[attrBank + mapIdx];
      const flipX = (attr & 0x20) !== 0;
      const flipY = (attr & 0x40) !== 0;
      const rowOff = (flipY ? 7 - yInTile : yInTile) * 2;
      const dataBank = (attr & 0x08) ? 0x2000 : 0;
      const addr = dataBank + (signedTiles ? 0x1000 + (((tileNum << 24) >> 24) * 16) : tileNum * 16) + rowOff;
      const lo = vram[addr], hi = vram[addr + 1];
      for (let px = x; px < end; px++) {
        const bit = flipX ? ((px + sx) & 7) : (7 - ((px + sx) & 7));
        const color = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        // row stays a plain color 0-3 (bits 2+ are reserved for OBJ marking;
        // the palette number lives in rowAttrs and is applied at composite).
        row[px] = color;
        bgRow[px] = color;
        attrs[px] = attr;
      }
      x = end;
    }
  }

  // Sprites + palette commit. On CGB the OBJ selection is the first 10 in OAM
  // order; priority among them depends on FF6C (OPRI): 0 = OAM order (boot
  // default), 1 = X coordinate then OAM index (DMG-style).
  _cleanOAM(y) {
    const oam = this.oam;
    const h = (this.lcdc & 0x04) ? 16 : 8;
    // Reused across lines: a fresh [] here allocates 144 arrays per frame.
    const ids = this._oamIds;
    ids.length = 0;
    for (let i = 0; i < 40 && ids.length < 10; i++) {
      const oy = oam[i * 4];
      if (y < oy - 16 || y >= oy - 16 + h) continue;
      if (this.opri) {
        // opri: sort by X then OAM index — insertion sort on the ≤10-element
        // scratch (key = unique (x<<7|i)) beats Array.sort + closure per line.
        const key = (oam[i * 4 + 1] << 7) | i;
        let j = ids.length;
        ids.push(key);
        while (j > 0 && ids[j - 1] > key) { ids[j] = ids[j - 1]; j--; }
        ids[j] = key;
      } else {
        ids.push(i);
      }
    }
    if (this.opri) {
      for (let i = 0; i < ids.length; i++) ids[i] &= 0x7F;
    }
    this.sortedSprites = ids;
  }

  // CGB OBJ rendering: VRAM bank from attribute, palette index in bits 0-2,
  // no OBP1 flag, no OBJ-priority encoding (priority resolved in _compositeLine).
  _drawObj(i, y, h16) {
    const oam = this.oam, vram = this.vram, row = this.row, bgRow = this.bgRow, attrs = this.rowAttrs;
    const masterPriority = (this.lcdc & 0x01) !== 0; // LCDC bit0: when clear, BG attr-7 is ignored
    const objX = oam[i * 4 + 1];
    const ix = objX - 8;
    const startX = Math.max(0, ix);
    const endX = Math.min(_SCREEN_W, objX);
    if (startX >= endX) return;
    const objY = oam[i * 4];
    const tile = oam[i * 4 + 2];
    const attr = oam[i * 4 + 3];
    const xFlip = (attr & 0x20) !== 0;
    const yFlip = (attr & 0x40) !== 0;
    const priority = (attr & 0x80) !== 0;
    // Palette number lives in bits 6-8 of row[x]: bits 3-5 would collide with
    // _OBJ_MARK (0x20), and the DMG OBP1/OBJ_PRIO bits (0x80/0x100) are unused
    // in the CGB subclass (no OBP1 flag; priority resolved via bgRow/attrs).
    const pal = (attr & 0x07) << 6;
    const objBank = (attr & 0x08) ? 0x2000 : 0;

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
    const base = objBank + objTile * 16 + bottomY * 2;
    const lo = vram[base], hi = vram[base + 1];

    for (let x = startX; x < endX; x++) {
      const bit = xFlip ? ((x - objX) & 7) : (7 - ((x - objX) & 7));
      const color = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      if (!color) continue;                             // OBJ color 0: transparent
      const current = row[x];
      if (current & _OBJ_MARK) continue;                 // higher-priority OBJ already there
      if (priority && masterPriority) {
        if ((bgRow[x] & 3) !== 0) continue;             // BG colors 1+ win over BG-priority OBJ
        if (attrs[x] & 0x80) continue;                  // BG TO-BG priority flag wins too
      }
      row[x] = _OBJ_MARK | color | pal;
    }
  }

  // Final mix: resolve BG/OBJ priority and commit palette-RAM colors (BGR555).
  _compositeLine() {
    const y = this.ly;
    if (y >= _SCREEN_H) return;
    const rowOff = y * _SCREEN_W;

    // Un-pushed tail (LCD just turned on mid-line etc.): BG color 0, no attrs.
    if (this.lastX < _SCREEN_W) {
      this.row.fill(0, this.lastX);
      this.bgRow.fill(0, this.lastX);
    }

    this._cleanOAM(y);
    const lcdc = this.lcdc;
    if ((lcdc & 0x02) && y < _SCREEN_H) {
      for (let s = 0; s < this.sortedSprites.length; s++) {
        this._drawObj(this.sortedSprites[s], y, (lcdc & 0x04) !== 0);
      }
    }

    const fb = this.colorFramebuffer, row = this.row, bgRow = this.bgRow, attrs = this.rowAttrs;
    const bgpd = this.bgpd, ocpd = this.ocpd;
    const masterPriority = (lcdc & 0x01) !== 0;
    for (let x = 0; x < _SCREEN_W; x++) {
      const v = row[x];
      let color;
      if (v & _OBJ_MARK) {
        const bgc = bgRow[x] & 3;
        if (bgc !== 0 && masterPriority && (attrs[x] & 0x80)) {
          const p = ((attrs[x] & 0x07) << 3) + (bgc << 1);
          color = bgpd[p] | (bgpd[p + 1] << 8);
        } else {
          const oi = (((v >> 6) & 7) << 3) | ((v & 3) << 1);
          color = ocpd[oi] | (ocpd[oi + 1] << 8);
        }
      } else {
        const p = ((attrs[x] & 0x07) << 3) + ((v & 3) << 1);
        color = bgpd[p] | (bgpd[p + 1] << 8);
      }
      fb[rowOff + x] = color;
    }
  }

  // LCD off: the color display shows the palette-RAM color 0 (white) like the
  // parent clears to its lightest shade.
  writeLCDC(v) {
    const wasOn = (this.lcdc & 0x80) !== 0;
    super.writeLCDC(v);
    if (wasOn && !(v & 0x80)) this.colorFramebuffer.fill(0x7FFF);
  }

  // Clear BG attributes for the next line so un-pushed tail pixels (and any
  // BG-disabled stretch) never inherit a stale palette/priority byte.
  lineDone() {
    super.lineDone();
    this.rowAttrs.fill(0);
  }
}

if (typeof module !== 'undefined') module.exports = { CgbPPU };
