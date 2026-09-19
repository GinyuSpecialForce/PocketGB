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
    this.disasmEl = document.getElementById('debug-disasm');
    this.listEl = document.getElementById('disasm-list');
    this.disasmAddrEl = document.getElementById('disasm-addr');
    this.timer = null;
    this.followPc = true;
    this.viewAddr = null; // pinned listing address (null = follow PC)
  }

  // n instruction lines starting at addr (full-coverage disassembler)
  disasmLines(addr, n = 12) {
    const lines = [];
    let a = addr & 0xFFFF;
    for (let i = 0; i < n; i++) {
      const { text, size } = this.disasmInstruction(a);
      const bp = this.gb._breakpoints && this.gb._breakpoints.has(a) ? '>' : ' ';
      lines.push(`${bp}${a.toString(16).toUpperCase().padStart(4, '0')}  ${text}`);
      a = (a + size) & 0xFFFF;
    }
    return lines;
  }

  // Full one-instruction decode → { text, size } (size = bytes consumed)
  disasmInstruction(addr) {
    const m = this.gb.mmu;
    const b = (o) => m.read((addr + o) & 0xFFFF);
    const w = (o) => b(o) | (b(o + 1) << 8);
    const h2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
    const h4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
    const r = (i) => ['B','C','D','E','H','L','(HL)','A'][i];
    const rp = (i) => ['BC','DE','HL','SP'][i];
    const rp2 = (i) => ['BC','DE','HL','AF'][i];
    const cc = (i) => ['NZ','Z','NC','C'][i];
    const alu = ['ADD A,','ADC A,','SUB ','SBC A,','AND ','XOR ','OR ','CP '];
    const rot = ['RLC','RRC','RL','RR','SLA','SRA','SWAP','SRL'];
    const op = b(0);
    if (op === 0xCB) {
      const cb = b(1);
      const x = cb >> 6, y = (cb >> 3) & 7, z = cb & 7;
      if (x === 0) return { text: `${rot[y]} ${r(z)}`, size: 2 };
      if (x === 1) return { text: `BIT ${y},${r(z)}`, size: 2 };
      if (x === 2) return { text: `RES ${y},${r(z)}`, size: 2 };
      return { text: `SET ${y},${r(z)}`, size: 2 };
    }
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1;
    if (x === 0) {
      if (z === 0) {
        if (y === 0) return { text: 'NOP', size: 1 };
        if (y === 1) return { text: 'LD (nn),SP', size: 3 };
        if (y === 2) return { text: 'STOP', size: 2 };
        if (y === 3) { const e = (b(1) << 24) >> 24; return { text: `JR ${e >= 0 ? '+' : ''}${e}`, size: 2 }; }
        if (y >= 4) { const e = (b(1) << 24) >> 24; return { text: `JR ${cc(y - 4)},${e >= 0 ? '+' : ''}${e}`, size: 2 }; }
      }
      if (z === 1) return y & 1 ? { text: `ADD HL,${rp(p)}`, size: 1 } : { text: `LD ${rp(p)},$${h4(w(1))}`, size: 3 };
      if (z === 2) {
        if (y < 4) return { text: ['LD (BC),A','LD (DE),A','LD (HL+),A','LD (HL-),A'][y], size: 1 };
        return { text: ['LD A,(BC)','LD A,(DE)','LD A,(HL+)','LD A,(HL-)'][y - 4], size: 1 };
      }
      if (z === 3) return { text: `${(y & 1) ? 'DEC' : 'INC'} ${rp(p)}`, size: 1 };
      if (z === 4) return { text: `INC ${r(y)}`, size: 1 };
      if (z === 5) return { text: `DEC ${r(y)}`, size: 1 };
      if (z === 6) return { text: `LD ${r(y)},$${h2(b(1))}`, size: 2 };
      return { text: ['RLCA','RRCA','RLA','RRA','DAA','CPL','SCF','CCF'][y], size: 1 };
    }
    if (x === 1) return op === 0x76 ? { text: 'HALT', size: 1 } : { text: `LD ${r(y)},${r(z)}`, size: 1 };
    if (x === 2) return { text: `${alu[y]}${r(z)}`, size: 1 };
    // x === 3
    if (z === 0) return { text: [`RET ${cc(y)}`,undefined,'JP ${undefined}'][0] || `RET ${cc(y)}`, size: 1 };
    if (z === 1) {
      if (y & 1) return { text: ['RETI','LD SP,HL'][y >> 1], size: 1 };
      return { text: `POP ${rp2(p)}`, size: 1 };
    }
    if (z === 2) return { text: `JP ${cc(y)},$${h4(w(1))}`, size: 3 };
    if (z === 3) {
      if (y === 0) return { text: `JP $${h4(w(1))}`, size: 3 };
      if (y === 6) return { text: 'DI', size: 1 };
      if (y === 7) return { text: 'EI', size: 1 };
      if (y === 1) return { text: `CB $${h2(b(1))}`, size: 2 }; // handled above normally
      return { text: `DB $${h2(op)}`, size: 1 };
    }
    if (z === 4) return { text: `CALL ${cc(y)},$${h4(w(1))}`, size: 3 };
    if (z === 5) return (y & 1) ? { text: `DB $${h2(op)}`, size: 1 } : { text: `PUSH ${rp2(p)}`, size: 1 };
    if (z === 6) return { text: `${alu[y]}$${h2(b(1))}`, size: 2 };
    return { text: `RST $${h2(y * 8)}`, size: 1 };
  }

  start() {
    this.stop();
    this.render(); // immediate
    this.timer = setInterval(() => {
      this.render();
      if (typeof renderHeatmap === 'function' && document.getElementById('ov-debug').classList.contains('open')) {
        try { renderHeatmap(); } catch { /* heatmap is diagnostics, never fatal */ }
      }
    }, 250);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  render() {
    const c = this.gb.cpu, p = this.gb.ppu, m = this.gb.mmu;
    const h = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
    const bps = this.gb._breakpoints ? this.gb._breakpoints.size : 0;
    this.cpuEl.textContent =
      `A=${h(c.a)} F=${h(c.f)} B=${h(c.b)} C=${h(c.c)} D=${h(c.d)} E=${h(c.e)} H=${h(c.h)} L=${h(c.l)}\n` +
      `SP=${h(c.sp, 4)} PC=${h(c.pc, 4)}  IME=${c.ime ? 1 : 0} HALT=${c.halted ? 1 : 0}${bps ? `  BP=${bps}` : ''}\n` +
      `IE=${h(m.ie)} IF=${h(m.if)}  next: ${this.disasmAt(c.pc)}`;
    this.ppuEl.textContent =
      `LCDC=${h(p.lcdc)} STAT=${h(p.stat)} LY=${p.ly} LYC=${p.lyc} SCY=${p.scy} SCX=${p.scx}\n` +
      `WY=${p.wy} WX=${p.wx} BGP=${h(p.bgp)} OBP0=${h(p.obp0)} OBP1=${h(p.obp1)} mode=${p.mode} dot=${p.dot}`;
    this.renderTiles();
    this.renderDisasm();
  }

  renderDisasm() {
    if (!this.listEl) return;
    const pc = this.gb.cpu.pc;
    if (this.followPc) this.viewAddr = pc;
    const start = (this.viewAddr & 0xFFFF);
    this.listEl.textContent = this.disasmLines(start, 12).join('\n');
    this.disasmAddrEl.textContent = `from $${start.toString(16).toUpperCase().padStart(4, '0')}`;
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
