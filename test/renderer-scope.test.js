'use strict';
// Regression test for a real bug: the renderer loads every core file as a
// classic <script> into one shared scope. ppu-cgb.js re-declared bare
// SCREEN_W/SCREEN_H/MODE_HBLANK/OBJ_MARK that ppu.js already declares, which
// threw a SyntaxError at load and killed every later script (app.js included)
// — leaving the Import ROM button and all other UI dead. Node unit tests
// never saw it because CommonJS modules get separate scopes.
//
// This harness reproduces the renderer: run all core scripts in ONE vm
// context, then instantiate a GameBoy and load both a CGB-flagged and a DMG
// ROM to prove the PPU swap works with the real global bindings.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Derive the script order from index.html so the test always mirrors the
// renderer's actual load sequence.
function coreScriptsFromIndex() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(tags.length > 0, 'index.html must declare its scripts as plain <script src> tags');
  return tags.map(rel => path.join(ROOT, rel));
}

// The UI scripts (app.js, src/ui/*) need the DOM, so the shared-scope run
// below covers the core files — where the original collision lived.
const coreScripts = coreScriptsFromIndex().filter(f => f.includes(`${path.sep}core${path.sep}`));

test('every script in index.html exists on disk', () => {
  for (const file of coreScriptsFromIndex()) {
    assert.ok(fs.existsSync(file), `missing script: ${path.relative(ROOT, file)}`);
  }
});

test('core scripts load together in one classic-script scope (renderer parity)', () => {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance, Math, Date, JSON, Error,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int32Array,
    Float32Array, Float64Array, DataView, ArrayBuffer,
    Map, Set, Symbol, Promise,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  for (const file of coreScripts) {
    // Throws (SyntaxError/ReferenceError) exactly like the renderer would.
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }

  // With the real shared bindings in place, the machine must boot both ways.
  const result = vm.runInContext(`
    const gb = new GameBoy();
    const cgbHead = new Uint8Array(0x150); cgbHead[0x143] = 0xC0; // CGB flag
    gb.loadROM(cgbHead);
    const cgbPpu = gb.ppu.constructor.name;
    gb.loadROM(new Uint8Array(0x150));                            // no flag
    const dmgPpu = gb.ppu.constructor.name;
    (cgbPpu === 'CgbPPU' && dmgPpu === 'PPU')
      ? 'OK: CGB -> ' + cgbPpu + ', DMG -> ' + dmgPpu
      : 'FAIL: CGB -> ' + cgbPpu + ', DMG -> ' + dmgPpu;
  `, ctx);

  assert.match(result, /^OK:/, result);
});
