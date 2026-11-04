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

  // ---- heading fusion config (Stage 1) ------------------------------------
  const HEADING = {
    GPS_SPEED_THRESHOLD: 3,       // km/h — above this, trust GPS course
    GPS_HDOP_MAX: 6,              // above this, GPS heading not trusted
    GYRO_DRIFT_PULL: 0.03,        // per-frame pull back toward last GPS heading
    CONFIDENCE_DECAY_MS: 15000,   // gyro confidence decays after this without GPS
    PHONE_COMPASS_OFFSET: 0,      // degrees, user-calibratable offset for device alpha
  };

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

  // ---- heading fusion state -----------------------------------------------
  let headingState = {
    source: 'HOLD',        // GPS | GYRO | PHONE | MAG | HOLD
    heading: 0,            // fused heading degrees [0,360)
    confidence: 0,         // 0..1
    lastGpsHeading: 0,
    lastGpsTs: 0,
    gyroAnchor: 0,         // heading anchor for gyro integration
    gyroAnchorTs: 0,
    lastMpuYaw: null,
    lastMpuTs: null,
    phoneHeading: null,
    phoneTs: null,
    magHeading: null,
    magTs: null,
    preferred: 'auto',     // auto | gps | phone | mag (user setting)
    phonePermitted: false, // DeviceOrientation permission granted
  };

  let headingWatch = null; // DeviceOrientation watch id (fallback)

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
      _initPhoneCompass();
      try { map.addLayer(carLayer); } catch (e) { console.warn('add car layer failed:', e); }
    });

    // Catch terrain/tile load errors gracefully so a bad tile URL doesn't crash the page.
    map.on('error', (e) => {
      if (e.error && /elevation-tiles-prod|terrarium/.test(String(e.error))) {
        console.warn('terrain tile error (non-fatal):', e.error);
        terrainOn = false;
        disableTerrain();
        const btn = document.getElementById('btnTerrain');
        if (btn) btn.textContent = 'TERRAIN: N/A';
      }
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

    // Detect user panning/rotating -> drop to Free, resume tracking after debounce.
    function _userGesture() {
      userPanning = true;
      setFollowMode('free');
      lastUserInteractionTs = Date.now();
      const btn = document.getElementById('btnMyLocation');
      if (btn) { btn.className = 'ml-btn ' + ML_STATES.recenter; myLocationMode = 'recenter'; myLocPending = true; }
      clearTimeout(window._mlDebounceTimer);
      window._mlDebounceTimer = setTimeout(() => {
        userPanning = false;
        if (myLocationMode === 'free' || myLocationMode === 'recenter') setMyLocationMode('follow');
      }, ML_DEBOUNCE_MS);
    }
    map.on('mousedown', _userGesture);
    map.on('dragstart', _userGesture);
    map.on('rotatestart', _userGesture);
    map.on('zoomstart', _userGesture);

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
    if (map) {
      map.setStyle(STYLES[key]);
      // style wipe removes all sources/layers; re-init them on next vehicle update
      vehicle.layersReady = false;
      // re-add the 3D car custom layer (wiped by setStyle)
      if (carLayer && carLayer.ready && !map.getLayer('car-3d-layer')) {
        try { map.addLayer(carLayer); } catch (e) { /* layer may already exist */ }
      }
    }
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
    try {
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
    } catch (e) {
      console.warn('terrain tiles unavailable:', e.message);
      terrainOn = false;
      disableTerrain();
    }
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

  // ---- my-location state machine (Stage 3) ---------------------------------
  // recenter -> follow -> compass -> north -> (back to recenter)
  const ML_MODES = ['recenter', 'follow', 'compass', 'north'];
  const ML_LABELS = { recenter: 'RECENTER', follow: 'FOLLOW', compass: 'COMPASS', north: 'NORTH' };
  const ML_STATES = { recenter: 'ml-state-recenter', follow: 'ml-state-follow', compass: 'ml-state-compass', north: 'ml-state-north' };
  let myLocationMode = 'recenter';
  let lockNorth = false;
  let myLocPending = false;   // one-shot recenter pending
  let lastUserInteractionTs = 0;
  const ML_DEBOUNCE_MS = 3000; // GPS won't fight user gestures for this long

  function cycleMyLocation() {
    const i = ML_MODES.indexOf(myLocationMode);
    const next = ML_MODES[(i + 1) % ML_MODES.length];
    setMyLocationMode(next);
    return myLocationMode;
  }
  function getMyLocationMode() { return myLocationMode; }

  function setMyLocationMode(mode) {
    if (!ML_MODES.includes(mode)) return;
    myLocationMode = mode;
    userPanning = (mode === 'free');
    lastUserInteractionTs = Date.now();
    const btn = document.getElementById('btnMyLocation');
    if (btn) {
      btn.className = 'ml-btn ' + ML_STATES[mode];
      btn.title = ML_LABELS[mode] + ' mode';
      btn.setAttribute('aria-pressed', mode !== 'recenter');
    }
    if (mode === 'recenter') { myLocPending = true; requestTrackingUpdate(); }
    else if (mode === 'follow' || mode === 'compass' || mode === 'north') { requestTrackingUpdate(); }
    return myLocationMode;
  }

  function requestTrackingUpdate() {
    if (myLocPending) { myLocPending = false; }
    updateTrackingCamera();
  }

  // Call whenever the vehicle position/heading changes. Respects gesture debounce.
  function updateTrackingCamera() {
    if (!map || !initialized || !vehicle.target) return;
    const now = Date.now();
    const userIdle = (now - lastUserInteractionTs) > ML_DEBOUNCE_MS;
    if (userPanning && userIdle) {
      // debounce expired: resume tracking if in a tracking mode
      userPanning = false;
      if (myLocationMode === 'free') setMyLocationMode('follow');
    }
    if (userPanning) return; // user is in control

    const bearing = (myLocationMode === 'follow' || myLocationMode === 'compass') ? vehicle.heading : 0;
    const pitch = is3D ? 45 : 0;
    map.easeTo({
      center: [vehicle.target.lng, vehicle.target.lat],
      bearing: lockNorth ? 0 : bearing,
      pitch,
      duration: 500, easing: (t) => t * (2 - t),
    });
  }

  function recenterNow() {
    if (!map || !initialized || !vehicle.target) return;
    userPanning = false;
    lastUserInteractionTs = Date.now();
    map.easeTo({
      center: [vehicle.target.lng, vehicle.target.lat],
      bearing: lockNorth ? 0 : vehicle.heading,
      pitch: is3D ? 45 : 0,
      duration: 700, easing: (t) => t * (2 - t),
    });
  }

  function resetNorth() {
    if (!map || !initialized) return;
    lockNorth = true;
    map.easeTo({ bearing: 0, pitch: is3D ? 45 : 0, duration: 700, easing: (t) => t * (2 - t) });
    setFollowMode('north');
    const btn = document.getElementById('btnCompass');
    if (btn) btn.classList.add('compass-locked');
  }

  function toggleLockNorth() {
    lockNorth = !lockNorth;
    const btn = document.getElementById('btnCompass');
    if (btn) btn.classList.toggle('compass-locked', lockNorth);
    if (lockNorth) resetNorth();
    return lockNorth;
  }
  function isLockNorth() { return lockNorth; }

  function getCompassBearing() {
    return map ? map.getBearing() : 0;
  }

  // ---- 3D car custom layer (Stage 3) ---------------------------------------
  // F1-style car built from Three.js primitives, rendered as a MapLibre custom
  // layer. Positioned at the live GPS fix, oriented by fused heading plus
  // MPU6050 roll/pitch, and colored by danger level. Constant metre size so it
  // scales naturally with zoom; a floor scale keeps it visible when zoomed out.
  const CAR = {
    LENGTH_M: 4.6,
    WIDTH_M: 1.9,
    HEIGHT_M: 1.3,
    MIN_SCREEN_SCALE: 0.06, // floor multiplier so car never vanishes when zoomed out
    colors: { safe: 0x06b6d4, warn: 0xffe600, danger: 0xdc2626 },
  };

  let carLayer = null;

  class CarLayer {
    constructor() {
      this.id = 'car-3d-layer';
      this.type = 'custom';
      this.renderingMode = '3d';
      this.map = null;
      this.gl = null;
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.car = null;
      this.ready = false;
      this.lng = 0;
      this.lat = 0;
      this.alt = 0;
      this.heading = 0;
      this.roll = 0;
      this.pitch = 0;
      this.dangerLevel = 0;
    }
    onAdd(map, gl) {
      this.map = map;
      this.gl = gl;
      try {
        this.renderer = new THREE.WebGLRenderer({
          context: gl,
          canvas: gl.canvas,
          antialias: true,
          premultipliedAlpha: true,
        });
        this.renderer.autoClear = false;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.scene = new THREE.Scene();
        this.camera = new THREE.Camera();
        this.camera.matrixAutoUpdate = false;
        this._buildCar();
        this.ready = true;
      } catch (e) {
        console.warn('car layer init failed:', e);
        this.ready = false;
      }
    }
    _buildCar() {
      const car = new THREE.Group();

      // ---- chassis (main body) ----
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(CAR.LENGTH_M, CAR.HEIGHT_M * 0.5, CAR.WIDTH_M),
        new THREE.MeshStandardMaterial({ color: 0x111118, roughness: 0.4, metalness: 0.6 })
      );
      body.position.y = CAR.HEIGHT_M * 0.35;
      body.castShadow = true;
      car.add(body);

      // ---- nose cone (front) ----
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(CAR.WIDTH_M * 0.55, CAR.LENGTH_M * 0.35, 8),
        new THREE.MeshStandardMaterial({ color: 0xdc2626, emissive: 0x4a0000, emissiveIntensity: 0.5 })
      );
      nose.rotation.x = -Math.PI / 2;
      nose.position.set(0, CAR.HEIGHT_M * 0.55, CAR.LENGTH_M * 0.35);
      car.add(nose);

      // ---- cockpit canopy ----
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(CAR.LENGTH_M * 0.5, CAR.HEIGHT_M * 0.45, CAR.WIDTH_M * 0.7),
        new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.7 })
      );
      cabin.position.set(-CAR.LENGTH_M * 0.1, CAR.HEIGHT_M * 0.95, 0);
      car.add(cabin);

      // ---- rear wing ----
      const wing = new THREE.Mesh(
        new THREE.BoxGeometry(CAR.WIDTH_M * 1.1, CAR.HEIGHT_M * 0.25, CAR.LENGTH_M * 0.12),
        new THREE.MeshStandardMaterial({ color: 0x111118 })
      );
      wing.position.set(0, CAR.HEIGHT_M * 1.05, -CAR.LENGTH_M * 0.3);
      car.add(wing);

      // ---- glow halo (danger color) ----
      const glow = new THREE.Mesh(
        new THREE.CylinderGeometry(CAR.WIDTH_M * 0.9, CAR.WIDTH_M * 0.9, 0.05, 16),
        new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.35 })
      );
      glow.rotation.x = Math.PI / 2;
      glow.position.y = CAR.HEIGHT_M * 0.15;
      car.add(glow);
      car._glow = glow;

      this.car = car;
      this.scene.add(car);

      // lights so the car is visible in dark styles / 3d
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
      const dl = new THREE.DirectionalLight(0xffffff, 0.8);
      dl.position.set(50, 100, 50);
      dl.castShadow = true;
      this.scene.add(dl);
    }
    _dangerColor() {
      const d = this.dangerLevel;
      if (d >= 2) return CAR.colors.danger;
      if (d >= 1) return CAR.colors.warn;
      return CAR.colors.safe;
    }
    setPose(lng, lat, alt, heading, roll, pitch, dangerLevel) {
      this.lng = lng;
      this.lat = lat;
      this.alt = typeof alt === 'number' ? alt : 0;
      this.heading = typeof heading === 'number' ? heading : 0;
      this.roll = typeof roll === 'number' ? roll : 0;
      this.pitch = typeof pitch === 'number' ? pitch : 0;
      this.dangerLevel = typeof dangerLevel === 'number' ? dangerLevel : 0;
    }
    render(gl, matrix) {
      if (!this.ready || !this.map || !this.camera || !this.renderer || !this.car) return;
      try {
        // Use MapLibre's view-projection matrix as the camera projection.
        this.camera.projectionMatrix.fromArray(matrix);
        this.camera.matrixAutoUpdate = false;
        this.camera.matrixWorld.identity();

        // Place the car in world space (metres relative to map centre).
        const center = this.map.getCenter();
        const latRad = (center.lat * Math.PI) / 180;
        const worldX = (this.lng - center.lng) * Math.cos(latRad) * 111320; // east
        const worldZ = (this.lat - center.lat) * 111320; // north (screen-up)
        this.car.position.set(worldX, this.alt, worldZ);

        // Orientation: heading (yaw around Y), then pitch (X), then roll (Z).
        const h = (this.heading * Math.PI) / 180;
        const p = (this.pitch * Math.PI) / 180;
        const r = (this.roll * Math.PI) / 180;
        const q = new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(0, 1, 0), h)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), p))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), r));
        this.car.quaternion.copy(q);

        // Constant metre size + floor so it stays visible when zoomed out.
        const zoom = this.map.getZoom();
        const scale = Math.max(CAR.MIN_SCREEN_SCALE, Math.pow(1.12, zoom - 14));
        this.car.scale.setScalar(scale);

        // Colour + glow follow danger level.
        const color = this._dangerColor();
        const body = this.car.children[0];
        const nose = this.car.children[1];
        const glow = this.car._glow;
        if (body) body.material.color.setHex(color);
        if (nose) nose.material.color.setHex(color === 0xdc2626 ? 0xdc2626 : 0x6a2a00);
        if (glow) {
          glow.material.color.setHex(color);
          glow.material.opacity = color === 0x06b6d4 ? 0.35 : 0.6;
        }

        // Restore GL state MapLibre expects, then render.
        this.renderer.state.reset();
        this.renderer.render(this.scene, this.camera);
      } catch (e) {
        console.warn('car layer render failed:', e);
      }
    }
  }

  carLayer = new CarLayer();

  // ---- angle helpers --------------------------------------------------------
  function _normAngle(a) { return ((a % 360) + 360) % 360; }
  function _shortestDelta(from, to) {
    let d = _normAngle(to - from);
    if (d > 180) d -= 360;
    return d;
  }

  function _gpsUsable(cog, speed, hdop, fix) {
    return !!fix && typeof cog === 'number' && typeof speed === 'number'
      && speed >= HEADING.GPS_SPEED_THRESHOLD
      && (hdop === null || hdop <= HEADING.GPS_HDOP_MAX);
  }

  // ---- heading source preference -------------------------------------------
  function setHeadingSource(pref) {
    if (!['auto', 'gps', 'phone', 'mag'].includes(pref)) return;
    headingState.preferred = pref;
    // force re-evaluation on next GPS/IMU update
    headingState.lastMpuYaw = null;
    return headingState.preferred;
  }
  function getHeadingSource() { return headingState.preferred; }

  // ---- DeviceOrientation (phone compass) -----------------------------------
  function _initPhoneCompass() {
    if (headingState.phonePermitted) return;
    if (typeof DeviceOrientationEvent === 'undefined' && typeof window.DeviceOrientationEvent === 'undefined') return;
    const onDeviceOrientation = (e) => {
      let alpha = e.alpha; // degrees 0-360, north = 0, clockwise
      if (typeof alpha !== 'number') return;
      // webkitCompassHeading (legacy iOS) is compass heading directly; alpha is device-relative
      if (typeof e.webkitCompassHeading === 'number') alpha = e.webkitCompassHeading;
      alpha = _normAngle(alpha + HEADING.PHONE_COMPASS_OFFSET);
      headingState.phoneHeading = alpha;
      headingState.phoneTs = Date.now();
      if (headingState.preferred === 'auto' || headingState.preferred === 'phone') {
        headingState.source = 'PHONE';
        headingState.heading = alpha;
        headingState.confidence = 0.7;
      }
    };
    const request = () => {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then((resp) => {
            if (resp === 'granted') {
              headingState.phonePermitted = true;
              window.addEventListener('deviceorientation', onDeviceOrientation);
            }
          })
          .catch(() => { headingState.phonePermitted = false; });
      } else {
        headingState.phonePermitted = true;
        window.addEventListener('deviceorientation', onDeviceOrientation);
      }
    };
    // Expose globally so a UI button can request permission on a user gesture.
    window.__requestPhoneCompass = request;
    return request;
  }

  // ---- heading fusion -------------------------------------------------------
  function _fuseHeading(gpsCog, gpsSpeed, gpsHdop, gpsFix, mpuYaw, magHeading, ts) {
    const now = ts || Date.now();
    const gpsOk = _gpsUsable(gpsCog, gpsSpeed, gpsHdop, gpsFix);

    // ---- IMU (gyro) integration -------------------------------------------
    if (typeof mpuYaw === 'number') {
      if (headingState.lastMpuYaw !== null && headingState.lastMpuTs !== null) {
        const dt = Math.max(0, now - headingState.lastMpuTs);
        const delta = _shortestDelta(headingState.lastMpuYaw, mpuYaw);
        headingState.gyroAnchor = _normAngle(headingState.gyroAnchor + delta);
        headingState.gyroAnchorTs = now;
      }
      headingState.lastMpuYaw = mpuYaw;
      headingState.lastMpuTs = now;
    }

    // ---- GPS course (absolute) --------------------------------------------
    if (gpsOk) {
      headingState.lastGpsHeading = gpsCog;
      headingState.lastGpsTs = now;
      headingState.gyroAnchor = gpsCog;
      headingState.gyroAnchorTs = now;
    }

    // ---- MAG (absolute) ---------------------------------------------------
    if (typeof magHeading === 'number') {
      headingState.magHeading = _normAngle(magHeading);
      headingState.magTs = now;
    }

    // ---- decide source + fused heading ------------------------------------
    let source = headingState.source;
    let heading = headingState.heading;
    let confidence = headingState.confidence;

    const prefer = headingState.preferred;
    const gpsAge = now - headingState.lastGpsTs;

    if (prefer === 'gps') {
      if (gpsOk) {
        source = 'GPS'; heading = gpsCog;
        confidence = Math.min(1, gpsSpeed / 20) * (gpsHdop === null ? 1 : Math.max(0, 1 - gpsHdop / 10));
      } else {
        source = 'HOLD'; heading = headingState.lastGpsHeading; confidence = 0.2;
      }
    } else if (prefer === 'phone') {
      if (headingState.phoneHeading !== null && (now - headingState.phoneTs) < 5000) {
        source = 'PHONE'; heading = headingState.phoneHeading; confidence = 0.75;
      } else if (gpsOk) {
        source = 'GPS'; heading = gpsCog;
        confidence = Math.min(1, gpsSpeed / 20) * (gpsHdop === null ? 1 : Math.max(0, 1 - gpsHdop / 10));
      } else {
        source = 'GYRO'; heading = _normAngle(headingState.gyroAnchor);
        confidence = Math.max(0, 1 - gpsAge / HEADING.CONFIDENCE_DECAY_MS) * 0.6;
      }
    } else if (prefer === 'mag') {
      if (headingState.magHeading !== null && (now - headingState.magTs) < 5000) {
        source = 'MAG'; heading = headingState.magHeading; confidence = 0.8;
      } else if (gpsOk) {
        source = 'GPS'; heading = gpsCog;
        confidence = Math.min(1, gpsSpeed / 20) * (gpsHdop === null ? 1 : Math.max(0, 1 - gpsHdop / 10));
      } else {
        source = 'GYRO'; heading = _normAngle(headingState.gyroAnchor);
        confidence = Math.max(0, 1 - gpsAge / HEADING.CONFIDENCE_DECAY_MS) * 0.6;
      }
    } else {
      // auto: GPS when moving & usable, else gyro integrated from GPS anchor
      if (gpsOk) {
        source = 'GPS'; heading = gpsCog;
        confidence = Math.min(1, gpsSpeed / 20) * (gpsHdop === null ? 1 : Math.max(0, 1 - gpsHdop / 10));
      } else {
        // phone/mag overrides take precedence if fresh
        let usedAbsolute = false;
        if (headingState.phoneHeading !== null && (now - headingState.phoneTs) < 5000) {
          source = 'PHONE'; heading = headingState.phoneHeading; confidence = 0.7; usedAbsolute = true;
        } else if (headingState.magHeading !== null && (now - headingState.magTs) < 5000) {
          source = 'MAG'; heading = headingState.magHeading; confidence = 0.8; usedAbsolute = true;
        }
        if (!usedAbsolute) {
          source = 'GYRO';
          heading = _normAngle(headingState.gyroAnchor);
          // drift pull back toward last GPS heading
          const pull = HEADING.GYRO_DRIFT_PULL * Math.min(1, Math.max(0, now - headingState.lastMpuTs || 0) / 1000 || 1);
          const d = _shortestDelta(heading, headingState.lastGpsHeading);
          heading = _normAngle(heading + d * pull * 0.1);
          headingState.gyroAnchor = heading;
          confidence = Math.max(0, 1 - gpsAge / HEADING.CONFIDENCE_DECAY_MS);
        }
      }
    }

    headingState.source = source;
    headingState.heading = _normAngle(heading);
    headingState.confidence = Math.max(0, Math.min(1, confidence));
    return { source: headingState.source, heading: headingState.heading, confidence: headingState.confidence };
  }

  function getHeading() {
    return { source: headingState.source, heading: headingState.heading, confidence: headingState.confidence, preferred: headingState.preferred };
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
    headingSource: 'HOLD', headingConfidence: 0,
    roll: 0, pitch: 0,
    speed: 0, hdop: null, fix: false,
    trail: [], maxTrail: 400,
    layersReady: false,
  };

  function _vehicleEl() {
    if (vehicle.el) return vehicle.el;
    const el = document.createElement('div');
    el.className = 'vehicle-marker';
    el.style.width = '24px'; el.style.height = '24px';
    el.style.position = 'relative';
    el.style.transformOrigin = 'center';

    // Google-style blue dot (the vehicle position)
    const dot = document.createElement('div');
    dot.className = 'vehicle-dot';
    dot.style.position = 'absolute';
    dot.style.top = '50%'; dot.style.left = '50%';
    dot.style.width = '10px'; dot.style.height = '10px';
    dot.style.background = '#06b6d4';
    dot.style.border = '2px solid #fff';
    dot.style.borderRadius = '50%';
    dot.style.transform = 'translate(-50%,-50%)';
    dot.style.boxShadow = '0 0 8px rgba(6,182,212,0.7)';
    dot.style.zIndex = '2';
    el.appendChild(dot);

    // Translucent view cone showing facing direction; width ~ confidence
    const cone = document.createElement('div');
    cone.className = 'vehicle-cone';
    cone.style.position = 'absolute';
    cone.style.bottom = '12px'; cone.style.left = '50%';
    cone.style.transform = 'translateX(-50%)';
    cone.style.width = '24px'; cone.style.height = '34px';
    cone.style.background = 'rgba(6,182,212,0.28)';
    cone.style.clipPath = 'polygon(50% 0%, 100% 100%, 0% 100%)';
    cone.style.transformOrigin = 'center bottom';
    cone.style.zIndex = '1';
    el.appendChild(cone);
    vehicle._cone = cone;
    vehicle._dot = dot;
    vehicle.el = el;
    return el;
  }

  function _initVehicleLayers() {
    if (vehicle.layersReady || !map || !initialized) return;
    // accuracy circle (sized from HDOP) — idempotent: style wipe removes sources
    if (!map.getSource('vehicle-acc')) {
      map.addSource('vehicle-acc', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer('vehicle-acc-layer')) {
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
    }
    // speed-colored trail — idempotent
    if (!map.getSource('vehicle-trail')) {
      map.addSource('vehicle-trail', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('vehicle-trail-layer')) {
      map.addLayer({
        id: 'vehicle-trail-layer',
        type: 'line',
        source: 'vehicle-trail',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': 3,
          'line-color': [
            'interpolate', ['linear'], ['get', 's'],
            0, '#06b6d4', 40, '#2447ff', 80, '#ffe600', 120, '#dc2626'],
          'line-opacity': 0.8,
        },
      });
    }
    vehicle.layersReady = true;
  }

  function _updateTrail() {
    if (!map || !initialized || !vehicle.layersReady) return;
    const src = map.getSource('vehicle-trail');
    if (!src) return; // style change wiped sources; will be re-added on next _initVehicleLayers
    const feats = [];
    for (let i = 1; i < vehicle.trail.length; i++) {
      const a = vehicle.trail[i - 1], b = vehicle.trail[i];
      feats.push({
        type: 'Feature',
        properties: { s: (a.speed + b.speed) / 2 },
        geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
      });
    }
    src.setData({ type: 'FeatureCollection', features: feats });
  }

  function clearTrail() {
    vehicle.trail = [];
    if (map && initialized && vehicle.layersReady) {
      const src = map.getSource('vehicle-trail');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
    }
  }

  /**
   * Feed a live GPS fix into the map. Called from app.js on every valid GPS message.
   * Never extrapolates past the last fix; marker glides toward it each frame.
   * @param roll/pitch/yaw MPU6050 orientation (degrees). yaw is integrated as gyro delta.
   * @param magHeading optional compass heading (degrees) from a magnetometer.
   */
  function setVehicle(lng, lat, heading, speed, hdop, fix, ts, roll, pitch, yaw, magHeading, lvl, alt) {
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
    vehicle.dangerLevel = typeof lvl === 'number' ? lvl : 0;
    vehicle.alt = typeof alt === 'number' ? alt : 0;
    if (typeof roll === 'number') vehicle.roll = roll;
    if (typeof pitch === 'number') vehicle.pitch = pitch;

    // ---- heading fusion ----------------------------------------------------
    const fused = _fuseHeading(heading, speed, hdop, fix, yaw, magHeading, ts);
    vehicle.heading = fused.heading;
    vehicle.headingSource = fused.source;
    vehicle.headingConfidence = fused.confidence;

    const stale = !vehicle.fix || fused.confidence < 0.25;
    const conf = fused.confidence;

    if (vehicle.marker) {
      vehicle.marker.setRotation(vehicle.heading);
      const el = vehicle.marker.getElement();
      // whole marker: fade + grayscale when stale
      el.style.opacity = stale ? '0.45' : '1';
      el.style.filter = stale ? 'grayscale(1)' : 'none';

      // dot color: blue when confident/fresh, grey when stale
      const dot = el.querySelector('.vehicle-dot');
      if (dot) {
        dot.style.background = stale ? '#8a8a96' : '#06b6d4';
        dot.style.borderColor = stale ? '#cfcfd6' : '#fff';
        dot.style.boxShadow = stale ? '0 0 6px rgba(138,138,150,0.4)' : '0 0 8px rgba(6,182,212,0.7)';
      }

      // cone: width grows as confidence drops; fades when stale
      const cone = el.querySelector('.vehicle-cone');
      if (cone) {
        const w = 18 + (1 - conf) * 100;   // 18px (conf 1) -> 118px (conf 0)
        cone.style.width = Math.max(16, Math.min(140, w)) + 'px';
        cone.style.background = stale ? 'rgba(138,138,150,0.18)' : 'rgba(6,182,212,' + (0.22 + 0.18 * conf) + ')';
        cone.style.opacity = stale ? '0.35' : (0.5 + 0.3 * conf);
        const narrow = 50 - (1 - conf) * 18;   // conf1 -> 50%, conf0 -> 32% ... wide base
        cone.style.clipPath = 'polygon(50% 0%, ' + (50 + (1 - conf) * 25) + '% 100%, ' + (50 - (1 - conf) * 25) + '% 100%)';
      }

      // badge text: source + confidence, tooltip-style title
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

    // Drive the 3D car custom layer with the same fused pose as the marker.
    if (carLayer && carLayer.ready) {
      carLayer.setPose(
        vehicle.target.lng,
        vehicle.target.lat,
        vehicle.alt,
        vehicle.heading,
        vehicle.roll,
        vehicle.pitch,
        vehicle.dangerLevel
      );
      map.triggerRepaint();
    }

    // Unified my-location tracking (respects gesture debounce).
    updateTrackingCamera();
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
    setHeadingSource, getHeadingSource, getHeading,
    cycleMyLocation, setMyLocationMode, getMyLocationMode,
    recenterNow, resetNorth, toggleLockNorth, isLockNorth, getCompassBearing,
    flyTo, easeTo,
    getMap: () => map,
  };
})();
