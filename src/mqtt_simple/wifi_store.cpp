/*
 * wifi_store.cpp - NVS-backed Wi-Fi credential list.
 *
 * One NVS blob keeps the whole list atomic: a half-written list would look like
 * "connected to the wrong network", which is exactly the bug this is meant to
 * avoid. The blob is versioned so a future field can be added without trying
 * to interpret an old layout.
 */
#include "wifi_store.h"

#include <Preferences.h>
#include <string.h>

namespace {

const char* const NS  = "wifi";
const char* const KEY = "nets";
const uint8_t BLOB_VERSION = 1;

struct WifiCred {
  char ssid[WIFI_SSID_MAX];
  char pass[WIFI_PASS_MAX];
};

struct WifiBlob {
  uint8_t  version;
  uint8_t  count;
  WifiCred nets[WIFI_STORE_MAX];
};

WifiCred g_nets[WIFI_STORE_MAX];
size_t   g_count  = 0;
bool     g_loaded = false;

void ensureLoaded() {
  if (!g_loaded) wifiStoreLoad();
}

void clearRam() {
  memset(g_nets, 0, sizeof g_nets);
  g_count = 0;
}

void copyEntry(WifiCred& dst, const char* ssid, const char* pass) {
  memset(&dst, 0, sizeof dst);
  strncpy(dst.ssid, ssid, WIFI_SSID_MAX - 1);
  strncpy(dst.pass, pass, WIFI_PASS_MAX - 1);
  dst.ssid[WIFI_SSID_MAX - 1] = '\0';
  dst.pass[WIFI_PASS_MAX - 1] = '\0';
}

bool writeBlob() {
  WifiBlob blob;
  memset(&blob, 0, sizeof blob);
  blob.version = BLOB_VERSION;
  blob.count   = (uint8_t)g_count;
  memcpy(blob.nets, g_nets, sizeof g_nets);

  Preferences prefs;
  if (!prefs.begin(NS, false)) return false;
  const size_t written = prefs.putBytes(KEY, &blob, sizeof blob);
  prefs.end();
  return written == sizeof blob;
}

const char* validSsid(const char* ssid) {
  if (!ssid || !ssid[0]) return nullptr;
  // strnlen stops at the first NUL and never reads past the maximum, so a
  // malformed String from the web server cannot walk off the buffer.
  if (strnlen(ssid, WIFI_SSID_MAX) >= WIFI_SSID_MAX) return nullptr;
  return ssid;
}

const char* validPass(const char* pass) {
  if (!pass) return "";
  if (strnlen(pass, WIFI_PASS_MAX) >= WIFI_PASS_MAX) return nullptr;
  return pass;
}

}  // namespace

size_t wifiStoreLoad() {
  clearRam();

  Preferences prefs;
  if (prefs.begin(NS, true)) {
    WifiBlob blob;
    const size_t got = prefs.getBytes(KEY, &blob, sizeof blob);
    prefs.end();
    if (got == sizeof blob && blob.version == BLOB_VERSION &&
        blob.count <= WIFI_STORE_MAX) {
      for (size_t i = 0; i < blob.count; i++) {
        // The blob is data from flash, not a trusted C string: force the
        // terminator on both fields before anything calls strlen on them.
        memcpy(g_nets[i].ssid, blob.nets[i].ssid, WIFI_SSID_MAX);
        memcpy(g_nets[i].pass, blob.nets[i].pass, WIFI_PASS_MAX);
        g_nets[i].ssid[WIFI_SSID_MAX - 1] = '\0';
        g_nets[i].pass[WIFI_PASS_MAX - 1] = '\0';
        if (!g_nets[i].ssid[0]) break;   // truncated/corrupt entry
        g_count++;
      }
    }
  }

  g_loaded = true;
  return g_count;
}

size_t wifiStoreCount() {
  ensureLoaded();
  return g_count;
}

const char* wifiStoreSsid(size_t index) {
  ensureLoaded();
  return index < g_count ? g_nets[index].ssid : "";
}

const char* wifiStorePass(size_t index) {
  ensureLoaded();
  return index < g_count ? g_nets[index].pass : "";
}

bool wifiStoreSave(const char* ssid, const char* pass) {
  ssid = validSsid(ssid);
  pass = validPass(pass);
  if (!ssid || !pass) return false;

  ensureLoaded();

  WifiCred old[WIFI_STORE_MAX];
  memcpy(old, g_nets, sizeof g_nets);
  const size_t oldCount = g_count;

  WifiCred next[WIFI_STORE_MAX];
  memset(next, 0, sizeof next);

  size_t out = 0;
  copyEntry(next[out++], ssid, pass);          // newest first
  for (size_t i = 0; i < oldCount && out < WIFI_STORE_MAX; i++) {
    if (strcmp(old[i].ssid, ssid) == 0) continue;   // replace, do not duplicate
    next[out++] = old[i];
  }

  memcpy(g_nets, next, sizeof g_nets);
  g_count = out;

  if (!writeBlob()) {
    memcpy(g_nets, old, sizeof g_nets);
    g_count = oldCount;
    return false;
  }
  return true;
}

bool wifiStoreForget(const char* ssid) {
  if (!ssid || !ssid[0]) return false;
  ensureLoaded();

  WifiCred old[WIFI_STORE_MAX];
  memcpy(old, g_nets, sizeof g_nets);
  const size_t oldCount = g_count;

  WifiCred next[WIFI_STORE_MAX];
  memset(next, 0, sizeof next);

  size_t out = 0;
  bool found = false;
  for (size_t i = 0; i < oldCount; i++) {
    if (strcmp(old[i].ssid, ssid) == 0) {
      found = true;
      continue;
    }
    next[out++] = old[i];
  }
  if (!found) return false;

  memcpy(g_nets, next, sizeof g_nets);
  g_count = out;

  if (!writeBlob()) {
    memcpy(g_nets, old, sizeof g_nets);
    g_count = oldCount;
    return false;
  }
  return true;
}

bool wifiStoreClear() {
  ensureLoaded();

  WifiCred old[WIFI_STORE_MAX];
  memcpy(old, g_nets, sizeof g_nets);
  const size_t oldCount = g_count;

  clearRam();
  if (!writeBlob()) {
    memcpy(g_nets, old, sizeof g_nets);
    g_count = oldCount;
    return false;
  }
  return true;
}
