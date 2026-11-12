"use strict";

// ---------------------------------------------------------------------------
// web/ui/mpu3d.js - a small software 3D view of the MPU6050 board.
//
// No WebGL and no three.js: one board, its chip and a ground grid are projected
// onto an ordinary 2D canvas, the way a Processing sketch would. That keeps the
// tab cheap on a phone and needs no new vendor file. Roll, pitch and yaw come
// straight from the firmware fusion, in degrees; yaw is the gyro-integrated one,
// so it drifts and is a heading, not north.
//
// The maths is exported so test/mpu3d.test.js can check the rotations under
// node, with no canvas and no browser.
// ---------------------------------------------------------------------------

const MPU3D = (function () {
  const DEG = Math.PI / 180;

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function unit(v) {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  // Board frame: x right, y forward, z up. The firmware reports roll about x,
  // pitch about y and yaw about z, so the body rotation is yaw * pitch * roll.
  function rotate(p, roll, pitch, yaw) {
    const r = (Number(roll) || 0) * DEG;
    const t = (Number(pitch) || 0) * DEG;
    const y = (Number(yaw) || 0) * DEG;
    const cr = Math.cos(r), sr = Math.sin(r);
    const cp = Math.cos(t), sp = Math.sin(t);
    const cy = Math.cos(y), sy = Math.sin(y);

    const y1 = p[1] * cr - p[2] * sr;          // roll about x
    const z1 = p[1] * sr + p[2] * cr;
    const x2 = p[0] * cp + z1 * sp;            // pitch about y
    const z2 = -p[0] * sp + z1 * cp;
    return [x2 * cy - y1 * sy, x2 * sy + y1 * cy, z2];   // yaw about z
  }

  // Fixed camera: 42 degrees round, 26 degrees up. Looking from above makes a
  // tilt readable; a straight-on view would hide the whole thing.
  const AZ = 42 * DEG, EL = 26 * DEG;
  const RIGHT = [-Math.sin(AZ), Math.cos(AZ), 0];
  const UP = [-Math.sin(EL) * Math.cos(AZ), -Math.sin(EL) * Math.sin(AZ), Math.cos(EL)];
  const DIR = [Math.cos(EL) * Math.cos(AZ), Math.cos(EL) * Math.sin(AZ), Math.sin(EL)];
  const DIST = 6.4, FOCAL = 4.5;

  // Project a world point. Returns [screenX, screenY, depth] in canvas units;
  // screenY is already flipped because canvas y grows downward.
  function project(p, scale) {
    const s = Number.isFinite(scale) ? scale : 1;
    const xc = dot(p, RIGHT), yc = dot(p, UP), zc = dot(p, DIR);
    const k = FOCAL / Math.max(0.6, DIST - zc);
    return [xc * k * s, -yc * k * s, zc];
  }

  const CORNERS = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
  ];
  const FACES = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
    [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]
  ];

  const BOARD = { c: [0, 0, 0.55], h: [1.35, 0.85, 0.08], rgb: [36, 71, 255] };
  const CHIP = { c: [0, -0.10, 0.70], h: [0.38, 0.32, 0.05], rgb: [255, 230, 0] };
  const LIGHT = unit([-0.35, -0.5, 0.85]);

  function tint(rgb, lit) {
    // 0.55 on a face turned away from the light, 1.0 on one turned into it.
    const k = 0.55 + 0.45 * Math.max(0, Math.min(1, lit));
    return "rgb(" + Math.round(rgb[0] * k) + "," +
      Math.round(rgb[1] * k) + "," + Math.round(rgb[2] * k) + ")";
  }

  function facesOf(box, roll, pitch, yaw) {
    const world = CORNERS.map(c => rotate([
      box.c[0] + c[0] * box.h[0],
      box.c[1] + c[1] * box.h[1],
      box.c[2] + c[2] * box.h[2]
    ], roll, pitch, yaw));
    return FACES.map(idx => {
      const pts = idx.map(i => world[i]);
      const n = unit(cross(sub(pts[1], pts[0]), sub(pts[3], pts[0])));
      return { pts, lit: dot(n, LIGHT) };
    });
  }

  function draw(canvas, att) {
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width < 40) return;               // hidden tab: keep the last frame

    const w = Math.round(rect.width);
    const h = Math.round(rect.height || 170);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const roll = att && Number.isFinite(att.roll) ? att.roll : 0;
    const pitch = att && Number.isFinite(att.pitch) ? att.pitch : 0;
    const yaw = att && Number.isFinite(att.yaw) ? att.yaw : 0;
    const live = !!(att && att.valid);

    const scale = Math.min(w, h) * 0.38;
    const cx = w / 2, cy = h * 0.52;
    const at = p => {
      const q = project(p, scale);
      return [cx + q[0], cy + q[1], q[2]];
    };

    // ---- ground grid, fixed in the world: the reference the board tilts on --
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.beginPath();
    for (let i = -3; i <= 3; i++) {
      const v = i * 0.62;
      const a1 = at([v, -2.1, 0]), b1 = at([v, 2.1, 0]);
      const a2 = at([-2.1, v, 0]), b2 = at([2.1, v, 0]);
      ctx.moveTo(a1[0], a1[1]); ctx.lineTo(b1[0], b1[1]);
      ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]);
    }
    ctx.stroke();

    // ---- world axes: x red, y green, z blue (drawn under the board) ---------
    const AXES = [
      { v: [2.0, 0, 0], c: "#ff3b1f" },
      { v: [0, 2.0, 0], c: "#00a63e" },
      { v: [0, 0, 1.7], c: "#2447ff" }
    ];
    const o = at([0, 0, 0]);
    for (const ax of AXES) {
      const tip = at(ax.v);
      ctx.beginPath();
      ctx.moveTo(o[0], o[1]); ctx.lineTo(tip[0], tip[1]);
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = ax.c;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(o[0], o[1], 2.2, 0, Math.PI * 2);
    ctx.fill();

    // ---- the board and its chip --------------------------------------------
    const toFace = (f, rgb) => {
      const screen = f.pts.map(at);
      let depth = 0;
      for (const s of screen) depth += s[2];
      return { screen, depth: depth / screen.length, lit: f.lit, rgb };
    };
    const faces = facesOf(BOARD, roll, pitch, yaw).map(f => toFace(f, BOARD.rgb))
      .concat(facesOf(CHIP, roll, pitch, yaw).map(f => toFace(f, CHIP.rgb)));

    faces.sort((a, b) => a.depth - b.depth);
    ctx.lineJoin = "round";
    for (const f of faces) {
      ctx.beginPath();
      ctx.moveTo(f.screen[0][0], f.screen[0][1]);
      for (let k = 1; k < f.screen.length; k++) {
        ctx.lineTo(f.screen[k][0], f.screen[k][1]);
      }
      ctx.closePath();
      ctx.fillStyle = live ? tint(f.rgb, f.lit) : "rgba(120,120,120,0.45)";
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // ---- state label -------------------------------------------------------
    ctx.font = "700 10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = live ? "rgba(0,0,0,0.55)" : "#ff3b1f";
    ctx.fillText(live ? "MPU6050 · yaw drifts" : "NO MPU DATA", 6, 5);
  }

  return { draw, rotate, project, cross, unit };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MPU3D;
