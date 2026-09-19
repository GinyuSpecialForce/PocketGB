'use strict';
// Regression test for the cheat-persistence bug: the per-game settings key is
// `game:<base64url-of-rom-path>:<field>`, and main.js's `set-setting` IPC
// guard rejects keys over a length bound. Long ROM paths (e.g. Super Mario
// Bros. Deluxe's 96-char path) base64 out to keys of 150+ chars, which the
// original 128-char bound silently dropped — cheats never reached
// settings.json. This pins the real bound (read from main.js source) against
// the keys the app actually builds.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

function settingKeyBound() {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  const m = src.match(/key\.length > (\d+)\)/);
  assert.ok(m, 'main.js set-setting guard (key.length > N) not found');
  return Number(m[1]);
}

// Mirrors romKey() in main.js — the app's canonical key for a ROM path.
function romKey(romPath) {
  return Buffer.from(romPath.toLowerCase()).toString('base64url');
}

// Real-world ROM paths that must keep working.
const PATHS = [
  '/Users/jon/Downloads/Super Mario Bros. Deluxe (Europe) (Rev 2)/Super Mario Bros. Deluxe (Europe) (Rev 2).gbc',
  '/Users/jon/Downloads/Tetris (World) (Rev 1)/Tetris (World) (Rev 1).gb',
  '/home/user/roms/pokemon - crystal version (UE) (V1.0)/[C][!].gbc',
];

test('every persisted per-game settings key fits under the set-setting bound', () => {
  const bound = settingKeyBound();
  for (const p of PATHS) {
    for (const field of ['cheats', 'palette', 'scale', 'shaderPackPath']) {
      const key = `game:${romKey(p)}:${field}`;
      assert.ok(
        key.length <= bound,
        `key of length ${key.length} exceeds guard bound ${bound} — settings for this game would be silently dropped: ${key}`
      );
    }
  }
});

test('SMB Deluxe cheat key specifically fits (the reported bug)', () => {
  const bound = settingKeyBound();
  const key = `game:${romKey(PATHS[0])}:cheats`;
  assert.ok(key.length > 128, 'precondition: this key was over the old 128 bound');
  assert.ok(key.length <= bound);
});
