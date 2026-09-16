PocketGB
A Game Boy (DMG) emulator for macOS, built with Electron. The CPU and PPU are written from scratch in plain JavaScript — no emulation libraries — and are validated against industry-standard hardware test suites.

Getting started
Requires Node.js and npm.

bash
Copy
npm install
npm start
Drop a .gb ROM onto the window, or use File → Open ROM… (<kbd>⌘O</kbd>).

Accuracy
Suite	Result
dmg-acid2 (PPU)	Pixel-perfect — 0 / 23,040 pixel mismatches vs. real DMG hardware
Blargg cpu_instrs (CPU)	11 / 11 individual tests pass
Project test suite	13 tests (CPU ops & flags, MBC banking, timer, PPU rendering, save states, smoke ROM)
The PPU is a dot-driven renderer ported from mGBA's software renderer: pixels are pushed per-dot with register sampling, so mid-scanline writes to LCDC, SCX, WX, and WY land exactly where hardware puts them. The STAT interrupt is edge-triggered per hardware behavior. OAM DMA transfers over 160 m-cycles while the CPU keeps running.

Features
Emulation — SM83 CPU (full base + CB instruction sets, HALT bug, interrupts), DMG PPU, 4-channel APU (2 pulse, wave, noise) with frame sequencer, DIV/TIMA timers, MBC1 / MBC3 (+ RTC) / MBC5 and ROM-only cartridges
Persistence — battery saves (.sav), MBC3 RTC storage, and 10 save-state slots per game (<kbd>⌘1</kbd>–<kbd>⌘0</kbd> to load, <kbd>⌘⇧1</kbd>–<kbd>⌘⇧0</kbd> to save), auto-flushed every few seconds and on quit
Display — integer-scaled canvas, three palettes (DMG Green, Pocket Gray, Ember) selectable in-app and persisted
Audio — Web Audio output matched to your device's real sample rate (no crackle from rate mismatch)
Gamepad support — Gamepad API, standard mapping, merged with keyboard input
Fast-forward & rewind — hold <kbd>Tab</kbd> to fast-forward, <kbd>Backspace</kbd> to rewind (rolling save-state buffer)
Cheats — GameShark (01XXXXYY) and Game Genie (XXXYYY[ZZZ]), persisted per game
LCD effects — LCD ghosting and scanlines, toggleable and persisted
ROM library — home screen with recent ROMs, one click to relaunch
Remappable input — keyboard bindings with a press-to-rebind editor
Per-game settings — palette, scale, and cheats remembered per ROM
Capture — PNG screenshots and GIF capture of the last/next ~10 seconds
Debug overlay — CPU/PPU registers, next-instruction hint, VRAM tile viewer
Link cable — two PocketGB windows over localhost TCP (host/join), for Pokémon trades and other serial-exchange games
Convenience — Recent ROMs menu, drag-and-drop from anywhere in the window, pause (<kbd>⌘P</kbd>), mute (<kbd>⌘M</kbd>), reset (<kbd>⌘R</kbd>)
Controls
Key	Button
<kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd>	D-Pad
<kbd>X</kbd>	A
<kbd>Z</kbd>	B
<kbd>Enter</kbd>	Start
<kbd>Shift</kbd>	Select
Keyboard bindings are remappable in-app.

Performance
The core runs a full frame in ~1.9 ms (≈ 517 fps cap, 8.6× realtime headroom), measured on a CPU-heavy workload — rendering, audio, and timers included. Hot paths are allocation-free per frame; the timer is O(1) via falling-edge counting.

Project layout
text
Copy
main.js               Electron main process (window, menu, file I/O)
pocketgb-preload.js   IPC bridge (context-isolated)
app.js                Renderer: main loop, ROM loading, UI wiring
index.html            UI
src/core/             The emulator itself — no DOM, no Electron
  cpu.js  mmu.js  ppu.js  apu.js  timer.js  joypad.js  cartridge.js  gameboy.js
src/ui/               Presentation
  renderer.js  input.js  audio.js
test/                 Test suite + Blargg/dmg-acid2 harnesses
fonts/                Hack typeface (MIT)
The src/core layer is deliberately dependency-free: it loads both as browser globals (for the app) and CommonJS modules (for Node tests).

Testing
bash
Copy
npm test             # unit tests + Blargg cpu_instrs + dmg-acid2
npm run fetch-tests  # download the Blargg ROMs (freely redistributable)
The dmg-acid2 test runs the ROM headless until the screen stabilizes, then compares every pixel against the reference image captured from real hardware (includes a tiny dependency-free PNG codec for the comparison).

Data locations
Saves, save states, and the recent-ROMs list live under Electron's userData directory: ~/Library/Application Support/pocketgb/ on macOS.

Roadmap
 Game Boy Color (CGB) emulation
 Shaders (subpixel LCD grid, curvature) on top of the existing effects pipeline
 WebM/video capture alongside GIF
 Save-state thumbnails in the library
Notes
DMG (original Game Boy) only — GBC ROMs run in DMG compatibility mode; there is no color support yet.
Hack font is © Source Foundry Authors, MIT licensed — see fonts/HACK_LICENSE.
No ROMs are included; bring your own dumps.
