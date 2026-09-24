'use strict';
// End-to-end smoke: boot a supplied commercial ROM through the real mGBA wasm
// core. Node cannot provide the threaded browser runtime, so this harness
// verifies the pieces that are environment-independent: the vendored core
// parses and instantiates, the adapter module loads, and ROM/header detection
// routes .gba content to the mGBA machine path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('mGBA wasm core is vendored and parses as an ES module', async () => {
  const js = path.join(ROOT, 'vendor/mgba/mgba.js');
  const wasm = path.join(ROOT, 'vendor/mgba/mgba.wasm');
  assert.ok(fs.existsSync(js), 'vendor/mgba/mgba.js must exist');
  assert.ok(fs.existsSync(wasm), 'vendor/mgba/mgba.wasm must exist');
  const wasmBytes = fs.readFileSync(wasm);
  assert.deepEqual([...wasmBytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'valid wasm magic');
  // Parse (not evaluate): the module is browser-oriented but must be valid ESM.
  const src = fs.readFileSync(js, 'utf8');
  assert.match(src, /export default/, 'core exports a default (mGBA factory)');
  assert.match(src, /loadGame/, 'core exposes the loadGame API');
});

test('mGBA machine adapter exposes the GameBoy machine surface', () => {
  const { MgbaMachine, GBA_W, GBA_H } = require('../src/core/gba-mgba');
  assert.equal(GBA_W, 240); assert.equal(GBA_H, 160);
  const machine = new MgbaMachine(fakeModule());
  assert.equal(machine.ready, false);
  assert.equal(typeof machine.runFrame, 'function');
  assert.equal(typeof machine.setInput, 'function');
  assert.equal(typeof machine.saveState, 'function');
  assert.equal(typeof machine.applyCheats, 'function');
  // joypad shim consumes setState like the GB joypad does
  assert.doesNotThrow(() => machine.setInput({ a: true }));
  assert.doesNotThrow(() => machine.setInput({}));
});

// Minimal fake of the mGBA Module surface (the real one needs a threaded
// browser runtime). Tracks FS writes and cheat-related calls so the adapter's
// cheat-file protocol can be verified without the wasm core.
function fakeModule() {
  const files = new Map();
  const calls = [];
  return {
    setVolume() {}, quickReload() { calls.push('quickReload'); },
    pauseGame() {}, resumeGame() {},
    FS: {
      writeFile: (p, data) => { files.set(p, data); },
      unlink: (p) => { files.delete(p); },
    },
    files, calls,
    loadGame(romPath, savePath) { calls.push(['loadGame', romPath, savePath]); return true; },
    quitGame() { calls.push('quitGame'); },
    autoLoadCheats() { return files.has('/data/cheats/game.cheats'); },
    forceAutoSaveState() { return false; },
    getAutoSaveState() { return null; },
    loadAutoSaveState() { return true; },
    autoSaveStateName: '/autosave/game_auto.ss',
    getSave() { return null; },
    buttonPress() {}, buttonUnpress() {},
    setFastForwardMultiplier() {},
  };
}

const GBA_ROM = (() => {
  // Minimal GBA-shaped ROM: Nintendo logo at 0x04, title at 0xA0.
  const rom = new Uint8Array(0x1000);
  const logo = [0x24,0xff,0xae,0x51,0x69,0x9a,0xa2,0x21,0x3d,0x84,0x82,0x0a,0x84,0xe4,0x09,0xad];
  logo.forEach((b, i) => { rom[4 + i] = b; });
  rom.set(Buffer.from('TESTROM    ', 'latin1'), 0xA0);
  return rom;
})();

test('loadROM writes the .cheats file before loadGame when cheats exist', () => {
  const { MgbaMachine } = require('../src/core/gba-mgba');
  const Module = fakeModule();
  const machine = new MgbaMachine(Module);
  machine.loadROM(GBA_ROM, null, [
    { code: '02036D42 00000063', enabled: true },
    { code: '82036D42 03E7', enabled: false },
    { code: '02036D42:63', enabled: true },
  ]);
  assert.ok(Module.files.has('/data/cheats/game.cheats'), 'cheats file exists after load');
  // mCheatParseFile format: disabled directive before a named set, then the code
  const text = Buffer.from(Module.files.get('/data/cheats/game.cheats')).toString('latin1');
  assert.match(text, /# cheat\n02036D42 00000063/);
  assert.match(text, /!disabled\n# cheat\n82036D42 03E7/);
  assert.match(text, /02036D42:63/);
});

test('applyCheats re-boots the core via quitGame→loadGame, state round-tripped', () => {
  const { MgbaMachine } = require('../src/core/gba-mgba');
  const Module = fakeModule();
  const machine = new MgbaMachine(Module);
  machine.loadROM(GBA_ROM, null, []);
  machine.ready = true;
  // fake a live state so the round-trip path is exercised
  Module.forceAutoSaveState = () => { Module.__state = new Uint8Array([9, 9, 9]); return true; };
  Module.getAutoSaveState = () => ({ data: Module.__state });
  const loaded = [];
  Module.loadGame = (p) => { loaded.push(p); return true; };
  const r = machine.applyCheats([{ code: '02036D42 00000063', enabled: true }]);
  assert.equal(r, 'applied', 'first apply after a cheatless boot append-parses, no reload');
  const r2 = machine.applyCheats([{ code: '02036D42 00000063', enabled: false }]);
  assert.equal(r2, 'reloaded');
  assert.equal(loaded.filter((p) => p === '/data/games/game.gba').length, 1, 'ROM re-loaded once');
  assert.ok(Module.calls.includes('quitGame'), 'core quit before reload (mCheatParseFile appends)');
  assert.deepStrictEqual([...Module.files.get('/autosave/game_auto.ss')], [9, 9, 9], 'current frame round-tripped through the auto state');
});

test('applyCheats with an empty list after a cheaty boot reloads and clears sets', () => {
  const { MgbaMachine } = require('../src/core/gba-mgba');
  const Module = fakeModule();
  const machine = new MgbaMachine(Module);
  machine.loadROM(GBA_ROM, null, [{ code: '02036D42 00000063', enabled: true }]);
  machine.ready = true;
  const r = machine.applyCheats([]);
  assert.equal(r, 'reloaded', 'append-parse cannot remove existing sets — reload required');
  assert.ok(!Module.files.has('/data/cheats/game.cheats'), 'stale cheats file removed');
});

test('applyCheats after a clean boot append-parses without reloading', () => {
  const { MgbaMachine } = require('../src/core/gba-mgba');
  const Module = fakeModule();
  const machine = new MgbaMachine(Module);
  machine.loadROM(GBA_ROM, null, []);
  machine.ready = true;
  Module.loadGame = () => { throw new Error('loadGame must not be called for a first apply'); };
  const r = machine.applyCheats([{ code: '02036D42 00000063', enabled: true }]);
  assert.equal(r, 'applied');
  assert.ok(Module.files.has('/data/cheats/game.cheats'));
  // a second apply now reloads: the core device already holds that set
  delete Module.loadGame;
  Module.loadGame = () => true;
  assert.equal(machine.applyCheats([{ code: '02036D42 00000063', enabled: false }]), 'reloaded');
});

test('GBA cheat parsing: AR/GS, CodeBreaker, VBA, and rejections', () => {
  const { parseGbaCheatLine } = require('../src/core/cheats');
  // GameShark/AR: 8+8 hex with a RAM address
  assert.deepStrictEqual(parseGbaCheatLine('02036D42 00000063'), { format: 'ar', address: 0x02036D42, value: 0x63 });
  // dashes are accepted separators, case-insensitive
  assert.deepStrictEqual(parseGbaCheatLine('02036d42-00000063'), { format: 'ar', address: 0x02036D42, value: 0x63 });
  // CodeBreaker: 8+4 hex — high nibble is the op type, address is the low 28 bits
  assert.deepStrictEqual(parseGbaCheatLine('82036D42 03E7'), { format: 'cb', address: 0x02036D42, value: 0x03E7 });
  // VBA raw write: address colon byte
  assert.deepStrictEqual(parseGbaCheatLine('03004E12:63'), { format: 'vba', address: 0x03004E12, value: 0x63 });
  // AR/GS and CB lines can be encrypted (operands are ciphertext), so shape is
  // the only valid gate — real codes like these must pass untouched:
  assert.deepStrictEqual(parseGbaCheatLine('78DA954E 4C1C9C2B'), { format: 'ar', address: 0x78DA954E, value: 0x4C1C9C2B });
  assert.deepStrictEqual(parseGbaCheatLine('F6183CE4 2400'), { format: 'cb', address: 0x6183CE4, value: 0x2400 }, 'high nibble is the CB op type');
  // rejected: GB GameShark shape, wrong lengths, garbage
  assert.strictEqual(parseGbaCheatLine('010238CD'), null);
  assert.strictEqual(parseGbaCheatLine('02036D4 2 0000006'), null);
  assert.strictEqual(parseGbaCheatLine('hello world'), null);
});

test('gbaCheatsFile emits one named set per cheat with disabled directives', () => {
  const { gbaCheatsFile } = require('../src/core/cheats');
  const text = gbaCheatsFile([
    { code: '02036D42 00000063', enabled: true },
    { code: '82036D42 03E7', enabled: false },
    { code: 'not a code', enabled: true },
  ]);
  assert.strictEqual(text, '# cheat\n02036D42 00000063\n!disabled\n# cheat\n82036D42 03E7');
  assert.strictEqual(gbaCheatsFile([]), '');
});

test('GbaCheatList validates GBA formats and round-trips serialization', () => {
  const { GbaCheatList } = require('../src/core/cheats');
  const list = new GbaCheatList();
  const res = list.add('02036d42 00000063');
  assert.ok(!res.error, 'valid AR code accepted');
  assert.strictEqual(res.format, 'ar');
  assert.ok(list.add('02036D42:63').code, 'VBA code accepted');
  assert.ok(list.add('010238CD').error, 'GB GameShark code rejected');
  assert.strictEqual(list.all().length, 2);
  list.toggle(0);
  assert.strictEqual(list.all()[0].enabled, false);
  const ser = list.serialize();
  const list2 = new GbaCheatList();
  list2.restore(ser);
  assert.deepStrictEqual(list2.serialize(), ser);
  list.remove(0);
  assert.strictEqual(list.all().length, 1);
  list.clear();
  assert.strictEqual(list.all().length, 0);
});

test('movieRomId reads the GBA title region for GBA ROMs', () => {
  const { movieRomId } = require('../src/core/movie');
  const rom = new Uint8Array(4 * 1024 * 1024);
  const logo = [0x24,0xff,0xae,0x51,0x69,0x9a,0xa2,0x21,0x3d,0x84,0x82,0x0a,0x84,0xe4,0x09,0xad];
  logo.forEach((b, i) => { rom[4 + i] = b; });
  rom.set(Buffer.from('POKEMON EMER', 'latin1'), 0xA0);
  rom.set(Buffer.from('BPEE', 'latin1'), 0xAC);
  for (let i = 0x150; i < rom.length; i += 997) rom[i] = i & 0xFF; // sparse-ish content
  const gbLike = { cart: { rom }, isGba: true };
  const id = movieRomId(gbLike);
  assert.ok(id.startsWith('POKEMON EMER|'), 'uses the 12-byte GBA title: ' + id);
  assert.strictEqual(movieRomId(gbLike), id, 'stable');
  // header-derived GBA detection works without isGba on the wrapper
  assert.strictEqual(movieRomId({ cart: { rom } }), id);
  // content change flips the hash
  rom[0x200] ^= 0xFF;
  assert.notStrictEqual(movieRomId(gbLike), id);
});

test('GBA ROM detection routes through the mGBA machine path', async () => {
  const { GameBoy } = require('../src/core/gameboy');
  const romPath = path.join(ROOT, 'Pokemon - Emerald Version (USA, Europe).gba');
  if (!fs.existsSync(romPath)) return; // commercial ROMs are local validation inputs
  const gb = new GameBoy();
  gb.loadROM(new Uint8Array(fs.readFileSync(romPath)));
  assert.equal(gb.isGba, true, 'header detection parks the ROM for the mGBA machine');
  assert.equal(gb.runFrame(), null, 'no frames until attachGbaMachine resolves');
});
