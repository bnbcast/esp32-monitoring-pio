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
#include <esp_system.h>
#include <stdarg.h>

// ============ NETWORK (EDIT THESE) ============
// Candidate Wi-Fi networks, tried in order against what the ESP32 can see.
// The first one that is actually visible wins, so the board comes up on
// whatever hotspot is around without a reflash. Exact SSID match first, then
// prefix match (e.g. "ESP32_AP2" matches "ESP32"). Empty password = open AP.
struct WifiCandidate { const char* ssid; const char* pass; };
static const WifiCandidate WIFI_NETS[] = {
  { "Gi Joe",  "arduino1234" },
  { "ESP32",   "" },
};
static const size_t WIFI_NET_COUNT = sizeof(WIFI_NETS) / sizeof(WIFI_NETS[0]);

#define MQTT_HOST     "broker.hivemq.com"
#define MQTT_PORT     1883

// Random key that makes your topic unguessable. Anyone who knows it can watch.
// Generate a new one if you ever want to "rotate the lock".
#define TOPIC_KEY     "ea77aca95507194b8e46"
#define TOPIC_DATA    "esp32-dash/" TOPIC_KEY "/data"
#define TOPIC_STATUS  "esp32-dash/" TOPIC_KEY "/status"

#define PUBLISH_INTERVAL_MS 500

// ============ IDENTITY ============
#define FW_NAME     "esp32-dash"
#define FW_VERSION  "1.3.0"

// ============ SERIAL CONSOLE ============
// One framed panel every DASH_INTERVAL_MS plus event lines as they happen.
// Keys: g raw NMEA echo | v verbose | c colours | p panel | ? help
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
#define GPS_MIN_SATS  4
#define GPS_MAX_HDOP  20.0
#define GPS_MAX_KMH   200.0          // anything faster is a bad frame, not a vehicle

// Physical plausibility clamps
#define GYRO_MAX_DPS  500.0f         // MPU6050 configured range is +-500 dps
#define AMPS_MAX      30.0f          // ACS712 30 A module limit

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
#define GPS_TX_PIN    -1
#define ACS_PIN       34     // ADC1 pin: keeps working while Wi-Fi is on
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

// ACS712 sensitivity in V per Ampere: 5A = 0.185, 20A = 0.100, 30A = 0.066
#define ACS_SENS 0.185f
// Divider ratio R2 / (R1 + R2): 10k/22k = 0.6875, 4.7k/10k = 0.6803
#define ACS_DIVIDER 0.6875f
#define ACS_DEADBAND 0.08f

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

float acsOffsetV = 2.5f;
float acsFiltV = 2.5f;
float amps = 0;

float maxTilt = 0;
float peakAmps = 0;

// GPS odometer (device-side cumulative distance)
float gpsDistTotalM = 0;
bool gpsHasPrev = false;
float gpsPrevLat = 0, gpsPrevLng = 0;

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
float acsReadVoltage(int samples);
void acsCalibrate();
void updateCurrent();
bool acsWiringOK();
bool connectMqtt();
void publishData();
void networkService();
void wifiService(unsigned long now);
int8_t pickBestNetwork(int found);
bool gpsFixUsable();

// ============ LEDs ============
void ledsOff() {
  digitalWrite(LED_BLUE_PIN, LOW);
  digitalWrite(LED_WHITE_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);
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
  digitalWrite(LED_BLUE_PIN,  lvl == 0 ? HIGH : (!wifiOk && fast ? HIGH : LOW));
  digitalWrite(LED_WHITE_PIN, lvl == 1 ? HIGH : (!mqttOk && fast ? HIGH : LOW));
  digitalWrite(LED_RED_PIN,   lvl == 2 ? (fast ? HIGH : LOW) : (!wifiOk && !fast ? HIGH : LOW));
}

void ledsFault() {
  bool slow = ((millis() / 500) % 2 == 0);
  digitalWrite(LED_BLUE_PIN,  slow ? HIGH : LOW);
  digitalWrite(LED_WHITE_PIN, slow ? HIGH : LOW);
  digitalWrite(LED_RED_PIN,   slow ? HIGH : LOW);
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

bool mpuRead(float &ax, float &ay, float &az, float &temp,
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

// ============ ACS712 ============
float acsReadVoltage(int samples) {
  uint32_t sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogReadMilliVolts(ACS_PIN);
    delayMicroseconds(200);
  }
  return (sum / (float)samples) / 1000.0f / ACS_DIVIDER;
}

void acsCalibrate() {
  for (int i = 0; i < 20; i++) {
    analogReadMilliVolts(ACS_PIN);
    delay(5);
  }
  acsOffsetV = acsReadVoltage(500);
  acsFiltV = acsOffsetV;
}

void updateCurrent() {
  float v = acsReadVoltage(16);
  acsFiltV = 0.9f * acsFiltV + 0.1f * v;
  amps = (acsFiltV - acsOffsetV) / ACS_SENS;
  if (fabs(amps) < ACS_DEADBAND) amps = 0;
  if (fabs(amps) > peakAmps) peakAmps = fabs(amps);
}

bool acsWiringOK() {
  return (acsFiltV > 0.3f && acsFiltV < 4.9f);
}

// ============ NETWORK ============
// Pick the best visible candidate: exact SSID match beats prefix match, and the
// previously working network wins ties so we do not flap between APs.
int8_t pickBestNetwork(int found) {
  int8_t exact = -1, prefix = -1;
  for (size_t c = 0; c < WIFI_NET_COUNT; c++) {
    for (int i = 0; i < found; i++) {
      String seen = WiFi.SSID(i);
      if (seen == WIFI_NETS[c].ssid) { if (exact < 0) exact = (int8_t)c; }
      else if (seen.startsWith(WIFI_NETS[c].ssid)) { if (prefix < 0) prefix = (int8_t)c; }
    }
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
bool gpsFixUsable() {
  if (!gps.location.isValid()) return false;
  if (!gps.satellites.isValid() || gps.satellites.value() < GPS_MIN_SATS) return false;
  if (gps.hdop.isValid() && gps.hdop.hdop() > GPS_MAX_HDOP) return false;
  return true;
}

void publishData() {
  // A position is only published when the fix is actually usable (enough
  // satellites, sane HDOP); otherwise the fields stay null and the dashboard
  // shows "NO FIX" instead of a wrong place on the map.
  const bool fix = gpsFixUsable();
  char lat[16] = "null", lng[16] = "null", alt[16] = "null", spd[16] = "null";
  if (fix && GPS_DECIMALS >= 0) {
    snprintf(lat, sizeof lat, "%.*f", GPS_DECIMALS, gps.location.lat());
    snprintf(lng, sizeof lng, "%.*f", GPS_DECIMALS, gps.location.lng());
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
  uint32_t epoch = 0;
  if (utc_y >= 2020) {
    epoch = (uint32_t)((utc_y - 1970) * 31556952UL + (utc_mo - 1) * 2629746UL +
                       (utc_d - 1) * 86400UL + utc_h * 3600UL + utc_m * 60UL + utc_s);
  }

  // Sensor plausibility clamps: never publish values the hardware cannot mean.
  float tRoll  = constrain(roll,  -180.0f, 180.0f);
  float tPitch = constrain(pitch, -180.0f, 180.0f);
  float tYaw   = constrain(yaw,   -180.0f, 180.0f);
  float tAmps  = constrain(amps,  -AMPS_MAX, AMPS_MAX);

  txSeq++;

  char b[1200];
  int n = snprintf(b, sizeof b,
    "{\"seq\":%lu,\"ts\":%lu,\"up\":%lu,\"mpu\":%s,\"roll\":%.2f,\"pitch\":%.2f,\"yaw\":%.2f,\"tilt\":%.2f,"
    "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"temp\":%.1f,\"lvl\":%d,"
    "\"warn\":%d,\"danger\":%d,\"maxTilt\":%.1f,\"peakA\":%.2f,"
    "\"acs\":{\"ok\":%s,\"amps\":%.3f,\"v\":%.3f,\"zero\":%.3f},"
    "\"gps\":{\"chars\":%lu,\"view\":%d,\"snr\":%d,\"q\":%d,\"bad\":%lu,"
    "\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
    "\"cog\":%s,\"hdop\":%s,\"dist_m\":%.2f,"
    "\"utc_h\":%d,\"utc_m\":%d,\"utc_s\":%d,\"utc_y\":%d,\"utc_mo\":%d,\"utc_d\":%d},"
    "\"sys\":{\"heap\":%u,\"rssi\":%d,"
    "\"wifi\":{\"ssid\":\"%.32s\",\"bssid\":\"%.17s\",\"channel\":%d,\"status\":\"%s\","
    "\"ip\":\"%.15s\",\"mac\":\"%.17s\"}}}",
    (unsigned long)txSeq, (unsigned long)epoch, (unsigned long)(millis() / 1000),
    mpuValid ? "true" : "false",
    tRoll, tPitch, tYaw, tilt, lax, lay, laz, lt, level,
    (int)WARN_ANGLE, (int)DANGER_ANGLE, maxTilt, peakAmps,
    acsWiringOK() ? "true" : "false", tAmps, acsFiltV, acsOffsetV,
    (unsigned long)gps.charsProcessed(), gm.cGSV ? gm.view : -1, gm.snr, gm.fixQ, (unsigned long)gm.bad,
    (int)gps.satellites.value(),
    fix ? "true" : "false", lat, lng, alt, spd,
    cog, hdop, gpsDistTotalM,
    utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d,
    (unsigned)ESP.getFreeHeap(), WiFi.RSSI(),
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
      "\"lvl\":%d,\"warn\":%d,\"danger\":%d,\"maxTilt\":%.1f,\"peakA\":%.2f,"
      "\"acs\":{\"ok\":%s,\"amps\":%.3f,\"v\":%.3f,\"zero\":%.3f},"
      "\"gps\":{\"chars\":%lu,\"view\":%d,\"snr\":%d,\"q\":%d,\"bad\":%lu,"
      "\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
      "\"cog\":%s,\"hdop\":%s,\"dist_m\":%.2f},"
      "\"sys\":{\"heap\":%u,\"rssi\":%d}}",
      (unsigned long)txSeq, (unsigned long)epoch, (unsigned long)(millis() / 1000),
      mpuValid ? "true" : "false", tRoll, tPitch, tYaw, tilt, level,
      (int)WARN_ANGLE, (int)DANGER_ANGLE, maxTilt, peakAmps,
      acsWiringOK() ? "true" : "false", tAmps, acsFiltV, acsOffsetV,
      (unsigned long)gps.charsProcessed(), gm.cGSV ? gm.view : -1, gm.snr, gm.fixQ, (unsigned long)gm.bad,
      (int)gps.satellites.value(),
      fix ? "true" : "false", lat, lng, alt, spd, cog, hdop, gpsDistTotalM,
      (unsigned)ESP.getFreeHeap(), WiFi.RSSI());
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

  Serial.printf("%s|%s PWR   %6.2f A  peak %5.2f A  zero %.3f V  acs %s%s%s\n",
                A(ANSI_DIM), A(ANSI_RESET),
                amps, peakAmps, acsOffsetV,
                A(acsWiringOK() ? ANSI_GRN : ANSI_RED), acsWiringOK() ? "OK" : "FAIL", A(ANSI_RESET));

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
    Serial.printf("  ! GPS  %d in view, %d used, q=%d - still locking (needs 4+)\n",
                  gm.view, used, gm.fixQ);

  if (!mpuValid)
    Serial.println("  ! IMU  MPU6050 not reading - check VCC, GND, SDA, SCL");
  if (!acsWiringOK())
    Serial.println("  ! PWR  ACS712 out of range - check 5V, GND, OUT, divider");
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
  Serial.printf(" reset %s   mac %s\n", resetReasonStr(), macStr);
  Serial.printf(" topic %s\n", TOPIC_DATA);
  Serial.printf(" broker %s:%d  keepalive %ds  publish %dms\n",
                MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE_S, PUBLISH_INTERVAL_MS);
  Serial.printf(" gps   uart2  RX=%d  TX=%d  9600 8N1\n", GPS_RX_PIN, GPS_TX_PIN);
  Serial.printf(" pins  i2c SDA=%d SCL=%d @100kHz   acs ADC1/%d   leds %d/%d/%d\n",
                I2C_SDA_PIN, I2C_SCL_PIN, ACS_PIN, LED_BLUE_PIN, LED_WHITE_PIN, LED_RED_PIN);
  rule('=');
  printHelp();
}

void printHelp() {
  Serial.printf("%skeys  g raw nmea | v verbose | c colours | p panel | r yaw=0 | z acs zero | x reboot | ? help%s\n",
                A(ANSI_DIM), A(ANSI_RESET));
}


// ============ SETUP ============
void mqtt_simple_setup() {
  Serial.begin(115200);

  pinMode(LED_BLUE_PIN, OUTPUT);
  pinMode(LED_WHITE_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  ledsOff();

  int testPins[] = {LED_BLUE_PIN, LED_WHITE_PIN, LED_RED_PIN};
  for (int i = 0; i < 3; i++) {
    digitalWrite(testPins[i], HIGH);
    delay(300);
    digitalWrite(testPins[i], LOW);
  }

  // 1 KB RX buffer: a Wi-Fi/MQTT stall must not drop mid-sentence bytes, which
  // would show up as checksum failures in the NMEA tap.
  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  analogReadResolution(12);
  analogSetPinAttenuation(ACS_PIN, ADC_11db);
  delay(500);

  gm.lastMs = millis();
  printBanner();

#if VIEWER_MODE == 0
  // Start Wi-Fi in the background so calibration is not delayed. At boot we do
  // not know which candidate is around, so go straight to the async scan
  // instead of burning 15 s on a guess.
  snprintf(clientId, sizeof clientId, "esp32-dash-%08lX", (unsigned long)ESP.getEfuseMac());
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
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
  int tries = 0;
  while (!(mpuFind() && mpuInit())) {
    if (tries++ == 40) logMsg(L_ERR, "IMU", "MPU6050 not found - check VCC, GND, SDA, SCL");
    ledsFault();
    delay(100);
  }

  logMsg(L_INFO, "CAL", "keep the board still, no current in the ACS712 (about 3 s)");
  digitalWrite(LED_WHITE_PIN, HIGH);
  const int N = 500;
  int good = 0;
  float sx = 0, sy = 0, sz = 0;
  float ax, ay, az, t, gx, gy, gz;
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

  delay(1000);
  acsCalibrate();

  if (mpuRead(ax, ay, az, t, gx, gy, gz)) {
    roll  = atan2(ay, az) * RAD_TO_DEG;
    pitch = atan2(-ax, sqrt(ay * ay + az * az)) * RAD_TO_DEG;
  }
  yaw = 0;
  mpuValid = true;
  ledsOff();
  lastMicros = micros();

  bootMillis = millis();

  logMsg(L_OK, "IMU", "MPU6050 at 0x%02X  gyro bias %.2f/%.2f/%.2f dps",
         MPU_ADDR, gyroBiasX, gyroBiasY, gyroBiasZ);
  if (acsOffsetV >= 2.3f && acsOffsetV <= 2.55f)
    logMsg(L_OK, "PWR", "ACS712 zero %.3f V (expected 2.3-2.5 V)", acsOffsetV);
  else
    logMsg(L_WARN, "PWR", "ACS712 zero %.3f V - outside 2.3-2.5 V, check 5V/GND/OUT", acsOffsetV);
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
      case 'z': case 'Z':
        acsCalibrate();
        peakAmps = 0;
        logMsg(L_OK, "PWR", "ACS712 re-zeroed at %.3f V", acsOffsetV);
        break;
      case 'x': case 'X':
        logMsg(L_WARN, "SYS", "restart requested from console");
        Serial.flush();
        delay(100);
        ESP.restart();
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
  // Every byte feeds TinyGPSPlus (parsed fields) and the tap (raw sentence
  // stream: counters, GSV view/SNR, checksum failures).
  while (gpsSerial.available()) {
    char gc = (char)gpsSerial.read();
    gps.encode(gc);
    gpsMonFeed(gc);
  }

  handleKeys();
  gpsWatch();

  // GPS odometer: accumulate distance on valid location updates
  if (gps.location.isUpdated() && gps.location.isValid()) {
    float newLat = gps.location.lat();
    float newLng = gps.location.lng();
    if (gpsHasPrev) {
      float d = haversineM(gpsPrevLat, gpsPrevLng, newLat, newLng);
      if (d > 2.0f) {          // jitter filter: ignore sub-2 m drift
        gpsDistTotalM += d;
      }
    }
    gpsPrevLat = newLat;
    gpsPrevLng = newLng;
    gpsHasPrev = true;
  }

  updateCurrent();
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
