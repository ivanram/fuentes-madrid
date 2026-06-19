/* ============================================================
   Fuentes de Madrid — localizador de agua para beber
   Datos: Ayuntamiento de Madrid (CC BY 4.0)
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const INFO_URL = 'https://datos.madrid.es/dataset/300051-0-fuentes';
const MARKER_CAP = 350;          // máx. marcadores dibujados a la vez (rendimiento)
const MIN_RADIUS = 70;           // m: evita sobre-acercar si la fuente está pegada

/* ---------- State ---------- */
let map, userMarker, accCircle, radiusCircle, fountainLayer;
let allFountains = [];           // todas las fuentes del dataset
let fountains = [];              // subconjunto activo tras aplicar filtros
const shown = new Set();         // fuentes con marcador actualmente en el mapa
let userPos = null;
let geoWatchId = null;
let selected = null;
let heading = null;
let dataUpdated = Date.now();
const filters = { operativeOnly: true, uso: 'todas' };   // uso: todas | personas | perros

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
  return s.toLowerCase().replace(/(^|\s|\/|\(|-)([a-záéíóúñ])/g, (m, p, c) => p + c.toUpperCase());
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================================================
   DATA: load bundled local dataset (fuentes.json)
   Generado desde el CSV oficial del Ayuntamiento de Madrid
   (CC BY 4.0) y reproyectado a WGS84. Sin dependencias de red.
   ============================================================ */
let _dataPromise = null;
function ensureData() {
  if (allFountains.length) return Promise.resolve(allFountains);
  if (!_dataPromise) _dataPromise = loadData().catch((e) => { _dataPromise = null; throw e; });
  return _dataPromise;
}

async function loadData() {
  const res = await fetch('./fuentes.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const list = (data.features || []).filter(f => typeof f.lat === 'number' && typeof f.lon === 'number');
  if (!list.length) throw new Error('Sin datos');
  allFountains = list.map(makeFountain);
  dataUpdated = data.updated || Date.now();
  const operativas = allFountains.filter(f => isOperative(f)).length;
  setUpdated(dataUpdated, operativas);
  return allFountains;
}

function makeFountain(f) {
  return { lat: f.lat, lon: f.lon, props: f.props, marker: null, dist: null };
}
function isOperative(f) { return (f.props.ESTADO || '').toUpperCase() === 'OPERATIVO'; }

function setUpdated(ms, n) {
  const d = new Date(ms);
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: '2-digit' });
  $('updatedText').textContent = `Datos actualizados: ${fmt} · ${n} fuentes`;
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
      $('splashErr').textContent = err.code === 1
        ? 'Permiso denegado. Actívalo en los ajustes del navegador para ver las fuentes cercanas.'
        : 'No hemos podido obtener tu ubicación. Inténtalo de nuevo.';
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}
function posToObj(pos) {
  return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
}

async function startApp() {
  try { if (!allFountains.length) await ensureData(); }
  catch (e) {
    $('askLocation').disabled = false;
    $('askLocation').innerHTML = 'Reintentar';
    $('splashErr').textContent = 'No se pudieron cargar las fuentes. Recarga la página e inténtalo de nuevo.';
    return;
  }
  $('splash').style.display = 'none';
  $('app').style.display = 'flex';
  initMap();
  watchPosition();
}

/* ============================================================
   FILTERS
   ============================================================ */
function matchesFilter(f) {
  if (filters.operativeOnly && !isOperative(f)) return false;
  const u = (f.props.USO || '').toUpperCase();
  if (filters.uso === 'personas' && !(u === 'PERSONAS' || u === 'MIXTO')) return false;
  if (filters.uso === 'perros' && !(u === 'MASCOTAS' || u === 'MIXTO')) return false;
  return true;
}
function applyFilters() {
  fountains = allFountains.filter(matchesFilter);
  recomputeDistances();
  const n = fountains.length;
  if ($('countN')) $('countN').textContent = `${n}`;
  if ($('filterCount')) $('filterCount').textContent = n;
}
function previewCount() {
  // cuántas habría con la configuración actual de la UI (sin tocar el estado global)
  return allFountains.filter(matchesFilter).length;
}

function readFilterUI() {
  filters.operativeOnly = $('fOper').checked;
  const active = $('fUso').querySelector('button.active');
  filters.uso = active ? active.dataset.uso : 'todas';
}
function onFilterChange() {
  readFilterUI();
  applyFilters();
  renderMarkers();
}
function openFilters() {
  // sincroniza la UI con el estado actual
  $('fOper').checked = filters.operativeOnly;
  $('fUso').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.uso === filters.uso));
  $('filterCount').textContent = fountains.length;
  $('filterSheet').classList.add('open');
}
function closeFilters() {
  $('filterSheet').classList.remove('open');
  fitInitialView();      // reencuadra a la más cercana del nuevo conjunto
}

/* ============================================================
   MAP
   ============================================================ */
function userIcon() {
  return L.divIcon({
    className: '', iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="user-dot"><svg width="30" height="30" viewBox="0 0 30 30">
      <circle cx="15" cy="15" r="14" fill="#1f7fe0" fill-opacity="0.18"/>
      <circle cx="15" cy="15" r="7.5" fill="#1f7fe0" stroke="#fff" stroke-width="3.2"/></svg></div>`
  });
}
function fountainIcon(off) {
  const color = off ? '#9aa7b6' : '#1f7fe0';
  return L.divIcon({
    className: '', iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -38],
    html: `<div class="fountain-pin${off ? ' off' : ''}">
      <svg width="34" height="42" viewBox="0 0 34 42">
        <path d="M17 1 C17 1 4 15 4 25 a13 13 0 0 0 26 0 C30 15 17 1 17 1 Z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
        <path d="M17 12 c-3 4 -5 6.5 -5 9 a5 5 0 0 0 10 0 c0 -2.5 -2 -5 -5 -9 z" fill="#fff"/>
      </svg></div>`
  });
}

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true, preferCanvas: true })
        .setView([userPos.lat, userPos.lon], 16);

  // CARTO Voyager: estilo colorido tipo Google Maps, gratuito y sin API key.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Fuentes: Ayto. de Madrid',
    subdomains: 'abcd', maxZoom: 20, detectRetina: true
  }).addTo(map);

  userMarker = L.marker([userPos.lat, userPos.lon], { icon: userIcon(), zIndexOffset: 1000 })
               .addTo(map).bindTooltip('Estás aquí', { direction: 'top', offset: [0, -12] });
  accCircle = L.circle([userPos.lat, userPos.lon], {
    radius: userPos.acc || 30, color: '#1f7fe0', weight: 1, opacity: .3, fillOpacity: .08
  }).addTo(map);

  fountainLayer = L.layerGroup().addTo(map);

  applyFilters();
  map.on('moveend zoomend', debounce(renderMarkers, 90));

  // El contenedor del mapa se acaba de hacer visible: si encuadramos ya,
  // Leaflet aún lo ve con tamaño 0 y el zoom sale mal. Recalculamos tamaño
  // tras el primer reflow y entonces ajustamos a la fuente más cercana.
  requestAnimationFrame(() => {
    map.invalidateSize();
    fitInitialView();
    renderMarkers();
  });
  $('recenter').addEventListener('click', () => {
    if (userPos) map.setView([userPos.lat, userPos.lon], 16, { animate: true });
  });
}

/* dibuja solo lo visible (con margen) y como mucho MARKER_CAP marcadores */
function renderMarkers() {
  if (!map || !fountainLayer) return;
  const b = map.getBounds().pad(0.25);
  let inView = [];
  for (const f of fountains) if (b.contains([f.lat, f.lon])) inView.push(f);
  if (inView.length > MARKER_CAP) {
    const c = map.getCenter();
    inView.sort((a, z) => map.distance(c, [a.lat, a.lon]) - map.distance(c, [z.lat, z.lon]));
    inView = inView.slice(0, MARKER_CAP);
  }
  const need = new Set(inView);
  for (const f of Array.from(shown)) {
    if (!need.has(f)) { if (f.marker) fountainLayer.removeLayer(f.marker); f.marker = null; shown.delete(f); }
  }
  for (const f of inView) {
    if (!f.marker) {
      f.marker = L.marker([f.lat, f.lon], { icon: fountainIcon(!isOperative(f)) }).on('click', () => openSheet(f));
      fountainLayer.addLayer(f.marker); shown.add(f);
    }
  }
}

function recomputeDistances() {
  if (!userPos) return;
  for (const f of fountains) f.dist = haversine(userPos.lat, userPos.lon, f.lat, f.lon);
  fountains.sort((a, b) => a.dist - b.dist);
}
function nearest() { return fountains.length ? fountains[0] : null; }

/* la vista inicial se ajusta al radio de la fuente más cercana */
function fitInitialView() {
  if (!userPos || !map) return;
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  const near = nearest();
  if (!near) { map.setView([userPos.lat, userPos.lon], 15); toast('No hay fuentes con estos filtros.'); return; }

  const radius = Math.max(near.dist * 1.25, MIN_RADIUS);
  radiusCircle = L.circle([userPos.lat, userPos.lon], {
    radius, color: '#1f7fe0', weight: 1.5, dashArray: '6 6', opacity: .5, fillOpacity: .04
  }).addTo(map);
  map.fitBounds(radiusCircle.getBounds(), { padding: [50, 50], maxZoom: 18 });
  toast(`Fuente más cercana: ${fmtDist(near.dist)}`);
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
  if (u === 'MIXTO') return ['MIXTO', 'Personas y mascotas'];
  if (u === 'MASCOTAS') return ['MASCOTAS', 'Para mascotas'];
  if (u === 'PERSONAS') return ['PERSONAS', 'Para personas'];
  return ['MIXTO', 'Uso no especificado'];
}

function openSheet(f) {
  selected = f;
  const p = f.props;
  const addr = [p.DIRECCION, p.DIRECCION_AUX].filter(Boolean).join(' · ');
  $('sName').textContent = p.BARRIO ? `Fuente · ${p.BARRIO}` : 'Fuente de agua';
  $('sAddr').textContent = [addr, p.DISTRITO].filter(Boolean).join(' — ');

  const [usoKey, usoTxt] = usoLabel(p.USO);
  const operative = isOperative(f);
  const chips = [];
  chips.push(`<span class="chip dist">${pinSvg()} ${fmtDist(f.dist)}</span>`);
  chips.push(`<span class="chip">${USO_ICON[usoKey] || ''} ${usoTxt}</span>`);
  chips.push(`<span class="chip ${operative ? 'ok' : 'bad'}">${operative ? checkSvg() : crossSvg()} ${operative ? 'Operativa' : titleCase(p.ESTADO || 'Sin servicio')}</span>`);
  $('sChips').innerHTML = chips.join('');
  $('sheet').classList.add('open');
}
function updateSheetDistance() {
  if (!selected) return;
  const el = $('sChips').querySelector('.chip.dist');
  if (el) el.innerHTML = `${pinSvg()} ${fmtDist(selected.dist)}`;
}
function pinSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>'; }
function checkSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'; }
function crossSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; }

$('sheetClose').addEventListener('click', () => { $('sheet').classList.remove('open'); selected = null; });

/* ---------- Walking route (opens map app) ---------- */
$('btnRoute').addEventListener('click', () => {
  if (!selected || !userPos) return;
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
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') toast('Necesito permiso de orientación para la brújula.');
    }
  } catch (_) {}

  try {
    arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) { toast('No se pudo abrir la cámara. Revisa los permisos.'); return; }

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
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (typeof e.alpha === 'number') h = 360 - e.alpha;
  if (h != null) {
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

/* ============================================================
   UI wiring (filtros) + BOOT
   ============================================================ */
$('count').addEventListener('click', openFilters);
$('filterClose').addEventListener('click', closeFilters);
$('filterApply').addEventListener('click', closeFilters);
$('fOper').addEventListener('change', onFilterChange);
$('fUso').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    $('fUso').querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    onFilterChange();
  }));

window.addEventListener('orientationchange', () => { if (map) setTimeout(() => map.invalidateSize(), 300); });

(async function boot() {
  try { await ensureData(); }
  catch (e) { $('updatedText').textContent = 'No se pudo cargar la base de datos.'; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
