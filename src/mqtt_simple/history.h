/*
 * history.h - store-and-forward history for the race tracker.
 *
 * Live data keeps flowing over MQTT (best effort, QoS 0) exactly as before.
 * This module is a second, independent path: every frame with a usable GPS fix
 * is appended to a LittleFS ring buffer, and a background task uploads 30 s
 * batches over HTTPS. A 2xx response deletes the batch. If the network, the
 * host or the board dies, the buffer simply drains later - the live map is
 * never affected.
 *
 * Configuration lives in src/history_secret.h (gitignored):
 *
 *   #define HISTORY_URL   "https://race-tracker-history.pages.dev/ingest"
 *   #define HISTORY_KEY   "<the X-Ingest-Key value>"
 *   #define HISTORY_DEVICE "esp32-01"
 *
 * Without that file the module compiles to a no-op, so a fresh clone builds.
 * Run `node dev/gen-history-secret.mjs` to create it from the key file.
 */
#pragma once

#include <Arduino.h>

struct HistoryFix {
  uint32_t seq;
  uint32_t ts;      // GPS epoch, seconds
  uint32_t up;      // seconds since boot
  uint16_t boot;
  float lat, lng;
  float alt, kmh, cog, hdop, dist_m;
  uint8_t sats;
};

struct HistoryStats {
  uint32_t queued;      // accepted into the queue
  uint32_t dropped;     // queue full, frame discarded
  uint32_t written;     // frames flushed to LittleFS
  uint32_t batches;     // upload attempts
  uint32_t acked;       // frames confirmed by the server
  uint32_t failed;      // upload attempts that did not get 2xx
  uint32_t bytes;       // current ring buffer size
  int      lastStatus;  // HTTP status of the last attempt (0 = never)
};

// 0 = info, 1 = ok, 2 = warn, 3 = error.
typedef void (*HistoryLogFn)(int level, const char* msg);

void historySetLogger(HistoryLogFn fn);
void historyBegin();
bool historyEnabled();
bool historyEnqueue(const HistoryFix& f);
HistoryStats historyStats();

// Queues a few synthetic frames (fixed position, "moving" so the server keeps
// every one). Only available in a -DHISTORY_SELFTEST build, where the build
// script bakes in a fresh epoch; proves queue -> flash -> TLS -> ack without a
// GPS fix. Returns false when the build or the module is not ready.
bool historySelfTest();
