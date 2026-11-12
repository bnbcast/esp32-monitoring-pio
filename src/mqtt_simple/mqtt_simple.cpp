/*
 * mqtt_simple.cpp — ESP32 sensor dashboard publishing to MQTT broker
 * Source: secret.txt (GitHub bnbcast/esp32-monitoring)
 *
 * The ESP32 joins Wi-Fi and publishes sensor readings to a public MQTT broker.
 * Topics: esp32-dash/<TOPIC_KEY>/data, esp32-dash/<TOPIC_KEY>/status
 *
 * Build: pio run -e esp32-mqtt-simple
 */

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <TinyGPSPlus.h>
#include <Wire.h>
#include <Preferences.h>
#include <esp_system.h>
#include <stdarg.h>

// History store-and-forward (LittleFS + HTTPS batch). Compiled to a no-op when
// src/history_secret.h is absent, so a fresh clone still builds.
#include "history.h"

// The task watchdog is the difference between "the board is stuck" and "the
// board rebooted itself and said so". Guarded so the sketch still builds on a
// core that does not ship it.
#if __has_include(<esp_task_wdt.h>)
#include <esp_task_wdt.h>
#include <esp_idf_version.h>
#define HAVE_TASK_WDT 1
#else
#define HAVE_TASK_WDT 0
#endif

// ============ NETWORK (EDIT THESE) ============
// Shared with src/bench so the measurement build joins the same APs.
#include "../wifi_config.h"

#define MQTT_HOST     "broker.hivemq.com"
#define MQTT_PORT     1883

// Random key that makes your topic unguessable. Anyone who knows it can watch.
// Generate a new one if you ever want to "rotate the lock".
// One readable default, shared with web/ui/app.js. The old random hex key was
// never secret (it ships in public JS), and it forced every user to edit two
// files. Open the dashboard with #t=<slug> to run a second tracker.
#define TOPIC_KEY     "race-tracker"
#define TOPIC_DATA    "esp32-dash/" TOPIC_KEY "/data"
#define TOPIC_STATUS  "esp32-dash/" TOPIC_KEY "/status"

// 1 Hz is enough for a race tracker and halves broker traffic, log volume and
// the power draw compared with the old 500 ms cadence.
#define PUBLISH_INTERVAL_MS 1000

// ============ IDENTITY ============
#define FW_NAME     "esp32-dash"
#define FW_VERSION  "1.3.0"

// ============ SERIAL CONSOLE ============
// One framed panel every DASH_INTERVAL_MS plus event lines as they happen.
// Keys: g raw NMEA echo | v verbose | c colours | p panel | ? help
//       d LED self-test | y invert LED polarity | a/b lap gates | x reboot
#define ANSI_RESET  "\033[0m"
#define ANSI_BOLD   "\033[1m"
#define ANSI_DIM    "\033[2m"
#define ANSI_RED    "\033[31m"
#define ANSI_GRN    "\033[32m"
#define ANSI_YEL    "\033[33m"
#define ANSI_CYN    "\033[36m"
#define ANSI_MAG    "\033[35m"

// ---- reliability tuning -----------------------------------------------
#define MQTT_KEEPALIVE_S      15      // broker ping period
#define MQTT_SOCKET_TIMEOUT_S 3       // per-attempt socket timeout
#define MQTT_BACKOFF_MIN_MS   2000UL  // first retry delay
#define MQTT_BACKOFF_MAX_MS   30000UL // cap for exponential backoff
#define MQTT_WATCHDOG_MS      20000UL // connected but nothing delivered -> reconnect
#define WIFI_RETRY_MS         10000UL // retry pause when idle
#define WIFI_CONNECT_TIMEOUT  15000UL // give up one association attempt after this

// Publishes that fail are kept here and re-sent, oldest first, as soon as the
// broker is reachable again. 3 x 1 KB is ~3 KB of static RAM.
#define TXQ_SLOTS 3
#define TXQ_LEN   1024

// GPS sanity gates (a "fix" below these is not worth publishing as a position)
#define GPS_MIN_SATS  5
// HDOP 20 is roughly a 100 m error circle. 4.0 still passes a normal race
// track (the healthy log showed 0.7-0.8) and rejects the multipath garbage
// that made the marker wander indoors.
#define GPS_MAX_HDOP  4.0
#define GPS_MAX_KMH   200.0          // anything faster is a bad frame, not a vehicle

// Shadow gate for the "tighten to HDOP 2 / 6 sats" proposal. It never decides
// what is published: it only counts the fixes the stricter threshold would
// drop, so one track session can answer the question with numbers instead of
// opinion. See the POS line and the 2.0-vs-4.0 note in docs/PLAN.md.
#define GPS_STRICT_SATS 6
#define GPS_STRICT_HDOP 2.0

// A 2D fix (no altitude) has no vertical constraint, so its horizontal error
// is several times worse than HDOP suggests. Only 3D fixes are published.
#define GPS_REQUIRE_3D 1

// Parked hold. Below 1 km/h the receiver reports micro-movement from multipath:
// the module itself says "0 km/h" but its coordinates still wander tens of
// metres. While that is true the published position is frozen, and it only
// moves again when the fix has genuinely travelled GPS_HOLD_MOVE_M.
#define GPS_STILL_KMH     1.0f
#define GPS_HOLD_MOVE_M   8.0f

// Odometer gates: distance is only counted while the module itself reports
// motion, and a single fix may not imply more than the frame limit allows.
// The step floor is measured from an anchor fix, not from the previous fix, so
// it keeps working at 5 Hz: at 1 Hz a 10 km/h car moves 2.8 m per fix, at 5 Hz
// only 0.55 m, and a per-fix floor would have stopped counting below 36 km/h.
#define GPS_ODO_MIN_KMH    3.0f
#define GPS_ODO_MIN_STEP_M 2.0f   // anchor-to-fix distance that beats jitter
#define GPS_ODO_SLACK_M    10.0f  // allowed beyond speed x time (position noise)
#define GPS_ODO_MAX_STEP_M 60.0f  // hard ceiling, still 216 km/h at 1 Hz
// Lifetime total: gpsDistTotalM lives in RAM, so a reboot used to reset the
// number the dashboard calls dist_m. One NVS write per 500 m costs nothing
// (a 100 km day is 200 writes) and bounds the loss to half a kilometre.
#define ODO_SAVE_STEP_M    500.0f

// Physical plausibility clamps
#define GYRO_MAX_DPS  500.0f         // MPU6050 configured range is +-500 dps

// GPS privacy: decimals published for latitude/longitude.
//   2 = about 1.1 km accuracy   5 = about 1.1 m   6 = about 0.11 m (exact)
//  -1 = never publish coordinates (only fix status, satellites, altitude, speed)
#define GPS_DECIMALS  6

// ============ MODE ============
#define VIEWER_MODE 0

// ============ PINS ============
#define I2C_SDA_PIN   21
#define I2C_SCL_PIN   22
#define GPS_RX_PIN    25
// GPS module RX: needed to push UBX configuration (5 Hz, automotive, static
// hold, SBAS) into the NEO-6M. With the pin unwired the config simply never
// answers, the firmware falls back to 9600 8N1 and everything still works.
#define GPS_TX_PIN    33
#define LED_BLUE_PIN  26
#define LED_WHITE_PIN 27
#define LED_RED_PIN   32

// ============ SETTINGS ============
#define SEND_INTERVAL_MS 20       // viewer mode: 50 updates per second
#define DASH_INTERVAL_MS 2000     // serial status line every 2 seconds
#define ALPHA 0.98f               // tilt filter: gyro 98%, accelerometer 2%

#define WARN_ANGLE   30.0f        // degrees (the website reads these from the data)
#define DANGER_ANGLE 50.0f
#define HYSTERESIS   2.0f

// ---- GPS link + u-blox configuration -----------------------------------
#define GPS_BAUD         9600     // NEO-6M power-on default
#define GPS_BAUD_FAST    38400    // enough headroom for 5 Hz NMEA
#define GPS_BAUD_ALT     115200   // a module configured by u-center may be here
#define GPS_NAV_HZ       5        // nav solution rate once configured
#define GPS_UBX_ENABLE   1        // only runs when a module answers on GPS_TX_PIN

// ---- finish line --------------------------------------------------------
// The gate is stored as two points; a lap counts when the segment between two
// consecutive fixes crosses A->B in the forward direction.
#define LAP_MIN_MS       3000UL   // ignore re-crossings closer than this
#define LAP_MIN_KMH      5.0f     // a lap cannot be walked across the line

// ============ GLOBALS ============
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);
WiFiClient netClient;
PubSubClient mqtt(netClient);

char clientId[32];
unsigned long lastWifiTry = 0;
unsigned long lastMqttTry = 0;
unsigned long lastPublish = 0;
unsigned long lastPublishOk = 0;
unsigned long lastStatusLog = 0;
unsigned long bootMillis = 0;

// MQTT backoff state
unsigned long mqttBackoff = MQTT_BACKOFF_MIN_MS;
bool mqttWasConnected = false;

// Delivery counters (shown on the serial status line)
uint32_t txSeq = 0, txOk = 0, txFail = 0, txDrop = 0;

// Wi-Fi non-blocking state machine
enum WifiPhase { WF_IDLE, WF_SCANNING, WF_CONNECTING };
WifiPhase wifiPhase = WF_IDLE;
unsigned long wifiPhaseSince = 0;
int8_t lastGoodNet = -1;        // index into WIFI_NETS of the last working AP

// Pending publish ring (oldest at txqHead)
static char txq[TXQ_SLOTS][TXQ_LEN];
static uint8_t txqHead = 0, txqCount = 0;

uint8_t MPU_ADDR = 0x68;
bool mpuValid = false;
unsigned long lastRetry = 0;

float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;
float roll = 0, pitch = 0, yaw = 0, tilt = 0;
float lax = 0, lay = 0, laz = 0, lt = 0;
unsigned long lastMicros = 0;
unsigned long lastSend = 0;
unsigned long lastDash = 0;
int level = 0;

float maxTilt = 0;

// GPS odometer (device-side cumulative distance). The anchor is the last fix
// whose distance was actually counted; it is what the 2 m jitter floor uses.
float gpsDistTotalM = 0;
bool gpsOdoHasAnchor = false;
float gpsOdoLat = 0, gpsOdoLng = 0;
uint32_t gpsOdoMs = 0;

// ---- GPS position conditioning -----------------------------------------
// last accepted fix (used by the jump gate and the lap interpolator)
bool  fixHasPrev = false;
float fixPrevLat = 0, fixPrevLng = 0;
uint32_t fixPrevMs = 0;

// parked hold: while the module reports < 1 km/h the published coordinate is
// frozen here, so multipath wander never reaches the map
bool  holdValid = false;
float holdLat = 0, holdLng = 0;

uint32_t gpsRejected = 0;       // fixes dropped by the jump gate
uint32_t gpsFixesAccepted = 0;  // fixes that passed the 5/4.0 gate
uint32_t gpsStrictReject = 0;   // of those, how many fail a 6/2.0 gate (diagnostic only)
uint32_t gpsTtffMs = 0;         // time to first usable fix after boot

// ---- finish line --------------------------------------------------------
bool     gateValid = false;
double   gateALat = 0, gateALng = 0, gateBLat = 0, gateBLng = 0;
uint32_t lapCount = 0, lapLastMs = 0, lapBestMs = 0;
uint32_t lapCrossMs = 0;        // interpolated time of the last crossing
static void lapSaveCounters();  // defined with the NVS gate storage below

// Uptime diagnostics. minFreeHeap catches a slow leak long before the board
// actually runs out. bootCount must survive a reset to make a reboot loop
// visible from the dashboard. RTC_DATA_ATTR looked like the obvious home, but
// on a normal (non deep-sleep) reset the runtime initialises that section
// again: every boot reported 1, so the diagnostic could never fire. NVS is the
// durable store this board already has, and one write per boot is nothing.
uint32_t bootCount = 1;
uint32_t minFreeHeap = 0xFFFFFFFFu;

static uint32_t bootCountInit() {
  Preferences prefs;
  if (!prefs.begin("sys", false)) return bootCount;
  bootCount = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", bootCount);
  prefs.end();
  return bootCount;
}

// Lifetime odometer. gpsDistTotalM is RAM only, so every reboot used to reset
// the number the dashboard shows as dist_m. Restore it at boot and write it
// back every ODO_SAVE_STEP_M; a half kilometre of loss per reboot is worth not
// burning flash cycles on every fix.
float odoSavedM = 0.0f;

static void odoLoad() {
  Preferences prefs;
  if (!prefs.begin("odo", true)) return;
  const float m = prefs.getFloat("m", 0.0f);
  prefs.end();
  // Reject junk rather than publish a 4-million-kilometre lifetime.
  if (m > 0.0f && m < 1.0e7f) {
    gpsDistTotalM = m;
    odoSavedM = m;
  }
}

static void odoSaveIfNeeded() {
  if (fabsf(gpsDistTotalM - odoSavedM) < ODO_SAVE_STEP_M) return;
  Preferences prefs;
  if (!prefs.begin("odo", false)) return;
  prefs.putFloat("m", gpsDistTotalM);
  prefs.end();
  odoSavedM = gpsDistTotalM;
}

// A hang in Wi-Fi/MQTT used to be silent: the board stayed powered, published
// nothing and looked offline until somebody power-cycled it. 30 s is
// deliberately generous so a slow broker retry cannot trip it; the watchdog is
// there to catch a genuine deadlock, not to police jitter.
#define WDT_TIMEOUT_S   30
// Below this the next allocation is likely to fail. Logged once per boot so a
// long uptime run produces one clear warning instead of a flood.
#define HEAP_WARN_BYTES 40000UL
static bool heapWarned = false;

// ============ SERIAL CONSOLE ============
// Every event is one greppable line: "<up-time> <level> [TAG] message".
// Static flags are toggled from the monitor with single keys (see helpText()).
static bool useColor  = true;    // 'c'
static bool showNmea  = true;    // 'g' raw NMEA echo
static bool verbose   = false;   // 'v'
static bool showPanel = true;    // 'p'

enum LogLvl { L_DBG, L_INFO, L_OK, L_WARN, L_ERR };

static const char* lvlColor(LogLvl l) {
  if (!useColor) return "";
  switch (l) {
    case L_OK:   return ANSI_GRN;
    case L_WARN: return ANSI_YEL;
    case L_ERR:  return ANSI_RED;
    case L_DBG:  return ANSI_DIM;
    default:     return ANSI_CYN;
  }
}

static const char* lvlName(LogLvl l) {
  switch (l) {
    case L_OK:   return "OK  ";
    case L_WARN: return "WARN";
    case L_ERR:  return "ERR ";
    case L_DBG:  return "dbg ";
    default:     return "info";
  }
}

// "00:02:14.384" from boot. Monotonic, so log files sort without a clock.
static void stamp(char* out, size_t n) {
  unsigned long ms = millis();
  snprintf(out, n, "%02lu:%02lu:%02lu.%03lu",
           ms / 3600000UL, (ms / 60000UL) % 60UL, (ms / 1000UL) % 60UL, ms % 1000UL);
}

static void logMsg(LogLvl lvl, const char* tag, const char* fmt, ...) {
  char msg[192];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);

  char up[24];
  stamp(up, sizeof up);
  Serial.printf("%s[%s]%s %s%s%s %s%-4s%s %s\n",
                useColor ? ANSI_DIM : "", up, useColor ? ANSI_RESET : "",
                lvlColor(lvl), lvlName(lvl), useColor ? ANSI_RESET : "",
                useColor ? ANSI_BOLD : "", tag, useColor ? ANSI_RESET : "",
                msg);
}

// The history task logs through this shim so every line keeps the same
// timestamp/tag format as the rest of the console.
void histLog(int lvl, const char* msg) {
  LogLvl l = (lvl >= 3) ? L_ERR : (lvl == 2) ? L_WARN : (lvl == 1) ? L_OK : L_INFO;
  logMsg(l, "HIST", "%s", msg);
}

// ============ RAW NMEA TAP ============
// TinyGPSPlus only exposes sanitised GGA/GSA/RMC fields, so on its own it cannot
// tell "the antenna hears nothing" from "it hears satellites but will not lock".
// This tap keeps the sentence stream itself: per-type counters, checksum
// failures, GSV satellites-in-view and the best SNR of each GSV cycle.
struct GpsMon {
  char     line[128];
  uint8_t  len;
  bool     active;
  bool     overflow;
  uint32_t sentences, bad, cGGA, cRMC, cGSA, cGSV, cOther;
  int      view;      // GSV field 3: satellites in view (-1 = no GSV yet)
  int      snr;       // GSV field 7: best SNR of the last completed cycle
  int      snrCycle;  // peak SNR inside the cycle that is still arriving
  int      fixQ;      // GGA field 6: 0 none, 1 GPS, 2 DGPS
  int      fixMode;   // GSA field 2: 1 no fix, 2 = 2D, 3 = 3D
  uint32_t lastMs;    // last complete sentence
  char     lastType[6];
  bool     silent;    // silence warning already printed
};

static GpsMon gm;

static int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

// Copy comma field n (1 = first field after the sentence name) into out.
// A valid but empty field yields "": that is itself a meaningful NMEA result.
static bool nmeaField(const char* s, int n, char* out, size_t outLen) {
  const char* p = (*s == '$') ? s + 1 : s;
  while (*p && *p != ',') p++;            // skip the sentence name
  if (*p != ',') return false;
  p++;
  int idx = 0;
  while (*p && idx < n) {
    const char* start = p;
    while (*p && *p != ',' && *p != '*') p++;
    if (++idx == n) {
      size_t len = (size_t)(p - start);
      if (len >= outLen) len = outLen - 1;
      memcpy(out, start, len);
      out[len] = '\0';
      return true;
    }
    if (*p == ',') p++;
    else return false;
  }
  return false;
}

static void gpsMonParse() {
  gm.sentences++;
  gm.lastMs = millis();

  // Terminate before anything reads gm.line as a C string, otherwise the tail
  // of a previously longer sentence leaks into this one (and into nmeaField()).
  gm.line[gm.len] = '\0';

  if (gm.overflow || gm.len < 7 || gm.line[0] != '$') { gm.bad++; return; }

  int star = -1;
  for (int i = 1; i < gm.len; i++) if (gm.line[i] == '*') { star = i; break; }

  bool ok = false;
  if (star > 0 && star + 3 <= gm.len) {
    uint8_t sum = 0;
    for (int i = 1; i < star; i++) sum ^= (uint8_t)gm.line[i];
    int hi = hexVal(gm.line[star + 1]);
    int lo = hexVal(gm.line[star + 2]);
    ok = (hi >= 0 && lo >= 0 && (uint8_t)((hi << 4) | lo) == sum);
  }
  if (!ok) gm.bad++;

  char type[6];
  memcpy(type, gm.line + 1, 5);
  type[5] = '\0';
  memcpy(gm.lastType, type, sizeof type);

  const char* kind = type + 2;            // "GPGGA"/"GNGGA" -> "GGA"

  char f[16];
  char note[72];
  note[0] = '\0';

  if (!strcmp(kind, "GGA")) {
    gm.cGGA++;
    if (nmeaField(gm.line, 6, f, sizeof f) && f[0]) gm.fixQ = atoi(f);
    snprintf(note, sizeof note, "q=%d used=%d", gm.fixQ, (int)gps.satellites.value());
  } else if (!strcmp(kind, "GSV")) {
    gm.cGSV++;
    // Field 2 == 1 starts a new GSV cycle: publish the previous cycle's peak so
    // the value does not flicker back to 0 every second.
    if (nmeaField(gm.line, 2, f, sizeof f) && f[0] == '1' && f[1] == '\0') {
      if (gm.snrCycle > 0) gm.snr = gm.snrCycle;
      gm.snrCycle = 0;
    }
    if (nmeaField(gm.line, 3, f, sizeof f) && f[0]) {
      gm.view = atoi(f);
      if (gm.view == 0) gm.snr = 0;      // nothing in view, nothing to report
    }
    if (nmeaField(gm.line, 7, f, sizeof f) && f[0]) {
      int s = atoi(f);
      if (s > gm.snrCycle) gm.snrCycle = s;
    }
    snprintf(note, sizeof note, "in view=%d snr=%d", gm.view,
             gm.snrCycle > 0 ? gm.snrCycle : gm.snr);
  } else if (!strcmp(kind, "RMC")) {
    gm.cRMC++;
    char st[8] = "?", dt[16] = "?";
    nmeaField(gm.line, 2, st, sizeof st);
    nmeaField(gm.line, 9, dt, sizeof dt);
    snprintf(note, sizeof note, "status=%s date=%s", st[0] ? st : "?", dt);
  } else if (!strcmp(kind, "GSA")) {
    gm.cGSA++;
    // Field 2 is the fix type: 1 none, 2 = 2D, 3 = 3D. A 2D fix has no
    // altitude constraint, so its horizontal error is much worse than HDOP
    // suggests; the publish gate rejects it.
    if (nmeaField(gm.line, 2, f, sizeof f) && f[0]) {
      gm.fixMode = atoi(f);
      snprintf(note, sizeof note, "fix=%s", gm.fixMode == 3 ? "3D" : gm.fixMode == 2 ? "2D" : "none");
    }
  } else {
    gm.cOther++;
  }

  if (showNmea) {
    char up[24];
    stamp(up, sizeof up);
    char echo[208];
    if (note[0]) snprintf(echo, sizeof echo, "%-62s %s", gm.line, note);
    else         snprintf(echo, sizeof echo, "%s", gm.line);
    Serial.printf("%s[%s]%s %s%s%s\n",
                  useColor ? ANSI_DIM : "", up, useColor ? ANSI_RESET : "",
                  ok ? "" : (useColor ? ANSI_RED : ""),
                  echo, useColor ? ANSI_RESET : "");
  }
}

static void gpsMonFeed(char c) {
  if (c == '$') {                       // NMEA start delimiter
    gm.len = 0;
    gm.active = true;
    gm.overflow = false;
    gm.line[gm.len++] = '$';
    return;
  }
  if (!gm.active) return;               // drop garbage between sentences
  if (c == '\r' || c == '\n') {
    gpsMonParse();
    gm.active = false;
    gm.len = 0;
    return;
  }
  if (gm.len < sizeof(gm.line) - 1) gm.line[gm.len++] = c;
  else gm.overflow = true;
}

// Haversine distance between two GPS points (meters)
float haversineM(float lat1, float lng1, float lat2, float lng2) {
  float radLat1 = lat1 * PI / 180.0f;
  float radLat2 = lat2 * PI / 180.0f;
  float dLat = (lat2 - lat1) * PI / 180.0f;
  float dLng = (lng2 - lng1) * PI / 180.0f;
  float a = sin(dLat / 2) * sin(dLat / 2) +
            cos(radLat1) * cos(radLat2) *
            sin(dLng / 2) * sin(dLng / 2);
  float c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return 6371000.0f * c;
}

// Forward declarations for C++ compatibility
void ledsOff();
void updateLevel(float t);
void setLeds(int lvl);
void ledsFault();
bool mpuFind();
bool mpuInit();
bool mpuRead(float &ax, float &ay, float &az, float &temp,
             float &gx, float &gy, float &gz);
void updateMotion();
void updateGpsPositioning();
bool connectMqtt();
void publishData();
void networkService();
void wifiService(unsigned long now);
int8_t pickBestNetwork(int found);
bool gpsFixUsable();
void histLog(int lvl, const char* msg);

// ============ LEDs ============
// Two wirings exist in the wild and a wrong guess looks like a different bug:
//   active-high  anode -> GPIO, cathode -> GND   (pin HIGH = lit)
//   active-low   anode -> 3V3,  cathode -> GPIO  (pin LOW  = lit)
// With active-low LEDs the old ledsOff() (all pins LOW) lit all three, which
// reads exactly like "the LEDs come on all at once". Polarity is therefore a
// runtime flag, settled by the 'd' self-test and the 'y' toggle, not a guess.
static bool ledActiveLow = false;

static void ledWrite(uint8_t pin, bool on) {
  digitalWrite(pin, (on != ledActiveLow) ? HIGH : LOW);
}

// Kept in NVS so 'y' is a one-time fix: the wiring does not change when the
// board reboots, and the boot self-test has to print the right polarity.
static void ledLoadPolarity() {
  Preferences p;
  if (!p.begin("sys", true)) return;
  ledActiveLow = p.getBool("ledLow", ledActiveLow);
  p.end();
}

static void ledSavePolarity() {
  Preferences p;
  if (!p.begin("sys", false)) return;
  p.putBool("ledLow", ledActiveLow);
  p.end();
}

void ledsOff() {
  ledWrite(LED_BLUE_PIN, false);
  ledWrite(LED_WHITE_PIN, false);
  ledWrite(LED_RED_PIN, false);
}

// Lights one LED at a time and names it on the console. Watching the board while
// this runs answers both unknowns at once:
//   "only BLUE"  -> blue lit, others dark  : wiring and polarity are correct
//   "only BLUE"  -> all three lit          : the three signal wires are shorted
//                                            (usually one breadboard row)
//   "only BLUE"  -> nothing lit            : polarity is inverted, press 'y'
void ledSelfTest(const char* why) {
  const uint8_t pins[3]  = {LED_BLUE_PIN, LED_WHITE_PIN, LED_RED_PIN};
  const char*   names[3] = {"BLUE", "WHITE", "RED"};
  Serial.printf("LED test (%s): polarity %s\n", why,
                ledActiveLow ? "active-low, LOW = lit" : "active-high, HIGH = lit");
  for (int i = 0; i < 3; i++) {
    ledsOff();
    ledWrite(pins[i], true);
    Serial.printf("LED test %d/3: only %s should be lit (GPIO %u)\n",
                  i + 1, names[i], (unsigned)pins[i]);
    delay(900);
  }
  ledsOff();
  Serial.println("LED test: all off");
}

void updateLevel(float t) {
  if (level == 0) {
    if (t >= DANGER_ANGLE) level = 2;
    else if (t >= WARN_ANGLE) level = 1;
  } else if (level == 1) {
    if (t >= DANGER_ANGLE) level = 2;
    else if (t < WARN_ANGLE - HYSTERESIS) level = 0;
  } else {
    if (t < DANGER_ANGLE - HYSTERESIS) level = (t >= WARN_ANGLE) ? 1 : 0;
  }
}

void setLeds(int lvl) {
  bool fast = ((millis() / 150) % 2 == 0);
  bool wifiOk = WiFi.status() == WL_CONNECTED;
  bool mqttOk = mqtt.connected();
  // Danger level still colours the panel, but a broken link blinks the LED of
  // the failing stage so a stuck dashboard is obvious from across the room.
  ledWrite(LED_BLUE_PIN,  lvl == 0 ? true : (!wifiOk && fast));
  ledWrite(LED_WHITE_PIN, lvl == 1 ? true : (!mqttOk && fast));
  ledWrite(LED_RED_PIN,   lvl == 2 ? fast : (!wifiOk && !fast));
}

void ledsFault() {
  bool slow = ((millis() / 500) % 2 == 0);
  ledWrite(LED_BLUE_PIN,  slow);
  ledWrite(LED_WHITE_PIN, slow);
  ledWrite(LED_RED_PIN,   slow);
}

// ============ MPU6050 ============
bool mpuFind() {
  uint8_t addrs[] = {0x68, 0x69};
  for (uint8_t a : addrs) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      MPU_ADDR = a;
      return true;
    }
  }
  return false;
}

bool mpuInit() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);               // wake up
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;

  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x1A);               // low-pass filter ~44 Hz
  Wire.write(0x03);
  Wire.endTransmission();

  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x1B);               // gyro +-500 deg/s
  Wire.write(0x08);
  Wire.endTransmission();

  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x1C);               // accel +-2g
  Wire.write(0x00);
  Wire.endTransmission();
  return true;
}

static bool mpuReadOnce(float &ax, float &ay, float &az, float &temp,
                        float &gx, float &gy, float &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 14, 1) != 14) return false;

  int16_t rax = (Wire.read() << 8) | Wire.read();
  int16_t ray = (Wire.read() << 8) | Wire.read();
  int16_t raz = (Wire.read() << 8) | Wire.read();
  int16_t rt  = (Wire.read() << 8) | Wire.read();
  int16_t rgx = (Wire.read() << 8) | Wire.read();
  int16_t rgy = (Wire.read() << 8) | Wire.read();
  int16_t rgz = (Wire.read() << 8) | Wire.read();

  if (rax == 0 && ray == 0 && raz == 0 && rgx == 0 && rgy == 0 && rgz == 0) return false;

  ax = rax / 16384.0f;
  ay = ray / 16384.0f;
  az = raz / 16384.0f;
  temp = rt / 340.0f + 36.53f;
  gx = rgx / 65.5f;
  gy = rgy / 65.5f;
  gz = rgz / 65.5f;
  return true;
}

bool mpuRead(float &ax, float &ay, float &az, float &temp,
             float &gx, float &gy, float &gz) {
  // One NACK on a breadboard patch cable is not a dead sensor. A single retry
  // hides the transient that used to flip mpuValid twice a few seconds apart
  // and blink the dashboard between OK and FAIL.
  if (mpuReadOnce(ax, ay, az, temp, gx, gy, gz)) return true;
  delayMicroseconds(200);
  return mpuReadOnce(ax, ay, az, temp, gx, gy, gz);
}

void updateMotion() {
  float ax, ay, az, t, gx, gy, gz;
  if (!mpuRead(ax, ay, az, t, gx, gy, gz)) {
    if (mpuValid) logMsg(L_ERR, "IMU", "MPU6050 stopped responding (I2C 0x%02X)", MPU_ADDR);
    mpuValid = false;
    if (millis() - lastRetry > 500) {
      lastRetry = millis();
      mpuFind();
      mpuInit();
    }
    return;
  }
  if (!mpuValid) {
    mpuValid = true;
    lastMicros = micros();
    logMsg(L_OK, "IMU", "MPU6050 back online at 0x%02X", MPU_ADDR);
  }

  unsigned long now = micros();
  float dt = (now - lastMicros) / 1000000.0f;
  lastMicros = now;
  // A network reconnect can block the loop for a moment. Without this limit the
  // gyro would be integrated over that whole gap and the angle would jump.
  if (dt > 0.1f) dt = 0.1f;

  gx -= gyroBiasX;
  gy -= gyroBiasY;
  gz -= gyroBiasZ;

  float accRoll  = atan2(ay, az) * RAD_TO_DEG;
  float accPitch = atan2(-ax, sqrt(ay * ay + az * az)) * RAD_TO_DEG;

  roll  = ALPHA * (roll  + gx * dt) + (1.0f - ALPHA) * accRoll;
  pitch = ALPHA * (pitch + gy * dt) + (1.0f - ALPHA) * accPitch;

  yaw += gz * dt;
  if (yaw > 180) yaw -= 360;
  else if (yaw < -180) yaw += 360;

  lax = ax; lay = ay; laz = az; lt = t;
  tilt = max(fabs(roll), fabs(pitch));
  if (tilt > maxTilt) maxTilt = tilt;
  updateLevel(tilt);
}

// ============ GPS POSITION CONDITIONING ============
// Two separate problems, two separate answers:
//   * while parked, multipath wander moves the reported coordinate by tens of
//     metres even though the module says 0 km/h -> the published point is
//     frozen until the vehicle really moves;
//   * while moving, one wild fix must not teleport the map, the trail or the
//     odometer -> impossible steps are rejected and counted.
// Both work on the accepted fix stream, after the HDOP/satellite gate.

bool gpsFixUsable() {
  if (!gps.location.isValid()) return false;
  if (!gps.satellites.isValid() || gps.satellites.value() < GPS_MIN_SATS) return false;
  if (gps.hdop.isValid() && gps.hdop.hdop() > GPS_MAX_HDOP) return false;
#if GPS_REQUIRE_3D
  // 2 = 2D fix: no altitude, so the horizontal solution is unconstrained.
  // 0 = the module sent no GSA at all; HDOP and satellite count then decide.
  if (gm.fixMode == 2) return false;
#endif
  return true;
}

bool gpsIsParked() {
  return gps.speed.isValid() && gps.speed.kmph() < GPS_STILL_KMH;
}

// Would this fix survive a 6-satellite / HDOP 2.0 gate? Counted, never enforced.
static bool gpsFixStrict() {
  if (!gps.satellites.isValid() || gps.satellites.value() < GPS_STRICT_SATS) return false;
  if (gps.hdop.isValid() && gps.hdop.hdop() > GPS_STRICT_HDOP) return false;
  return true;
}

// The coordinate the rest of the world (map, history, odometer) must see.
bool gpsPublishPos(float* outLat, float* outLng) {
  if (!gpsFixUsable()) return false;
  if (holdValid) { *outLat = holdLat; *outLng = holdLng; }
  else           { *outLat = gps.location.lat(); *outLng = gps.location.lng(); }
  return true;
}

// Cross product (in metres, local flat projection) of gate vector and point.
static double gateSide(double lat, double lng) {
  const double midLat = (gateALat + gateBLat) * 0.5;
  const double kx = 111320.0 * cos(midLat * PI / 180.0);
  const double ky = 110540.0;
  const double gx = (gateBLng - gateALng) * kx;
  const double gy = (gateBLat - gateALat) * ky;
  return gx * ((lat - gateALat) * ky) - gy * ((lng - gateALng) * kx);
}

// Runs once per parsed fix, before publishing.
void updateGpsPositioning() {
  if (!gps.location.isUpdated() || !gps.location.isValid()) return;

  const uint32_t now = millis();
  const float lat = gps.location.lat();
  const float lng = gps.location.lng();
  const bool usable = gpsFixUsable();

  if (usable) {
    gpsFixesAccepted++;
    if (!gpsFixStrict()) gpsStrictReject++;   // diagnostic: cost of tightening the gate
  }

  if (usable && gpsTtffMs == 0) gpsTtffMs = now;

  // Jump gate: a fix that needs more than GPS_MAX_KMH to be true is noise.
  if (usable && fixHasPrev) {
    uint32_t dt = now - fixPrevMs;
    if (dt == 0) dt = 1;
    const float d = haversineM(fixPrevLat, fixPrevLng, lat, lng);
    const float kmh = (d / (float)dt) * 3600.0f;   // m/ms -> km/h
    if (kmh > GPS_MAX_KMH) {
      gpsRejected++;
      if (verbose) logMsg(L_WARN, "GPS", "fix rejected: %.0f m in %lu ms (%.0f km/h)",
                          d, (unsigned long)dt, kmh);
      return;                                       // keep the last good fix
    }
  }

  // Parked hold.
  if (usable && gpsIsParked()) {
    if (!holdValid) {
      holdValid = true;
      holdLat = lat;
      holdLng = lng;
    } else if (haversineM(holdLat, holdLng, lat, lng) > GPS_HOLD_MOVE_M) {
      // Carried, towed or a genuine slow creep: trust the new place.
      holdLat = lat;
      holdLng = lng;
    }
  } else if (usable) {
    holdValid = false;
  }

  // Finish line: does the segment P0->P1 cross A->B in the forward direction?
  if (gateValid && usable && fixHasPrev) {
    const double s0 = gateSide(fixPrevLat, fixPrevLng);
    const double s1 = gateSide(lat, lng);
    if (s0 < 0.0 && s1 >= 0.0) {
      const double midLat = (gateALat + gateBLat) * 0.5;
      const double kx = 111320.0 * cos(midLat * PI / 180.0);
      const double ky = 110540.0;
      const double px = (lng - fixPrevLng) * kx;
      const double py = (lat - fixPrevLat) * ky;
      const double a0 = px * ((gateALat - fixPrevLat) * ky) - py * ((gateALng - fixPrevLng) * kx);
      const double a1 = px * ((gateBLat - fixPrevLat) * ky) - py * ((gateBLng - fixPrevLng) * kx);
      const bool insideGate = (a0 < 0.0 && a1 >= 0.0) || (a0 >= 0.0 && a1 < 0.0);
      if (insideGate) {
        const double frac = s0 / (s0 - s1);           // 0..1 along P0->P1
        const uint32_t dt = now - fixPrevMs;
        const uint32_t crossMs = fixPrevMs + (uint32_t)(frac * (double)dt);
        const bool fast = gps.speed.isValid() && gps.speed.kmph() >= LAP_MIN_KMH;
        if (fast && (lapCrossMs == 0 || crossMs - lapCrossMs >= LAP_MIN_MS)) {
          if (lapCrossMs != 0) {
            lapLastMs = crossMs - lapCrossMs;
            if (lapBestMs == 0 || lapLastMs < lapBestMs) lapBestMs = lapLastMs;
            lapCount++;
            logMsg(L_OK, "LAP", "%lu  %lu.%02lu s  (best %lu.%02lu)",
                   (unsigned long)lapCount,
                   (unsigned long)(lapLastMs / 1000UL), (unsigned long)((lapLastMs % 1000UL) / 10UL),
                   (unsigned long)(lapBestMs / 1000UL), (unsigned long)((lapBestMs % 1000UL) / 10UL));
            lapSaveCounters();   // a brownout must not erase the session
          }
          lapCrossMs = crossMs;                        // arm the next lap
        }
      }
    }
  }

  // Only an accepted fix becomes the reference for the jump gate and for the
  // lap segment. A fix that failed the gate can be 20 m out; using it as the
  // chord endpoint would time a crossing against a position we already know is
  // wrong (or invent a crossing that never happened).
  if (usable) {
    fixPrevLat = lat;
    fixPrevLng = lng;
    fixPrevMs = now;
    fixHasPrev = true;
  }
}

// ============ UBX CONFIGURATION ============
// A NEO-6M out of the box runs 1 Hz at 9600 baud with a pedestrian dynamic
// model: no static hold, no SBAS, and 33 m of blind travel per second at
// 120 km/h. All three are fixed by pushing UBX-CFG messages once at boot.
//
// This only runs when something actually answers on GPS_TX_PIN. If the module
// does not move to 38400 the firmware restores 9600 and carries on exactly as
// before, so an unwired TX pin cannot brick the tracker.

static void gpsPump(uint32_t ms) {
  unsigned long t0 = millis();
  while (millis() - t0 < ms) {
    while (gpsSerial.available()) {
      char gc = (char)gpsSerial.read();
      gps.encode(gc);
      gpsMonFeed(gc);
    }
    delay(1);
  }
}

static void ubxSend(uint8_t cls, uint8_t id, const uint8_t* payload, uint16_t len) {
  uint8_t ckA = 0, ckB = 0;
  const uint8_t head[4] = {cls, id, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8)};
  gpsSerial.write(0xB5);
  gpsSerial.write(0x62);
  for (int i = 0; i < 4; i++) { gpsSerial.write(head[i]); ckA = (uint8_t)(ckA + head[i]); ckB = (uint8_t)(ckB + ckA); }
  for (uint16_t i = 0; i < len; i++) { gpsSerial.write(payload[i]); ckA = (uint8_t)(ckA + payload[i]); ckB = (uint8_t)(ckB + ckA); }
  gpsSerial.write(ckA);
  gpsSerial.write(ckB);
}

static void ubxMsgRate(uint8_t id, uint8_t uart1Rate) {
  const uint8_t m[8] = {0xF0, id, 0, uart1Rate, 0, 0, 0, 0};
  ubxSend(0x06, 0x01, m, sizeof m);
}

// Any complete NMEA sentence in the next window proves the link is alive at the
// current rate: half a sentence at the wrong baud never reaches a '$'...'*'.
static bool gpsLinkAlive(uint32_t ms) {
  const uint32_t before = gm.sentences;
  gpsPump(ms);
  return gm.sentences != before;
}

// The factory rate is 9600, but once this firmware stores its configuration in
// the module (step 7 below) the next power-up starts at 38400, and a module
// touched by u-center may be at 115200. Probe all three so a saved rate can
// never leave the tracker listening at the wrong speed.
static uint32_t gpsDetectBaud() {
  const uint32_t rates[3] = {GPS_BAUD, GPS_BAUD_FAST, GPS_BAUD_ALT};
  for (int i = 0; i < 3; i++) {
    gpsSerial.updateBaudRate(rates[i]);
    if (gpsLinkAlive(600)) return rates[i];
  }
  gpsSerial.updateBaudRate(GPS_BAUD);
  return 0;
}

// Active probe: does anything answer UBX on the TX pin at all? A MON-VER poll
// is answered by a healthy module even when it ignores CFG-PRT, so this tells
// "wire missing / wrong pin" apart from "module refused the configuration".
// Both used to print the same "not acknowledged" line.
static bool ubxPing() {
  ubxSend(0x0A, 0x04, nullptr, 0);                 // UBX-MON-VER poll
  const uint32_t t0 = millis();
  bool sync = false;
  while (millis() - t0 < 400) {
    while (gpsSerial.available()) {
      const uint8_t b = (uint8_t)gpsSerial.read();
      if (b == 0xB5) {
        sync = true;
      } else if (sync) {
        if (b == 0x62) return true;                // 0xB5 0x62 = UBX frame start
        sync = false;
      }
    }
    delay(1);
  }
  return false;
}

static bool gpsUbxConfigure() {
#if GPS_UBX_ENABLE
  if (GPS_TX_PIN < 0) return false;

  gpsPump(700);                                   // let the module finish booting
  const uint32_t found = gpsDetectBaud();
  if (found == 0) {
    // Not verbose-gated: a tracker that cannot reach the module should say so
    // once at boot instead of looking healthy while publishing no position.
    logMsg(L_INFO, "GPS", "no NMEA on GPIO %d - UBX setup skipped (check module TX)", GPS_RX_PIN);
    return false;
  }
  if (found != GPS_BAUD) {
    logMsg(L_INFO, "GPS", "module already at %lu baud", (unsigned long)found);
  }

  if (found != GPS_BAUD_FAST) {
    // 1. Move UART1 to 38400 8N1.
    uint8_t prt[20] = {0};
    prt[0] = 1;                                   // portID: UART1
    prt[4] = 0xD0; prt[5] = 0x08;                 // 8 data bits, no parity, 1 stop
    prt[8] = (uint8_t)(GPS_BAUD_FAST & 0xFF);
    prt[9] = (uint8_t)(GPS_BAUD_FAST >> 8);
    prt[12] = 0x07;                               // in:  UBX | NMEA | RTCM
    prt[14] = 0x03;                               // out: UBX | NMEA
    ubxSend(0x06, 0x00, prt, sizeof prt);
    gpsSerial.flush();
    delay(50);
    gpsSerial.updateBaudRate(GPS_BAUD_FAST);

    // 2. Verify it really moved. Garbage at the wrong rate parses as nothing.
    if (!gpsLinkAlive(1400)) {
      gpsSerial.updateBaudRate(found);
      gpsPump(300);
      if (ubxPing()) {
        logMsg(L_WARN, "GPS", "UBX: module answers on GPIO %d but ignored 38400 - staying at %lu baud",
               GPS_TX_PIN, (unsigned long)found);
      } else {
        logMsg(L_WARN, "GPS", "UBX: no reply on GPIO %d - wire module RX to it; staying at %lu baud",
               GPS_TX_PIN, (unsigned long)found);
      }
      return false;
    }
  }

  // 3. 5 Hz navigation.
  const uint8_t rate[6] = {200, 0, 1, 0, 1, 0};   // measRate 200 ms, navRate 1, GPS time
  ubxSend(0x06, 0x08, rate, sizeof rate);

  // 4. Automotive model + static hold below 0.5 m/s.
  //    The mask is per field, not "apply everything": bit 0 = dynamic model,
  //    bit 2 = fix mode, bit 8 = static hold threshold. 0x0105 sets exactly
  //    those three; an earlier 0x41 applied the dynamic model and a DOP mask
  //    and left static hold silently off.
  uint8_t nav5[36] = {0};
  nav5[0] = 0x05; nav5[1] = 0x01;                 // dynModel | fixMode | staticHoldThresh
  nav5[2] = 4;                                    // automotive
  nav5[3] = 3;                                    // auto 2D/3D
  nav5[22] = 50;                                  // static hold 50 cm/s
  ubxSend(0x06, 0x24, nav5, sizeof nav5);

  // 5. SBAS (WAAS/EGNOS/MSAS): differential corrections, ~2 m instead of ~3 m.
  const uint8_t sbas[8] = {1, 3, 3, 0, 0, 0, 0, 0};
  ubxSend(0x06, 0x16, sbas, sizeof sbas);

  // 6. Trim the stream: keep GGA/GSA/RMC every fix, GSV once a second, drop
  //    VTG/GLL/ZDA entirely. At 5 Hz the default set would not fit 38400.
  ubxMsgRate(0x00, 1);                            // GGA
  ubxMsgRate(0x02, 1);                            // GSA
  ubxMsgRate(0x04, 1);                            // RMC
  ubxMsgRate(0x03, GPS_NAV_HZ);                   // GSV: once per second
  ubxMsgRate(0x01, 0);                            // GLL: off
  ubxMsgRate(0x05, 0);                            // VTG: off
  ubxMsgRate(0x08, 0);                            // ZDA: off
  gpsSerial.flush();

  // 7. Store the configuration in the module itself (battery-backed RAM +
  //    flash). Without this every power cycle returns to 1 Hz / 9600 / no SBAS
  //    and the first seconds of every run are wasted re-negotiating; with it a
  //    warm start is already at 5 Hz. gpsDetectBaud() above handles the 38400
  //    start this creates.
  const uint8_t save[13] = {0, 0, 0, 0,            // clearMask: nothing
                            0xFF, 0xFF, 0, 0,      // saveMask: BBR|Flash|EEPROM|SPI|IO|MSG
                            0, 0, 0, 0, 0};        // loadMask: nothing
  ubxSend(0x06, 0x09, save, sizeof save);
  gpsSerial.flush();
  delay(100);

  logMsg(L_OK, "GPS", "UBX: %d Hz, %d baud, automotive, static hold 1.8 km/h, SBAS on (saved)",
         GPS_NAV_HZ, GPS_BAUD_FAST);
  return true;
#else
  return false;
#endif
}

// ============ FINISH LINE STORAGE ============
// Two points, captured from the console while the vehicle sits on each end of
// the line, kept in NVS so a reboot does not lose the track.
static bool gateASet = false, gateBSet = false;

// Counters are written once per completed lap, not per fix: roughly one NVS
// commit every 90 s at race pace, which is nowhere near the flash endurance
// limit, but it means a race survives a brownout or a reset on the grid.
static void lapSaveCounters() {
  Preferences prefs;
  if (!prefs.begin("lap", false)) return;
  prefs.putUInt("n", lapCount);
  prefs.putUInt("last", lapLastMs);
  prefs.putUInt("best", lapBestMs);
  prefs.end();
}

static void gpsSaveGates() {
  Preferences prefs;
  if (!prefs.begin("lap", false)) return;
  prefs.putBool("aSet", gateASet);
  prefs.putBool("bSet", gateBSet);
  prefs.putInt("alat", (int32_t)lround(gateALat * 1e7));
  prefs.putInt("alng", (int32_t)lround(gateALng * 1e7));
  prefs.putInt("blat", (int32_t)lround(gateBLat * 1e7));
  prefs.putInt("blng", (int32_t)lround(gateBLng * 1e7));
  prefs.end();
}

void gpsLoadGates() {
  Preferences prefs;
  if (!prefs.begin("lap", true)) return;
  gateASet = prefs.getBool("aSet", false);
  gateBSet = prefs.getBool("bSet", false);
  gateALat = prefs.getInt("alat", 0) / 1e7;
  gateALng = prefs.getInt("alng", 0) / 1e7;
  gateBLat = prefs.getInt("blat", 0) / 1e7;
  gateBLng = prefs.getInt("blng", 0) / 1e7;
  lapCount  = prefs.getUInt("n", 0);
  lapLastMs = prefs.getUInt("last", 0);
  lapBestMs = prefs.getUInt("best", 0);
  prefs.end();
  // millis() restarts at boot, so a stored crossing time would be meaningless.
  // The line re-arms on the next forward crossing; finished laps survive.
  lapCrossMs = 0;
  gateValid = gateASet && gateBSet && haversineM(gateALat, gateALng, gateBLat, gateBLng) > 1.0f;
  if (gateValid) logMsg(L_OK, "LAP", "gate loaded: A %.6f,%.6f  B %.6f,%.6f",
                        gateALat, gateALng, gateBLat, gateBLng);
  if (lapCount) logMsg(L_OK, "LAP", "%lu lap(s) restored, last %lu.%02lu s, best %lu.%02lu s",
                       (unsigned long)lapCount,
                       (unsigned long)(lapLastMs / 1000UL), (unsigned long)((lapLastMs % 1000UL) / 10UL),
                       (unsigned long)(lapBestMs / 1000UL), (unsigned long)((lapBestMs % 1000UL) / 10UL));
}

static void gpsClearGates() {
  Preferences prefs;
  if (prefs.begin("lap", false)) { prefs.clear(); prefs.end(); }
  gateASet = gateBSet = gateValid = false;
  lapCount = lapLastMs = lapBestMs = lapCrossMs = 0;
  logMsg(L_OK, "LAP", "gate cleared");
}

static void gpsCaptureGate(char which) {
  float lat = 0, lng = 0;
  if (!gpsPublishPos(&lat, &lng)) {
    logMsg(L_WARN, "LAP", "no usable fix - cannot set gate %c", which);
    return;
  }
  if (which == 'a') { gateALat = lat; gateALng = lng; gateASet = true; }
  else              { gateBLat = lat; gateBLng = lng; gateBSet = true; }
  gateValid = gateASet && gateBSet && haversineM(gateALat, gateALng, gateBLat, gateBLng) > 1.0f;
  gpsSaveGates();
  if (gateValid) {
    const float width = haversineM(gateALat, gateALng, gateBLat, gateBLng);
    lapCount = lapLastMs = lapBestMs = lapCrossMs = 0;
    lapSaveCounters();   // persist the reset; otherwise a reboot revives the old session
    logMsg(L_OK, "LAP", "gate armed: %c %.6f,%.6f  width %.1f m - cross A->B to start",
           which, lat, lng, width);
  } else {
    logMsg(L_INFO, "LAP", "gate %c stored - set the other end (%.6f,%.6f)", which, lat, lng);
  }
}

static void gpsShowGates() {
  if (!gateValid) { logMsg(L_INFO, "LAP", "no gate set: press a at one end, b at the other"); return; }
  logMsg(L_INFO, "LAP", "A %.6f,%.6f  B %.6f,%.6f  width %.1f m  laps %lu  last %lu.%02lu s  best %lu.%02lu s",
         gateALat, gateALng, gateBLat, gateBLng,
         haversineM(gateALat, gateALng, gateBLat, gateBLng), (unsigned long)lapCount,
         (unsigned long)(lapLastMs / 1000UL), (unsigned long)((lapLastMs % 1000UL) / 10UL),
         (unsigned long)(lapBestMs / 1000UL), (unsigned long)((lapBestMs % 1000UL) / 10UL));
}

// ============ NETWORK ============
// Pick the best visible candidate: exact SSID match beats prefix match, and the
// previously working network wins ties so we do not flap between APs.
int8_t pickBestNetwork(int found) {
  int8_t exact = -1, prefix = -1;
  for (int i = 0; i < found; i++) {
    // One String per visible AP, not one per (AP, candidate) pair: this call
    // used to allocate inside the inner loop and fragment the heap on every
    // rescan, which happens for hours on a pit lane.
    String seen = WiFi.SSID(i);
    for (size_t c = 0; c < WIFI_NET_COUNT; c++) {
      if (seen == WIFI_NETS[c].ssid) { if (exact < 0) exact = (int8_t)c; }
      else if (seen.startsWith(WIFI_NETS[c].ssid)) { if (prefix < 0) prefix = (int8_t)c; }
    }
    if (exact >= 0) break;
  }
  if (exact >= 0) return exact;
  if (prefix >= 0) return prefix;
  if (lastGoodNet >= 0) return lastGoodNet;   // last resort: known-good AP
  return -1;
}

// Non-blocking Wi-Fi driver. Never calls the blocking scanNetworks(); the async
// form returns immediately and is polled here, so sensors and MQTT keep running.
void wifiService(unsigned long now) {
  if (WiFi.status() == WL_CONNECTED) {
    if (wifiPhase != WF_IDLE) {
      wifiPhase = WF_IDLE;
      // Remember the AP that actually worked so reconnects skip the scan.
      String cur = WiFi.SSID();
      for (size_t c = 0; c < WIFI_NET_COUNT; c++) {
        if (cur == WIFI_NETS[c].ssid || cur.startsWith(WIFI_NETS[c].ssid)) { lastGoodNet = (int8_t)c; break; }
      }
      logMsg(L_OK, "NET", "connected '%s'  ip=%s  rssi=%d dBm  ch=%d  (slot %d)",
             WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
             (int)WiFi.RSSI(), (int)WiFi.channel(), (int)lastGoodNet);
    }
    return;
  }

  switch (wifiPhase) {
    case WF_IDLE:
      if (now - lastWifiTry < WIFI_RETRY_MS) return;
      lastWifiTry = now;
      if (lastGoodNet >= 0) {
        // Fast path: re-associate with the AP that worked before, no scan.
        logMsg(L_INFO, "NET", "retrying '%s'", WIFI_NETS[lastGoodNet].ssid);
        WiFi.begin(WIFI_NETS[lastGoodNet].ssid, WIFI_NETS[lastGoodNet].pass);
        wifiPhase = WF_CONNECTING;
        wifiPhaseSince = now;
      } else {
        logMsg(L_INFO, "NET", "scanning (async)");
        WiFi.scanNetworks(true /*async*/, false);
        wifiPhase = WF_SCANNING;
        wifiPhaseSince = now;
      }
      break;

    case WF_SCANNING: {
      int found = WiFi.scanComplete();
      if (found == WIFI_SCAN_RUNNING) {
        if (now - wifiPhaseSince > 15000) { wifiPhase = WF_IDLE; }   // scan stuck
        return;
      }
      if (found < 0) {                       // WIFI_SCAN_FAILED
        logMsg(L_WARN, "NET", "scan failed");
        wifiPhase = WF_IDLE;
        return;
      }
      int8_t best = pickBestNetwork(found);
      logMsg(L_INFO, "NET", "%d network(s) visible, best candidate=%s",
             found, best >= 0 ? WIFI_NETS[best].ssid : "none");
      WiFi.scanDelete();
      if (best >= 0) {
        logMsg(L_INFO, "NET", "connecting to '%s'%s", WIFI_NETS[best].ssid,
               WIFI_NETS[best].pass[0] ? "" : " (open)");
        WiFi.begin(WIFI_NETS[best].ssid, WIFI_NETS[best].pass);
        wifiPhase = WF_CONNECTING;
        wifiPhaseSince = now;
      } else {
        wifiPhase = WF_IDLE;
      }
      break;
    }

    case WF_CONNECTING:
      if (now - wifiPhaseSince > WIFI_CONNECT_TIMEOUT) {
        logMsg(L_WARN, "NET", "association timeout (status=%d), backing off", (int)WiFi.status());
        WiFi.disconnect(true);
        wifiPhase = WF_IDLE;
        lastWifiTry = now;
      }
      break;
  }
}

const char* wifiStatusStr() {
  switch (WiFi.status()) {
    case WL_CONNECTED:      return "Connected";
    case WL_NO_SSID_AVAIL:  return "No SSID";
    case WL_CONNECT_FAILED: return "Connect failed";
    case WL_IDLE_STATUS:    return "Idle";
    case WL_DISCONNECTED:   return "Disconnected";
    default:                return "Unknown";
  }
}

bool connectMqtt() {
  logMsg(L_INFO, "MQTT", "connecting to %s:%d", MQTT_HOST, MQTT_PORT);
  // Last will: if the ESP32 vanishes, the broker publishes "offline" for us
  if (mqtt.connect(clientId, nullptr, nullptr, TOPIC_STATUS, 0, true, "offline")) {
    mqtt.publish(TOPIC_STATUS, "online", true);
    logMsg(L_OK, "MQTT", "session up, status=online (retained)");
    mqttBackoff = MQTT_BACKOFF_MIN_MS;
    mqttWasConnected = true;
    lastPublishOk = millis();          // watchdog baseline
    return true;
  }
  logMsg(L_WARN, "MQTT", "connect failed (state=%d), retry in %lus",
         mqtt.state(), mqttBackoff / 1000UL);
  return false;
}

// ---- pending publish queue ------------------------------------------------
void txqPush(const char* payload) {
  uint8_t slot = (uint8_t)((txqHead + txqCount) % TXQ_SLOTS);
  if (txqCount == TXQ_SLOTS) {           // full: drop the oldest
    txqHead = (uint8_t)((txqHead + 1) % TXQ_SLOTS);
    txqCount--;
    txDrop++;
  }
  strncpy(txq[slot], payload, TXQ_LEN - 1);
  txq[slot][TXQ_LEN - 1] = '\0';
  txqCount++;
}

void txqDrain() {
  while (txqCount > 0 && mqtt.connected()) {
    if (mqtt.publish(TOPIC_DATA, txq[txqHead], true)) {   // retained: latest wins
      txqHead = (uint8_t)((txqHead + 1) % TXQ_SLOTS);
      txqCount--;
      txOk++;
      lastPublishOk = millis();
    } else {
      txFail++;
      return;                            // retry on a later loop
    }
  }
}

// ============ GPS sanity ============
// gpsFixUsable() lives with the position conditioning above, because the jump
// gate and the parked hold both need the same verdict.

void publishData() {
  // A position is only published when the fix is actually usable (enough
  // satellites, sane HDOP, 3D); otherwise the fields stay null and the
  // dashboard shows "NO FIX" instead of a wrong place on the map.
  const bool fix = gpsFixUsable();
  float pubLat = 0, pubLng = 0;
  const bool havePos = fix && gpsPublishPos(&pubLat, &pubLng);
  char lat[16] = "null", lng[16] = "null", alt[16] = "null", spd[16] = "null";
  if (havePos && GPS_DECIMALS >= 0) {
    snprintf(lat, sizeof lat, "%.*f", GPS_DECIMALS, pubLat);
    snprintf(lng, sizeof lng, "%.*f", GPS_DECIMALS, pubLng);
  }
  if (fix && gps.altitude.isValid()) snprintf(alt, sizeof alt, "%.0f", gps.altitude.meters());
  if (fix && gps.speed.isValid() && gps.speed.kmph() <= GPS_MAX_KMH)
    snprintf(spd, sizeof spd, "%.1f", gps.speed.kmph());

  char cog[16] = "null", hdop[16] = "null";
  if (fix && gps.course.isValid()) snprintf(cog, sizeof cog, "%.1f", gps.course.deg());
  if (gps.hdop.isValid())          snprintf(hdop, sizeof hdop, "%.2f", gps.hdop.hdop());

  int utc_h = 0, utc_m = 0, utc_s = 0;
  int utc_y = 0, utc_mo = 0, utc_d = 0;
  if (gps.time.isValid())  { utc_h = gps.time.hour();  utc_m = gps.time.minute();  utc_s = gps.time.second(); }
  if (gps.date.isValid())  { utc_y = gps.date.year();  utc_mo = gps.date.month();  utc_d = gps.date.day(); }

  // Wall-clock timestamp when the GPS knows the date, otherwise 0 so the
  // dashboard falls back to arrival time. seq lets it detect gaps/duplicates.
  //
  // Date -> epoch must be exact: the old code multiplied elapsed years by an
  // average year length, which drifted by tens of minutes and made every
  // timestamp wrong. This is the standard civil-date algorithm.
  uint32_t epoch = 0;
  if (utc_y >= 2020) {
    int y = utc_y;
    unsigned m = (unsigned)utc_mo, d = (unsigned)utc_d;
    y -= (m <= 2);
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153u * (m + (m > 2 ? -3u : 9u)) + 2u) / 5u + d - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    const int32_t days = era * 146097 + (int32_t)doe - 719468;
    epoch = (uint32_t)(days * 86400L + utc_h * 3600L + utc_m * 60L + utc_s);
  }

  // Sensor plausibility clamps: never publish values the hardware cannot mean.
  float tRoll  = constrain(roll,  -180.0f, 180.0f);
  float tPitch = constrain(pitch, -180.0f, 180.0f);
  float tYaw   = constrain(yaw,   -180.0f, 180.0f);

  txSeq++;

#if GPS_DECIMALS >= 0
  // History path: only real fixes with a real clock are worth storing. It is a
  // separate queue, so a history or TLS problem can never delay the live map.
  // The stored point is the conditioned one, otherwise the parked hold would
  // keep the live map still while the database filled with wander.
  if (havePos && epoch > 0) {
    HistoryFix hf = {};
    hf.seq  = txSeq;
    hf.ts   = epoch;
    hf.up   = (uint32_t)(millis() / 1000);
    hf.boot = (uint16_t)bootCount;
    hf.lat  = pubLat;
    hf.lng  = pubLng;
    hf.alt  = gps.altitude.isValid() ? gps.altitude.meters() : 0.0f;
    hf.kmh  = (gps.speed.isValid() && gps.speed.kmph() <= GPS_MAX_KMH) ? gps.speed.kmph() : 0.0f;
    hf.cog  = gps.course.isValid() ? gps.course.deg() : 0.0f;
    hf.hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 99.0f;
    hf.sats = (uint8_t)gps.satellites.value();
    hf.dist_m = gpsDistTotalM;
    // Lap and attitude travel with the fix: the server logs a lap row when
    // lap_n changes and keeps a lean trace per point.
    hf.roll = roll;
    hf.pitch = pitch;
    hf.lap_n = lapCount;
    hf.lap_last_ms = lapLastMs;
    hf.lap_best_ms = lapBestMs;
    historyEnqueue(hf);
  }
#endif

  char b[1200];
  int n = snprintf(b, sizeof b,
    "{\"seq\":%lu,\"ts\":%lu,\"up\":%lu,\"mpu\":%s,\"roll\":%.2f,\"pitch\":%.2f,\"yaw\":%.2f,\"tilt\":%.2f,"
    "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"temp\":%.1f,\"lvl\":%d,"
    "\"warn\":%d,\"danger\":%d,\"maxTilt\":%.1f,"
    "\"gps\":{\"chars\":%lu,\"view\":%d,\"snr\":%d,\"q\":%d,\"bad\":%lu,"
    "\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
    "\"cog\":%s,\"hdop\":%s,\"dist_m\":%.2f,\"ttff_s\":%lu,\"rej\":%lu,\"still\":%s,\"mode\":%d,"
    "\"utc_h\":%d,\"utc_m\":%d,\"utc_s\":%d,\"utc_y\":%d,\"utc_mo\":%d,\"utc_d\":%d},"
    "\"lap\":{\"on\":%s,\"n\":%lu,\"last_ms\":%lu,\"best_ms\":%lu,"
    "\"la\":[%.*f,%.*f],\"lb\":[%.*f,%.*f]},"
    "\"sys\":{\"heap\":%u,\"heap_min\":%u,\"boot\":%lu,\"rssi\":%d,"
    "\"wifi\":{\"ssid\":\"%.32s\",\"bssid\":\"%.17s\",\"channel\":%d,\"status\":\"%s\","
    "\"ip\":\"%.15s\",\"mac\":\"%.17s\"}}}",
    (unsigned long)txSeq, (unsigned long)epoch, (unsigned long)(millis() / 1000),
    mpuValid ? "true" : "false",
    tRoll, tPitch, tYaw, tilt, lax, lay, laz, lt, level,
    (int)WARN_ANGLE, (int)DANGER_ANGLE, maxTilt,
    (unsigned long)gps.charsProcessed(), gm.cGSV ? gm.view : -1, gm.snr, gm.fixQ, (unsigned long)gm.bad,
    (int)gps.satellites.value(),
    fix ? "true" : "false", lat, lng, alt, spd,
    cog, hdop, gpsDistTotalM,
    (unsigned long)(gpsTtffMs / 1000UL), (unsigned long)gpsRejected,
    holdValid ? "true" : "false", (int)gm.fixMode,
    utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d,
    gateValid ? "true" : "false", (unsigned long)lapCount,
    (unsigned long)lapLastMs, (unsigned long)lapBestMs,
    GPS_DECIMALS, gateALat, GPS_DECIMALS, gateALng,
    GPS_DECIMALS, gateBLat, GPS_DECIMALS, gateBLng,
    (unsigned)ESP.getFreeHeap(), (unsigned)minFreeHeap, (unsigned long)bootCount,
    WiFi.RSSI(),
    WiFi.SSID().c_str(), WiFi.BSSIDstr().c_str(), (int)WiFi.channel(), wifiStatusStr(),
    WiFi.localIP().toString().c_str(), WiFi.macAddress().c_str());

  if (n < 0) {                       // snprintf failure
    logMsg(L_ERR, "MQTT", "payload snprintf failed, reading dropped");
    txFail++;
    return;
  }
  if (n >= (int)sizeof b) {          // would be truncated: send the slim form
    logMsg(L_WARN, "MQTT", "payload truncated (%d >= %d), publishing slim variant", n, (int)sizeof b);
    n = snprintf(b, sizeof b,
      "{\"seq\":%lu,\"ts\":%lu,\"up\":%lu,\"mpu\":%s,\"roll\":%.2f,\"pitch\":%.2f,\"yaw\":%.2f,\"tilt\":%.2f,"
      "\"lvl\":%d,\"warn\":%d,\"danger\":%d,\"maxTilt\":%.1f,"
      "\"gps\":{\"chars\":%lu,\"view\":%d,\"snr\":%d,\"q\":%d,\"bad\":%lu,"
      "\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
      "\"cog\":%s,\"hdop\":%s,\"dist_m\":%.2f,\"ttff_s\":%lu,\"rej\":%lu,\"still\":%s,\"mode\":%d},"
      "\"lap\":{\"on\":%s,\"n\":%lu,\"last_ms\":%lu,\"best_ms\":%lu},"
      "\"sys\":{\"heap\":%u,\"heap_min\":%u,\"boot\":%lu,\"rssi\":%d}}",
      (unsigned long)txSeq, (unsigned long)epoch, (unsigned long)(millis() / 1000),
      mpuValid ? "true" : "false", tRoll, tPitch, tYaw, tilt, level,
      (int)WARN_ANGLE, (int)DANGER_ANGLE, maxTilt,
      (unsigned long)gps.charsProcessed(), gm.cGSV ? gm.view : -1, gm.snr, gm.fixQ, (unsigned long)gm.bad,
      (int)gps.satellites.value(),
      fix ? "true" : "false", lat, lng, alt, spd, cog, hdop, gpsDistTotalM,
      (unsigned long)(gpsTtffMs / 1000UL), (unsigned long)gpsRejected,
      holdValid ? "true" : "false", (int)gm.fixMode,
      gateValid ? "true" : "false", (unsigned long)lapCount,
      (unsigned long)lapLastMs, (unsigned long)lapBestMs,
      (unsigned)ESP.getFreeHeap(), (unsigned)minFreeHeap, (unsigned long)bootCount,
      WiFi.RSSI());
    if (n <= 0 || n >= (int)sizeof b) { txFail++; return; }
  }

  if (verbose) logMsg(L_DBG, "MQTT", "queued #%lu (%d bytes, q=%u)",
                      (unsigned long)txSeq, n, (unsigned)txqCount);
  txqPush(b);
}

// Called every loop. Never blocks for long and never stops the sensors.
void networkService() {
#if VIEWER_MODE == 0
  unsigned long now = millis();

  wifiService(now);

  if (WiFi.status() != WL_CONNECTED) {
    // Remember which candidate actually works, so the next reconnect can skip
    // the scan entirely and go straight back to it.
    return;
  }

  if (!mqtt.connected()) {
    if (mqttWasConnected) {
      mqttWasConnected = false;
      logMsg(L_WARN, "MQTT", "link lost after %lu ok publishes", (unsigned long)txOk);
    }
    if (now - lastMqttTry >= mqttBackoff) {
      lastMqttTry = now;
      if (!connectMqtt()) {
        mqttBackoff = mqttBackoff * 2;
        if (mqttBackoff > MQTT_BACKOFF_MAX_MS) mqttBackoff = MQTT_BACKOFF_MAX_MS;
      }
    }
    return;
  }

  // Half-open TCP guard: the socket can look connected while nothing is
  // delivered. If no publish has succeeded for a while, force a clean session.
  if (lastPublishOk != 0 && now - lastPublishOk > MQTT_WATCHDOG_MS) {
    logMsg(L_WARN, "MQTT", "watchdog: nothing delivered for %lus, reconnecting",
           (unsigned long)((now - lastPublishOk) / 1000));
    mqtt.disconnect();
    lastMqttTry = 0;                     // reconnect immediately
    mqttBackoff = MQTT_BACKOFF_MIN_MS;
    return;
  }

  mqtt.loop();

  if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = now;
    publishData();                       // queues the reading
  }

  txqDrain();                            // send queue + backfill after outages
#endif
}

// ============ SERIAL PANEL ============
// Framed snapshot every DASH_INTERVAL_MS. Columns are fixed so a captured log
// can be scanned vertically; the state words carry the colour, not the padding.
static const char* A(const char* code) { return useColor ? code : ""; }

static void printStatus() {
  if (!showPanel) return;

  unsigned long ms = millis();
  const bool wifiOk  = WiFi.status() == WL_CONNECTED;
  const bool mqttOk  = mqtt.connected();
  const bool gpsLive = gps.charsProcessed() > 0;
  const bool fix     = gpsFixUsable();
  const bool stale   = gpsLive && gm.sentences > 0 && (ms - gm.lastMs) > 3000UL;
  const bool garbage = gpsLive && gm.sentences == 0;   // bytes but no NMEA frames
  const int  used    = (int)gps.satellites.value();

  // "FIX" green, "NO FIX" yellow only when the antenna actually sees satellites,
  // red when it hears nothing at all - that distinction is the point of the tap.
  const char* gpsWord = fix ? "FIX"
                      : (!gpsLive ? "NO DATA" : (garbage ? "NO NMEA" : "NO FIX"));
  const char* gpsCol  = fix ? ANSI_GRN
                      : ((gpsLive && !stale && gm.view > 0) ? ANSI_YEL : ANSI_RED);
  const char* lvlWord = level == 2 ? "DANGER" : (level == 1 ? "WARN" : "safe");
  const char* lvlCol  = level == 2 ? ANSI_RED : (level == 1 ? ANSI_YEL : ANSI_GRN);

  char up[24];
  stamp(up, sizeof up);

  char hdop[12];
  if (gps.hdop.isValid()) snprintf(hdop, sizeof hdop, "%.2f", gps.hdop.hdop());
  else                    snprintf(hdop, sizeof hdop, "--");

  char age[12];
  if (gpsLive) snprintf(age, sizeof age, "%lus", (unsigned long)((ms - gm.lastMs) / 1000UL));
  else         snprintf(age, sizeof age, "--");

  // Optional columns: empty when there is nothing to say, so the line stays
  // readable in the common all-empty case.
  char spTtff[16] = "";
  if (gpsTtffMs) snprintf(spTtff, sizeof spTtff, "%lus", (unsigned long)(gpsTtffMs / 1000UL));
  char spLast[16] = "", spBest[16] = "";
  if (lapCrossMs) snprintf(spLast, sizeof spLast, "%lu.%02lu", (unsigned long)(lapLastMs / 1000UL), (unsigned long)((lapLastMs % 1000UL) / 10UL));
  if (lapBestMs)  snprintf(spBest, sizeof spBest, "%lu.%02lu", (unsigned long)(lapBestMs / 1000UL), (unsigned long)((lapBestMs % 1000UL) / 10UL));

  // -1 = the module sent no GSV at all, so "0 in view" would be a lie.
  char viewTxt[8], snrTxt[8];
  if (gm.cGSV > 0) { snprintf(viewTxt, sizeof viewTxt, "%d", gm.view); snprintf(snrTxt, sizeof snrTxt, "%d", gm.snr); }
  else             { snprintf(viewTxt, sizeof viewTxt, "--");          snprintf(snrTxt, sizeof snrTxt, "--"); }

  Serial.printf("\n%s+------------------------------------------------------------------------------%s\n",
                A(ANSI_DIM), A(ANSI_RESET));

  Serial.printf("%s|%s SYS   up %s   heap %uK   rssi %d dBm   ch %d   ip %s\n",
                A(ANSI_DIM), A(ANSI_RESET), up,
                (unsigned)(ESP.getFreeHeap() / 1024),
                wifiOk ? (int)WiFi.RSSI() : 0,
                wifiOk ? (int)WiFi.channel() : 0,
                wifiOk ? WiFi.localIP().toString().c_str() : "-");

  Serial.printf("%s|%s LINK  wifi %s%-4s%s  mqtt %s%-4s%s  tx %lu  ok %lu  fail %lu  drop %lu  q %u\n",
                A(ANSI_DIM), A(ANSI_RESET),
                A(wifiOk ? ANSI_GRN : ANSI_RED), wifiOk ? "OK" : "DOWN", A(ANSI_RESET),
                A(mqttOk ? ANSI_GRN : ANSI_RED), mqttOk ? "OK" : "DOWN", A(ANSI_RESET),
                (unsigned long)txSeq, (unsigned long)txOk, (unsigned long)txFail,
                (unsigned long)txDrop, (unsigned)txqCount);

  Serial.printf("%s|%s GPS   %s%-7s%s used %-2d  view %-3s  snr %-3s  q %d  hdop %-5s  nmea %s ago\n",
                A(ANSI_DIM), A(ANSI_RESET),
                A(gpsCol), gpsWord, A(ANSI_RESET),
                used, viewTxt, snrTxt, gm.fixQ, hdop, age);

  Serial.printf("%s|%s NMEA  %lu sent  %lu bad  gga %lu  rmc %lu  gsa %lu  gsv %lu  other %lu\n",
                A(ANSI_DIM), A(ANSI_RESET),
                (unsigned long)gm.sentences, (unsigned long)gm.bad,
                (unsigned long)gm.cGGA, (unsigned long)gm.cRMC,
                (unsigned long)gm.cGSA, (unsigned long)gm.cGSV, (unsigned long)gm.cOther);

  Serial.printf("%s|%s IMU   tilt %5.1f  %s%-6s%s  roll %5.1f  pitch %5.1f  yaw %6.1f  mpu %s%s%s\n",
                A(ANSI_DIM), A(ANSI_RESET),
                tilt, A(lvlCol), lvlWord, A(ANSI_RESET),
                roll, pitch, yaw,
                A(mpuValid ? ANSI_GRN : ANSI_RED), mpuValid ? "OK" : "FAIL", A(ANSI_RESET));

  // "tight" is the shadow gate: fixes that pass today but would fail 6/2.0.
  // If it stays near 0 on track, tightening is free; if it is double digits,
  // the strict gate is dropping track segments for no real accuracy gain.
  const unsigned tightPct = gpsFixesAccepted
      ? (unsigned)((100ULL * gpsStrictReject) / gpsFixesAccepted) : 0;
  Serial.printf("%s|%s POS   fix %-4s  ttff %-4s  rejected %-3lu  tight %lu/%lu (%u%%)  hold %-3s  lap %lu  last %s  best %s\n",
                A(ANSI_DIM), A(ANSI_RESET),
                gm.fixMode == 3 ? "3D" : gm.fixMode == 2 ? "2D" : "--",
                gpsTtffMs ? (spTtff[0] ? spTtff : "--") : "--",
                (unsigned long)gpsRejected,
                (unsigned long)gpsStrictReject, (unsigned long)gpsFixesAccepted, tightPct,
                holdValid ? "yes" : "no",
                (unsigned long)lapCount,
                lapLastMs ? spLast : "--",
                lapBestMs ? spBest : "--");

  {
    HistoryStats hs = historyStats();
    const bool on = historyEnabled();
    Serial.printf("%s|%s HIST  %s%-4s%s  queued %lu  stored %lu  sent %lu  fail %lu  drop %lu  buf %lu B\n",
                  A(ANSI_DIM), A(ANSI_RESET),
                  A(on ? ANSI_GRN : ANSI_YEL), on ? "ON" : "OFF", A(ANSI_RESET),
                  (unsigned long)hs.queued, (unsigned long)hs.written,
                  (unsigned long)hs.acked, (unsigned long)hs.failed,
                  (unsigned long)hs.dropped, (unsigned long)hs.bytes);
  }

  Serial.printf("%s+------------------------------------------------------------------------------%s\n",
                A(ANSI_DIM), A(ANSI_RESET));

  // One hint per failure, phrased as the next physical thing to check.
  if (!gpsLive)
    Serial.println("  ! GPS  no bytes at all - check TX->GPIO25, common GND, module VCC");
  else if (garbage)
    Serial.println("  ! GPS  bytes but no NMEA sentences - wrong baud, TX noise or swapped pin");
  else if (stale)
    Serial.printf("  ! GPS  stream stopped %lus ago - module lost power or the TX wire moved\n",
                  (unsigned long)((ms - gm.lastMs) / 1000UL));
  else if (gm.cGSV == 0)
    Serial.println("  ! GPS  no GSV sentences - module is not reporting satellites at all");
  else if (!fix && gm.view == 0)
    Serial.println("  ! GPS  0 satellites in view - antenna / sky view, not the wiring");
  else if (!fix && gm.view > 0)
    Serial.printf("  ! GPS  %d in view, %d used, q=%d - still locking (needs %d+)\n",
                  gm.view, used, gm.fixQ, GPS_MIN_SATS);

  if (!fix && gm.fixMode == 2)
    Serial.println("  ! GPS  2D fix only (no altitude) - position stays unpublished until 3D");

  if (!mpuValid)
    Serial.println("  ! IMU  MPU6050 not reading - check VCC, GND, SDA, SCL");
}

// ============ BANNER / HELP ============
static const char* resetReasonStr() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "power-on";
    case ESP_RST_EXT:       return "external pin";
    case ESP_RST_SW:        return "software";
    case ESP_RST_PANIC:     return "PANIC - exception";
    case ESP_RST_INT_WDT:   return "interrupt watchdog";
    case ESP_RST_TASK_WDT:  return "task watchdog";
    case ESP_RST_WDT:       return "other watchdog";
    case ESP_RST_DEEPSLEEP: return "deep-sleep wake";
    case ESP_RST_BROWNOUT:  return "BROWNOUT - supply sagged";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "unknown";
  }
}

static void rule(char c) {
  char line[81];
  memset(line, c, 80);
  line[80] = '\0';
  Serial.printf("%s%s%s\n", A(ANSI_DIM), line, A(ANSI_RESET));
}

void printHelp();

void printBanner() {
  uint64_t mac = ESP.getEfuseMac();
  char macStr[18];
  snprintf(macStr, sizeof macStr, "%02X:%02X:%02X:%02X:%02X:%02X",
           (unsigned)(mac & 0xFF), (unsigned)((mac >> 8) & 0xFF),
           (unsigned)((mac >> 16) & 0xFF), (unsigned)((mac >> 24) & 0xFF),
           (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));

  Serial.println();
  rule('=');
  Serial.printf(" %s%s %s%s\n", A(ANSI_BOLD), FW_NAME, FW_VERSION, A(ANSI_RESET));
  Serial.printf(" %sbuilt %s %s%s\n", A(ANSI_DIM), __DATE__, __TIME__, A(ANSI_RESET));
  uint16_t rev = ESP.getChipRevision();
  Serial.printf(" chip  %s rev %u.%u  %u core(s) @ %u MHz  flash %u KB  heap %u KB\n",
                ESP.getChipModel(), (unsigned)(rev / 100), (unsigned)(rev % 100),
                ESP.getChipCores(), (unsigned)ESP.getCpuFreqMHz(),
                (unsigned)(ESP.getFlashChipSize() / 1024), (unsigned)(ESP.getFreeHeap() / 1024));
  Serial.printf(" reset %s   mac %s   boot #%lu\n", resetReasonStr(), macStr,
                (unsigned long)bootCount);
  Serial.printf(" topic %s\n", TOPIC_DATA);
  Serial.printf(" broker %s:%d  keepalive %ds  publish %dms\n",
                MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE_S, PUBLISH_INTERVAL_MS);
  Serial.printf(" gps   uart2  RX=%d  TX=%d  %d/%d/115200 8N1 (UBX re-baud to %d when it answers)\n",
                GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD, GPS_BAUD_FAST, GPS_BAUD_FAST);
  Serial.printf(" pins  i2c SDA=%d SCL=%d @100kHz   leds %d/%d/%d\n",
                I2C_SDA_PIN, I2C_SCL_PIN, LED_BLUE_PIN, LED_WHITE_PIN, LED_RED_PIN);
  rule('=');
  printHelp();
}

void printHelp() {
  Serial.printf("%skeys  g raw nmea | v verbose | c colours | p panel | r yaw=0 | x reboot | ? help%s\n",
                A(ANSI_DIM), A(ANSI_RESET));
  Serial.printf("%sled   d light each LED in turn | y invert polarity (all-on / dark)%s\n",
                A(ANSI_DIM), A(ANSI_RESET));
  Serial.printf("%slap   a gate A here | b gate B here | l clear paint | k show gates%s\n",
                A(ANSI_DIM), A(ANSI_RESET));
}


// ============ SETUP ============
void mqtt_simple_setup() {
  Serial.begin(115200);

  bootCountInit();
  minFreeHeap = ESP.getFreeHeap();


  pinMode(LED_BLUE_PIN, OUTPUT);
  pinMode(LED_WHITE_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  ledLoadPolarity();              // before the first write, or the boot test lies
  ledsOff();

  ledSelfTest("boot");

  // 1 KB RX buffer: a Wi-Fi/MQTT stall must not drop mid-sentence bytes, which
  // would show up as checksum failures in the NMEA tap. 5 Hz at 38400 is also
  // more than one sentence per loop, so the buffer has to hold a burst.
  gpsSerial.setRxBufferSize(2048);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  delay(500);

  gm.lastMs = millis();
  printBanner();

  // Ask the module to run 5 Hz / automotive / static hold / SBAS. Falls back to
  // the power-on defaults when nothing answers on the TX pin.
  gpsUbxConfigure();
  gpsLoadGates();
  odoLoad();
  gm.lastMs = millis();

#if VIEWER_MODE == 0
  // Start Wi-Fi in the background so calibration is not delayed. At boot we do
  // not know which candidate is around, so go straight to the async scan
  // instead of burning 15 s on a guess.
  snprintf(clientId, sizeof clientId, "esp32-dash-%08lX", (unsigned long)ESP.getEfuseMac());
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // No modem sleep: a full 5 Hz telemetry stream must not wait for a beacon
  // interval, and the receiver is on USB power for the whole session anyway.
  WiFi.setSleep(false);
  logMsg(L_INFO, "NET", "scanning for a known network (async)");
  WiFi.scanNetworks(true /*async*/, false);
  wifiPhase = WF_SCANNING;
  wifiPhaseSince = millis();
  lastWifiTry = millis();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(2048);                            // JSON + wifi block fits with room to spare
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT_S);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
#endif

  logMsg(L_INFO, "IMU", "probing MPU6050 on SDA=%d SCL=%d", I2C_SDA_PIN, I2C_SCL_PIN);
  // A missing IMU must not brick the tracker: retry for ~5 s, then carry on
  // with tilt/yaw disabled. The GPS and MQTT link do not need the MPU, and an
  // endless probe loop would also stop the watchdog from ever being armed.
  int tries = 0;
  bool imuPresent = false;
  while (tries++ < 50) {
    if (mpuFind() && mpuInit()) { imuPresent = true; break; }
    ledsFault();
    delay(100);
  }

  float ax = 0, ay = 0, az = 0, t = 0, gx = 0, gy = 0, gz = 0;
  if (imuPresent) {
    logMsg(L_INFO, "CAL", "keep the board still while the gyro zero is measured (about 2 s)");
    ledWrite(LED_WHITE_PIN, true);
    const int N = 500;
    int good = 0;
    float sx = 0, sy = 0, sz = 0;
    for (int i = 0; i < N; i++) {
      if (mpuRead(ax, ay, az, t, gx, gy, gz)) {
        sx += gx; sy += gy; sz += gz;
        good++;
      }
      delay(4);
    }
    if (good > 0) {
      gyroBiasX = sx / good;
      gyroBiasY = sy / good;
      gyroBiasZ = sz / good;
    }
  } else {
    logMsg(L_WARN, "IMU", "MPU6050 absent after 5 s - tilt/yaw disabled, tracker continues");
  }

  delay(1000);

  if (imuPresent && mpuRead(ax, ay, az, t, gx, gy, gz)) {
    roll  = atan2(ay, az) * RAD_TO_DEG;
    pitch = atan2(-ax, sqrt(ay * ay + az * az)) * RAD_TO_DEG;
  }
  yaw = 0;
  mpuValid = imuPresent;
  ledsOff();
  lastMicros = micros();

  bootMillis = millis();

  // History store-and-forward. Starts its own task; must not block the loop.
  historySetLogger(histLog);
  historyBegin();

  if (imuPresent) {
    logMsg(L_OK, "IMU", "MPU6050 at 0x%02X  gyro bias %.2f/%.2f/%.2f dps",
           MPU_ADDR, gyroBiasX, gyroBiasY, gyroBiasZ);
  }

#if HAVE_TASK_WDT
  // Armed here, not at the top of setup: hardware probing is allowed to wait
  // as long as it needs, and a missing MPU6050 must not turn into a boot loop.
  // From this point the loop must keep calling esp_task_wdt_reset() or the chip
  // resets itself and the next payload carries an incremented `sys.boot`.
  esp_err_t wdtErr;
#if defined(ESP_IDF_VERSION_MAJOR) && ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdtCfg = {};
  wdtCfg.timeout_ms = WDT_TIMEOUT_S * 1000UL;
  wdtCfg.idle_core_mask = 0;
  wdtCfg.trigger_panic = true;
  // The Arduino core initialises the TWDT before setup(), and a second init()
  // only logs "TWDT already initialized" at ERROR. status() is the non-logging
  // probe: INVALID_STATE means "not initialised yet"; anything else means
  // "initialised, just retune it".
  if (esp_task_wdt_status(NULL) == ESP_ERR_INVALID_STATE) {
    wdtErr = esp_task_wdt_init(&wdtCfg);
    if (wdtErr == ESP_ERR_INVALID_STATE) wdtErr = esp_task_wdt_reconfigure(&wdtCfg);
  } else {
    wdtErr = esp_task_wdt_reconfigure(&wdtCfg);
    if (wdtErr == ESP_ERR_INVALID_STATE) wdtErr = esp_task_wdt_init(&wdtCfg);
  }
#else
  wdtErr = esp_task_wdt_init(WDT_TIMEOUT_S, true);
  if (wdtErr == ESP_ERR_INVALID_STATE) wdtErr = ESP_OK;  // already initialised
#endif
  if (wdtErr == ESP_OK) {
    // add() returns an error when this task is already subscribed. status()
    // separates that harmless case from a real failure, so the log is honest
    // and the loop never calls reset() on a task that is not registered.
    esp_err_t addErr = esp_task_wdt_add(NULL);
    if (addErr != ESP_OK && esp_task_wdt_status(NULL) == ESP_OK) addErr = ESP_OK;
    if (addErr == ESP_OK)
      logMsg(L_INFO, "SYS", "task watchdog armed (%d s)", WDT_TIMEOUT_S);
    else
      logMsg(L_WARN, "SYS", "task watchdog configured but loop not subscribed (err %d)", (int)addErr);
  } else {
    logMsg(L_WARN, "SYS", "task watchdog unavailable (err %d)", (int)wdtErr);
  }
#endif

  logMsg(L_OK, "SYS", "ready - %s %s", FW_NAME, FW_VERSION);
}

// ============ CONSOLE KEYS ============
static void handleKeys() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    switch (c) {
      case 'g': case 'G':
        showNmea = !showNmea;
        logMsg(L_INFO, "UI", "raw NMEA echo %s", showNmea ? "on" : "off");
        break;
      case 'v': case 'V':
        verbose = !verbose;
        logMsg(L_INFO, "UI", "verbose %s", verbose ? "on" : "off");
        break;
      case 'c': case 'C':
        useColor = !useColor;
        logMsg(L_INFO, "UI", "colours %s", useColor ? "on" : "off");
        break;
      case 'p': case 'P':
        showPanel = !showPanel;
        logMsg(L_INFO, "UI", "panel %s", showPanel ? "on" : "off");
        break;
      case 'r': case 'R':
        yaw = 0;
        logMsg(L_INFO, "IMU", "yaw reset to 0");
        break;
      case 'a': case 'A':
        gpsCaptureGate('a');
        break;
      case 'b': case 'B':
        gpsCaptureGate('b');
        break;
      case 'l': case 'L':
        gpsClearGates();
        break;
      case 'k': case 'K':
        gpsShowGates();
        break;
      case 'd': case 'D':
        ledSelfTest("console");
        break;
      case 'y': case 'Y':
        ledActiveLow = !ledActiveLow;
        ledSavePolarity();
        ledsOff();
        logMsg(L_INFO, "LED", "polarity %s (saved) - press d to verify",
               ledActiveLow ? "active-low (LOW = lit)" : "active-high (HIGH = lit)");
        break;
      case 'x': case 'X':
        logMsg(L_WARN, "SYS", "restart requested from console");
        Serial.flush();
        delay(100);
        ESP.restart();
        break;
      case 't': case 'T':
        if (historySelfTest())
          logMsg(L_OK, "HIST", "self-test queued 3 synthetic frames - watch the HIST line");
        else
          logMsg(L_WARN, "HIST", "self-test needs a -DHISTORY_SELFTEST build and a secret header");
        break;
      case '?': case 'h': case 'H':
        printHelp();
        break;
      default:
        break;
    }
  }
}

// ============ GPS WATCHDOG ============
// Turns the raw counters into events: stream died, stream came back, fix
// acquired/lost, satellites appeared in view. These are the lines worth grepping
// in a long capture.
static int lastFixState = -1;   // -1 unknown, 0 no data, 1 no fix, 2 fix
static int lastView = -1;

static void gpsWatch() {
  unsigned long ms = millis();
  const uint32_t chars = gps.charsProcessed();

  if (chars > 0 && gm.sentences > 0 && ms - gm.lastMs > 3000UL) {
    if (!gm.silent) {
      gm.silent = true;
      lastFixState = -1;
      logMsg(L_WARN, "GPS", "no NMEA for %lus (chars=%lu) - module power or TX wire",
             (unsigned long)((ms - gm.lastMs) / 1000UL), (unsigned long)chars);
    }
  } else if (gm.silent && ms - gm.lastMs < 1000UL) {
    gm.silent = false;
    logMsg(L_OK, "GPS", "NMEA stream resumed");
  }

  static unsigned long lastCheck = 0;
  if (ms - lastCheck < 1000UL) return;
  lastCheck = ms;

  const bool fix = gpsFixUsable();
  const int st = fix ? 2 : (chars > 0 ? 1 : 0);
  if (st != lastFixState) {
    if (st == 2) {
      char hd[12];
      if (gps.hdop.isValid()) snprintf(hd, sizeof hd, "%.2f", gps.hdop.hdop());
      else                    snprintf(hd, sizeof hd, "--");
      logMsg(L_OK, "GPS", "FIX acquired: %d sats used, %d in view, hdop %s",
             (int)gps.satellites.value(), gm.view, hd);
    } else if (st == 1 && lastFixState == 2) {
      logMsg(L_WARN, "GPS", "fix lost");
    } else if (st == 0) {
      logMsg(L_WARN, "GPS", "no NMEA data on the RX pin");
    }
    lastFixState = st;
  }

  if (gm.view != lastView) {
    if (verbose || (gm.view > 0 && lastView <= 0))
      logMsg(L_INFO, "GPS", "satellites in view: %d (best snr %d)", gm.view, gm.snr);
    lastView = gm.view;
  }
}

// ============ LOOP ============
void mqtt_simple_loop() {
#if HAVE_TASK_WDT
  // Proves the loop is still making progress. If it stops, the chip resets.
  esp_task_wdt_reset();
#endif

  {
    const uint32_t heapNow = ESP.getFreeHeap();
    if (heapNow < minFreeHeap) minFreeHeap = heapNow;
    if (!heapWarned && heapNow < HEAP_WARN_BYTES) {
      heapWarned = true;
      logMsg(L_WARN, "SYS", "low heap: %lu B free (boot %lu) - check for a leak",
             (unsigned long)heapNow, (unsigned long)bootCount);
    }
  }

  // Every byte feeds TinyGPSPlus (parsed fields) and the tap (raw sentence
  // stream: counters, GSV view/SNR, checksum failures).
  while (gpsSerial.available()) {
    char gc = (char)gpsSerial.read();
    gps.encode(gc);
    gpsMonFeed(gc);
  }

  handleKeys();
  gpsWatch();
  updateGpsPositioning();

  // GPS odometer: only real displacement counts. The distance is measured from
  // an anchor fix, not from the previous fix. A parked receiver wanders 2-10 m
  // per fix; at 5 Hz a slow car moves less than that per fix, so the anchor is
  // what separates "moved 2 m" from "jittered 2 m" at any fix rate.
  if (gps.location.isUpdated() && gps.location.isValid()) {
    const float newLat = gps.location.lat();
    const float newLng = gps.location.lng();
    const uint32_t nowMs = millis();
    const float kmh = gps.speed.isValid() ? gps.speed.kmph() : 0.0f;
    const bool rolling = gps.speed.isValid() && kmh >= GPS_ODO_MIN_KMH;

    if (!gpsOdoHasAnchor) {
      gpsOdoLat = newLat; gpsOdoLng = newLng; gpsOdoMs = nowMs;
      gpsOdoHasAnchor = true;
    } else if (!rolling) {
      // Parked: the anchor follows every fix, so wander can never accumulate.
      gpsOdoLat = newLat; gpsOdoLng = newLng; gpsOdoMs = nowMs;
    } else {
      const float d = haversineM(gpsOdoLat, gpsOdoLng, newLat, newLng);
      // The cap follows the real fix spacing: a fixed 60 m was 216 km/h at
      // 1 Hz but 1080 km/h at 5 Hz, which is no gate at all.
      float dt = (nowMs - gpsOdoMs) / 1000.0f;
      if (dt <= 0.0f) dt = 1.0f / GPS_NAV_HZ;
      float allowed = kmh * (1.0f / 3.6f) * dt * 1.5f + GPS_ODO_SLACK_M;
      if (allowed > GPS_ODO_MAX_STEP_M) allowed = GPS_ODO_MAX_STEP_M;

      if (d > allowed) {
        // A teleport is not distance: move the anchor, count nothing.
        gpsOdoLat = newLat; gpsOdoLng = newLng; gpsOdoMs = nowMs;
      } else if (d >= GPS_ODO_MIN_STEP_M) {
        gpsDistTotalM += d;
        gpsOdoLat = newLat; gpsOdoLng = newLng; gpsOdoMs = nowMs;
      }
    }
  }
  odoSaveIfNeeded();

  updateMotion();

  if (mpuValid) setLeds(level);
  else ledsFault();

#if VIEWER_MODE == 1
  if (mpuValid && millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    Serial.printf("%.2f,%.2f,%.2f\n", roll, pitch, yaw);
  }
#else
  networkService();
  if (millis() - lastDash >= DASH_INTERVAL_MS) {
    lastDash = millis();
    printStatus();
  }
#endif
}
// MARKER-1793934746
