'use strict';
// Tests for the GB serial port (src/core/serial.js) — the link-cable exchange
// timing that netplay and printer ride on. Uses two wired Serial instances as
// master/slave and master/master (TCP netplay: both ends run their own clock).

const { test } = require('node:test');
const assert = require('node:assert');
const { Serial } = require('../src/core/serial');

const fire = (s) => s.tick(4096); // one full transfer window

test('master→slave exchange over one transfer window', () => {
  const m = new Serial();
  const s = new Serial();
  m.onSend = (b) => s.receiveByte(b);
  s.onSend = (b) => m.receiveByte(b);
  m.writeSB(0x42);
  s.writeSB(0x99);
  s.writeSC(0x80); // slave: external clock (bit0=0), start bit set
  m.writeSC(0x81); // master: internal clock, start bit set
  fire(m);
  assert.equal(m.sb, 0x99, 'master got the slave byte');
  assert.equal(s.sb, 0x42, 'slave got the master byte');
  assert.equal(m.sc & 0x80, 0, 'master transfer finished');
  assert.equal(s.sc & 0x80, 0, 'slave transfer finished');
});

test('peer byte arriving mid-shift is not discarded at expiry', () => {
  // TCP netplay: both ends are internal-clock masters. The peer's reply can
  // land during our 8 clocks (ST_MASTER_RUN) — the code buffers it in
  // _pendingPeer; expiry must USE that byte, not clear it.
  const a = new Serial();
  const b = new Serial();
  a.onSend = (x) => b.receiveByte(x);
  b.onSend = (x) => a.receiveByte(x);
  a.writeSB(0x11);
  b.writeSB(0x22);
  a.writeSC(0x81); // A starts its transfer
  b.writeSC(0x81); // B starts its own (its reply may land mid-shift at A)
  fire(a); // A's window expires first: its onSend lands in B's shift buffer
  fire(b); // B's own window expires: it must complete with the buffered byte
  assert.equal(b.sb, 0x11, 'B received A\'s byte');
  assert.equal(a.sb, 0x22, 'A uses B\'s byte that arrived mid-shift');
  assert.equal(a.sc & 0x80, 0, 'A finished (no 0xFF timeout)');
  assert.notEqual(a.sb, 0xFF, 'no phantom timeout byte');
});

test('master with no reply times out with 0xFF like an unplugged cable', () => {
  const m = new Serial();
  m.writeSB(0x42);
  m.writeSC(0x81);
  m.tick(4096); // window ends → ST_MASTER_WAIT
  m.tick(280896 + 4096); // reply timeout elapses
  assert.equal(m.sb, 0xFF);
  assert.equal(m.sc & 0x80, 0);
});

test('unsolicited byte latches into SB and raises the serial interrupt', () => {
  const m = new Serial();
  let irq = 0;
  m.requestInterrupt = () => { irq++; };
  m.receiveByte(0x77);
  assert.equal(m.sb, 0x77);
  assert.equal(irq, 1);
});
