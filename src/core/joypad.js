// PocketGB — joypad register (P1/JOYP)
'use strict';

const JOY_RIGHT = 0x01, JOY_LEFT = 0x02, JOY_UP = 0x04, JOY_DOWN = 0x08;
const JOY_A = 0x01, JOY_B = 0x02, JOY_SELECT = 0x04, JOY_START = 0x08;

class Joypad {
  constructor(interrupt) {
    this.interrupt = interrupt;
    this.selectBits = 0x30; // which group selected (active low)
    this.directionBits = 0x0F; // active low: 0 = pressed
    this.actionBits = 0x0F;
  }

  // state: {up,down,left,right,a,b,start,select} booleans
  setState(state) {
    const prevDir = this.directionBits, prevAct = this.actionBits;
    this.directionBits = 0x0F;
    if (state.right) this.directionBits &= ~JOY_RIGHT;
    if (state.left) this.directionBits &= ~JOY_LEFT;
    if (state.up) this.directionBits &= ~JOY_UP;
    if (state.down) this.directionBits &= ~JOY_DOWN;
    this.actionBits = 0x0F;
    if (state.a) this.actionBits &= ~JOY_A;
    if (state.b) this.actionBits &= ~JOY_B;
    if (state.select) this.actionBits &= ~JOY_SELECT;
    if (state.start) this.actionBits &= ~JOY_START;
    if (prevDir !== this.directionBits || prevAct !== this.actionBits) {
      this.interrupt.requestInterrupt(4); // Joypad
    }
  }

  read() {
    let low = 0x0F;
    if (!(this.selectBits & 0x10)) low &= this.directionBits;
    if (!(this.selectBits & 0x20)) low &= this.actionBits;
    return 0xC0 | (this.selectBits & 0x30) | low;
  }

  write(v) { this.selectBits = v & 0x30; }
}

if (typeof module !== 'undefined') module.exports = { Joypad, JOY_RIGHT, JOY_LEFT, JOY_UP, JOY_DOWN, JOY_A, JOY_B, JOY_SELECT, JOY_START };
