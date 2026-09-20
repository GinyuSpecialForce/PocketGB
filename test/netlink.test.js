'use strict';
// Tests for the link-cable netplay transport (src/core/netlink.js).
// Drives real loopback TCP sockets: host → join → byte exchange both ways →
// stop semantics. The Serial layer owns protocol timing; this only proves the
// pipe.

const { test } = require('node:test');
const assert = require('node:assert');
const { NetLink } = require('../src/core/netlink');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('host + join + exchange bytes both directions', async () => {
  const aBytes = [], bBytes = [];
  let aStatus = null, bStatus = null;
  const a = new NetLink({ onByte: (b) => aBytes.push(b), onStatus: (s) => { aStatus = s; } });
  const b = new NetLink({ onByte: (b) => bBytes.push(b), onStatus: (s) => { bStatus = s; } });
  const port = await a.host(0, { lan: false }); // loopback: CI-safe
  assert.ok(port > 0, 'got an assigned port');
  assert.equal(a.status.hosting, true);
  await b.join(port, '127.0.0.1');
  await sleep(50); // socket churn
  assert.equal(a.status.connected, true, 'host sees the peer');
  assert.equal(b.status.connected, true, 'client sees the host');
  a.send(0xAB);
  b.send(0x5C);
  await sleep(50);
  assert.deepEqual(bBytes, [0xAB], 'host byte arrived at client');
  assert.deepEqual(aBytes, [0x5C], 'client byte arrived at host');
  a.stop();
  b.stop();
});

test('lan option exposes a listening address and loopback refuses non-lan', async () => {
  const a = new NetLink();
  const port = await a.host(0, { lan: false });
  const addr = a.server.address();
  assert.equal(addr.address, '127.0.0.1', 'lan=false binds loopback');
  a.stop();
  const c = new NetLink();
  await c.host(0, { lan: true });
  const addr2 = c.server.address();
  assert.equal(addr2.address, '0.0.0.0', 'lan=true binds all interfaces');
  c.stop();
});

test('status reflects connection lifecycle', async () => {
  const a = new NetLink();
  const b = new NetLink();
  const port = await a.host(0);
  await b.join(port, '127.0.0.1');
  await sleep(30);
  b.stop();
  await sleep(50);
  assert.equal(a.status.connected, false, 'host drops to unconnected after client leaves');
  assert.equal(a.status.hosting, true, 'host keeps listening');
  a.stop();
  assert.equal(a.status.hosting, false);
});

test('send with no peer is a safe no-op', () => {
  const a = new NetLink();
  assert.doesNotThrow(() => a.send(0x12));
  assert.doesNotThrow(() => a.stop());
});
