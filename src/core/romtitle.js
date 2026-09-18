// PocketGB — ROM title extraction (header 0x134-0x143).
//
// One shared implementation for every place a game's name is shown: the
// library cards, the File → Open Recent menu, the window title, the in-game
// header, and the cartridge detector. Headers in the wild pad titles with
// 0x00, 0xFF, spaces, or any junk; some pre-DMG games store Latin-1 text.
'use strict';

// Extract the display title from ROM bytes. Rules:
//   - stop at the first NUL (titles are NUL-terminated in well-formed dumps)
//   - printable ASCII and Latin-1 letters/punctuation pass through
//   - anything else (0xFF padding, control bytes) becomes a space
//   - collapse runs of spaces and trim
// Returns '' when the header has no usable title.
function extractRomTitle(bytes) {
  if (!bytes || bytes.length < 0x135) return '';
  let s = '';
  for (let i = 0x134; i < 0x143; i++) { // 0x143 is the CGB flag — never part of the title
    const b = bytes[i];
    if (b === 0) break;
    s += ((b >= 32 && b < 127) || (b >= 0xA0 && b < 0xFF))
      ? String.fromCharCode(b)
      : ' '; // 0xFF filler and control bytes → readable gap (0xFF excluded from Latin-1: it's the classic padding byte)
  }
  return s.replace(/\s+/g, ' ').trim();
}

// True when a stored title carries mojibake/control junk from an older
// extractor (or is empty) and should be repaired from the ROM file.
function titleLooksBroken(t) {
  if (typeof t !== 'string' || !t.trim()) return true;
  // control chars or the U+FFFD replacement char
  return /[\u0000-\u001F\u007F-\u009F\uFFFD]/.test(t);
}

// Fallback name from a file path, tolerating both separators.
function basenameOf(p) {
  return String(p).split(/[\\/]/).pop() || String(p);
}

if (typeof module !== 'undefined') module.exports = { extractRomTitle, titleLooksBroken, basenameOf };
if (typeof window !== 'undefined') window.PocketTitle = { extractRomTitle, titleLooksBroken, basenameOf };
