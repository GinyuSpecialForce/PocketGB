// PocketGB — machine wiring: step, runFrame, reset, save states
'use strict';

// Browser loads these via <script> globals; Node tests use require()
const _PPU    = (typeof PPU    !== 'undefined') ? PPU    : require('./ppu').PPU;
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

  loadROM(bytes, saveData) {
    if (this.cart) this.cart.dispose();
    this.cart = new _Cartridge(bytes);
    this.cart.cheats = this.cheats; // Game Genie patches read from this cart
    this.mmu = new _MMU(this.cpu, this.cart, this.ppu, this.apu, this.timer, this.joypad);
    this.mmu.serial = this.serial;
    this.cpu.mmu = this.mmu;
    this.resetComponents();
    if (saveData) this.cart.loadSav(saveData);
    // Hot-loop bindings (runFrame calls these thousands of times per frame)
    this._cpuStep = this.cpu.step.bind(this.cpu);
    this._tickParts = (n) => {
      this.timer.tick(n);
      this.ppu.tick(n);
      this.apu.tick(n);
      this.serial.tick(n);
      this.mmu.dmaTick(n);
    };
  }

  resetComponents() {
    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.timer.reset();
    this.joypad = new _Joypad({ requestInterrupt: (b) => this.requestInterrupt(b) });
    this.mmu.joypad = this.joypad;
    this.mmu.if = 0xE1; this.mmu.ie = 0x00;
    this.serial.reset();
  }

  // ---- save states ----
  saveState() {
    const c = this.cpu, p = this.ppu, a = this.apu, t = this.timer, m = this.mmu, k = this.cart;
    const header = {
      v: 1,
      cpu: { a: c.a, f: c.f, b: c.b, c: c.c, d: c.d, e: c.e, h: c.h, l: c.l, sp: c.sp, pc: c.pc,
             ime: c.ime, imeDelay: c.imeDelay, halted: c.halted, haltBug: c.haltBug, stopped: c.stopped },
      ppu: { lcdc: p.lcdc, stat: p.stat, scy: p.scy, scx: p.scx, ly: p.ly, lyc: p.lyc,
             bgp: p.bgp, obp0: p.obp0, obp1: p.obp1, wy: p.wy, wx: p.wx, dma: p.dma,
             mode: p.mode, dot: p.dot, wly: p.wly, winActive: p.winActive,
             currentWy: p.currentWy, hasWindow: p.hasWindow, lastY: p.lastY, lastX: p.lastX, statLine: p.statLine },
      timer: { div: t.div, tima: t.tima, tma: t.tma, tac: t.tac },
      mmu: { ie: m.ie, if: m.if },
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
      blobs: ['wram', 'hram', 'vram', 'oam', 'cartRam', 'waveRam'],
    };
    const blobs = [m.wram, m.hram, p.vram, p.oam, k.ram, a.waveRam];
    return encodeState(header, blobs);
  }

  loadState(u8) {
    const { header, blobs } = decodeState(u8);
    if (header.v !== 1) throw new Error('Unsupported state version');
    const c = this.cpu, p = this.ppu, a = this.apu, t = this.timer, m = this.mmu, k = this.cart;
    Object.assign(c, header.cpu);
    // Strip undefined so older/newer state versions never clobber live fields
    for (const key of Object.keys(header.ppu)) if (header.ppu[key] === undefined) delete header.ppu[key];
    Object.assign(p, header.ppu);
    Object.assign(t, header.timer);
    m.ie = header.mmu.ie; m.if = header.mmu.if;
    a.enabled = header.apu.enabled; a.nr50 = header.apu.nr50; a.nr51 = header.apu.nr51;
    a.seqStep = header.apu.seqStep; a.seqAcc = header.apu.seqAcc; a.cycleAcc = header.apu.cycleAcc;
    header.apu.ch.forEach((s, i) => Object.assign(a.ch[i], s));
    this.joypad.selectBits = header.joypad.selectBits;
    if (header.serial) this.serial.restore(header.serial);
    Object.assign(k, { romBank: header.cart.romBank, ramBank: header.cart.ramBank, mode: header.cart.mode,
                       bank2: header.cart.bank2, ramEnabled: header.cart.ramEnabled });
    if (header.cart.rtc) Object.assign(k.rtc, header.cart.rtc);
    const [wram, hram, vram, oam, cartRam, waveRam] = blobs;
    m.wram.set(wram); m.hram.set(hram); p.vram.set(vram); p.oam.set(oam);
    k.ram.set(cartRam.subarray(0, k.ram.length)); a.waveRam.set(waveRam);
  }

  // Advance the machine by one rendered frame (70224 m-cycles). Returns the
  // framebuffer (Uint8Array of 160*144 shade indices) when a new frame completes.
  runFrame() {
    if (!this.cart || !this.mmu) return null;
    const fb = this.ppu.framebuffer;
    const cpuStep = this._cpuStep;
    const tickParts = this._tickParts;
    this.ppu.frameComplete = false; // consume last frame's vblank flag
    this.ppu.frameReady = false;
    let budget = 70224;
    while (budget > 0) {
      let cycles;
      if (this.cpu.stopped) {
        // STOP: memory timed components keep running; only the CPU waits.
        cycles = Math.min(65536, budget);
      } else {
        // cpu.step handles HALT internally (cheap 4-cycle path + interrupt wake).
        cycles = cpuStep();
      }
      if (cycles > budget) cycles = budget;
      tickParts(cycles);
      budget -= cycles;
      if (this.ppu.frameComplete) break; // vblank reached: frame is on screen
    }
    if (this.cheats) this.cheats.applyRAM(this.mmu); // GameShark: once per frame
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
  dv.setUint16(4, 1, true);
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
  const sizes = { wram: 0x2000, hram: 0x80, vram: 0x2000, oam: 0xA0, cartRam: 0, waveRam: 16 };
  sizes.cartRam = header.cart ? (header.cart.ramSize ?? 0) : 0;
  let off = 10 + jsonLen;
  const blobs = header.blobs.map(name => {
    const n = name === 'cartRam' ? u8.length - off - ['wram','hram','vram','oam','waveRam'].reduce((s, k) => s + sizes[k], 0) : sizes[name];
    const b = u8.slice(off, off + n); off += n; return new Uint8Array(b);
  });
  return { header, blobs };
}

if (typeof module !== 'undefined') module.exports = { GameBoy };
