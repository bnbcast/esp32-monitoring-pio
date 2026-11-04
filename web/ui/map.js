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
  let threeRenderer = null;
  let threeScene = null;
  let threeCamera = null;
  let threeCar = null;
  let customLayer = null;
  let styleName = "dark";

  // vehicle state
  let vehicle = {
    lng: null, lat: null, heading: 0, speed: 0, hdop: null, fix: false,
    ts: 0, alt: null, roll: null, pitch: null, yaw: null,
    magHeading: null, danger: 0
  };

  // trail (speed-colored polyline)
  let trailSource = null;
  let trailLayer = null;
  let trailCoords = [];

  // marker + accuracy circle + heading wedge
  let markerEl = null;
  let accuracyCircle = null;
  let headingWedge = null;

  // modes
  let myLocMode = "recenter";   // recenter | follow | compass | north
  let lockNorth = false;
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
    map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");

    map.on("load", () => {
      initLayers();
      resize();
    });

    map.on("resize", resize);
    map.on("move", () => {
      if (myLocMode === "free") myLocMode = "free"; // user gestured -> free mode
    });
  }

  function initLayers() {
    // ---- Trail source (geojson) ----
    trailSource = {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    };
    map.addSource("trail", trailSource);

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

    // ---- Custom 3D car layer ----
    map.addLayer({
      id: "car-layer",
      type: "custom",
      renderingMode: "3d",
      onAdd: onCarLayerAdd,
      render: onCarLayerRender
    }, "trail");
  }

  function onCarLayerAdd(ctx) {
    const gl = ctx.gl;
    const canvas = gl.canvas;

    threeRenderer = new THREE.WebGLRenderer({
      canvas: canvas,
      context: gl,
      alpha: true,
      premultipliedAlpha: false
    });
    threeRenderer.setSize(canvas.width, canvas.height);
    threeRenderer.autoClear = false;

    threeScene = new THREE.Scene();

    // Camera — match MapLibre view-projection
    threeCamera = new THREE.PerspectiveCamera(
      45, canvas.width / canvas.height, 0.1, 1000
    );

    // Simple F1 car: body + cockpit + wing
    const group = new THREE.Group();

    // Body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.6, 4.4),
      new THREE.MeshStandardMaterial({ color: 0xff1100 })
    );
    body.position.y = 0.3;
    group.add(body);

    // Cockpit
    const cockpit = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.4, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    cockpit.position.set(0, 0.6, 0);
    group.add(cockpit);

    // Front wing
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.15, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    wing.position.set(0, 0.0, -2.6);
    group.add(wing);

    // Rear wing
    const rearWing = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.25, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    rearWing.position.set(0, 0.35, 2.4);
    group.add(rearWing);

    // Wheels
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.5, 16);
    for (const pos of [
      [-1.3, 0.15, -1.8], [1.3, 0.15, -1.8],
      [-1.3, 0.15, 1.6], [1.3, 0.15, 1.6]
    ]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(...pos);
      w.rotation.z = Math.PI / 2;
      group.add(w);
    }

    threeCar = group;
    threeScene.add(group);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    threeScene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 5);
    threeScene.add(dir);

    customLayer = ctx;
  }

  function onCarLayerRender(gl, matrix) {
    if (!threeRenderer || !threeCamera || !threeCar || !vehicle.lat) return;

    const c = threeCamera;
    const m = matrix;

    // Build projection/view matrix from MapLibre
    const proj = new THREE.Matrix4().fromArray([
      m[0], m[4], m[8],  m[12],
      m[1], m[5], m[9],  m[13],
      m[2], m[6], m[10], m[14],
      m[3], m[7], m[11], m[15]
    ]);
    c.projectionMatrix = proj;
    c.position.set(0, 0, 0);
    c.lookAt(0, 0, -1);
    c.updateMatrixWorld();
    c.matrixWorldInverse.getInverse(c.matrixWorld);

    // Position car at vehicle location
    const merc = maplibregl.MercatorCoordinate.fromLngLat(
      { lng: vehicle.lng, lat: vehicle.lat },
      0
    );

    // Orientation quaternion from heading + roll/pitch
    const headingRad = deg2rad(vehicle.heading);
    const rollRad = deg2rad(vehicle.roll || 0);
    const pitchRad = deg2rad(vehicle.pitch || 0);

    const qHeading = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, -headingRad, "YXZ")
    );
    const qTilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitchRad, rollRad, 0, "YXZ")
    );
    threeCar.position.set(merc.x, merc.y, merc.z);
    threeCar.quaternion.copy(qHeading).multiply(qTilt);

    // Danger color coding
    const danger = vehicle.danger || 0;
    const body = threeCar.children[0];
    if (body && body.material) {
      body.material.color.setHex(danger >= 2 ? 0xff3b1f : danger >= 1 ? 0xffe600 : 0xff1100);
    }

    threeRenderer.render(threeScene, threeCamera);
    map.triggerRepaint();
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

    // Update DOM via app (callback)
    if (window.renderVehicleUI) window.renderVehicleUI();

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

    // Auto-follow modes
    if (myLocMode === "follow" || myLocMode === "recenter") {
      flyTo(lng, lat, 15, 0, 0);
      if (myLocMode === "recenter") myLocMode = "follow";
    } else if (myLocMode === "north") {
      flyTo(lng, lat, 15, 0, 0);
      map.easeTo({ bearing: 0, duration: 300 });
    }

    // Street view camera
    if (streetView && threeRenderer) {
      updateStreetCamera();
    }
  }

  function updateMarker() {
    const el = markerEl;
    if (!el) return;
    const conf = headingConfidence;
    const size = 24 + 16 * conf;
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.border = "4px solid #000";
    el.style.background = danger >= 2 ? "#ff3b1f" : danger >= 1 ? "#ffe600" : "#00e676";
    el.style.boxShadow = "6px 6px 0 #000";
    el.style.transform = `translate(-50%, -50%) rotate(${fusedHeading}deg)`;
    el.style.opacity = conf > 0.1 ? "1" : "0.4";
    el.style.transition = conf > 0.1 ? "transform 0.1s" : "none";
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
    if (!trailSource) return;
    const coords = trailCoords.map(p => [p.lng, p.lat]);
    if (coords.length < 2) return;
    trailSource.setData({
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
    if (trailSource) trailSource.setData({ type: "FeatureCollection", features: [] });
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
    if (threeRenderer) {
      const c = container;
      threeRenderer.setSize(c.clientWidth, c.clientHeight);
      if (threeCamera) threeCamera.aspect = c.clientWidth / c.clientHeight;
    }
  }

  function setStreetView(on) {
    streetView = !!on;
    const el = document.getElementById("view3d");
    if (!el) return;
    if (on) {
      el.classList.add("active");
      initThreeStreet();
    } else {
      el.classList.remove("active");
    }
    resize();
  }

  function initThreeStreet() {
    if (threeRenderer) return;
    const el = document.getElementById("view3d");
    const canvas = document.createElement("canvas");
    el.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / el.clientHeight, 0.1, 2000);
    camera.position.set(0, 8, 12);

    // Ground plane (brutalist: solid black grid)
    const grid = new THREE.GridHelper(200, 40, 0x222222, 0x111111);
    scene.add(grid);

    // Simple car placeholder (will be overridden by MapLibre custom layer when back in 2D)
    const geo = new THREE.BoxGeometry(2, 1, 4);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff1100 });
    const car = new THREE.Mesh(geo, mat);
    car.position.y = 0.5;
    scene.add(car);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(10, 20, 10);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));

    // Store for render loop
    window.__threeStreet = { renderer, scene, camera, car, el, canvas };

    animateStreet();
  }

  function animateStreet() {
    if (!streetView) return;
    const s = window.__threeStreet;
    if (!s) return;
    s.renderer.render(s.scene, s.camera);
    requestAnimationFrame(animateStreet);
  }

  function setStreetCam(mode) {
    streetCam = mode;
    const s = window.__threeStreet;
    if (!s) return;
    if (mode === "chase") { s.camera.position.set(0, 8, 12); s.camera.lookAt(0, 0, 0); }
    else if (mode === "driver") { s.camera.position.set(0, 2, 1); s.camera.lookAt(0, 0, -10); }
    else if (mode === "orbit") { s.camera.position.set(12, 10, 12); s.camera.lookAt(0, 2, 0); }
  }

  function updateStreetCamera() {
    // In a full build this would chase the MapLibre vehicle position;
    // here we keep the simple Three.js street view.
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
    toggleLockNorth,
    cycleMyLocation,
    getHeading,
    setHeadingSource,
    setStreetView,
    setStreetCam,
    flyTo,
    style: () => styleName,
    setStyle: (name) => { styleName = name; if (map) map.setStyle(RASTER_STYLES[name].url); },
    isStreetView: () => streetView
  };
})();
