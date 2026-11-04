"use strict";

// ---------------------------------------------------------------------------
// web/map.js — MapLibre GL JS base map (Stage 1)
// Free, key-less stack: OpenFreeMap vector tiles + AWS Terrain Tiles (Terrarium).
// No Google Maps, no paid providers, no API keys.
// ---------------------------------------------------------------------------
const MAP = (() => {
  // ---- free, key-less styles (OpenFreeMap) ---------------------------------
  const STYLES = {
    liberty: 'https://tiles.openfreemap.org/styles/liberty',
    bright: 'https://tiles.openfreemap.org/styles/bright',
    positron: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  };
  const DEFAULT_STYLE = 'liberty';

  // ---- AWS Terrain Tiles (Terrarium PNG, raster-dem) -----------------------
  // Canonical MapLibre / AWS Terrain Tiles values:
  //   url:  https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
  //   Terrarium encoding: elevation = -32768 + (R * 256 + G + B / 256)
  const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TERRAIN_SOURCE = 'aws-terrain';
  const TERRAIN_EXAGGERATION = 1.5;

  let map = null;
  let container = null;
  let mapDiv = null;
  let initialized = false;
  let loadResolve = null;
  const loadPromise = new Promise((res) => { loadResolve = res; });

  let styleKey = DEFAULT_STYLE;
  let terrainOn = false;
  let is3D = true;        // pitched 3D vs flat 2D
  let followMode = 'free'; // follow | north | free
  let userPanning = false;

  // ---- lifecycle -----------------------------------------------------------
  function _ensureMapDiv(containerId) {
    container = document.getElementById(containerId);
    if (!container) return null;
    // Reuse the container itself as the MapLibre host (it fills the panel).
    mapDiv = container;
    mapDiv.classList.add('map-host');
    return mapDiv;
  }

  function create(containerId) {
    if (map || typeof maplibregl === 'undefined') return !!map;
    _ensureMapDiv(containerId);
    if (!mapDiv) return false;

    map = new maplibregl.Map({
      container: mapDiv,
      style: STYLES[styleKey],
      center: [0, 0],
      zoom: 1,
      pitch: is3D ? 45 : 0,
      bearing: 0,
      antialias: true,
      preserveDrawingBuffer: false,
    });

    // Standard controls (zoom + compass, scale)
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ position: 'bottom-right', maxWidth: 200 }));
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      initialized = true;
      loadResolve(map);
      if (terrainOn) enableTerrain();
    });

    // Smooth glide: interpolate the rendered marker toward the last fix each frame.
    map.on('render', () => {
      if (!vehicle.target || !vehicle.current || !vehicle.marker) return;
      const dx = vehicle.target.lng - vehicle.current.lng;
      const dy = vehicle.target.lat - vehicle.current.lat;
      if (Math.hypot(dx, dy) > 0.00002) {
        const k = 0.18;
        vehicle.current.lng += dx * k;
        vehicle.current.lat += dy * k;
        vehicle.marker.setLngLat([vehicle.current.lng, vehicle.current.lat]);
        if (map.getSource('vehicle-acc')) {
          const r = vehicle.hdop != null ? Math.max(6, Math.min(70, 8 + vehicle.hdop * 16)) : 10;
          map.getSource('vehicle-acc').setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: { r },
              geometry: { type: 'Point', coordinates: [vehicle.current.lng, vehicle.current.lat] } }],
          });
        }
      }
    });

    // Detect user panning -> switch to Free follow mode
    map.on('mousedown', () => { userPanning = true; setFollowMode('free'); });
    map.on('dragstart', () => { userPanning = true; setFollowMode('free'); });

    return true;
  }

  function loaded() {
    return loadPromise;
  }

  function resize() {
    if (map) map.resize();
  }

  function show() {
    if (mapDiv) {
      mapDiv.style.display = '';
      if (map) map.resize();
    }
  }

  function hide() {
    if (mapDiv) mapDiv.style.display = 'none';
  }

  // ---- style switching ------------------------------------------------------
  function setStyle(key) {
    if (!STYLES[key]) return;
    styleKey = key;
    if (map) map.setStyle(STYLES[key]);
  }

  function getStyle() { return styleKey; }

  // ---- 2D / 3D toggle -------------------------------------------------------
  function set3D(enabled) {
    is3D = !!enabled;
    if (map && initialized) map.easeTo({ pitch: is3D ? 45 : 0, duration: 700 });
  }
  function is3DMode() { return is3D; }

  // ---- terrain --------------------------------------------------------------
  function enableTerrain() {
    terrainOn = true;
    if (!map || !initialized) return;
    if (map.getSource(TERRAIN_SOURCE)) {
      map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
      return;
    }
    map.addSource(TERRAIN_SOURCE, {
      type: 'raster-dem',
      url: TERRAIN_URL,
      tileSize: 256,
      maxzoom: 14,
    });
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
  }

  function disableTerrain() {
    terrainOn = false;
    if (map) map.setTerrain({ source: null });
  }
  function isTerrainOn() { return terrainOn; }

  // ---- follow mode ----------------------------------------------------------
  function setFollowMode(mode) {
    if (!['follow', 'north', 'free'].includes(mode)) return;
    followMode = mode;
    userPanning = (mode === 'free');
    return followMode;
  }
  function getFollowMode() { return followMode; }
  function isUserPanning() { return userPanning; }

  function recenter() {
    if (!vehicle.target || !map || !initialized) return;
    map.easeTo({
      center: [vehicle.target.lng, vehicle.target.lat],
      bearing: followMode === 'follow' ? vehicle.heading : 0,
      pitch: is3D ? 45 : 0,
      duration: 700, easing: (t) => t * (2 - t),
    });
    userPanning = false;
    if (followMode === 'free') setFollowMode('follow');
  }

  // ---- local distance (meters) ---------------------------------------------
  function distM(lat1, lg1, lat2, lg2) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lg2 - lg1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---- live vehicle / accuracy circle / speed-colored trail ----------------
  let vehicle = {
    el: null, marker: null,
    current: null, target: null,
    heading: 0, lastHeading: 0,
    speed: 0, hdop: null, fix: false,
    trail: [], maxTrail: 400,
    layersReady: false,
  };

  function _vehicleEl() {
    if (vehicle.el) return vehicle.el;
    const el = document.createElement('div');
    el.className = 'vehicle-marker';
    el.style.width = '20px'; el.style.height = '20px';
    el.style.position = 'relative';
    const head = document.createElement('div');
    head.className = 'vehicle-head';
    el.appendChild(head);
    vehicle.el = el;
    return el;
  }

  function _initVehicleLayers() {
    if (vehicle.layersReady || !map || !initialized) return;
    // accuracy circle (sized from HDOP)
    map.addSource('vehicle-acc', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'vehicle-acc-layer',
      type: 'circle',
      source: 'vehicle-acc',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'r'], 0, 6, 1, 12, 2, 22, 4, 38, 6, 56],
        'circle-color': '#06b6d4',
        'circle-opacity': 0.22,
        'circle-stroke-color': '#06b6d4',
        'circle-stroke-width': 1,
      },
    });
    // speed-colored trail
    map.addSource('vehicle-trail', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'vehicle-trail-layer',
      type: 'line',
      source: 'vehicle-trail',
      paint: {
        'line-width': 3,
        'line-cap': 'round', 'line-join': 'round',
        'line-color': [
          'interpolate', ['linear'], ['get', 's'],
          0, '#06b6d4', 40, '#2447ff', 80, '#ffe600', 120, '#dc2626'],
        'line-opacity': 0.8,
      },
    });
    vehicle.layersReady = true;
  }

  function _updateTrail() {
    if (!map || !initialized || !vehicle.layersReady) return;
    const feats = [];
    for (let i = 1; i < vehicle.trail.length; i++) {
      const a = vehicle.trail[i - 1], b = vehicle.trail[i];
      feats.push({
        type: 'Feature',
        properties: { s: (a.speed + b.speed) / 2 },
        geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
      });
    }
    map.getSource('vehicle-trail').setData({ type: 'FeatureCollection', features: feats });
  }

  function clearTrail() {
    vehicle.trail = [];
    if (map && initialized && vehicle.layersReady) {
      map.getSource('vehicle-trail').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  /**
   * Feed a live GPS fix into the map. Called from app.js on every valid GPS message.
   * Never extrapolates past the last fix; marker glides toward it each frame.
   */
  function setVehicle(lng, lat, heading, speed, hdop, fix, ts) {
    if (!map || !initialized) return;
    _initVehicleLayers();

    const el = _vehicleEl();
    if (!vehicle.marker) {
      vehicle.marker = new maplibregl.Marker(el, { anchor: 'center' })
        .setLngLat([lng, lat]).addTo(map);
    }
    vehicle.current = vehicle.current || { lng, lat };
    vehicle.target = { lng, lat };
    vehicle.speed = typeof speed === 'number' ? speed : 0;
    vehicle.hdop = typeof hdop === 'number' ? hdop : null;
    vehicle.fix = !!fix;

    // Heading: trust GPS course when moving, otherwise hold last known heading.
    if (typeof heading === 'number' && vehicle.speed > 1) vehicle.lastHeading = heading;
    vehicle.heading = vehicle.lastHeading;
    if (vehicle.marker) {
      vehicle.marker.setRotation(vehicle.heading);
      const el = vehicle.marker.getElement();
      el.style.opacity = vehicle.fix ? '1' : '0.5';
      el.style.filter = vehicle.fix ? 'none' : 'grayscale(1)';
    }

    // Accuracy circle sized from HDOP (pixels).
    const r = vehicle.hdop != null ? Math.max(6, Math.min(70, 8 + vehicle.hdop * 16)) : 10;
    if (map.getSource('vehicle-acc')) {
      map.getSource('vehicle-acc').setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { r },
          geometry: { type: 'Point', coordinates: [lng, lat] } }],
      });
    }

    // Trail: append segment only when the fix moves > 2 m (keeps it fast).
    if (vehicle.fix) {
      const last = vehicle.trail[vehicle.trail.length - 1];
      if (!last || distM(lat, lng, last.lat, last.lng) > 2) {
        vehicle.trail.push({ lng, lat, speed: vehicle.speed });
        if (vehicle.trail.length > vehicle.maxTrail) vehicle.trail.shift();
        _updateTrail();
      }
    }

    // Follow-mode camera: centre on the vehicle.
    if (followMode === 'follow') {
      map.easeTo({ center: [lng, lat], bearing: vehicle.heading, pitch: is3D ? 45 : 0,
        duration: 500, easing: (t) => t * (2 - t) });
    } else if (followMode === 'north') {
      map.easeTo({ center: [lng, lat], bearing: 0, pitch: is3D ? 45 : 0, duration: 500 });
    }
  }

  // ---- camera ---------------------------------------------------------------
  function flyTo(lng, lat, options = {}) {
    if (!map || !initialized) return;
    map.flyTo({
      center: [lng, lat],
      zoom: options.zoom !== undefined ? options.zoom : 16,
      pitch: options.pitch !== undefined ? options.pitch : (is3D ? 45 : 0),
      bearing: options.bearing !== undefined ? options.bearing : 0,
      duration: options.duration || 1000,
      easing: (t) => t * (2 - t), // ease-out quad
    });
  }
  function easeTo(options) {
    if (!map) return;
    map.easeTo(options);
  }

  // ---- API ------------------------------------------------------------------
  return {
    create, loaded, resize, show, hide,
    setStyle, getStyle,
    set3D, is3DMode,
    enableTerrain, disableTerrain, isTerrainOn,
    setFollowMode, getFollowMode, isUserPanning,
    setVehicle, recenter, clearTrail,
    flyTo, easeTo,
    getMap: () => map,
  };
})();
