// Downloads Blargg's cpu_instrs individual test ROMs (freely redistributable)
// from the retrio/gb-test-roms repository for headless verification.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://github.com/retrio/gb-test-roms/raw/master/';
// [subdir, filename] — all downloaded into test/blargg/ (flat, like the runner expects)
const ROMS = [
  ['cpu_instrs/individual', '01-special.gb'], ['cpu_instrs/individual', '02-interrupts.gb'],
  ['cpu_instrs/individual', '03-op sp,hl.gb'], ['cpu_instrs/individual', '04-op r,imm.gb'],
  ['cpu_instrs/individual', '05-op rp.gb'], ['cpu_instrs/individual', '06-ld r,r.gb'],
  ['cpu_instrs/individual', '07-jr,jp,call,ret,rst.gb'], ['cpu_instrs/individual', '08-misc instrs.gb'],
  ['cpu_instrs/individual', '09-op r,r.gb'], ['cpu_instrs/individual', '10-bit ops.gb'],
  ['cpu_instrs/individual', '11-op a,(hl).gb'],
  ['instr_timing', 'instr_timing.gb'],
  ['mem_timing', 'mem_timing.gb'],
];

const outDir = path.join(__dirname, 'blargg');
fs.mkdirSync(outDir, { recursive: true });

function fetch(url) { // prettier-ignore
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pocketgb-test-fetch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject); // follow redirects
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  for (const [sub, name] of ROMS) {
    const dest = path.join(outDir, name.replace(/[ ,]/g, '_'));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) { console.log('cached:', name); continue; }
    try {
      const buf = await fetch(BASE + sub + '/' + encodeURIComponent(name));
      fs.writeFileSync(dest, buf);
      console.log('fetched:', name, buf.length, 'bytes');
    } catch (err) {
      console.error('FAILED:', name, err.message);
    }
  }
})();
