// PocketGB — debugger: watchpoints on memory access
//
// Breakpoints (break on fetch at PC) already live on the machine. This module
// adds watchpoints — break when a specific address is READ, WRITTEN, or BOTH —
// the tool that answers "what code touches this RAM address?".
//
// Cost model: the MMU consults the watchpoint sets on every read/write ONLY
// when at least one watchpoint is armed (two Set.has calls, a few ns). With
// none armed the cost is one undefined check per access. Breakpoints stay
// exactly where they were (runFrame's fetch check).
'use strict';

class BreakpointManager {
  constructor() {
    this.reads = new Set();    // addresses that fire on read
    this.writes = new Set();   // addresses that fire on write
    this.armed = false;        // any watchpoints present?
    this.lastHit = null;       // { addr, kind, pc } — cleared by the debugger
    this.enabled = true;       // master switch (UI pause button)
  }

  watchRead(addr) { this.reads.add(addr & 0xFFFF); this._rearm(); }
  watchWrite(addr) { this.writes.add(addr & 0xFFFF); this._rearm(); }
  watchAccess(addr) { this.watchRead(addr); this.watchWrite(addr); }

  unwatchRead(addr) { this.reads.delete(addr & 0xFFFF); this._rearm(); }
  unwatchWrite(addr) { this.writes.delete(addr & 0xFFFF); this._rearm(); }

  clear() { this.reads.clear(); this.writes.clear(); this._rearm(); }

  _rearm() { this.armed = this.reads.size > 0 || this.writes.size > 0; }

  // Called from the MMU. Returns true when a watchpoint fired (the caller
  // breaks execution); the hit is recorded for the UI.
  check(addr, kind, pc) {
    if (!this.armed || !this.enabled) return false;
    const set = kind === 'r' ? this.reads : this.writes;
    if (!set.has(addr & 0xFFFF)) return false;
    this.lastHit = { addr: addr & 0xFFFF, kind, pc: pc & 0xFFFF };
    return true;
  }

  list() {
    const out = [];
    for (const a of this.reads) out.push({ addr: a, kind: 'r' });
    for (const a of this.writes) out.push({ addr: a, kind: 'w' });
    return out.sort((x, y) => x.addr - y.addr);
  }
}

// Step-over / step-out planning lives here so the app layer stays thin.
//   stepOver: if the next instruction is CALL (or RST with a real routine),
//   run until PC returns to the instruction AFTER the call. Any other
//   instruction: a plain step.
//   stepOut: run until SP exceeds the current frame's return address slot —
//   i.e. until the current function RETs. Heuristic on stack layout (no frame
//   pointers on SM83), which is what every GB debugger does.
function isCallOpcode(op) { return op === 0xCD || (op & 0xC7) === 0xC4; } // CALL nn / CALL cc,nn
function isRstOpcode(op) { return (op & 0xC7) === 0xC7; }

function stepOverTarget(cpu) {
  const op = cpu.mmu.read(cpu.pc);
  if (isCallOpcode(op)) return (cpu.pc + 3) & 0xFFFF;
  if (isRstOpcode(op)) return (cpu.pc + 1) & 0xFFFF;
  return null; // plain step
}

function stepOutFrameReturn(cpu) {
  // The return address of the current frame sits at SP (unless the function
  // just pushed — take SP as-is; that matches "return to caller").
  return cpu.mmu.read(cpu.sp) | (cpu.mmu.read((cpu.sp + 1) & 0xFFFF) << 8);
}

if (typeof module !== 'undefined') module.exports = { BreakpointManager, isCallOpcode, isRstOpcode, stepOverTarget, stepOutFrameReturn };
if (typeof window !== 'undefined') window.PocketDebug = { stepOverTarget, stepOutFrameReturn, isCallOpcode };
