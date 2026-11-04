import { test, expect } from '@playwright/test';

/**
 * example.spec.ts
 *
 * Runs headless using a previously saved login session (auth/state.json).
 *
 *   STORAGE_STATE=auth/state.json npx playwright test example
 */

test('automated flow with saved session', async ({ page }) => {
  // TODO: Replace with your target URL
  await page.goto('https://example.com/dashboard');

  // Because storageState restores cookies/localStorage, you should already
  // be logged in — no login step needed here.
  await expect(page.locator('text=Dashboard')).toBeVisible();

  // Add your automation steps here
});
