import { test, expect } from '@playwright/test';

/**
 * save-login.spec.ts — GitHub
 *
 * Log in to GitHub once and persist the session to auth/state.json.
 * Run headed the first time so you can complete login/MFA manually:
 *
 *   STORAGE_STATE=auth/state.json npx playwright test save-login --headed
 *
 * Afterward, run headless with the saved session:
 *
 *   STORAGE_STATE=auth/state.json npx playwright test example
 */

test('save persistent GitHub login session', async ({ page }) => {
  // Navigate to GitHub login
  await page.goto('https://github.com/login');

  // TODO: Fill in your GitHub credentials (or do it manually in the browser)
  // await page.fill('input[name="login"]', process.env.GITHUB_USER!);
  // await page.fill('input[name="password"]', process.env.GITHUB_PASS!);
  // await page.click('input[type="submit"]');

  // Wait for successful login - GitHub redirects to /dashboard after login
  // 5 minute timeout to allow time for manual login + MFA
  await expect(page).toHaveURL(/github\.com\/dashboard/, { timeout: 300000 });

  // Playwright automatically writes storageState when the test ends
  // if STORAGE_STATE env var is set (e.g., auth/state.json).
});
