/*
 * src/wifi_config.h - Wi-Fi candidates shared by the tracker and bench builds.
 *
 * Tried in order against what the ESP32 can see; the first visible one wins.
 * Exact SSID match first, then prefix match ("ESP32_AP2" matches "ESP32").
 * Empty password means an open AP.
 *
 * The venue hotspot is not chosen yet, so the bench build uses the same list
 * as production instead of hardcoding a second copy.
 */
#pragma once
#include <stddef.h>

struct WifiCandidate { const char* ssid; const char* pass; };

static const WifiCandidate WIFI_NETS[] = {
  { "Gi Joe",  "arduino1234" },
  { "ESP32",   "" },
};
static const size_t WIFI_NET_COUNT = sizeof(WIFI_NETS) / sizeof(WIFI_NETS[0]);
