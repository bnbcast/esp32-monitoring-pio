const { test, expect } = require('@playwright/test');

test('debug dev server MQTT connection', async ({ page }) => {
  const logs = [];
  const errors = [];

  // Capture console messages
  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logs.push(text);
    console.log(text);
  });

  // Capture page errors
  page.on('pageerror', (err) => {
    errors.push(err.message);
    console.log('PAGE ERROR:', err.message);
  });

  // Capture WebSocket-related network events
  page.on('websocket', (ws) => {
    console.log(`WS: ${ws.url()} - ${ws.isClosed() ? 'CLOSED' : 'OPEN'}`);
    ws.on('framesent', (frame) => console.log('WS SENT:', frame.opcode, frame.payload?.length));
    ws.on('framereceived', (frame) => console.log('WS RECV:', frame.opcode, frame.payload?.length));
  });

  // Navigate to dev server
  await page.goto('http://localhost:5003/?dev&t=dev-test-1234', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('Page loaded, title:', await page.title());

  // Wait for GPS trace to appear
  await page.waitForTimeout(5000);

  // Check if 3D trace container exists
  const gps3d = await page.locator('#gps3d-container').count();
  console.log('3D container found:', gps3d);

  // Check if trace status shows
  const tGps3d = await page.locator('#tGps3d').textContent();
  console.log('Trace status:', tGps3d);

  // Check distance
  const vDist = await page.locator('#vDist').textContent();
  console.log('Distance:', vDist);

  // Check speed
  const vAvgSpd = await page.locator('#vAvgSpd').textContent();
  console.log('Avg speed:', vAvgSpd);

  // Take screenshot
  await page.screenshot({ path: 'playwright-report/debug-dev.png', fullPage: true });
  console.log('Screenshot saved');

  // Print all logs
  console.log('\n=== ALL LOGS ===');
  logs.forEach((l) => console.log(l));

  console.log('\n=== ALL ERRORS ===');
  errors.forEach((e) => console.log(e));

  // Verify page loaded
  expect(gps3d).toBeGreaterThan(0);
});
