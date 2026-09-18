<div align="center">

# 🎮 PocketGB

**A Game Boy Color / Game Boy (DMG) emulator for macOS — built with Electron**

CPU, PPU, and CGB written from scratch in plain JavaScript. No emulation libraries.
Validated against industry-standard hardware test suites.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS-black?logo=apple&logoColor=white)
![Tests](https://img.shields.io/badge/project_tests-117_passing-brightgreen)
![dmg-acid2](https://img.shields.io/badge/dmg_acid2-pixel_perfect-success)
![cgb-acid2](https://img.shields.io/badge/cgb_acid2-pixel_perfect-success)

</div>

---

## 🚀 Getting started

Requires [Node.js](https://nodejs.org/) and npm.

```bash
npm install
npm start
```

Drop a `.gb` or `.gbc` ROM onto the window, or use **File → Open ROM…** (<kbd>⌘O</kbd>). Color games automatically run in full Game Boy Color mode.

---

## 🎯 Accuracy

| Suite | Result |
|---|---|
| [dmg-acid2](https://github.com/mattcurrie/dmg-acid2) (PPU, DMG) | ✅ **Pixel-perfect** — 0 / 23,040 pixel mismatches vs. real DMG hardware |
| [cgb-acid2](https://github.com/mattcurrie/cgb-acid2) (PPU, Color) | ✅ **Pixel-perfect** — 0 / 23,040 pixel mismatches vs. real Game Boy Color hardware |
| [Blargg `cpu_instrs`](https://github.com/retrio/gb-test-roms) (CPU) | ✅ **11 / 11** individual tests pass, plus `02-interrupts` |
| [Blargg `instr_timing` / `mem_timing`](https://github.com/retrio/gb-test-roms) | ⚠️ included and run; known-failing on bus-timing subtleties (documented, reported as skips) |
| Project test suite | ✅ 120 tests (CPU ops & flags, MBC banking incl. MBC1M/MBC30/HuC, timer quirks, PPU rendering, CGB memory/palette/DMA/speed, save states, GIF encoders, cheat engine, patch decoders, movie replay, ROM-title extraction, smoke ROM) |

<details>
<summary>How the PPU stays accurate</summary>

The PPU is a dot-driven renderer ported from mGBA's software renderer: pixels are
pushed per-dot with register sampling, so mid-scanline writes to `LCDC`, `SCX`,
`WX`, and `WY` land exactly where hardware puts them. The STAT interrupt is
edge-triggered per hardware behavior. OAM DMA transfers over 160 m-cycles while
the CPU keeps running.

The timer implements the hardware overflow quirks: the delayed TMA reload with
its 4-cycle window, TIMA write cancellation, and DIV/TAC write edge effects.

</details>

---

## ✨ Features

- **Emulation** — SM83 CPU (full base + CB instruction sets, HALT bug, interrupts), DMG PPU, 4-channel APU (2 pulse, wave, noise) with frame sequencer, hardware-accurate DIV/TIMA timer, OAM DMA with startup delay, MBC1 (+MBC1M multicarts) / MBC3 (+ RTC) / MBC30 / MBC5 / HuC1 / HuC3 and ROM-only cartridges
- **Game Boy Color** — full CGB mode: 32 KB banked WRAM, 16 KB banked VRAM with tile/map attributes, 8 BG + 8 OBJ palettes (32K colors), HDMA/GDMA transfers, double-speed mode (<kbd>STOP</kbd> + <kbd>KEY1</kbd>), BGR555 color output, and DMG-compatibility register behavior
- **Boot ROMs & generated intro** — optionally load original boot ROM dumps for the authentic logo drop, boot chime, and CGB color intro; without a dump, a generated intro plays the same falling-logo animation with chime and CGB color sweep, straight from the cartridge's own boot data
- **Auto-updates** — electron-updater checks GitHub releases in the background, surfaces updates in-app, and installs on restart (Help ▸ Check for Updates…)
- **Persistence** — battery saves (`.sav`), MBC3 RTC storage, and 10 save-state slots per game (<kbd>⌘1</kbd>–<kbd>⌘0</kbd> to load, <kbd>⌘⇧1</kbd>–<kbd>⌘⇧0</kbd> to save), auto-flushed every few seconds and on quit
- **Display** — integer-scaled canvas, full color for CGB games; three palettes (DMG Green, Pocket Gray, Ember) for DMG games, selectable in-app and persisted
- **Audio** — Web Audio output matched to your device's real sample rate (no crackle from rate mismatch)
- **Gamepad support** — Gamepad API, standard mapping, merged with keyboard input (MBC rumble hook ready for `vibrationActuator`)
- **Fast-forward & rewind** — hold <kbd>Tab</kbd> to fast-forward, <kbd>Backspace</kbd> to rewind (rolling save-state buffer)
- **Cheats** — GameShark (Pan Docs layout: `01` + value + little-endian address, e.g. `010238CD`) and Game Genie (`XXXYYY[ZZZ]`), per-game persisted, with per-code toggles, deletion, and text-field-safe typing
- **LCD effects & shader packs** — LCD ghosting, scanlines, a WebGL shader (subpixel LCD grid + optional screen curvature), plus loadable `.pbg-fx` shader packs: JSON + GLSL with validated uniforms, per-game persistence, and hot-reload when you edit the file
- **ROM library** — home screen with recent ROMs, one click to relaunch; cards show cover art (your chosen screenshot, else the newest save-state thumbnail); delete a game's saves or remove it from the library with two-step confirmation
- **Screenshot history** — every screenshot is filed into a per-game gallery (newest 100 kept), browsable as a filmstrip, with per-shot delete and one-click *set as cover art*
- **ROM header editor** — edit title, region, and CGB-compatibility flag right from a library card (a `.hdrbak` backup is written first); the game reloads with the new header immediately
- **Library naming** — clean, junk-filtered titles from the ROM header (handles `0xFF`/NUL padding) with filename fallback; one shared extractor powers every display site, self-repairs stored names on relaunch
- **Remappable input** — keyboard bindings with a press-to-rebind editor
- **Per-game settings** — palette, scale, and cheats remembered per ROM
- **Capture** — PNG screenshots on both DMG and CGB; animated GIF capture on both (4-color for DMG, full 256-color palette with median-cut quantization for CGB); WebM video recording (canvas + game audio) via MediaRecorder
- **Debug overlay** — CPU/PPU registers, next-instruction hint, VRAM tile viewer, breakpoints, step / step×8 / run-to-breakpoint, and a live disassembly listing
- **Link cable & netplay** — host on a port or join any IP (LAN or tunneled internet play) for Pokémon trades and other serial-exchange games
- **ROM-hack patches** — IPS, UPS, BPS, APS, RUP (NINJA2), PPF (v1/v2/v3), and xdelta (VCDIFF) applied automatically from a same-named file next to the ROM, or picked alongside it
- **Game Boy Printer** — full protocol (framing, checksums, RLE, 2bpp tiles): print in-game and PocketGB saves your printout as a PNG. Game Boy Camera photo registers are emulated too
- **Game clock** — live RTC control panel: clock rates up to a full Pokémon day per 24 s, morning/night/noon quick-sets, persisted into battery saves
- **Movie recording** — record input to a `.pgm` file and replay it deterministically (state anchor + ROM fingerprint + per-frame input masks)
- **Convenience** — Recent ROMs menu, drag-and-drop from anywhere in the window, pause (<kbd>⌘P</kbd>), mute (<kbd>⌘M</kbd>), reset (<kbd>⌘R</kbd>)

---

## 🎮 Controls

| Key | Button |
|---|---|
| <kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> | D-Pad |
| <kbd>X</kbd> | A |
| <kbd>Z</kbd> | B |
| <kbd>Enter</kbd> | Start |
| <kbd>Shift</kbd> | Select |

> [!TIP]
> Keyboard bindings are remappable in-app. Text fields (cheat codes, breakpoints, netplay address) always own the keyboard while focused.

---

## ⚡ Performance

The core runs a full frame in **~1.9 ms** (≈ 517 fps cap, 8.6× realtime headroom), measured on a CPU-heavy workload — rendering, audio, and timers included. Hot paths are allocation-free per frame; the timer is O(1) via falling-edge counting.

---

## 📁 Project layout

<details>
<summary>Directory structure</summary>

```text
main.js               Electron main process (window, menu, file I/O)
pocketgb-preload.js   IPC bridge (context-isolated)
app.js                Renderer: main loop, ROM loading, UI wiring
index.html            UI
src/core/             The emulator itself — no DOM, no Electron
  cpu.js  mmu.js  ppu.js  ppu-cgb.js  apu.js  timer.js  joypad.js
  cartridge.js  cheats.js  patch.js  printer.js  movie.js  romtitle.js  gameboy.js
src/ui/               Presentation
  renderer.js  input.js  audio.js  capture.js  rewind.js  debug.js
  boot-animation.js  shader-pack.js
src/main/             Main-process modules (auto-updater)
test/                 Test suite + Blargg/dmg-acid2/cgb-acid2 harnesses
fonts/                Hack typeface (MIT)
```

The `src/core` layer is deliberately dependency-free: it loads both as browser globals (for the app) and CommonJS modules (for Node tests).

</details>

---

## 🧪 Testing

```bash
npm test             # unit tests + Blargg cpu_instrs + dmg-acid2 + cgb-acid2
npm run fetch-tests  # download the Blargg ROMs (freely redistributable)
```

The dmg-acid2 and cgb-acid2 tests run their ROMs headless until the screen stabilizes, then compare every pixel against reference images captured from real hardware (each includes a tiny dependency-free PNG codec for the comparison). Both ROMs are committed in `test/`, so no download is needed. The Blargg suite covers 13 ROMs — `cpu_instrs` (11 + `02-interrupts`) must pass; `instr_timing` and `mem_timing` run too and are documented known-failures on bus-timing subtleties.

---

## 📦 Packaging

```bash
npm run dist:mac     # signed macOS build via electron-builder
npm run dist:win     # Windows
npm run dist:linux   # Linux
```

---

## 💾 Data locations

Saves, save states, and the recent-ROMs list live under Electron's `userData` directory: `~/Library/Application Support/pocketgb/` on macOS.

---

## 📝 Notes

> [!NOTE]
> CGB games run in full-color Game Boy Color mode; DMG games keep their classic look. A color game can still be forced into DMG mode from the ROM library settings.

> [!IMPORTANT]
> No ROMs are included — bring your own dumps. Boot ROMs are user-supplied; without one, games fast-boot to the post-boot state.

Hack font is © Source Foundry Authors, MIT licensed — see `fonts/HACK_LICENSE`.
