// PocketGB — minimal GBA cartridge header check.
// The Nintendo logo at 0x04 is the strongest format discriminator for .gba
// content; this lives apart from any emulator core so both the GB machine
// wrapper and the app shell can use it.
'use strict';

function gbaHeaderValid(rom) {
  if (!rom || rom.length < 0xC0) return false;
  const logo = [0x24,0xff,0xae,0x51,0x69,0x9a,0xa2,0x21,0x3d,0x84,0x82,0x0a,0x84,0xe4,0x09,0xad];
  for (let i = 0; i < logo.length; i++) if (rom[4 + i] !== logo[i]) return false;
  return true;
}

if (typeof module !== 'undefined') module.exports = { gbaHeaderValid };
if (typeof window !== 'undefined') window.gbaHeaderValid = gbaHeaderValid;
