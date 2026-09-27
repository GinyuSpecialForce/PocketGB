'use strict';
// Tests for play-time accounting: store accumulation/formatting plus the
// live session accumulator that feeds both persistence and presence elapsed.

const { test } = require('node:test');
const assert = require('node:assert');
const { addTime, getTime, fmtPlaytime, PlaySession } = require('../src/main/playtime');

test('addTime: accumulates per-game seconds under the settings key', () => {
  const s = {};
  assert.strictEqual(addTime(s, 'abc', 30), 30);
  assert.strictEqual(addTime(s, 'abc', 45), 75);
  assert.strictEqual(s['game:abc:playtime'], 75);
  assert.strictEqual(getTime(s, 'abc'), 75);
});

test('addTime: ignores junk input and returns the untouched total', () => {
  const s = { 'game:abc:playtime': 10 };
  assert.strictEqual(addTime(s, 'abc', -5), 10, 'negative seconds rejected');
  assert.strictEqual(addTime(s, '', 5), 0, 'empty key has no total');
  assert.strictEqual(addTime(s, 'abc', NaN), 10);
  assert.strictEqual(addTime(s, null, 5), 0);
  assert.strictEqual(s['game:abc:playtime'], 10, 'store not corrupted');
});

test('addTime: rounds to whole seconds, keeps fractional accrual', () => {
  const s = {};
  addTime(s, 'k', 1.6); // → 2
  addTime(s, 'k', 1.4); // → 3 (2 + round(1.4)=1)
  assert.strictEqual(getTime(s, 'k'), 3);
});

test('fmtPlaytime: seconds, minutes, hours+minutes, exact hours', () => {
  assert.strictEqual(fmtPlaytime(0), '0s');
  assert.strictEqual(fmtPlaytime(45), '45s');
  assert.strictEqual(fmtPlaytime(60), '1m');
  assert.strictEqual(fmtPlaytime(754), '12m');
  assert.strictEqual(fmtPlaytime(12240), '3h 24m');
  assert.strictEqual(fmtPlaytime(10800), '3h');
});

test('PlaySession: ticks accrue only while a game is active', () => {
  const sess = new PlaySession();
  sess.tick(5);
  assert.strictEqual(sess.elapsed, 0, 'no game → no accrual');
  sess.start('gameA');
  sess.tick(1.5);
  sess.tick(1.5);
  assert.strictEqual(sess.elapsed, 3);
  sess.stop();
  sess.tick(10);
  assert.strictEqual(sess.elapsed, 3, 'stopped session ignores ticks');
});

test('PlaySession: take() banks whole seconds and keeps the remainder', () => {
  const sess = new PlaySession();
  sess.start('gameA');
  sess.tick(10.75);
  assert.strictEqual(sess.take(), 10);
  assert.ok(sess.played > 0 && sess.played < 1, 'remainder kept');
  sess.tick(0.5);
  assert.strictEqual(sess.take(), 1, 'remainder + next tick = 1 whole second');
  assert.strictEqual(sess.take(), 0);
});

test('PlaySession: switching games restarts elapsed at zero', () => {
  const sess = new PlaySession();
  sess.start('gameA');
  sess.tick(120);
  sess.start('gameB');
  assert.strictEqual(sess.elapsed, 0);
  sess.tick(2);
  assert.strictEqual(sess.elapsed, 2);
});
