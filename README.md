<div align="center">

# 🎮 PocketGB

**A Game Boy Color / Game Boy (DMG) emulator for macOS — built with Electron**

CPU, PPU, and CGB written from scratch in plain JavaScript. No emulation libraries.
Validated against industry-standard hardware test suites.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS-black?logo=apple&logoColor=white)
![Tests](https://img.shields.io/badge/project_tests-35_passing-brightgreen)
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
| [Blargg `cpu_instrs`](https://github.com/retrio/gb-test-roms) (CPU) | ✅ **11 / 11** individual tests pass |
| Project test suite | ✅ 35 tests (CPU ops & flags, MBC banking, timer, PPU rendering, CGB memory/palette/DMA/speed, save states, smoke ROM) |

<details>
<summary>How the PPU stays accurate</summary>

The PPU is a dot-driven renderer ported from mGBA's software renderer: pixels are
pushed per-dot with register sampling, so mid-scanline writes to `LCDC`, `SCX`,
`WX`, and `WY` land exactly where hardware puts them. The STAT interrupt is
edge-triggered per hardware behavior. OAM DMA transfers over 160 m-cycles while
the CPU keeps running.

</details>

---

## ✨ Features

- **Emulation** — SM83 CPU (full base + CB instruction sets, HALT bug, interrupts), DMG PPU, 4-channel APU (2 pulse, wave, noise) with frame sequencer, DIV/TIMA timers, MBC1 / MBC3 (+ RTC) / MBC5 and ROM-only cartridges
- **Game Boy Color** — full CGB mode: 32 KB banked WRAM, 16 KB banked VRAM with tile/map attributes, 8 BG + 8 OBJ palettes (32K colors), HDMA/GDMA transfers, double-speed mode (<kbd>STOP</kbd> + <kbd>KEY1</kbd>), BGR555 color output, and DMG-compatibility register behavior
- **Persistence** — battery saves (`.sav`), MBC3 RTC storage, and 10 save-state slots per game (<kbd>⌘1</kbd>–<kbd>⌘0</kbd> to load, <kbd>⌘⇧1</kbd>–<kbd>⌘⇧0</kbd> to save), auto-flushed every few seconds and on quit
- **Display** — integer-scaled canvas, full color for CGB games; three palettes (DMG Green, Pocket Gray, Ember) for DMG games, selectable in-app and persisted
- **Audio** — Web Audio output matched to your device's real sample rate (no crackle from rate mismatch)
- **Gamepad support** — Gamepad API, standard mapping, merged with keyboard input
- **Fast-forward & rewind** — hold <kbd>Tab</kbd> to fast-forward, <kbd>Backspace</kbd> to rewind (rolling save-state buffer)
- **Cheats** — GameShark (`01XXXXYY`) and Game Genie (`XXXYYY[ZZZ]`), persisted per game
- **LCD effects** — LCD ghosting and scanlines, toggleable and persisted
- **ROM library** — home screen with recent ROMs, one click to relaunch
- **Remappable input** — keyboard bindings with a press-to-rebind editor
- **Per-game settings** — palette, scale, and cheats remembered per ROM
- **Capture** — PNG screenshots on both DMG and CGB; GIF capture of the last/next ~10 seconds on DMG (color games not yet supported for GIF)
- **Debug overlay** — CPU/PPU registers, next-instruction hint, VRAM tile viewer
- **Link cable** — two PocketGB windows over localhost TCP (host/join), for Pokémon trades and other serial-exchange games
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
> Keyboard bindings are remappable in-app.

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
  cpu.js  mmu.js  ppu.js  ppu-cgb.js  apu.js  timer.js  joypad.js  cartridge.js  gameboy.js
src/ui/               Presentation
  renderer.js  input.js  audio.js
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

The dmg-acid2 and cgb-acid2 tests run their ROMs headless until the screen stabilizes, then compare every pixel against reference images captured from real hardware (each includes a tiny dependency-free PNG codec for the comparison). Both ROMs are committed in `test/`, so no download is needed.

---

## 💾 Data locations

Saves, save states, and the recent-ROMs list live under Electron's `userData` directory: `~/Library/Application Support/pocketgb/` on macOS.

---

## 🗺️ Roadmap

- [x] Game Boy Color (CGB) emulation
- [ ] CGB GIF capture (BGR555-aware GIF encoder)
- [ ] Shaders (subpixel LCD grid, curvature) on top of the existing effects pipeline
- [ ] WebM/video capture alongside GIF
- [ ] Save-state thumbnails in the library

---

## 📝 Notes

> [!NOTE]
> CGB games run in full-color Game Boy Color mode; DMG games keep their classic look. A color game can still be forced into DMG mode from the ROM library settings.

> [!IMPORTANT]
> No ROMs are included — bring your own dumps.

Hack font is © Source Foundry Authors, MIT licensed — see `fonts/HACK_LICENSE`.
