# Maps-style UI: scope reduced to the HIST timeline

Status: **superseded**, 2026-11-12. The shell rework described in the previous
revision of this file (rail, sliding drawer, floating search card, directions
panel, saved places, palette pass) is **dropped**. Do not build it.

## What was kept

One change, in the tab that already existed: **HIST was rewritten as a
timeline.** No new navigation, no layout change, no backend change, no firmware
change.

| Item | Where |
|---|---|
| Group stored fixes into sessions (gap > 120 s starts a new one) | `web/ui/sessions.js` |
| Session rows: day header, start-end clock, duration, km, max km/h, points | `web/index.html` `#tab-history`, `renderTimeline()` in `web/ui/app.js` |
| Tap a row: draw only that session and frame it | `selectSession()`, `MAP.fitPoints()` in `web/ui/map.js` |
| Tap again: back to the whole window | same |
| Window totals stay: points, distance, max gap, clock, status | existing `#hist*` ids, kept so `dev/check-history.mjs` still works |

Two defects were found by the browser probe and fixed before shipping:

1. Window distance summed the straight line **between** sessions (6.13 km for
   1.59 km of driving). It now sums the sessions.
2. Day headers were UTC while the rest of the page is local, which puts an
   early-morning session under the wrong day. All labels are local now.

## What was dropped, and why

| Dropped | Reason |
|---|---|
| Rail + sliding drawer + full-bleed map | expensive, and the existing tab bar already switches panels; the five features do not need it |
| Place/address search | needs a Nominatim proxy and a results UI; not requested any more |
| Directions A→B | needs an OSRM proxy; only useful off-track |
| Saved places | no request for it; adds state without a use |
| Google-ish palette pass | the panel is a deliberate neo-brutalist design; restyling is cosmetic |
| Accounts / private timeline | not needed while the timeline only reads the public history API |
| OTA | explicitly out of scope |

Privacy note that used to justify accounts: the timeline is built from the same
public `/history` data the HIST tab already loaded. If the owner later exposes
longer windows (7 days and up), the home/routine disclosure applies again and
the decision should be revisited.

## Verification

`dev/check-timeline.mjs` serves `web/`, stubs `/history` with three sessions and
asserts rows, summary, selection, framing, deselect and zero CSP errors. Latest
run: 3 rows, `3 sessions · 1.59 km · 3m 04s`, zoom 5 → 16.67, 3 → 1 lines and
back. `test/sessions.test.js` covers grouping, junk rows, distance, speeds,
formatting and the page contract. Full suite: 80/80.
