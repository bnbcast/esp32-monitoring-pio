/*
 * web/ui/guard.js - plausibility gate for live frames.
 *
 * The MQTT broker is public and unauthenticated, so any client can publish to
 * the topic. This module is the single place that decides whether a frame is
 * allowed to reach the map. It is deliberately dependency-free and free of DOM
 * access so the same code can be unit-tested under Node (test/guard.test.js).
 *
 * Rules, in order of application:
 *   shape        - required fields and types
 *   flood        - at most CONFIG.maxPerSecond frames per second
 *   seq          - duplicate or regression within the same boot
 *   range/bbox   - coordinate range, optional venue box
 *   speed        - reported speed within CONFIG.maxKmh
 *   teleport     - distance since the last fix must be reachable in the time
 *   clock        - timestamp not absurdly far from the browser clock
 *
 * Sequence numbers reset on reboot, so a reboot is detected by `up` (uptime in
 * seconds) going backwards. That is what makes "seq regression" safe to reject.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GUARD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONFIG = {
    maxKmh: 150,
    // Filled in once the race venue is chosen, e.g.
    // { minLat: -6.95, maxLat: -6.85, minLng: 107.55, maxLng: 107.65 }
    bbox: null,
    maxPerSecond: 20,
    teleportFactor: 1.5,
    teleportSlackM: 20,
    // Generous on purpose: the device derives `ts` from GPS, and a first fix
    // can be minutes off. Sequence numbers, not the clock, are what stop
    // replays; the clock check only catches obviously forged timestamps.
    clockFutureS: 3600,
    clockPastS: 7 * 24 * 3600
  };

  var state = null;      // last accepted frame summary
  var arrivals = [];     // timestamps of recent attempts, for the flood cap
  var stats = { accepted: 0, rejected: 0, byReason: {} };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function haversineM(lat1, lng1, lat2, lng2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function reject(reason) {
    stats.rejected++;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
    return { ok: false, reason: reason };
  }

  function reset() {
    state = null;
    arrivals = [];
  }

  function accept(frame, nowMs) {
    var now = isNum(nowMs) ? nowMs : Date.now();
    var nowS = now / 1000;

    if (!frame || typeof frame !== 'object') return reject('shape');
    var g = frame.gps;
    if (!g || typeof g !== 'object') return reject('shape');
    if (!isNum(frame.seq) || !isNum(frame.up)) return reject('shape');

    // Flood cap: a hostile publisher must not be able to make the page do
    // unbounded work. 20/s is ten times the real publish rate.
    arrivals = arrivals.filter(function (t) { return now - t < 1000; });
    if (arrivals.length >= CONFIG.maxPerSecond) return reject('flood');
    arrivals.push(now);

    // Uptime going backwards means the device rebooted, so seq restarted too.
    var sameBoot = state !== null && frame.up >= state.up;

    if (sameBoot) {
      if (frame.seq === state.seq) return reject('duplicate');
      if (frame.seq < state.seq) return reject('seq-regression');
    }

    if (g.fix) {
      if (!isNum(g.lat) || !isNum(g.lng)) return reject('shape');
      if (g.lat < -90 || g.lat > 90 || g.lng < -180 || g.lng > 180) return reject('range');

      if (CONFIG.bbox) {
        var b = CONFIG.bbox;
        if (g.lat < b.minLat || g.lat > b.maxLat ||
            g.lng < b.minLng || g.lng > b.maxLng) return reject('outside-area');
      }

      if (isNum(g.kmh) && (g.kmh < 0 || g.kmh > CONFIG.maxKmh)) return reject('speed');

      // A jump that the reported time cannot explain is a spoof or a bad fix.
      if (state && isNum(state.lat)) {
        var dt = nowS - state.t;
        if (isNum(frame.ts) && frame.ts > 0 && isNum(state.ts) && state.ts > 0) {
          dt = frame.ts - state.ts;
        }
        // Clamp so a burst of buffered frames is not judged on a 5 ms delta.
        dt = Math.min(Math.max(dt, 0.5), 30);
        var allow = (CONFIG.maxKmh / 3.6) * dt * CONFIG.teleportFactor + CONFIG.teleportSlackM;
        if (haversineM(state.lat, state.lng, g.lat, g.lng) > allow) return reject('teleport');
      }
    }

    if (isNum(frame.ts) && frame.ts > 0) {
      if (frame.ts > nowS + CONFIG.clockFutureS) return reject('clock');
      if (nowS - frame.ts > CONFIG.clockPastS) return reject('clock');
    }

    stats.accepted++;
    state = {
      seq: frame.seq,
      up: frame.up,
      ts: isNum(frame.ts) ? frame.ts : 0,
      lat: g.fix && isNum(g.lat) ? g.lat : null,
      lng: g.fix && isNum(g.lng) ? g.lng : null,
      t: nowS
    };
    return { ok: true };
  }

  function statsCopy() {
    return {
      accepted: stats.accepted,
      rejected: stats.rejected,
      byReason: Object.assign({}, stats.byReason),
      last: state ? { seq: state.seq, up: state.up } : null
    };
  }

  return {
    CONFIG: CONFIG,
    accept: accept,
    reset: reset,
    stats: statsCopy,
    haversineM: haversineM
  };
});
