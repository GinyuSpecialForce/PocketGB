// PocketGB — machine wiring: step, runFrame, reset, save states
'use strict';

// Browser loads these via <script> globals; Node tests use require()
const _PPU    = (typeof PPU    !== 'undefined') ? PPU    : require('./ppu').PPU;
const _CgbPPU = (typeof CgbPPU !== 'undefined') ? CgbPPU : require('./ppu-cgb').CgbPPU;
const _APU    = (typeof APU    !== 'undefined') ? APU    : require('./apu').APU;
const _CPU    = (typeof CPU    !== 'undefined') ? CPU    : require('./cpu').CPU;
const _MMU    = (typeof MMU    !== 'undefined') ? MMU    : require('./mmu').MMU;
const _Timer  = (typeof Timer  !== 'undefined') ? Timer  : require('./timer').Timer;
const _Joypad = (typeof Joypad !== 'undefined') ? Joypad : require('./joypad').Joypad;
const _Cartridge = (typeof Cartridge !== 'undefined') ? Cartridge : require('./cartridge').Cartridge;
const _CheatEngine = (typeof CheatEngine !== 'undefined') ? CheatEngine : require('./cheats').CheatEngine;
const _Serial = (typeof Serial !== 'undefined') ? Serial : require('./serial').Serial;

class GameBoy {
  constructor() {
    this.cart = null;
    this.cheats = new _CheatEngine();
    this.serial = new _Serial();
    this.serial.requestInterrupt = (b) => this.requestInterrupt(b);
    this.ppu = new _PPU({ requestInterrupt: (b) => this.requestInterrupt(b), readByte: () => 0xFF });
    this.apu = new _APU();
    this.joypad = new _Joypad({ requestInterrupt: (b) => this.requestInterrupt(b) });
    this.timer = new _Timer({ requestInterrupt: (b) => this.requestInterrupt(b) });
    this.cpu = new _CPU(this);
  }

  requestInterrupt(bit) { this.cpu.mmu && this.cpu.mmu.requestInterrupt(bit); }

  loadROM(bytes, saveData, forceDmg, bootBytes) {
    if (this.cart) this.cart.dispose();
    this.cart = new _Cartridge(bytes);
    this.cart.cheats = this.cheats; // Game Genie patches read from this cart
    const cgb = !forceDmg && this.cart.isGBC;
    // DMG WRAM is 8 KB; CGB has 8 banks (32 KB, SVBK bank 0 = bank 1)
    const cgbWram = cgb ? 0x8000 : 0x2000;
    // Swap in the CGB PPU (16 KB VRAM, palette RAM) for color games; a plain
    // PPU otherwise (reused if already the right kind).
    const wantCgb = cgb && !(this.ppu instanceof _CgbPPU);
    const wantDmg = !cgb && (this.ppu instanceof _CgbPPU);
    if (wantCgb || wantDmg) {
      const PpuClass = cgb ? _CgbPPU : _PPU;
      this.ppu = new PpuClass({ requestInterrupt: (b) => this.requestInterrupt(b), readByte: () => 0xFF });
    }
    this.mmu = new _MMU(this.cpu, this.cart, this.ppu, this.apu, this.timer, this.joypad);
    this.mmu.wram = new Uint8Array(cgbWram);
    this.mmu.serial = this.serial;
    this.mmu.cgb = cgb;
    // Super Game Boy layer: only for DMG games with the SGB unlock in the
    // header (0x146=03 + old licensee 0x33) — the ICD2 gate for SGB features.
    const _SGB = (typeof SGB !== 'undefined') ? SGB : require('./sgb').SGB;
    const sgbUnlocked = !cgb && this.cart.rom[0x146] === 0x03 && this.cart.rom[0x14B] === 0x33;
    if (sgbUnlocked) {
      this.sgb = new _SGB();
      this.joypad.sgb = this.sgb;
    } else {
      this.sgb = null;
      this.joypad.sgb = null;
    }
    // Optional authentic boot ROM (user-supplied dump): DMG (256 B) maps at
    // 0000-00FF; CGB (2 KB, incl. the color intro) maps at 0000-08FF. Without
    // one the CPU starts at the post-boot state (built-in fast boot).
    const boot = bootBytes && bootBytes.length >= 0x100 ? bootBytes : null;
    this.mmu.bootrom = boot;
    this.mmu.bootromDisabled = !boot;
    if (boot) {
      this.cpu.a = 0; this.cpu.f = 0; this.cpu.b = 0; this.cpu.c = 0;
      this.cpu.d = 0; this.cpu.e = 0; this.cpu.h = 0; this.cpu.l = 0;
      this.cpu.sp = 0; this.cpu.pc = 0;
      this.cpu.ime = false; this.cpu.imeDelay = false; this.cpu.halted = false;
    }
    this.cpu.mmu = this.mmu;
    this.ppu.mmu = this.mmu; // HDMA source reads
    this.resetComponents();
    // resetComponents() builds a fresh Joypad (its select bits are part of the
    // reset state) — re-link the SGB transport that loadROM attached above.
    this.joypad.sgb = this.sgb || null;
    // Cache for in-app resets: without this, resetGame() would reboot with the
    // built-in fast boot instead of the user's authentic boot ROM.
    this._bootBytes = boot;
    if (saveData) this.cart.loadSav(saveData);
    // Hot-loop bindings (runFrame calls these thousands of times per frame)
    this._cpuStep = this.cpu.step.bind(this.cpu);
    // APU tick batching: audio timestamps only need ~ms accuracy, so defer APU
    // ticks into ~96 T-cycle (23 µs) batches instead of ticking per CPU
    // instruction — removes ~19k call frames/frame on double-speed CGB with no
    // audible difference. Flushed at frame end and around save/load.
    this._apuPending = 0;
    this._tickParts = (n) => {
      // CGB double speed: the CPU runs twice as fast, so timed components
      // see half as many of their (4.19 MHz) cycles per CPU cycle.
      const slow = this.cpu.doubleSpeed ? (n >> 1) : n;
      this.timer.tick(slow);
      this.ppu.tick(slow);
      this._apuPending += slow;
      if (this._apuPending >= 96) { this.apu.tick(this._apuPending); this._apuPending = 0; }
      this.serial.tick(slow);
      this.mmu.dmaTick(slow);
      if (this.ppu.hdmaTick) this.ppu.hdmaTick();
    };
  }

  // Push any batched APU cycles through before state capture / frame end.
  _flushApu() {
    if (this._apuPending) { this.apu.tick(this._apuPending); this._apuPending = 0; }
  }

  resetComponents() {
    this._apuPending = 0; // fresh APU timeline: drop any batched cycles
    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.timer.reset();
    this.joypad = new _Joypad({ requestInterrupt: (b) => this.requestInterrupt(b) });
    this.mmu.joypad = this.joypad;
    this.serial.reset();
    if (this.mmu.cgb) {
      // Post-boot CGB register state (cgb_boot values)
      this.cpu.a = 0x11; this.cpu.f = 0x80; this.cpu.b = 0x00; this.cpu.c = 0x00;
      this.cpu.d = 0xFF; this.cpu.e = 0x56; this.cpu.h = 0x00; this.cpu.l = 0x0D;
      this.mmu.wramBank = 1;
      this.mmu.ff72 = 0x00; this.mmu.ff73 = 0x00; this.mmu.ff74 = 0x00; this.mmu.ff75 = 0x00;
    }
    this.mmu.if = 0xE1; this.mmu.ie = 0x00;
  }

  // ---- save states ----
  saveState() {
    this._flushApu(); // no un-emulated cycles hiding in the batcher
    const c = this.cpu, p = this.ppu, a = this.apu, t = this.timer, m = this.mmu, k = this.cart;
    const isCgb = this.mmu.cgb;
    const header = {
      v: 2,
      cgb: isCgb,
      cpu: { a: c.a, f: c.f, b: c.b, c: c.c, d: c.d, e: c.e, h: c.h, l: c.l, sp: c.sp, pc: c.pc,
             ime: c.ime, imeDelay: c.imeDelay, halted: c.halted, haltBug: c.haltBug, stopped: c.stopped,
             doubleSpeed: c.doubleSpeed, speedSwitchArmed: c.speedSwitchArmed },
      ppu: { lcdc: p.lcdc, stat: p.stat, scy: p.scy, scx: p.scx, ly: p.ly, lyc: p.lyc,
             bgp: p.bgp, obp0: p.obp0, obp1: p.obp1, wy: p.wy, wx: p.wx, dma: p.dma,
             mode: p.mode, dot: p.dot, wly: p.wly, winActive: p.winActive,
             currentWy: p.currentWy, hasWindow: p.hasWindow, lastY: p.lastY, lastX: p.lastX, statLine: p.statLine },
      timer: { div: t.div, tima: t.tima, tma: t.tma, tac: t.tac },
      mmu: { ie: m.ie, if: m.if, wramBank: m.wramBank,
             ff72: m.ff72, ff73: m.ff73, ff74: m.ff74, ff75: m.ff75,
             wramSize: m.wram.length, vramSize: p.vram.length },
      apu: {
        enabled: a.enabled, nr50: a.nr50, nr51: a.nr51, seqStep: a.seqStep, seqAcc: a.seqAcc, cycleAcc: a.cycleAcc,
        ch: a.ch.map(ch => ({ on: ch.on, dac: ch.dac, freq: ch.freq, duty: ch.duty, dutyPos: ch.dutyPos,
          len: ch.len, lenEnable: ch.lenEnable, envVol: ch.envVol, envInitial: ch.envInitial,
          envDir: ch.envDir, envPeriod: ch.envPeriod, envTimer: ch.envTimer,
          sweepEnable: ch.sweepEnable, sweepNeg: ch.sweepNeg, sweepShift: ch.sweepShift,
          sweepTimer: ch.sweepTimer, sweepFreq: ch.sweepFreq, sweepPeriod: ch.sweepPeriod,
          volumeShift: ch.volumeShift, pos: ch.pos, lfsr: ch.lfsr, divCode: ch.divCode,
          widthMode: ch.widthMode, timer: ch.timer })),
      },
      joypad: { selectBits: this.joypad.selectBits },
      serial: this.serial.serialize(),
      cart: { romBank: k.romBank, ramBank: k.ramBank, mode: k.mode, bank2: k.bank2,
              ramEnabled: k.ramEnabled, ramSize: k.ramSize, rtc: k.hasRtc ? { ...k.rtc } : null },
      ppuCgb: p.bgpd ? { vbk: p.vbk, bgpi: p.bgpi, ocpi: p.ocpi,
                         bcpsIncrement: p.bcpsIncrement, ocpsIncrement: p.ocpsIncrement,
                         opri: p.opri } : null,
      blobs: isCgb ? ['wram', 'hram', 'vram', 'oam', 'cartRam', 'waveRam', 'bgpd', 'ocpd']
                   : ['wram', 'hram', 'vram', 'oam', 'cartRam', 'waveRam'],
    };
    const blobData = isCgb
      ? [m.wram, m.hram, p.vram, p.oam, k.ram, a.waveRam, p.bgpd, p.ocpd]
      : [m.wram, m.hram, p.vram, p.oam, k.ram, a.waveRam];
    // Explicit per-blob sizes keep decodeState from guessing (the old
    // rest-of-file heuristic broke when blobs were appended after cartRam).
    header.blobSizes = blobData.map(b => b.length);
    return encodeState(header, blobData);
  }

  loadState(u8) {
    const { header, blobs } = decodeState(u8);
    if (header.v > 2) throw new Error('Unsupported state version');
    if (!!header.cgb !== !!this.mmu.cgb) throw new Error('State is for a different console type');
    this._apuPending = 0; // the loaded state owns the APU timeline from here
    const c = this.cpu, p = this.ppu, a = this.apu, t = this.timer, m = this.mmu, k = this.cart;
    Object.assign(c, header.cpu);
    // Strip undefined so older/newer state versions never clobber live fields
    for (const key of Object.keys(header.ppu)) if (header.ppu[key] === undefined) delete header.ppu[key];
    Object.assign(p, header.ppu);
    Object.assign(t, header.timer);
    m.ie = header.mmu.ie; m.if = header.mmu.if;
    // New (v2) fields; v1 states predate WRAM banking and palette RAM
    if (header.v >= 2) {
      m.wramBank = header.mmu.wramBank;
      m.ff72 = header.mmu.ff72; m.ff73 = header.mmu.ff73;
      m.ff74 = header.mmu.ff74; m.ff75 = header.mmu.ff75;
      if (header.ppuCgb && p.bgpd) Object.assign(p, header.ppuCgb);
    }
    a.enabled = header.apu.enabled; a.nr50 = header.apu.nr50; a.nr51 = header.apu.nr51;
    a.seqStep = header.apu.seqStep; a.seqAcc = header.apu.seqAcc; a.cycleAcc = header.apu.cycleAcc;
    header.apu.ch.forEach((s, i) => Object.assign(a.ch[i], s));
    this.joypad.selectBits = header.joypad.selectBits;
    if (header.serial) this.serial.restore(header.serial);
    Object.assign(k, { romBank: header.cart.romBank, ramBank: header.cart.ramBank, mode: header.cart.mode,
                       bank2: header.cart.bank2, ramEnabled: header.cart.ramEnabled });
    if (header.cart.rtc) Object.assign(k.rtc, header.cart.rtc);
    const [wram, hram, vram, oam, cartRam, waveRam, bgpd, ocpd] = blobs;
    m.wram.set(wram); m.hram.set(hram); p.vram.set(vram); p.oam.set(oam);
    k.ram.set(cartRam.subarray(0, k.ram.length)); a.waveRam.set(waveRam);
    if (bgpd) p.bgpd.set(bgpd);
    if (ocpd) p.ocpd.set(ocpd);
  }

  // Advance the machine by one rendered frame (70224 m-cycles). Returns the
  // framebuffer when a new frame completes: Uint8Array of 160*144 shade
  // indices on DMG, Uint32Array of BGR555 colors on CGB.
  // ---- debugger hooks ----
  // breakpoints: Set of addresses checked before each CPU step. stepFrames()
  // runs instructions (with breakpoints honored) while video keeps rendering.
  get breakpoints() { return this._breakpoints || (this._breakpoints = new Set()); }
  addBreakpoint(addr) { this.breakpoints.add(addr & 0xFFFF); }
  removeBreakpoint(addr) { this.breakpoints.delete(addr & 0xFFFF); }
  clearBreakpoints() { if (this._breakpoints) this._breakpoints.clear(); }

  stepInstruction() {
    // one CPU step with full component ticking (slower than runFrame's loop
    // but identical semantics); returns m-cycles consumed. _tickParts already
    // halves internally at double speed — pass raw cycles, never pre-scale.
    const cycles = this._cpuStep ? this._cpuStep() : this.cpu.step();
    if (this._tickParts) this._tickParts(cycles);
    return cycles;
  }

  runFrame() {
    if (!this.cart || !this.mmu) return null;
    const fb = this.ppu.colorFramebuffer || this.ppu.framebuffer;
    const cpuStep = this._cpuStep;
    const tickParts = this._tickParts;
    this.ppu.frameComplete = false; // consume last frame's vblank flag
    this.ppu.frameReady = false;
    // Budget is one frame in 4.19 MHz master T-cycles. In CGB double speed the
    // CPU runs twice as fast, so it gets twice as many cycles and the timed
    // components see half as many of their base-rate ticks (tickParts halves).
    let budget = 70224;
    const bps = this._breakpoints;
    while (budget > 0) {
      if (bps && bps.has(this.cpu.pc)) break; // debugger: halt at the breakpoint
      // cpu.step handles HALT and STOP internally (cheap wait path + interrupt wake).
      let cycles = cpuStep();
      const master = this.cpu.doubleSpeed ? Math.max(1, cycles >> 1) : cycles;
      if (master > budget) { cycles = budget << (this.cpu.doubleSpeed ? 1 : 0); }
      tickParts(cycles);
      budget -= master;
      if (this.ppu.frameComplete) break; // vblank reached: frame is on screen
    }
    if (this.cheats) this.cheats.applyRAM(this.mmu); // GameShark: once per frame
    this._flushApu(); // emit the frame's final audio samples
    // SGB VRAM transfer: a pending _TRN command latches; the next completed
    // frame delivers 8000-8FFF to the SGB (real hardware reads over 5 frames).
    if (this.sgb && this.sgb.pendingTrn) this.sgb.consumeVramBlock(this.ppu.vram.subarray(0, 0x1000));
    return fb;
  }

}

// Binary state format: magic | u16 ver | u32 headerLen | JSON header | raw blobs in header order
function encodeState(header, blobs) {
  const json = (typeof Buffer !== 'undefined')
    ? Buffer.from(JSON.stringify(header), 'utf8')
    : new TextEncoder().encode(JSON.stringify(header));
  const total = 4 + 2 + 4 + json.length + blobs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x50, 0x47, 0x53, 0x54]); // 'PGST'
  dv.setUint16(4, header.v || 1, true);
  dv.setUint32(6, json.length, true);
  out.set(json, 10);
  let off = 10 + json.length;
  for (const b of blobs) { out.set(b, off); off += b.length; }
  return out;
}

function decodeState(u8) {
  if (!(u8[0] === 0x50 && u8[1] === 0x47 && u8[2] === 0x53 && u8[3] === 0x54)) throw new Error('Not a PocketGB state');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jsonLen = dv.getUint32(6, true);
  const json = new TextDecoder().decode(u8.subarray(10, 10 + jsonLen));
  const header = JSON.parse(json);
  const cgb = !!header.cgb;
  const sizes = { wram: (header.mmu && header.mmu.wramSize) || 0x2000,
                  hram: 0x80, vram: (header.mmu && header.mmu.vramSize) || 0x2000,
                  oam: 0xA0, cartRam: 0, waveRam: 16, bgpd: 64, ocpd: 64 };
  sizes.cartRam = header.cart ? (header.cart.ramSize ?? 0) : 0;
  let off = 10 + jsonLen;
  const others = ['wram', 'hram', 'vram', 'oam', 'waveRam'].reduce((s, k) => s + sizes[k], 0);
  const blobSizes = header.blobSizes; // v2+: exact sizes; pre-v2 falls back to heuristics
  const blobs = header.blobs.map((name, i) => {
    const n = blobSizes ? blobSizes[i]
      : name === 'cartRam' ? u8.length - off - others : sizes[name];
    const b = u8.slice(off, off + n); off += n; return new Uint8Array(b);
  });
  return { header, blobs };
}

if (typeof module !== 'undefined') module.exports = { GameBoy };
