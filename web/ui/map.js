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
  let frozenHeading = 0;

  // trail (speed-colored polyline) + its measured length
  let trailCoords = [];
  let trailDistM = 0;
  const TRAIL_MAX = 1200;          // drawn vertices before decimation
  const TRAIL_STEP_MOVING = 2.5;   // metres between accepted points
  const TRAIL_STEP_STOPPED = 5.0;  // larger deadband while parked
  let trailRaf = 0;

  // marker + accuracy circle + heading wedge
  let marker = null;
  let markerInner = null;

  // A-to-B measuring tool
  let measureMode = false;
  let measureA = null;
  let measureB = null;
  let measureCb = null;

  // modes
  let myLocMode = "recenter";   // recenter | compass | north
  let lockNorth = false;

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
      style: MAP_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      bearing: 0,
      interaction: true,
      attributionControl: true
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ position: "bottom-left" }), "bottom-left");

    // Readiness must not depend on the 'load' event alone: it only fires once
    // the first frame is fully painted with every initial tile, and a single
    // slow/blocked tile keeps it from firing forever (the map then looks fine
    // but the vehicle, trail and heading HUD never initialise). Initialise on
    // whichever comes first: load, idle, styledata, or a short poll.
    let initDone = false;
    function styleParsed() {
      // isStyleLoaded() stays false while any initial tile is outstanding (one
      // slow tile is enough), so test for our own layer instead: it only exists
      // once the style has been parsed and is safe to add layers to.
      try { return !!map.getLayer('base-layer'); } catch (e) { return false; }
    }

    function tryInitMap(force) {
      if (initDone || !map) return;
      if (!force && !styleParsed()) return;
      initDone = true;
      mapReady = true;
      try { initLayers(); } catch (e) { console.warn('initLayers failed:', e && e.message); }
      try { createMarker(); } catch (e) { console.warn('createMarker failed:', e && e.message); }
      try { resize(); } catch (e) { /* ignore */ }
    }

    map.on("load", () => tryInitMap(false));
    map.on("idle", () => tryInitMap(false));
    map.on("styledata", () => tryInitMap(false));
    const readyPoll = setInterval(() => {
      tryInitMap(false);
      if (initDone || !map) clearInterval(readyPoll);
    }, 400);
    // Hard safety net: after 6 s initialise regardless, so a starved tile server
    // can never leave the dashboard without a vehicle marker.
    setTimeout(() => tryInitMap(true), 6000);
    // ---- tile failover ----------------------------------------------------
    // A provider can fail two ways: hard errors (blocked / offline), or the
    // silent 200-with-blank-tile trick OSM plays on foreign Referers. Hard
    // errors are counted here and we hop to the next provider.
    let tileErrors = 0;
    let lastSwap = 0;
    map.on('error', e => {
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
    map.on("dragstart", () => { myLocMode = "free"; });
    map.on("zoomstart", e => {
      if (e.originalEvent) myLocMode = "free";
    });

    map.on("click", e => {
      if (!measureMode) return;
      const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      if (!measureA || measureB) { measureA = p; measureB = null; }
      else { measureB = p; }
      renderMeasure();
      notifyMeasure();
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

    const now = Date.now();
    if (fix && lng != null && lat != null) {
      if (anchor.lat == null) {
        anchor = { lng, lat };
        lastMoveTs = now;
        pushTrail(lng, lat, speed);
      } else {
        const d = distM(anchor.lat, anchor.lng, lat, lng);
        // A parked receiver wanders a few metres. While the reported speed says
        // "stopped", only a move that clears the deadband is accepted; that
        // keeps the marker and the trail perfectly still on the map.
        const step = speed >= 1.0 ? TRAIL_STEP_MOVING : TRAIL_STEP_STOPPED;
        if (d >= step) {
          trailDistM += d;
          anchor = { lng, lat };
          lastMoveTs = now;
          pushTrail(lng, lat, speed);
        }
      }
    }

    const wasStopped = stopped;
    stopped = (speed < 0.6) && (now - lastMoveTs > 2500);
    if (!stopped || !wasStopped) {
      if (!stopped) frozenHeading = fusedHeading;
    }

    updateMarker();
    updateAccuracy();
    updateHeadingWedge();
    followIfNeeded();
  }

  // Metres between two WGS84 points (haversine).
  function distM(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Keep the vehicle in view without re-centring on every single reading: only
  // pan when it leaves the middle band of the viewport.
  function followIfNeeded() {
    if (!map || !mapReady) return;
    if (myLocMode !== "recenter" && myLocMode !== "follow") return;
    if (vehicle.lat == null) return;
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    const p = map.project([vehicle.lng, vehicle.lat]);
    if (p.x < w * 0.2 || p.x > w * 0.8 || p.y < h * 0.2 || p.y > h * 0.8) {
      map.easeTo({ center: [vehicle.lng, vehicle.lat], duration: 400 });
    }
  }

  // The marker is a MapLibre Marker, so MapLibre re-projects it on every pan,
  // zoom and pitch change. A hand-positioned div (the old approach) stayed
  // glued to the last pixel position and slid away from the map as soon as the
  // user moved it, which is what made the position look wrong.
  function updateMarker() {
    if (!mapReady || !marker || !markerInner) return;
    const lat = (stopped && anchor.lat != null) ? anchor.lat : vehicle.lat;
    const lng = (stopped && anchor.lng != null) ? anchor.lng : vehicle.lng;
    if (lat == null || lng == null) return;
    marker.setLngLat([lng, lat]);
    // Freeze the rotation while parked: gyro drift would otherwise spin the
    // marker forever on a stationary vehicle.
    marker.setRotation(stopped ? frozenHeading : fusedHeading);
    markerInner.classList.toggle("stopped", stopped);
    markerInner.classList.toggle("nofix", !vehicle.fix);
  }

  function updateAccuracy() {
    if (!map || !mapReady) return;
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
    if (marker) return;
    markerInner = document.createElement('div');
    markerInner.className = 'vehicle-marker';
    markerInner.textContent = '\uD83E\uDD7A';
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

  function updateHeadingWedge() {
    if (!map || !mapReady) return;
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

  function pushTrail(lng, lat, kmh) {
    trailCoords.push({ lng, lat, kmh });
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
    // One feature per segment so line-color can read that segment's speed.
    const features = [];
    for (let i = 1; i < trailCoords.length; i++) {
      const a = trailCoords[i - 1], b = trailCoords[i];
      features.push({
        type: "Feature",
        properties: { kmh: b.kmh || 0 },
        geometry: {
          type: "LineString",
          coordinates: [[a.lng, a.lat], [b.lng, b.lat]]
        }
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }

  function clearTrail() {
    trailCoords = [];
    trailDistM = 0;
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

  function resize() {
    if (!map || !mapReady || !container) return;
    map.resize();
  }

  function setLockNorth(on) {
    lockNorth = !!on;
    if (lockNorth) {
      myLocMode = "north";
      if (map && mapReady) map.easeTo({ bearing: 0, duration: 400 });
    }
  }

  // ---- public API ---------------------------------------------------------
  return {
    create,
    loaded: () => new Promise(res => { if (map) { map.once("load", res); } else res(); }),
    isReady: () => mapReady,
    getMap: () => map,          // debugging/verification hook
    resize,
    setVehicle,
    clearTrail,
    getTrailDistance: () => trailDistM,
    getTrailPoints: () => trailCoords.length,
    isStopped: () => stopped,
    setMeasureMode,
    clearMeasure,
    onMeasure,
    recenterNow,
    resetNorth,
    setLockNorth,
    flyTo,
    getHeading,
    setHeadingSource,
    getTileProvider: () => TILE_PROVIDERS[tileProviderIndex]
  };
})();
