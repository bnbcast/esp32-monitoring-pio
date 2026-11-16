/*
 * Static checks for the interactive API tester served at /api/docs.
 * Run with: node --test test/api-docs.test.js
 *
 * The tester is plain HTML + JS with no build step, so the risks are the ones
 * a browser probe catches only by luck: an endpoint that silently disappears
 * from the UI, a key that gets baked into the page, or a CSP that blocks the
 * very request the page exists to send. These assertions pin the contract.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const HTML = read('web/api/docs/index.html');
const JS = read('web/api/docs/app.js');

test('the tester exposes every documented endpoint', () => {
  // One card per endpoint, plus the response panel the user actually reads.
  for (const id of ['healthTitle', 'historyTitle', 'ingestTitle', 'optionsTitle',
                    'errorTitle', 'respStatus', 'respMeta', 'respHeaders', 'respBody']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `#${id} is missing`);
  }

  assert.match(JS, /path: '\/health'/, 'GET /health is never sent');
  assert.match(JS, /path: historyQuery\(\)/, 'GET /history is never sent');
  assert.match(JS, /path: '\/ingest'/, 'POST /ingest is never sent');
  assert.match(JS, /method: 'OPTIONS'/, 'OPTIONS is never sent');
  // The error shape is a wrong method on a real path: Pages serves the
  // landing page for arbitrary paths, so /nope is not a JSON 404 there.
  assert.match(JS, /method: 'GET',\s*\n\s*path: '\/ingest'/, 'the wrong-method probe is missing');
  assert.match(JS, /intent: 'error'/, 'the wrong-method probe is not identified');

  // /history must build the four documented query parameters.
  for (const key of ['device', 'from', 'to', 'limit']) {
    assert.match(JS, new RegExp(`p\\.set\\('${key}'`), `GET /history never sets ${key}`);
  }
});

test('the tester points at the public API and nowhere else by default', () => {
  assert.match(JS, /DEFAULT_BASE = 'https:\/\/race-tracker-history\.pages\.dev'/);
  assert.match(HTML, /value="https:\/\/race-tracker-history\.pages\.dev"/);
  // A custom base is allowed, but it must still be an absolute http(s) origin.
  assert.match(JS, /u\.protocol !== 'https:' && u\.protocol !== 'http:'/);
  assert.match(JS, /if \(u\.search \|\| u\.hash\)/);
});

test('the ingest key is never embedded, previewed or stored by default', () => {
  // The input starts empty and the page ships no value for it.
  assert.doesNotMatch(HTML, /id="iKey"[^>]*value="[^"]+"/,
    'the key input must be empty in the markup');
  // The key is read from the field only when a request runs.
  assert.match(JS, /'x-ingest-key': key/, 'the header is not taken from the input');
  // The copyable curl always shows a placeholder, never the secret.
  assert.match(JS, /x-ingest-key: \$INGEST_KEY/, 'the curl preview must use a placeholder');
  assert.doesNotMatch(JS, /\$\{key\}/, 'the key must never be interpolated into the curl preview');
  // localStorage is written only behind the explicit remember checkbox.
  assert.match(JS, /remember\.checked \? keyEl\.value\.trim\(\) : ''/,
    'the key is persisted without the remember checkbox');
});

test('the CSP allows the request the page exists to send', () => {
  const csp = (HTML.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert.ok(csp, 'the page has no Content-Security-Policy');
  assert.match(csp, /connect-src https:/, 'https APIs are blocked by connect-src');
  assert.match(csp, /http:\/\/localhost:\*/, 'the local wrangler dev server is blocked');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'scripts must stay in app.js');
  assert.match(csp, /form-action 'none'/);
});

test('the response panel reports status, timing, headers and body', () => {
  assert.match(JS, /res\.headers\.forEach/, 'response headers are never read');
  assert.match(JS, /performance\.now\(\)/, 'the request is not timed');
  assert.match(JS, /JSON\.stringify\(JSON\.parse\(text\), null, 2\)/, 'the body is not pretty-printed');
  assert.match(JS, /new AbortController\(\)/, 'a stalled request can hang the page');
  assert.match(JS, /mode: 'cors'/);
  assert.match(JS, /credentials: 'omit'/);
});

test('the UI mirrors the ingestion limits and the verify-key trick', () => {
  assert.match(JS, /MAX_FRAMES = 120/);
  assert.match(JS, /MAX_BYTES = 64 \* 1024/);
  // Auth is checked before the body, so an empty object proves the key
  // without storing a row.
  assert.match(JS, /body: '\{\}'/, 'the no-write key check is missing');
  assert.match(JS, /no-frames/, 'the key-check response is not explained');
  assert.match(JS, /401 unauthorized/);
});

test('the docs site links to the tester, and the renderer cannot wipe it', () => {
  const endpoints = read('doc/api/endpoints.md');
  assert.match(endpoints, /https:\/\/bnbcast\.github\.io\/esp32-monitoring-pio\/api\/docs\//,
    'the endpoint reference does not link to the tester');

  const build = read('tools/build-docs.mjs');
  assert.match(build, /\.\.\/api\/docs\//, 'the docs nav has no tester link');
  // The tester lives in web/api/docs, outside the generated web/doc tree.
  assert.match(build, /outRoot = join\(root, "web", "doc"\)/,
    'build-docs must only own web/doc');
});
