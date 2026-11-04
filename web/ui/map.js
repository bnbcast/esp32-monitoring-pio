"use strict";

// ---------------------------------------------------------------------------
// web/ui/map.js — MapLibre GL JS module (neo-brutalist refactor)
// Stack: MapLibre GL JS + CartoDB raster tiles (free, key-less) +
//        Three.js custom 3D car layer for the street view.
// No Google Maps, no paid APIs, no API keys. Attribution preserved.
// ---------------------------------------------------------------------------

const MAP = (function () {
  // ---- config -------------------------------------------------------------
  const RASTER_STYLES = {
    dark: {
      name: "CartoDB Dark Matter",
      url:  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
    },
    light: {
      name: "CartoDB Positron",
      url:  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
    }
  };

  const HEADING = {
    GPS_SPEED_THRESHOLD: 3,      // km/h — above this, GPS course is trusted
    GPS_HDOP_MAX: 6,             // max HDOP for GPS heading to be valid
    GYRO_DRIFT_PULL: 0.03,       // how fast gyro heading is pulled back to GPS
    CONFIDENCE_DECAY_MS: 15000,  // confidence decays to 0 over this many ms
    GYRO_HEADING_OFFSET: 0       // calibrated offset (degrees)
  };

  // ---- map state ----------------------------------------------------------
  let map = null;
  let styleName = "light";

  // vehicle state
  let vehicle = {
    lng: null, lat: null, heading: 0, speed: 0, hdop: null, fix: false,
    ts: 0, alt: null, roll: null, pitch: null, yaw: null,
    magHeading: null, danger: 0
  };

  // trail (speed-colored polyline)
  let trailCoords = [];

  // marker + accuracy circle + heading wedge
  let markerEl = null;
  let accuracyCircle = null;
  let headingWedge = null;

  // modes
  let myLocMode = "recenter";   // recenter | follow | compass | north
  let lockNorth = false;
  let followMode = false;
  let streetView = false;
  let streetCam = "chase";     // chase | driver | orbit

  // heading fusion
  let fusedHeading = 0;
  let headingConfidence = 0;
  let headingSource = "gps";
  let headingSourcePref = "auto";  // auto | gps | phone | mag
  let lastGyroYaw = 0;
  let lastGyroTs = 0;
  let lastGpsHeading = 0;
  let lastGpsTs = 0;

  // DOM
  let container = null;

  // ---- helpers ------------------------------------------------------------
  const deg2rad = d => d * Math.PI / 180;
  const rad2deg = r => r * 180 / Math.PI;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function wrap180(a) {
    while (a > 180) a -= 360;
    while (a < -180) a += 360;
    return a;
  }

  function wrap360(a) { return ((a % 360) + 360) % 360; }

  // ---- heading fusion -----------------------------------------------------
  function updateHeadingFusion(gpsHeading, gpsTs, gyroYaw, gyroTs, magHeading, speed, hdop) {
    const now = Date.now();

    // Decide if GPS heading is trustworthy
    const gpsValid = speed > HEADING.GPS_SPEED_THRESHOLD &&
      hdop != null && hdop <= HEADING.GPS_HDOP_MAX &&
      gpsHeading != null && !isNaN(gpsHeading);

    let newSource = headingSourcePref;
    let gpsConf = 0;

    if (newSource === "auto") {
      if (gpsValid) { newSource = "gps"; gpsConf = 1; }
      else if (magHeading != null && !isNaN(magHeading)) { newSource = "mag"; gpsConf = 0.6; }
      else { newSource = "gyro"; gpsConf = 0; }
    } else if (newSource === "gps") {
      if (gpsValid) gpsConf = 1; else newSource = "gyro";
    } else if (newSource === "mag") {
      if (magHeading != null && !isNaN(magHeading)) gpsConf = 0.6;
      else newSource = "gyro";
    } else if (newSource === "phone") {
      // phone compass handled externally via magHeading
      if (magHeading != null && !isNaN(magHeading)) { newSource = "mag"; gpsConf = 0.8; }
      else newSource = "gyro";
    }

    // Confidence decay when GPS not updating
    if (newSource === "gps") {
      headingConfidence = Math.min(1, headingConfidence + 0.1);
      lastGpsHeading = gpsHeading;
      lastGpsTs = now;
    } else {
      const dt = (now - lastGpsTs) / 1000;
      headingConfidence = Math.max(0, headingConfidence - dt / (HEADING.CONFIDENCE_DECAY_MS / 1000));
    }

    // Fuse
    let targetHeading;
    if (newSource === "gps") {
      targetHeading = gpsHeading;
    } else if (newSource === "mag") {
      targetHeading = magHeading;
    } else {
      // gyro integration
      if (lastGyroTs > 0) {
        const dt = (now - lastGyroTs) / 1000;
        lastGyroYaw += gyroYaw * dt * (Math.PI / 180); // assume gyroYaw is deg/s
      }
      lastGyroTs = now;
      // slow pull toward GPS when available
      if (gpsValid) {
        const pull = HEADING.GYRO_DRIFT_PULL;
        lastGyroYaw += wrap180(gpsHeading - rad2deg(lastGyroYaw)) * pull;
      }
      targetHeading = rad2deg(lastGyroYaw);
    }

    // Smooth
    fusedHeading = wrap360(fusedHeading + wrap180(targetHeading - fusedHeading) * 0.15);
    headingSource = newSource;
  }

  function getHeading() {
    return {
      heading: fusedHeading,
      confidence: clamp(headingConfidence, 0, 1),
      source: headingSource
    };
  }

  function setHeadingSource(pref) {
    headingSourcePref = pref;
    headingConfidence = 0;
  }

  // ---- map lifecycle ------------------------------------------------------
  function create(id) {
    container = document.getElementById(id);
    if (!container) return;

    map = new maplibregl.Map({
      container: id,
      style: RASTER_STYLES[styleName].url,
      center: [0, 0],
      zoom: 13,
      pitch: 0,
      bearing: 0,
      interaction: true,
      attributionControl: true
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ position: "bottom-left" }), "bottom-left");

    map.on("load", () => {
      initLayers();
      createMarker();
      resize();
    });

    map.on("resize", resize);
    map.on("move", () => {
      if (myLocMode === "free") myLocMode = "free"; // user gestured -> free mode
    });
  }

  function initLayers() {
    // ---- Trail source (geojson) ----
    map.addSource("trail", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });

    // ---- Trail layer (speed-colored, solid) ----
    map.addLayer({
      id: "trail",
      type: "line",
      source: "trail",
      layout: {
        "line-cap": "round",
        "line-join": "round"
      },
      paint: {
        "line-width": 4,
        "line-color": [
          "interpolate", ["linear"], ["zoom"],
          12, ["interpolate", ["linear"], ["get", "kmh"], 0, "#00e676", 30, "#ffe600", 60, "#ff3b1f"],
          16, ["interpolate", ["linear"], ["get", "kmh"], 0, "#00e676", 30, "#ffe600", 60, "#ff3b1f"]
        ],
        "line-opacity": 0.85
      }
    });

    // ---- Accuracy circle ----
    map.addLayer({
      id: "accuracy",
      type: "fill",
      source: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      },
      paint: {
        "fill-color": "#2447ff",
        "fill-opacity": 0.15
      }
    });

    // ---- Heading wedge (translucent view cone) ----
    map.addLayer({
      id: "heading-wedge",
      type: "fill",
      source: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      },
      paint: {
        "fill-color": "#2447ff",
        "fill-opacity": 0.25
      }
    });
  }

  // ---- vehicle / trail updates -------------------------------------------
  function setVehicle(lng, lat, heading, speed, hdop, fix, ts,
                      roll, pitch, yaw, magHeading, danger, alt) {
    vehicle.lng = lng; vehicle.lat = lat;
    vehicle.heading = heading; vehicle.speed = speed;
    vehicle.hdop = hdop; vehicle.fix = fix; vehicle.ts = ts;
    vehicle.alt = alt; vehicle.danger = danger || 0;
    vehicle.roll = roll; vehicle.pitch = pitch; vehicle.yaw = yaw;
    vehicle.magHeading = magHeading;

    // Heading fusion
    updateHeadingFusion(heading, ts, yaw ? yaw * 10 : 0, ts,
      magHeading, speed, hdop);

    // DOM (map HUD / banner) is updated by app.renderData / renderBanner

    // Marker DOM element
    updateMarker();

    // Accuracy circle
    updateAccuracy();

    // Heading wedge
    updateHeadingWedge();

    // Trail
    if (fix && lng != null && lat != null) {
      const pt = { lng, lat, kmh: speed, hdop };
      trailCoords.push(pt);
      if (trailCoords.length > 120) trailCoords.shift();
      updateTrail();
    }

    // Sync street-view car (local scene: heading + dead-reckoned position)
    if (streetView) {
      if (!streetVehicle) streetVehicle = { x: 0, z: 0, heading: 0 };
      streetVehicle.heading = fusedHeading;
      // Move forward/back based on speed (km/h -> scene units per frame is handled in animate)
      // Store last speed for dead reckoning in animate loop
      streetVehicle._lastSpeed = speed;
      streetVehicle._dt = (ts - (streetVehicle._lastTs || ts)) / 1000;
      streetVehicle._lastTs = ts;
    }

    // Auto-follow modes
    if (followMode || myLocMode === "recenter") {
      flyTo(lng, lat, 15, lockNorth ? 0 : fusedHeading, 0);
      if (myLocMode === "recenter") myLocMode = "follow";
    } else if (myLocMode === "north" || lockNorth) {
      flyTo(lng, lat, 15, 0, 0);
    }

    // Street view camera
    if (streetView) {
      updateStreetCamera();
    }
  }

  function updateMarker() {
    const el = markerEl;
    if (!el || !vehicle.lat || !vehicle.lng) return;
    const conf = headingConfidence;
    const size = 24 + 16 * conf;
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.border = "4px solid #000";
    el.style.background = danger >= 2 ? "#ff3b1f" : danger >= 1 ? "#ffe600" : "#00e676";
    el.style.boxShadow = "6px 6px 0 #000";
    el.style.transformOrigin = 'center';
    el.style.opacity = conf > 0.1 ? "1" : "0.4";
    el.style.transition = conf > 0.1 ? "transform 0.1s" : "none";

    // Project lng/lat to screen pixels
    const px = map.project({ lng: vehicle.lng, lat: vehicle.lat });
    el.style.left = (px.x - size / 2) + "px";
    el.style.top = (px.y - size / 2) + "px";
    el.style.transform = `translate(-50%, -50%) rotate(${fusedHeading}deg)`;
  }

  function updateAccuracy() {
    const src = map.getSource("accuracy");
    if (!src) return;
    const hdop = vehicle.hdop || 5;
    const radius = clamp(hdop * 3, 3, 60); // meters
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Point",
          coordinates: [vehicle.lng, vehicle.lat]
        }
      }],
      // buffer via turf-like circle — simple approximation
      _buffer: radius
    });
    // MapLibre doesn't buffer natively; draw a circle via many points
    const circle = circleCoords(vehicle.lng, vehicle.lat, radius, 32);
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [circle] }
      }]
    });
  }

  function createMarker() {
    if (markerEl) return;
    markerEl = document.createElement('div');
    markerEl.className = 'vehicle-marker';
    markerEl.style.position = 'absolute';
    markerEl.style.width = '24px';
    markerEl.style.height = '24px';
    markerEl.style.border = '4px solid #000';
    markerEl.style.background = '#00e676';
    markerEl.style.boxShadow = '6px 6px 0 #000';
    markerEl.style.borderRadius = '0';
    markerEl.style.transformOrigin = 'center';
    markerEl.style.pointerEvents = 'none';
    markerEl.style.zIndex = '100';
    container.appendChild(markerEl);
  }

  function circleCoords(lng, lat, radiusM, n) {
    const coords = [];
    const d = radiusM / 111320;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      coords.push([
        lng + (d * Math.cos(a)) / Math.cos(lat * Math.PI / 180),
        lat + d * Math.sin(a)
      ]);
    }
    return coords;
  }

  function updateHeadingWedge() {
    const src = map.getSource("heading-wedge");
    if (!src) return;
    const conf = clamp(headingConfidence, 0, 1);
    if (conf < 0.05) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const r = 12 + 8 * conf; // meters
    const d = r / 111320;
    const h = deg2rad(fusedHeading);
    const w = deg2rad(35 * conf); // wedge width ~ confidence
    const cLat = Math.cos(vehicle.lat * Math.PI / 180);
    const pts = [[vehicle.lng, vehicle.lat]];
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const a = h - w / 2 + (w * i) / steps;
      pts.push([
        vehicle.lng + (d * Math.cos(a)) / cLat,
        vehicle.lat + d * Math.sin(a)
      ]);
    }
    pts.push([vehicle.lng, vehicle.lat]);
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [pts] }
      }]
    });
  }

  function updateTrail() {
    if (!map) return;
    const src = map.getSource("trail");
    if (!src) return;
    const coords = trailCoords.map(p => [p.lng, p.lat]);
    if (coords.length < 2) return;
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords }
      }]
    });
  }

  function clearTrail() {
    trailCoords = [];
    if (map) {
      const src = map.getSource("trail");
      if (src) src.setData({ type: "FeatureCollection", features: [] });
    }
  }

  // ---- camera / controls --------------------------------------------------
  function flyTo(lng, lat, zoom, bearing, pitch, duration = 600) {
    if (!map) return;
    map.easeTo({ center: [lng, lat], zoom, bearing, pitch, duration });
  }

  function recenterNow() {
    if (vehicle.lat != null && vehicle.lng != null) {
      myLocMode = "recenter";
      flyTo(vehicle.lng, vehicle.lat, 15, lockNorth ? 0 : fusedHeading, 0);
    }
  }

  function resetNorth() {
    lockNorth = false;
    myLocMode = "compass";
    if (map) map.easeTo({ bearing: 0, duration: 400 });
  }

  function toggleLockNorth() {
    lockNorth = !lockNorth;
    if (lockNorth) {
      myLocMode = "north";
      map.easeTo({ bearing: 0, duration: 400 });
    }
    return lockNorth;
  }

  function cycleMyLocation() {
    const order = ["recenter", "follow", "compass", "north"];
    let i = order.indexOf(myLocMode);
    i = (i + 1) % order.length;
    myLocMode = order[i];
    if (myLocMode === "recenter" || myLocMode === "follow") {
      recenterNow();
    } else if (myLocMode === "north") {
      toggleLockNorth();
    }
    return myLocMode;
  }

  function resize() {
    if (!map || !container) return;
    map.resize();
    const s = window.__threeStreet;
    if (s && s.renderer) {
      const c = s.el;
      s.renderer.setSize(c.clientWidth, c.clientHeight);
      if (s.camera) s.camera.aspect = c.clientWidth / c.clientHeight;
    }
  }

  let threeLoadPromise = null;

  function loadThree() {
    if (threeLoadPromise) return threeLoadPromise;
    threeLoadPromise = new Promise((resolve, reject) => {
      if (window.THREE) { resolve(window.THREE); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.onload = () => resolve(window.THREE);
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return threeLoadPromise;
  }

  function setStreetView(on) {
    streetView = !!on;
    const el = document.getElementById("view3d");
    if (!el) return;
    if (on) {
      el.classList.add("active");
      loadThree().then(() => { initThreeStreet(); resize(); });
    } else {
      el.classList.remove("active");
    }
    resize();
  }

  let streetVehicle = null; // {x, z, heading} in street scene units

  function initThreeStreet() {
    if (window.__threeStreet) return;
    const el = document.getElementById("view3d");
    const canvas = document.createElement("canvas");
    el.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    scene.fog = new THREE.Fog(0x0a0a0a, 20, 120);

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 1000);

    // Ground — brutalist dark asphalt
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Road markings (dashed center line)
    const markGeo = new THREE.PlaneGeometry(0.4, 400);
    const markMat = new THREE.MeshStandardMaterial({ color: 0xffe600 });
    for (let i = -200; i < 200; i += 10) {
      const m = new THREE.Mesh(markGeo, markMat);
      m.position.set(0, 0.02, i);
      m.rotation.x = -Math.PI / 2;
      if ((i / 10) % 2 === 0) m.visible = false;
      scene.add(m);
    }

    // Simple buildings around (brutalist blocks)
    const bMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const bPos = [
      [-60, 0, -60], [60, 0, -60], [-60, 0, 60], [60, 0, 60],
      [-120, 0, -30], [120, 0, -30], [-120, 0, 30], [120, 0, 30]
    ];
    bPos.forEach(([x, y, z]) => {
      const h = 15 + Math.random() * 25;
      const w = 10 + Math.random() * 8;
      const d = 10 + Math.random() * 8;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bMat);
      b.position.set(x, h / 2, z);
      b.castShadow = true; b.receiveShadow = true;
      scene.add(b);
    });

    // Car
    const carGeo = new THREE.BoxGeometry(2.2, 0.9, 4.4);
    const carMat = new THREE.MeshStandardMaterial({ color: 0xff1100 });
    const car = new THREE.Mesh(carGeo, carMat);
    car.position.y = 0.45;
    car.castShadow = true;
    scene.add(car);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(20, 40, 20);
    light.castShadow = true;
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    window.__threeStreet = { renderer, scene, camera, car, ground, el, canvas };
    streetVehicle = { x: 0, z: 0, heading: 0 };

    animateStreet();
  }

  function animateStreet() {
    if (!streetView) return;
    const s = window.__threeStreet;
    if (!s) return;

    // Sync car to vehicle state (dead reckoning from speed)
    if (streetVehicle && s.car) {
      if (streetVehicle._lastSpeed && streetVehicle._dt) {
        const move = (streetVehicle._lastSpeed / 3.6) * streetVehicle._dt; // m/s * s
        const hR = streetVehicle.heading * Math.PI / 180;
        streetVehicle.x -= Math.sin(hR) * move;
        streetVehicle.z -= Math.cos(hR) * move;
      }
      s.car.position.set(streetVehicle.x, 0.45, streetVehicle.z);
      s.car.rotation.y = -streetVehicle.heading; // Three.js uses -Y for heading
    }

    s.renderer.render(s.scene, s.camera);
    requestAnimationFrame(animateStreet);
  }

  function setStreetCam(mode) {
    streetCam = mode;
    const s = window.__threeStreet;
    if (!s) return;
    if (mode === "chase") {
      s.camera.position.set(0, 9, 14);
      s.camera.lookAt(0, 1, 0);
    } else if (mode === "driver") {
      s.camera.position.set(0, 1.6, 1.2);
      s.camera.lookAt(0, 1.6, -10);
    } else if (mode === "orbit") {
      s.camera.position.set(14, 10, 14);
      s.camera.lookAt(0, 2, 0);
    }
  }

  function updateStreetCamera() {
    if (!streetView || !streetVehicle) return;
    const s = window.__threeStreet;
    if (!s) return;
    const h = streetVehicle.heading;
    // Chase camera behind the car, offset by heading
    const dist = 14;
    const hR = h * Math.PI / 180;
    s.camera.position.set(
      -Math.sin(hR) * dist,
      9,
      -Math.cos(hR) * dist
    );
    s.camera.lookAt(streetVehicle.x, 1, streetVehicle.z);
  }

  function setFollowMode(on) {
    followMode = !!on;
    myLocMode = followMode ? "follow" : "recenter";
    if (followMode && vehicle.lat != null && vehicle.lng != null) {
      flyTo(vehicle.lng, vehicle.lat, 15, lockNorth ? 0 : fusedHeading, 0);
    }
  }

  function setLockNorth(on) {
    lockNorth = !!on;
    if (lockNorth) {
      myLocMode = "north";
      if (map) map.easeTo({ bearing: 0, duration: 400 });
    }
  }

  // ---- public API ---------------------------------------------------------
  return {
    create,
    loaded: () => new Promise(res => { if (map) { map.once("load", res); } else res(); }),
    resize,
    setVehicle,
    clearTrail,
    recenterNow,
    resetNorth,
    setLockNorth,
    setFollowMode,
    flyTo,
    getHeading,
    setHeadingSource,
    setStreetView,
    setStreetCam,
    style: () => styleName,
    setStyle: (name) => { styleName = name; if (map) map.setStyle(RASTER_STYLES[name].url); },
    isStreetView: () => streetView
  };
})();
