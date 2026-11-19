/*
 * Static checks for runtime Wi-Fi provisioning.
 * Run with: node --test test/wifi.test.js
 *
 * The tracker no longer compiles an SSID or password into the image: it reads
 * a small list from NVS and opens a captive portal when it cannot join one.
 * These checks pin the properties that keep that safe and keep a fresh clone
 * working, without needing a radio in the test loop. The compiled check is
 * still `pio run`, which runs separately.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(root, 'src', 'mqtt_simple', 'mqtt_simple.cpp'), 'utf8');
const STORE_H = fs.readFileSync(
  path.join(root, 'src', 'mqtt_simple', 'wifi_store.h'), 'utf8');
const STORE = fs.readFileSync(
  path.join(root, 'src', 'mqtt_simple', 'wifi_store.cpp'), 'utf8');
const PORTAL = fs.readFileSync(
  path.join(root, 'src', 'mqtt_simple', 'wifi_portal.cpp'), 'utf8');

test('the firmware image carries no Wi-Fi credential', () => {
  // A compiled list was the thing that put a real hotspot password in the
  // public repository. The tracker must go through NVS only.
  assert.doesNotMatch(SRC, /wifi_config\.h/,
    'the tracker still includes the compiled credential header');
  assert.doesNotMatch(SRC, /WIFI_NET_COUNT|WIFI_NETS/,
    'the tracker still loops over a compiled network list');
  assert.match(SRC, /#include "wifi_store\.h"/);
  assert.match(SRC, /wifiStoreLoad\(\);/,
    'saved networks are never read at boot');
});

test('a fresh clone still builds the bench environment', () => {
  // src/wifi_config.h is gitignored, so the include has to be optional.
  const BENCH = fs.readFileSync(
    path.join(root, 'src', 'bench', 'bench_main.cpp'), 'utf8');
  assert.match(BENCH, /#if __has_include\("\.\.\/wifi_config\.h"\)/,
    'the bench build hard-requires a gitignored file');
  assert.match(BENCH, /#define BENCH_HAVE_WIFI_CONFIG 0/);
  assert.match(BENCH, /#if BENCH_HAVE_WIFI_CONFIG/,
    'the Wi-Fi join is not behind the optional-include guard');

  const EXAMPLE = fs.readFileSync(
    path.join(root, 'src', 'wifi_config.example.h'), 'utf8');
  assert.match(EXAMPLE, /YOUR_SSID/);
  assert.match(EXAMPLE, /WIFI_NETS/);

  const IGNORE = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(IGNORE, /^src\/wifi_config\.h$/m,
    'a local bench credential file would be committed again');
});

test('the credential list is small, versioned and atomic', () => {
  assert.match(STORE_H, /#define WIFI_STORE_MAX\s+4/);
  // One blob, so a half-written list can never look like the wrong network.
  assert.match(STORE, /struct WifiBlob/);
  assert.match(STORE, /const uint8_t BLOB_VERSION = 1;/);
  assert.match(STORE, /blob\.version = BLOB_VERSION;/);
  assert.match(STORE, /blob\.version == BLOB_VERSION/,
    'an unknown blob layout would be interpreted as credentials');
  assert.match(STORE, /prefs\.putBytes\(KEY, &blob, sizeof blob\)/);
  assert.match(STORE, /blob\.count <= WIFI_STORE_MAX/,
    'a corrupt count would read past the entry array');
});

test('a failed NVS write leaves the previous list intact', () => {
  // The RAM list is updated before the write so writeBlob() can see it; every
  // caller has to put the old copy back when that write fails.
  const save = STORE.slice(STORE.indexOf('bool wifiStoreSave'),
                           STORE.indexOf('bool wifiStoreForget'));
  const forget = STORE.slice(STORE.indexOf('bool wifiStoreForget'),
                             STORE.indexOf('bool wifiStoreClear'));
  const clear = STORE.slice(STORE.indexOf('bool wifiStoreClear'));
  for (const [name, body] of [['save', save], ['forget', forget], ['clear', clear]]) {
    assert.match(body, /memcpy\(g_nets, old, sizeof g_nets\);/,
      `${name} does not restore the list after a failed write`);
    assert.match(body, /g_count = oldCount;/,
      `${name} leaves the count out of step with the restored list`);
  }
});

test('saving a network moves it to the front and never duplicates an SSID', () => {
  const save = STORE.slice(STORE.indexOf('bool wifiStoreSave'),
                           STORE.indexOf('bool wifiStoreForget'));
  assert.match(save, /copyEntry\(next\[out\+\+\], ssid, pass\);/,
    'a new network is not the first candidate');
  assert.match(save, /if \(strcmp\(old\[i\]\.ssid, ssid\) == 0\) continue;/,
    'saving the same SSID again would leave two entries for one AP');
  assert.match(save, /out < WIFI_STORE_MAX/,
    'the list can grow past its fixed size');
});

test('an empty password means an open network', () => {
  assert.match(STORE, /copyEntry\(WifiCred& dst, const char\* ssid, const char\* pass\)/);
  assert.match(STORE, /memset\(&dst, 0, sizeof dst\);/,
    'a leftover password could turn an open network into a failed join');
  // The form must accept the empty case instead of rejecting it as too short.
  const save = PORTAL.slice(PORTAL.indexOf('void handleSave'),
                            PORTAL.indexOf('void handleForget'));
  assert.match(save, /pass\.length\(\) > 0 && pass\.length\(\) < 8/,
    'an empty password is treated as a short password');
});

test('the setup portal can provision both protected and open networks', () => {
  assert.match(PORTAL, /"Orion-Setup-%04X"/);
  assert.match(PORTAL, /WiFi\.softAP\(g_apSsid\)/,
    'the setup AP is not open, or needs a password nobody can read');
  for (const route of ['/', '/scan', '/save', '/forget']) {
    assert.match(PORTAL, new RegExp(`g_http\\.on\\("${route.replace('/', '\\/')}"`),
      `${route} is not registered`);
  }
  // Scan results and saved names reach HTML/JS: both contexts need escaping.
  assert.match(PORTAL, /String htmlEscape\(const String& in\)/);
  assert.match(PORTAL, /String jsonEscape\(const String& in\)/);
  assert.match(PORTAL, /g_http\.sendContent\(htmlEscape\(String\(g_apSsid\)\)\)/);
  assert.match(PORTAL, /out \+= jsonEscape\(items\[i\]\.ssid\)/);
  // A password is written to NVS and never rendered back into a page.
  assert.doesNotMatch(PORTAL, /wifiStorePass/,
    'the portal reads a stored password, so it can leak one');
});

test('only a client on the setup AP can change the saved list', () => {
  assert.match(PORTAL, /bool fromSetupClient\(\)/);
  assert.match(PORTAL, /g_http\.client\(\)\.remoteIP\(\)/);
  for (const handler of ['handleRoot', 'handleSave', 'handleForget', 'handleScan']) {
    const body = PORTAL.slice(PORTAL.indexOf(`void ${handler}(`),
                              PORTAL.indexOf('\n}', PORTAL.indexOf(`void ${handler}(`)));
    assert.match(body, /if \(!fromSetupClient\(\)\) \{ sendForbidden\(\); return; \}/,
      `${handler} is reachable from the station interface`);
  }
});

test('a save reboots after the response has left the socket', () => {
  const save = PORTAL.slice(PORTAL.indexOf('void handleSave'),
                            PORTAL.indexOf('void handleForget'));
  assert.doesNotMatch(save, /ESP\.restart\(\)/,
    'restarting inside the handler truncates the saved page');
  assert.match(save, /g_restartAt = millis\(\) \+ 1500UL;/);
  assert.match(PORTAL, /if \(g_restartAt && \(int32_t\)\(millis\(\) - g_restartAt\) >= 0\)/);
  assert.match(PORTAL, /ESP\.restart\(\);/,
    'the deferred restart never happens');
});

test('the portal opens itself when no saved network connects', () => {
  assert.match(SRC, /#define WIFI_PORTAL_AFTER_MS\s+45000UL/);
  assert.match(SRC, /#define WIFI_BOOT_PIN\s+0/);
  assert.match(SRC, /#define WIFI_BOOT_HOLD_MS\s+3000UL/);
  assert.match(SRC, /now - wifiDownSince >= WIFI_PORTAL_AFTER_MS/);
  assert.match(SRC, /if \(wifiStoreCount\(\) == 0\)/,
    'an empty list would scan forever instead of opening the portal');
  assert.match(SRC, /case 'w': case 'W':\s+wifiPortalToggle\("console"\);/,
    'the documented console key does not open the portal');
  assert.match(SRC, /wifiPortalLoop\(\);/,
    'the portal HTTP server is never polled');
});

test('the portal does not cut a working telemetry link', () => {
  assert.match(PORTAL, /WiFi\.mode\(WIFI_AP_STA\)/,
    'a manually opened portal would stop the station interface');
  assert.match(SRC, /wifiPortalOpenedWithLink = \(WiFi\.status\(\) == WL_CONNECTED\)/);
  assert.match(SRC, /wifiPortalActive\(\) && !wifiPortalOpenedWithLink/,
    'an automatic portal would stay open after the station recovered');
  assert.match(SRC, /if \(wifiPortalActive\(\) && WiFi\.status\(\) != WL_CONNECTED\) return;/,
    'the station state machine fights the portal for the radio');
});
