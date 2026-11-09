# dev/pio_network_lib.py - add the bundled "Networking" library on Arduino-ESP32 3.3.x.
#
# WiFiGeneric.h does `#include "Network.h"`, but 3.3.x moved that header (and
# the NetworkClient/Server/Udp sources) into libraries/Network, whose
# library.properties is named "Networking". PlatformIO's dependency finder does
# not select it, and bundled libraries are compiled with only their own src on
# the include path, so a clean Linux checkout fails with:
#
#   WiFiGeneric.h:44:10: fatal error: Network.h: No such file or directory
#
# Older installs that still carry Network.h inside WiFi/src already build; this
# script detects that layout and does nothing, avoiding duplicate definitions.
#
# Tested by hiding WiFi/src/Network.h, which reproduces a clean checkout.

Import("env")
import os

framework = env.PioPlatform().get_package_dir("framework-arduinoespressif32")
network_src = os.path.join(framework, "libraries", "Network", "src")
umbrella = os.path.join(framework, "libraries", "WiFi", "src", "Network.h")

if os.path.isdir(network_src) and not os.path.isfile(umbrella):
    env.Append(CPPPATH=[network_src])
    env.BuildSources(
        os.path.join("$BUILD_DIR", "network-lib"),
        network_src,
        src_filter=["+<*.cpp>"],
    )
