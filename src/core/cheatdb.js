// PocketGB — cheat database lookup (gamehacking.org)
//
// Pulls cheat codes for the running game from gamehacking.org, the largest
// public repository of single-player cheat codes. There is no documented
// JSON API; the site is server-rendered HTML behind Cloudflare, so the
// client (running in the Electron MAIN process, where CORS/COEP don't apply)
// fetches the same pages the browser does and parses the tables:
//   • game search:  GET /?sys=<gba|gb|gbc>&q=<query>   → list of { gamId, version, crc, codes }
//   • codes:        GET /game/<gamId> (+ POST /modules/game.php per group)
//
// GH's CRC32 is the checksum of the WHOLE ROM file (verified against real
// hashes, e.g. Sonic Advance (USA) = 63F70FD8), so a local ROM can be matched
// to the site's exact version row without guessing regions.
//
// Everything here is pure DOM-free logic: the fetch is injected, the HTML
// parsers are string-in/string-out, and the import helpers just call an
// engine's .add() — so the whole module unit-tests in Node. Wrapped in an
// IIFE because the renderer loads it as a classic script into one shared
// scope with every other core file (a second top-level `const HEX` etc.
// would throw at load and kill everything after it).
'use strict';

(function () {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const GH_HOST = 'https://gamehacking.org';
  // GH systems: 'gb' = Game Boy, 'gbc' = Game Boy Color, 'gba' = Game Boy Advance.
  // If a GB-family search comes back empty we retry the sibling system — some
  // games are categorized differently than the ROM header implies.
  const SYS_SIBLING = { gb: 'gbc', gbc: 'gb' };

  // ---- CRC32 (IEEE 802.3, same polynomial as the UPS/BPS trailer code) ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  // Full-file CRC32 as GH prints it: uppercase 8-digit hex.
  function crc32Hex(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  // ---- tiny HTML text helpers (no DOM) ----
  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => safeFromCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => safeFromCode(parseInt(d, 10)))
      .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&amp;/g, '&'); // &amp; LAST (no double-decode)
  }
  function safeFromCode(n) {
    try { return String.fromCodePoint(n); } catch { return ''; }
  }
  function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  // Is this plausibly a cheat code line (hex/colon/dash soup, ≥4 hex digits)?
  function looksLikeCodeLine(s) {
    const t = String(s || '').trim();
    if (!t || t.length > 64) return false;
    if (!/^[0-9A-Fa-f:\- ]+$/.test(t)) return false;
    return (t.match(/[0-9A-Fa-f]/g) || []).length >= 4;
  }

  // ---- search-results parsing (GET /?sys=...&q=...) ----
  // Rows look like: <th colspan="5">Sonic Advance</th> (game name header),
  // then per version: <a href="/game/6000">(USA) (En,Ja)</a> | serial | size |
  // CRC32 | code count. Returns [{ gamId, game, version, crc, codes }].
  function parseGameSearch(html) {
    const games = [];
    let current = '';
    for (const row of String(html || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
      const th = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(row);
      if (th) {
        const t = stripTags(th[1]);
        if (t) current = t;
      }
      const a = /<a[^>]+href="\/game\/(\d+)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      if (!a) continue;
      // CRC cell: an 8-hex token that is not part of the /game/ link id.
      let crc = null;
      for (const m of row.matchAll(/\b([0-9A-F]{8})\b/g)) {
        if (!a[0].includes(m[1]) || Number.parseInt(a[1], 10) === Number.parseInt(m[1], 16)) { crc = m[1]; break; }
      }
      const nums = stripTags(row.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, ' ')).match(/\d+/g);
      games.push({
        gamId: Number.parseInt(a[1], 10),
        game: current,
        version: stripTags(a[2]),
        crc,
        codes: nums && nums.length ? Number.parseInt(nums[nums.length - 1], 10) : 0,
      });
    }
    return games;
  }

  // Pick the game row for a ROM: exact CRC32 match wins outright; otherwise
  // shortlist games that actually have codes (keeps the region guess honest —
  // the UI shows the shortlist when it's ambiguous).
  function findBestGame(games, crcHex) {
    const list = Array.isArray(games) ? games : [];
    if (crcHex) {
      const want = String(crcHex).toUpperCase();
      const exact = list.find((g) => g.crc && g.crc.toUpperCase() === want);
      if (exact) return { exact, shortlist: [exact] };
    }
    return { exact: null, shortlist: list.filter((g) => (g.codes | 0) > 0) };
  }

  // ---- code-row parsing (GET /game/<id>, POST /modules/game.php) ----
  // Each code line is a <tr> with: <label> TITLE <input…></label>,
  // <small>by <a href="/hackers/NAME">…</a></small>, a device cell
  // (col-sm-3) and the code itself in a <pre>. Multi-line cheats are one row
  // per line; continuation rows have an empty title.
  function parseGameRows(html) {
    const rows = [];
    for (const row of String(html || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
      const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(row);
      if (!pre) continue;
      const code = stripTags(pre[1]);
      if (!looksLikeCodeLine(code)) continue;
      const label = /<label[^>]*>([\s\S]*?)<\/label>/i.exec(row);
      const title = label ? stripTags(label[1].replace(/<input[^>]*>/gi, ' ')) : '';
      const hackers = [...new Set([...row.matchAll(/\/hackers\/([A-Za-z0-9_.\-]+)/g)].map((m) => m[1]))];
      const dev = /class="col-sm-3"[^>]*>\s*<small>([\s\S]*?)<\/small>/i.exec(row);
      rows.push({ title, hackers, device: dev ? stripTags(dev[1]) : '', code });
    }
    // Exact duplicates (page renders a group, then we re-fetch it per-group).
    const seen = new Set();
    return rows.filter((r) => {
      const k = `${r.title}|${r.code}|${r.device}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Fold flat rows into cheats: same-title rows merge; blank-title rows are
  // continuation lines of the previous cheat.
  function groupRows(rows) {
    const groups = [];
    for (const r of rows || []) {
      const last = groups[groups.length - 1];
      if (!r.title && last) {
        last.lines.push(r.code);
        continue;
      }
      if (last && last.title === r.title && last.device === r.device) {
        last.lines.push(r.code);
        continue;
      }
      groups.push({ title: r.title || 'cheat', hackers: r.hackers, device: r.device, lines: [r.code] });
    }
    return groups;
  }

  // Group ids from the page's fillGroup(...) buttons — groups the server
  // didn't inline (their content loads via POST /modules/game.php).
  function groupIdsOnPage(html, gamId) {
    const ids = new Set();
    for (const m of String(html || '').matchAll(/fillGroup\(\{\s*gamID:\s*(\d+),\s*grpID:\s*(\d+)/g)) {
      if (Number.parseInt(m[1], 10) === Number.parseInt(gamId, 10)) ids.add(Number.parseInt(m[2], 10));
    }
    return [...ids];
  }

  // ---- client (fetch is injectable for tests) ----
  class CheatDbClient {
    constructor({ host = GH_HOST, fetchImpl, timeoutMs = 20000 } = {}) {
      this.host = String(host).replace(/\/$/, '');
      this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
      this.timeoutMs = timeoutMs;
      if (!this._fetch) throw new Error('fetch unavailable in this runtime');
    }

    async _get(pathName) {
      const res = await this._fetch(this.host + pathName, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      return this._body(res);
    }

    async _post(pathName, params) {
      const body = new URLSearchParams(params).toString();
      const res = await this._fetch(this.host + pathName, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      return this._body(res);
    }

    async _body(res) {
      const text = await res.text();
      if (res.status === 403 || res.status === 503 || text.includes('Attention Required')) {
        throw new Error('gamehacking.org blocked the request (Cloudflare) — try again in a moment');
      }
      if (res.status === 404) throw new Error('not found on gamehacking.org');
      if (!res.ok) throw new Error(`gamehacking.org HTTP ${res.status}`);
      return text;
    }

    async searchGames(sys, query) {
      const html = await this._get(`/?sys=${encodeURIComponent(sys)}&q=${encodeURIComponent(String(query || '').slice(0, 100))}`);
      return parseGameSearch(html);
    }

    // Retry the sibling Game Boy system when the primary search is empty.
    async searchGamesWithFallback(sys, query) {
      const games = await this.searchGames(sys, query);
      const sib = SYS_SIBLING[sys];
      if (!games.length && sib) return this.searchGames(sib, query);
      return games;
    }

    // All cheat groups for one game: parse the server-rendered page, then
    // pull any groups it only exposes via fillGroup buttons (best-effort,
    // capped so a pathological page can't turn into fifty requests).
    async fetchGroups(gamId) {
      const id = Number.parseInt(gamId, 10);
      if (!id) throw new Error('bad game id');
      const html = await this._get(`/game/${id}`);
      const rows = parseGameRows(html);
      const seen = new Set(rows.map((r) => `${r.title}|${r.code}|${r.device}`));
      for (const grpId of groupIdsOnPage(html, id).slice(0, 12)) {
        try {
          const more = parseGameRows(await this._post('/modules/game.php', {
            gamID: id,
            grpID: grpId,
            'filter[name]': '',
            'filter[format]': 'original',
            'filter[enc]': '',
            'filter[hacker]': '',
          }));
          for (const r of more) {
            const k = `${r.title}|${r.code}|${r.device}`;
            if (!seen.has(k)) { seen.add(k); rows.push(r); }
          }
        } catch { /* a failed group must not sink the whole lookup */ }
      }
      return groupRows(rows);
    }

    static sourceUrl(gamId) { return `${GH_HOST}/game/${Number.parseInt(gamId, 10) || ''}`; }
  }

  // ---- import helpers (shared by paste-multiple and the db UI) ----
  // One text blob → clean single-code lines (newlines/semicolons split;
  // blanks and stray padding dropped).
  function splitCheatLines(text) {
    return String(text || '').split(/[\r\n;]+/).map((l) => l.trim()).filter(Boolean);
  }

  // Feed lines to a cheat engine (GB CheatEngine or GbaCheatList — both just
  // expose .add). Returns counts plus the first engine error for the UI.
  function importCheatLines(engine, lines) {
    let added = 0, skipped = 0, firstError = null;
    for (const line of lines || []) {
      const r = engine.add(line);
      if (r && r.error) { skipped++; if (!firstError) firstError = r.error; }
      else added++;
    }
    return { added, skipped, firstError };
  }

  const exports_ = {
    crc32Hex, parseGameSearch, findBestGame, parseGameRows, groupRows,
    groupIdsOnPage, CheatDbClient, splitCheatLines, importCheatLines,
    looksLikeCodeLine, decodeEntities, stripTags,
  };
  if (typeof module !== 'undefined') module.exports = exports_;
  if (typeof window !== 'undefined') window.PocketCheatDb = exports_;
})();
