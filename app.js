/* ============================================================
   Fuentes de Madrid — localizador de agua para beber
   Datos: Ayuntamiento de Madrid (CC BY 4.0)
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const SERVICE = 'https://sigma.madrid.es/hosted/rest/services/MEDIO_AMBIENTE/FUENTES_DE_AGUA/MapServer/3';
const FIELDS = 'CODIGO_INTERNO,ESTADO,USO,MODELO,DIRECCION,DIRECCION_AUX,BARRIO,DISTRITO';
const CACHE_KEY = 'fuentes_madrid_v1';
const CACHE_TTL = 24 * 60 * 60 * 1000;          // 24 h
const DEFAULT_RADIUS = 500;                      // metros
const MADRID_CENTER = [40.4168, -3.7038];

/* ---------- State ---------- */
let map, userMarker, accCircle, radiusCircle;
let fountains = [];          // {lat,lon,props,marker,dist}
let userPos = null;          // {lat,lon,acc}
let geoWatchId = null;
let selected = null;         // currently selected fountain
let heading = null;          // compass heading (deg)

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(aLat, aLon, bLat, bLon) {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
            Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function fmtDist(m) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function titleCase(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/(^|\s|\/|\(|-)([a-záéíóúñ])/g,
    (m, p, c) => p + c.toUpperCase());
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================================================
   DATA: load from cache, refresh from official service
   ============================================================ */
let _dataPromise = null;
function ensureData() {
  if (fountains.length) return Promise.resolve(fountains);
  if (!_dataPromise) _dataPromise = loadData().catch((e) => { _dataPromise = null; throw e; });
  return _dataPromise;
}

async function loadData() {
  // 1) try cache for instant start
  const cached = readCache();
  if (cached) {
    fountains = cached.features.map(makeFountain);
    setUpdated(cached.updated, fountains.length);
  }
  // 2) refresh from network (skip only if cache is very fresh)
  const fresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL;
  if (!cached || !fresh) {
    try {
      const data = await fetchAll();
      fountains = data.features.map(makeFountain);
      writeCache(data);
      setUpdated(data.updated, fountains.length);
    } catch (e) {
      console.warn('Refresh failed', e);
      if (!cached) throw e;     // nothing to show at all
    }
  }
  return fountains;
}

function makeFountain(f) {
  return { lat: f.lat, lon: f.lon, props: f.props, marker: null, dist: null };
}

async function fetchAll() {
  const updated = await fetchUpdatedDate();
  const PAGE = 3000;                     // = service maxRecordCount: one page covers current data
  const all = [];
  const seen = new Set();                // dedupe by CODIGO_INTERNO (safety net)
  let offset = 0, guard = 0;
  while (guard++ < 20) {
    const url = `${SERVICE}/query?where=${encodeURIComponent("ESTADO='OPERATIVO'")}` +
                `&outFields=${encodeURIComponent(FIELDS)}&returnGeometry=true&outSR=4326` +
                `&resultOffset=${offset}&resultRecordCount=${PAGE}&f=geojson`;
    const res = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const gj = await res.json();
    const feats = (gj.features || []).filter(g => g.geometry && g.geometry.coordinates);
    let added = 0;
    for (const g of feats) {
      const [lon, lat] = g.geometry.coordinates;
      const code = (g.properties && g.properties.CODIGO_INTERNO) || `${lat},${lon}`;
      if (typeof lat !== 'number' || typeof lon !== 'number' || seen.has(code)) continue;
      seen.add(code);
      all.push({ lat, lon, props: g.properties || {} });
      added++;
    }
    // stop when the page wasn't full, or pagination isn't adding anything new
    if (feats.length < PAGE || added === 0) break;
    offset += PAGE;
  }
  if (!all.length) throw new Error('Sin resultados');
  return { features: all, updated, fetchedAt: Date.now() };
}

async function fetchUpdatedDate() {
  try {
    const res = await fetch(`${SERVICE}?f=json`, { referrerPolicy: 'no-referrer' });
    const meta = await res.json();
    const ms = meta && meta.editingInfo && meta.editingInfo.lastEditDate;
    if (ms) return ms;
  } catch (_) {}
  return Date.now();   // fallback: today (data is updated daily)
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o.features || !o.features.length) return null;
    return o;
  } catch (_) { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
}

function setUpdated(ms, n) {
  const d = new Date(ms);
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  $('updatedText').textContent = `Base de datos actualizada: ${fmt} · ${n} fuentes`;
}

/* ============================================================
   SPLASH → location permission
   ============================================================ */
$('askLocation').addEventListener('click', requestLocation);

function requestLocation() {
  if (!('geolocation' in navigator)) {
    $('splashErr').textContent = 'Tu navegador no permite geolocalización.';
    return;
  }
  const btn = $('askLocation');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Buscando tu posición…';
  $('splashErr').textContent = '';

  navigator.geolocation.getCurrentPosition(
    (pos) => { userPos = posToObj(pos); startApp(); },
    (err) => {
      btn.disabled = false;
      btn.innerHTML = 'Permitir ubicación';
      const msg = err.code === 1
        ? 'Permiso denegado. Actívalo en los ajustes del navegador para ver las fuentes cercanas.'
        : 'No hemos podido obtener tu ubicación. Inténtalo de nuevo.';
      $('splashErr').textContent = msg;
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}
function posToObj(pos) {
  return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
}

async function startApp() {
  // make sure data is ready
  try {
    if (!fountains.length) await ensureData();
  } catch (e) {
    $('askLocation').disabled = false;
    $('askLocation').innerHTML = 'Reintentar';
    $('splashErr').textContent = 'No se pudieron cargar las fuentes. Revisa tu conexión e inténtalo de nuevo.';
    return;
  }
  $('splash').style.display = 'none';
  $('app').style.display = 'flex';
  initMap();
  watchPosition();
}

/* ============================================================
   MAP
   ============================================================ */
function userIcon() {
  return L.divIcon({
    className: '',
    iconSize: [28, 28], iconAnchor: [14, 14],
    html: `<div class="user-dot"><svg width="28" height="28" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="13" fill="#1f7fe0" fill-opacity="0.18"/>
      <circle cx="14" cy="14" r="7" fill="#1f7fe0" stroke="#fff" stroke-width="3"/></svg></div>`
  });
}
function fountainIcon(off) {
  const color = off ? '#9aa7b6' : '#1f7fe0';
  return L.divIcon({
    className: '',
    iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -38],
    html: `<div class="fountain-pin${off ? ' off' : ''}">
      <svg width="34" height="42" viewBox="0 0 34 42">
        <path d="M17 1 C17 1 4 15 4 25 a13 13 0 0 0 26 0 C30 15 17 1 17 1 Z"
              fill="${color}" stroke="#fff" stroke-width="2.5"/>
        <path d="M17 12 c-3 4 -5 6.5 -5 9 a5 5 0 0 0 10 0 c0 -2.5 -2 -5 -5 -9 z" fill="#fff"/>
      </svg></div>`
  });
}

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true })
        .setView([userPos.lat, userPos.lon], 16);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Fuentes: Ayto. de Madrid',
    subdomains: 'abcd', maxZoom: 20, detectRetina: true
  }).addTo(map);

  userMarker = L.marker([userPos.lat, userPos.lon], { icon: userIcon(), zIndexOffset: 1000 })
               .addTo(map).bindTooltip('Estás aquí', { direction: 'top', offset: [0, -10] });
  accCircle = L.circle([userPos.lat, userPos.lon], {
    radius: userPos.acc || 30, color: '#1f7fe0', weight: 1, opacity: .3, fillOpacity: .08
  }).addTo(map);

  // place fountain markers
  for (const f of fountains) {
    const off = (f.props.ESTADO || '').toUpperCase() !== 'OPERATIVO';
    f.marker = L.marker([f.lat, f.lon], { icon: fountainIcon(off) })
                .addTo(map).on('click', () => openSheet(f));
  }

  recomputeDistances();
  fitInitialView();
  $('count').textContent = `${fountains.length} fuentes`;

  $('recenter').addEventListener('click', () => {
    if (userPos) map.setView([userPos.lat, userPos.lon], 16, { animate: true });
  });
}

function recomputeDistances() {
  if (!userPos) return;
  for (const f of fountains) f.dist = haversine(userPos.lat, userPos.lon, f.lat, f.lon);
  fountains.sort((a, b) => a.dist - b.dist);
}

function nearest() { return fountains.length ? fountains[0] : null; }

/* default 500 m view; if no fountain inside, widen to include the closest one */
function fitInitialView() {
  const near = nearest();
  let radius = DEFAULT_RADIUS;
  if (near && near.dist > DEFAULT_RADIUS) radius = near.dist * 1.15;

  if (radiusCircle) map.removeLayer(radiusCircle);
  radiusCircle = L.circle([userPos.lat, userPos.lon], {
    radius, color: '#1f7fe0', weight: 1.5, dashArray: '6 6', opacity: .5, fillOpacity: .04
  }).addTo(map);

  map.fitBounds(radiusCircle.getBounds(), { padding: [40, 40] });

  if (near && near.dist > DEFAULT_RADIUS) {
    toast(`No hay fuentes en 500 m. La más cercana está a ${fmtDist(near.dist)}.`);
  }
}

/* ============================================================
   LIVE position tracking
   ============================================================ */
function watchPosition() {
  if (geoWatchId != null) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userPos = posToObj(pos);
      if (userMarker) userMarker.setLatLng([userPos.lat, userPos.lon]);
      if (accCircle) { accCircle.setLatLng([userPos.lat, userPos.lon]); accCircle.setRadius(userPos.acc || 30); }
      recomputeDistances();
      if (selected) updateSheetDistance();
      if ($('ar').style.display === 'block') updateAR();
    },
    () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

/* ============================================================
   INFO SHEET
   ============================================================ */
const USO_ICON = {
  PERSONAS: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/></svg>',
  MASCOTAS: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12.5" r="1.8"/><circle cx="9.5" cy="8" r="1.8"/><circle cx="14.5" cy="8" r="1.8"/><circle cx="18.5" cy="12.5" r="1.8"/><path d="M12 12c-2.5 0-4.5 2-5 4-.4 1.6.8 3 2.4 3 .9 0 1.7-.4 2.6-.4s1.7.4 2.6.4c1.6 0 2.8-1.4 2.4-3-.5-2-2.5-4-5-4z"/></svg>',
  MIXTO: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="18" cy="14" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="12.5" r="1.4" fill="currentColor" stroke="none"/></svg>'
};
function usoLabel(u) {
  u = (u || '').toUpperCase();
  if (u.includes('MIXTO')) return ['MIXTO', 'Personas y mascotas'];
  if (u.includes('MASCOTA')) return ['MASCOTAS', 'Para mascotas'];
  if (u.includes('PERSONA')) return ['PERSONAS', 'Para personas'];
  return ['MIXTO', titleCase(u) || 'Uso general'];
}

function openSheet(f) {
  selected = f;
  const p = f.props;
  const addr = [titleCase(p.DIRECCION), p.DIRECCION_AUX ? titleCase(p.DIRECCION_AUX) : '']
               .filter(Boolean).join(' · ');
  $('sName').textContent = titleCase(p.BARRIO) ? `Fuente · ${titleCase(p.BARRIO)}` : 'Fuente de agua';
  $('sAddr').textContent = [addr, titleCase(p.DISTRITO)].filter(Boolean).join(' — ');

  const [usoKey, usoTxt] = usoLabel(p.USO);
  const operative = (p.ESTADO || '').toUpperCase() === 'OPERATIVO';
  const chips = [];
  chips.push(`<span class="chip dist">${pinSvg()} ${fmtDist(f.dist)}</span>`);
  chips.push(`<span class="chip">${USO_ICON[usoKey] || ''} ${usoTxt}</span>`);
  chips.push(`<span class="chip ${operative ? 'ok' : ''}">${operative ? checkSvg() : ''} ${operative ? 'Operativa' : titleCase(p.ESTADO || 'Estado desconocido')}</span>`);
  $('sChips').innerHTML = chips.join('');

  $('sheet').classList.add('open');
}
function updateSheetDistance() {
  if (!selected) return;
  const el = $('sChips').querySelector('.chip.dist');
  if (el) el.innerHTML = `${pinSvg()} ${fmtDist(selected.dist)}`;
}
function pinSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>';
}
function checkSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
}
$('sheetClose').addEventListener('click', () => { $('sheet').classList.remove('open'); selected = null; });

/* ---------- Walking route (opens map app) ---------- */
$('btnRoute').addEventListener('click', () => {
  if (!selected) return;
  const d = selected, u = userPos;
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const url = isiOS
    ? `https://maps.apple.com/?saddr=${u.lat},${u.lon}&daddr=${d.lat},${d.lon}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&origin=${u.lat},${u.lon}&destination=${d.lat},${d.lon}&travelmode=walking`;
  window.open(url, '_blank', 'noopener');
});

/* ============================================================
   AR MODE (camera + compass arrow)
   ============================================================ */
let arStream = null;

$('btnAR').addEventListener('click', startAR);
$('arClose').addEventListener('click', stopAR);

async function startAR() {
  if (!selected) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Tu navegador no permite usar la cámara para AR.'); return;
  }
  // iOS 13+ needs explicit motion/orientation permission
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') { toast('Necesito permiso de orientación para la brújula.'); }
    }
  } catch (_) {}

  try {
    arStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false
    });
  } catch (e) {
    toast('No se pudo abrir la cámara. Revisa los permisos.'); return;
  }
  $('arVideo').srcObject = arStream;
  $('ar').style.display = 'block';
  $('arName').textContent = $('sName').textContent;
  startCompass();
  updateAR();
}

function stopAR() {
  $('ar').style.display = 'none';
  if (arStream) { arStream.getTracks().forEach(t => t.stop()); arStream = null; }
  stopCompass();
}

function startCompass() {
  window.addEventListener('deviceorientationabsolute', onOrient, true);
  window.addEventListener('deviceorientation', onOrient, true);
}
function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrient, true);
  window.removeEventListener('deviceorientation', onOrient, true);
}
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') {
    h = e.webkitCompassHeading;                       // iOS: already 0 = North, clockwise
  } else if (e.absolute && typeof e.alpha === 'number') {
    h = 360 - e.alpha;                                // Android absolute
  } else if (typeof e.alpha === 'number') {
    h = 360 - e.alpha;
  }
  if (h != null) {
    // adjust for screen rotation
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    heading = (h + so + 360) % 360;
    updateAR();
  }
}

function updateAR() {
  if (!selected || !userPos || $('ar').style.display !== 'block') return;
  const dist = haversine(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const brg = bearing(userPos.lat, userPos.lon, selected.lat, selected.lon);

  const dEl = $('arDist'), hintEl = $('arHint');
  if (dist < 12) {
    dEl.textContent = '¡Ya casi!'; dEl.classList.add('ar-arrived');
    hintEl.textContent = 'La fuente está a unos pasos de ti';
  } else {
    dEl.textContent = fmtDist(dist); dEl.classList.remove('ar-arrived');
    hintEl.textContent = heading == null
      ? 'Mueve el móvil en forma de 8 para calibrar la brújula'
      : 'Camina en la dirección de la flecha';
  }

  const rot = heading == null ? 0 : (brg - heading + 360) % 360;
  $('arArrow').style.transform = `rotate(${rot}deg)`;
}

/* re-evaluate distances if user rotates device orientation */
window.addEventListener('orientationchange', () => { if (map) setTimeout(() => map.invalidateSize(), 300); });

/* ============================================================
   BOOT — arranque de la app
   ============================================================ */
(async function boot() {
  try { await ensureData(); }
  catch (e) {
    $('updatedText').textContent = 'No se pudo cargar la base de datos (revisa tu conexión).';
  }
  // register service worker for offline / installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
