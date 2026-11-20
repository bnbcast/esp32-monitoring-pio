# Wi-Fi Setup Guide

The tracker is not born knowing a Wi-Fi network. After flashing, it opens its
own setup hotspot so a phone can hand it the name and password (or tell it the
network is open). Credentials are stored in NVS, so they survive later
reflashes of the application.

This page is for the person at the track. The firmware-side design is in
[firmware.html#wi-fi-provisioning-nvs-setup-portal](firmware.html#wi-fi-provisioning-nvs-setup-portal).

---

## What you need

- A phone or laptop with Wi-Fi.
- A **2.4 GHz** network. The ESP32 cannot see or join 5 GHz-only networks.
- The network password, unless it is an open network.
- The tracker powered over USB (the setup hotspot is only up while the board
  is running).

---

## First-time setup

1. **Power the tracker.** With no saved network, it opens its setup hotspot
   within a few seconds.
2. **Join the setup hotspot from your phone.** Its name is
   `Orion-Setup-XXXX`, where `XXXX` comes from the board's MAC address. The
   password is **`12345678`**.
3. **Open the setup page.** Most phones show a "sign in to network" sheet
   automatically. If not, open a browser and go to
   **http://192.168.4.1/**.
4. **Add the network:**
   - Tap **Scan** to list what the tracker can see (strongest first), or type
     the SSID directly for a hidden network.
   - Enter the password. Leave it **empty** for an open network.
   - Tap **Save and reboot**.
5. **Let the board join.** It reboots and connects. Your phone may complain
   that the setup hotspot has no internet; that is expected, so reconnect your
   phone to its normal Wi-Fi.
6. **Check the dashboard.** Live data should start within a few seconds at
   https://bnbcast.github.io/esp32-monitoring-pio/.

If the password is wrong or the network is out of range, the setup hotspot
comes back after 20 seconds. Join it again and correct the entry.

---

## Adding or changing a network later

The tracker keeps up to **4** networks, newest first. Saving a network that is
already in the list replaces it, so changing a password is just another save.

To open the portal while the tracker is running:

- **Hold the BOOT button (GPIO0) for 3 seconds**, or
- press **`w`** in the serial console.

The portal starts in AP+STA mode, so a tracker that is already publishing keeps
publishing while you edit. It stays open until you hold BOOT again or reboot.

The **Saved networks** card shows what is stored. **Forget** removes one entry.
Removing the network the board is currently using does not drop the link until
the next reboot or reconnect.

You can also open the portal by waiting: if none of the saved networks connects
for 20 seconds after boot, the board opens it on its own.

---

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| `Orion-Setup-XXXX` does not appear | The tracker is already connected to a saved network, or it has been up for less than a few seconds. Hold BOOT for 3 s. |
| The network is missing from the scan | It is 5 GHz-only, or hidden. Type the SSID by hand (case-sensitive). |
| "Password too short" | WPA passphrases are 8–63 characters. Use the empty password field only for a genuinely open network. |
| Saved, rebooted, portal came back | Wrong password, out of range, or the venue uses a captive portal of its own. Rejoin the setup hotspot and retry. |
| It joined but the dashboard is offline | Check the broker/internet path; the serial panel shows the Wi-Fi and MQTT state separately. |

---

## Security notes

- The setup hotspot uses the password **`12345678`** while it exists. It only runs
  during provisioning, is never left on after a working connection (unless
  opened manually), and its save/forget endpoints reject clients that did not
  connect through the setup AP.
- The tracker never exposes the stored password: the page lists SSIDs only, and
  passwords are written to NVS without being read back into HTML.
- This repository must never contain a real SSID/password. If a credential was
  ever committed, rotate it at the hotspot; deleting the file does not remove
  it from git history.
