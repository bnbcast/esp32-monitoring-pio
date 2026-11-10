/*
 * Glossary data for the INFO tab.
 *
 * Plain data so it can be read without a browser: test/info.test.js parses this
 * file and fails if a panel shows a field that is not explained here. The
 * renderer (ui/info.js) turns it into a searchable, filterable list.
 *
 * `d` may contain <b> and HTML entities; it is authored text, inserted with
 * innerHTML. `short` is the chip label.
 */
window.INFO_INTRO =
  "Tap an area, then a term. Search jumps straight to it. " +
  "GREEN = healthy, YELLOW = waiting, RED = a problem.";

window.INFO_GROUPS = [
  {
    "id": "pills",
    "title": "Status pills",
    "short": "Pills",
    "terms": [
      { "t": "BROKER", "d": "<b>BROKER OK</b> = this page's WebSocket to the broker is open. <b>BROKER ...</b> = still connecting, or reconnecting after a drop." },
      { "t": "DEVICE", "d": "<b>DEVICE LIVE</b> = a frame arrived in the last 6 seconds. <b>NO SIGNAL</b> = the link is fine but the board went quiet. <b>DEVICE OFFLINE</b> = the board announced it is going away (shutdown, Wi-Fi loss, power cut)." },
      { "t": "ACS", "d": "<b>ACS OK</b> = the firmware found the current sensor: its zero sits near half supply (~2.5 V) and the amps are plausible. <b>ACS CHECK</b> = floating pin, wrong wiring, or impossible readings, so current is not trustworthy." },
      { "t": "MPU6050", "d": "<b>MPU OK</b> = the tilt sensor answered and its numbers passed the range check. <b>MPU FAIL</b> = missing or unreadable, so tilt and the danger lights are unknown." },
      { "t": "GPS", "d": "<b>GPS FIX</b> = the receiver has a valid position. <b>GPS WAIT</b> = serial data is arriving but there is no fix yet (indoors, or a cold start: can take minutes). <b>GPS NO DATA</b> = nothing on the serial line (wiring or baud rate)." }
    ]
  },
  {
    "id": "map",
    "title": "Map corner",
    "short": "Map",
    "terms": [
      { "t": "SPEED (map)", "d": "Ground speed of the last fix, km/h. Shows <b>0.0</b> while the page agrees the vehicle is parked (receivers report 1&ndash;2 km/h of noise) and <b>NO FIX</b> when there is no position." },
      { "t": "TRIP", "d": "Length of the trail this page has drawn since it was opened. It is not stored anywhere and returns to 0 on reload." },
      { "t": "HEADING (map)", "d": "Direction of travel in degrees: 0 = north, 90 = east, 180 = south. Taken from GPS when moving with a good HDOP, otherwise from the MPU6050, so it can be a couple of degrees off." },
      { "t": "Position", "d": "Latitude and longitude of the last valid fix, plus the nearest street address (OpenStreetMap). <b>locating address...</b> means it is still resolving; the numbers above it are already current." },
      { "t": "MEASURE A&rarr;B", "d": "Operator tool: tap two points on the map to get the distance between them. Nothing is uploaded." }
    ]
  },
  {
    "id": "live",
    "title": "LIVE tab",
    "short": "Live",
    "terms": [
      { "t": "Speed", "d": "Same value as the map corner: last GPS ground speed in km/h." },
      { "t": "Altitude", "d": "GPS altitude in metres. Noisy by &plusmn;5&ndash;10 m and not barometric, so treat small changes as noise." },
      { "t": "Sats", "d": "Satellites used in the current fix. 6 or more works, 9&ndash;12 is good, under 4 means no fix." },
      { "t": "HDOP", "d": "Horizontal dilution of precision: a geometry score, <b>lower is better</b>. Under 2 is excellent, 2&ndash;5 is good, over 8 is poor. Above 8 the firmware stops publishing a position even though it still has a fix, which is why you can see satellites but <b>NO FIX</b>." },
      { "t": "Fix", "d": "<b>VALID</b> = the receiver says the position is usable. <b>NO FIX</b> = it does not, so coordinates are sent as empty." },
      { "t": "Heading", "d": "Course in degrees, from GPS or MPU6050 (see map corner)." },
      { "t": "Tilt", "d": "How far the vehicle is leaning, from the MPU6050, in degrees. This is the number the danger lights use." },
      { "t": "Amps", "d": "Current in amperes from the ACS712. <b>ERR</b> means the sensor is not present or not calibrated, so the number would be fiction." },
      { "t": "Odometer", "d": "Distance in metres the <b>firmware</b> has counted since it booted, minus any reset you did in this browser. It drops to 0 when the board reboots; the reset button (unlocked) zeroes it just for this browser." },
      { "t": "Trail", "d": "Distance in km of the breadcrumb line on the map. Browser-side only: reload clears it." },
      { "t": "Address", "d": "Nearest street to the last fix, as resolved above. It lags the coordinates slightly because the lookup is rate-limited." },
      { "t": "Max Speed", "d": "Fastest speed this page has seen since it opened, not the device's all-time record." },
      { "t": "Seq", "d": "The device's frame counter. It rises by about 1 per second; a jump means frames were lost in transit." },
      { "t": "Gaps", "d": "How many frames went missing between Seq jumps since this page opened. A few after a Wi-Fi hiccup is normal (live MQTT is best-effort); stored history is unaffected because the board uploads it separately from flash." },
      { "t": "Age", "d": "Seconds since the last frame reached <b>this browser</b>. About 1 s is normal; over 6 s and DEVICE turns to NO SIGNAL." },
      { "t": "Device Time", "d": "The board's UTC clock (hh:mm:ss), set from GPS. <b>no clock</b> means it has not seen a GPS time yet; stored fixes are stamped with the same clock." },
      { "t": "GPS Lat / GPS Lng / GPS Alt / GPS Spd", "d": "The same position and speed again, raw, for copying or checking against another device. They follow Fix: <b>NO FIX</b> when there is no position." },
      { "t": "Uptime", "d": "Seconds since the board booted. A number that starts over means it rebooted." },
      { "t": "RSSI", "d": "Wi-Fi signal at the board, in dBm. &minus;50 is excellent, &minus;70 is fine, &minus;85 is weak, below &minus;90 causes dropouts." },
      { "t": "Heap", "d": "Free RAM right now, in KB. High hundreds is healthy on this build; a value that keeps shrinking over hours means a leak." },
      { "t": "GPS Sats", "d": "Satellite count again, straight from the receiver." }
    ]
  },
  {
    "id": "leds",
    "title": "Danger lights",
    "short": "Lights",
    "terms": [
      { "t": "BLUE safe", "d": "Tilt is below the warning angle. Normal driving." },
      { "t": "WHITE warn", "d": "Tilt passed the warning angle (30&deg; by default): the vehicle is leaning more than it should." },
      { "t": "RED danger", "d": "Tilt passed the danger angle (50&deg; by default): likely a crash or rollover." },
      { "t": "all off", "d": "No MPU6050 data, so the page cannot judge. This is accident indication only, not a lock and not a security feature." }
    ]
  },
  {
    "id": "wifi",
    "title": "WIFI tab",
    "short": "WiFi",
    "terms": [
      { "t": "Uptime (WIFI)", "d": "Same as LIVE: seconds since boot." },
      { "t": "WiFi RSSI", "d": "Signal strength at the board in dBm (&minus;50 great &rarr; &minus;90 unusable)." },
      { "t": "Free Heap", "d": "Free RAM right now, in KB. Healthy readings sit well above the lowest point this build has ever needed." },
      { "t": "Min Heap", "d": "The <b>lowest</b> free RAM since boot. This is the leak detector: Free Heap bounces, Min Heap only falls." },
      { "t": "Boots", "d": "How many times the board has started. Climbing on its own means crashes or brownouts." },
      { "t": "Last Update", "d": "Local time this browser last received a frame." },
      { "t": "SSID / BSSID", "d": "Wi-Fi network name, and the MAC of the access point it is attached to (useful when a venue has several identical hotspots)." },
      { "t": "Channel", "d": "Wi-Fi channel in use. 1/6/11 are the non-overlapping 2.4 GHz ones." },
      { "t": "Status (WIFI)", "d": "Association state reported by the board." },
      { "t": "IP Address", "d": "The board's address on the local network." },
      { "t": "MAC", "d": "The board's own Wi-Fi MAC. Use it in a DHCP reservation so the address never changes." }
    ]
  },
  {
    "id": "mpu",
    "title": "MPU tab",
    "short": "MPU",
    "terms": [
      { "t": "Temp", "d": "Chip temperature in &deg;C, a few degrees above ambient. It is not engine or air temperature." },
      { "t": "Roll / Pitch", "d": "Lean left-right (roll) and nose up-down (pitch) in degrees, from gravity." },
      { "t": "Yaw", "d": "Turn around the vertical axis, in degrees, integrated from the gyro. It drifts over time because there is no magnetometer, so trust GPS HEADING when moving." },
      { "t": "Max Tilt", "d": "The largest tilt seen since boot. It survives nothing: a reboot clears it." },
      { "t": "Accel X / Accel Y / Accel Z", "d": "Acceleration in g (1 g = gravity). Sitting still, one axis reads about &plusmn;1 and the others near 0. Cornering and bumps show up here." },
      { "t": "Tilt (MPU)", "d": "Current combined tilt: the angle that drives the danger lights." },
      { "t": "Warn at / Danger at", "d": "The thresholds in force, in degrees. The board uses the same values to pick the LED level." },
      { "t": "tilt history", "d": "The last 120 samples (about two minutes at one frame per second) drawn as a line, so a spike is visible even after it passed." }
    ]
  },
  {
    "id": "acs",
    "title": "ACS tab",
    "short": "ACS",
    "terms": [
      { "t": "Module V", "d": "Sensor output voltage with the divider undone. At 0 A it should sit near 2.5 V; far from that means the sensor is unplugged or the pin is floating." },
      { "t": "Zero", "d": "The voltage treated as 0 A. Calibrated once, because every module is slightly different." },
      { "t": "Current", "d": "(Module V &minus; Zero) &divide; sensitivity, in amperes. Signed: negative means current flowing the other way. <b>ERR</b> when the sensor is not present." },
      { "t": "Peak", "d": "Highest current the firmware has held recently (peak hold)." },
      { "t": "Status (ACS)", "d": "Plain verdict: OK, <b>OK &mdash; idle (0 A)</b>, <b>OUT OF RANGE</b> (wrong model or divider), or <b>NO SIGNAL</b> (nothing connected)." },
      { "t": "Model", "d": "Picks the sensitivity preset: 5 A = 185 mV/A, 20 A = 100 mV/A, 30 A = 66 mV/A. Match the board you actually wired." },
      { "t": "Sensitivity (V/A)", "d": "Volts of output change per ampere. Only edit it for a module that is not one of the three presets." },
      { "t": "Divider ratio", "d": "How much your voltage divider scales the sensor output before the ADC. Default 0.6875 matches this build; change it only if you wired a different divider, or every amp reading shifts." },
      { "t": "Zero (V)", "d": "Manual zero. Leave it empty (<b>auto</b>) to follow the firmware." },
      { "t": "Zero now / Device zero / Defaults", "d": "<b>Zero now</b> adopts the current reading as 0 A (do it with the motor off). <b>Device zero</b> goes back to the firmware's value. <b>Defaults</b> restores 5 A / 0.185 / 0.6875 / auto." }
    ]
  },
  {
    "id": "history",
    "title": "HIST tab",
    "short": "HIST",
    "terms": [
      { "t": "1 h / 6 h / 24 h", "d": "The stored window you are asking for, ending now. HIST is not live data: it asks the Cloudflare API what the board saved." },
      { "t": "Points", "d": "How many stored fixes are drawn for the window. The board records one per second while moving and one per 10 s while parked, and only when it has a fix. Wide windows are sampled by the server so they still cover the whole window; Status then says <b>1 of N points, T total</b>, where T is what is really stored." },
      { "t": "Distance", "d": "Sum of the straight lines between the drawn points, in km. Sampling cuts corners, so a sampled window can read slightly low." },
      { "t": "Max gap", "d": "The longest wait between two stored fixes in that window, measured on the raw data so sampling never fakes a gap. About 1 s while moving and about 10 s while parked are normal. Bigger means data was missing: no GPS, no internet, a reboot, or the board was off." },
      { "t": "Window", "d": "The exact UTC start and end the API answered with." },
      { "t": "Status (HIST)", "d": "What happened: loaded, sampled, truncated at the row cap, empty, or an error such as the API being unreachable." }
    ]
  },
  {
    "id": "normal",
    "title": "Rules of thumb",
    "short": "Normal",
    "terms": [
      { "t": "A healthy parked board", "d": "Age 1&ndash;2 s, Speed 0.0, Gaps barely moving, HDOP under 5, Sats 7+, Min Heap flat, and a HIST max gap around 10 s." },
      { "t": "A healthy moving board", "d": "Seq rising, Gaps flat, HDOP under 5, a HIST max gap around 1 s, and heading following the turns." },
      { "t": "Worth investigating", "d": "Age over 6 s repeatedly, Gaps climbing, Min Heap falling every hour, Boots climbing, HDOP pinned above 8, or a HIST max gap far above 10 s with no parked period to explain it." }
    ]
  }
];
