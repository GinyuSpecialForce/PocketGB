// PocketGB — link-cable network transport (netplay)
//
// Wraps Node's net module into the byte-exchange transport the Serial layer
// expects: whatever the peer sends lands in onByte, whatever we send goes to
// the peer. One peer at a time (a real link cable has two ends). Used by
// main.js for netplay — both Game Boys run PocketGB, the TCP socket stands in
// for the cable.
//
//   host(port, { lan })  — listen; lan=true binds 0.0.0.0 so a machine on the
//                          same network (or a port-forward) can join, LAN=false
//                          binds loopback only (two copies on one computer).
//   join(port, hostName) — connect to a host. hostName may be a LAN IP or a
//                          DNS name; blank means loopback.
//
// TCP is a byte stream, which is exactly the link cable's model — the Serial
// exchange is byte-oriented and both sides keep their own timing, so no
// framing layer is needed (and none is wanted: it would add latency).
'use strict';
const net = require('net');

class NetLink {
  constructor({ onByte, onStatus, onError } = {}) {
    this.onByte = onByte || null;    // (byte) => void
    this.onStatus = onStatus || null;// (status) => void  — status: {hosting, connected, port}
    this.onError = onError || null;  // (message) => void
    this.server = null;  // net.Server while hosting
    this.sock = null;    // net.Socket while connected (either side)
    this._closed = false;
  }

  get status() {
    return {
      hosting: !!this.server,
      connected: !!(this.sock && !this.sock.destroyed),
      port: this.server ? (this.server.address() && this.server.address().port) : null,
    };
  }

  _emitStatus() { if (this.onStatus) this.onStatus(this.status); }
  _emitError(msg) { if (this.onError) this.onError(msg); }

  _wire(sock) {
    sock.on('data', (buf) => {
      if (!this.onByte) return;
      for (let i = 0; i < buf.length; i++) this.onByte(buf[i]);
    });
    sock.on('close', () => {
      if (this.sock === sock) { this.sock = null; this._emitStatus(); }
    });
    sock.on('error', (err) => this._emitError(String((err && err.message) || err)));
  }

  // Start hosting. Resolves with the listening port (0 → OS-assigned).
  host(port, { lan = false } = {}) {
    this.stop();
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = net.createServer((sock) => {
        if (this.sock && !this.sock.destroyed) { sock.destroy(); return; } // two ends only
        this.sock = sock;
        this._wire(sock);
        this._emitStatus();
      });
      server.on('error', (err) => {
        this.server = null;
        this._emitError(String((err && err.message) || err));
        this._emitStatus();
        if (!settled) { settled = true; reject(err); }
      });
      server.listen(port || 0, lan ? '0.0.0.0' : '127.0.0.1', () => {
        this.server = server;
        this._emitStatus();
        if (!settled) { settled = true; resolve(this.status.port); }
      });
      this.server = server; // visible to status() immediately
    });
  }

  // Connect to a hosting peer. Resolves when the socket connects.
  join(port, hostName) {
    this.stop();
    const target = (typeof hostName === 'string' && hostName.trim().length) ? hostName.trim() : '127.0.0.1';
    return new Promise((resolve, reject) => {
      const sock = net.connect(port || 8765, target);
      this.sock = sock;
      let settled = false;
      sock.on('connect', () => { this._emitStatus(); if (!settled) { settled = true; resolve(); } });
      sock.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      this._wire(sock);
    });
  }

  // Send one byte (or a burst) to the peer. No-op when unconnected.
  send(b) {
    if (this.sock && !this.sock.destroyed) {
      try { this.sock.write(typeof b === 'number' ? Buffer.from([b & 0xFF]) : Buffer.from(b)); }
      catch { /* peer vanished mid-write; close handler cleans up */ }
    }
  }

  stop() {
    if (this.sock) { this.sock.destroy(); this.sock = null; }
    if (this.server) { this.server.close(); this.server = null; }
    this._emitStatus();
  }

  dispose() { this._closed = true; this.stop(); }
}

if (typeof module !== 'undefined') module.exports = { NetLink };
