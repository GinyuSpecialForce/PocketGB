'use strict';
// Tests for the rewind ring's machine gating: the GBA mGBA machine's save
// states are ~500KB and ~17ms to produce, so snapshotting five times a second
// stalled emulation (~85ms/s). RewindManager now has a rewindable switch —
// GB/CGB keeps the ring, GBA skips snapshots entirely (and keeps no ring).

const { test } = require('node:test');
const assert = require('node:assert');
const { RewindManager } = require('../src/ui/rewind');

function fakeMachine(spy) {
  return {
    saveState() { spy.snapshots++; return new Uint8Array([spy.snapshots & 0xFF]); },
    loadState() { spy.loads++; },
  };
}

test('update: snapshots at most once per interval', () => {
  const spy = { snapshots: 0, loads: 0 };
  const rw = new RewindManager(fakeMachine(spy), { capacity: 4, interval: 200 });
  rw.update(0); // elapsed 0 → nothing yet
  rw.update(100);
  rw.update(199);
  assert.strictEqual(spy.snapshots, 0);
  rw.update(200);
  rw.update(399);
  assert.strictEqual(spy.snapshots, 1, 'one snapshot in the first 200ms window');
  rw.update(400);
  assert.strictEqual(spy.snapshots, 2);
});

test('update: ring respects capacity', () => {
  const spy = { snapshots: 0, loads: 0 };
  const rw = new RewindManager(fakeMachine(spy), { capacity: 3, interval: 10 });
  for (let i = 0; i <= 60; i += 10) rw.update(i);
  assert.strictEqual(rw.entries.length, 3);
  assert.ok(spy.snapshots > 3);
});

test('rewindable=false (GBA): no snapshots, no ring', () => {
  const spy = { snapshots: 0, loads: 0 };
  const rw = new RewindManager(fakeMachine(spy), { capacity: 4, interval: 10 });
  rw.setRewindable(false);
  for (let i = 0; i <= 100; i += 10) rw.update(i);
  assert.strictEqual(spy.snapshots, 0, 'mGBA saveState never called');
  assert.strictEqual(rw.entries.length, 0);
  assert.strictEqual(rw.step(), false, 'step is a no-op');
});

test('setRewindable(false) clears an existing ring (memory reclaimed)', () => {
  const spy = { snapshots: 0, loads: 0 };
  const rw = new RewindManager(fakeMachine(spy), { capacity: 10, interval: 10 });
  for (let i = 0; i <= 100; i += 10) rw.update(i);
  assert.ok(rw.entries.length > 0);
  rw.setRewindable(false);
  assert.strictEqual(rw.entries.length, 0);
});

test('rewindable=true (GB/CGB default): snapshots resume', () => {
  const spy = { snapshots: 0, loads: 0 };
  const rw = new RewindManager(fakeMachine(spy), { capacity: 4, interval: 10 });
  rw.setRewindable(false);
  rw.update(1000);
  assert.strictEqual(spy.snapshots, 0);
  rw.setRewindable(true);
  rw.update(2000);
  assert.strictEqual(spy.snapshots, 1);
});
