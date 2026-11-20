/*
 * wifi_portal.cpp - captive setup portal for the tracker.
 *
 * Design notes:
 *  - The AP is open: a setup hotspot that needs a password the user cannot
 *    read is worse than a hotspot that exists only while provisioning.
 *  - The HTML lives in flash and is streamed in chunks, so a page render does
 *    not need a 5 KB String on an already-fragmented heap.
 *  - Every dynamic value is escaped for its context: HTML for the page, JSON
 *    for the scan response. Passwords are never rendered at all.
 *  - /save writes NVS and schedules a restart; it never calls ESP.restart()
 *    inside the request handler, so the response can leave the socket first.
 */
#include "wifi_portal.h"
#include "wifi_store.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <stdarg.h>

// Page chunks live in flash at the bottom of this file. Declared here so the
// anonymous-namespace handlers can stream them without internal-linkage copies.
extern const char PAGE_HEAD[] PROGMEM;
extern const char PAGE_SAVED_HEAD[] PROGMEM;
extern const char PAGE_NO_SAVED[] PROGMEM;
extern const char PAGE_FORM[] PROGMEM;
extern const char PAGE_TAIL[] PROGMEM;

namespace {

WebServer g_http(80);
DNSServer g_dns;
WifiPortalLog g_log = nullptr;

bool g_active = false;
bool g_routesReady = false;
char g_apSsid[24] = {0};
uint32_t g_restartAt = 0;

enum ScanState { SCAN_IDLE, SCAN_RUNNING };
ScanState g_scanState = SCAN_IDLE;
uint32_t g_scanStarted = 0;

void portalLog(const char* fmt, ...) {
  char line[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  if (g_log) g_log(line);
  else Serial.println(line);
}

String htmlEscape(const String& in) {
  String out;
  out.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); i++) {
    const char c = in[i];
    switch (c) {
      case '&':  out += F("&amp;");  break;
      case '<':  out += F("&lt;");   break;
      case '>':  out += F("&gt;");   break;
      case '"':  out += F("&quot;"); break;
      case '\'': out += F("&#39;");  break;
      default:
        if ((uint8_t)c < 0x20) {
          char tmp[8];
          snprintf(tmp, sizeof tmp, "&#%u;", (unsigned)(uint8_t)c);
          out += tmp;
        } else {
          out += c;
        }
    }
  }
  return out;
}

String jsonEscape(const String& in) {
  String out;
  out.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); i++) {
    const uint8_t c = (uint8_t)in[i];
    switch (c) {
      case '"':  out += F("\\\"");  break;
      case '\\': out += F("\\\\");  break;
      case '\b': out += F("\\b");   break;
      case '\f': out += F("\\f");   break;
      case '\n': out += F("\\n");   break;
      case '\r': out += F("\\r");   break;
      case '\t': out += F("\\t");   break;
      default:
        if (c < 0x20) {
          char tmp[7];
          snprintf(tmp, sizeof tmp, "\\u%04x", (unsigned)c);
          out += tmp;
        } else {
          out += (char)c;   // UTF-8 bytes pass through unchanged
        }
    }
  }
  return out;
}

// The HTTP server listens on every interface. Mutating endpoints are only for
// clients that joined the setup AP: the request must have arrived on the AP
// address, not merely come from a station-side address that happens to share
// the 192.168.4.x prefix.
bool fromSetupClient() {
  const IPAddress ap = WiFi.softAPIP();
  const IPAddress local = g_http.client().localIP();
  if (!(local == ap)) return false;
  const IPAddress remote = g_http.client().remoteIP();
  return remote[0] == ap[0] && remote[1] == ap[1] && remote[2] == ap[2];
}

void sendForbidden() {
  g_http.send(403, "text/plain", "Join the Orion setup hotspot first.");
}

void redirectToPortal() {
  String loc = F("http://");
  loc += WiFi.softAPIP().toString();
  loc += '/';
  g_http.sendHeader("Location", loc);
  g_http.send(302, "text/plain", String(F("Orion setup: ")) + loc);
}

void sendMessage(int code, const char* title, const String& message, bool back) {
  if (!fromSetupClient()) { sendForbidden(); return; }
  g_http.sendHeader("Cache-Control", "no-store");
  String page = F("<!doctype html><html><head><meta charset=utf-8>"
                  "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
                  "<title>");
  page += title;
  page += F("</title><style>"
            "body{margin:0;background:#0d0f12;color:#e8edf3;font:16px/1.55 system-ui,Segoe UI,sans-serif}"
            "main{max-width:560px;margin:0 auto;padding:28px 18px 60px}"
            "h1{font-size:26px;margin:0 0 6px}p{color:#b8c3ce}"
            "a{color:#ffe600}.card{background:#151a20;border:1px solid #252d37;border-radius:12px;padding:18px;margin:16px 0}"
            ".btn{display:inline-block;background:#ffe600;color:#111;text-decoration:none;font-weight:700;"
            "border:0;border-radius:9px;padding:12px 16px;margin-top:12px}"
            "</style></head><body><main><h1>");
  page += title;
  page += F("</h1><div class=card><p>");
  page += message;
  page += F("</p>");
  if (back) page += F("<a class=btn href=\"/\">Back to setup</a>");
  page += F("</div></main></body></html>");
  g_http.send(code, "text/html; charset=utf-8", page);
}

// ------------------------------------------------------------------ page ---

void handleRoot() {
  if (!fromSetupClient()) { sendForbidden(); return; }

  g_http.sendHeader("Cache-Control", "no-store");
  g_http.setContentLength(CONTENT_LENGTH_UNKNOWN);
  g_http.send(200, "text/html; charset=utf-8", "");
  g_http.sendContent_P(PAGE_HEAD);

  if (wifiStoreCount() == 0) {
    g_http.sendContent_P(PAGE_NO_SAVED);
  } else {
    g_http.sendContent_P(PAGE_SAVED_HEAD);
    for (size_t i = 0; i < wifiStoreCount(); i++) {
      const String ssid = htmlEscape(String(wifiStoreSsid(i)));
      String item = F("<li><span class=\"ssid\">");
      item += ssid;
      item += F("</span><form method=\"post\" action=\"/forget\">"
                "<input type=\"hidden\" name=\"ssid\" value=\"");
      item += ssid;
      item += F("\"><button class=\"link\" type=\"submit\">Forget</button></form></li>");
      g_http.sendContent(item);
    }
    g_http.sendContent_P("</ul>");
  }

  g_http.sendContent_P(PAGE_FORM);
  g_http.sendContent(htmlEscape(String(g_apSsid)));
  g_http.sendContent_P(PAGE_TAIL);
  g_http.sendContent("");
}

void handleProbe() {
  redirectToPortal();
}

void handleFavicon() {
  g_http.send(204, "text/plain", "");
}

void handleNotFound() {
  if (!fromSetupClient()) { sendForbidden(); return; }
  redirectToPortal();
}

// ------------------------------------------------------------------ scan ---

void startScan() {
  const int16_t rc = WiFi.scanNetworks(true /*async*/, false /*hidden*/);
  if (rc == WIFI_SCAN_RUNNING || rc >= 0) {
    g_scanState = SCAN_RUNNING;
    g_scanStarted = millis();
  } else {
    g_scanState = SCAN_IDLE;
  }
}

struct ScanItem {
  String  ssid;
  int32_t rssi;
  uint8_t channel;
  bool    open;
};

String scanJson() {
  if (g_scanState != SCAN_RUNNING) {
    return F("{\"scanning\":false,\"networks\":[]}");
  }

  const int16_t found = WiFi.scanComplete();
  if (found == WIFI_SCAN_RUNNING) {
    return F("{\"scanning\":true,\"networks\":[]}");
  }
  if (found < 0) {
    WiFi.scanDelete();
    g_scanState = SCAN_IDLE;
    return F("{\"scanning\":false,\"error\":\"scan failed\",\"networks\":[]}");
  }

  // One row per SSID. A mesh/repeater advertises the same name on several
  // channels; showing it four times only makes the list harder to tap.
  ScanItem items[24];
  size_t count = 0;
  for (int i = 0; i < found && count < 24; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length()) continue;                 // hidden AP
    if (ssid == g_apSsid) continue;               // our own setup AP
    bool duplicate = false;
    for (size_t k = 0; k < count; k++) {
      if (items[k].ssid == ssid) { duplicate = true; break; }
    }
    if (duplicate) continue;
    items[count].ssid    = ssid;
    items[count].rssi    = WiFi.RSSI(i);
    items[count].channel = (uint8_t)WiFi.channel(i);
    items[count].open    = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN);
    count++;
  }

  // Strongest first: the phone is usually next to the AP the user wants.
  for (size_t i = 0; i < count; i++) {
    for (size_t j = i + 1; j < count; j++) {
      if (items[j].rssi > items[i].rssi) {
        ScanItem tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
    }
  }

  const size_t shown = count > 20 ? 20 : count;
  String out;
  out.reserve(64 + shown * 72);
  out = F("{\"scanning\":false,\"networks\":[");
  for (size_t i = 0; i < shown; i++) {
    if (i) out += ',';
    out += F("{\"ssid\":\"");
    out += jsonEscape(items[i].ssid);
    out += F("\",\"rssi\":");
    out += String(items[i].rssi);
    out += F(",\"ch\":");
    out += String((unsigned)items[i].channel);
    out += F(",\"open\":");
    out += (items[i].open ? F("true") : F("false"));
    out += '}';
  }
  out += "]}";

  WiFi.scanDelete();
  g_scanState = SCAN_IDLE;
  return out;
}

void handleScan() {
  if (!fromSetupClient()) { sendForbidden(); return; }
  g_http.sendHeader("Cache-Control", "no-store");
  if (g_http.hasArg("fresh")) {
    // A finished scan can be restarted; a running one is already fresh enough.
    if (g_scanState == SCAN_IDLE) {
      WiFi.scanDelete();
      startScan();
    }
  } else if (g_scanState == SCAN_IDLE) {
    startScan();
  }
  g_http.send(200, "application/json", scanJson());
}

// ------------------------------------------------------------------ save ---

void handleSave() {
  if (!fromSetupClient()) { sendForbidden(); return; }

  String ssid = g_http.arg("ssid");
  String pass = g_http.arg("pass");

  if (ssid.length() == 0) {
    sendMessage(400, "Network name missing",
                F("Type the network name, or pick one from the scan list."), true);
    return;
  }
  if (ssid.length() > 32) {
    sendMessage(400, "Network name too long",
                F("An SSID is at most 32 characters."), true);
    return;
  }
  if (pass.length() > 64) {
    sendMessage(400, "Password too long",
                F("A Wi-Fi password is at most 64 characters."), true);
    return;
  }
  // WPA/WPA2/WPA3 passphrases are 8-63 characters; 64 is the raw hex PSK.
  // Anything between 1 and 7 would be accepted by the form and then fail as
  // an association timeout, which looks like a dead hotspot.
  if (pass.length() > 0 && pass.length() < 8) {
    sendMessage(400, "Password too short",
                F("Use at least 8 characters, or leave the password empty for an open network."), true);
    return;
  }

  if (!wifiStoreSave(ssid.c_str(), pass.c_str())) {
    sendMessage(500, "Could not save",
                F("The credential list could not be written to flash. Try again; "
                  "if it keeps failing the NVS partition may be full."), true);
    return;
  }

  portalLog("saved '%s' (%s), rebooting", ssid.c_str(), pass.length() ? "password" : "open");
  g_http.sendHeader("Cache-Control", "no-store");
  sendMessage(200, "Saved",
              String(F("The device will reboot and join <b>")) + htmlEscape(ssid) +
                  F("</b>. If it cannot connect, the setup hotspot returns after 45 seconds."),
              false);
  g_restartAt = millis() + 1500UL;
}

void handleForget() {
  if (!fromSetupClient()) { sendForbidden(); return; }

  const String ssid = g_http.arg("ssid");
  if (ssid.length() == 0) {
    sendMessage(400, "Nothing to forget", F("No network name was supplied."), true);
    return;
  }
  if (!wifiStoreForget(ssid.c_str())) {
    sendMessage(404, "Not saved",
                String(F("No saved network named <b>")) + htmlEscape(ssid) + F("</b>."), true);
    return;
  }

  portalLog("forgot '%s'", ssid.c_str());
  g_http.sendHeader("Location", "/");
  g_http.send(303, "text/plain", "");
}

// ----------------------------------------------------------------- routes ---

void registerRoutes() {
  g_http.on("/", HTTP_GET, handleRoot);
  g_http.on("/scan", HTTP_GET, handleScan);
  g_http.on("/save", HTTP_POST, handleSave);
  g_http.on("/forget", HTTP_POST, handleForget);
  g_http.on("/favicon.ico", HTTP_GET, handleFavicon);

  // Captive-portal probes. A redirect is enough for Android, iOS and Windows
  // to show the "sign in to network" sheet; the exact body is not parsed.
  static const char* const probes[] = {
    "/generate_204", "/gen_204", "/hotspot-detect.html",
    "/library/test/success.html", "/connecttest.txt", "/ncsi.txt",
    "/redirect", "/success.txt", "/canonical.html", "/fwlink",
  };
  for (size_t i = 0; i < sizeof probes / sizeof probes[0]; i++) {
    g_http.on(probes[i], HTTP_ANY, handleProbe);
  }
  g_http.onNotFound(handleNotFound);
}

}  // namespace

void wifiPortalSetLogger(WifiPortalLog sink) {
  g_log = sink;
}

bool wifiPortalActive() {
  return g_active;
}

const char* wifiPortalSsid() {
  return g_active ? g_apSsid : "";
}

bool wifiPortalBegin() {
  if (g_active) return true;

  const uint64_t mac = ESP.getEfuseMac();
  snprintf(g_apSsid, sizeof g_apSsid, "Orion-Setup-%04X", (unsigned)(mac & 0xFFFF));

  // AP_STA, not AP: when the board is already publishing, starting the portal
  // from the console must not cut the telemetry link. With no station link it
  // behaves like a plain AP.
  WiFi.mode(WIFI_AP_STA);
  delay(10);
  if (!WiFi.softAP(g_apSsid, "12345678")) {
    portalLog("softAP failed");
    WiFi.mode(WIFI_STA);
    return false;
  }
  // Keep the project-wide TX limit: the setup AP is short-lived, but a phone
  // next to the board is exactly the case where 19.5 dBm is unnecessary.
  WiFi.setTxPower(WIFI_POWER_15dBm);

  const IPAddress ip = WiFi.softAPIP();
  if (!g_dns.start(53, "*", ip)) {
    portalLog("DNS server failed to start");
  }
  if (!g_routesReady) {
    registerRoutes();
    g_routesReady = true;
  }
  g_http.begin();

  g_scanState = SCAN_IDLE;
  g_restartAt = 0;
  g_active = true;
  portalLog("setup AP '%s' open at http://%s/", g_apSsid, ip.toString().c_str());
  return true;
}

void wifiPortalEnd() {
  if (!g_active) return;
  g_active = false;
  g_restartAt = 0;
  g_scanState = SCAN_IDLE;
  g_http.stop();
  g_dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  portalLog("setup AP stopped");
}

void wifiPortalLoop() {
  if (!g_active) return;

  g_http.handleClient();

  // DNSServer runs on its own async socket in core 3.x; this call is a no-op
  // kept for compatibility with older cores.
  g_dns.processNextRequest();

  if (g_scanState == SCAN_RUNNING && millis() - g_scanStarted > 15000UL) {
    WiFi.scanDelete();
    g_scanState = SCAN_IDLE;
    portalLog("scan timed out");
  }

  if (g_restartAt && (int32_t)(millis() - g_restartAt) >= 0) {
    ESP.restart();
  }
}

// ================================================================== page ===
// Split into chunks because the WebServer streams it and a single 5 KB literal
// would still have to be copied into a String by send(). The page is plain
// HTML/CSS/JS with no external request, so it works before the device has a
// route to the internet.

extern const char PAGE_HEAD[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orion Setup</title>
<style>
:root{--bg:#0d0f12;--panel:#151a20;--line:#252d37;--ink:#e8edf3;--muted:#9aa7b5;--accent:#ffe600}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:600px;margin:0 auto;padding:26px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
p{margin:8px 0;color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
label{display:block;margin:12px 0 4px;font-size:13px;color:var(--muted)}
input{width:100%;background:#0a0c0f;border:1px solid var(--line);border-radius:9px;color:var(--ink);
padding:13px 12px;font:16px/1.3 ui-monospace,Consolas,monospace}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.hint{font-size:12.5px;color:var(--muted)}
.primary{width:100%;background:var(--accent);color:#111;border:0;border-radius:9px;padding:14px;
font-size:16px;font-weight:750;margin-top:16px;cursor:pointer}
.link{background:none;border:0;color:#ff8a8a;font:inherit;font-size:13px;cursor:pointer;padding:4px 6px}
.nets{list-style:none;margin:0;padding:0}
.nets li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 0;
border-bottom:1px solid var(--line)}
.nets li:last-child{border-bottom:0}
.ssid{font-weight:650;word-break:break-word}
.row{display:flex;gap:8px;align-items:center}
.row h2{flex:1;margin:0}
.scan{background:#232b34;color:var(--ink);border:1px solid var(--line);border-radius:8px;
padding:8px 12px;font:inherit;font-size:13px;cursor:pointer}
.net{display:block;width:100%;text-align:left;background:#10151a;color:var(--ink);
border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:7px 0;font:inherit;cursor:pointer}
.net:active{border-color:var(--accent)}
.net .meta{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.foot{font-size:12px;color:var(--muted);margin-top:22px;text-align:center}
#show{width:auto;margin:0}
</style></head><body><main>
<h1>Orion setup</h1>
<p>Connect this tracker to a 2.4 GHz Wi-Fi network.</p>
<div class="card"><h2>Saved networks</h2>
)HTML";

extern const char PAGE_SAVED_HEAD[] PROGMEM = R"HTML(<ul class="nets">)HTML";
extern const char PAGE_NO_SAVED[] PROGMEM =
  R"HTML(<p>No networks saved yet. Add the first one below.</p>)HTML";

// Closes the saved-networks card and opens the form, scan card and footer.
extern const char PAGE_FORM[] PROGMEM = R"HTML(</div>
<div class="card"><h2>Add a network</h2>
<form method="post" action="/save" autocomplete="off">
<label for="ssid">Network name (SSID)</label>
<input id="ssid" name="ssid" maxlength="32" required autocomplete="off"
 autocapitalize="none" spellcheck="false" placeholder="Type it, or pick from the scan">
<label for="pass">Password</label>
<input id="pass" name="pass" type="password" maxlength="64" autocomplete="new-password"
 placeholder="Leave empty for an open network">
<div class="row" style="margin-top:10px">
<input id="show" type="checkbox"><label for="show" style="margin:0">Show password</label>
</div>
<p class="hint">Leave the password empty for an open network. Only 2.4 GHz
networks are visible to the ESP32; 5 GHz-only networks will not appear.</p>
<button class="primary" type="submit">Save and reboot</button>
</form></div>
<div class="card"><div class="row"><h2>Nearby networks</h2>
<button class="scan" type="button" id="scan">Scan</button></div>
<p class="hint" id="scanmsg">Tap Scan to list what the tracker can see. Hidden
networks can be typed into the form instead.</p><div id="nets"></div></div>
<p class="foot">Setup hotspot: <b>)HTML";

extern const char PAGE_TAIL[] PROGMEM = R"HTML(</b></p><script>
(function(){
  var scan=document.getElementById('scan'),msg=document.getElementById('scanmsg'),
      list=document.getElementById('nets'),ssid=document.getElementById('ssid'),
      pass=document.getElementById('pass'),show=document.getElementById('show'),timer=0;
  function fail(){msg.textContent='Scan interrupted. Tap Scan again.';}
  function render(nets){
    list.innerHTML='';
    if(!nets.length){msg.textContent='No networks found. Type the name in the form above.';return;}
    nets.forEach(function(n){
      var b=document.createElement('button');
      b.type='button';b.className='net';
      var name=document.createElement('span');name.className='ssid';name.textContent=n.ssid;
      var meta=document.createElement('span');meta.className='meta';
      meta.textContent=(n.open?'open network':'password')+' \u00b7 '+n.rssi+' dBm \u00b7 ch '+n.ch;
      b.appendChild(name);b.appendChild(meta);
      b.onclick=function(){
        ssid.value=n.ssid;
        if(n.open){pass.value='';pass.placeholder='Open network - no password needed';}
        else {pass.placeholder='Network password';}
        pass.focus();
      };
      list.appendChild(b);
    });
    msg.textContent=nets.length+' network(s) found. Tap one to fill the form.';
  }
  function poll(){
    fetch('/scan',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      if(j.scanning){timer=setTimeout(poll,1100);return;}
      if(j.error){msg.textContent=j.error;return;}
      render(j.networks||[]);
    }).catch(fail);
  }
  scan.onclick=function(){
    clearTimeout(timer);list.innerHTML='';msg.textContent='Scanning...';
    fetch('/scan?fresh=1',{cache:'no-store'}).then(poll).catch(fail);
  };
  show.onchange=function(){pass.type=show.checked?'text':'password';};
})();
</script>
</main></body></html>)HTML";
