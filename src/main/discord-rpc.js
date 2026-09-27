'use strict';
// PocketGB — Discord Rich Presence (main process, zero dependencies).
//
// Talks the Discord IPC protocol over the platform's local named pipe/socket.
// Every frame is a 4-byte little-endian length + one JSON object { op, d }.
// Only what a game needs: HANDSHAKE (op 0), SET_ACTIVITY (op 1) and the
// PING/PONG heartbeat (op 3/4). Reconnection policy lives in main.js so this
// transport stays dumb and unit-testable without a running Discord.

const net = require('net');
const os = require('os');
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const HEARTBEAT_MS = 15000;

function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Pull the first complete frame off a growing buffer: { frame, rest }.
// frame is null when the buffer does not hold a whole frame yet (or fails
// to parse — the caller just drops it and keeps the rest).
function readFrame(buf) {
  if (!buf || buf.length < 4) return { frame: null, rest: buf };
  const len = buf.readUInt32LE(0);
  if (!Number.isFinite(len) || len > 8 * 1024 * 1024) return { frame: null, rest: Buffer.alloc(0) };
  if (buf.length < 4 + len) return { frame: null, rest: buf };
  let frame = null;
  try { frame = JSON.parse(buf.slice(4, 4 + len).toString('utf8')); } catch { frame = null; }
  return { frame, rest: buf.slice(4 + len) };
}

function buildHandshake(clientId) {
  return { v: 1, client_id: String(clientId) };
}

// Discord clamps activity strings at 128 bytes; a long ROM filename must not
// fail the whole update, so we truncate here.
function clamp128(s) {
  s = String(s == null ? '' : s);
  return s.length > 128 ? s.slice(0, 127) + '…' : s;
}

// Build the op-1 SET_ACTIVITY payload. `elapsedSeconds` becomes a start
// timestamp (now − elapsed), so Discord shows total play time ticking up.
function buildActivity({ title, state, elapsedSeconds, instance = true } = {}) {
  const activity = { name: 'PocketGB', type: 0 }; // type 0 = PLAYING
  if (title) activity.details = clamp128(title);
  if (state) activity.state = clamp128(state);
  if (Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0) {
    activity.timestamps = { start: Math.round(Date.now() / 1000 - elapsedSeconds) };
  }
  activity.assets = {
    large_image: 'pocketgb',
    large_text: clamp128(title || 'PocketGB'),
  };
  activity.instance = !!instance;
  return { pid: process.pid, activity };
}

// Where Discord listens: Windows exposes \\.\pipe\discord-ipc-<n>; macOS and
// Linux use a unix socket under XDG_RUNTIME_DIR (or TMPDIR/tmp), optionally
// inside a snap's private runtime dir.
function pipePaths() {
  if (process.platform === 'win32') {
    const out = [];
    for (let i = 0; i < 10; i++) out.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    return out;
  }
  const bases = [];
  if (process.env.XDG_RUNTIME_DIR) bases.push(process.env.XDG_RUNTIME_DIR);
  if (process.env.TMPDIR) bases.push(process.env.TMPDIR);
  bases.push(path.join(os.tmpdir(), 'snap.discord'));
  bases.push('/tmp');
  const out = [];
  for (const b of [...new Set(bases)]) {
    for (let i = 0; i < 10; i++) out.push(path.join(b, `discord-ipc-${i}`));
  }
  return out;
}

class DiscordRpcClient {
  constructor({ clientId, onReady, onClose } = {}) {
    this.clientId = clientId;
    this.onReady = onReady || null;
    this.onClose = onClose || null;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.ready = false;
    this.heartbeat = null;
    this.pendingActivity = undefined; // undefined = nothing queued
  }

  // Try every candidate pipe; resolves once Discord answers the handshake.
  connect() {
    if (this.sock) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const paths = pipePaths();
      let i = 0;
      const tryNext = () => {
        if (i >= paths.length) { reject(new Error('discord is not running')); return; }
        const p = paths[i++];
        const sock = net.connect(p);
        let settled = false;
        sock.once('connect', () => {
          settled = true;
          this.sock = sock;
          this._wire(sock);
          sock.write(encodeFrame(OP.HANDSHAKE, buildHandshake(this.clientId)));
          resolve(true);
        });
        sock.once('error', () => {
          sock.destroy();
          if (!settled) { settled = true; tryNext(); }
        });
      };
      tryNext();
    });
    this._connectPromise.catch(() => { this.sock = null; this._connectPromise = null; });
    return this._connectPromise;
  }

  _wire(sock) {
    this.buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      let { frame, rest } = readFrame(this.buf);
      this.buf = rest;
      while (frame) {
        if (frame.op === OP.CLOSE) { this.destroy(); return; }
        if (frame.op === OP.PONG || frame.op === OP.FRAME) this.ready = true;
        ({ frame, rest } = readFrame(this.buf));
        this.buf = rest;
      }
    });
    sock.once('close', () => {
      this.sock = null;
      this.ready = false;
      this._stopHeartbeat();
      if (this.onClose) this.onClose();
    });
    sock.on('error', () => { /* close follows */ });
    this._startHeartbeat();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.sock) this.sock.write(encodeFrame(OP.PING, Date.now()));
    }, HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  // Queue-and-flush: while offline the latest request is remembered and sent
  // the moment a connection lands, so the first update never races readiness.
  setActivity(payload) {
    this.pendingActivity = payload || null;
    this._flush();
  }

  clearActivity() { this.setActivity(null); }

  _flush() {
    if (!this.sock || !this.ready) return;
    const { pid, activity } = typeof this.pendingActivity === 'object' && this.pendingActivity && 'pid' in this.pendingActivity
      ? this.pendingActivity
      : { pid: process.pid, activity: this.pendingActivity };
    this.sock.write(encodeFrame(OP.FRAME, {
      cmd: activity ? 'SET_ACTIVITY' : 'SET_ACTIVITY',
      args: { pid, activity: activity || {} },
      nonce: String(Date.now()),
    }));
    this.pendingActivity = undefined;
  }

  destroy() {
    this._stopHeartbeat();
    if (this.sock) { try { this.sock.destroy(); } catch { /* already gone */ } }
    this.sock = null;
    this.ready = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OP, encodeFrame, readFrame, buildHandshake, buildActivity, pipePaths, DiscordRpcClient, clamp128 };
}
