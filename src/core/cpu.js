// PocketGB — SM83 (Game Boy CPU) core
// All timings in m-cycles (4.19 MHz / 4). step() executes one instruction and returns cycles.
'use strict';

const F_Z = 0x80, F_N = 0x40, F_H = 0x20, F_C = 0x10;

class CPU {
  constructor(mmu) {
    this.mmu = mmu;
    this.reset();
  }

  reset() {
    // Post-boot DMG register state
    this.a = 0x01; this.f = 0xB0; this.b = 0x00; this.c = 0x13;
    this.d = 0x00; this.e = 0xD8; this.h = 0x01; this.l = 0x4D;
    this.sp = 0xFFFE; this.pc = 0x0100;
    this.ime = false; this.imeDelay = false; // imeDelay: EI takes effect after next instruction
    this.halted = false; this.haltBug = false;
    this.stopped = false;
    // CGB double-speed state (unused on DMG)
    this.doubleSpeed = false;      // CGB KEY1 bit 7
    this.speedSwitchArmed = false; // CGB KEY1 bit 0
  }

  // ---- register pair helpers ----
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  get af() { return (this.a << 8) | (this.f & 0xF0); }
  set af(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xF0; }

  rd(a) { return this.mmu.read(a); }
  wr(a, v) { this.mmu.write(a, v); }
  rd16(a) { return this.rd(a) | (this.rd((a + 1) & 0xFFFF) << 8); }
  wr16(a, v) { this.wr(a, v & 0xFF); this.wr((a + 1) & 0xFFFF, (v >> 8) & 0xFF); }

  fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }

  push16(v) { this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, (v >> 8) & 0xFF);
              this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, v & 0xFF); }
  pop16() { const lo = this.rd(this.sp); this.sp = (this.sp + 1) & 0xFFFF;
            const hi = this.rd(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return lo | (hi << 8); }

  // ---- flags ----
  setFlags(z, n, h, c) {
    this.f = ((z ? F_Z : 0) | (n ? F_N : 0) | (h ? F_H : 0) | (c ? F_C : 0)) & 0xF0;
  }
  get fz() { return (this.f & F_Z) !== 0; }
  get fh() { return (this.f & F_H) !== 0; }
  get fc() { return (this.f & F_C) !== 0; }

  add8(v) {
    const r = this.a + v;
    const h = ((this.a & 0xF) + (v & 0xF)) > 0xF;
    const c = r > 0xFF;
    this.a = r & 0xFF;
    this.setFlags(this.a === 0, false, h, c);
  }
  adc8(v) {
    const cy = this.fc ? 1 : 0;
    const r = this.a + v + cy;
    const h = ((this.a & 0xF) + (v & 0xF) + cy) > 0xF;
    const c = r > 0xFF;
    this.a = r & 0xFF;
    this.setFlags(this.a === 0, false, h, c);
  }
  sub8(v) {
    const r = this.a - v;
    const h = (this.a & 0xF) < (v & 0xF);
    const c = r < 0;
    this.a = r & 0xFF;
    this.setFlags(this.a === 0, true, h, c);
  }
  sbc8(v) {
    const cy = this.fc ? 1 : 0;
    const r = this.a - v - cy;
    const h = (this.a & 0xF) - (v & 0xF) - cy < 0;
    const c = r < 0;
    this.a = r & 0xFF;
    this.setFlags(this.a === 0, true, h, c);
  }
  and8(v) { this.a &= v; this.setFlags(this.a === 0, false, true, false); }
  xor8(v) { this.a ^= v; this.setFlags(this.a === 0, false, false, false); }
  or8(v)  { this.a |= v; this.setFlags(this.a === 0, false, false, false); }
  cp8(v) {
    const r = this.a - v;
    this.setFlags((r & 0xFF) === 0, true, (this.a & 0xF) < (v & 0xF), r < 0);
  }
  inc8(v) { const r = (v + 1) & 0xFF; this.setFlags(r === 0, false, (v & 0xF) === 0xF, this.fc); return r; }
  dec8(v) { const r = (v - 1) & 0xFF; this.setFlags(r === 0, true, (v & 0xF) === 0, this.fc); return r; }

  add16(v) {
    const hl = this.hl;
    const r = hl + v;
    const h = ((hl & 0xFFF) + (v & 0xFFF)) > 0xFFF;
    const c = r > 0xFFFF;
    this.hl = r & 0xFFFF;
    // Z preserved, N reset, H/C per carry
    this.f = (this.f & F_Z) | (h ? F_H : 0) | (c ? F_C : 0);
  }
  addSP(e) { // SP + signed e: Z,N reset; H,C from low byte
    const r = (this.sp + e) & 0xFFFF;
    const h = ((this.sp & 0xF) + (e & 0xF)) > 0xF;
    const c = ((this.sp & 0xFF) + (e & 0xFF)) > 0xFF;
    this.setFlags(false, false, h, c);
    return r;
  }

  rlc(v) { const c = (v >> 7) & 1; const r = ((v << 1) | c) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  rrc(v) { const c = v & 1; const r = ((v >> 1) | (c << 7)) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  rl(v)  { const c = (v >> 7) & 1; const r = ((v << 1) | (this.fc ? 1 : 0)) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  rr(v)  { const c = v & 1; const r = ((v >> 1) | (this.fc ? 0x80 : 0)) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  sla(v) { const c = (v >> 7) & 1; const r = (v << 1) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  sra(v) { const c = v & 1; const r = ((v >> 1) | (v & 0x80)) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  srl(v) { const c = v & 1; const r = (v >> 1) & 0xFF; this.setFlags(r === 0, false, false, c === 1); return r; }
  swap(v) { const r = ((v << 4) | (v >> 4)) & 0xFF; this.setFlags(r === 0, false, false, false); return r; }
  bit(v, b) { this.setFlags(((v >> b) & 1) === 0, false, true, this.fc); }
  res(v, b) { return v & ~(1 << b) & 0xFF; }
  setb(v, b) { return (v | (1 << b)) & 0xFF; }

  daa() {
    let a = this.a;
    if (!(this.f & F_N)) {
      if (this.fc || a > 0x99) { a += 0x60; this.f |= F_C; }
      if (this.fh || (a & 0xF) > 9) { a += 0x06; }
    } else {
      if (this.fc) a -= 0x60;
      if (this.fh) a -= 0x06;
    }
    a &= 0xFF;
    this.a = a;
    this.f = (this.f & ~(F_Z | F_H)) | (a === 0 ? F_Z : 0);
  }


  // condition helpers
  cond(idx) { // 0:NZ 1:Z 2:NC 3:C
    switch (idx) {
      case 0: return !this.fz;
      case 1: return this.fz;
      case 2: return !this.fc;
      case 3: return this.fc;
    }
  }

  // ---- interrupts ----
  checkInterrupts() {
    const pending = this.mmu.ie & this.mmu.if & 0x1F;
    if (pending === 0) return 0;
    if (this.stopped) this.stopped = false; // any enabled interrupt wakes STOP
    if (this.halted) this.halted = false; // interrupts always wake HALT...
    if (!this.ime) return 0;              // ...but are only serviced when IME is set
    this.halted = false;
    // service highest priority
    for (let i = 0; i < 5; i++) {
      if (pending & (1 << i)) {
        this.ime = false;
        this.mmu.if &= ~(1 << i);
        this.push16(this.pc);
        this.pc = 0x0040 + i * 8;
        return 20; // 5 m-cycles
      }
    }
    return 0;
  }

  // Execute one instruction (plus servicing one interrupt). Returns m-cycles.
  step() {
    if (this.imeDelay) { this.ime = true; this.imeDelay = false; }
    // Hot path: the interrupt check runs before EVERY instruction (~21k times
    // per frame), so the all-quiet case is inlined here instead of paying a
    // call frame into checkInterrupts() each time. Identical semantics.
    const mmu = this.mmu;
    if (mmu.ie & mmu.if & 0x1F) {
      const served = this.checkInterrupts();
      if (served) return served;
    }
    if (this.halted) return 4; // just wait
    if (this.haltBug) {
      // HALT bug: PC is left unchanged for the next fetch (byte is read twice)
      this.haltBug = false;
      const op0 = this.rd(this.pc);
      return this.exec(op0);
    }

    const op = this.fetch();
    return this.exec(op);
  }

  // STOP: on CGB with KEY1 bit 0 armed, this toggles double-speed and
  // execution continues (the switch costs ~4.4k T-cycles on hardware; a few
  // m-cycles here). Otherwise the CPU stops until a joypad interrupt.
  execStop() {
    const m = this.mmu;
    if (m && m.cgb && this.speedSwitchArmed) {
      this.speedSwitchArmed = false;
      this.doubleSpeed = !this.doubleSpeed;
      return 8;
    }
    this.stopped = true;
    this.halted = true;
    return 4;
  }

  exec(op) {
    const m = this.mmu;
    switch (op) {
      // -- 8-bit loads --
      case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x47: // LD r,r' (B..A)
      case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4F:
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x57:
      case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: case 0x5D: case 0x5F:
      case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x67:
      case 0x68: case 0x69: case 0x6A: case 0x6B: case 0x6C: case 0x6D: case 0x6F:
      case 0x78: case 0x79: case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7F: {
        const dst = (op >> 3) & 7, src = op & 7;
        this.setReg(dst, this.getReg(src));
        return 4;
      }
      case 0x06: this.b = this.fetch(); return 8; // LD B,n
      case 0x0E: this.c = this.fetch(); return 8;
      case 0x16: this.d = this.fetch(); return 8;
      case 0x1E: this.e = this.fetch(); return 8;
      case 0x26: this.h = this.fetch(); return 8;
      case 0x2E: this.l = this.fetch(); return 8;
      case 0x3E: this.a = this.fetch(); return 8; // LD A,n
      case 0x7E: this.a = this.rd(this.hl); return 8;       // LD A,(HL)
      case 0x46: this.b = this.rd(this.hl); return 8;       // LD B,(HL)
      case 0x4E: this.c = this.rd(this.hl); return 8;       // LD C,(HL)
      case 0x56: this.d = this.rd(this.hl); return 8;       // LD D,(HL)
      case 0x5E: this.e = this.rd(this.hl); return 8;       // LD E,(HL)
      case 0x66: this.h = this.rd(this.hl); return 8;       // LD H,(HL)
      case 0x6E: this.l = this.rd(this.hl); return 8;       // LD L,(HL)
      case 0x77: this.wr(this.hl, this.a); return 8;        // LD (HL),A
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: // LD (HL),r
        this.wr(this.hl, this.getReg(op & 7)); return 8;
      case 0x36: this.wr(this.hl, this.fetch()); return 12; // LD (HL),n
      case 0x0A: this.a = this.rd(this.bc); return 8;       // LD A,(BC)
      case 0x1A: this.a = this.rd(this.de); return 8;       // LD A,(DE)
      case 0xEA: this.wr(this.fetch16(), this.a); return 16; // LD (nn),A
      case 0xFA: this.a = this.rd(this.fetch16()); return 16; // LD A,(nn)
      case 0xE0: this.wr(0xFF00 | this.fetch(), this.a); return 12; // LDH (n),A
      case 0xF0: this.a = this.rd(0xFF00 | this.fetch()); return 12; // LDH A,(n)
      case 0xE2: this.wr(0xFF00 | this.c, this.a); return 8; // LDH (C),A
      case 0xF2: this.a = this.rd(0xFF00 | this.c); return 8; // LDH A,(C)
      case 0x02: this.wr(this.bc, this.a); return 8;  // LD (BC),A
      case 0x12: this.wr(this.de, this.a); return 8;  // LD (DE),A
      case 0x22: this.wr(this.hl, this.a); this.hl = (this.hl + 1) & 0xFFFF; return 8; // LDI
      case 0x2A: this.a = this.rd(this.hl); this.hl = (this.hl + 1) & 0xFFFF; return 8;
      case 0x32: this.wr(this.hl, this.a); this.hl = (this.hl - 1) & 0xFFFF; return 8; // LDD
      case 0x3A: this.a = this.rd(this.hl); this.hl = (this.hl - 1) & 0xFFFF; return 8;
      case 0x08: this.wr16(this.fetch16(), this.sp); return 20; // LD (nn),SP
      case 0xF9: this.sp = this.hl; return 8; // LD SP,HL
      case 0xF8: { const e = (this.fetch() << 24 >> 24); this.hl = this.addSP(e); return 12; } // LDHL SP,e

      // -- 16-bit loads --
      case 0x01: this.bc = this.fetch16(); return 12;
      case 0x11: this.de = this.fetch16(); return 12;
      case 0x21: this.hl = this.fetch16(); return 12;
      case 0x31: this.sp = this.fetch16(); return 12;
      case 0xC5: this.push16(this.bc); return 16;
      case 0xD5: this.push16(this.de); return 16;
      case 0xE5: this.push16(this.hl); return 16;
      case 0xF5: this.push16(this.af); return 16;
      case 0xC1: this.bc = this.pop16(); return 12;
      case 0xD1: this.de = this.pop16(); return 12;
      case 0xE1: this.hl = this.pop16(); return 12;
      case 0xF1: this.af = this.pop16(); return 12;

      // -- 16-bit ALU --
      case 0x09: this.add16(this.bc); return 8; // ADD HL,BC
      case 0x19: this.add16(this.de); return 8; // ADD HL,DE
      case 0x29: this.add16(this.hl); return 8; // ADD HL,HL
      case 0x39: this.add16(this.sp); return 8; // ADD HL,SP
      case 0xE8: { const e = (this.fetch() << 24 >> 24); this.sp = this.addSP(e); return 16; } // ADD SP,e

      // -- 8-bit ALU --
      case 0x80: case 0x81: case 0x82: case 0x83: case 0x84: case 0x85: case 0x86: case 0x87:
        if (op === 0x86) this.add8(this.rd(this.hl)); else this.add8(this.getReg(op & 7)); return op === 0x86 ? 8 : 4;
      case 0x88: case 0x89: case 0x8A: case 0x8B: case 0x8C: case 0x8D: case 0x8E: case 0x8F:
        if (op === 0x8E) this.adc8(this.rd(this.hl)); else this.adc8(this.getReg(op & 7)); return op === 0x8E ? 8 : 4;
      case 0x90: case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
        if (op === 0x96) this.sub8(this.rd(this.hl)); else this.sub8(this.getReg(op & 7)); return op === 0x96 ? 8 : 4;
      case 0x98: case 0x99: case 0x9A: case 0x9B: case 0x9C: case 0x9D: case 0x9E: case 0x9F:
        if (op === 0x9E) this.sbc8(this.rd(this.hl)); else this.sbc8(this.getReg(op & 7)); return op === 0x9E ? 8 : 4;
      case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xA5: case 0xA6: case 0xA7:
        if (op === 0xA6) this.and8(this.rd(this.hl)); else this.and8(this.getReg(op & 7)); return op === 0xA6 ? 8 : 4;
      case 0xA8: case 0xA9: case 0xAA: case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF:
        if (op === 0xAE) this.xor8(this.rd(this.hl)); else this.xor8(this.getReg(op & 7)); return op === 0xAE ? 8 : 4;
      case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB4: case 0xB5: case 0xB6: case 0xB7:
        if (op === 0xB6) this.or8(this.rd(this.hl)); else this.or8(this.getReg(op & 7)); return op === 0xB6 ? 8 : 4;
      case 0xB8: case 0xB9: case 0xBA: case 0xBB: case 0xBC: case 0xBD: case 0xBE: case 0xBF:
        if (op === 0xBE) this.cp8(this.rd(this.hl)); else this.cp8(this.getReg(op & 7)); return op === 0xBE ? 8 : 4;
      case 0xC6: this.add8(this.fetch()); return 8;
      case 0xCE: this.adc8(this.fetch()); return 8;
      case 0xD6: this.sub8(this.fetch()); return 8;
      case 0xDE: this.sbc8(this.fetch()); return 8;
      case 0xE6: this.and8(this.fetch()); return 8;
      case 0xEE: this.xor8(this.fetch()); return 8;
      case 0xF6: this.or8(this.fetch()); return 8;
      case 0xFE: this.cp8(this.fetch()); return 8;

      // -- inc/dec --
      case 0x04: case 0x0C: case 0x14: case 0x1C: case 0x24: case 0x2C: case 0x3C: case 0x7C: {
        const r = (op >> 3) & 7;
        this.setReg(r, this.inc8(this.getReg(r)));
        return 4;
      }
      case 0x05: case 0x0D: case 0x15: case 0x1D: case 0x25: case 0x2D: case 0x3D: case 0x7D: {
        const r = (op >> 3) & 7;
        this.setReg(r, this.dec8(this.getReg(r)));
        return 4;
      }
      case 0x34: this.wr(this.hl, this.inc8(this.rd(this.hl))); return 12;
      case 0x35: this.wr(this.hl, this.dec8(this.rd(this.hl))); return 12;
      case 0x03: this.bc = (this.bc + 1) & 0xFFFF; return 8;
      case 0x13: this.de = (this.de + 1) & 0xFFFF; return 8;
      case 0x23: this.hl = (this.hl + 1) & 0xFFFF; return 8;
      case 0x33: this.sp = (this.sp + 1) & 0xFFFF; return 8;
      case 0x0B: this.bc = (this.bc - 1) & 0xFFFF; return 8;
      case 0x1B: this.de = (this.de - 1) & 0xFFFF; return 8;
      case 0x2B: this.hl = (this.hl - 1) & 0xFFFF; return 8;
      case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; return 8;

      // -- rotates/shifts on A (Z always reset, unlike CB variants) --
      case 0x07: this.a = this.rlc(this.a); this.f &= ~F_Z; return 4; // RLCA
      case 0x0F: this.a = this.rrc(this.a); this.f &= ~F_Z; return 4; // RRCA
      case 0x17: this.a = this.rl(this.a); this.f &= ~F_Z; return 4;  // RLA
      case 0x1F: this.a = this.rr(this.a); this.f &= ~F_Z; return 4;  // RRA
      case 0x27: this.daa(); return 4;

      // -- CB prefix --
      case 0xCB: return this.execCB(this.fetch());

      // -- control flow --
      case 0x18: { const e = (this.fetch() << 24 >> 24); this.pc = (this.pc + e) & 0xFFFF; return 12; } // JR
      case 0x20: case 0x28: case 0x30: case 0x38: { // JR cc
        const e = (this.fetch() << 24 >> 24);
        if (this.cond((op >> 3) & 3)) { this.pc = (this.pc + e) & 0xFFFF; return 12; }
        return 8;
      }
      case 0xC3: this.pc = this.fetch16(); return 16; // JP
      case 0xC2: case 0xCA: case 0xD2: case 0xDA: { // JP cc
        const a = this.fetch16();
        if (this.cond((op >> 3) & 3)) { this.pc = a; return 16; }
        return 12;
      }
      case 0xE9: this.pc = this.hl; return 4; // JP HL
      case 0xCD: { const a = this.fetch16(); this.push16(this.pc); this.pc = a; return 24; } // CALL
      case 0xC4: case 0xCC: case 0xD4: case 0xDC: { // CALL cc
        const a = this.fetch16();
        if (this.cond((op >> 3) & 3)) { this.push16(this.pc); this.pc = a; return 24; }
        return 12;
      }
      case 0xC9: this.pc = this.pop16(); return 16; // RET
      case 0xC0: case 0xC8: case 0xD0: case 0xD8: { // RET cc
        if (this.cond((op >> 3) & 3)) { this.pc = this.pop16(); return 20; }
        return 8;
      }
      case 0xD9: this.pc = this.pop16(); this.ime = true; return 16; // RETI
      case 0xC7: case 0xCF: case 0xD7: case 0xDF: case 0xE7: case 0xEF: case 0xF7: case 0xFF: // RST
        this.push16(this.pc); this.pc = op - 0xC7; return 16;

      // -- misc --
      case 0x00: return 4;            // NOP
      case 0x76: { // HALT
        const pending = m.ie & m.if & 0x1F;
        if (pending && !this.ime) this.haltBug = true;
        else this.halted = true;
        return 4;
      }
      case 0x10: return this.execStop(); // STOP / CGB speed switch
      case 0xFB: this.imeDelay = true; return 4; // EI
      case 0xF3: this.ime = false; return 4;     // DI
      case 0x37: this.f = (this.f & F_Z) | F_C; return 4; // SCF
      case 0x3F: this.f = (this.f & (F_Z | F_C)) ^ F_C; return 4; // CCF
      case 0x2F: this.a = ~this.a & 0xFF; this.f = (this.f & (F_Z | F_C)) | F_N | F_H; return 4; // CPL: Z,C unchanged; N,H set

      default:
        // 0xD3/0xDB/0xDD/0xE3/0xE4/0xEB/0xEC/0xED/0xF4/0xFC/0xFD are illegal on SM83;
        // real hardware executes them as NOPs, so we do the same.
        return 4;
    }
  }

  execCB(op) {
    const bit = (op >> 3) & 7;
    const reg = op & 7;
    const isHL = reg === 6;
    let v = isHL ? this.rd(this.hl) : this.getReg(reg);
    const base = op & 0xF8;
    let cycles = isHL ? 16 : 8;

    if (base >= 0x40 && base <= 0x7F) { // BIT
      this.bit(v, bit);
      // DMG: BIT n,(HL) costs 12T (3 m-cycles), one less than other (HL) CB ops
      return isHL ? 12 : 8;
    }
    if (base >= 0x80 && base <= 0xBF) { // RES
      v = this.res(v, bit);
      if (isHL) this.wr(this.hl, v); else this.setReg(reg, v);
      return cycles;
    }
    if (base >= 0xC0) { // SET
      v = this.setb(v, bit);
      if (isHL) this.wr(this.hl, v); else this.setReg(reg, v);
      return cycles;
    }
    // rotates/shifts (0x00-0x3F)
    switch (base) {
      case 0x00: v = this.rlc(v); break;
      case 0x08: v = this.rrc(v); break;
      case 0x10: v = this.rl(v); break;
      case 0x18: v = this.rr(v); break;
      case 0x20: v = this.sla(v); break;
      case 0x28: v = this.sra(v); break;
      case 0x30: v = this.swap(v); break;
      case 0x38: v = this.srl(v); break;
    }
    if (isHL) this.wr(this.hl, v); else this.setReg(reg, v);
    return cycles;
  }

  getReg(i) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l;
      case 6: return this.rd(this.hl);
      case 7: return this.a;
    }
  }
  setReg(i, v) {
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break;
      case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break;
      case 6: this.wr(this.hl, v); break;
      case 7: this.a = v; break;
    }
  }
}


if (typeof module !== 'undefined') module.exports = { CPU, F_Z, F_N, F_H, F_C };
