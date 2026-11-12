# Maps-style UI plan (Google-Maps-like dashboard)

Status: plan, not built. OTA is explicitly out of scope for this plan.
Target: keep the ESP32 live telemetry dashboard working while the map becomes a
Maps-like product surface (search, directions, satellite, saved places, timeline,
3D pitch) and the telemetry/WiFi/MPU panels stay clean and readable.

## Verdict

Possible, at €0, for the *experience*. Not possible to copy Google's data:
live traffic, Street View, the Places database and traffic-aware ETAs are paid
Google APIs and may not be used as tiles in MapLibre.

| Want | Source | Cost | Notes |
|---|---|---|---|
| Search a place / address | Nominatim search (same host as the reverse lookup already in `app.js`) | free | 1 req/s policy; proxy it |
| Directions A→B | OSRM demo `router.project-osrm.org` | free | fair use, no SLA; proxy + cache |
| Satellite | Esri World Imagery raster, already allowed by the CSP | free with attribution | labels drawn from the vector style on top |
| Saved places (home / track) | `localStorage`, later D1 | free | works offline, no account needed |
| Timeline / sessions | existing D1 `fixes` table, grouped by `boot` | free | no firmware change |
| Google-ish palette, POI icons | runtime paint overrides on the OpenFreeMap `liberty` style | free | street + building names stay |
| 3D pitch / buildings | MapLibre `maxPitch` + `fill-extrusion` from the `building` layer | free | no DEM needed |
| Accounts, private timeline | GitHub OAuth + D1 | free | phase 5, protects history |

Hard limits to state up front: no live traffic, no Street View, no place reviews
or photos, no Google tiles, no navigation on the ESP32 (it has no display).

## Shell

One map, one rail, one drawer — the same bones as the reference screenshots.

```
+------+-------------------------------------------------------------+
| rail |  [ search places / addresses        ]  [Directions]  [acct] |
|      |                                                             |
|  Q   |                                                             |
|  []  |                    MAP (pitch 0/45, satellite)             |
|  *   |                                                    [layers] |
|  o   |   +------------------+                          [3D][+][-] |
|  ()  |   | LIVE telemetry   |                                      |
|      |   | speed  dist  lap |                                      |
|      |   +------------------+                                      |
|      |                                                             |
|  ^   |  (drawer open: timeline / saved / recents)                  |
+------+-------------------------------------------------------------+
```

- **Rail** (72 px): Search, Saved, Timeline (Recents), Telemetry, Info; the
  account avatar at the bottom when phase 5 lands.
- **Drawer** (360 px, slides over the map, never resizes it): Timeline, Saved,
  Recents or Directions. This is the "slider sidebar" request.
- **Search card**: pill at the top-left of the map; expands to place + directions
  modes.
- **Telemetry**: a floating compact card over the map (speed, trip, lap, fix), and
  the full LIVE / WIFI / MPU / HIST / INFO panels in a right-hand drawer behind
  the rail's Telemetry item. Mobile: the drawer becomes the existing bottom sheet.
- **Map controls** (right): layers (streets / satellite), 3D pitch, zoom,
  my-location, follow. Measure and reset-trip stay operator-only.

What stays untouched: every data field currently in LIVE, WIFI, MPU and INFO,
the lock button, the pills, the simulator badge and the glossary. The UI is
restyled, not rewritten; element IDs stay so `app.js` keeps working.

## 1. Search

- Input: Nominatim `/search?format=jsonv2&addressdetails=1&limit=6&q=...`,
  debounced 400 ms, minimum 3 characters, one request per second.
- Result rows: name, type, distance from the vehicle, "Directions" and "Save".
- Selecting a result: `flyTo` zoom 16, drop a temporary pin, show the address in
  the search card.
- Do **not** call Nominatim directly from the browser in the final build: the
  policy asks for an identifying User-Agent, which a browser cannot set. Proxy
  through the existing Pages Function (`/api/search`), cache 24 h, rate-limit.

## 2. Directions

- Two fields, A and B; each can be the vehicle, a saved place, a search result
  or a map right-click. Swap button.
- `GET /api/route?from=lng,lat&to=lng,lat` → OSRM demo, `overview=full`,
  `steps=true`; the function adds a User-Agent, caches by rounded coordinates and
  returns distance, duration and steps.
- Render: route line (Google blue `#1a73e8`, white casing), start/end pins,
  turn-list card in the drawer, "X km · Y min" summary, "Start" for a
  follow-the-route camera.
- No turn-by-turn voice, no live re-routing, no traffic: state this in the UI
  ("route preview, not live navigation").
- On-track use is limited by design: the racing line is the recorded trail, not
  a road route.

## 3. Satellite

- Toggle in the layers control. Adds a raster source
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
  under the label/road layers, so street and building names remain readable.
- Attribution: "Imagery © Esri, Maxar, Earthstar Geographics".
- The existing `TILE_PROVIDERS` fallback logic already probes raster providers
  when the vector style fails; satellite reuses that code path instead of adding
  a second mechanism.

## 4. Saved places

- `places: [{id, name, lat, lng, kind: home|track|custom}]` in `localStorage`
  first; D1 with the account in phase 5.
- Add from the search card ("Save"), from a long-press on the map, or from
  "Save current position" while the tracker is parked.
- Home and Track get one-tap directions from the rail.
- Defaults: track = the finish-line gate midpoint once a gate exists; home =
  unset, so nothing private is invented.

## 5. Timeline (the "like Google Maps" part)

Data already exists: `fixes(device, boot, seq, ts, up, lat, lon, alt, kmh, cog,
hdop, sats, dist_m, received)`. Every power-on is a session boundary.

- New endpoint `GET /api/sessions?device=&from=&to=&limit=`:
  `GROUP BY boot`, split when `ts - LAG(ts) > 120 s` for pit stops that keep the
  board powered; returns `{id, boot, started_at, ended_at, points, dist_m,
  max_kmh, avg_kmh}`.
- `GET /api/history?session=<boot>` reuses the existing query with a boot filter.
- Drawer: date headers (Today / Yesterday / 12 Nov), session cards with duration,
  distance, top speed, lap count when the gate was set.
- Selecting a session: fit bounds, draw the stored polyline (dashed, as today),
  show a scrubber + speed graph, and a "play" at 1–16×.
- Privacy: a year of history reveals home and routine. Timeline is private by
  default in the default build: it stays disabled on the public GitHub Pages
  until phase 5 auth exists, or it is limited to the last 24 h.

## 6. Palette, POIs and 3D

- Runtime paint overrides on the loaded `liberty` style (no fork of the style
  JSON, so tile updates keep working): land `#f2f4f0`, water `#a6cbe3`, parks
  `#cfe8c9`, motorways `#f9c74f`, primary `#ffffff` casing `#d8d8d8`, buildings
  `#e8e6e1`, text `#3c4043` with a white halo.
- POI icons: keep the style's sprite in phase 1; adjust size/colour. Custom
  Google-style icons in phase 2 need a locally generated sprite (`sprite.json` +
  png) from an openly licensed icon set, otherwise we would be shipping Google's
  artwork.
- 3D: `maxPitch: 75`, a 3D button that eases `pitch` 0→45 and back, and a
  `fill-extrusion` layer over `building` using `render_height` /
  `render_min_height` from the OpenMapTiles schema. No terrain DEM in phase 1.
- Street and building names are a hard requirement: the style keeps its
  `transportation_name`, `place` and `building` label layers; only colors and
  sizes change.

## 7. Telemetry drawer (keep it clean)

- The current cards, same IDs, new skin: white 16 px radius, 1 px border,
  soft shadow, Roboto/Inter for labels, the existing mono font for numbers.
- Compact map card: speed, trip, lap count, fix state, one line of address.
- Pills move into the compact card header (BROKER / DEVICE / MPU / GPS) so the
  top bar disappears and the map gets the space.
- Full panels unchanged in content: LIVE (telemetry + lap + danger), WIFI,
  MPU (+ tilt chart), HIST, INFO glossary.
- Lock, measure, follow, reset-trip and full-screen keep their current behavior.

## Backend changes

| Item | Where | Notes |
|---|---|---|
| `/api/search` | `worker/src/index.js` | Nominatim proxy, UA, 24 h cache, 1 req/s per IP |
| `/api/route` | same | OSRM proxy, rounded-coordinate cache, 6 h |
| `/api/sessions` | same | D1 window query, 120 s gap split |
| `/api/history` | same | add `session` (boot) filter |
| CSP | `web/index.html` | add `https://router.project-osrm.org` to `connect-src`; Esri already allowed in `img-src` |
| Caching | `worker` | `Cache-Control` + `cf.cacheTtl` for search/route |

No firmware change in this plan. No new npm dependency: search, route and
session grouping are `fetch` + plain JS.

## Phases

| Phase | Scope | Effort | Acceptance |
|---|---|---|---|
| P0 | Shell: rail, drawer, search card, layers (streets/satellite), 3D pitch, telemetry drawer, palette | 0.5–1 d | `dev/check-live.mjs` PASS, screenshot desktop + phone, no CSP errors, LIVE/WIFI/MPU values unchanged |
| P1 | Search results + fly-to pin | 0.5 d | 6 results for "Monas", pin lands, ESC closes |
| P2 | Directions A→B, route line, steps card | 0.5–1 d | Jakarta→Bandung returns km/min, line + steps, swap works |
| P3 | Saved places (home/track/custom) | 0.5 d | survives reload, one-tap directions |
| P4 | `/sessions` + timeline drawer + replay + speed graph | 1–1.5 d | 3 seeded sessions listed, fit bounds correct, replay stops at end |
| P5 | Proxies, caching, rate limits, CSP, tests | 0.5–1 d | no direct Nominatim/OSRM calls from the page; unit tests for parsing + grouping |
| P6 | Accounts, private timeline, D1 places | 1 d | login allowlist, session list requires token, public live view unchanged |

## Tests

- Unit: search-result normalization, route summary formatting, session grouping
  (gap split, boot split), saved-place validation, palette/style override list.
- Browser probes (`dev/`): shell at 1440×900 and 390×844, drawer open/close,
  satellite toggle keeps labels, pitch button changes `map.getPitch()`,
  directions card renders, timeline session click fits bounds.
- Regression: the 49 existing tests must stay green; `validData()` untouched.

## Risks

| Risk | Mitigation |
|---|---|
| Nominatim / OSRM policies | proxy with UA, cache, per-IP limit, "preview only" wording |
| MapLibre style update changes layer names | paint overrides applied by layer `id` with existence checks; fall back to stock liberty |
| CSP blocks a new host | every new host added deliberately and checked in the console probe |
| Timeline privacy | hidden/limited until phase 6 |
| Large history payloads | sessions endpoint returns stats only; points loaded per session, decimated |
| Mobile clutter | drawer becomes the bottom sheet; HUD compacts to one row |

## Files

- `web/index.html` — new shell, rail, drawer, search card, controls, CSP.
- `web/css/tokens.css`, `layout.css`, `components.css`, `map.css` — palette, rail,
  drawer, cards; keep existing class names where possible.
- `web/ui/map.js` — satellite source, paint overrides, 3D buildings, pitch,
  route/pin sources, timeline polyline, fit-bounds helpers.
- `web/ui/search.js` (new) — search + directions UI and fetch layer.
- `web/ui/places.js` (new) — saved places, localStorage.
- `web/ui/timeline.js` (new) — sessions list, replay, scrubber.
- `web/ui/app.js` — wire rail/drawer, keep every existing field binding.
- `worker/src/index.js` — `/api/search`, `/api/route`, `/api/sessions`, boot filter.
- `worker/schema.sql` — `places` table only in phase 6.
- `test/ui.test.js` + a new `test/maps.test.js` — pure functions and shell contract.
