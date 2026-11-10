/*
 * Unit tests for the INFO tab (web/index.html).
 * Run with: node --test test/info.test.js
 *
 * The INFO tab is the only place a reader can find out what a number means, so
 * it must not silently fall behind the panels. These tests parse the page with
 * plain regexes (no DOM, no browser) and fail when a value is displayed that
 * the glossary never explains.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

// The INFO panel runs from its tab-panel div to the end of the side panel.
const infoStart = HTML.indexOf('<div class="tab-panel" id="tab-info">');
const infoEnd = HTML.indexOf('<!-- /desktop-layout -->');
const INFO = infoStart >= 0 && infoEnd > infoStart ? HTML.slice(infoStart, infoEnd) : '';

function all(block, re) {
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

const dt = all(INFO, /<dt>([\s\S]*?)<\/dt>/g).map(s => s.replace(/\s+/g, ' ').trim());
const dd = all(INFO, /<dd>([\s\S]*?)<\/dd>/g).map(s => s.replace(/\s+/g, ' ').trim());

// A field is a .lbl immediately followed by its value cell, or the map HUD's
// .hud-label followed by .hud-value. Requiring the adjacent value cell keeps
// unit captions ("km/h", "deg") out: those labels end the cell instead.
// The negative lookahead keeps a match inside one cell: unit captions are empty
// .lbl divs, and without it the scan would run from an empty label all the way
// to the next value cell and report the whole page as one field.
const FIELD_RES = [
  /<div class="lbl">((?:(?!<div).)*?)<\/div><div class="val[\s"]/g,
  /<div class="hud-label">([\s\S]*?)<\/div>\s*<div class="hud-value"/g
];

const ENTITIES = {
  '&amp;': '&', '&mdash;': '-', '&ndash;': '-', '&rarr;': '->',
  '&plusmn;': '+/-', '&minus;': '-', '&divide;': '/', '&deg;': ' deg '
};

// "Odometer<button …>↻</button>" is still the field "Odometer", and "A→B" is
// the same field as "A&rarr;B". Normalise both sides before comparing.
function norm(s) {
  let t = s;
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
  return t
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/[^\w\s&/().+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

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

test('the INFO tab exists and is reachable from the tab bar', () => {
  assert.ok(infoStart > 0, 'tab-panel id="tab-info" is missing');
  assert.match(HTML, /<button class="tab-btn" data-tab="info">INFO<\/button>/);
  // The tab switcher derives the panel id from data-tab, so those must agree.
  assert.ok(HTML.includes('id="tab-info"'));
});

test('every term has an explanation', () => {
  assert.ok(dt.length >= 40, `expected a full glossary, found ${dt.length} terms`);
  assert.equal(dd.length, dt.length, 'every <dt> needs exactly one <dd>');
  for (let i = 0; i < dt.length; i++) {
    assert.ok(dt[i].length > 0, `empty term at ${i}`);
    assert.ok(dd[i].length > 20, `term "${dt[i]}" has a too-short explanation`);
  }
});

test('the glossary terms are unique', () => {
  const seen = new Set();
  for (const t of dt) {
    const key = norm(t);
    assert.ok(!seen.has(key), `duplicate term: ${t}`);
    seen.add(key);
  }
});

test('no displayed field is missing from the glossary', () => {
  const glossary = dt.map(norm).join(' | ');
  const missing = fields().filter(f => !glossary.includes(f));
  assert.deepEqual(missing, [], 'these on-screen fields have no INFO entry');
});
