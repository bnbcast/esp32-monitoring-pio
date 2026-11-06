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

  // trail (speed-colored polyline)
  let trailCoords = [];

  // marker + accuracy circle + heading wedge
  let markerEl = null;

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

    // Auto-follow modes
    if (myLocMode === "north" || lockNorth) {
      flyTo(lng, lat, 15, 0, 0);
    }
  }

  function updateMarker() {
    if (!map || !mapReady) return;
    const el = markerEl;
    if (!el || !vehicle.lat || !vehicle.lng) return;
    const conf = headingConfidence;
    const size = 28 + 16 * conf;
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.fontSize = (size * 0.75) + "px";
    el.style.border = "3px solid #000";
    el.style.background = "rgba(255,255,255,0.95)";
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
    if (markerEl) return;
    markerEl = document.createElement('div');
    markerEl.className = 'vehicle-marker';
    markerEl.style.position = 'absolute';
    markerEl.style.width = '32px';
    markerEl.style.height = '32px';
    markerEl.style.fontSize = '24px';
    markerEl.style.lineHeight = '1';
    markerEl.style.textAlign = 'center';
    markerEl.style.border = '3px solid #000';
    markerEl.style.background = 'rgba(255,255,255,0.95)';
    markerEl.style.boxShadow = '6px 6px 0 #000';
    markerEl.style.borderRadius = '0';
    markerEl.style.transformOrigin = 'center';
    markerEl.style.pointerEvents = 'none';
    markerEl.style.zIndex = '100';
    markerEl.textContent = '🥺';
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

  function updateTrail() {
    if (!map || !mapReady) return;
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
    if (map && mapReady) {
      const src = map.getSource("trail");
      if (src) src.setData({ type: "FeatureCollection", features: [] });
    }
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
    recenterNow,
    resetNorth,
    setLockNorth,
    flyTo,
    getHeading,
    setHeadingSource,
    getTileProvider: () => TILE_PROVIDERS[tileProviderIndex]
  };
})();
