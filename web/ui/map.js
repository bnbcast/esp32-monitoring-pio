"use strict";

// ---------------------------------------------------------------------------
// web/ui/map.js — MapLibre GL JS module (neo-brutalist refactor)
// Stack: MapLibre GL JS + CartoDB raster tiles (free, key-less).
// No Google Maps, no paid APIs, no API keys.
// ---------------------------------------------------------------------------

const MAP = (function () {
  // CSP-safe worker — must be set before Map constructor.
  // Resolved against the document base URI so the app also works when it is
  // served from a sub-path (GitHub Pages: /esp32-monitoring-pio/), not only
  // from the domain root.
  if (typeof maplibregl !== 'undefined' && !maplibregl.workerUrl) {
    maplibregl.workerUrl = new URL('vendor/maplibre-gl-csp-worker.js', document.baseURI).href;
  }

  // ---- config -------------------------------------------------------------
  // Tile providers, best first, plus WHY this order:
  //   * OSM's tile server answers HTTP 200 with a tiny 103-byte "access blocked"
  //     image whenever the Referer is a third-party site (github.io included) —
  //     that is the blank/blocked map users were seeing.
  //   * CARTO's keyless basemaps answer every z/x/y with the SAME 2049-byte
  //     placeholder in that situation, so they are not usable either.
  //   * Esri's ArcGIS basemaps serve real, distinct tiles with a browser
  //     Referer and need no key. They are primary; OSM stays as a last-ditch
  //     fallback for networks where Esri is unreachable.
  const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  const TILE_PROVIDERS = [
    {
      id: 'esri-street',
      label: 'Esri World Street',
      maxzoom: 19,
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'
      ],
      attribution: 'Tiles \u00A9 Esri, HERE, Garmin, \u00A9 OpenStreetMap contributors'
    },
    {
      id: 'esri-topo',
      label: 'Esri World Topo',
      maxzoom: 19,
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'
      ],
      attribution: 'Tiles \u00A9 Esri, HERE, Garmin, \u00A9 OpenStreetMap contributors'
    },
    {
      id: 'osm',
      label: 'OpenStreetMap',
      maxzoom: 19,
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
      ],
      attribution: '\u00A9 OpenStreetMap contributors'
    }
  ];

  // Vector basemap: buildings + POI/street labels, crisp at any zoom, no key.
  // OpenMapTiles schema on OpenFreeMap (free, no signup). The raster providers
  // below stay as the fallback if this host is unreachable.
  const VECTOR_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

  // Local dev server proxies tiles (adds a proper User-Agent). Only used on
  // localhost, where a proxy is actually reachable.
  if (IS_LOCAL) {
    TILE_PROVIDERS.unshift({
      id: 'dev-proxy',
      label: 'dev tile proxy',
      maxzoom: 19,
      tiles: [location.origin + '/tiles/{z}/{x}/{y}.png'],
      attribution: '\u00A9 OpenStreetMap contributors'
    });
  }

  let tileProviderIndex = 0;

  function buildStyle(provider) {
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: provider.tiles,
          tileSize: 256,
          maxzoom: provider.maxzoom,
          attribution: provider.attribution
        }
      },
      layers: [{
        id: 'base-layer',
        type: 'raster',
        source: 'base',
        minzoom: 0,
        maxzoom: provider.maxzoom
      }]
    };
  }

  const MAP_STYLE = buildStyle(TILE_PROVIDERS[0]);

  // Where to look before the first GPS fix arrives. [0,0] is the Gulf of
  // Guinea, which looks like a broken map; the board's last known area is a
  // far more useful default and is replaced the moment a fix comes in.
  const DEFAULT_CENTER = [107.502952, -6.909235];   // lng, lat
  const DEFAULT_ZOOM = 12;

  // A phone at 3x has nine times the pixels of a 1x screen, and every one of them
  // is painted again on every frame. Capping the drawing buffer at 2x costs
  // nothing visible at arm's length and removes more than half the fill work.
  const PIXEL_RATIO_CAP = 2;

  function isPhone() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  // What to switch off on a phone, and what must never be switched off:
  //   * OUT: polygon/line decoration that costs fill rate and tells you nothing
  //     about where the car is - building footprints and 3D extrusions, airport
  //     aprons, runways, taxiways.
  //   * IN: every symbol layer. Street names, place names and building/POI
  //     labels are what make the map readable, so they stay.
  const HEAVY_LAYER = /(^|[-_])(building|aeroway)(?=$|[-_])/i;

  function isDecorative(layer) {
    return layer && layer.type !== "symbol" && HEAVY_LAYER.test(layer.id || "");
  }

  const HEADING = {
    GPS_SPEED_THRESHOLD: 3,      // km/h — above this, GPS course is trusted
    GPS_HDOP_MAX: 6,             // max HDOP for GPS heading to be valid
    GYRO_DRIFT_PULL: 0.03,       // how fast gyro heading is pulled back to GPS
    CONFIDENCE_DECAY_MS: 15000,  // confidence decays to 0 over this many ms
    GYRO_HEADING_OFFSET: 0       // calibrated offset (degrees)
  };

  // ---- map state ----------------------------------------------------------
  let map = null;
  let mapReady = false;

  // vehicle state
  let vehicle = {
    lng: null, lat: null, heading: 0, speed: 0, hdop: null, fix: false,
    ts: 0, alt: null, roll: null, pitch: null, yaw: null,
    magHeading: null, danger: 0
  };

  // Last accepted trail point. The marker snaps to this while stationary, so a
  // +-3 m GPS wobble cannot make it drift or spin on the spot.
  let anchor = { lng: null, lat: null };
  let lastMoveTs = 0;
  let stopped = true;
  let parkedNow = false;        // position cloud says "not moving" (trustworthy)
  let lastSampleOk = true;      // last fix passed the physics gate
  let frozenHeading = 0;

  // trail (speed-colored polyline) + its measured length
  let trailCoords = [];
  let trailDistM = 0;
  const TRAIL_MAX = 800;           // drawn vertices before decimation (was 1200)
  const TRAIL_STEP_MOVING = 3.0;   // metres between accepted points
  const TRAIL_STEP_STOPPED = 15.0; // deadband while parked (grows with HDOP)
  let trailRaf = 0;
  let trailSeg = 0;             // bumped after a fix outage, so lines do not bridge it

  // Parked-receiver noise often arrives as a single 5-10 m jump. A move is only
  // believed after this many consecutive readings agree on it.
  let stillCount = 0;
  let movingConfirm = 0;        // consecutive samples that say "moving"
  let parkedConfirm = 0;        // consecutive samples that say "parked"
  let pending = { lat: null, lng: null };
  let pendingD = 0;             // distance of that pending point from the anchor
  let lastAcceptTs = 0;         // wall clock of the last accepted point
  let lastRaw = { lat: null, lng: null, ts: 0 };   // previous raw fix

  // Rolling window of raw fixes. Whether the receiver is actually parked is
  // decided from how much this cloud spreads, not from the reported speed:
  // a stationary module happily reports 2-4 km/h of "speed noise".
  let recent = [];

  function pushRecent(lat, lng, now) {
    recent.push({ lat, lng, ts: now });
    while (recent.length && now - recent[0].ts > 30000) recent.shift();
    if (recent.length > 120) recent.shift();
  }

  // Displacement over the last ~25 s. A parked receiver wanders inside ~10 m;
  // a person walking covers 30 m+ in that time, which is what separates them.
  function recentDisplacementM(lat, lng) {
    const now = Date.now();
    let ref = null;
    for (const p of recent) {
      if (now - p.ts >= 20000) ref = p; else break;
    }
    if (!ref) return 0;
    return distM(ref.lat, ref.lng, lat, lng);
  }

  function recentSpreadM() {
    const now = Date.now();
    const pts = recent.filter(p => now - p.ts <= 10000);
    if (pts.length < 4) return Infinity;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return distM(minLat, minLng, maxLat, maxLng);
  }

  // marker + accuracy circle + heading wedge
  let marker = null;
  let markerInner = null;

  // A-to-B measuring tool
  let measureMode = false;
  let measureA = null;
  let measureB = null;
  let measureCb = null;
  let gateCurrent = null;   // last lap gate reported by the board

  // modes
  let myLocMode = "recenter";   // recenter | follow | compass | north | free
  let lockNorth = false;

  // Explicit camera lock ("keep the car in the middle"), independent of the
  // mode cycle: it is the switch a spectator leaves on, and a manual pan turns
  // it off so the map never fights the finger.
  let followLock = false;
  let followCb = null;

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
      style: VECTOR_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      bearing: 0,
      interaction: true,
      attributionControl: false,
      // Two cheap wins before anything is drawn: a smaller drawing buffer and a
      // short tile fade. A 300 ms fade repaints every freshly loaded tile for a
      // third of a second, which on a phone is most of the time.
      pixelRatio: Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP),
      fadeDuration: isPhone() ? 100 : 300
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ position: "bottom-left" }), "bottom-left");

    let styleKind = VECTOR_STYLE_URL ? "vector" : "raster";
    let initDone = false;

    // Our sources/layers are wiped by every setStyle(), so they are (re)added on
    // each 'style.load' - first load, raster fallback, everything.
    map.on("style.load", () => {
      try { ensureLayers(); } catch (e) { console.warn("addLayers failed:", e && e.message); }
      try { lightenBasemap(); } catch (e) { /* not fatal */ }
      if (!initDone) {
        initDone = true;
        mapReady = true;
        try { createMarker(); } catch (e) { console.warn("createMarker failed:", e && e.message); }
        try { updateMarker(); } catch (e) { /* ignore */ }
        try { resize(); } catch (e) { /* ignore */ }
      }
    });

    // If the vector style never arrives (blocked host, DNS, offline) the map
    // would stay blank, so drop to the raster provider list after 12 s.
    setTimeout(() => {
      if (initDone || styleKind !== "vector") return;
      console.warn("Vector basemap did not load, falling back to raster");
      styleKind = "raster";
      map.setStyle(buildStyle(TILE_PROVIDERS[tileProviderIndex]));
    }, 12000);

    // ---- raster tile failover --------------------------------------------
    let tileErrors = 0;
    let lastSwap = 0;
    map.on('error', e => {
      if (styleKind !== "raster") return;
      const src = e && e.sourceId;
      if (src && src !== 'base') return;
      tileErrors++;
      const now = Date.now();
      if (tileErrors >= 6 && now - lastSwap > 5000 && tileProviderIndex < TILE_PROVIDERS.length - 1) {
        tileProviderIndex++;
        lastSwap = now;
        tileErrors = 0;
        const p = TILE_PROVIDERS[tileProviderIndex];
        console.warn('Map tiles: switching to ' + p.label);
        try {
          const source = map.getSource('base');
          if (source && source.setTiles) source.setTiles(p.tiles);
          else map.setStyle(buildStyle(p));
        } catch (err) {
          map.setStyle(buildStyle(p));
        }
      }
    });

    // Any user gesture drops out of follow mode; the recenter button (or C)
    // puts it back. Without this the camera fights the user while panning.
    // A plain click counts too: a press on the map is the operator taking the
    // camera, and leaving the lock on meant the next fix pulled the view back
    // while they were still deciding where to look.
    map.on("dragstart", userCameraMove);
    map.on("rotatestart", userCameraMove);
    map.on("pitchstart", userCameraMove);
    map.on("zoomstart", e => { if (e.originalEvent) userCameraMove(); });
    map.getContainer().addEventListener("pointerdown", userCameraMove,
      { capture: true, passive: true });
    enableTrackpadRotate();

    // The camera is only ever mid-animation for a moment, but a finger that
    // lands during one is ignored by MapLibre's drag handler. Stopping the ease
    // in the capture phase, before the handler looks, hands the map to the
    // finger instead of making the first swipe do nothing.
    const settle = () => { if (map.isEasing()) map.stop(); };
    const canvasHost = map.getCanvasContainer();
    canvasHost.addEventListener("touchstart", settle, { capture: true, passive: true });
    canvasHost.addEventListener("mousedown", settle, { capture: true, passive: true });

    map.on("click", e => {
      if (!measureMode) return;
      const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      if (!measureA || measureB) { measureA = p; measureB = null; }
      else { measureB = p; }
      renderMeasure();
      notifyMeasure();
    });
  }

  // Switch off the decorative basemap polygons a phone cannot afford. Every
  // symbol layer (street names, place names, POI and building labels) is left
  // alone: names are the map, fills are the wallpaper. Called on style.load, so
  // it also survives the raster fallback, where no such layer ids exist and each
  // call is a harmless no-op.
  let lightApplied = false;
  function lightenBasemap() {
    if (lightApplied || !map || !isPhone()) return;
    const style = map.getStyle();
    if (!style || !Array.isArray(style.layers)) return;
    for (const layer of style.layers) {
      if (!isDecorative(layer)) continue;
      try { map.setLayoutProperty(layer.id, "visibility", "none"); } catch (e) { /* already gone */ }
    }
    lightApplied = true;
  }

  // Idempotent: safe to call after every style load. Re-creates our overlays
  // (a setStyle wipes them) and repopulates the data they held.
  function ensureLayers() {
    if (map.getSource("trail")) return;
    if (!map.getStyle()) return;

    // ---- Stored history (dashed, drawn under the live trail) ----
    // Fed by /history on demand. Keeping it a separate source means a failed
    // fetch or a cleared history can never disturb the live trail.
    map.addSource("history", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "history",
      type: "line",
      source: "history",
      layout: {
        "line-cap": "round",
        "line-join": "round"
      },
      paint: {
        "line-color": "#9fb2cc",
        "line-width": 2,
        "line-opacity": 0.5,
        "line-dasharray": [3, 2]
      }
    });

    // Companion overlay for fixes the GPS itself did not trust (HDOP > 3,
    // roughly worse than 15 m). Same geometry, red and thin, drawn just above
    // the grey line so a shaky stretch is visible without hiding the route.
    map.addSource("historyPoor", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "history-poor",
      type: "line",
      source: "historyPoor",
      layout: {
        "line-cap": "round",
        "line-join": "round"
      },
      paint: {
        "line-color": "#ff3b1f",
        "line-width": 2,
        "line-opacity": 0.75
      }
    });

    // ---- Trail source (geojson) ----
    map.addSource("trail", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });

    // ---- Trail layer (speed-colored, solid) ----
    // Uses line-gradient for a single continuous LineString — far fewer features
    // than one per segment, and GPU-native coloring along the line.
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
        "line-gradient": [
          "interpolate", ["linear"], ["line-progress"],
          0, "#00e676",    // stopped/green
          0.1, "#ffe600",  // slow/yellow
          0.5, "#ff3b1f",  // fast/red
          1, "#ff3b1f"
        ],
        "line-opacity": 0.85
      }
    });

    // ---- Accuracy circle ----
    // Circle layer with geographic radius: expression converts meters to screen px.
    // At zoom 18, 1 meter ≈ 1.5 screen px; scales with zoom via 2^(z-18).
    map.addSource("accuracy", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "accuracy",
      type: "circle",
      source: "accuracy",
      paint: {
        "circle-radius": [
          "interpolate", ["exponential", 2], ["zoom"],
          12, 2,
          18, ["*", ["get", "radius"], 1.5],
          20, ["*", ["get", "radius"], 6]
        ],
        "circle-color": "#2447ff",
        "circle-opacity": 0.15,
        "circle-stroke-color": "#2447ff",
        "circle-stroke-width": 1,
        "circle-stroke-opacity": 0.4
      }
    });

    // ---- Measure (A to B) ----
    map.addSource("measure", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "measure-line",
      type: "line",
      source: "measure",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": "#2447ff",
        "line-width": 3,
        "line-dasharray": [2, 2]
      }
    });
    map.addLayer({
      id: "measure-pts",
      type: "circle",
      source: "measure",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 7,
        "circle-color": "#ffffff",
        "circle-stroke-color": "#000000",
        "circle-stroke-width": 3
      }
    });

    // ---- Virtual finish line (gate A -> B, from the board) ----
    // Reference only: the lap count itself is computed on the ESP32, so the
    // line can never disagree with the timing. It is drawn under the vehicle.
    map.addSource("gate", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "gate-line",
      type: "line",
      source: "gate",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": "#ff3b1f",
        "line-width": 4,
        "line-dasharray": [2, 1]
      }
    });
    map.addLayer({
      id: "gate-pts",
      type: "circle",
      source: "gate",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#ff3b1f",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2
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

    // ---- Playback overlay (history replay) ----
    // Two sources, so the dot and the travelled line can be updated without a
    // geometry filter. Kept separate from the history line: replay must not
    // change what the session itself looks like.
    map.addSource("playbackLine", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "playback-line",
      type: "line",
      source: "playbackLine",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#2447ff",
        "line-width": 3,
        "line-opacity": 0.9
      }
    });
    map.addSource("playbackDot", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "playback-dot",
      type: "circle",
      source: "playbackDot",
      paint: {
        "circle-radius": 6,
        "circle-color": "#ffe600",
        "circle-stroke-color": "#000000",
        "circle-stroke-width": 3
      }
    });

    // A style swap threw the old data away; put the current state back. The
    // redraw caches have to be reset first, or they would suppress the upload
    // that is needed precisely because the sources are now empty.
    accKey = "";
    wedgeKey = "none";
    try { updateTrail(); } catch (e) { /* ignore */ }
    try { updateAccuracy(); } catch (e) { /* ignore */ }
    try { updateHeadingWedge(); } catch (e) { /* ignore */ }
    try { renderMeasure(); } catch (e) { /* ignore */ }
    try { applyGate(); } catch (e) { /* ignore */ }
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

    const now = Date.now();
    if (fix && lng != null && lat != null) {
      if (anchor.lat == null) {
        anchor = { lng, lat };
        lastMoveTs = now;
        pushTrail(lng, lat, speed);
      } else {
        const d = distM(anchor.lat, anchor.lng, lat, lng);
        // Position error scales with HDOP; ~5 m per HDOP unit is the usual rule
        // of thumb for a consumer receiver, so the deadband follows the sky.
        const acc = clamp((hdop && hdop > 0 ? hdop : 3) * 5, 5, 40);

        // Physics gate, applied to EVERY sample before it can influence
        // anything: the jump since the previous fix must be physically possible
        // for the reported speed. A parked receiver's multipath jump of 20-60 m
        // implies hundreds of km/h and is dropped here, so it can neither move
        // the marker nor widen the "parked" window nor add trail distance.
        const dtS = Math.max(0.2, (now - (lastRaw.ts || now - 500)) / 1000);
        const stepDist = (lastRaw.lat != null) ? distM(lastRaw.lat, lastRaw.lng, lat, lng) : d;
        lastRaw = { lat, lng, ts: now };

        // How far could the vehicle have moved since the previous fix? The
        // reported speed is the only trustworthy scale here (the position is
        // what we are trying to filter), so allow 2.5x its distance plus 4 m of
        // slack, and never more than a hard 200 km/h equivalent.
        const vMs = (numOr0(speed)) / 3.6;
        const allowM = Math.min(vMs * dtS * 2.5 + 4, 55 * dtS + 12);
        lastSampleOk = stepDist <= allowM;
        if (lastSampleOk) {
          pushRecent(lat, lng, now);
          // Two independent hints say "parked": the module reports less than
          // 6 km/h (it lies by 2-4 while standing still, but never reports 0
          // while driving) or the position cloud is tight. Multipath drift of
          // ~10 m creeps past any small deadband, so the parked step is 15 m+.
          // A tight cloud (inside the fix accuracy) vetoes any "moving" claim,
          // so a 7 km/h noise spike on a parked receiver changes nothing.
          const tight = recentSpreadM() < Math.max(6, acc);
          const walking = recentDisplacementM(lat, lng) > 20;   // sustained, not wander
          const moving = !tight && (numOr0(speed) >= 6.0 || walking);

          // Hysteresis: a single noisy sample must not flip the state. Two
          // consecutive samples are needed in either direction, so the marker
          // cannot oscillate between "parked" and "moving" at the boundary.
          if (moving) { movingConfirm++; parkedConfirm = 0; }
          else { parkedConfirm++; movingConfirm = 0; }
          if (movingConfirm >= 2) parkedNow = false;
          else if (parkedConfirm >= 2) parkedNow = true;

          const step = moving ? TRAIL_STEP_MOVING : Math.max(TRAIL_STEP_STOPPED, acc * 2.5);

          // A move must be confirmed by consecutive readings that keep going the
          // same way: one sample is noise, two (moving) or three (parked) are a
          // real displacement.
          if (d >= step) {
            if (pending.lat != null && d >= pendingD - 0.5) {
              stillCount++;
            } else {
              pending = { lat, lng };
              pendingD = d;
              stillCount = 1;
            }
            if (stillCount >= (moving ? 2 : 3)) {
              acceptPoint(lng, lat, speed, d, now);
              stillCount = 0;
              pending = { lat: null, lng: null };
              pendingD = 0;
            }
          } else {
            stillCount = 0;
            pending = { lat: null, lng: null };
            pendingD = 0;
          }
        }
      }
    }

    // Stopped for the map means "the position cloud is not moving", not "the
    // receiver reports 0 km/h" - a parked module happily reports 2-4 km/h.
    stopped = parkedNow || ((speed < 0.6) && (now - lastMoveTs > 2500));
    if (!stopped) frozenHeading = fusedHeading;

    updateMarker();
    updateAccuracy();
    updateHeadingWedge();
    followIfNeeded();
  }

  function acceptPoint(lng, lat, speed, d, now) {
    // Returning after a fix outage is a relocation, not travel: start a new
    // segment instead of drawing a straight line across the gap and adding its
    // length to the trip.
    const gap = lastAcceptTs > 0 && (now - lastAcceptTs > 30000);
    if (gap) trailSeg++;
    else trailDistM += d;
    anchor = { lng, lat };
    lastMoveTs = now;
    lastAcceptTs = now;
    pushTrail(lng, lat, speed);
  }

  // Metres between two WGS84 points (haversine).
  function numOr0(v) { return (typeof v === "number" && isFinite(v) && v > 0) ? v : 0; }

  function distM(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Keep the vehicle in view without re-centring on every single reading: only
  // pan when it leaves the middle band of the viewport. With the camera lock on
  // (the target button), the middle is kept explicitly every fix.
  function followIfNeeded() {
    if (!map || !mapReady) return;
    if (parkedNow) return;              // never pan a parked vehicle
    if (vehicle.lat == null) return;
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    const p = map.project([vehicle.lng, vehicle.lat]);
    if (followLock) {
      // Locked still uses a band rather than re-centring on every fix. An
      // easeTo that restarts every second never lets the camera settle, and
      // MapLibre will not begin a drag while the camera is already moving - so
      // a locked map could not be panned to unlock it. A tight band means the
      // camera is idle almost all the time and a finger always wins.
      if (p.x < w * 0.3 || p.x > w * 0.7 || p.y < h * 0.3 || p.y > h * 0.7) {
        map.easeTo({ center: [vehicle.lng, vehicle.lat], duration: 600 });
      }
      return;
    }
    if (myLocMode !== "recenter" && myLocMode !== "follow") return;
    if (p.x < w * 0.2 || p.x > w * 0.8 || p.y < h * 0.2 || p.y > h * 0.8) {
      map.easeTo({ center: [vehicle.lng, vehicle.lat], duration: 400 });
    }
  }

  // The marker is a MapLibre Marker, so MapLibre re-projects it on every pan,
  // zoom and pitch change. A hand-positioned div (the old approach) stayed
  // glued to the last pixel position and slid away from the map as soon as the
  // user moved it, which is what made the position look wrong.
  // Where the vehicle is drawn: the anchor while parked or while the newest
  // fix is a rejected outlier, the live fix otherwise.
  function viewPos() {
    const useAnchor = anchor.lat != null && (stopped || !lastSampleOk);
    return useAnchor ? anchor : { lng: vehicle.lng, lat: vehicle.lat };
  }

  function updateMarker() {
    if (!mapReady || !marker || !markerInner) return;
    const p = viewPos();
    const lat = p.lat, lng = p.lng;
    // Before the first fix there is nowhere to draw. The marker used to stay at
    // the default centre, which on the live site pointed at a real town and
    // looked like the car was parked there. Hide it until a position exists;
    // after a lost fix the last known spot stays, greyed out.
    if (lat == null || lng == null) {
      markerInner.style.display = "none";
      return;
    }
    markerInner.style.display = "";
    marker.setLngLat([lng, lat]);
    // Freeze the rotation while parked: gyro drift would otherwise spin the
    // marker forever on a stationary vehicle.
    marker.setRotation(stopped ? frozenHeading : fusedHeading);
    markerInner.classList.toggle("stopped", stopped);
    markerInner.classList.toggle("nofix", !vehicle.fix);
  }

  // Accuracy as a MapLibre circle layer — no polygon math, GPU-native, tiny.
  // Radius in pixels at zoom 18 scales with zoom so it stays geographic.
  let accKey = "";
  function updateAccuracy() {
    if (!map || !mapReady) return;
    const src = map.getSource("accuracy");
    if (!src) return;
    const hdop = vehicle.hdop || 5;
    const radius = clamp(hdop * 3, 3, 60); // meters
    const pos = viewPos();
    if (pos.lat == null) return;
    const key = pos.lng.toFixed(5) + "," + pos.lat.toFixed(5) + "," + radius.toFixed(0);
    if (key === accKey) return;
    accKey = key;
    // Single point feature; circle-radius expression converts meters to px.
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { radius },
        geometry: { type: "Point", coordinates: [pos.lng, pos.lat] }
      }]
    });
  }

  function createMarker() {
    if (marker) return;
    markerInner = document.createElement('div');
    markerInner.className = 'vehicle-marker';
    // A plain arrow, pointing up at heading 0. The emoji glyph that used to be
    // here rendered differently on every platform and read as a sad face.
    markerInner.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M12 2 20.5 21.5 12 17 3.5 21.5Z" fill="currentColor"/>' +
      '</svg>';
    markerInner.style.display = 'none';   // shown by updateMarker once a fix exists
    marker = new maplibregl.Marker({ element: markerInner, rotationAlignment: 'map' })
      .setLngLat([DEFAULT_CENTER[0], DEFAULT_CENTER[1]])
      .addTo(map);
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

  let wedgeKey = "none";
  function updateHeadingWedge() {
    if (!map || !mapReady) return;
    const src = map.getSource("heading-wedge");
    if (!src) return;
    const conf = clamp(headingConfidence, 0, 1);
    if (conf < 0.05) {
      if (wedgeKey === "") return;
      wedgeKey = "";
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const pos = viewPos();
    if (pos.lat == null) return;
    // Heading is smoothed every frame but only the drawn wedge matters: skip the
    // upload when neither its centre nor its angle moved a visible amount.
    const key = pos.lng.toFixed(5) + "," + pos.lat.toFixed(5) + "," +
      Math.round(fusedHeading) + "," + conf.toFixed(2);
    if (key === wedgeKey) return;
    wedgeKey = key;
    const r = 12 + 8 * conf; // meters
    const d = r / 111320;
    const h = deg2rad(fusedHeading);
    const w = deg2rad(35 * conf); // wedge width ~ confidence
    const cLat = Math.cos(pos.lat * Math.PI / 180);
    const pts = [[pos.lng, pos.lat]];
    const steps = 4;  // was 8 — fewer vertices, still smooth enough at small radius
    for (let i = 0; i <= steps; i++) {
      const a = h - w / 2 + (w * i) / steps;
      pts.push([
        pos.lng + (d * Math.cos(a)) / cLat,
        pos.lat + d * Math.sin(a)
      ]);
    }
    pts.push([pos.lng, pos.lat]);
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [pts] }
      }]
    });
  }

  function pushTrail(lng, lat, kmh, seg) {
    trailCoords.push({ lng, lat, kmh, seg: seg == null ? trailSeg : seg });
    if (trailCoords.length > TRAIL_MAX) decimateTrail();
    scheduleTrailRender();
  }

  // Halve the vertex count, always keeping the newest point. The travelled
  // distance is accumulated separately, so thinning the drawn line never
  // changes the measured total.
  function decimateTrail() {
    const out = [];
    for (let i = 0; i < trailCoords.length; i += 2) out.push(trailCoords[i]);
    const lastPt = trailCoords[trailCoords.length - 1];
    if (out[out.length - 1] !== lastPt) out.push(lastPt);
    trailCoords = out;
  }

  // Coalesce redraws to one per frame: several readings can land between frames
  // and rebuilding the GeoJSON each time is wasted work.
  function scheduleTrailRender() {
    if (trailRaf) return;
    trailRaf = requestAnimationFrame(() => { trailRaf = 0; updateTrail(); });
  }

  function updateTrail() {
    if (!map || !mapReady) return;
    const src = map.getSource("trail");
    if (!src) return;
    if (trailCoords.length < 2) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    // Single LineString — line-gradient handles speed coloring via line-progress.
    const coords = [];
    for (let i = 0; i < trailCoords.length; i++) {
      coords.push([trailCoords[i].lng, trailCoords[i].lat]);
    }
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
    trailDistM = 0;
    anchor = { lng: null, lat: null };
    recent = [];
    stillCount = 0;
    pending = { lat: null, lng: null };
    lastMoveTs = 0;
    lastAcceptTs = 0;
    trailSeg = 0;
    lastRaw = { lat: null, lng: null, ts: 0 };
    if (map && mapReady) {
      const src = map.getSource("trail");
      if (src) src.setData({ type: "FeatureCollection", features: [] });
    }
  }

  // ---- measure tool (A -> B) ----------------------------------------------
  function renderMeasure() {
    if (!map || !mapReady) return;
    const src = map.getSource("measure");
    if (!src) return;
    const features = [];
    if (measureA && measureB) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [[measureA.lng, measureA.lat], [measureB.lng, measureB.lat]]
        }
      });
    }
    for (const p of [measureA, measureB]) {
      if (!p) continue;
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [p.lng, p.lat] }
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }

  function measureDistanceM() {
    if (!measureA || !measureB) return null;
    return distM(measureA.lat, measureA.lng, measureB.lat, measureB.lng);
  }

  function notifyMeasure() {
    if (measureCb) measureCb({ a: measureA, b: measureB, distM: measureDistanceM() });
  }

  function setMeasureMode(on) {
    measureMode = !!on;
    if (map) map.getCanvas().style.cursor = measureMode ? "crosshair" : "";
  }

  function clearMeasure() {
    measureA = null;
    measureB = null;
    renderMeasure();
    notifyMeasure();
  }

  function onMeasure(cb) { measureCb = cb; }

  // ---- virtual finish line -------------------------------------------------
  // The board owns the gate and the lap count; the page only mirrors it so the
  // operator can see where the line is. Called on every frame; the upload is
  // skipped unless the gate actually changed.
  let gateLast = "none";
  function gateGeoJSON(g) {
    const okNum = v => typeof v === "number" && isFinite(v);
    if (!g || !g.on || !Array.isArray(g.la) || !Array.isArray(g.lb) ||
        !okNum(g.la[0]) || !okNum(g.la[1]) || !okNum(g.lb[0]) || !okNum(g.lb[1])) {
      return { type: "FeatureCollection", features: [] };
    }
    // The payload stores [lat, lng]; GeoJSON wants [lng, lat].
    const a = [g.la[1], g.la[0]];
    const b = [g.lb[1], g.lb[0]];
    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {},
          geometry: { type: "LineString", coordinates: [a, b] } },
        { type: "Feature", properties: {},
          geometry: { type: "Point", coordinates: a } },
        { type: "Feature", properties: {},
          geometry: { type: "Point", coordinates: b } }
      ]
    };
  }

  function applyGate() {
    if (!map || !mapReady) return;
    const src = map.getSource("gate");
    if (!src) return;
    src.setData(gateGeoJSON(gateCurrent));
  }

  function setGate(g) {
    gateCurrent = g;
    // Before the style has loaded there is no source to draw into. Remember the
    // gate only and let ensureLayers() paint it; do NOT consume the change here,
    // or a gate that arrived during load would never be drawn.
    if (!map || !mapReady) return;
    const key = gateGeoJSON(g);
    const sig = JSON.stringify(key.features);
    if (sig === gateLast) return;
    gateLast = sig;
    applyGate();
  }

  // ---- camera / controls --------------------------------------------------
  function flyTo(lng, lat, zoom, bearing, pitch, duration = 600) {
    if (!map || !mapReady) return;
    map.easeTo({ center: [lng, lat], zoom, bearing, pitch, duration });
  }

  function recenterNow() {
    if (!map || !mapReady) return;
    if (vehicle.lat != null && vehicle.lng != null) {
      myLocMode = "recenter";
      flyTo(vehicle.lng, vehicle.lat, 15, lockNorth ? 0 : fusedHeading, 0);
    }
  }

  function resetNorth() {
    lockNorth = false;
    myLocMode = "compass";
    if (map && mapReady) map.easeTo({ bearing: 0, duration: 400 });
  }

  function toggleLockNorth() {
    lockNorth = !lockNorth;
    if (lockNorth) {
      myLocMode = "north";
      if (map && mapReady) map.easeTo({ bearing: 0, duration: 400 });
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

  // ---- camera lock ---------------------------------------------------------
  // "Keep the car in the middle" as a switch, not a cycling mode: the button on
  // the map stays lit while it is on, and a pan/zoom turns it off. The dashboard
  // saves the choice per browser, so it survives a reload during a race day.
  function releaseFollow() {
    if (!followLock) return;
    followLock = false;
    if (followCb) followCb(false);
  }

  // Every intentional camera action goes through here first: a pan, a zoom, a
  // rotate, a pitch. It drops the follow lock AND the auto-recenter mode, so the
  // next fix cannot pull the view back out from under the user. A plain click
  // counts, not just a drag.
  function userCameraMove() {
    myLocMode = "free";
    releaseFollow();
  }

  // A trackpad has no rotate gesture: two-finger scrolling arrives as a wheel
  // event and MapLibre uses only the vertical part, for zoom. The horizontal
  // part (and Shift+scroll, which browsers deliver as horizontal) was unused,
  // so a horizontal two-finger swipe now turns the map. That is the 360 that a
  // mouse gets from ctrl+drag or a right-drag, without adding map buttons.
  function enableTrackpadRotate() {
    if (!map) return;
    // Capture on the outer container so this runs before MapLibre's zoom
    // handler on the canvas container, and stop it there: a horizontal swipe
    // must turn the map, not nudge the zoom.
    map.getContainer().addEventListener("wheel", ev => {
      if (ev.ctrlKey) return;                        // pinch -> MapLibre zoom
      const dx = ev.deltaX || 0, dy = ev.deltaY || 0;
      if (!dx || Math.abs(dx) <= Math.abs(dy) * 1.2) return;  // vertical -> zoom
      ev.preventDefault();
      ev.stopPropagation();
      userCameraMove();
      map.setBearing(map.getBearing() + dx * 0.3);
    }, { capture: true, passive: false });
  }

  function setFollow(on) {
    followLock = !!on;
    if (followLock) {
      myLocMode = "follow";
      if (map && mapReady && vehicle.lat != null) {
        map.easeTo({
          center: [vehicle.lng, vehicle.lat],
          zoom: Math.max(map.getZoom(), 15),
          duration: 500
        });
      }
    }
    if (followCb) followCb(followLock);
    return followLock;
  }

  function onFollow(cb) { followCb = cb; }

  // The URL bar collapsing on a phone fires a resize on almost every scroll
  // pixel, and map.resize() reallocates the canvas and repaints every tile. A
  // sub-2 px wobble is not worth that: ignore it, and let the dashboard debounce
  // the rest.
  let lastSize = { w: 0, h: 0 };
  function resize() {
    if (!map || !mapReady || !container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (Math.abs(w - lastSize.w) < 2 && Math.abs(h - lastSize.h) < 2) return;
    lastSize = { w, h };
    map.resize();
  }

  function setLockNorth(on) {
    lockNorth = !!on;
    if (lockNorth) {
      myLocMode = "north";
      if (map && mapReady) map.easeTo({ bearing: 0, duration: 400 });
    }
  }

  // ---- stored history overlay ----------------------------------------------
  // points: [[ts, lat, lng, kmh, cog, hdop], ...] exactly as /history returns.
  // Breaks the line on a long time gap or an implausible jump, so an outage or
  // a teleport-looking artifact is not drawn as a straight line across the map.
  function setHistory(points) {
    if (!map || !mapReady) return 0;
    const src = map.getSource("history");
    const poor = map.getSource("historyPoor");
    if (!src) return 0;

    const feats = [];
    const bad = [];
    let run = [];
    let poorRun = [];
    let prev = null;
    let prevPoor = false;
    let prevCoord = null;

    const flush = () => {
      if (run.length > 1) feats.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: run }
      });
      run = [];
    };
    // The overlay is a set of short red runs, not the whole trail: only pairs
    // that touch a fix with HDOP > 3 are flagged, so a good line stays grey.
    const flushPoor = () => {
      if (poorRun.length > 1) bad.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: poorRun }
      });
      poorRun = [];
    };

    for (const p of points) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const ts = Number(p[0]), lat = Number(p[1]), lng = Number(p[2]);
      if (!isFinite(ts) || !isFinite(lat) || !isFinite(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      const hdop = Number(p[5]);
      const isPoor = isFinite(hdop) && hdop > 3;

      if (prev && (ts - prev[0] > 600 ||
                   Math.abs(lat - prev[1]) > 0.02 ||
                   Math.abs(lng - prev[2]) > 0.02)) {
        flush();
        flushPoor();
        prev = null;
        prevPoor = false;
        prevCoord = null;
      }
      run.push([lng, lat]);
      if (prev) {
        if (prevPoor || isPoor) {
          if (!poorRun.length) poorRun.push(prevCoord);
          poorRun.push([lng, lat]);
        } else {
          flushPoor();
        }
      }
      prev = [ts, lat, lng];
      prevPoor = isPoor;
      prevCoord = [lng, lat];
    }
    flush();
    flushPoor();
    src.setData({ type: "FeatureCollection", features: feats });
    if (poor) poor.setData({ type: "FeatureCollection", features: bad });
    return feats.length;
  }

  function clearHistory() {
    if (!map || !mapReady) return;
    const src = map.getSource("history");
    if (src) src.setData({ type: "FeatureCollection", features: [] });
    const poor = map.getSource("historyPoor");
    if (poor) poor.setData({ type: "FeatureCollection", features: [] });
  }

  // ---- playback ------------------------------------------------------------
  // coords is the travelled part of the session, newest last, already as
  // [lng, lat] pairs so replay does not rebuild them on every tick.
  function setPlayback(lat, lng, coords) {
    if (!map || !mapReady) return;
    const line = map.getSource("playbackLine");
    const dot = map.getSource("playbackDot");
    if (line) {
      const usable = Array.isArray(coords) && coords.length > 1;
      line.setData({
        type: "FeatureCollection",
        features: usable ? [{
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: coords }
        }] : []
      });
    }
    if (dot) {
      const ok = isFinite(lat) && isFinite(lng);
      dot.setData({
        type: "FeatureCollection",
        features: ok ? [{
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [lng, lat] }
        }] : []
      });
    }
  }

  function clearPlayback() {
    if (!map || !mapReady) return;
    for (const id of ["playbackLine", "playbackDot"]) {
      const src = map.getSource(id);
      if (src) src.setData({ type: "FeatureCollection", features: [] });
    }
  }

  // Frames the selected session. Without this, picking a 400 m stint out of a
  // 24 h window leaves the camera where it was and the line is a dash in the
  // corner, which reads as "nothing happened".
  function fitPoints(points, opts) {
    if (!map || !mapReady || !Array.isArray(points) || !points.length) return false;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, n = 0;
    for (const p of points) {
      const lat = Number(p && p[1]), lng = Number(p && p[2]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      n++;
    }
    if (n === 0) return false;

    const pad = (opts && opts.padding) || 60;
    const maxZoom = (opts && opts.maxZoom) || 17;
    if (n === 1) {
      map.easeTo({ center: [maxLng, maxLat], zoom: 16, duration: 600 });
      return true;
    }
    // A single point (parked, or a 1-fix session) has no extent: fitBounds on
    // identical corners zooms to the max, so that case is handled above.
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]],
      { padding: pad, maxZoom, duration: 700 });
    return true;
  }

  // ---- public API ---------------------------------------------------------
  return {
    create,
    loaded: () => new Promise(res => {
      if (!map || mapReady) return res();
      map.once("load", res);
      map.once("idle", res);
      setTimeout(res, 8000);   // never leave the caller hanging
    }),
    isReady: () => mapReady,
    getMap: () => map,          // debugging/verification hook
    resize,
    setVehicle,
    clearTrail,
    setHistory,
    clearHistory,
    setPlayback,
    clearPlayback,
    fitPoints,
    getTrailDistance: () => trailDistM,
    getTrailPoints: () => trailCoords.length,
    isStopped: () => stopped,
    isParked: () => parkedNow,
    setMeasureMode,
    clearMeasure,
    setGate,
    onMeasure,
    recenterNow,
    resetNorth,
    setLockNorth,
    flyTo,
    setFollow,
    isFollowing: () => followLock,
    onFollow,
    getHeading,
    setHeadingSource,
    getTileProvider: () => TILE_PROVIDERS[tileProviderIndex]
  };
})();
