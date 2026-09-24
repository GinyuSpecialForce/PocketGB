// PocketGB — mGBA wasm core loader.
// The core is an ES module; loading it here (as an external module script,
// not inline — the app CSP forbids inline script) exposes the factory as a
// classic-script global for the machine adapter in gba-mgba.js. Same-origin
// (app://bundle) so the core's pthread workers start cleanly.
import mGBA from '../../vendor/mgba/mgba.js';
window.mGBA = mGBA;
window.dispatchEvent(new Event('mgba-ready'));
console.info('[pocketgb] mGBA core loaded');
