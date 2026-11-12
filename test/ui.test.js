/*
 * Static checks for the phone UI and the map's rendering rules.
 * Run with: node --test test/ui.test.js
 *
 * These are the invariants that a browser probe can only catch by accident:
 * a button that is no longer wired, a sheet rule that hides the panels on
 * desktop, a scroll container that lets a swipe reload the page, or the
 * accuracy circle being uploaded twice per fix again. They parse the real
 * files, so there is no second copy of the truth to drift.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const HTML = read('web/index.html');
const APP = read('web/ui/app.js');
const MAPJS = read('web/ui/map.js');
const LAYOUT = read('web/css/layout.css');

// The body of a function, by matching braces from its opening line.
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} is missing`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('the map offers a camera lock and a full-screen button', () => {
  const buttons = HTML.slice(HTML.indexOf('class="map-btns"'), HTML.indexOf('id="sidePanel"'));
  assert.match(buttons, /id="btnFollow"[\s\S]*aria-pressed="false"/, 'the camera-lock button is missing');
  assert.match(buttons, /id="btnFull"[\s\S]*aria-pressed="false"/, 'the full-screen button is missing');
  // Both have to be reachable to the API and drawn as a state.
  for (const api of ['setFollow', 'isFollowing', 'onFollow']) {
    assert.match(MAPJS, new RegExp(`\\b${api}\\b`), `MAP.${api} is not exported`);
  }
  assert.match(APP, /MAP\.setFollow\(/, 'the dashboard never asks the map to lock');
  assert.match(APP, /classList\.toggle\('active', !!on\)/, 'the lock button has no pressed look');
});

test('a trackpad can turn the map, and any press releases the camera lock', () => {
  // No extra map buttons: a trackpad already sends its horizontal scroll, so
  // that gesture turns the map. The vertical part still zooms, and pinch
  // (ctrl+wheel) is left to MapLibre.
  assert.match(MAPJS, /function enableTrackpadRotate\(\)/);
  assert.match(MAPJS, /if \(ev\.ctrlKey\) return/);
  assert.match(MAPJS, /Math\.abs\(dx\) <= Math\.abs\(dy\)/);
  assert.match(MAPJS, /map\.setBearing\(map\.getBearing\(\) \+ dx/);
  assert.ok(!/btnRotate|btnPitch/.test(HTML), 'no camera buttons may be added to the map');

  // "the lock camera is unreleased when I click anything": a press on the map,
  // a rotate and a pitch all have to drop the lock, not only a pan.
  assert.match(MAPJS, /addEventListener\("pointerdown", userCameraMove/);
  assert.match(MAPJS, /map\.on\("dragstart", userCameraMove\)/);
  assert.match(MAPJS, /map\.on\("rotatestart", userCameraMove\)/);
  assert.match(MAPJS, /map\.on\("pitchstart", userCameraMove\)/);
  assert.match(MAPJS, /function userCameraMove\(\)[\s\S]{0,200}releaseFollow\(\)/);
});

test('the bottom sheet folds to the tab bar on a phone, and only there', () => {
  assert.match(HTML, /id="sheetHandle"[\s\S]{0,200}aria-controls="tabPanels"/, 'the handle is not wired to the panels');
  assert.match(HTML, /class="tab-panels-wrapper" id="tabPanels"/, 'the panels have no id for the handle');

  const desktopRule = LAYOUT.slice(0, LAYOUT.indexOf('@media (max-width: 900px)'));
  assert.match(desktopRule, /\.sheet-handle\s*{\s*display:\s*none;/, 'the handle must be hidden on desktop');

  const phoneRules = LAYOUT.slice(LAYOUT.indexOf('@media (max-width: 900px)'));
  assert.match(phoneRules, /\.sheet-handle\s*{[\s\S]{0,300}display:\s*flex;/, 'the handle is not shown on a phone');
  assert.match(phoneRules, /\.side-panel\.collapsed\s*\.tab-panels-wrapper\s*{\s*display:\s*none;/, 'folding does not hide the panels');
  assert.match(phoneRules, /\.side-panel\.collapsed\s*{[^}]*height:\s*auto;/, 'a folded sheet keeps its full height');
});

test('a downward swipe cannot reload the page or drag it', () => {
  const shell = LAYOUT.slice(0, LAYOUT.indexOf('.app-shell'));
  assert.match(shell, /overscroll-behavior:\s*none;/, 'html/body do not suppress pull-to-refresh');
  const wrapper = LAYOUT.slice(LAYOUT.indexOf('.tab-panels-wrapper'), LAYOUT.indexOf('.tab-panel {'));
  assert.match(wrapper, /overscroll-behavior:\s*contain;/, 'the panel scroller chains its scroll to the page');
  // And the document must not be scrollable on a phone in the first place.
  const phoneRules = LAYOUT.slice(LAYOUT.indexOf('@media (max-width: 900px)'));
  assert.match(phoneRules, /html,\s*body\s*{[^}]*overflow:\s*hidden;/, 'the phone document can still scroll');
});

test('the accuracy circle is uploaded once per fix, not twice', () => {
  const body = fnBody(MAPJS, 'updateAccuracy');
  assert.strictEqual(count(body, '.setData('), 1,
    'updateAccuracy uploads the circle more than once per fix');
  // The upload is skipped when nothing moved: that is the other half of the cost.
  assert.match(body, /if \(key === accKey\) return;/, 'the circle is re-uploaded even when unchanged');
  const wedge = fnBody(MAPJS, 'updateHeadingWedge');
  assert.match(wedge, /if \(key === wedgeKey\) return;/, 'the heading wedge is re-uploaded even when unchanged');
});

test('the phone basemap drops decoration but never text labels', () => {
  assert.match(MAPJS, /layer\.type !== "symbol"/, 'the basemap rule must exempt symbol layers');
  const m = MAPJS.match(/const HEAVY_LAYER = (\/.*\/i);/);
  assert.ok(m, 'HEAVY_LAYER regex not found');
  const re = eval(m[1]);   // a literal from our own source, not user input

  // Only aeroway (airport aprons, runways, taxiways) are treated as decoration.
  // Building footprints are kept for orientation context.
  for (const id of ['aeroway_fill', 'aeroway_runway']) {
    assert.ok(re.test(id), `${id} should be treated as decoration`);
  }
  for (const id of ['building', 'building-3d', 'highway-name-major', 'highway-name-minor', 'label_city', 'label_village',
    'poi_r1', 'airport', 'water_name_point_label', 'road_shield_us', 'water', 'park']) {
    assert.ok(!re.test(id), `${id} must never be hidden`);
  }
});

test('the vehicle marker is hidden until the first fix', () => {
  // With no GPS lock the map used to leave the marker at DEFAULT_CENTER, which
  // is a real town: the live site looked like the car was parked there.
  const body = fnBody(MAPJS, 'updateMarker');
  assert.match(body, /markerInner\.style\.display = "none"/, 'the marker is drawn before any fix');
  const create = fnBody(MAPJS, 'createMarker');
  assert.match(create, /style\.display = 'none'/, 'the marker starts visible at the default centre');
});

test('resize ignores sub-pixel wobble and the dashboard debounces it', () => {
  const body = fnBody(MAPJS, 'resize');
  assert.match(body, /lastSize/, 'resize does not remember the last size');
  assert.match(body, /<\s*2/, 'resize does not ignore a tiny change');
  assert.match(APP, /clearTimeout\(resizeTimer\)/, 'the dashboard does not debounce resize');
  assert.match(APP, /visualViewport/, 'a keyboard or URL-bar resize is not observed');
});

test('the camera lock and the folded sheet survive a reload', () => {
  for (const [key, src] of [['followLock', APP], ['sheetCollapsed', APP]]) {
    assert.match(src, new RegExp(`getItem\\('${key}'\\)`), `${key} is never read back`);
    assert.match(src, new RegExp(`setItem\\('${key}'`), `${key} is never saved`);
  }
});

test('every asset is requested at one version', () => {
  const versions = [...HTML.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
  assert.ok(versions.length > 5, 'no asset versions found');
  const unique = [...new Set(versions)];
  assert.strictEqual(unique.length, 1, `mixed asset versions: ${unique.join(', ')}`);
});

test('the page, icons and manifest carry the Orion brand', () => {
  assert.match(HTML, /<title>Orion Project<\/title>/);
  assert.match(HTML, /class="brand-mascot"[^>]*src="assets\/orion\.png\?v=\d+"/,
    'the header mascot is missing');
  assert.match(HTML, /<span>Orion<br><span id="brandState">LIVE<\/span><\/span>/, 'the wordmark is missing');
  assert.match(HTML, /<link rel="manifest" href="manifest\.webmanifest\?v=\d+">/);
  assert.match(HTML, /icons\/orion-64\.png\?v=\d+/, 'no 64 px favicon');
  assert.match(HTML, /icons\/orion-180\.png\?v=\d+/, 'no apple-touch icon');
  assert.match(HTML, /<span>ORION<\/span>/, 'the footer still uses the old name');
  assert.doesNotMatch(HTML, /ESP32 \/\/ LIVE/);

  const manifest = JSON.parse(read('web/manifest.webmanifest'));
  assert.strictEqual(manifest.name, 'Orion Project');
  assert.strictEqual(manifest.short_name, 'Orion');
  assert.ok(manifest.icons.length >= 2, 'the manifest has no home-screen icons');

  for (const p of ['web/assets/orion.png',
                   ...[32, 48, 64, 180, 192, 512].map(n => `web/icons/orion-${n}.png`)]) {
    const file = path.join(root, p);
    assert.ok(fs.existsSync(file), `missing ${p}`);
    assert.ok(fs.statSync(file).size > 500, `${p} looks empty`);
  }
});
