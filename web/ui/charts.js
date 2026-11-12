/*
 * web/ui/charts.js - small canvas helpers shared by the LIVE, WIFI, MPU and
 * HIST panels.
 *
 * The dashboard has several "a line over the last N samples" charts. Keeping
 * one drawing routine means the grid, gap handling and two-scale labels behave
 * the same everywhere. It is written as a classic browser script and also runs
 * under node for the pure helpers, matching web/ui/sessions.js.
 */
(function (root) {
  'use strict';

  const finite = v => typeof v === 'number' && Number.isFinite(v);

  // Biggest value in a list, never below `floor`. Used for an axis so a flat
  // trace does not collapse onto one pixel.
  function autoMax(values, floor) {
    let m = finite(floor) ? floor : 0;
    for (const v of (Array.isArray(values) ? values : [])) {
      if (finite(v) && v > m) m = v;
    }
    return m;
  }

  // Round up to a readable axis step: 23 -> 30 with step 10, 2.1 -> 2.5 with 0.5.
  function niceMax(value, step) {
    const s = finite(step) && step > 0 ? step : 10;
    const v = finite(value) ? value : 0;
    return Math.max(s, Math.ceil(v / s) * s);
  }

  // Merge bad samples into shaded time bands. Each bad sample covers `half`
  // seconds either side, so a run of bad HDOP becomes one red block instead of
  // a comb of separate stripes.
  function bands(points, isBad, half) {
    const out = [];
    const h = finite(half) ? half : 0.5;
    for (const p of (Array.isArray(points) ? points : [])) {
      if (!Array.isArray(p)) continue;
      const t = Number(p[0]);
      if (!Number.isFinite(t) || !isBad(p)) continue;
      const last = out[out.length - 1];
      const a = t - h, b = t + h;
      if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  function axisSize(canvas, height) {
    const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : null;
    const width = Math.max(Math.round((rect && rect.width) || 0), 300);
    canvas.width = width;
    canvas.height = height;
    return { w: width, h: height };
  }

  function paintFrame(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "Courier New", Courier, monospace';
    ctx.strokeStyle = '#e2ded2';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round(i * h / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  // series: [{ pts: [[t, v], ...], min, max, color, width }]
  // Each series may own its scale, which is how RSSI and heap share one box.
  // A gap longer than gapS breaks the line instead of drawing through it.
  function drawSeries(canvas, opts) {
    if (!canvas || !canvas.parentElement) return false;
    const o = opts || {};
    const { w, h } = axisSize(canvas, finite(o.height) ? o.height : 110);
    const ctx = canvas.getContext('2d');
    paintFrame(ctx, w, h);

    const list = (Array.isArray(o.series) ? o.series : [])
      .filter(s => s && Array.isArray(s.pts) && s.pts.length);

    let t0 = Number(o.t0), t1 = Number(o.t1);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
      t0 = Infinity;
      t1 = -Infinity;
      for (const s of list) {
        for (const p of s.pts) {
          const t = Number(p[0]);
          if (!Number.isFinite(t)) continue;
          if (t < t0) t0 = t;
          if (t > t1) t1 = t;
        }
      }
    }
    if (!list.length || !Number.isFinite(t0) || !Number.isFinite(t1)) {
      ctx.fillStyle = '#666';
      ctx.fillText(o.empty || 'waiting for samples', 8, h / 2);
      return false;
    }
    const span = Math.max(1, t1 - t0);
    const x = t => ((t - t0) / span) * (w - 2) + 1;

    // Quality bands sit under every line.
    ctx.fillStyle = o.bandColor || 'rgba(255,59,31,0.13)';
    for (const b of (Array.isArray(o.bands) ? o.bands : [])) {
      const xa = x(b[0]), xb = x(b[1]);
      ctx.fillRect(xa, 0, Math.max(1, xb - xa), h);
    }

    const gapS = finite(o.gapS) ? o.gapS : 8;
    for (const s of list) {
      const min = finite(s.min) ? s.min : 0;
      const max = finite(s.max) ? s.max : autoMax(s.pts.map(p => Number(p[1])), min + 1);
      const range = Math.max(1e-9, max - min);
      const norm = v => Math.min(1, Math.max(0, (v - min) / range));
      ctx.strokeStyle = s.color || '#000';
      ctx.lineWidth = finite(s.width) ? s.width : 2;
      ctx.beginPath();
      let started = false, prev = NaN;
      for (const p of s.pts) {
        const t = Number(p[0]), v = Number(p[1]);
        if (!Number.isFinite(t) || !Number.isFinite(v)) { started = false; continue; }
        if (started && t - prev > gapS) started = false;
        const px = x(t);
        const py = h - norm(v) * (h - 6) - 3;
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
        prev = t;
      }
      ctx.stroke();
    }

    // Reference lines use the first series' scale.
    if (list.length) {
      const s = list[0];
      const min = finite(s.min) ? s.min : 0;
      const max = finite(s.max) ? s.max : autoMax(s.pts.map(p => Number(p[1])), min + 1);
      const range = Math.max(1e-9, max - min);
      for (const r of (Array.isArray(o.refLines) ? o.refLines : [])) {
        const v = Number(r.v);
        if (!Number.isFinite(v)) continue;
        const y = h - Math.min(1, Math.max(0, (v - min) / range)) * (h - 6) - 3;
        ctx.strokeStyle = r.color || '#888';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.setLineDash([]);
        if (r.text) {
          ctx.fillStyle = r.color || '#888';
          ctx.fillText(r.text, 6, Math.max(10, y - 3));
        }
      }
    }

    if (o.topText) {
      ctx.fillStyle = o.topColor || '#000';
      ctx.fillText(o.topText, 4, 11);
    }
    if (o.bottomText) {
      ctx.fillStyle = o.bottomColor || '#666';
      ctx.fillText(o.bottomText, 4, h - 4);
    }
    return true;
  }

  // values: [delta seconds, ...], labels: short x labels.
  function drawBars(canvas, opts) {
    if (!canvas || !canvas.parentElement) return false;
    const o = opts || {};
    const { w, h } = axisSize(canvas, finite(o.height) ? o.height : 110);
    const ctx = canvas.getContext('2d');
    paintFrame(ctx, w, h);

    const values = Array.isArray(o.values) ? o.values : [];
    const labels = Array.isArray(o.labels) ? o.labels : [];
    if (!values.length) {
      ctx.fillStyle = '#666';
      ctx.fillText(o.empty || 'no laps in this range', 8, h / 2);
      return false;
    }

    const max = Math.max(finite(o.max) && o.max > 0 ? o.max : 1,
      autoMax(values, 0));
    const base = h - 15;
    const slot = w / values.length;
    const bw = Math.max(3, slot * 0.62);

    values.forEach((raw, i) => {
      const v = Math.max(0, Number(raw) || 0);
      // A zero delta still gets a stub, otherwise the best lap is invisible.
      const bh = Math.max(v === 0 ? 3 : 2, (v / max) * (base - 12));
      const x = i * slot + (slot - bw) / 2;
      ctx.fillStyle = (Array.isArray(o.colors) && o.colors[i]) || '#000';
      ctx.fillRect(x, base - bh, bw, bh);
      if (labels[i]) {
        ctx.fillStyle = '#000';
        ctx.fillText(String(labels[i]), x, h - 4);
      }
    });

    if (o.topText) {
      ctx.fillStyle = o.topColor || '#000';
      ctx.fillText(o.topText, 4, 11);
    }
    return true;
  }

  const api = { autoMax, niceMax, bands, drawSeries, drawBars };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CHARTS = api;
})(typeof self !== 'undefined' ? self : this);
