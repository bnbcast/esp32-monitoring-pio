/*
 * Orion Project — ESP32 firmware entry point
 *
 * Build environments (see platformio.ini):
 *   pio run -e esp32-mqtt-simple   -> MQTT, single Wi-Fi network  (secret.txt)
 *   pio run -e esp32-mqtt-failover -> MQTT, multi-network failover (testno3.ino)
 *
 * Select with: pio run -e esp32-mqtt-simple   or   pio run -e esp32-mqtt-failover
 */

#if defined(USE_MQTT_SIMPLE)
#include "mqtt_simple/mqtt_simple.h"
void setup() { mqtt_simple_setup(); }
void loop()  { mqtt_simple_loop(); }

#elif defined(USE_MQTT_FAILOVER)
#include "mqtt_failover/mqtt_failover.h"
void setup() { mqtt_failover_setup(); }
void loop()  { mqtt_failover_loop(); }

#else
#error "No MQTT variant selected. Build with -e esp32-mqtt-simple or -e esp32-mqtt-failover"
#endif
