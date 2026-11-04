// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Reusable Playwright config for headless browser automation
 * with persistent logged-in context (storageState).
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  // Persistent storage state so logins survive across runs
  storageState: process.env.STORAGE_STATE || 'auth/state.json',

  use: {
    headless: process.env.HEADLESS === 'true',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome'],
    },
  ],

  webServer: undefined,
});
