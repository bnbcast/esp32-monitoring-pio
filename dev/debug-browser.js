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

const { chromium } = require('../browser-automation/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const logs = [];
  const errors = [];

  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logs.push(text);
    console.log(text);
  });

  page.on('pageerror', (err) => {
    errors.push(err.message);
    console.log('PAGE ERROR:', err.message);
  });

  page.on('websocket', (ws) => {
    console.log(`WS: ${ws.url()} - ${ws.isClosed() ? 'CLOSED' : 'OPEN'}`);
  });

  await page.goto('http://localhost:5003/?dev&t=dev-test-1234', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('Page loaded, title:', await page.title());

  // Wait for data to flow
  await page.waitForTimeout(5000);

  // Check elements
  const gps3dCount = await page.locator('#gps3d-container').count();
  console.log('3D container found:', gps3dCount);

  const tGps3d = await page.locator('#tGps3d').textContent().catch(() => 'NOT FOUND');
  console.log('Trace status:', tGps3d);

  const vDist = await page.locator('#vDist').textContent().catch(() => 'NOT FOUND');
  console.log('Distance:', vDist);

  const vAvgSpd = await page.locator('#vAvgSpd').textContent().catch(() => 'NOT FOUND');
  console.log('Avg speed:', vAvgSpd);

  const vHdop = await page.locator('#vHdop').textContent().catch(() => 'NOT FOUND');
  console.log('HDOP:', vHdop);

  await page.screenshot({ path: 'debug-dev.png', fullPage: true });
  console.log('Screenshot saved to debug-dev.png');

  console.log('\n=== ERRORS ===');
  if (errors.length === 0) console.log('(none)');
  errors.forEach((e) => console.log(e));

  await browser.close();
})();
