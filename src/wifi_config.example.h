/*
 * src/wifi_config.example.h - bench-only Wi-Fi candidates.
 *
 * The tracker does NOT use this file: credentials are provisioned from a phone
 * through the setup portal and stored in NVS (see src/mqtt_simple/wifi_store.h).
 *
 * Only the one-shot `esp32-bench` environment still reads a compiled list. If
 * you build that environment, copy this file to src/wifi_config.h and fill in
 * a network the bench is allowed to join. src/wifi_config.h is gitignored so a
 * real password never enters the public repository.
 */
#pragma once
#include <stddef.h>

struct WifiCandidate { const char* ssid; const char* pass; };

static const WifiCandidate WIFI_NETS[] = {
  { "YOUR_SSID", "YOUR_PASSWORD" },
  { "YOUR_OPEN_SSID", "" },
};
static const size_t WIFI_NET_COUNT = sizeof(WIFI_NETS) / sizeof(WIFI_NETS[0]);
