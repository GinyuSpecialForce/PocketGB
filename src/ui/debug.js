// PocketGB — debug overlay: live CPU/PPU state + VRAM tile viewer
'use strict';

class DebugView {
  constructor(gb, renderer) {
    this.gb = gb;
    this.renderer = renderer || null;
    this.cpuEl = document.getElementById('debug-cpu');
    this.ppuEl = document.getElementById('debug-ppu');
    this.vramEl = document.getElementById('vram-view');
    this.vramCtx = this.vramEl ? this.vramEl.getContext('2d') : null;
    this.timer = null;
  }

  start() {
    this.stop();
    this.render(); // immediate
    this.timer = setInterval(() => this.render(), 250);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  render() {
    const c = this.gb.cpu, p = this.gb.ppu, m = this.gb.mmu;
    const h = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
    this.cpuEl.textContent =
      `A=${h(c.a)} F=${h(c.f)} B=${h(c.b)} C=${h(c.c)} D=${h(c.d)} E=${h(c.e)} H=${h(c.h)} L=${h(c.l)}\n` +
      `SP=${h(c.sp, 4)} PC=${h(c.pc, 4)}  IME=${c.ime ? 1 : 0} HALT=${c.halted ? 1 : 0}\n` +
      `IE=${h(m.ie)} IF=${h(m.if)}  next: ${this.disasmAt(c.pc)}`;
    this.ppuEl.textContent =
      `LCDC=${h(p.lcdc)} STAT=${h(p.stat)} LY=${p.ly} LYC=${p.lyc} SCY=${p.scy} SCX=${p.scx}\n` +
      `WY=${p.wy} WX=${p.wx} BGP=${h(p.bgp)} OBP0=${h(p.obp0)} OBP1=${h(p.obp1)} mode=${p.mode} dot=${p.dot}`;
    this.renderTiles();
  }

  // One-instruction disassembly hint at addr (covers the common opcodes).
  disasmAt(addr) {
    const m = this.gb.mmu;
    const op = m.read(addr);
    const h = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
    // common families only — this is a live hint, not a full disassembler
    if (op === 0x00) return 'NOP';
    if (op === 0x76) return 'HALT';
    if ((op & 0xC7) === 0x04) return `INC ${rName((op >> 3) & 7)}`;
    if ((op & 0xC7) === 0x05) return `DEC ${rName((op >> 3) & 7)}`;
    if ((op & 0xF8) === 0x40 && op !== 0x76) return `LD ${rName((op >> 3) & 7)},${rName(op & 7)}`;
    if ((op & 0xE7) === 0x06) return `LD ${rName((op >> 3) & 7)},$${h(m.read(addr + 1))}`;
    if (op === 0xC3) return `JP $${h(m.read(addr + 2), 2)}${h(m.read(addr + 1), 2)}`;
    if (op === 0x18) return `JR ${((m.read(addr + 1) << 24) >> 24) >= 0 ? '+' : ''}${(m.read(addr + 1) << 24) >> 24}`;
    if (op === 0xCD) return `CALL $${h(m.read(addr + 2), 2)}${h(m.read(addr + 1), 2)}`;
    if (op === 0xC9) return 'RET';
    if (op === 0xCB) return `CB $${h(m.read(addr + 1))}`;
    if ((op & 0xE7) === 0x20) return `JR ${ccName((op >> 3) & 3)},${((m.read(addr + 1) << 24) >> 24)}`;
    if ((op & 0xC7) === 0xC7) return `RST $${h(op - 0xC7)}`;
    if (op >= 0x80 && op <= 0xBF) return `${aluName(op)} ${rName(op & 7)}`;
    return `DB $${h(op)}`;
  }

  renderTiles() {
    if (!this.vramCtx) return;
    const p = this.gb.ppu;
    const ctx = this.vramCtx;
    const img = ctx.createImageData(384, 128);
    const px = new Uint32Array(img.data.buffer);
    const pal = this.rendererPalette(); // ABGR-packed like the renderer's framebuffer
    // All 384 VRAM tiles: 48 columns x 8 rows on the 384x128 canvas.
    for (let tile = 0; tile < 384; tile++) {
      const tx = (tile % 48) * 8, ty = ((tile / 48) | 0) * 8;
      const base = tile * 16;
      for (let y = 0; y < 8; y++) {
        const lo = p.vram[base + y * 2];
        const hi = p.vram[base + y * 2 + 1];
        const row = (ty + y) * 384 + tx;
        for (let x = 0; x < 8; x++) {
          const bit = 7 - x;
          const color = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
          px[row + x] = pal[color];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  rendererPalette() {
    // mirror the renderer's current palette (packed 0xAABBGGRR little-endian)
    const r = this.renderer;
    if (r && r.palRGB) return r.palRGB;
    return [[155,188,15],[139,172,15],[48,98,48],[15,56,15]].map(c => 0xFF000000 | (c[2] << 16) | (c[1] << 8) | c[0]);
  }
}

function rName(i) { return ['B','C','D','E','H','L','(HL)','A'][i]; }
function ccName(i) { return ['NZ','Z','NC','C'][i]; }
function aluName(op) {
  const names = ['ADD','ADC','SUB','SBC','AND','XOR','OR','CP'];
  return names[(op >> 3) & 7];
}

if (typeof module !== 'undefined') module.exports = { DebugView };
