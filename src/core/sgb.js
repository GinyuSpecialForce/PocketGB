// PocketGB — Super Game Boy layer: command packets, palettes, attributes,
// custom borders, screen mask, and multiplayer (MLT_REQ) detection.
//
// The SGB is an ICD2 bridge between a GB CPU and SNES video. Games talk to it
// by bit-banging P14/P15 (JOYP bits 4-5): a both-low pulse resets the packet
// receiver, then 128 data bits follow LSB-first (P14 low = 0, P15 low = 1).
// Command byte = cmd*8 + packet-count; multi-packet groups (length > 1) chain
// 16-byte continuation packets. We decode a fixed, games-actually-use-them
// subset: PAL01/23/03/12, PAL_SET, PAL_TRN, ATTR_BLK/LIN/DIV/CHR, ATTR_TRN,
// ATTR_SET, CHR_TRN, PCT_TRN, MASK_EN, MLT_REQ. Everything else is acked and
// ignored (the real system software treats unknowns the same way).
//
// Rendering contract with the renderer: on DMG shade indices we apply the
// active SGB palettes via `mapShade(shade, palIndex)`; the border (when
// transferred) is composited by the renderer from `borderImage` state.
// Spec: Pan Docs "SGB Functions" (gbdev.gg8.se wiki snapshot, cross-checked
// against the gbdev.io living document).
'use strict';

const SGB_W = 32, SGB_H = 28;   // SNES map in tiles
const GB_COLS = 20, GB_ROWS = 18;
const GB_X0 = 6, GB_Y0 = 5;     // GB window origin inside the 32x28 map

class SGB {
  constructor() {
    this.reset();
  }

  reset() {
    // ---- packet transport ----
    this.p14 = true; this.p15 = true;   // idle high (active-low lines)
    this.packet = new Uint8Array(16);
    this.bitPos = 0;                    // bits written into the current packet
    // Multi-packet command buffering: hardware accumulates the whole command
    // group (up to 7 packets / 112 bytes) and executes the command ONCE with
    // the full parameter block. Executing early would both read out of bounds
    // and re-parse continuation bytes as a new command header.
    this.cmdBuf = new Uint8Array(7 * 16);
    this.cmdLen = 0;                    // bytes buffered for the active command
    this.cmdExpected = 0;               // total packets the command declares
    this.cmdActive = false;
    this.cmd = 0;                       // command code being accumulated
    // ---- palettes ----
    // 4 game-screen palettes (we use colors 0-3) + 4 border palettes (16 each).
    // Stored BGR555 like the CGB; color 0 is the shared backdrop. Hardware
    // boots the screen palettes to the grayshade ramp (white/light/dark/black),
    // so pre-palette frames render gray, not black.
    this.palData = new Uint16Array(8 * 16);
    for (let p = 0; p < 4; p++) {
      const gray = [0x7FFF, 0x56B5, 0x294A, 0x0000];
      for (let c = 0; c < 4; c++) this.palData[p * 16 + c] = gray[c];
    }
    this.active = [0, 1, 2, 3];         // PAL_SET: which system palettes map to 0-3
    this.systemPal = new Uint16Array(512 * 4); // PAL_TRN system palette memory
    // ---- attribute map (per-tile palette 0-3, 20x18) ----
    this.attrMap = new Uint8Array(GB_COLS * GB_ROWS);
    this.atf = [];                      // 45 attribute files (90 bytes each)
    for (let i = 0; i < 45; i++) this.atf.push(new Uint8Array(GB_COLS * GB_ROWS));
    // ---- border ----
    this.borderTiles = null;            // Uint8Array 128*32*2 planes (SNES 4bpp) when transferred
    this.borderMap = null;              // Uint16Array 32*28 entries
    this.borderPal = null;              // Uint16Array 4*16 (palettes 4-7)
    this.borderDirty = false;           // renderer should rebuild its border bitmap
    this.mask = 0;                      // 0 off, 1 freeze, 2 black, 3 color0
    this.frozen = null;                 // shade snapshot for MASK_EN=1
    // ---- multiplayer ----
    this.mltPlayers = 1;                // 1, 2 or 4
    this.joyId = 0;                     // increments when both P14/P15 go high mid-read
  }

  // ---- transport: call for every JOYP (FF00) write ----
  writeP14P15(v) {
    const p14 = (v & 0x10) !== 0, p15 = (v & 0x20) !== 0;
    const bothHighPrev = this.p14 && this.p15;
    this.p14 = p14; this.p15 = p15;
    if (p14 && p15) {
      // Both high: between-bits idle; in multiplayer mode this edge advances
      // the joypad selector (games pulse it between reads).
      if (this.mltPlayers > 1 && !bothHighPrev) {
        this.joyId = (this.joyId + 1) % this.mltPlayers;
      }
      return;
    }
    if (!p14 && !p15) {
      // Both low = RESET pulse: realign the bit receiver. It precedes EVERY
      // packet — including continuations of a multi-packet group — so it must
      // NOT abort the accumulated command; only the bit counter restarts.
      this.bitPos = 0;
      return;
    }
    // Data bit (only meaningful while a packet is open; a stray bit before
    // any reset is ignored like real hardware's shift register would be).
    const bit = p15 ? 0 : 1; // P14 low = 0, P15 low = 1
    if (this.bitPos >= 128) return;
    const byte = this.bitPos >> 3, bitIn = this.bitPos & 7;
    if (bit) this.packet[byte] |= (1 << bitIn);
    else this.packet[byte] &= ~(1 << bitIn);
    this.bitPos++;
    if (this.bitPos === 128) this.onPacket();
  }

  onPacket() {
    const len = this.packet[0] & 7;
    if (!this.cmdActive) {
      // First packet of a group: buffer it and wait for declared continuations.
      this.cmdActive = true;
      this.cmd = this.packet[0] >> 3;
      this.cmdExpected = len;
      this.cmdLen = 16;
      this.cmdBuf.set(this.packet, 0);
    } else {
      // Continuation: append raw bytes — it has no header of its own.
      if (this.cmdLen < this.cmdBuf.length) {
        this.cmdBuf.set(this.packet, this.cmdLen);
        this.cmdLen += 16;
      }
    }
    if (this.cmdLen >= this.cmdExpected * 16) {
      // Whole group received: execute once with the complete parameter block.
      const view = this.cmdLen === 16 ? this.cmdBuf.subarray(0, 16) : this.cmdBuf.subarray(0, this.cmdLen);
      this.exec(this.cmd, view);
      this.cmdActive = false;
      this.cmdLen = 0;
      this.cmdExpected = 0;
    }
  }

  // ---- VRAM transfer hook: the renderer/game passes 4 KB from 8000-8FFF ----
  vramTransfer() {
    // The last _TRN command decides what this block becomes. We keep a latch.
    return this.pendingTrn;
  }

  // ---- command decoder ----
  exec(cmd, p) {
    switch (cmd) {
      case 0x00: this.setPalSmall(p, 0, 1); break;         // PAL01
      case 0x01: this.setPalSmall(p, 2, 3); break;         // PAL23
      case 0x02: this.setPalSmall(p, 0, 3); break;         // PAL03
      case 0x03: this.setPalSmall(p, 1, 2); break;         // PAL12
      case 0x04: this.attrBlk(p); break;
      case 0x05: this.attrLin(p); break;
      case 0x06: this.attrDiv(p); break;
      case 0x07: this.attrChr(p); break;
      case 0x0A: this.palSet(p); break;
      case 0x0B: this.pendingTrn = 'pal'; break;           // PAL_TRN
      case 0x11: this.mltReq(p); break;
      case 0x13: this.pendingTrn = p[1] & 2 ? 'chr-obj' : 'chr-bg'; break; // CHR_TRN
      case 0x14: this.pendingTrn = 'pct'; break;           // PCT_TRN
      case 0x15: this.pendingTrn = 'attr'; break;          // ATTR_TRN
      case 0x16: this.attrSet(p); break;
      case 0x17: this.maskEn(p); break;
      default: break; // SOUND, ICON_EN, DATA_SND, JUMP, OBJ_TRN…: ignored
    }
  }

  // PAL01/23/03/12: 7 colors — 4 for the first palette (incl. color 0), 3 for the second.
  setPalSmall(p, palA, palB) {
    let o = 1;
    for (let c = 0; c < 4; c++, o += 2) this.palData[palA * 16 + c] = p[o] | (p[o + 1] << 8);
    for (let c = 1; c < 4; c++, o += 2) this.palData[palB * 16 + c] = p[o] | (p[o + 1] << 8);
  }

  palSet(p) {
    // Copy the named system palettes into the visible screen palettes
    // (hardware: PAL_SET copies 4 colors from system palette RAM).
    for (let i = 0; i < 4; i++) {
      const np = (p[1 + i * 2] | (p[2 + i * 2] << 8)) & 0x1FF;
      this.active[i] = np;
      for (let c = 0; c < 4; c++) this.palData[i * 16 + c] = this.systemPal[np * 4 + c];
    }
    // Attribute-file / cancel-mask bits (byte 9 bit 6/7) apply after palettes.
    if (p[9] & 0x40) this.mask = 0;
  }

  attrSet(p) {
    const n = p[1] & 0x3F;
    if (p[1] & 0x40) this.mask = 0;
    if (n < 45) this.attrMap.set(this.atf[n]);
  }

  mltReq(p) {
    const mode = p[1] & 3;
    this.mltPlayers = mode === 3 ? 4 : mode === 1 ? 2 : 1;
    this.joyId = 0;
  }

  maskEn(p) {
    this.mask = p[1] & 3;
    if (this.mask === 0) this.frozen = null;
  }

  // freeze: renderer calls back with the current shade buffer
  freeze(fb) { if (this.mask === 1) { this.frozen = fb.slice(); this.borderDirty = false; } }

  // ---- ATTR_BLK: rectangular regions with inside/line/outside palettes ----
  attrBlk(p) {
    const sets = p[1];
    const maxSets = Math.min(sets, ((p.length - 2) / 6) | 0);
    let o = 2;
    for (let s = 0; s < maxSets; s++) {
      const ctl = p[o], pals = p[o + 1];
      const x1 = p[o + 2], y1 = p[o + 3], x2 = p[o + 4], y2 = p[o + 5];
      const pin = pals & 3, pline = (pals >> 2) & 3, pout = (pals >> 4) & 3;
      const inside = !!(ctl & 1), line = !!(ctl & 2), outside = !!(ctl & 4);
      // Region model: interior = strictly inside the rectangle; ring = its
      // 1-pixel border; exterior = everything else. (A previous model treated
      // every in-rect pixel as "inside", which made the line flag dead code.)
      for (let y = 0; y < GB_ROWS; y++) {
        for (let x = 0; x < GB_COLS; x++) {
          const inRect = x >= x1 && x <= x2 && y >= y1 && y <= y2;
          const interior = x > x1 && x < x2 && y > y1 && y < y2;
          let pal = this.attrMap[y * GB_COLS + x];
          if (!inRect) {
            if (outside) pal = pout;
          } else if (interior) {
            if (inside) pal = pin;
          } else { // ring
            if (line) pal = pline;
            else if (inside && outside) pal = pout; // Pan Docs exception
            else if (inside) pal = pin;             // inside-only covers the whole rect
          }
          this.attrMap[y * GB_COLS + x] = pal;
        }
      }
      o += 6;
      if (o + 5 >= p.length) break; // guarded by maxSets; belt-and-suspenders
    }
  }

  attrLin(p) {
    const sets = p[1];
    const maxSets = Math.min(sets, (p.length - 2) | 0);
    let o = 2;
    for (let s = 0; s < maxSets; s++) {
      const b = p[o]; o++;
      const num = b & 0x1F, pal = (b >> 5) & 3, horiz = !!(b & 0x80);
      if (horiz) { for (let x = 0; x < GB_COLS; x++) this.attrMap[num * GB_COLS + x] = pal; }
      else { for (let y = 0; y < GB_ROWS; y++) this.attrMap[y * GB_COLS + num] = pal; }
    }
  }

  attrDiv(p) {
    // spec: bits0-1 = palette below/right, bits2-3 = above/left, bits4-5 = line
    const palA = (p[1] >> 2) & 3, palB = p[1] & 3, palLine = (p[1] >> 4) & 3;
    const horiz = !!(p[1] & 0x40), line = p[2];
    for (let y = 0; y < GB_ROWS; y++) {
      for (let x = 0; x < GB_COLS; x++) {
        let pal;
        if (horiz) pal = y < line ? palA : y > line ? palB : palLine;
        else pal = x < line ? palA : x > line ? palB : palLine;
        this.attrMap[y * GB_COLS + x] = pal;
      }
    }
  }

  attrChr(p) {
    let x = p[1], y = p[2];
    const count = p[3] | (p[4] << 8);
    const vertical = !!(p[5] & 1);
    // p.length can exceed 16 for multi-packet groups; the count guard keeps
    // the tile walk inside the buffered parameter block.
    const countCapped = Math.min(count, (p.length - 6) * 4);
    let o = 6, shift = 6, cur = p[o] || 0;
    for (let i = 0; i < countCapped; i++) {
      if (shift < 0) { o++; shift = 6; cur = o < p.length ? p[o] : 0; }
      const pal = (cur >> shift) & 3;
      shift -= 2;
      if (y < GB_ROWS && x < GB_COLS) this.attrMap[y * GB_COLS + x] = pal;
      if (vertical) { y++; if (y >= GB_ROWS) { y = 0; x++; } }
      else { x++; if (x >= GB_COLS) { x = 0; y++; } }
    }
  }

  // ---- DMG shade → BGR555 through the SGB palettes ----
  // palIndex selects one of the four VISIBLE screen palettes (PAL01 writes
  // them directly; PAL_SET copies system palettes into them). GB shade 0-3
  // maps to SNES color slots via the BGP/OBP the game wrote (the PPU's
  // framebuffer already carries that mapping as a shade index).
  mapShade(shade, palIndex) {
    return this.palData[(palIndex & 3) * 16 + (shade & 3)];
  }

  // ---- VRAM transfer consumption (renderer calls once per transferred frame) ----
  consumeVramBlock(block) {
    // block: Uint8Array 4096 = VRAM 8000-8FFF as the game laid it out
    const what = this.pendingTrn;
    this.pendingTrn = null;
    if (!what || !block || block.length < 4096) return;
    if (what === 'attr') {
      for (let f = 0; f < 45; f++) {
        const base = f * 90;
        const dst = this.atf[f];
        for (let r = 0; r < GB_ROWS; r++) {
          for (let c = 0; c < GB_COLS; c += 4) {
            const b = block[base + r * 5 + (c >> 2)];
            for (let k = 0; k < 4 && c + k < GB_COLS; k++) {
              dst[r * GB_COLS + c + k] = (b >> (6 - k * 2)) & 3;
            }
          }
        }
      }
    } else if (what === 'pal') {
      for (let i = 0; i < 512 * 4; i++) this.systemPal[i] = block[i * 2] | (block[i * 2 + 1] << 8);
    } else if (what === 'chr-bg' || what === 'chr-obj') {
      if (!this.borderTiles) this.borderTiles = new Uint8Array(256 * 32);
      const half = what === 'chr-bg' ? 0 : 128; // both write the same bank per docs
      for (let t = 0; t < 128; t++) {
        for (let b = 0; b < 32; b++) this.borderTiles[(half + t) * 32 + b] = block[t * 32 + b];
      }
      this.borderDirty = true;
    } else if (what === 'pct') {
      this.borderMap = new Uint16Array(SGB_W * SGB_H);
      for (let i = 0; i < SGB_W * SGB_H; i++) this.borderMap[i] = block[i * 2] | (block[i * 2 + 1] << 8);
      this.borderPal = new Uint16Array(4 * 16);
      for (let i = 0; i < 4 * 16; i++) this.borderPal[i] = block[0x800 + i * 2] | (block[0x801 + i * 2] << 8);
      this.borderDirty = true;
    }
  }
}

// BGR555 → RGBA8888 (LCD-corrected like the CGB path is not required; SGB
// colors are already display-intended).
function bgr555to888(c) {
  const r5 = c & 31, g5 = (c >> 5) & 31, b5 = (c >> 10) & 31;
  const r = (r5 << 3) | (r5 >> 2), g = (g5 << 3) | (g5 >> 2), b = (b5 << 3) | (b5 >> 2);
  return (0xFF << 24) | (b << 16) | (g << 8) | r;
}

if (typeof module !== 'undefined') module.exports = { SGB, bgr555to888, GB_X0, GB_Y0, GB_COLS, GB_ROWS, SGB_W, SGB_H };
if (typeof window !== 'undefined') window.PocketSGB = { SGB, bgr555to888, GB_X0, GB_Y0, GB_COLS, GB_ROWS, SGB_W, SGB_H };
