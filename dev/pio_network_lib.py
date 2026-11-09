# dev/pio_network_lib.py - add bundled framework libraries that PlatformIO's
# dependency finder misses on Arduino-ESP32 3.3.x.
#
# Two separate symptoms, one cause: 3.3.x moved code into framework libraries
# whose library.properties no longer declares its dependencies, and PlatformIO
# compiles each bundled library with only its own src/ on the include path.
#
#   1. WiFiGeneric.h does `#include "Network.h"`, but Network.h lives in
#      libraries/Network, whose library.properties is named "Networking":
#        WiFiGeneric.h:44:10: fatal error: Network.h: No such file or directory
#
#   2. LittleFS.h does `#include "FS.h"`, but FS.h lives in libraries/FS and
#      LittleFS does not declare `depends=FS`:
#        LittleFS.h:21:10: fatal error: FS.h: No such file or directory
#
# Older installs that still carry Network.h inside WiFi/src are detected and
# skipped for the Network case, so no symbols are defined twice. FS is added
# only when the header is not already reachable from the WiFi tree.
#
# Reproduced by a clean checkout; verified by `pio run` on Windows and Linux.

Import("env")
import os

framework = env.PioPlatform().get_package_dir("framework-arduinoespressif32")


def add_bundled(name, subdir, skip_if):
    src = os.path.join(framework, "libraries", subdir, "src")
    if not os.path.isdir(src):
        return
    if skip_if and os.path.isfile(skip_if):
        return
    env.Append(CPPPATH=[src])
    env.BuildSources(
        os.path.join("$BUILD_DIR", name + "-lib"),
        src,
        src_filter=["+<*.cpp>"],
    )


add_bundled(
    "network",
    "Network",
    os.path.join(framework, "libraries", "WiFi", "src", "Network.h"),
)

add_bundled(
    "fs",
    "FS",
    os.path.join(framework, "libraries", "WiFi", "src", "FS.h"),
)
