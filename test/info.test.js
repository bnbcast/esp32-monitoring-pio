/*
 * Unit tests for the INFO tab (web/index.html + web/ui/info-data.js).
 * Run with: node --test test/info.test.js
 *
 * The INFO tab is the only place a reader can find out what a number means, so
 * it must not silently fall behind the panels. These tests read the data file
 * and the page with plain regexes (no DOM, no browser) and fail when a value is
 * displayed that the glossary never explains.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const DATA = fs.readFileSync(path.join(root, 'web', 'ui', 'info-data.js'), 'utf8');

// info-data.js is plain JSON on one assignment, so it can be read without a
// browser or an eval.
const marker = 'window.INFO_GROUPS = ';
const at = DATA.indexOf(marker);
const GROUPS = at < 0 ? null : JSON.parse(DATA.slice(at + marker.length, DATA.lastIndexOf(']') + 1));

const TERMS = GROUPS ? GROUPS.flatMap(g => (g.terms || []).map(t => ({ group: g.id, ...t }))) : [];

const ENTITIES = {
  '&amp;': '&', '&mdash;': '-', '&ndash;': '-', '&rarr;': '->',
  '&plusmn;': '+/-', '&minus;': '-', '&divide;': '/', '&deg;': ' deg '
};

// "Odometer<button …>↻</button>" is still the field "Odometer", and "A→B" is
// the same field as "A&rarr;B". Normalise both sides before comparing.
function norm(s) {
  let t = String(s);
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
  return t
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/[^\w\s&/().+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function all(block, re) {
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

// A field is a .lbl immediately followed by its value cell, or the map HUD's
// .hud-label followed by .hud-value. Requiring the adjacent value cell keeps
// unit captions ("km/h", "deg") out: those labels end the cell instead. The
// negative lookahead keeps a match inside one cell, so an empty unit label
// cannot swallow the rest of the page.
const FIELD_RES = [
  /<div class="lbl">((?:(?!<div).)*?)<\/div><div class="val[\s"]/g,
  /<div class="hud-label">([\s\S]*?)<\/div>\s*<div class="hud-value"/g
];

function fields() {
  const out = [];
  for (const re of FIELD_RES) {
    re.lastIndex = 0;
    for (const raw of all(HTML, re)) {
      const t = norm(raw);
      if (t) out.push(t);
    }
  }
  return Array.from(new Set(out));
}

test('the INFO tab exists, is reachable, and loads its data and renderer', () => {
  assert.ok(GROUPS && Array.isArray(GROUPS), 'window.INFO_GROUPS is missing or not an array');
  assert.ok(HTML.includes('id="tab-info"'), 'tab-panel id="tab-info" is missing');
  assert.match(HTML, /<button class="tab-btn" data-tab="info">INFO<\/button>/);
  // The tab switcher derives the panel id from data-tab, so those must agree.
  assert.ok(HTML.includes('id="infoList"'), 'the renderer has no mount point');
  assert.ok(HTML.includes('id="infoSearch"'), 'the glossary has no search box');
  assert.match(HTML, /<script src="ui\/info-data\.js\?v=\d+"><\/script>/);
  assert.match(HTML, /<script src="ui\/info\.js\?v=\d+"><\/script>/);
});

test('every group is usable and every term has an explanation', () => {
  assert.ok(GROUPS.length >= 8, `expected the full glossary, found ${GROUPS.length} groups`);
  assert.ok(TERMS.length >= 60, `expected ~70 terms, found ${TERMS.length}`);
  for (const g of GROUPS) {
    assert.ok(g.id && g.title && g.short, `group ${g.id || '?'} is missing id/title/short`);
    assert.ok(Array.isArray(g.terms) && g.terms.length > 0, `group ${g.id} has no terms`);
    for (const t of g.terms) {
      assert.ok(t.t && t.t.trim(), `group ${g.id} has an empty term`);
      assert.ok(t.d && norm(t.d).length > 12, `term "${t.t}" has a too-short explanation`);
    }
  }
});

test('group ids and terms are unique', () => {
  const seenGroups = new Set();
  for (const g of GROUPS) {
    const key = norm(g.id);
    assert.ok(!seenGroups.has(key), `duplicate group id: ${g.id}`);
    seenGroups.add(key);
  }
  const seen = new Set();
  for (const t of TERMS) {
    const key = norm(t.t);
    assert.ok(!seen.has(key), `duplicate term: ${t.t}`);
    seen.add(key);
  }
});

test('no displayed field is missing from the glossary', () => {
  const glossary = TERMS.map(t => norm(t.t)).join(' | ');
  const missing = fields().filter(f => !glossary.includes(f));
  assert.deepEqual(missing, [], 'these on-screen fields have no INFO entry');
});

test('a field label resolves to the right term (same rules as ui/info.js)', () => {
  // Mirrors pick() in ui/info.js: exact match first, then substring, with the
  // panel's group preferred. If this drifts, tapping a label opens nothing.
  function best(list, t) {
    return list.find(e => e.lc === t) ||
      list.find(e => e.lc.indexOf(t) === 0) ||
      list.slice().sort((a, b) => a.lc.length - b.lc.length).find(e => e.lc.includes(t)) ||
      null;
  }
  function pick(label, group) {
    const t = norm(label).toLowerCase();
    // Stay inside the panel first: "Tilt" in LIVE is the tilt readout while
    // "Tilt" in MPU is the combined value, and "Status" exists in three tabs.
    return best(group ? TERMS.filter(e => e.group === group) : TERMS, t) || best(TERMS, t);
  }
  for (const e of TERMS) e.lc = norm(e.t).toLowerCase();
  const cases = [
    ['HDOP', 'live', 'HDOP'],
    ['Odometer', 'live', 'Odometer'],
    ['Tilt', 'live', 'Tilt'],
    ['Tilt', 'mpu', 'Tilt (MPU)'],
    ['Status', 'wifi', 'Status (WIFI)'],
    ['Status', 'history', 'Status (HIST)'],
    ['Uptime', 'wifi', 'Uptime (WIFI)'],
    ['Accel X', 'mpu', 'Accel X / Accel Y / Accel Z'],
    ['SPEED', 'map', 'SPEED (map)'],
    ['Max gap', 'history', 'Max gap'],
    ['TTFF', 'live', 'TTFF'],
    ['Fix Mode', 'live', 'Fix Mode'],
    ['Gate', 'live', 'Gate']
  ];
  for (const [label, group, expected] of cases) {
    const hit = pick(label, group);
    assert.ok(hit, `"${label}" in ${group} resolved to nothing`);
    assert.strictEqual(hit.t, expected, `"${label}" in ${group} resolved to "${hit.t}"`);
  }
});
