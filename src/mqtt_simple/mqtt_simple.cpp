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

// GPS privacy: decimals published for latitude/longitude.
//   2 = about 1.1 km accuracy (default)   3 = about 110 m   6 = exact
//  -1 = never publish coordinates (only fix status, satellites, altitude, speed)
#define GPS_DECIMALS  2

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
  digitalWrite(LED_BLUE_PIN,  lvl == 0 ? HIGH : LOW);
  digitalWrite(LED_WHITE_PIN, lvl == 1 ? HIGH : LOW);
  digitalWrite(LED_RED_PIN,   (lvl == 2 && fast) ? HIGH : LOW);
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
// Scan once, then connect to the first candidate network that is visible.
// Keeps the board usable on several hotspots without reflashing.
bool connectBestWifi() {
  int n = WiFi.scanNetworks();
  if (n <= 0) {
    Serial.println("Wi-Fi: scan found no networks, retrying primary");
    WiFi.begin(WIFI_NETS[0].ssid, WIFI_NETS[0].pass);
    return false;
  }

  int best = -1;
  for (size_t c = 0; c < WIFI_NET_COUNT && best < 0; c++) {
    for (int i = 0; i < n; i++) {
      String seen = WiFi.SSID(i);
      if (seen == WIFI_NETS[c].ssid || seen.startsWith(WIFI_NETS[c].ssid)) { best = (int)c; break; }
    }
  }
  WiFi.scanDelete();

  if (best < 0) {
    Serial.printf("Wi-Fi: %d network(s) visible, none matches a candidate, retrying '%s'\n",
                  n, WIFI_NETS[0].ssid);
    WiFi.begin(WIFI_NETS[0].ssid, WIFI_NETS[0].pass);
    return false;
  }

  Serial.printf("Wi-Fi: connecting to '%s'%s\n", WIFI_NETS[best].ssid,
                WIFI_NETS[best].pass[0] ? "" : " (open)");
  WiFi.begin(WIFI_NETS[best].ssid, WIFI_NETS[best].pass);
  return true;
}

const char* wifiStatusStr() {
  switch (WiFi.status()) {
    case WL_CONNECTED:     return "Connected";
    case WL_NO_SSID_AVAIL: return "No SSID";
    case WL_CONNECT_FAILED:return "Connect failed";
    case WL_IDLE_STATUS:   return "Idle";
    case WL_DISCONNECTED:  return "Disconnected";
    default:               return "Unknown";
  }
}

bool connectMqtt() {
  Serial.print("MQTT: connecting... ");
  // Last will: if the ESP32 vanishes, the broker publishes "offline" for us
  if (mqtt.connect(clientId, nullptr, nullptr, TOPIC_STATUS, 0, true, "offline")) {
    mqtt.publish(TOPIC_STATUS, "online", true);
    Serial.println("connected");
    return true;
  }
  Serial.printf("failed (rc=%d), will retry\n", mqtt.state());
  return false;
}

void publishData() {
  const bool fix = gps.location.isValid();
  char lat[16] = "null", lng[16] = "null", alt[16] = "null", spd[16] = "null";
  if (fix && GPS_DECIMALS >= 0) {
    snprintf(lat, sizeof lat, "%.*f", GPS_DECIMALS, gps.location.lat());
    snprintf(lng, sizeof lng, "%.*f", GPS_DECIMALS, gps.location.lng());
  }
  if (gps.altitude.isValid()) snprintf(alt, sizeof alt, "%.0f", gps.altitude.meters());
  if (gps.speed.isValid())    snprintf(spd, sizeof spd, "%.1f", gps.speed.kmph());

  char cog[16] = "null", hdop[16] = "null";
  if (gps.course.isValid())   snprintf(cog, sizeof cog, "%.1f", gps.course.deg());
  if (gps.hdop.isValid())     snprintf(hdop, sizeof hdop, "%.2f", gps.hdop.hdop());

  int utc_h = 0, utc_m = 0, utc_s = 0;
  int utc_y = 0, utc_mo = 0, utc_d = 0;
  if (gps.time.isValid())  { utc_h = gps.time.hour();  utc_m = gps.time.minute();  utc_s = gps.time.second(); }
  if (gps.date.isValid())  { utc_y = gps.date.year();  utc_mo = gps.date.month();  utc_d = gps.date.day(); }

  char b[1200];
  int n = snprintf(b, sizeof b,
    "{\"up\":%lu,\"mpu\":%s,\"roll\":%.2f,\"pitch\":%.2f,\"yaw\":%.2f,\"tilt\":%.2f,"
    "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"temp\":%.1f,\"lvl\":%d,"
    "\"warn\":%d,\"danger\":%d,\"maxTilt\":%.1f,\"peakA\":%.2f,"
    "\"acs\":{\"ok\":%s,\"amps\":%.3f,\"v\":%.3f,\"zero\":%.3f},"
    "\"gps\":{\"chars\":%lu,\"sats\":%d,\"fix\":%s,\"lat\":%s,\"lng\":%s,\"alt\":%s,\"kmh\":%s,"
    "\"cog\":%s,\"hdop\":%s,\"dist_m\":%.2f,"
    "\"utc_h\":%d,\"utc_m\":%d,\"utc_s\":%d,\"utc_y\":%d,\"utc_mo\":%d,\"utc_d\":%d},"
    "\"sys\":{\"heap\":%u,\"rssi\":%d,"
    "\"wifi\":{\"ssid\":\"%.32s\",\"bssid\":\"%.17s\",\"channel\":%d,\"status\":\"%s\","
    "\"ip\":\"%.15s\",\"mac\":\"%.17s\"}}}",
    (unsigned long)(millis() / 1000), mpuValid ? "true" : "false",
    roll, pitch, yaw, tilt, lax, lay, laz, lt, level,
    (int)WARN_ANGLE, (int)DANGER_ANGLE, maxTilt, peakAmps,
    acsWiringOK() ? "true" : "false", amps, acsFiltV, acsOffsetV,
    (unsigned long)gps.charsProcessed(), (int)gps.satellites.value(),
    fix ? "true" : "false", lat, lng, alt, spd,
    cog, hdop, gpsDistTotalM,
    utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d,
    (unsigned)ESP.getFreeHeap(), WiFi.RSSI(),
    WiFi.SSID().c_str(), WiFi.BSSIDstr().c_str(), WiFi.channel(), wifiStatusStr(),
    WiFi.localIP().toString().c_str(), WiFi.macAddress().c_str());

  if (n > 0 && n < (int)sizeof b) {
    mqtt.publish(TOPIC_DATA, b, true);   // retained: new viewers get the last reading at once
  }
}

// Called every loop. Never blocks for long and never stops the sensors.
void networkService() {
#if VIEWER_MODE == 0
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry > 15000) {          // give each attempt 15 s
      lastWifiTry = now;
      Serial.println("Wi-Fi: (re)connecting...");
      WiFi.disconnect();
      connectBestWifi();
    }
    return;
  }

  if (!mqtt.connected()) {
    if (now - lastMqttTry > 5000) {
      lastMqttTry = now;
      connectMqtt();
    }
    return;
  }

  mqtt.loop();
  if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = now;
    publishData();
  }
#endif
}

// ============ SERIAL STATUS LINE ============
void printStatus() {
  Serial.printf("[%lus] tilt=%.0f lvl=%d | %.2fA | sats=%d%s | wifi=%s mqtt=%s | heap=%uKB\n",
                (unsigned long)(millis() / 1000),
                tilt, level, amps,
                (int)gps.satellites.value(),
                gps.location.isValid() ? " FIX" : "",
                WiFi.status() == WL_CONNECTED ? "ok" : "down",
                mqtt.connected() ? "ok" : "down",
                (unsigned)(ESP.getFreeHeap() / 1024));
  if (!mpuValid)       Serial.println("  MPU6050 NOT READING - check VCC, GND, SDA, SCL");
  if (!acsWiringOK())  Serial.println("  ACS712 out of range - check VCC 5V, GND, OUT, divider");
  if (gps.charsProcessed() < 10) Serial.println("  GPS NO DATA - check GPS TX wire to GPIO25, VCC, GND");
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
  Serial.println("ESP32 sensor dashboard (MQTT) starting...");

#if VIEWER_MODE == 0
  // Start Wi-Fi in the background so calibration is not delayed
  snprintf(clientId, sizeof clientId, "esp32-dash-%08lX", (unsigned long)ESP.getEfuseMac());
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  connectBestWifi();
  lastWifiTry = millis();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setSocketTimeout(3);
  mqtt.setKeepAlive(15);
#endif

  int tries = 0;
  while (!(mpuFind() && mpuInit())) {
    if (tries++ % 10 == 0) Serial.println("MPU6050 not found - check VCC, GND, SDA, SCL");
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
#if VIEWER_MODE == 0
  Serial.println("Publishing to topic: " TOPIC_DATA);
#endif
  Serial.println("Ready");
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
