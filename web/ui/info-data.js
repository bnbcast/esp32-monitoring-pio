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
  "Orion Project: tap an area, then a term. Search jumps straight to it. " +
  "GREEN = healthy, YELLOW = waiting, RED = a problem.";

window.INFO_GROUPS = [
  {
    "id": "pills",
    "title": "Status pills",
    "short": "Pills",
    "terms": [
      { "t": "BROKER", "d": "<b>BROKER OK</b> = this page's WebSocket to the broker is open. <b>BROKER ...</b> = still connecting, or reconnecting after a drop." },
      { "t": "DEVICE", "d": "<b>DEVICE LIVE</b> = a frame arrived in the last 6 seconds. <b>NO SIGNAL</b> = the link is fine but the board went quiet. <b>DEVICE OFFLINE</b> = the board announced it is going away (shutdown, Wi-Fi loss, power cut)." },
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
      { "t": "Camera lock", "d": "The target button on the map. Lit = the camera keeps the vehicle near the middle as it moves. Tap it off, or just drag the map once: the finger wins and the lock releases. The choice is stored in this browser, nothing is sent to the board." },
      { "t": "Full screen", "d": "Hides the top bar and the panels so the map fills the window. <b>Esc</b> (or the same button) leaves it. Nothing about the data changes; it is only a bigger map." },
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
      { "t": "Sats", "d": "Satellites used in the current fix. The firmware needs at least 5 and a 3D fix before it publishes a position; 7&ndash;12 is comfortable." },
      { "t": "HDOP", "d": "Horizontal dilution of precision: a geometry score, <b>lower is better</b>. Under 2 is excellent, 2&ndash;5 is good, over 8 is poor. Above 8 the firmware stops publishing a position even though it still has a fix, which is why you can see satellites but <b>NO FIX</b>." },
      { "t": "Fix", "d": "<b>VALID</b> = the receiver says the position is usable. <b>NO FIX</b> = it does not, so coordinates are sent as empty." },
      { "t": "Heading", "d": "Course in degrees, from GPS or MPU6050 (see map corner)." },
      { "t": "Tilt", "d": "How far the vehicle is leaning, from the MPU6050, in degrees. This is the number the danger lights use." },
      { "t": "Odometer", "d": "Distance in metres the <b>firmware</b> has counted since it booted, minus any reset you did in this browser. It drops to 0 when the board reboots; the reset button (unlocked) zeroes it just for this browser." },
      { "t": "Trail", "d": "Distance in km of the breadcrumb line on the map. Browser-side only: reload clears it." },
      { "t": "Address", "d": "Nearest street to the last fix, as resolved above. It lags the coordinates slightly because the lookup is rate-limited." },
      { "t": "Max Speed", "d": "Fastest speed this page has seen since it opened, not the device's all-time record." },
      { "t": "Avg moving", "d": "Average speed over the last 180 frames that were at or above 1 km/h, so time spent parked does not drag it down." },
      { "t": "Stopped", "d": "Share of the last 180 frames below 1 km/h. Receivers report 1&ndash;2 km/h of noise while parked, so the threshold is one, not zero." },
      { "t": "Peak", "d": "Fastest single sample in the same 180-frame live buffer, in km/h. It can be one noisy fix; compare it with Max Speed." },
      { "t": "Seq", "d": "The device's frame counter. It rises by about 1 per second; a jump means frames were lost in transit." },
      { "t": "Gaps", "d": "How many frames went missing between Seq jumps since this page opened. A few after a Wi-Fi hiccup is normal (live MQTT is best-effort); stored history is unaffected because the board uploads it separately from flash." },
      { "t": "Age", "d": "Seconds since the last frame reached <b>this browser</b>. About 1 s is normal; over 6 s and DEVICE turns to NO SIGNAL." },
      { "t": "Device Time", "d": "The board's UTC clock (hh:mm:ss), set from GPS. <b>no clock</b> means it has not seen a GPS time yet; stored fixes are stamped with the same clock." },
      { "t": "GPS Lat / GPS Lng / GPS Alt / GPS Spd", "d": "The same position and speed again, raw, for copying or checking against another device. They follow Fix: <b>NO FIX</b> when there is no position." },
      { "t": "Uptime", "d": "Seconds since the board booted. A number that starts over means it rebooted." },
      { "t": "RSSI", "d": "Wi-Fi signal at the board, in dBm. &minus;50 is excellent, &minus;70 is fine, &minus;85 is weak, below &minus;90 causes dropouts." },
      { "t": "Heap", "d": "Free RAM right now, in KB. High hundreds is healthy on this build; a value that keeps shrinking over hours means a leak." },
      { "t": "GPS Sats", "d": "Satellite count again, straight from the receiver." },
      { "t": "Fix Mode", "d": "<b>3D</b> = latitude, longitude and altitude are solved, which is what the firmware requires. <b>2D</b> = no altitude constraint, so the horizontal position is much less trustworthy and is deliberately not published." },
      { "t": "TTFF", "d": "Time to first fix, in seconds after boot: how long the receiver needed for a position the firmware accepted. A warm start with a charged backup battery is a few seconds; a cold start outdoors is around 30 s." },
      { "t": "Rejected", "d": "Fixes the firmware threw away because they implied a speed no vehicle can reach (over 200 km/h). Each one is a multipath jump, not real movement, and counting them keeps the map and the stored history clean." },
      { "t": "Laps", "d": "Completed crossings of the virtual finish line, counted on the board. The first forward crossing arms the timer; every later crossing must also be at least 3 s and 5 km/h apart." },
      { "t": "Last / Best", "d": "The most recent lap and the fastest lap since the gate was set, in seconds. The time is interpolated to the exact crossing point, so it is not rounded to the 5 Hz fix interval." },
      { "t": "Gate", "d": "<b>armed</b> = two ends are stored on the board. Set them over serial: drive to one end of the line and press <b>a</b>, drive to the other and press <b>b</b>; <b>k</b> shows the gate, <b>l</b> clears it." }
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
      { "t": "MAC", "d": "The board's own Wi-Fi MAC. Use it in a DHCP reservation so the address never changes." },
      { "t": "Link", "d": "A plain-language summary of the current RSSI: <b>strong</b> at &minus;60 dBm or better, <b>fair</b> down to &minus;75, <b>weak</b> below that." },
      { "t": "Msg rate", "d": "Frames per second this browser received over the last 15 seconds. The board sends about 1/s; a much lower number means frames are arriving late, not that the sensor slowed down." },
      { "t": "Largest gap", "d": "Longest silence between two frames in the last minute. A few seconds is a normal Wi-Fi hiccup; tens of seconds means the link or the broker went away." }
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
      { "t": "tilt history", "d": "The last 120 samples (about two minutes at one frame per second) drawn as a line, so a spike is visible even after it passed." },
      { "t": "Accel |a|", "d": "Length of the acceleration vector, in g: sqrt(x&sup2; + y&sup2; + z&sup2;). About 1 g at rest; a bump or a hard corner pushes it up." },
      { "t": "Peak |a|", "d": "Largest acceleration magnitude in the current chart buffer (about 180 frames). Use it to spot a pothole or a kerb strike after the fact." },
      { "t": "Peak tilt", "d": "Largest tilt in the same 120-sample buffer, in degrees. It is a short-term window, not the all-time Max Tilt." }
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
      { "t": "Max lean", "d": "The largest body tilt seen in the window: the bigger of roll and pitch reported by the MPU at any stored fix. Degrees. It is a bound, not a cornering limit; a pothole can spike one or two samples." },
      { "t": "Quality", "d": "Average HDOP in the window and the share of fixes worse than 3.0, drawn as red on the map. About 1.0 is a good sky view, 3.0 is roughly 15 m of position error, 6.0 or more means the trail can wander." },
      { "t": "Lap log", "d": "Lap rows the tracker logged when its finish-line counter moved. Each chip shows the lap number, its time in seconds, and how far it was off the best lap. Restarting the board resets the counter, so the log groups by session." },
      { "t": "Window", "d": "The exact UTC start and end the API answered with." },
      { "t": "Status (HIST)", "d": "What happened: loaded, sampled, truncated at the row cap, empty, or an error such as the API being unreachable." },
      { "t": "Moving / Stopped", "d": "Share of stored points at or above 1 km/h, and the rest. Wide windows are sampled by the API, so this is a share of points, not a measured duration; the board records about one point per second while moving." },
      { "t": "Chart view", "d": "<b>Speed + lean</b> shows ground speed and the bigger of roll/pitch. <b>GPS quality</b> plots HDOP with the 3.0 threshold. <b>Lap deltas</b> draws each lap's gap to the best lap, with the best as a green zero bar." }
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
