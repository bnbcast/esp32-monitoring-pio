# Reusable Browser Automation (Playwright)

Persistent, headless browser automation with saved login state so you stay
logged in across runs. Works across projects — copy this folder anywhere.

## Quick start

```bash
# Install dependencies (one time)
npm install

# Install browsers (one time)
npx playwright install chromium

# Save a login session (interactive headed browser)
STORAGE_STATE=auth/state.json HEADLESS=false npx playwright test tests/save-login.spec.ts

# Run headless with the saved session
STORAGE_STATE=auth/state.json npx playwright test
```

## Files

| File | Purpose |
|------|---------|
| `playwright.config.js` | Project Playwright config with `storageState` support |
| `tests/save-login.spec.ts` | Example: log in once, save `auth/state.json` |
| `tests/example.spec.ts` | Example: run headless using saved session |
| `auth/` | Saved login state (gitignored — contains cookies/tokens) |

## Persistent login flow

1. Run the save-login spec in **headed** mode (`HEADLESS=false`).
2. Complete the login manually in the browser window.
3. Playwright writes cookies/localStorage to `auth/state.json`.
4. Future runs use `STORAGE_STATE=auth/state.json` to restore the session —
   no re-login needed, fully headless.

## Service account / non-interactive login

If you have a service account, fill credentials in `save-login.spec.ts` and
run it headlessly once to populate `auth/state.json`. After that, all
automation runs headless with that service-account session.

## Reuse in other projects

Copy `playwright.config.js`, `tests/`, and `auth/` into any project, then:

```bash
npm install playwright
npx playwright install chromium
STORAGE_STATE=auth/state.json npx playwright test
```
