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
const _BreakpointManager = (typeof BreakpointManager !== 'undefined') ? BreakpointManager : require('./debugger').BreakpointManager;
const _CheatEngine = (typeof CheatEngine !== 'undefined') ? CheatEngine : require('./cheats').CheatEngine;
const _cheatsMod = (typeof require === 'function') ? require('./cheats') : null;
const _GbaCheatList = (typeof GbaCheatList !== 'undefined') ? GbaCheatList : (_cheatsMod && _cheatsMod.GbaCheatList);
const _Serial = (typeof Serial !== 'undefined') ? Serial : require('./serial').Serial;
const _SGB = (typeof SGB !== 'undefined') ? SGB : require('./sgb').SGB;
const _gbaHeaderValid = (typeof gbaHeaderValid !== 'undefined') ? gbaHeaderValid
  : (typeof require === 'function' ? require('./gba-header').gbaHeaderValid : null);

function isGbaRom(bytes) {
  if (!_gbaHeaderValid) return false;
  try { return _gbaHeaderValid(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  catch { return false; }
}

class GameBoy {
  constructor() {
    this.cart = null;
    this._gba = null;          // MgbaMachine when a GBA ROM is attached
    this._pendingGba = null;   // { bytes, saveBytes } while the wasm core loads
    this.cheats = new _CheatEngine();
    this._bpMgr = new _BreakpointManager(); // debugger watchpoints (bound to each MMU at loadROM)
    this.serial = new _Serial();
    this.serial.requestInterrupt = (b) => this.requestInterrupt(b);
    this.ppu = new _PPU({ requestInterrupt: (b) => this.requestInterrupt(b), readByte: () => 0xFF });
    this.apu = new _APU();
    this.joypad = new _Joypad({ requestInterrupt: (b) => this.requestInterrupt(b) });
    this.timer = new _Timer({ requestInterrupt: (b) => this.requestInterrupt(b) });
    // Constructor-time CPU gets no MMU yet (machine wiring happens in loadROM);
    // loadROM always builds a fresh CPU bound to the real MMU.
    this.cpu = new _CPU({ read: () => 0xFF, write() {}, tickAccess() {}, ie: 0, if: 0, requestInterrupt() {}, cpu: { pc: 0 } });
  }

  requestInterrupt(bit) { this.cpu.mmu && this.cpu.mmu.requestInterrupt(bit); }

  loadROM(bytes, saveData, forceDmg, bootBytes) {
    if (isGbaRom(bytes)) {
      // GBA path: the mGBA wasm machine loads asynchronously. Park the ROM and
      // expose a stub surface immediately; attachGbaMachine() finishes the job
      // (app.js awaits it before running frames).
      this._gba = null;
      this._pendingGba = { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), saveBytes: saveData || null };
      // GBA codes are applied by mGBA (via the .cheats file), not by the GB
      // engine — swap in the GBA validator so UI add/restore rejects GB codes.
      if (_GbaCheatList && !(this.cheats instanceof _GbaCheatList)) this.cheats = new _GbaCheatList();
      this.cart = {
        rom: this._pendingGba.bytes,
        dirty: false,
        battery: true,
        serializeSav: () => (this._gba ? this._gba.getSav() : new Uint8Array(0)),
      };
      // Neutral GB-side surface so UI probes (mmu.cgb, cpu.pc, joypad) don't
      // crash while the real machine boots up.
      this.cpu = { pc: 0, halted: false, doubleSpeed: false };
      this.ppu = { framebuffer: new Uint8Array(160 * 144), colorFramebuffer: new Uint32Array(160 * 144), cgb: true, frameComplete: false, frameReady: false };
      this.mmu = { cgb: true, read: () => 0xFF, write() {} };
      this.apu = { outputRate: 48000, available: () => 0, pull: () => false, pullBlock: () => new Float32Array(0), setOutputRate() {}, tick() {}, reset() {} };
      this.joypad = { setState: () => {} };
      this._bootBytes = bootBytes || null; // unused by mGBA (HLE boot); kept for reset
      return;
    }
    this._gba = null;
    this._pendingGba = null;
    // Coming off a GBA game the cheat list validates GBA formats — swap back.
    if (!(this.cheats instanceof _CheatEngine)) this.cheats = new _CheatEngine();
    if (this.cart) this.cart.dispose && this.cart.dispose();
    this.cart = new _Cartridge(bytes);
    this.cart.cheats = this.cheats; // Game Genie patches read from this cart
    const cgb = !forceDmg && this.cart.isGBC;
    // DMG WRAM is 8 KB; CGB has 8 banks (32 KB, SVBK bank 0 = bank 1)
    const cgbWram = cgb ? 0x8000 : 0x2000;
    // Swap in the CGB PPU (16 KB VRAM, palette RAM) for color games; a plain
    // PPU otherwise (reused if already the right kind).
    const wantCgb = cgb && !(this.ppu instanceof _CgbPPU);
    const wantDmg = !cgb && (this.ppu instanceof _CgbPPU);
    this.mmu = new _MMU(this, this.cart, cgbWram);
    this.mmu.breakpoints = this._bpMgr; // debugger watchpoints ride the MMU
    this.mmu.cpu = this.cpu;
    this.mmu.cgb = cgb; // CGB address map + registers follow the cartridge flag
    // WRAM size matches the console: 8 banks on CGB, one on DMG.
    this.mmu.wram = new Uint8Array(cgbWram);
    if (wantCgb) this.ppu = new _CgbPPU({ requestInterrupt: (b) => this.requestInterrupt(b) });
    if (wantDmg) this.ppu = new _PPU({ requestInterrupt: (b) => this.requestInterrupt(b), readByte: () => 0xFF });
    this.ppu.readByte = (a) => this.mmu.read(a & 0xFFFF, true);
    this.ppu.mmu = this.mmu; // CGB HDMA reads its source through the bus
    this.cpu = new _CPU(this.mmu); // CPU reads/writes through the MMU
    this.mmu.cpu = this.cpu; // MMU watchpoint checks read cpu.pc
    // Hardware tickers. Per-access time already flows through MMU.tickAccess
    // during cpu.step(); _tickBulk delivers the remaining internal cycles of an
    // instruction at instruction end, and _tickHW is the bulk ticker used by
    // the frame loop and tests (CPU cycles → hardware ticks, halving on CGB
    // double speed since the CPU runs at twice the base rate).
    this._cpuStep = () => this.cpu.step();
    this._tickHW = (cycles) => {
      const n = this.cpu.doubleSpeed ? Math.max(1, cycles >> 1) : cycles;
      this.mmu.tickAccess(n);
    };
    this._tickBulk = (cycles) => {
      const rem = cycles - this.cpu._nAcc * 4;
      if (rem > 0) this._tickHW(rem);
    };
    // MMU needs live component references (joypad serial lines, PPU registers,
    // timer cascade); they are assigned after construction.
    this.mmu.cart = this.cart;
    this.mmu.ppu = this.ppu;
    this.mmu.apu = this.apu;
    this.mmu.timer = this.timer;
    this.mmu.joypad = this.joypad;
    this.mmu.serial = this.serial;
    this.cart.loadSav(saveData);
    // Super Game Boy: an unlocked DMG cart (SGB games) gets the SGB layer so
    // packets ride the joypad's P14/P15 lines. Built fresh per loadROM and
    // linked to the live joypad so resets never orphan it.
    this.sgb = (!cgb && this.cart.rom[0x146] === 0x03 && this.cart.rom[0x14B] === 0x33) ? new _SGB() : null;
    if (this.sgb) { this.joypad.sgb = this.sgb; }
    if (this.cart.mbc7) {
      const _Mbc7 = (typeof Mbc7 !== 'undefined') ? Mbc7 : require('./mbc7').Mbc7;
      this.cart.mbc7 = new _Mbc7();
    }
    this.reset();
    if (this.cart.cheats !== this.cheats)    this.cart.cheats = this.cheats;
    this.cheats.applyROM && this.cheats.applyROM(this.cart);
  }

  // Async completion of the GBA load path. Resolves once the mGBA wasm core
  // has booted the ROM. Safe to call when the ROM is a GB/CGB cart (no-op).
  async attachGbaMachine() {
    if (!this._pendingGba) return;
    const { bytes, saveBytes } = this._pendingGba;
    this._pendingGba = null;
    if (typeof createMgbaMachine !== 'function') throw new Error('mGBA adapter not loaded');
    const machine = await createMgbaMachine(this._gbaCanvas || document.createElement('canvas'));
    machine.loadROM(bytes, saveBytes);
    this._gba = machine;
    this.cart = machine.cart;
    this.cpu = { pc: 0, halted: false, doubleSpeed: false, _gbaStub: true };
    this.ppu = machine.ppu;
    this.apu = machine.apu;
    this.joypad = machine.joypad;
    this.mmu = { cgb: true, read: () => 0xFF, write() {} };
    this.serial = machine.serial;
  }

  get isGba() { return !!this._gba || !!this._pendingGba; }

  reset() {
    if (this._gba) { this._gba.reset(); return; }
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
    if (this._gba) return this._gba.saveState();
    if (this.mmu._apuAcc) { this.apu.tick(this.mmu._apuAcc); this.mmu._apuAcc = 0; } // flush APU batch: no un-emulated cycles in the snapshot
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
    if (this._gba) return this._gba.loadState(u8);
    const { header, blobs } = decodeState(u8);
    if (header.v > 2) throw new Error('Unsupported state version');
    if (!!header.cgb !== !!this.mmu.cgb) throw new Error('State is for a different console type');
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
  // Execution breakpoints: Set of addresses checked before each CPU step.
  get breakpoints() { return this._breakpoints || (this._breakpoints = new Set()); }
  addBreakpoint(addr) { this.breakpoints.add(addr & 0xFFFF); }
  removeBreakpoint(addr) { this.breakpoints.delete(addr & 0xFFFF); }
  clearBreakpoints() { if (this._breakpoints) this._breakpoints.clear(); }
  // Memory watchpoints (r/w/access) via the BreakpointManager on the MMU.
  get watchpoints() { return this._bpMgr; }
  watchRead(addr) { this._bpMgr.watchRead(addr); }
  watchWrite(addr) { this._bpMgr.watchWrite(addr); }
  watchAccess(addr) { this._bpMgr.watchAccess(addr); }
  clearWatchpoints() { this._bpMgr.clear(); }

  stepInstruction() {
    if (this._gba) return 1; // mGBA drives its own loop; single-step is GB-only
    // one CPU step with per-access hardware delivery; returns m-cycles consumed.
    const cycles = this._cpuStep ? this._cpuStep() : this.cpu.step();
    if (this._tickBulk) this._tickBulk(cycles);
    return cycles;
  }

  // While the CPU is halted (HALT/STOP) nothing observes memory, so instead of
  // stepping 4 T at a time — a full 5-component tick chain every step — we
  // deliver time up to the next event that can change interrupt state. The
  // horizons are exact, so wake timing is identical, just batched:
  //   • PPU mode boundary (STAT/vblank edges), in dots
  //   • timer pending reload, or the next falling DIV edge (TIMA overflow IRQ)
  //   • serial transfer completion (serial IRQ)
  // Capped so an event-free stretch still advances in bounded chunks.
  _idleHorizon() {
    const t = this.timer, p = this.ppu, s = this.serial;
    let h = 456; // one scanline: bounds chunk size when nothing is scheduled
    if (p.lcdc & 0x80) {
      const b = p.mode === 3 ? 252 : (p.mode === 2 ? 80 : 456);
      const d = b - p.dot;
      if (d > 0 && d < h) h = d;
    }
    if (t.reloadIn >= 0) {
      if (t.reloadIn < h) h = t.reloadIn;
    } else if (t.tac & 0x04) {
      const P = 1 << ((t.tac & 3) === 0 ? 10 : (t.tac & 3) === 1 ? 4 : (t.tac & 3) === 2 ? 6 : 8);
      const rem = P - (t.div % P);
      if (rem < h) h = rem;
    }
    if (s && s._state !== 0) {
      const c = s._state === 2 ? (s._counter > 0 ? s._counter : 0) : s._counter;
      if (c > 0 && c < h) h = c;
    }
    return h > 0 ? h : 1;
  }

  runFrame() {
    if (this._gba) return this._gba.runFrame();
    if (this._pendingGba) return null; // mGBA core still booting
    if (!this.cart || !this.mmu) return null;
    const fb = this.ppu.colorFramebuffer || this.ppu.framebuffer;
    const cpu = this.cpu;
    const mmu = this.mmu;
    const ppu = this.ppu;
    const cpuStep = this._cpuStep;
    const tickHW = this._tickHW;
    const tickBulk = this._tickBulk;
    ppu.frameComplete = false; // consume last frame's vblank flag
    ppu.frameReady = false;
    // Budget is one frame in 4.19 MHz master T-cycles. In CGB double speed the
    // CPU runs twice as fast, so it gets twice as many cycles and the timed
    // components see half as many of their base-rate ticks (tickers halve).
    let budget = 70224;
    const bps = this._breakpoints;
    const bp = this._bpMgr; // watchpoints: armed check is 3 loads, no call
    this._watchFired = false;
    while (budget > 0) {
      if (bp && bp.armed && bp.enabled) { cpu._watchHit = false; }
      if (bps && bps.has(cpu.pc)) break; // debugger: halt at the breakpoint
      if (cpu.halted && !(mmu.ie & mmu.if & 0x1F)) {
        // Batched idle: advance to the next interrupt-relevant event boundary.
        // Once a pending interrupt appears (IE&IF != 0) we drop through to the
        // normal step path below so cpu.step() wakes/serves it.
        const chunk0 = this._idleHorizon();
        const chunk = chunk0 < budget ? chunk0 : budget;
        // Horizons are master (base-rate) T-cycles; _tickHW takes CPU cycles,
        // so double speed delivers twice as many for the same component time.
        tickHW(cpu.doubleSpeed ? chunk << 1 : chunk);
        budget -= chunk;
        if (ppu.frameComplete) break; // vblank reached: frame is on screen
        continue;
      }
      // cpu.step handles HALT and STOP internally (cheap wait path + interrupt wake).
      let cycles = cpuStep();
      if (bp && bp.armed && bp.enabled && cpu._watchHit) { // debugger: watchpoint fired
        cpu._watchHit = false;
        this._watchFired = true;
        break;
      }
      const master = cpu.doubleSpeed ? Math.max(1, cycles >> 1) : cycles;
      if (master > budget) { cycles = budget << (cpu.doubleSpeed ? 1 : 0); }
      // Deliver the non-access portion of the instruction's time (accesses
      // already ticked through MMU.tickAccess during the step). Inlined here:
      // this runs once per instruction, so the call saved is worth it.
      const rem = cycles - cpu._nAcc * 4;
      if (rem > 0) tickHW(rem);
      budget -= master;
      if (ppu.frameComplete) break; // vblank reached: frame is on screen
    }
    if (mmu._apuAcc) { this.apu.tick(mmu._apuAcc); mmu._apuAcc = 0; } // flush APU batch: exact per-frame sample count
    if (this.cheats) this.cheats.applyRAM(this.mmu); // GameShark: once per frame
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
