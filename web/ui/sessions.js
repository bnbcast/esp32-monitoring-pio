"use strict";

// ---------------------------------------------------------------------------
// web/ui/sessions.js - turn a /history point list into timeline sessions.
//
// A session is a run of fixes with no gap longer than DEFAULT_GAP_S. The board
// publishes at 1 Hz, so a 2 minute silence means the tracker was off, out of
// range or rebooted; that is the boundary the timeline draws. D1 also stores
// `boot`, which would split a reboot even when it is quick, but /history does
// not return that column yet - the gap is what we can use without a deploy.
//
// Deliberately free of DOM and map code so it can be unit-tested under node:
// see test/sessions.test.js. Loaded as a classic script, so `SESSIONS` is a
// global lexical binding for app.js, the same pattern as `MAP`.
// ---------------------------------------------------------------------------

const SESSIONS = (function () {
  const DEFAULT_GAP_S = 120;

  function distanceKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[2] - a[2]) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function usable(p) {
    if (!Array.isArray(p) || p.length < 3) return false;
    const ts = Number(p[0]), lat = Number(p[1]), lon = Number(p[2]);
    return Number.isFinite(ts) && Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  // points: [[ts, lat, lon, kmh, ...], ...] oldest first, exactly as /history
  // returns them. Returns one object per session, still in time order.
  function group(points, gapS) {
    const gap = Number.isFinite(gapS) && gapS > 0 ? gapS : DEFAULT_GAP_S;
    const out = [];
    let cur = null;

    for (const p of (Array.isArray(points) ? points : [])) {
      if (!usable(p)) continue;
      const ts = Number(p[0]);

      // Strictly greater: exactly `gap` seconds is one session, not two.
      if (!cur || ts - cur.end > gap) {
        cur = {
          start: ts, end: ts, points: [],
          distKm: 0, maxKmh: 0, _kmhSum: 0, _kmhN: 0
        };
        out.push(cur);
      }

      const prev = cur.points[cur.points.length - 1];
      if (prev) cur.distKm += distanceKm(prev, p);
      cur.points.push(p);
      cur.end = ts;

      const kmh = Number(p[3]);
      if (Number.isFinite(kmh)) {
        if (kmh > cur.maxKmh) cur.maxKmh = kmh;
        cur._kmhSum += kmh;
        cur._kmhN++;
      }
    }

    for (const s of out) {
      s.count = s.points.length;
      s.seconds = Math.max(0, s.end - s.start);
      s.avgKmh = s._kmhN ? s._kmhSum / s._kmhN : 0;
      delete s._kmhSum;
      delete s._kmhN;
    }
    return out;
  }

  function summarize(list) {
    const out = { count: 0, distKm: 0, seconds: 0, maxKmh: 0, points: 0 };
    for (const s of (Array.isArray(list) ? list : [])) {
      out.count++;
      out.distKm += s.distKm || 0;
      out.seconds += s.seconds || 0;
      out.points += s.count || 0;
      if ((s.maxKmh || 0) > out.maxKmh) out.maxKmh = s.maxKmh;
    }
    return out;
  }

  const pad = n => (n < 10 ? "0" + n : String(n));

  // Local time on purpose: the timeline is read by the owner standing next to
  // the vehicle. Day headers are local too, so a 01:30 local stint is under
  // "Today" even though it is still the previous day in UTC.
  function fmtClock(ts) {
    const d = new Date(Number(ts) * 1000);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + pad(s % 60) + "s";
    return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function dayKey(ts) {
    const d = new Date(Number(ts) * 1000);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // Local, to match the clock labels and the footer clock. A UTC "Today" next
  // to a local 01:30 would put the session under the wrong day for hours.
  function fmtDay(ts, nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : Math.floor(Date.now() / 1000);
    const key = dayKey(ts);
    if (key === dayKey(now)) return "Today";
    if (key === dayKey(now - 86400)) return "Yesterday";
    const d = new Date(Number(ts) * 1000);
    return d.getDate() + " " + MONTHS[d.getMonth()];
  }

  // ---- laps ----------------------------------------------------------------
  // /history returns laps as [[ts, n, dur_ms, best_ms], ...]. A lap belongs to
  // the session whose time window contains it: the timestamp is the fix that
  // carried the new counter, so it is inside that session by construction.
  function lapsIn(laps, startTs, endTs) {
    const a = Number(startTs), b = Number(endTs);
    return (Array.isArray(laps) ? laps : []).filter(l => {
      if (!Array.isArray(l) || l.length < 3) return false;
      const ts = Number(l[0]), n = Number(l[1]), dur = Number(l[2]);
      return Number.isFinite(ts) && Number.isFinite(n) && Number.isFinite(dur) &&
        dur > 0 && ts >= a && ts <= b;
    });
  }

  // count, best, last and how far the last lap is off the best. Kept separate
  // from rendering so node can check the arithmetic without a DOM.
  function lapSummary(list) {
    const out = { count: 0, bestMs: 0, lastMs: 0, deltaMs: 0 };
    for (const l of (Array.isArray(list) ? list : [])) {
      const dur = Number(l[2]);
      if (!Number.isFinite(dur) || dur <= 0) continue;
      out.count++;
      out.lastMs = dur;
      if (!out.bestMs || dur < out.bestMs) out.bestMs = dur;
    }
    out.deltaMs = out.count > 1 && out.bestMs ? out.lastMs - out.bestMs : 0;
    return out;
  }

  function fmtLap(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v <= 0) return "--";
    return (v / 1000).toFixed(2);
  }

  function fmtDelta(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v === 0) return "";
    return (v > 0 ? "+" : "") + (v / 1000).toFixed(2);
  }

  // Largest |roll| or |pitch| in a point list. Points carry the attitude at
  // index 6 and 7 (see /history). Returns null when no point has a finite
  // value: old rows have no attitude columns, and 0.0 would look like a
  // measurement instead of "never recorded".
  function maxLean(points) {
    let m = null;
    for (const p of (Array.isArray(points) ? points : [])) {
      if (!Array.isArray(p)) continue;
      for (const i of [6, 7]) {
        const raw = p[i];
        if (raw === null || raw === undefined || raw === "") continue;
        const v = Math.abs(Number(raw));
        if (!Number.isFinite(v)) continue;
        if (m === null || v > m) m = v;
      }
    }
    return m;
  }

  // How much of this trail can be trusted: average HDOP and the share of
  // points worse than 3.0 (roughly "worse than 15 m"). Cheap and honest.
  function quality(points) {
    let n = 0, bad = 0, sum = 0;
    for (const p of (Array.isArray(points) ? points : [])) {
      if (!Array.isArray(p)) continue;
      const h = Number(p[5]);
      if (!Number.isFinite(h) || h <= 0) continue;
      n++; sum += h;
      if (h > 3) bad++;
    }
    return { n, bad, avg: n ? sum / n : 0, badPct: n ? (bad / n) * 100 : 0 };
  }

  // ---- event log -----------------------------------------------------------
  // A chronological list of the things worth knowing when reading a window,
  // derived from rows already stored. Nothing extra is recorded on the board:
  // a reboot shows as a boot change, a hole in the data as a gap, a shaky
  // stretch as an HDOP transition, and the laps arrive in their own array.
  // That keeps one source of truth and no second upload path to keep in sync.
  function isPoor(p) {
    const h = Number(p && p[5]);
    return Number.isFinite(h) && h > 3;
  }

  function events(points, laps) {
    const out = [];
    let prev = null;
    for (const p of (Array.isArray(points) ? points : [])) {
      if (!usable(p)) continue;
      if (prev) {
        const gap = Number(p[0]) - Number(prev[0]);
        if (gap > DEFAULT_GAP_S) {
          out.push({ ts: Number(prev[0]) + 1, kind: "gap",
                     text: "no data for " + fmtDuration(gap) });
        }
        const b = p[8], pb = prev[8];
        if (b !== null && b !== undefined && pb !== null && pb !== undefined &&
            Number(b) !== Number(pb)) {
          out.push({ ts: Number(p[0]), kind: "boot", text: "boot #" + b });
        }
        const poor = isPoor(p), wasPoor = isPoor(prev);
        if (poor && !wasPoor) {
          out.push({ ts: Number(p[0]), kind: "poor",
                     text: "GPS quality poor, hdop " + Number(p[5]).toFixed(1) });
        } else if (!poor && wasPoor) {
          out.push({ ts: Number(p[0]), kind: "good", text: "GPS quality back under 3" });
        }
      }
      prev = p;
    }
    for (const l of (Array.isArray(laps) ? laps : [])) {
      if (!Array.isArray(l) || l.length < 3) continue;
      const dur = Number(l[2]);
      if (!Number.isFinite(dur) || dur <= 0) continue;
      out.push({ ts: Number(l[0]), kind: "lap",
                 text: "lap " + Number(l[1]) + " · " + fmtLap(dur) + " s" });
    }
    // Stable for events sharing a timestamp: the sort is on time only.
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // ---- export --------------------------------------------------------------
  // Built in the browser from points already fetched: no backend, no new host.
  const isoUtc = ts => new Date(Number(ts) * 1000).toISOString();

  const xmlEsc = s => String(s).replace(/[<>&"']/g,
    c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

  // GPX 1.1. Speed is not a trkpt element in 1.1 (it was in 1.0), so it is
  // left out rather than written in the wrong namespace: a file that opens in
  // QGIS and Google Earth is worth more than one carrying a rejected field.
  function toGpx(points, name) {
    const pts = (Array.isArray(points) ? points : []).filter(usable);
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="esp32-race-tracker" ' +
      'xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <trk><name>' + xmlEsc(name || "session") + '</name><trkseg>\n';
    for (const p of pts) {
      out += '    <trkpt lat="' + Number(p[1]).toFixed(6) +
             '" lon="' + Number(p[2]).toFixed(6) + '">' +
             '<time>' + isoUtc(p[0]) + '</time></trkpt>\n';
    }
    return out + '  </trkseg></trk>\n</gpx>\n';
  }

  function toCsv(points) {
    const rows = ["ts,iso,lat,lon,kmh,cog,hdop,roll,pitch"];
    const f = v => {
      const n = Number(v);
      return (v === null || v === undefined || v === "" || !Number.isFinite(n)) ? "" : n;
    };
    for (const p of (Array.isArray(points) ? points : [])) {
      if (!usable(p)) continue;
      rows.push([f(p[0]), isoUtc(p[0]),
                 Number(p[1]).toFixed(6), Number(p[2]).toFixed(6),
                 f(p[3]), f(p[4]), f(p[5]), f(p[6]), f(p[7])].join(","));
    }
    return rows.join("\n") + "\n";
  }

  return { DEFAULT_GAP_S, group, summarize, distanceKm,
           fmtClock, fmtDuration, dayKey, fmtDay,
           lapsIn, lapSummary, fmtLap, fmtDelta, maxLean, quality, events,
           toGpx, toCsv };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SESSIONS;
