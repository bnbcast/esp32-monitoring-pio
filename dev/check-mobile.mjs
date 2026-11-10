/*
 * dev/check-mobile.mjs - Playwright gate for the phone layout.
 *
 * The phone is how the dashboard is actually used at the track, and the pieces
 * that matter there cannot be unit tested: a bottom sheet that folds away, a
 * full-screen map, a camera lock that survives a reload, and no page-level
 * scrolling (which is what made a downward swipe reload the page).
 *
 * Usage:
 *   node dev/check-mobile.mjs                                    # local dev server
 *   node dev/check-mobile.mjs https://bnbcast.github.io/esp32-monitoring-pio/ race-tracker
 *
 * Args: [baseUrl] [topicKey] [waitMs]
 * Exit code 0 = pass.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5003/?dev&t=dev-test-1234';
const KEY = process.argv[3] || 'dev-test-1234';
const WAIT = Number(process.argv[4] || 5000);
const url = BASE.includes('?') ? BASE : BASE + '#t=' + KEY;

const browser = await chromium.launch();
const problems = [];

function check(ok, message) {
  if (!ok) problems.push(message);
}

// ---- phone ----------------------------------------------------------------
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true
});
const page = await phone.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(WAIT);

const initial = await page.evaluate(() => {
  const wrap = document.getElementById('tabPanels');
  const handle = document.getElementById('sheetHandle');
  const panel = document.getElementById('sidePanel');
  const btn = document.getElementById('btnFollow');
  return {
    handleShown: !!handle && handle.offsetParent !== null,
    handleHeight: handle ? Math.round(handle.getBoundingClientRect().height) : 0,
    panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
    followPressed: btn ? btn.getAttribute('aria-pressed') : null,
    following: typeof MAP !== 'undefined' ? MAP.isFollowing() : null,
    bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
    htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
    wrapOverscroll: getComputedStyle(wrap).overscrollBehaviorY,
    docScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    mapWidth: Math.round(document.getElementById('map-container').getBoundingClientRect().width),
    mapHeight: Math.round(document.getElementById('map-container').getBoundingClientRect().height),
    buttonsVisible: ['btnFollow', 'btnFull', 'btnMyLocation'].filter(id => {
      const b = document.getElementById(id);
      return b && b.offsetParent !== null;
    }).length
  };
});

check(initial.handleShown, 'the sheet handle is not visible on a phone');
check(initial.handleHeight >= 20, `the sheet handle is too thin to grab (${initial.handleHeight}px)`);
check(initial.panelHeight > 150, `the sheet should start open, height ${initial.panelHeight}px`);
check(initial.followPressed === 'false', `camera lock starts pressed: ${initial.followPressed}`);
check(initial.following === false, 'MAP thinks the camera is locked at start');
check(initial.bodyOverscroll === 'none', `body overscroll-behavior is "${initial.bodyOverscroll}"`);
check(initial.htmlOverscroll === 'none', `html overscroll-behavior is "${initial.htmlOverscroll}"`);
check(initial.wrapOverscroll === 'contain', `panel overscroll-behavior is "${initial.wrapOverscroll}"`);
check(!initial.docScrollable, 'the document itself scrolls: a downward swipe can reload the page');
check(initial.overflowX <= 1, `page overflows horizontally by ${initial.overflowX}px`);
check(initial.buttonsVisible === 3, `only ${initial.buttonsVisible}/3 map buttons are visible`);

// ---- camera lock ---------------------------------------------------------
await page.click('#btnFollow');
await page.waitForTimeout(300);
const locked = await page.evaluate(() => ({
  pressed: document.getElementById('btnFollow').getAttribute('aria-pressed'),
  following: MAP.isFollowing(),
  stored: localStorage.getItem('followLock')
}));
check(locked.pressed === 'true', 'the lock button did not light up');
check(locked.following === true, 'MAP did not enter follow mode');
check(locked.stored === '1', `the lock was not saved (${locked.stored})`);

// A pan must release it, or the camera fights the finger. A phone sends touch
// events, so drive the real input stack instead of faking a mouse drag.
const cdp = await phone.newCDPSession(page);
const box = await page.locator('#map-container').boundingBox();
const from = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
const centerBefore = await page.evaluate(() => MAP.getMap().getCenter().toArray());
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
for (let i = 1; i <= 8; i++) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: from.x - i * 12, y: from.y - i * 7, id: 1 }]
  });
  await page.waitForTimeout(20);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(500);
const released = await page.evaluate((before) => {
  const after = MAP.getMap().getCenter().toArray();
  return {
    pressed: document.getElementById('btnFollow').getAttribute('aria-pressed'),
    following: MAP.isFollowing(),
    stored: localStorage.getItem('followLock'),
    moved: Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]) > 0.0005
  };
}, centerBefore);
check(released.moved, 'the touch drag did not pan the map, so the release test proves nothing');
check(released.pressed === 'false', 'panning did not release the camera lock');
check(released.following === false, 'MAP stayed locked after a pan');
check(released.stored === '0', `release was not saved (${released.stored})`);

// ---- the choice survives a reload ----------------------------------------
await page.click('#btnFollow');
await page.waitForTimeout(200);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(WAIT);
const afterReload = await page.evaluate(() => ({
  pressed: document.getElementById('btnFollow').getAttribute('aria-pressed'),
  following: MAP.isFollowing()
}));
check(afterReload.pressed === 'true', 'the camera lock was lost on reload');
check(afterReload.following === true, 'MAP forgot the camera lock on reload');
await page.click('#btnFollow');   // back to unlocked for the rest of the run
await page.waitForTimeout(200);

// ---- full-screen map -----------------------------------------------------
const beforeFull = await page.evaluate(() => ({
  map: Math.round(document.getElementById('map-container').getBoundingClientRect().height),
  side: getComputedStyle(document.getElementById('sidePanel')).display,
  canvas: (() => {
    const c = document.querySelector('#map-container canvas');
    return c ? c.width : 0;
  })()
}));
await page.click('#btnFull');
await page.waitForTimeout(600);
const duringFull = await page.evaluate(() => {
  const c = document.querySelector('#map-container canvas');
  return {
    classOn: document.body.classList.contains('map-full'),
    map: Math.round(document.getElementById('map-container').getBoundingClientRect().height),
    topBar: getComputedStyle(document.querySelector('.top-bar-area')).display,
    side: getComputedStyle(document.getElementById('sidePanel')).display,
    canvas: c ? c.width : 0,
    pressed: document.getElementById('btnFull').getAttribute('aria-pressed'),
    docScrollable: document.documentElement.scrollHeight > window.innerHeight + 2
  };
});
check(duringFull.classOn, 'full screen did not switch on');
check(duringFull.pressed === 'true', 'the full-screen button did not light up');
check(duringFull.side === 'none', 'the panel is still shown in full screen');
check(duringFull.topBar === 'none', 'the top bar is still shown in full screen');
check(duringFull.map > beforeFull.map + 100, `the map barely grew: ${beforeFull.map} -> ${duringFull.map}px`);
check(duringFull.map >= 780, `the map should fill the phone, it is ${duringFull.map}px of 844`);
check(duringFull.canvas !== beforeFull.canvas, 'the map canvas was not resized for full screen');
check(!duringFull.docScrollable, 'full screen lets the document scroll');

await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const afterFull = await page.evaluate(() => ({
  classOn: document.body.classList.contains('map-full'),
  side: getComputedStyle(document.getElementById('sidePanel')).display,
  map: Math.round(document.getElementById('map-container').getBoundingClientRect().height)
}));
check(!afterFull.classOn, 'Escape did not leave full screen');
check(afterFull.side !== 'none', 'the panel did not come back after full screen');
check(afterFull.map < duringFull.map - 100, 'the map did not give the space back to the panel');

// ---- folding the sheet ---------------------------------------------------
await page.click('#sheetHandle');
await page.waitForTimeout(350);
const collapsed = await page.evaluate(() => ({
  collapsed: document.getElementById('sidePanel').classList.contains('collapsed'),
  height: Math.round(document.getElementById('sidePanel').getBoundingClientRect().height),
  wrap: getComputedStyle(document.getElementById('tabPanels')).display,
  expanded: document.getElementById('sheetHandle').getAttribute('aria-expanded'),
  stored: localStorage.getItem('sheetCollapsed'),
  map: Math.round(document.getElementById('map-container').getBoundingClientRect().height)
}));
check(collapsed.collapsed, 'tapping the handle did not fold the sheet');
check(collapsed.wrap === 'none', 'the panels are still visible when folded');
check(collapsed.height < 100, `folded sheet is ${collapsed.height}px, expected just the tab bar`);
check(collapsed.expanded === 'false', 'the handle did not report itself collapsed');
check(collapsed.stored === '1', 'the folded state was not remembered');
check(collapsed.map > initial.mapHeight + 100, `the map did not grow when folded (${initial.mapHeight} -> ${collapsed.map})`);

await page.click('.tab-btn[data-tab="wifi"]');
await page.waitForTimeout(350);
const unfolded = await page.evaluate(() => ({
  collapsed: document.getElementById('sidePanel').classList.contains('collapsed'),
  active: document.querySelector('.tab-btn.active').dataset.tab,
  panelActive: document.getElementById('tab-wifi').classList.contains('active')
}));
check(!unfolded.collapsed, 'picking a tab did not reopen the sheet');
check(unfolded.active === 'wifi', `the wrong tab is active: ${unfolded.active}`);
check(unfolded.panelActive, 'the WIFI panel is not shown');

// ---- each tab starts at its own top --------------------------------------
const scrolled = await page.evaluate(async () => {
  const live = document.querySelector('.tab-btn[data-tab="live"]');
  live.click();
  await new Promise(r => setTimeout(r, 150));
  const wrap = document.getElementById('tabPanels');
  wrap.scrollTop = wrap.scrollHeight;
  const before = wrap.scrollTop;
  document.querySelector('.tab-btn[data-tab="history"]').click();
  await new Promise(r => setTimeout(r, 200));
  return { before, after: wrap.scrollTop, scrollable: wrap.scrollHeight > wrap.clientHeight };
});
check(scrolled.scrollable, 'the LIVE panel does not scroll, so the scroll test proves nothing');
check(scrolled.before > 10, `could not scroll the panel (scrollTop ${scrolled.before})`);
check(scrolled.after === 0, `switching tabs kept the old scroll position (${scrolled.after}px)`);

if (pageErrors.length) problems.push('page errors: ' + pageErrors.join(' | '));
await phone.close();

// ---- desktop: the same page, no sheet ------------------------------------
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dpage = await desktop.newPage();
const dErrors = [];
dpage.on('pageerror', e => dErrors.push(String((e && e.message) || e)));
await dpage.goto(url, { waitUntil: 'domcontentloaded' });
await dpage.waitForTimeout(WAIT);
const wide = await dpage.evaluate(() => ({
  handle: (() => {
    const h = document.getElementById('sheetHandle');
    return h ? getComputedStyle(h).display : null;
  })(),
  sideVisible: document.getElementById('sidePanel').offsetParent !== null,
  overflowX: document.documentElement.scrollWidth - window.innerWidth,
  follow: document.getElementById('btnFollow').getAttribute('aria-pressed')
}));
check(wide.handle === 'none', 'the sheet handle is showing on desktop');
check(wide.sideVisible, 'the side panel is missing on desktop');
check(wide.overflowX <= 1, `desktop overflows horizontally by ${wide.overflowX}px`);

await dpage.click('#btnFull');
await dpage.waitForTimeout(500);
const dFull = await dpage.evaluate(() => ({
  map: Math.round(document.getElementById('map-container').getBoundingClientRect().width),
  side: getComputedStyle(document.getElementById('sidePanel')).display,
  canvas: (() => { const c = document.querySelector('#map-container canvas'); return c ? c.width : 0; })()
}));
check(dFull.side === 'none', 'desktop full screen still shows the panel');
check(dFull.map > 1200, `desktop full-screen map is ${dFull.map}px wide`);
check(dFull.canvas > 1200, `desktop canvas was not resized (${dFull.canvas}px)`);

if (dErrors.length) problems.push('desktop page errors: ' + dErrors.join(' | '));
await desktop.close();
await browser.close();

console.log(`phone  sheet ${initial.panelHeight}px -> ${collapsed.height}px, ` +
  `map ${initial.mapHeight}px -> ${collapsed.map}px, full screen ${duringFull.map}px, ` +
  `canvas ${initial.mapWidth}px wide, lock saved=${locked.stored}, labels OK`);
if (problems.length) {
  for (const p of problems) console.log('  FAIL ' + p);
} else {
  console.log('  PASS');
}
console.log(problems.length ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(problems.length ? 1 : 0);
