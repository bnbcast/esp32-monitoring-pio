# Dev tooling

Everything here runs on the workstation, not on the ESP32.

## Local simulator

```powershell
npm run dev
```

- Serves the dashboard from `web/` at **http://localhost:5003/?dev&t=dev-test-1234**
- Runs a WebSocket MQTT broker at `ws://localhost:5003/mqtt`
- Publishes simulated GPS/MPU/ACS frames at 1 Hz

The topic key in dev mode is `dev-test-1234`, not the production key.

## Live traffic

```powershell
node dev/mqtt-watch.mjs                          # 60 s, prints payloads
node dev/mqtt-watch.mjs <key> <milliseconds>
node dev/mqtt-watch.mjs --out test/fixtures/parked.jsonl --dur 600000
```

`--out` writes JSON Lines, one object per message:
`{"t":...,"topic":...,"retained":false,"payload":{...}}`.
These files are the evidence used to test the parked-drift fixes.

## Serial capture

```powershell
python dev/serial-read.py
```

Reads COM4 at 115200 baud without asserting DTR/RTS, so it does not reset the
board. The firmware log panel is human-readable and monotonic.

## Browser checks

```powershell
node dev/check-live.mjs        # requires the dev server or the live site
```

Checks that the broker connects, the map renders and the console stays clean.

`dev/debug-browser.js` is stale (it still looks for removed 3D/compass
elements). Do not rely on it until it is rewritten.

## Ports

| Port | Used by |
|---|---|
| 5003 | dev server (HTTP + WebSocket MQTT) |
| 8884 | public HiveMQ WSS (production) |
| 1883 | public HiveMQ plain TCP (firmware) |
