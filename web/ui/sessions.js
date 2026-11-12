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

  return { DEFAULT_GAP_S, group, summarize, distanceKm,
           fmtClock, fmtDuration, dayKey, fmtDay };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SESSIONS;
