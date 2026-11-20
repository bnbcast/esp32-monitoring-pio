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

test('the gate row says when the line is automatic', () => {
  assert.match(APP, /lap\.auto \? 'AUTO armed' : 'armed'/,
    'the HUD cannot tell an automatic line from a manual one');
  assert.match(APP, /auto: arms on motion/,
    'the waiting state does not say the line will arm itself');
  const INFO = fs.readFileSync(path.join(root, 'web/ui/info-data.js'), 'utf8');
  assert.match(INFO, /AUTO armed/, 'the glossary does not explain the automatic gate');
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

test('the ESP32 chip temperature is on LIVE, WIFI and the link chart', () => {
  for (const id of ['sTemp', 'wifiTemp', 'wifiChart']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `#${id} is missing`);
  }
  assert.match(HTML, /chip temp \(green\)/, 'the chart legend does not name the temp line');
  assert.match(APP, /sys\.temp_c/, 'the payload field is never read');
  assert.match(APP, /WIFI_HIST\.temp/, 'the chart has no temperature history');
  assert.match(APP, /set\('sTemp'/, 'LIVE never prints the temperature');
  assert.match(APP, /set\('wifiTemp'/, 'WIFI never prints the temperature');
});

test('a missed MPU frame is recovering, not a wiring fault', () => {
  assert.match(APP, /const MPU_RECOVER_MS = 4000/,
    'the page has no grace window for an I2C glitch');
  assert.match(APP, /MPU RECOVERING/, 'the status strip never shows the soft state');
  // A sensor that never answered still gets the hard message.
  assert.match(APP, /check MPU6050 wiring/);
});

test('the auto-armed finish line is not drawn on the map', () => {
  // It persists in NVS once armed and the dashboard had no way to remove it,
  // so a red dashed line sat across the map forever. Lap timing still works:
  // only the overlay is gone.
  assert.ok(!MAPJS.includes('id: "gate-line"'), 'the red finish line is back');
  assert.ok(!MAPJS.includes('id: "gate-pts"'), 'the finish line endpoints are back');
});

test('the trail source enables lineMetrics, or the trail layer is dropped', () => {
  // MapLibre validates line-gradient against the source: a GeoJSON source
  // without lineMetrics makes addLayer reject the whole trail layer. The map
  // then shows a moving marker and no line, with no visible failure. This was
  // the bug after the single-LineString performance change.
  assert.match(MAPJS, /"line-gradient"/, 'the trail layer no longer uses a gradient');
  const at = MAPJS.indexOf('map.addSource("trail"');
  assert.ok(at >= 0, 'the trail source is missing');
  const source = MAPJS.slice(at, at + 300);
  assert.match(source, /lineMetrics:\s*true/,
    'the trail source must set lineMetrics: true for its line-gradient');
});

// ---- position filter -------------------------------------------------------
// map.js is an IIFE that only touches the DOM inside create(), so the pure
// filter can be loaded in a sandbox and measured without a browser.
function loadMapApi() {
  const vm = require('node:vm');
  const sandbox = {
    console,
    location: { hostname: 'example.org', href: 'https://example.org/', baseURI: 'https://example.org/' },
    document: {
      baseURI: 'https://example.org/',
      createElement: () => ({ style: {}, classList: { toggle() {} } })
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    navigator: { userAgent: '' },
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MAPJS + '\n;globalThis.__MAP = MAP;', sandbox);
  return sandbox.__MAP;
}

const DEG = Math.PI / 180;
const EARTH = 6371000;
const offset = (lat, lng, east, north) => [
  lat + north / EARTH / DEG,
  lng + east / (EARTH * Math.cos(lat * DEG)) / DEG
];
function metres(a, b) {
  const dLat = (b[0] - a[0]) * DEG, dLng = (b[1] - a[1]) * DEG;
  const q = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

test('the position filter kills GPS jitter without trailing a real move', () => {
  const MAP = loadMapApi();
  // Deterministic noise so the test never flakes.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const lat0 = -6.909, lng0 = 107.503;
  const heading = 0.7, dx = Math.sin(heading), dy = Math.cos(heading);

  const track = (speedMs, kmh, noiseM, n) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const [tlat, tlng] = offset(lat0, lng0, dx * speedMs * i, dy * speedMs * i);
      const [rlat, rlng] = offset(tlat, tlng, gauss() * noiseM, gauss() * noiseM);
      pts.push([1000 + i, rlat, rlng, kmh(i), 0, 2.8]);
    }
    const out = MAP.smoothPath(pts);
    let rawErr = 0, outErr = 0, rawJit = 0, outJit = 0, lag = 0, n2 = 0;
    for (let i = 0; i < n; i++) {
      const [tlat, tlng] = offset(lat0, lng0, dx * speedMs * i, dy * speedMs * i);
      rawErr += metres([pts[i][1], pts[i][2]], [tlat, tlng]);
      outErr += metres([out[i][1], out[i][0]], [tlat, tlng]);
      if (i) {
        rawJit += metres([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]) ** 2;
        outJit += metres([out[i - 1][1], out[i - 1][0]], [out[i][1], out[i][0]]) ** 2;
      }
      if (i > 5) {
        const east = (out[i][0] - tlng) * Math.cos(tlat * DEG) * EARTH * DEG;
        const north = (out[i][1] - tlat) * EARTH * DEG;
        lag += -(east * dx + north * dy);   // positive: estimate trails the truth
        n2++;
      }
    }
    return {
      rawErr: rawErr / n, outErr: outErr / n,
      rawJit: Math.sqrt(rawJit / (n - 1)),
      outJit: Math.sqrt(outJit / (n - 1)),
      lag: lag / n2
    };
  };

  const parked = track(0, () => 1 + rnd() * 3, 5, 70);
  assert.ok(parked.outJit < parked.rawJit * 0.5,
    `parked jitter is ${parked.outJit.toFixed(1)} vs raw ${parked.rawJit.toFixed(1)}`);
  assert.ok(parked.outErr < parked.rawErr * 0.6,
    `parked error is ${parked.outErr.toFixed(1)} vs raw ${parked.rawErr.toFixed(1)}`);

  const walk = track(1.4, () => 4 + rnd() * 2, 5, 70);
  assert.ok(walk.outJit < walk.rawJit * 0.5,
    `walking still zigzags: ${walk.outJit.toFixed(1)} vs raw ${walk.rawJit.toFixed(1)}`);
  assert.ok(walk.lag > -2 && walk.lag < 7,
    `walking marker trails by ${walk.lag.toFixed(1)} m`);
});

test('the marker and stored history use the filtered position', () => {
  const body = fnBody(MAPJS, 'viewPos');
  assert.doesNotMatch(body, /anchor/,
    'the marker still snaps to the old trail anchor');
  assert.match(body, /smooth/);
  assert.match(fnBody(MAPJS, 'setHistory'), /smoothStep\(/,
    'HIST is drawn from raw fixes and will zigzag');
  assert.match(APP, /MAP\.smoothPath/,
    'replay coordinates are not filtered');
});
