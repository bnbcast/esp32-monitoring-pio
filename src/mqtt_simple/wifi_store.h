/*
 * wifi_store.h - Wi-Fi credentials kept in NVS instead of the firmware image.
 *
 * The public repository must not contain a real SSID/password pair. The board
 * is provisioned from a phone through the setup portal (wifi_portal.h), and the
 * result is stored in the "wifi" NVS namespace so it survives a reflash of the
 * application.
 *
 * Up to WIFI_STORE_MAX networks are kept, newest first. An empty password
 * means an open network. The list is intentionally small: every extra slot is
 * another chance to join the wrong AP at a venue.
 */
#pragma once
#include <stddef.h>

#define WIFI_STORE_MAX   4
#define WIFI_SSID_MAX    33   // 32 bytes + NUL
#define WIFI_PASS_MAX    65   // 64 bytes + NUL (64 hex PSK is the longest)

// Read the list into RAM. Safe to call more than once. Returns the count.
size_t wifiStoreLoad();

// Number of saved networks. Loads the list lazily if setup did not.
size_t wifiStoreCount();

// Saved entries, newest first. Out-of-range indexes return "".
const char* wifiStoreSsid(size_t index);
const char* wifiStorePass(size_t index);

// Add or replace a network. Empty pass = open network. The new entry becomes
// the first candidate; the oldest entry is dropped when the list is full.
// Returns false when the input is invalid or the NVS write fails, and leaves
// the previous list untouched in that case.
bool wifiStoreSave(const char* ssid, const char* pass);

// Remove one network by exact SSID. Returns false when it was not saved.
bool wifiStoreForget(const char* ssid);

// Remove every saved network (used by the portal's "forget all" path).
bool wifiStoreClear();
