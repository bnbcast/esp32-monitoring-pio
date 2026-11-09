/*
 * src/bench/bench_main.cpp - one-shot TLS and ECDSA measurement for W3.
 *
 * Answers two questions the plan requires before the HTTPS batch path is
 * designed:
 *   1. How much heap does a TLS handshake cost, and does limiting the mbedTLS
 *      buffers make it affordable next to the 1 Hz live path?
 *   2. How long does a P-256 ECDSA signature take on this chip, and how much
 *      heap does the key cost?
 *
 * Build and run:
 *   pio run -e esp32-bench -t upload
 *   (serial 115200; every result is one JSON line starting with "BENCH ")
 *
 * Not part of the tracker build: esp32-mqtt-simple filters it out.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_heap_caps.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/entropy.h>

#include "../wifi_config.h"

// Arduino-ESP32 3.x has no setBufferSizes(); mbedTLS buffer sizes come from
// the core Kconfig. What matters for W3 is the cost of a default handshake,
// with and without certificate verification.
static void tlsProbe(const char* host, bool verify) {
  WiFiClientSecure client;
  client.setHandshakeTimeout(8000);           // never let a dead host stall the bench
  if (verify) client.useBuiltinCACertBundle();
  else client.setInsecure();

  uint32_t before = ESP.getFreeHeap();
  uint32_t t0 = millis();
  int rc = client.connect(host, 443);
  uint32_t ms = millis() - t0;
  uint32_t during = ESP.getFreeHeap();
  client.stop();
  uint32_t after = ESP.getFreeHeap();

  Serial.printf(
    "BENCH {\"tls\":\"%s\",\"verify\":%s,\"ok\":%s,\"ms\":%lu,"
    "\"heap_before\":%lu,\"heap_during\":%lu,\"heap_used\":%ld,"
    "\"heap_after_stop\":%lu,\"heap_min\":%lu}\n",
    host, verify ? "true" : "false", rc == 1 ? "true" : "false",
    (unsigned long)ms, (unsigned long)before, (unsigned long)during,
    (long)before - (long)during, (unsigned long)after,
    (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT));

  delay(300);
}

static void ecdsaProbe() {
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context drbg;
  mbedtls_ecdsa_context ecdsa;
  mbedtls_entropy_init(&entropy);
  mbedtls_ctr_drbg_init(&drbg);
  mbedtls_ecdsa_init(&ecdsa);

  uint32_t before = ESP.getFreeHeap();
  int rc = mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy,
                                 (const unsigned char*)"bench", 5);

  uint32_t t0 = millis();
  if (rc == 0) {
    rc = mbedtls_ecdsa_genkey(&ecdsa, MBEDTLS_ECP_DP_SECP256R1,
                              mbedtls_ctr_drbg_random, &drbg);
  }
  uint32_t keyMs = millis() - t0;

  unsigned char hash[32];
  for (int i = 0; i < 32; i++) hash[i] = (unsigned char)i;
  unsigned char sig[80];
  size_t sigLen = 0;
  uint32_t totalUs = 0;
  int signOk = 0;

  if (rc == 0) {
    for (int i = 0; i < 20; i++) {
      sigLen = 0;
      uint32_t s0 = micros();
      int r = mbedtls_ecdsa_write_signature(
        &ecdsa, MBEDTLS_MD_SHA256, hash, sizeof hash,
        sig, sizeof sig, &sigLen, mbedtls_ctr_drbg_random, &drbg);
      totalUs += micros() - s0;
      if (r == 0) signOk++;
    }
  }

  Serial.printf(
    "BENCH {\"ecdsa\":\"p256\",\"ok\":%s,\"keygen_ms\":%lu,\"sign_ok\":%d,"
    "\"sign_us_avg\":%lu,\"sig_len\":%u,\"heap_before\":%lu,\"heap_after\":%lu}\n",
    rc == 0 ? "true" : "false", (unsigned long)keyMs, signOk,
    signOk ? (unsigned long)(totalUs / signOk) : 0UL, (unsigned)sigLen,
    (unsigned long)before, (unsigned long)ESP.getFreeHeap());

  mbedtls_ecdsa_free(&ecdsa);
  mbedtls_ctr_drbg_free(&drbg);
  mbedtls_entropy_free(&entropy);
}

void setup() {
  Serial.begin(115200);
  delay(1200);
  Serial.println();
  Serial.println("BENCH start");
  Serial.printf(
    "BENCH {\"chip\":\"%s\",\"cores\":%d,\"flash_kb\":%lu,\"heap_free\":%lu}\n",
    ESP.getChipModel(), ESP.getChipCores(),
    (unsigned long)(ESP.getFlashChipSize() / 1024), (unsigned long)ESP.getFreeHeap());

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  bool joined = false;
  for (size_t i = 0; i < WIFI_NET_COUNT && !joined; i++) {
    WiFi.begin(WIFI_NETS[i].ssid, WIFI_NETS[i].pass);
    unsigned long t0 = millis();
    while (millis() - t0 < 15000 && WiFi.status() != WL_CONNECTED) delay(200);
    if (WiFi.status() == WL_CONNECTED) {
      joined = true;
    } else {
      WiFi.disconnect(true);
      delay(300);
    }
  }

  Serial.printf(
    "BENCH {\"wifi\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"heap_free\":%lu}\n",
    joined ? "up" : "down", WiFi.localIP().toString().c_str(), WiFi.RSSI(),
    (unsigned long)ESP.getFreeHeap());
  if (!joined) {
    Serial.println("BENCH done (no wifi)");
    return;
  }

  ecdsaProbe();

  // Cloudflare fronts the future Worker. GitHub Pages is irrelevant here: the
  // device never fetches the dashboard.
  tlsProbe("cloudflare.com", false);
  tlsProbe("cloudflare.com", true);
  tlsProbe("cloudflare.com", true);           // repeat, to see heap variance

  Serial.println("BENCH done");
}

void loop() {
  delay(1000);
}
