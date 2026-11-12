/*
 * Unit tests for the HIST tab timeline.
 *
 * The grouping and formatting live in web/ui/sessions.js, which is written to
 * run both as a classic browser script and under node, so these are real tests
 * of the code the page runs - not a second copy of the rules.
 *
 * Run with: node --test test/sessions.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const S = require(path.join(root, 'web', 'ui', 'sessions.js'));

const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const HTML = read('web/index.html');
const APP = read('web/ui/app.js');
const MAPJS = read('web/ui/map.js');

const BASE = 1700000000;                       // 2023-11-14T22:13:20Z
const at = (sec, lat, lon, kmh) => [BASE + sec, lat, lon, kmh];

// ---- grouping -------------------------------------------------------------

test('a gap longer than 120 s starts a new session', () => {
  const pts = [
    at(0, 0, 0, 0),
    at(60, 0, 0.001, 10),
    at(180, 0, 0.002, 20),     // 120 s after the previous: same session
    at(301, 0, 0.003, 30)      // 121 s after the previous: new session
  ];
  const s = S.group(pts);
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(s.map(x => x.count), [3, 1]);
  assert.strictEqual(s[0].start, BASE);
  assert.strictEqual(s[0].end, BASE + 180);
  assert.strictEqual(s[1].start, BASE + 301);
});

test('one point is a one-point session, not an error', () => {
  const s = S.group([at(0, 1, 2, 0)]);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].count, 1);
  assert.strictEqual(s[0].seconds, 0);
  assert.strictEqual(s[0].distKm, 0);
});

test('junk rows are dropped instead of breaking the split', () => {
  const pts = [null, [], [1, 2], at(0, 0, 0, 0), ['x', 0, 0, 0],
               at(1, 91, 0, 0), at(2, 0, 181, 0), at(3, 0, 0.001, 0)];
  const s = S.group(pts);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].count, 2);
});

test('empty input, and a non-array, return no sessions', () => {
  assert.deepStrictEqual(S.group([]), []);
  assert.deepStrictEqual(S.group(null), []);
  assert.deepStrictEqual(S.group(undefined), []);
});

test('distance is summed inside a session only', () => {
  const s = S.group([at(0, 0, 0, 0), at(1, 0.001, 0, 0), at(2, 0.002, 0, 0)]);
  assert.strictEqual(s.length, 1);
  // 0.001 deg of latitude is ~111.2 m, twice.
  assert.ok(Math.abs(s[0].distKm - 0.2224) < 0.002,
    `expected ~0.222 km, got ${s[0].distKm}`);
});

test('max and average speed come from the kmh column', () => {
  const s = S.group([at(0, 0, 0, 10), at(1, 0, 0.001, 30), at(2, 0, 0.002, 20)]);
  assert.strictEqual(s[0].maxKmh, 30);
  assert.strictEqual(s[0].avgKmh, 20);
});

test('a missing kmh does not become 0 km/h', () => {
  const s = S.group([at(0, 0, 0, 10), at(1, 0, 0.001, undefined)]);
  assert.strictEqual(s[0].maxKmh, 10);
  assert.strictEqual(s[0].avgKmh, 10, 'avg must ignore the missing sample');
});

test('summarize totals sessions, distance and time', () => {
  const list = [
    { count: 5, distKm: 1.5, seconds: 60, maxKmh: 40 },
    { count: 3, distKm: 0.5, seconds: 30, maxKmh: 55 }
  ];
  assert.deepStrictEqual(S.summarize(list),
    { count: 2, distKm: 2, seconds: 90, maxKmh: 55, points: 8 });
  assert.deepStrictEqual(S.summarize([]),
    { count: 0, distKm: 0, seconds: 0, maxKmh: 0, points: 0 });
});

// ---- formatting -----------------------------------------------------------

test('durations read the way a driver says them', () => {
  assert.strictEqual(S.fmtDuration(0), '0s');
  assert.strictEqual(S.fmtDuration(59), '59s');
  assert.strictEqual(S.fmtDuration(61), '1m 01s');
  assert.strictEqual(S.fmtDuration(3600), '1h 00m');
  assert.strictEqual(S.fmtDuration(3661), '1h 01m');
  assert.strictEqual(S.fmtDuration(-5), '0s');
});

test('clock and day labels are local, like the footer clock', () => {
  const ts = Date.UTC(2026, 10, 12, 14, 32, 0) / 1000;
  const d = new Date(ts * 1000);
  const want = String(d.getHours()).padStart(2, '0') + ':' +
               String(d.getMinutes()).padStart(2, '0');
  assert.strictEqual(S.fmtClock(ts), want);
  assert.match(S.fmtClock(ts), /^\d{2}:\d{2}$/);

  const now = ts + 60;
  assert.strictEqual(S.fmtDay(ts, now), 'Today');
  assert.strictEqual(S.fmtDay(ts - 86400, now), 'Yesterday');

  const old = Date.UTC(2026, 9, 1, 12, 0, 0) / 1000;
  const od = new Date(old * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  assert.strictEqual(S.fmtDay(old, now),
    `${od.getDate()} ${months[od.getMonth()]}`);
});

// ---- page contract --------------------------------------------------------

test('the page loads sessions.js before app.js at the same version', () => {
  const sessions = HTML.indexOf('ui/sessions.js');
  const app = HTML.indexOf('ui/app.js');
  assert.ok(sessions > 0, 'sessions.js is not loaded');
  assert.ok(sessions < app, 'app.js uses SESSIONS, so it must load after it');
  const versions = [...HTML.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
  assert.strictEqual(new Set(versions).size, 1, `mixed asset versions: ${versions.join(', ')}`);
});

test('the HIST panel keeps the ids the history probe reads', () => {
  for (const id of ['histPoints', 'histDist', 'histGap', 'histWindow', 'histStatus']) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /id="histList"/);
  assert.match(HTML, /id="histSummary"/);
});

test('the tab renders the sessions and draws the selected one', () => {
  assert.match(APP, /SESSIONS\.group\(pts\)/);
  assert.match(APP, /SESSIONS\.summarize\(histSessions\)/);
  assert.match(APP, /MAP\.setHistory\(pts\)/);
  assert.match(APP, /MAP\.fitPoints\(pts\)/,
    'selecting a session must frame it, or the line is a dash in the corner');
  // Selecting a session reuses the points already in memory: no refetch, so a
  // tap cannot fail on the network or add a request per row.
  const from = APP.indexOf('function selectSession(');
  const body = APP.slice(from, APP.indexOf('\n  }', from));
  assert.ok(!/fetch\(/.test(body), 'selectSession must not hit the network');
});

test('timeline text is written with textContent, not innerHTML', () => {
  const from = APP.indexOf('function renderTimeline(');
  const body = APP.slice(from, APP.indexOf('\n  }', from));
  assert.ok(body.length > 0);
  assert.ok(!/innerHTML/.test(body), 'stored device data must not be parsed as HTML');
  assert.match(body, /createElement\('button'\)/);
  assert.match(body, /textContent/);
});

test('map.js exposes the framing helper the tab calls', () => {
  assert.match(MAPJS, /function fitPoints\(points, opts\)/);
  assert.match(MAPJS, /\bfitPoints,/);
  assert.match(MAPJS, /map\.fitBounds\(/, 'a multi-point session must fit its bounds');
});

test('the window distance is the session total, not the gaps between them', () => {
  assert.match(APP, /const km = SESSIONS\.summarize\(histSessions\)\.distKm/);
  // Joining the last fix of one stint to the first of the next would count
  // kilometres the vehicle never drove: the probe fixture read 6.13 km for a
  // 1.59 km of driving before this.
  assert.ok(!/kmBetween/.test(APP), 'no cross-gap chord may be added to the total');
});

// ---- laps, quality, lean --------------------------------------------------

test('laps are filtered to the session window', () => {
  const laps = [[BASE + 10, 1, 60000, 60000], [BASE + 70, 2, 59000, 59000],
                [BASE + 500, 3, 61000, 59000]];
  assert.deepStrictEqual(S.lapsIn(laps, BASE, BASE + 100).map(l => l[1]), [1, 2]);
  assert.deepStrictEqual(S.lapsIn(null, 0, 1), []);
  assert.deepStrictEqual(S.lapsIn([[BASE, 1, 0, 0], [BASE, 'x', 5, 5]], BASE, BASE + 1), []);
});

test('lap summary counts laps, best and last, with a delta', () => {
  const list = [[BASE, 1, 61000, 61000], [BASE + 50, 2, 59000, 59000],
                [BASE + 99, 3, 60500, 59000]];
  assert.deepStrictEqual(S.lapSummary(list),
    { count: 3, bestMs: 59000, lastMs: 60500, deltaMs: 1500 });
  assert.deepStrictEqual(S.lapSummary([]),
    { count: 0, bestMs: 0, lastMs: 0, deltaMs: 0 });
  assert.strictEqual(S.fmtLap(61234), '61.23');
  assert.strictEqual(S.fmtLap(0), '--');
});

test('delta is signed, and empty on the best lap', () => {
  assert.strictEqual(S.fmtDelta(1500), '+1.50');
  assert.strictEqual(S.fmtDelta(-500), '-0.50');
  assert.strictEqual(S.fmtDelta(0), '');
  assert.strictEqual(S.fmtDelta(NaN), '');
});

test('quality uses hdop at index 5 and ignores missing values', () => {
  const pts = [
    [BASE, 0, 0, 10, 0, 0.8],
    [BASE + 1, 0, 0, 10, 0, 2.2],
    [BASE + 2, 0, 0, 10, 0, 5.0],
    [BASE + 3, 0, 0, 10, 0, null],
    [BASE + 4, 0, 0, 10]
  ];
  const q = S.quality(pts);
  assert.strictEqual(q.n, 3, 'only finite positive hdop counts');
  assert.ok(Math.abs(q.avg - 8 / 3) < 1e-9);
  assert.strictEqual(q.bad, 1);
  assert.ok(Math.abs(q.badPct - 100 / 3) < 1e-9);
  assert.deepStrictEqual(S.quality(null), { n: 0, bad: 0, avg: 0, badPct: 0 });
});

test('max lean reads roll and pitch at 6 and 7', () => {
  const pts = [[BASE, 0, 0, 0, 0, 0.9, -4.5, 1.0],
               [BASE, 0, 0, 0, 0, 0.9, 2.0, -12.25]];
  assert.strictEqual(S.maxLean(pts), 12.25);
  assert.strictEqual(S.maxLean([[BASE, 0, 0, 0, 0, 1]]), null,
    'no attitude columns means unknown, not flat');
  assert.strictEqual(S.maxLean([[BASE, 0, 0, 0, 0, 1, null, '']]), null);
  assert.strictEqual(S.maxLean(null), null);
});

// ---- export ---------------------------------------------------------------

test('GPX is 1.1, escapes the name and keeps every usable point', () => {
  const gpx = S.toGpx([
    [BASE, -6.9, 107.6, 30, 90, 0.8, 1, 2],
    [BASE + 1, -6.9001, 107.6001, 31, 91, 0.9, 3, 4],
    ['x', 0, 0]
  ], 'a & b <c>');
  assert.match(gpx, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /a &amp; b &lt;c&gt;/);
  assert.match(gpx, /<trkpt lat="-6\.900000" lon="107\.600000">/);
  assert.strictEqual((gpx.match(/<trkpt /g) || []).length, 2);
  assert.ok(!/<speed>/.test(gpx), 'speed is not a GPX 1.1 trkpt element');
});

test('CSV has a header, one row per point and blank for missing fields', () => {
  const csv = S.toCsv([
    [BASE, -6.9, 107.6, 30, 90, 0.8, 1.5, null],
    [BASE + 1, -6.9001, 107.6001, 31]
  ]);
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines[0], 'ts,iso,lat,lon,kmh,cog,hdop,roll,pitch');
  assert.strictEqual(lines.length, 3);
  assert.match(lines[1], /^1700000000,\d{4}-\d{2}-\d{2}T/);
  assert.match(lines[1], /,-6\.900000,107\.600000,30,90,0\.8,1\.5,$/);
  assert.match(lines[2], /,31,,,,$/, 'missing samples are empty, not 0');
});

test('laps, quality, lean and export controls exist in the panel', () => {
  for (const id of ['histLaps', 'histQuality', 'histLean',
                    'btnExportGpx', 'btnExportCsv']) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
});

test('the map draws a poor-fix overlay and clears it too', () => {
  assert.match(MAPJS, /addSource\("historyPoor"/);
  assert.match(MAPJS, /id: "history-poor"/);
  const clear = MAPJS.slice(MAPJS.indexOf('function clearHistory('));
  assert.match(clear.slice(0, 500), /getSource\("historyPoor"\)/);
});
