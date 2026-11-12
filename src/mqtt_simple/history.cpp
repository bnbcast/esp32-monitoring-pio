/*
 * history.cpp - LittleFS ring buffer + 30 s HTTPS batch upload.
 *
 * Threading: the main loop only pushes a small POD struct into a FreeRTOS
 * queue. One background task on core 0 owns LittleFS and the TLS client, so
 * there is never a second accessor of the file and no mutex is needed. That is
 * the whole reason this is easy to reason about: one writer, one reader, same
 * thread.
 *
 * Durability chain:
 *   RAM buffer -> LittleFS (flushed at most every 10 s)
 *   LittleFS   -> HTTPS batch (40 frames / 8 KB, every 30 s)
 *   HTTPS 2xx  -> byte offset advanced, persisted to /hist.off
 *
 * A crash between upload and offset write re-sends one batch; the server's
 * INSERT OR IGNORE plus its (boot, seq) duplicate check make that harmless.
 */

#include "history.h"

#include <LittleFS.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>

// Optional: a fresh clone has no secret file and history stays disabled.
#if __has_include("../history_secret.h")
#include "../history_secret.h"
#endif
#ifndef HISTORY_URL
#define HISTORY_URL ""
#endif
#ifndef HISTORY_KEY
#define HISTORY_KEY ""
#endif
#ifndef HISTORY_DEVICE
#define HISTORY_DEVICE "esp32-01"
#endif
#if __has_include("../history_secret.h")
#define HISTORY_ENABLED 1
#else
#define HISTORY_ENABLED 0
#endif

namespace {

const char* PATH     = "/hist.ndjson";
const char* PATH_OFF = "/hist.off";
const char* PATH_TMP = "/hist.tmp";

// 512 KB is ~3400 compact frames (~1 hour of 1 Hz driving). The ring drops the
// oldest half, so an outage longer than that loses the oldest history, never
// the newest.
const size_t MAX_FILE_BYTES = 512 * 1024;
const size_t KEEP_BYTES     = 256 * 1024;

const size_t   MAX_BODY_BYTES = 8 * 1024;
const uint16_t MAX_LINES      = 40;
const uint32_t FLUSH_MS       = 10000;
const uint32_t SEND_MS        = 30000;
const uint32_t MIN_FREE_HEAP  = 90000;   // TLS needs ~43 KB plus headroom
const int      TASK_STACK     = 12288;
const uint8_t  QUEUE_DEPTH    = 64;

QueueHandle_t   queue = nullptr;
HistoryLogFn    logger = nullptr;
HistoryStats    stats = {};
uint32_t        offset = 0;        // first byte not yet acknowledged
String          pending;           // complete NDJSON lines not yet on flash
uint32_t        pendingLines = 0;
uint32_t        lastFlushMs = 0;
uint32_t        lastCompactMs = 0;
uint32_t        lastWarnMs = 0;
char            host[96];
char            path[64];
bool            started = false;

void logf(int level, const char* fmt, ...) {
  if (!logger) return;
  char msg[192];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  logger(level, msg);
}

bool parseUrl(const char* url) {
  const char* p = strstr(url, "://");
  if (!p) return false;
  p += 3;
  const char* slash = strchr(p, '/');
  size_t hl = slash ? (size_t)(slash - p) : strlen(p);
  if (hl == 0 || hl >= sizeof host) return false;
  memcpy(host, p, hl);
  host[hl] = '\0';
  if (slash && slash[1] != '\0') {
    strncpy(path, slash, sizeof path - 1);
    path[sizeof path - 1] = '\0';
  } else {
    strcpy(path, "/ingest");           // bare host means "the ingest endpoint"
  }
  return true;
}

void saveOffset() {
  File f = LittleFS.open(PATH_OFF, "w");
  if (!f) return;
  f.printf("%lu\n", (unsigned long)offset);
  f.close();
}

void loadOffset() {
  offset = 0;
  File f = LittleFS.open(PATH_OFF, "r");
  if (!f) return;
  String s = f.readStringUntil('\n');
  f.close();
  s.trim();
  if (s.length() && s.length() < 12) {
    uint32_t v = (uint32_t)strtoul(s.c_str(), nullptr, 10);
    if (v != 0) offset = v;
  }
}

size_t fileSize() {
  File f = LittleFS.open(PATH, "r");
  if (!f) return 0;
  size_t n = f.size();
  f.close();
  return n;
}

// Move the surviving bytes [from, end) to a fresh file, so the buffer never
// grows past MAX_FILE_BYTES and the offset file stays small.
bool compactFrom(size_t from) {
  File in = LittleFS.open(PATH, "r");
  if (!in) return false;
  if (from >= in.size()) { in.close(); LittleFS.remove(PATH); return true; }
  in.seek(from);

  File out = LittleFS.open(PATH_TMP, "w");
  if (!out) { in.close(); return false; }

  uint8_t buf[1024];
  size_t copied = 0;
  while (in.available()) {
    size_t n = in.read(buf, sizeof buf);
    if (n == 0) break;
    if (out.write(buf, n) != n) break;
    copied += n;
  }
  in.close();
  out.close();
  if (copied == 0) { LittleFS.remove(PATH_TMP); return false; }

  LittleFS.remove(PATH);
  if (!LittleFS.rename(PATH_TMP, PATH)) return false;
  offset = 0;
  saveOffset();
  stats.bytes = fileSize();
  return true;
}

// Append the RAM buffer to flash in one write. Complete lines only, so a
// power cut can never leave a half-written record in the middle of the file.
bool flushPending() {
  lastFlushMs = millis();
  if (pending.length() == 0) return true;

  File f = LittleFS.open(PATH, FILE_APPEND);
  if (!f) {
    logf(3, "LittleFS append failed (%u B held in RAM)", (unsigned)pending.length());
    return false;
  }
  size_t wrote = f.write((const uint8_t*)pending.c_str(), pending.length());
  f.close();

  if (wrote != pending.length()) {
    // Treat a short write as a lost tail rather than retrying a partial record.
    logf(3, "short write %u/%u B", (unsigned)wrote, (unsigned)pending.length());
    stats.failed++;
    pending = "";
    pendingLines = 0;
    return false;
  }
  stats.written += pendingLines;
  pending = "";
  pendingLines = 0;
  stats.bytes = fileSize();
  return true;
}

// One HTTP round trip. Returns the status code, or a negative value.
int post(const String& body, String& reply) {
  WiFiClientSecure client;
  client.setHandshakeTimeout(8);
  client.useBuiltinCACertBundle();

  uint32_t t0 = millis();
  if (!client.connect(host, 443)) {
    logf(2, "TLS connect failed to %s", host);
    client.stop();
    return -1;
  }

  client.printf("POST %s HTTP/1.1\r\n", path);
  client.printf("Host: %s\r\n", host);
  client.print("Content-Type: application/json\r\n");
  client.printf("X-Ingest-Key: %s\r\n", HISTORY_KEY);
  client.printf("Content-Length: %u\r\n", (unsigned)body.length());
  client.print("Connection: close\r\n\r\n");
  client.write((const uint8_t*)body.c_str(), body.length());

  // Status line
  unsigned long wait = millis();
  while (!client.available() && client.connected() && millis() - wait < 10000) delay(10);
  String line = client.readStringUntil('\n');
  int code = -1;
  int sp = line.indexOf(' ');
  if (sp > 0) code = line.substring(sp + 1).toInt();

  // Small body (a few hundred bytes) for the serial log; stop at 300 chars.
  reply = "";
  unsigned long rd = millis();
  while (millis() - rd < 5000) {
    while (client.available()) {
      int c = client.read();
      if (c < 0) break;
      if (reply.length() < 300) reply += (char)c;
    }
    if (!client.connected() && !client.available()) break;
    delay(5);
  }
  client.stop();

  uint32_t dt = millis() - t0;
  logf(code >= 200 && code < 300 ? 1 : 2, "POST %s -> %d in %lums", path, code, (unsigned long)dt);
  return code;
}

// Read at most MAX_LINES / MAX_BODY_BYTES from `offset` and upload them.
void sendBatch() {
  if (!started) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (ESP.getFreeHeap() < MIN_FREE_HEAP) {
    if (millis() - lastWarnMs > 60000) {
      lastWarnMs = millis();
      logf(2, "low heap (%u B), upload deferred", (unsigned)ESP.getFreeHeap());
    }
    return;
  }

  flushPending();

  File f = LittleFS.open(PATH, "r");
  if (!f) return;
  size_t size = f.size();
  if (size == 0 || offset >= size) {
    f.close();
    // Everything before `offset` is gone (acked or compacted): start over.
    if (offset != 0) { offset = 0; saveOffset(); }
    stats.bytes = size;
    return;
  }
  f.seek(offset);

  String body;
  body.reserve(MAX_BODY_BYTES + 256);
  body = "{\"device\":\"";
  body += HISTORY_DEVICE;
  body += "\",\"frames\":[";

  char line[320];
  size_t len = 0;
  size_t pos = offset;      // byte offset of the line being read
  size_t endOff = offset;   // byte offset after the last good line
  uint16_t lines = 0;
  bool corrupt = false;

  while (lines < MAX_LINES && body.length() < MAX_BODY_BYTES) {
    int c = f.read();
    if (c < 0) { if (len) corrupt = true; break; }   // partial tail
    pos++;
    if (c == '\n') {
      if (len >= 2 && line[0] == '{' && line[len - 1] == '}') {
        if (lines) body += ',';
        for (size_t i = 0; i < len; i++) body += line[i];
        lines++;
        endOff = pos;
      } else if (len > 0) {
        corrupt = true;                              // not a JSON object
        break;
      } else {
        endOff = pos;                                // blank line
      }
      len = 0;
    } else if (c != '\r') {
      if (len < sizeof line - 1) line[len++] = (char)c;
      else { corrupt = true; break; }
    }
  }
  f.close();

  if (lines == 0) {
    if (corrupt) {
      // A partial/corrupt record is only ever the tail; there is nothing worth
      // keeping behind it.
      logf(2, "dropping corrupt tail (%u B) at offset %u",
           (unsigned)(size - offset), (unsigned)offset);
      offset = 0;
      LittleFS.remove(PATH);
      saveOffset();
      stats.bytes = 0;
    }
    return;
  }

  body += "]}";

  stats.batches++;
  String reply;
  int code = post(body, reply);
  stats.lastStatus = code;

  if (code >= 200 && code < 300) {
    offset = endOff;
    if (offset >= size) {
      // Everything is acknowledged: start clean.
      LittleFS.remove(PATH);
      offset = 0;
    }
    saveOffset();
    stats.acked += lines;
    stats.bytes = fileSize();
    logf(1, "%u frames acked, queue %u B", (unsigned)lines, (unsigned)stats.bytes);
    if (reply.length()) {
      String head = reply;
      head.replace("\n", " ");
      if (head.length() > 120) head = head.substring(0, 120);
      logf(0, "server: %s", head.c_str());
    } else {
      logf(0, "server: empty reply");
    }
    // Corruption behind an acked batch is handled on the next pass.
    if (fileSize() > MAX_FILE_BYTES) compactFrom(offset > KEEP_BYTES ? offset : KEEP_BYTES);
  } else {
    stats.failed++;
    logf(2, "batch of %u not accepted (%d), will retry", (unsigned)lines, code);
  }
}

void task(void*) {
  uint32_t lastSend = millis() - SEND_MS;    // try immediately if data survived a reboot
#if defined(HISTORY_SELFTEST) && HISTORY_SELFTEST
  bool selfTestDone = false;
#endif
  for (;;) {
    HistoryFix f;
    if (xQueueReceive(queue, &f, pdMS_TO_TICKS(500)) == pdTRUE) {
      char line[320];
      int n = snprintf(line, sizeof line,
        "{\"seq\":%lu,\"ts\":%lu,\"up\":%lu,\"boot\":%u,\"fix\":true,"
        "\"lat\":%.6f,\"lng\":%.6f,\"alt\":%.0f,\"kmh\":%.1f,\"cog\":%.1f,"
        "\"hdop\":%.2f,\"sats\":%u,\"dist_m\":%.1f,"
        "\"roll\":%.1f,\"pitch\":%.1f,\"lap_n\":%lu,\"lap_last_ms\":%lu,\"lap_best_ms\":%lu}\n",
        (unsigned long)f.seq, (unsigned long)f.ts, (unsigned long)f.up,
        (unsigned)f.boot, f.lat, f.lng, f.alt, f.kmh, f.cog,
        f.hdop, (unsigned)f.sats, f.dist_m,
        f.roll, f.pitch,
        (unsigned long)f.lap_n, (unsigned long)f.lap_last_ms, (unsigned long)f.lap_best_ms);
      if (n > 0 && n < (int)sizeof line) {
        pending += line;
        pendingLines++;
        stats.queued++;
      }
    }

    uint32_t now = millis();
    if (pending.length() && now - lastFlushMs >= FLUSH_MS) flushPending();

#if defined(HISTORY_SELFTEST) && HISTORY_SELFTEST
    // Test builds inject once, after the link is up, so a serial capture is
    // enough to prove the whole path; 't' on the console repeats it.
    if (!selfTestDone && now > 15000 && WiFi.status() == WL_CONNECTED) {
      selfTestDone = true;
      if (historySelfTest()) logf(1, "self-test: 3 synthetic frames queued");
    }
#endif

    // Keep the file bounded even while the host is unreachable. Throttled so a
    // failing compaction cannot rewrite flash every 500 ms.
    if (stats.bytes > MAX_FILE_BYTES && now - lastCompactMs >= 60000) {
      lastCompactMs = now;
      compactFrom(offset > KEEP_BYTES ? offset : KEEP_BYTES);
      stats.bytes = fileSize();
    }

    if (now - lastSend >= SEND_MS) {
      lastSend = now;
      sendBatch();
    }
  }
}

}  // namespace

void historySetLogger(HistoryLogFn fn) { logger = fn; }

bool historyEnabled() { return HISTORY_ENABLED != 0 && started; }

void historyBegin() {
#if HISTORY_ENABLED
  if (!parseUrl(HISTORY_URL)) {
    logf(3, "history: bad HISTORY_URL, history disabled");
    return;
  }
  if (!LittleFS.begin(true)) {
    logf(3, "history: LittleFS mount failed, history disabled");
    return;
  }
  loadOffset();
  pending.reserve(2048);

  queue = xQueueCreate(QUEUE_DEPTH, sizeof(HistoryFix));
  if (!queue) {
    logf(3, "history: queue alloc failed, history disabled");
    return;
  }
  if (xTaskCreatePinnedToCore(task, "history", TASK_STACK, nullptr, 1, nullptr, 0) != pdPASS) {
    logf(3, "history: task alloc failed, history disabled");
    return;
  }
  started = true;

  size_t size = fileSize();
  stats.bytes = size;
  logf(1, "history ready: %s%s, %u B buffered, offset %u",
       host, path, (unsigned)size, (unsigned)offset);
#else
  logf(0, "history disabled (no src/history_secret.h)");
#endif
}

bool historyEnqueue(const HistoryFix& f) {
  if (!started || !queue) return false;
  if (xQueueSend(queue, &f, 0) != pdTRUE) {
    stats.dropped++;
    return false;
  }
  return true;
}

HistoryStats historyStats() { return stats; }

bool historySelfTest() {
#if defined(HISTORY_SELFTEST) && HISTORY_SELFTEST && defined(HISTORY_SELFTEST_EPOCH)
  if (!started) return false;
  for (uint16_t i = 0; i < 3; i++) {
    HistoryFix f = {};
    f.seq  = 990000u + i;
    f.ts   = HISTORY_SELFTEST_EPOCH + i;
    f.up   = (uint32_t)(millis() / 1000);
    f.boot = 0x00EE;
    f.lat  = -6.9123f;
    f.lng  = 107.6098f;
    f.alt  = 750.0f;
    f.kmh  = 20.0f;            // "moving", so the server stores every frame
    f.cog  = 90.0f;
    f.hdop = 0.80f;
    f.sats = 9;
    f.dist_m = 10.0f;
    if (!historyEnqueue(f)) return false;
  }
  return true;
#else
  return false;
#endif
}
