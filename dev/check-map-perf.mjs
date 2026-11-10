/*
 * dev/check-map-perf.mjs - measure how heavy the dashboard's map is.
 *
 * The owner reported that the live map makes the phone lag. "It feels heavy"
 * is not a number, so this probe opens the page at a phone viewport, lets the
 * simulator drive for a while and records:
 *
 *   - frame intervals (p50 / p95 / worst) from requestAnimationFrame
 *   - long tasks (>50 ms) that block taps and scrolling
 *   - JS heap growth
 *   - basemap layers drawn, and that every text label survived
 *   - canvas pixels (the drawing buffer), which is what fill rate scales with
 *   - how often each GeoJSON source is re-uploaded (setData)
 *
 * Note on the numbers: headless Chromium here renders through SwiftShader, a
 * software rasteriser, so absolute frame times are far worse than a real phone.
 * Use them to compare runs (before/after a change), not as a phone benchmark.
 *
 * Usage:
 *   node dev/check-map-perf.mjs                                   # local dev server
 *   node dev/check-map-perf.mjs https://bnbcast.github.io/esp32-monitoring-pio/ race-tracker
 *   node dev/check-map-perf.mjs <url> <key> <warmupMs> <sampleMs> <cpuThrottle> --strict
 *
 * Exit code 0 = no regression and labels intact, 1 = a hard problem.
 * `--strict` also fails when frame time, long tasks or heap exceed the budgets.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const [
  BASE = 'http://localhost:5003/?dev&t=dev-test-1234',
  KEY = 'dev-test-1234',
  WARMUP = '8000',
  SAMPLE = '8000',
  THROTTLE = '4'
] = args.filter(a => !a.startsWith('--'));
const url = BASE.includes('?') ? BASE : BASE + '#t=' + KEY;

const BUDGET = { p95FrameMs: 70, longTaskMs: 900, heapGrowthMB: 8 };

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true
});
const page = await context.newPage();

const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(THROTTLE) });

const requests = { tiles: 0, glyphs: 0, sprites: 0, other: 0 };
const errors = [];
page.on('pageerror', e => errors.push(String((e && e.message) || e)));
page.on('request', r => {
  const u = r.url();
  if (/\/\d+\/\d+\/\d+\.(pbf|png|jpg|webp)(\?|$)/.test(u)) requests.tiles++;
  else if (/\.pbf(\?|$)/.test(u)) requests.glyphs++;
  else if (/sprite/.test(u)) requests.sprites++;
  else requests.other++;
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(Number(WARMUP));

// Instrument the sources the app redraws. Each setData() re-uploads a whole
// GeoJSON payload to the map worker, so this is the number that shows whether a
// small update is being paid for again and again.
await page.evaluate(() => {
  window.__mapPerf = { setData: {}, frames: [], long: [], heap: [] };
  const map = typeof MAP !== 'undefined' && MAP.getMap ? MAP.getMap() : null;
  if (map) {
    for (const id of ['trail', 'history', 'accuracy', 'measure', 'heading-wedge']) {
      const src = map.getSource(id);
      if (!src || typeof src.setData !== 'function' || src.__wrapped) continue;
      const orig = src.setData.bind(src);
      src.__wrapped = true;
      src.setData = d => {
        window.__mapPerf.setData[id] = (window.__mapPerf.setData[id] || 0) + 1;
        return orig(d);
      };
    }
  }
  const obs = new PerformanceObserver(list => {
    for (const e of list.getEntries()) window.__mapPerf.long.push(Math.round(e.duration));
  });
  try { obs.observe({ entryTypes: ['longtask'] }); } catch (e) { /* unsupported */ }

  const tick = t => {
    window.__mapPerf.frames.push(t);
    if (performance.memory) window.__mapPerf.heap.push(performance.memory.usedJSHeapSize);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const start = await page.evaluate(() => {
  const canvas = document.querySelector('#map-container canvas');
  const map = MAP.getMap();
  const style = map && map.getStyle ? map.getStyle() : null;
  const layers = (style && Array.isArray(style.layers)) ? style.layers : [];
  const visible = layers.filter(l => !(l.layout && l.layout.visibility === 'none'));
  return {
    canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    dpr: window.devicePixelRatio,
    pixelRatio: map && map.getPixelRatio ? map.getPixelRatio() : null,
    layers: {
      total: layers.length,
      visible: visible.length,
      hidden: layers.length - visible.length,
      hiddenIds: layers
        .filter(l => l.layout && l.layout.visibility === 'none')
        .map(l => l.id),
      visibleSymbols: visible.filter(l => l.type === 'symbol').length,
      symbols: layers.filter(l => l.type === 'symbol').length,
      extruded: visible.filter(l => l.type === 'fill-extrusion').length
    },
    tilesLoaded: map && map.loaded ? map.loaded() : null,
    trailPoints: MAP.getTrailPoints ? MAP.getTrailPoints() : 0
  };
});

await page.evaluate(() => {
  window.__mapPerf.frames.length = 0;
  window.__mapPerf.long.length = 0;
  window.__mapPerf.heap.length = 0;
});
const t0 = Date.now();
await page.waitForTimeout(Number(SAMPLE));
const elapsed = (Date.now() - t0) / 1000;

const data = await page.evaluate(() => {
  const p = window.__mapPerf;
  const gaps = [];
  for (let i = 1; i < p.frames.length; i++) gaps.push(p.frames[i] - p.frames[i - 1]);
  gaps.sort((a, b) => a - b);
  const at = q => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))]) : null);
  const heap = p.heap.map(n => n / 1048576);
  const map = MAP.getMap();
  return {
    frames: p.frames.length,
    p50: at(0.5),
    p95: at(0.95),
    worst: gaps.length ? Math.round(gaps[gaps.length - 1]) : null,
    longTasks: p.long.length,
    longTaskMs: p.long.reduce((a, b) => a + b, 0),
    heapStartMB: heap.length ? +heap[0].toFixed(1) : null,
    heapEndMB: heap.length ? +heap[heap.length - 1].toFixed(1) : null,
    setData: p.setData,
    trailPoints: MAP.getTrailPoints ? MAP.getTrailPoints() : 0,
    zoom: map ? +map.getZoom().toFixed(2) : null,
    styleLoaded: map ? !!map.getStyle() : false
  };
});

const fps = +(data.frames / elapsed).toFixed(1);
const heapGrowth = data.heapStartMB == null ? 0 : +(data.heapEndMB - data.heapStartMB).toFixed(1);

const result = {
  throttle: `${THROTTLE}x`,
  url: url.replace(/#t=.*/, '#t=<key>'),
  elapsed: +elapsed.toFixed(1),
  canvas: start.canvas,
  dpr: start.dpr,
  pixelRatio: start.pixelRatio,
  layers: start.layers,
  mapLoaded: start.tilesLoaded,
  trailPoints: data.trailPoints,
  fps,
  frameP50ms: data.p50,
  frameP95ms: data.p95,
  frameWorstMs: data.worst,
  longTasks: data.longTasks,
  longTaskMs: data.longTaskMs,
  heapStartMB: data.heapStartMB,
  heapEndMB: data.heapEndMB,
  heapGrowthMB: heapGrowth,
  setDataPerSec: Object.fromEntries(Object.entries(data.setData).map(([k, v]) => [k, +(v / elapsed).toFixed(2)])),
  requests,
  pageErrors: errors
};

console.log(JSON.stringify(result, null, 2));

const problems = [];
if (errors.length) problems.push('page errors: ' + errors.join(' | '));
if (!start.canvas) problems.push('map canvas missing');
if (!data.styleLoaded) problems.push('map style never loaded');
// The phone optimisation may only drop decoration. Losing the text layers would
// make the map unreadable, so that is a hard failure, not a slowdown.
const labels = start.layers.symbols;
if (labels > 0 && start.layers.visibleSymbols === 0) problems.push('every text label was hidden');
if (start.layers.hiddenIds.includes('highway-name-major')) problems.push('street names were hidden');
if (start.layers.hiddenIds.includes('label_city')) problems.push('place names were hidden');
if (STRICT) {
  if (data.p95 != null && data.p95 > BUDGET.p95FrameMs) problems.push(`p95 frame ${data.p95} ms > ${BUDGET.p95FrameMs} ms`);
  if (data.longTaskMs > BUDGET.longTaskMs) problems.push(`long tasks ${data.longTaskMs} ms > ${BUDGET.longTaskMs} ms`);
  if (heapGrowth > BUDGET.heapGrowthMB) problems.push(`heap grew ${heapGrowth} MB > ${BUDGET.heapGrowthMB} MB`);
}

await browser.close();
for (const p of problems) console.log('  FAIL ' + p);
console.log(`labels: ${start.layers.visibleSymbols}/${labels} symbol layers visible, ` +
  `${start.layers.hidden} decorative layers hidden`);
console.log(problems.length ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(problems.length ? 1 : 0);
