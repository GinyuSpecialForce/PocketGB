'use strict';
// PocketGB — local multiplayer hub.
//
// Local play over the link cable needs two emulators. The hub launches a
// second PocketGB instance with `--pgb-*` flags; the new instance parses its
// own argv (parseHubArgs) to auto-load the same ROM and auto-raise its end of
// the link cable. Each instance keeps its own window, IPC and NetLink, so
// nothing else in the app changes.
//
//   --pgb-second          marks this launch as the player-2 window
//   --pgb-rom=<path>      auto-load this ROM on boot
//   --pgb-host=<port>     auto-host the link cable on this port
//   --pgb-join=<port>     auto-join a host on loopback at this port

// Parse process.argv-style flag list → { second, rom, role, port }.
function parseHubArgs(argv) {
  const out = { second: false, rom: null, role: null, port: 0 };
  for (const arg of argv || []) {
    if (!arg || typeof arg !== 'string') continue;
    if (arg === '--pgb-second') out.second = true;
    else if (arg.startsWith('--pgb-rom=')) out.rom = arg.slice('--pgb-rom='.length) || null;
    else if (arg.startsWith('--pgb-host=')) { out.role = 'host'; out.port = parseInt(arg.slice('--pgb-host='.length), 10) || 0; }
    else if (arg.startsWith('--pgb-join=')) { out.role = 'join'; out.port = parseInt(arg.slice('--pgb-join='.length), 10) || 0; }
  }
  return out;
}

// Build the argv for the spawned second instance. baseArgs is
// process.argv.slice(1) (keeps the app path / packaged entry); any previous
// --pgb- flags are stripped so launches never chain roles. Passes the ROM
// through when the first window has one, plus the requested link role.
function buildSpawnArgs({ baseArgs, rom = null, role = null, port = 0 }) {
  const args = (baseArgs || []).filter((a) => !(typeof a === 'string' && a.startsWith('--pgb-')));
  args.push('--pgb-second');
  if (rom) args.push(`--pgb-rom=${rom}`);
  if (role === 'host') args.push(`--pgb-host=${port || 0}`);
  else if (role === 'join') args.push(`--pgb-join=${port || 0}`);
  return args;
}

// Which end of the cable the spawned window should raise, given the role the
// parent took. 'host' → the child joins the parent at the port the parent
// bound. Anything else → no auto-link in the child (its user can raise the
// cable manually). Passing the parent's own role through used to make the
// child host the SAME port → EADDRINUSE, and neither side ever connected.
function childRole(role) {
  if (role === 'host') return 'join';
  if (role === 'join') return 'host';
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseHubArgs, buildSpawnArgs, childRole };
}
