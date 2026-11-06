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
void printStatus();
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
      Serial.printf("Wi-Fi: connected to '%s'  ip=%s  rssi=%d dBm  ch=%d  (slot %d)\n",
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
        Serial.printf("Wi-Fi: retrying '%s'...\n", WIFI_NETS[lastGoodNet].ssid);
        WiFi.begin(WIFI_NETS[lastGoodNet].ssid, WIFI_NETS[lastGoodNet].pass);
        wifiPhase = WF_CONNECTING;
        wifiPhaseSince = now;
      } else {
        Serial.println("Wi-Fi: scanning (async)...");
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
        Serial.println("Wi-Fi: scan failed");
        wifiPhase = WF_IDLE;
        return;
      }
      int8_t best = pickBestNetwork(found);
      Serial.printf("Wi-Fi: %d network(s) visible, best candidate=%s\n",
                    found, best >= 0 ? WIFI_NETS[best].ssid : "none");
      WiFi.scanDelete();
      if (best >= 0) {
        Serial.printf("Wi-Fi: connecting to '%s'%s\n", WIFI_NETS[best].ssid,
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
        Serial.printf("Wi-Fi: association timeout (status=%d), backing off\n", (int)WiFi.status());
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
  Serial.printf("MQTT: connecting to %s:%d ... ", MQTT_HOST, MQTT_PORT);
  // Last will: if the ESP32 vanishes, the broker publishes "offline" for us
  if (mqtt.connect(clientId, nullptr, nullptr, TOPIC_STATUS, 0, true, "offline")) {
    mqtt.publish(TOPIC_STATUS, "online", true);
    Serial.println("OK");
    mqttBackoff = MQTT_BACKOFF_MIN_MS;
    mqttWasConnected = true;
    lastPublishOk = millis();          // watchdog baseline
    return true;
  }
  Serial.printf("failed (state=%d), next try in %lus\n",
                mqtt.state(), mqttBackoff / 1000);
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
    "\"gps\":{\"chars\":%lu,\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
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
    (unsigned long)gps.charsProcessed(), (int)gps.satellites.value(),
    fix ? "true" : "false", lat, lng, alt, spd,
    cog, hdop, gpsDistTotalM,
    utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d,
    (unsigned)ESP.getFreeHeap(), WiFi.RSSI(),
    WiFi.SSID().c_str(), WiFi.BSSIDstr().c_str(), WiFi.channel(), wifiStatusStr(),
    WiFi.localIP().toString().c_str(), WiFi.macAddress().c_str());

  if (n < 0) {                       // snprintf failure
    Serial.println("!! payload snprintf failed, reading dropped");
    txFail++;
    return;
  }
  if (n >= (int)sizeof b) {          // would be truncated: send the slim form
    Serial.printf("!! payload truncated (%d >= %d), publishing slim variant\n", n, (int)sizeof b);
    n = snprintf(b, sizeof b,
      "{\"seq\":%lu,\"ts\":%lu,\"up\":%lu,\"mpu\":%s,\"roll\":%.2f,\"pitch\":%.2f,\"yaw\":%.2f,\"tilt\":%.2f,"
      "\"lvl\":%d,\"warn\":%d,\"danger\":%d,\"maxTilt\":%.1f,\"peakA\":%.2f,"
      "\"acs\":{\"ok\":%s,\"amps\":%.3f,\"v\":%.3f,\"zero\":%.3f},"
      "\"gps\":{\"chars\":%lu,\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
      "\"cog\":%s,\"hdop\":%s,\"dist_m\":%.2f},"
      "\"sys\":{\"heap\":%u,\"rssi\":%d}}",
      (unsigned long)txSeq, (unsigned long)epoch, (unsigned long)(millis() / 1000),
      mpuValid ? "true" : "false", tRoll, tPitch, tYaw, tilt, level,
      (int)WARN_ANGLE, (int)DANGER_ANGLE, maxTilt, peakAmps,
      acsWiringOK() ? "true" : "false", tAmps, acsFiltV, acsOffsetV,
      (unsigned long)gps.charsProcessed(), (int)gps.satellites.value(),
      fix ? "true" : "false", lat, lng, alt, spd, cog, hdop, gpsDistTotalM,
      (unsigned)ESP.getFreeHeap(), WiFi.RSSI());
    if (n <= 0 || n >= (int)sizeof b) { txFail++; return; }
  }

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
      Serial.printf("MQTT: link lost after %lu ok publishes\n", (unsigned long)txOk);
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
    Serial.printf("MQTT: watchdog - nothing delivered for %lus, reconnecting\n",
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

// ============ SERIAL STATUS LINE ============
// One aligned line for the monitor. Everything a human needs to decide whether
// the device is healthy is on it: link state, GPS state, delivery counters.
void printStatus() {
  unsigned long up = (millis() - bootMillis) / 1000;
  const char* wifi = (WiFi.status() == WL_CONNECTED) ? "OK  " : "DOWN";
  const char* mq = mqtt.connected() ? "OK  " : "DOWN";
  int sats = (int)gps.satellites.value();

  char gpsTxt[40];
  if (!gps.charsProcessed())            snprintf(gpsTxt, sizeof gpsTxt, "NO DATA");
  else if (gpsFixUsable())              snprintf(gpsTxt, sizeof gpsTxt, "FIX   %2d sats", sats);
  else                                  snprintf(gpsTxt, sizeof gpsTxt, "NO FIX %2d sats", sats);

  char rssiTxt[12];
  if (WiFi.status() == WL_CONNECTED) snprintf(rssiTxt, sizeof rssiTxt, "%ddBm", (int)WiFi.RSSI());
  else                               snprintf(rssiTxt, sizeof rssiTxt, "  --");

  Serial.printf("[%5lus] tilt=%5.1f %s | %6.2fA pk%5.2f | GPS %-12s | wifi %s %6s | mqtt %s | "
                "seq=%lu ok=%lu fail=%lu drop=%lu q=%u | heap=%uK\n",
                up, tilt, level == 2 ? "DANGER" : (level == 1 ? "WARN  " : "safe  "),
                amps, peakAmps, gpsTxt, wifi, rssiTxt, mq,
                (unsigned long)txSeq, (unsigned long)txOk, (unsigned long)txFail,
                (unsigned long)txDrop, (unsigned)txqCount,
                (unsigned)(ESP.getFreeHeap() / 1024));

  if (!mpuValid)      Serial.println("  !! MPU6050 NOT READING - check VCC, GND, SDA, SCL");
  if (!acsWiringOK()) Serial.println("  !! ACS712 out of range - check VCC 5V, GND, OUT, divider");
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

  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  analogReadResolution(12);
  analogSetPinAttenuation(ACS_PIN, ADC_11db);
  delay(500);

  Serial.println();
  Serial.println("=== ESP32 dash | MQTT ===");
  Serial.printf("topic  : %s\n", TOPIC_DATA);
  Serial.printf("broker : %s:%d  keepalive=%ds\n", MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE_S);
  Serial.println("=========================");

#if VIEWER_MODE == 0
  // Start Wi-Fi in the background so calibration is not delayed. At boot we do
  // not know which candidate is around, so go straight to the async scan
  // instead of burning 15 s on a guess.
  snprintf(clientId, sizeof clientId, "esp32-dash-%08lX", (unsigned long)ESP.getEfuseMac());
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  Serial.println("Wi-Fi: scanning (async) for a known network...");
  WiFi.scanNetworks(true /*async*/, false);
  wifiPhase = WF_SCANNING;
  wifiPhaseSince = millis();
  lastWifiTry = millis();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(2048);                            // JSON + wifi block fits with room to spare
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT_S);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
#endif

  int tries = 0;
  while (!(mpuFind() && mpuInit())) {
    if (tries++ == 40) Serial.println("MPU6050 not found - check VCC, GND, SDA, SCL");
    ledsFault();
    delay(100);
  }

  Serial.println("Calibrating (about 3 seconds): keep the board still, no current in ACS712...");
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

  Serial.printf("MPU6050 found at 0x%02X\n", MPU_ADDR);
  Serial.printf("ACS712 zero-current level: %.3f V (about 2.3 to 2.5 V is normal)\n", acsOffsetV);
  Serial.println("Ready");
  bootMillis = millis();
}

// ============ LOOP ============
void mqtt_simple_loop() {
  while (gpsSerial.available()) gps.encode(gpsSerial.read());

  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'r' || c == 'R') yaw = 0;
    if (c == 'z' || c == 'Z') {
      acsCalibrate();
      peakAmps = 0;
      Serial.println("ACS712 re-zeroed");
    }
  }

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
