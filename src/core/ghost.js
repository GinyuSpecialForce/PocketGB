// PocketGB — ghost racer: race a replay of your own best run.
//
// A "ghost" is a PocketGB movie (.pgm, see movie.js): anchor save-state +
// per-frame input masks. The ghost runs a SECOND full emulation of the same
// ROM from the movie's anchor, fed the recorded inputs, while you keep playing
// the live machine with your own inputs. The ghost's framebuffer is displayed
// at full palette color in its own PiP panel (renderer.blitGhost) beside the
// game screen. Because the ghost is a real machine (not a video), it reacts
// to nothing — it is exactly your past self, which is the point.
//
// Race lifecycle (the two timelines must START together to be comparable):
//   load()  → arms the ghost (held frozen; PiP shows "armed")
//   startOnReset semantics: the app calls startNow() from its reset hook, so
//             F8 / the reset button launches the race from a shared moment —
//             the same keypress restarts the timer and the ghost.
//   startNow() → launch immediately without touching your game (comparison
//             starts from the movie's anchor point, not your position).
//   step() advances one frame per produced frame, so tempo stays locked.
//   pause()/resume() freeze the ghost with the game (rewind included).
//
// Cost while racing: one extra runFrame per frame (≈2× CPU). Audio, serial,
// and timers of the ghost machine are self-contained; its APU ring drops
// samples unread so nothing accumulates.
'use strict';

class GhostRacer {
  constructor(mainGb, machineClass) {
    this.main = mainGb;
    // Machine class: injected for tests; the app resolves the global that
    // gameboy.js (classic script) publishes.
    this.GB = machineClass || (typeof GameBoy !== 'undefined' ? GameBoy : null);
    this.gb = null;          // the ghost machine (lazy)
    this.frames = null;      // recorded input masks
    this.pos = 0;
    this.active = false;     // racing right now
    this.armed = false;      // movie loaded, waiting for the starting gun
    this.paused = false;     // frozen with the game (pause / rewind)
    this.done = false;       // ghost reached the end of its recording
    this.romId = null;
    this.diverged = false; // input echo: you left the recorded path
    this.nextEcho = null;  // input echo: mask the ghost will play next frame
  }

  // bytes: a .pgm movie file. ARMS the ghost — it does not move until
  // startNow() is called. Returns an error string or null on success.
  load(bytes) {
    try {
      if (!window.PocketMovie) return 'movie system unavailable';
      if (bytes.length < 12 || bytes[0] !== 0x50 || bytes[1] !== 0x47 || bytes[2] !== 0x42 || bytes[3] !== 0x4D) {
        return 'not a PocketGB movie';
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const jsonLen = dv.getUint32(4, true);
      const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen)));
      const o1 = 8 + jsonLen;
      const stateLen = dv.getUint32(o1, true);
      this.anchorState = bytes.slice(o1 + 4, o1 + 4 + stateLen);
      this.frames = bytes.slice(o1 + 4 + stateLen);
      this.romId = meta.rom;
      if (this.frames.length < meta.frames) return 'truncated movie file';
      // Validate the movie belongs to the running game before offering a race.
      if (!this.main || !this.main.cart || !this.main.cart.rom) return 'load a game first';
      const mainId = window.PocketMovie.movieRomId(this.main);
      if (this.romId !== mainId) return `movie is for ${this.armed ? '' : ''}${this.romId.split('|')[0] || 'another game'}`;
      this.pending = true;
      this.armed = true;
      this.done = false;
      this.pos = 0;
      return null;
    } catch {
      return 'corrupt movie file';
    }
  }

  // Launch the race NOW: boots the ghost machine from the same ROM, loads the
  // movie's anchor state, and begins advancing with the live machine. Both
  // timelines start at the movie's anchor point — the shared "frame 0".
  // Returns an error string or null.
  startNow() {
    if (!this.pending || !this.anchorState) return 'no ghost loaded';
    try {
      if (!this.GB) return 'machine class unavailable';
      if (!this.gb) this.gb = new this.GB();
      // Match the live machine's color mode so framebuffer formats agree
      // (a force-DMG main must produce a DMG ghost), and share the live
      // machine's cheats so the ghost races under the same rules it recorded.
      const forceDmg = this.main.mmu ? !this.main.mmu.cgb : false;
      this.gb.loadROM(this.main.cart.rom, undefined, forceDmg, undefined);
      this.gb.cheats = this.main.cheats;
      this.gb.loadState(new Uint8Array(this.anchorState));
      this.pos = 0;
      this.active = true;
      this.armed = false;
      this.paused = false;
      this.done = false;
      // Input echo (Input Echo Trainer): reset divergence tracking. The echo
      // strip renders frames[this.pos] — the input the ghost will play NOW.
      this.diverged = false;
      this.lastEcho = null;
      return null;
    } catch (e) {
      this.active = false;
      return 'ghost failed to start: ' + (e && e.message || e);
    }
  }

  // Convenience predicate for the app's reset hook: launch on the next reset?
  get waitingForReset() { return this.armed && !this.active; }

  // One emulated frame. mainMask: the LIVE player's input this frame (that is
  // what you race with). The ghost plays its own recorded input. Returns the
  // ghost framebuffer (PiP-ready) or null when not racing / frozen / finished.
  step(mainMask) {
    if (!this.active || !this.gb) return null;
    if (this.paused) return null;
    if (this.pos >= this.frames.length) {
      this.active = false;
      this.done = true;
      return null;
    }
    // Input Echo Trainer bookkeeping, BEFORE consuming the frame:
    //   nextEcho — the input the ghost is about to play (for the glyph strip)
    //   diverged — you pressed something the recording didn't (or missed
    //              something it did) at the same frame. "≠ pressed" means the
    //              timelines are no longer comparable from here.
    this.nextEcho = this.frames[this.pos];
    if (mainMask !== undefined && mainMask !== null) {
      if ((mainMask & 0xFF) !== this.nextEcho) {
        if (!this.diverged) this._divergeAt = this.pos; // first frame off the path
        this.diverged = true;
      }
    }
    const mask = this.frames[this.pos++];
    this.gb.joypad.setState(window.PocketMovie.maskToState(mask));
    return this.gb.runFrame();
  }

  // Input Echo Trainer accessors.
  // Mask the ghost will play on the NEXT step() (or null when idle/done).
  get echoMask() {
    if (!this.active || this.paused || this.done) return null;
    return this.pos < this.frames.length ? this.frames[this.pos] : null;
  }
  // True from the first mismatched frame onward until the race restarts.
  get divergedFromRecording() { return !!this.diverged; }
  // First frame index where you left the recorded path (or null if not).
  get divergenceFrame() { return this.diverged ? this._divergeAt : null; }

  // Freeze/unfreeze with the game (pause button, rewind hold).
  pause() { if (this.active) this.paused = true; }
  resume() { this.paused = false; }

  // Stop racing but KEEP the movie loaded and armed (race again via reset).
  hold() {
    this.active = false;
    this.armed = !!this.frames;
    this.paused = false;
    this.pos = 0;
    this.done = false;
    this.diverged = false;
    this.nextEcho = null;
    this._divergeAt = null;
  }

  // Full teardown (unloads the movie).
  stop() {
    this.active = false;
    this.pending = false;
    this.armed = false;
    this.paused = false;
    this.frames = null;
    this.anchorState = null;
    this.pos = 0;
    this.done = false;
    this.diverged = false;
    this.nextEcho = null;
    this.lastEcho = null;
    this._divergeAt = null;
  }

  get progress() { return this.frames && this.frames.length ? this.pos / this.frames.length : 0; }
}

if (typeof module !== 'undefined') module.exports = { GhostRacer };
if (typeof window !== 'undefined') window.PocketGhost = { GhostRacer };
