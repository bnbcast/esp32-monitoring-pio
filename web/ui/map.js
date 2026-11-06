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
  const TRAIL_MAX = 1200;          // drawn vertices before decimation
  const TRAIL_STEP_MOVING = 3.0;   // metres between accepted points
  const TRAIL_STEP_STOPPED = 10.0; // deadband while parked (grows with HDOP)
  let trailRaf = 0;

  // Parked-receiver noise often arrives as a single 5-10 m jump. A move is only
  // believed after this many consecutive readings agree on it.
  let stillCount = 0;
  let pending = { lat: null, lng: null };
  let pendingD = 0;             // distance of that pending point from the anchor
  let lastRaw = { lat: null, lng: null, ts: 0 };   // previous raw fix

  // Rolling window of raw fixes. Whether the receiver is actually parked is
  // decided from how much this cloud spreads, not from the reported speed:
  // a stationary module happily reports 2-4 km/h of "speed noise".
  let recent = [];

  function pushRecent(lat, lng, now) {
    recent.push({ lat, lng, ts: now });
    while (recent.length && now - recent[0].ts > 10000) recent.shift();
    if (recent.length > 40) recent.shift();
  }

  function recentSpreadM() {
    if (recent.length < 4) return Infinity;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of recent) {
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
      style: VECTOR_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      bearing: 0,
      interaction: true,
      attributionControl: false
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

  // Idempotent: safe to call after every style load. Re-creates our overlays
  // (a setStyle wipes them) and repopulates the data they held.
  function ensureLayers() {
    if (map.getSource("trail")) return;
    if (!map.getStyle()) return;

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

    // A style swap threw the old data away; put the current state back.
    try { updateTrail(); } catch (e) { /* ignore */ }
    try { renderMeasure(); } catch (e) { /* ignore */ }
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
        const impliedKmh = (stepDist / dtS) * 3.6;
        const speedCap = parkedNow
          ? Math.max(20, speed * 2.5 + 10)
          : Math.max(90, speed * 3 + 40);
        lastRaw = { lat, lng, ts: now };

        lastSampleOk = impliedKmh <= speedCap;
        if (lastSampleOk) {
          pushRecent(lat, lng, now);
          const parked = recentSpreadM() < Math.max(6, acc);
          parkedNow = parked;
          const moving = !parked;
          const step = moving ? TRAIL_STEP_MOVING : Math.max(TRAIL_STEP_STOPPED, acc * 2);

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
    trailDistM += d;
    anchor = { lng, lat };
    lastMoveTs = now;
    pushTrail(lng, lat, speed);
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
    if (parkedNow) return;              // never pan a parked vehicle
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
    const pos = viewPos();
    if (pos.lat == null) return;
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Point",
          coordinates: [pos.lng, pos.lat]
        }
      }]
    });
    // MapLibre doesn't buffer natively; draw a circle via many points
    const circle = circleCoords(pos.lng, pos.lat, radius, 32);
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
    const pos = viewPos();
    if (pos.lat == null) return;
    const r = 12 + 8 * conf; // meters
    const d = r / 111320;
    const h = deg2rad(fusedHeading);
    const w = deg2rad(35 * conf); // wedge width ~ confidence
    const cLat = Math.cos(pos.lat * Math.PI / 180);
    const pts = [[pos.lng, pos.lat]];
    const steps = 8;
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
    anchor = { lng: null, lat: null };
    recent = [];
    stillCount = 0;
    pending = { lat: null, lng: null };
    lastMoveTs = 0;
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
    getTrailDistance: () => trailDistM,
    getTrailPoints: () => trailCoords.length,
    isStopped: () => stopped,
    isParked: () => parkedNow,
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
