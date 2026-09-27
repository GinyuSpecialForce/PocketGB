'use strict';
// PocketGB — play-time accounting (main process, pure logic + storage).
//
// The main process owns the clock: the renderer says when a game is actually
// running (loaded, unpaused, window focused) and `tick()` accumulates
// wall-clock seconds — per game under the settings key
// `game:<statesKey>:playtime`, and for the live session. Elapsed time for
// Discord presence comes from the session accumulator, so "played 1:23" on
// the profile pauses with the emulator instead of counting paused time.

// Accumulate `seconds` onto the settings store for a game key. Returns the
// new total. Fractional seconds are fine; stored values round to whole
// seconds to keep settings.json readable.
function addTime(settings, key, seconds) {
  const k = `game:${key}:playtime`;
  if (!key || !Number.isFinite(seconds) || seconds <= 0) {
    return Math.round(Number(settings && settings[k]) || 0);
  }
  const next = Math.round((Number(settings[k]) || 0) + seconds);
  settings[k] = next;
  return next;
}

// Read the stored total (whole seconds) for a game key.
function getTime(settings, key) {
  return Math.round(Number(settings && settings[`game:${key}:playtime`]) || 0);
}

// Human formatting: "3h 24m", "12m", "45s" — compact for library cards.
function fmtPlaytime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// Live session accumulator: tracks which game is running and how many
// seconds of actual play it has seen. Swap games → seconds stay with the
// old game (callers commit first), elapsed restarts at zero.
class PlaySession {
  constructor() { this.key = null; this.played = 0; }
  start(key) { this.key = key || null; this.played = 0; }
  stop() { this.key = null; }
  tick(seconds) {
    if (this.key && Number.isFinite(seconds) && seconds > 0) this.played += seconds;
  }
  // Seconds of play to credit to the current game (floor of the fractional
  // accumulator; the remainder keeps accruing so no time is lost).
  take() {
    const whole = Math.floor(this.played);
    this.played -= whole;
    return whole;
  }
  get elapsed() { return Math.floor(this.played); }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { addTime, getTime, fmtPlaytime, PlaySession };
}
