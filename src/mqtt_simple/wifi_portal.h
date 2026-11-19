/*
 * wifi_portal.h - captive setup portal for Wi-Fi provisioning.
 *
 * The portal is deliberately dependency-free: WebServer and DNSServer ship
 * with the Arduino-ESP32 core, so no new lib_deps are needed. It runs only
 * while provisioning and stops the moment the board reboots into normal
 * tracker mode.
 */
#pragma once

// One-line progress message, already formatted. The tracker routes it into its
// NET log so the portal does not print in a different style.
typedef void (*WifiPortalLog)(const char* line);
void wifiPortalSetLogger(WifiPortalLog sink);

// Start the setup AP and HTTP server. Safe to call when already active.
// Returns false if softAP could not start.
bool wifiPortalBegin();

// Stop the HTTP/DNS servers and the setup AP, returning the radio to STA mode.
void wifiPortalEnd();

// Poll the HTTP server and the deferred restart timer. Call from loop().
void wifiPortalLoop();

bool wifiPortalActive();
const char* wifiPortalSsid();
