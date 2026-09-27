'use strict';
// Tests for the gamehacking.org cheat database module: CRC32 formatting
// (anchored on the IEEE test vector), the HTML parsers (fed with fixtures
// modeled on the real pages), the import helpers, and the client's fallback
// logic with an injected fake fetch.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  crc32Hex, parseGameSearch, findBestGame, parseGameRows, groupRows,
  groupIdsOnPage, CheatDbClient, splitCheatLines, importCheatLines,
} = require('../src/core/cheatdb');
const { CheatEngine, GbaCheatList } = require('../src/core/cheats');

// crc32Hex must print GH-style uppercase 8-hex — anchored on the IEEE 802.3
// test vector ("123456789" → CBF43926), same anchor patch.js uses.
test('crc32Hex matches the IEEE test vector and pads to 8 digits', () => {
  const v = new TextEncoder().encode('123456789');
  assert.strictEqual(crc32Hex(v), 'CBF43926');
  assert.strictEqual(crc32Hex(new TextEncoder().encode('a')), 'E8B7BE43');
});

test('parseGameSearch reads game headers, versions, crc and code counts', () => {
  const html = `<table><tbody>
    <tr><th colspan="5">Sonic Advance</th></tr>
    <tr>
      <td><a href="/game/6000">(USA) (En,Ja)</a></td>
      <td>AGB-ASOE-USA</td><td>8M</td><td>63F70FD8</td><td>709</td>
    </tr>
    <tr><th colspan="5">Sonic Advance 2</th></tr>
    <tr>
      <td><a href="/game/5999">(Japan) (En,Ja)</a></td>
      <td>AGB-A2NJ-JPN</td><td>16M</td><td>5F512223</td><td>100</td>
    </tr>
  </tbody></table>`;
  const games = parseGameSearch(html);
  assert.strictEqual(games.length, 2);
  assert.deepStrictEqual(games[0], { gamId: 6000, game: 'Sonic Advance', version: '(USA) (En,Ja)', crc: '63F70FD8', codes: 709 });
  assert.strictEqual(games[1].crc, '5F512223');
  assert.strictEqual(games[1].codes, 100);
});

test('parseGameSearch tolerates a missing crc and non-numeric counts', () => {
  const html = `<tr><th>Hack Game</th></tr>
    <tr><td><a href="/game/68983">Sonic Epoch Advance</a></td><td></td><td>0K</td><td></td><td></td></tr>`;
  const games = parseGameSearch(html);
  assert.strictEqual(games.length, 1);
  assert.strictEqual(games[0].crc, null);
  assert.strictEqual(games[0].codes, 0);
  assert.strictEqual(games[0].game, 'Hack Game');
});

test('findBestGame: exact CRC wins, otherwise only games with codes shortlist', () => {
  const games = [
    { gamId: 1, crc: 'AAAAAAAA', codes: 0 },
    { gamId: 2, crc: '63F70FD8', codes: 709 },
    { gamId: 3, crc: 'BBBBBBBB', codes: 12 },
  ];
  const hit = findBestGame(games, '63f70fd8'); // case-insensitive on purpose
  assert.strictEqual(hit.exact.gamId, 2);
  const noHit = findBestGame(games, 'DEADBEEF');
  assert.strictEqual(noHit.exact, null);
  assert.deepStrictEqual(noHit.shortlist.map((g) => g.gamId), [2, 3]);
});

// Fixture modeled on the real /game/6000 rows: label+checkbox title, hacker
// links, device cell, code in <pre>.
const ROWS_HTML = `<table><tbody>
  <tr><td>
    <div class="row">
      <div class="codID col-sm-5 col-md-6">
        <label for="code1"><input id="code1" type="checkbox" value="1" name="codID[]"/> 300 Rings</label>
        <small>by <a href="/hackers/Sappharad">Sappharad</a>, <a href="/hackers/Helder">Helder</a></small>
      </div>
      <div class="col-sm-3"><small>Codebreaker/GameShark SP/Xploder</small></div>
      <div class="col-sm-4 col-md-3"><pre>330030C3 0003</pre></div>
    </div>
  </td></tr>
  <tr><td>
    <div class="row">
      <div class="codID col-sm-5 col-md-6">
        <label for="code2"><input id="code2" type="checkbox" value="2" name="codID[]"/> All Rings Collected</label>
      </div>
      <div class="col-sm-3"><small>Codebreaker/GameShark SP/Xploder</small></div>
      <div class="col-sm-4 col-md-3"><pre>330030C3 0003</pre></div>
    </div>
  </td></tr>
  <tr><td>
    <div class="row">
      <div class="codID col-sm-5 col-md-6">
        <label for="code3"><input id="code3" type="checkbox" value="3" name="codID[]"/> Infinite Health</label>
      </div>
      <div class="col-sm-3"><small>GameShark/Pro Action Replay</small></div>
      <div class="col-sm-4 col-md-3"><pre>44FD097D E584E669</pre></div>
    </div>
  </td></tr>
</tbody></table>`;

test('parseGameRows reads titles, hackers, device and code; skips non-code rows', () => {
  const rows = parseGameRows(ROWS_HTML);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].title, '300 Rings');
  assert.deepStrictEqual(rows[0].hackers, ['Sappharad', 'Helder']);
  assert.strictEqual(rows[0].device, 'Codebreaker/GameShark SP/Xploder');
  assert.strictEqual(rows[0].code, '330030C3 0003');
  assert.strictEqual(rows[2].code, '44FD097D E584E669');
});

test('parseGameRows drops exact duplicate rows (page + per-group re-fetch)', () => {
  const dup = ROWS_HTML + ROWS_HTML;
  const rows = parseGameRows(dup);
  assert.strictEqual(rows.length, 3);
});

test('groupRows merges same-title rows and folds blank-title continuation lines', () => {
  const rows = parseGameRows(ROWS_HTML);
  rows.push({ title: '', hackers: [], device: 'Codebreaker/GameShark SP/Xploder', code: '830030C4 03E7' });
  const groups = groupRows(rows);
  // A blank-title row continues the cheat directly above it (here the last
  // group, "Infinite Health"); same-title rows never merge.
  assert.strictEqual(groups.length, 3);
  assert.strictEqual(groups[0].title, '300 Rings');
  assert.deepStrictEqual(groups[0].lines, ['330030C3 0003']);
  assert.deepStrictEqual(groups[2].lines, ['44FD097D E584E669', '830030C4 03E7']);
});

test('groupIdsOnPage extracts this game only, from fillGroup calls', () => {
  const html = `fillGroup({ gamID: 6000, grpID: 142578, filter: { name: '', format: 'original' } });
    fillGroup({ gamID: 6000, grpID: 98765 });
    fillGroup({ gamID: 5999, grpID: 11111 });`;
  assert.deepStrictEqual(groupIdsOnPage(html, 6000).sort((a, b) => a - b), [98765, 142578]);
});

test('splitCheatLines splits on newlines and semicolons, drops blanks', () => {
  assert.deepStrictEqual(
    splitCheatLines('010238CD;\n 068-5FF-E66 \n\n44FD097D E584E669'),
    ['010238CD', '068-5FF-E66', '44FD097D E584E669'],
  );
});

test('importCheatLines feeds a GB engine and reports per-line results', () => {
  const eng = new CheatEngine();
  const r = importCheatLines(eng, ['010238CD', 'nope-not-a-code']);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 1);
  assert.ok(r.firstError);
  assert.strictEqual(eng.all().length, 1);
});

test('importCheatLines feeds a GBA engine: AR, CodeBreaker and VBA lines', () => {
  const eng = new GbaCheatList();
  const r = importCheatLines(eng, [
    '44FD097D E584E669',  // AR/GS shape
    '330030C3 0003',      // CodeBreaker shape
    '02001F30:63',        // VBA shape
    'zzzz',
  ]);
  assert.strictEqual(r.added, 3);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(eng.all().length, 3);
});

// ---- client logic with injected fetch ------------------------------------
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = `${opts.method || 'GET'} ${url}`;
    const res = responses[key] || responses[url] || { status: 200, body: '' };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => res.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('client: search returns parsed games; empty search retries the sibling system', async () => {
  const rowsHtml = '<tr><th>Sonic Advance</th></tr><tr><td><a href="/game/6000">(USA) (En,Ja)</a></td><td>8M</td><td>63F70FD8</td><td>709</td></tr>';
  const f = fakeFetch({
    'GET https://gh.test/?sys=gb&q=Sonic%20Advance': { status: 200, body: '<html></html>' }, // empty page
    'GET https://gh.test/?sys=gbc&q=Sonic%20Advance': { status: 200, body: rowsHtml },
  });
  const c = new CheatDbClient({ host: 'https://gh.test', fetchImpl: f });
  const games = await c.searchGamesWithFallback('gbc', 'Sonic Advance'); // direct hit on the first try
  assert.strictEqual(games.length, 1);
  const games2 = await c.searchGamesWithFallback('gb', 'Sonic Advance'); // empty → retry gbc
  assert.strictEqual(games2.length, 1);
  assert.strictEqual(games2[0].gamId, 6000);
  // calls[0] = gbc direct hit, calls[1] = gb empty, calls[2] = gbc retry
  assert.strictEqual(f.calls[2].url, 'https://gh.test/?sys=gbc&q=Sonic%20Advance');
});

test('client: fetchGroups merges page rows with fillGroup groups, deduped', async () => {
  const page = ROWS_HTML + `<button onclick="fillGroup({ gamID: 6000, grpID: 142578, filter: { name: '', format: 'original', enc: '', hacker: '' } })"></button>`;
  const f = fakeFetch({
    'GET https://gh.test/game/6000': { status: 200, body: page },
    'POST https://gh.test/modules/game.php': { status: 200, body: '<table><tr><td><pre>830030C4 03E7</pre></td></tr></table>' },
  });
  const c = new CheatDbClient({ host: 'https://gh.test', fetchImpl: f });
  const groups = await c.fetchGroups(6000);
  assert.ok(groups.length >= 3);
  assert.ok(groups.some((g) => g.lines.includes('830030C4 03E7')));
  // The POST must carry the form the site's own JS sends.
  const body = new URLSearchParams(f.calls[1].opts.body);
  assert.strictEqual(body.get('gamID'), '6000');
  assert.strictEqual(body.get('grpID'), '142578');
  assert.strictEqual(body.get('filter[format]'), 'original');
});

test('client: fetchGroups survives a failing group request', async () => {
  const page = `<button onclick="fillGroup({ gamID: 6000, grpID: 1 })"></button>`;
  const f = fakeFetch({
    'GET https://gh.test/game/6000': { status: 200, body: page },
    'POST https://gh.test/modules/game.php': { status: 500, body: 'boom' },
  });
  const c = new CheatDbClient({ host: 'https://gh.test', fetchImpl: f });
  const groups = await c.fetchGroups(6000);
  assert.deepStrictEqual(groups, []); // no rows on page, group failed → empty, not a throw
});

test('client: Cloudflare interstitial becomes a friendly error', async () => {
  const f = fakeFetch({ 'GET https://gh.test/?sys=gba&q=x': { status: 403, body: '<html>Attention Required!</html>' } });
  const c = new CheatDbClient({ host: 'https://gh.test', fetchImpl: f });
  await assert.rejects(() => c.searchGames('gba', 'x'), /Cloudflare/);
});

test('client: sourceUrl', () => {
  assert.strictEqual(CheatDbClient.sourceUrl(6000), 'https://gamehacking.org/game/6000');
});
