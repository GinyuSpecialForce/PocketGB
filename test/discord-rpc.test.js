'use strict';
// Tests for the dependency-free Discord RPC protocol layer: the 4-byte
// length-prefixed frame codec, handshake/activity payload builders, and the
// platform pipe discovery list. The socket transport itself needs a live
// Discord, so only the deterministic parts are asserted here.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  OP, encodeFrame, readFrame, buildHandshake, buildActivity, pipePaths, clamp128,
} = require('../src/main/discord-rpc');

test('encodeFrame/readFrame round-trip an op payload', () => {
  const frame = { op: OP.FRAME, cmd: 'SET_ACTIVITY', args: { pid: 123 } };
  const buf = encodeFrame(frame.op, frame);
  assert.strictEqual(buf.readUInt32LE(0), buf.length - 4, 'length prefix excludes the header');
  const { frame: out, rest } = readFrame(buf);
  assert.deepStrictEqual(out, frame);
  assert.strictEqual(rest.length, 0);
});

test('readFrame: partial buffer yields no frame and keeps the bytes', () => {
  const buf = encodeFrame(OP.PING, { a: 1 });
  const partial = buf.subarray(0, buf.length - 2);
  const { frame, rest } = readFrame(Buffer.from(partial));
  assert.strictEqual(frame, null);
  assert.strictEqual(rest.length, partial.length);
});

test('readFrame: absurd length is dropped, not trusted', () => {
  const bad = Buffer.alloc(8);
  bad.writeUInt32LE(0x7fffffff, 0);
  const { frame, rest } = readFrame(bad);
  assert.strictEqual(frame, null);
  assert.strictEqual(rest.length, 0, 'corrupt buffer is discarded');
});

test('readFrame: two frames in one chunk split cleanly', () => {
  const a = encodeFrame(OP.PING, { n: 1 });
  const b = encodeFrame(OP.PONG, { n: 2 });
  let { frame, rest } = readFrame(Buffer.concat([a, b]));
  assert.strictEqual(frame.n, 1);
  ({ frame, rest } = readFrame(rest));
  assert.strictEqual(frame.n, 2);
  assert.strictEqual(rest.length, 0);
});

test('buildHandshake carries the protocol version and client id', () => {
  assert.deepStrictEqual(buildHandshake(424242), { v: 1, client_id: '424242' });
});

test('buildActivity: playing payload with elapsed → start timestamp and clamped strings', () => {
  const payload = buildActivity({ title: 'x'.repeat(200), state: 'playing — session 5m', elapsedSeconds: 300 });
  assert.strictEqual(payload.activity.details.length, 128, 'details clamped to Discord max');
  assert.strictEqual(payload.activity.state, 'playing — session 5m');
  const now = Math.floor(Date.now() / 1000);
  assert.ok(payload.activity.timestamps.start <= now - 295, 'start = now − elapsed');
  assert.strictEqual(payload.activity.assets.large_image, 'pocketgb');
  assert.strictEqual(payload.activity.type, 0, 'type PLAYING');
  assert.strictEqual(payload.activity.instance, true);
});

test('buildActivity: library payload has no timestamps', () => {
  const payload = buildActivity({ title: 'Tetris', state: 'in the library' });
  assert.ok(!payload.activity.timestamps, 'no session → no start time');
  assert.ok(payload.activity.details);
});

test('clamp128: short strings pass through, long ones truncate at 128', () => {
  assert.strictEqual(clamp128('hi'), 'hi');
  const long = clamp128('y'.repeat(300));
  assert.strictEqual(long.length, 128);
  assert.ok(long.endsWith('…'));
});

test('pipePaths: platform-appropriate candidates, all ending in discord-ipc-N', () => {
  const paths = pipePaths();
  assert.ok(paths.length >= 10);
  for (const p of paths) assert.ok(/discord-ipc-\d$/.test(p), p);
});
