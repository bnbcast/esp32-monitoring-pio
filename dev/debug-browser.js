/*
 * dev/debug-browser.js — Standalone Playwright debug script.
 *
 * Opens the dev server URL, captures console logs/WebSocket events,
 * takes a screenshot, and reports whether GPS data is flowing.
 *
 * Usage:
 *   cd dev
 *   node debug-browser.js
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const logs = [];
  const errors = [];

  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logs.push(text);
    if (msg.type() === 'error') errors.push(text);
    console.log(text);
  });

  page.on('pageerror', (err) => {
    errors.push(err.message);
    console.log('PAGE ERROR:', err.message);
  });

  page.on('crash', () => {
    console.log('PAGE CRASHED');
  });

  await page.goto('http://localhost:5003/?dev&t=dev-test-1234#t=dev-test-1234', {
    waitUntil: 'load',
    timeout: 30000,
  });

  console.log('\nPage loaded, title:', await page.title());

  // Check key elements exist immediately (new brutalist DOM)
  const checks = [
    ['#setup', 'setup screen (should be hidden)'],
    ['#sim-badge', 'sim badge'],
    ['#statusStrip', 'status strip'],
    ['#statusText', 'status text'],
    ['#pLink', 'broker pill'],
    ['#pDev', 'device pill'],
    ['#pMpu', 'mpu pill'],
    ['#pGps', 'gps pill'],
    ['#map-container', 'map container'],
    ['#hudSpeed', 'HUD speed'],
    ['#hudHeading', 'HUD heading'],
    ['#hudSource', 'HUD source'],
    ['#hudDanger', 'HUD danger'],
    ['#liveSpeed', 'live speed'],
    ['#liveAlt', 'live alt'],
    ['#liveSats', 'live sats'],
    ['#liveHdop', 'live hdop'],
    ['#liveFix', 'live fix'],
    ['#btnMyLocation', 'my location btn'],
    ['#btnCompass', 'compass btn'],
    ['#ledB', 'LED blue'],
    ['#ledW', 'LED white'],
    ['#ledR', 'LED red'],
  ];

  console.log(`\n=== ELEMENT CHECKS ===`);
  let allFound = true;
  for (const [sel, name] of checks) {
    const count = await page.locator(sel).count();
    const found = count > 0;
    if (!found && name !== 'setup screen (should be hidden)') allFound = false;
    console.log(`${found ? 'OK ' : 'MISS'} ${name} (${sel})`);
  }

  // Setup screen must be hidden when key is present
  const setupVisible = await page.locator('#setup').isVisible().catch(() => false);
  console.log(`${setupVisible ? 'FAIL' : 'OK '} setup screen hidden (should not be visible)`);
  if (setupVisible) allFound = false;

  // Only LIVE tab panel should be visible on desktop
  const liveVisible = await page.locator('#tab-live').isVisible().catch(() => false);
  const routeHidden = !(await page.locator('#tab-route').isVisible().catch(() => false));
  const tripsHidden = !(await page.locator('#tab-trips').isVisible().catch(() => false));
  const placesHidden = !(await page.locator('#tab-places').isVisible().catch(() => false));
  const settingsHidden = !(await page.locator('#tab-settings').isVisible().catch(() => false));
  console.log(`${liveVisible ? 'OK ' : 'FAIL'} LIVE tab visible`);
  console.log(`${routeHidden ? 'OK ' : 'FAIL'} ROUTE tab hidden`);
  console.log(`${tripsHidden ? 'OK ' : 'FAIL'} TRIPS tab hidden`);
  console.log(`${placesHidden ? 'OK ' : 'FAIL'} PLACES tab hidden`);
  console.log(`${settingsHidden ? 'OK ' : 'FAIL'} SETTINGS tab hidden`);
  if (!liveVisible || !routeHidden || !tripsHidden || !placesHidden || !settingsHidden) allFound = false;

  // Mobile sheet must be hidden on desktop
  const mobileSheetHidden = !(await page.locator('.mobile-sheet').isVisible().catch(() => false));
  console.log(`${mobileSheetHidden ? 'OK ' : 'FAIL'} mobile sheet hidden on desktop`);
  if (!mobileSheetHidden) allFound = false;

  // 3D view elements should NOT exist
  const view3dHidden = !(await page.locator('#view3d').isVisible().catch(() => false));
  console.log(`${view3dHidden ? 'OK ' : 'FAIL'} 3D view container removed`);
  if (!view3dHidden) allFound = false;

  const viewBadgeHidden = !(await page.locator('#viewBadge').isVisible().catch(() => false));
  console.log(`${viewBadgeHidden ? 'OK ' : 'FAIL'} view badge removed`);
  if (!viewBadgeHidden) allFound = false;

  const btnViewHidden = !(await page.locator('#btnView').isVisible().catch(() => false));
  console.log(`${btnViewHidden ? 'OK ' : 'FAIL'} view toggle button removed`);
  if (!btnViewHidden) allFound = false;

  const btnThemeHidden = !(await page.locator('#btnTheme').isVisible().catch(() => false));
  console.log(`${btnThemeHidden ? 'OK ' : 'FAIL'} theme toggle button removed`);
  if (!btnThemeHidden) allFound = false;

  // Footer should be at bottom (not overlapping content)
  const footerBox = await page.locator('footer').boundingBox().catch(() => null);
  const viewport = page.viewportSize();
  if (footerBox && viewport) {
    const footerAtBottom = footerBox.y + footerBox.height >= viewport.height - 5;
    console.log(`${footerAtBottom ? 'OK ' : 'CHECK'} footer at bottom (y=${footerBox.y}, viewport=${viewport.height})`);
    if (!footerAtBottom) allFound = false;
  }

  // Check for console errors (excluding expected ones)
  const errCount = errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('404')
  ).length;

  console.log(`\n=== CONSOLE ERRORS (non-favicon/404): ${errCount} ===`);
  if (errCount === 0) console.log('(none)');

  // Screenshot (may fail in headless WebGL environments — non-fatal)
  let screenshotOk = false;
  try {
    await page.screenshot({ path: 'debug-dev.png', fullPage: true });
    console.log('\nScreenshot saved to debug-dev.png');
    screenshotOk = true;
  } catch (e) {
    console.log(`\nScreenshot skipped (headless WebGL): ${e.message}`);
  }

  console.log(`\n=== RESULT: ${allFound && errCount === 0 ? 'PASS' : 'FAIL'} ===`);
  console.log(`Elements: ${allFound ? 'ALL FOUND' : 'SOME MISSING'} | Errors: ${errCount}`);

  await browser.close();
  process.exit(allFound && errCount === 0 ? 0 : 1);
})();
