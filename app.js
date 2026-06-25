/* ============================================================
   Fuentes de Madrid — localizador de agua para beber
   Datos: Ayuntamiento de Madrid (CC BY 4.0)
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const APP_VERSION = '1.10.0';
const FAV_KEY = 'fuentes_favs_v1';
const TARGET_KEY = 'fuentes_target_v1';
const INFO_URL = 'https://datos.madrid.es/dataset/300051-0-fuentes';
const MARKER_CAP = 350;          // máx. marcadores dibujados a la vez (rendimiento)
const MIN_RADIUS = 70;           // m: evita sobre-acercar si la fuente está pegada
const HEADING_SMOOTH = 0.07;     // suavizado de la brújula en AR (más bajo = más lento pero ignora saltos)
const HEADING_JUMP = 100;        // grados: cambio brusco = ruido del sensor → lo amortiguamos

/* ---------- State ---------- */
let map, userMarker, accCircle, fountainLayer;
let allFountains = [];
let fountains = [];
const shown = new Set();
let renderedNearest = null;
let userPos = null;
let geoWatchId = null;
let selected = null;
let dataUpdated = Date.now();
const filters = { operativeOnly: true, uso: 'todas', favOnly: false };

/* favoritas (persisten en el navegador) */
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch (_) {}
function favKey(f) { return f.lat.toFixed(5) + ',' + f.lon.toFixed(5); }
function isFav(f) { return favs.has(favKey(f)); }
function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch (_) {} }
function toggleFav(f) {
  const k = favKey(f);
  if (favs.has(k)) favs.delete(k); else favs.add(k);
  saveFavs();
  return favs.has(k);
}

/* ============================================================
   AJUSTES (tema, tema de mapa, import/export) — persistentes
   ============================================================ */
const SETTINGS_KEY = 'fuentes_settings_v1';
let settings = { theme: 'system', map: 'voyager', accent: 'blue' };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} }

const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> &middot; ' +
               '<a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> &middot; ' +
               '<a href="' + INFO_URL + '" target="_blank" rel="noopener">Ayto. de Madrid</a>';
const MAP_TILES = {
  voyager:  { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', sub: 'abcd' },
  osm:      { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc' },
  positron: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', sub: 'abcd' },
  dark:     { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', sub: 'abcd' }
};
let tileLayer = null;
let ACCENT = '#1f7fe0', ACCENT_L = '#3ea8ff';
const ACCENTS = {
  blue:   { main: '#1f7fe0', d: '#1668bd', l: '#3ea8ff' },
  teal:   { main: '#0ca7a0', d: '#0a847e', l: '#2bc9c2' },
  green:  { main: '#2faa4e', d: '#24863d', l: '#46c969' },
  purple: { main: '#7c5cff', d: '#6442e6', l: '#9a82ff' },
  red:    { main: '#e23b4e', d: '#c02438', l: '#f06070' },
  orange: { main: '#f08a1d', d: '#cf6f0c', l: '#ffa84a' }
};

function isDark() {
  const t = settings.theme;
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const dark = isDark();
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1620' : ACCENT);
  applyMapTheme();   // el mapa sigue al tema: en oscuro, mapa oscuro
}
function applyMapTheme() {
  if (!map) return;
  const key = isDark() ? 'dark' : settings.map;          // tema oscuro → siempre mapa oscuro
  const t = MAP_TILES[key] || MAP_TILES.voyager;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(t.url, { attribution: ATTRIB, subdomains: t.sub, maxZoom: 20, detectRetina: true });
  tileLayer.addTo(map); tileLayer.setZIndex(0);
}
function applyAccent() {
  const a = ACCENTS[settings.accent] || ACCENTS.blue;
  ACCENT = a.main; ACCENT_L = a.l;
  const s = document.documentElement.style;
  s.setProperty('--blue', a.main); s.setProperty('--blue-d', a.d); s.setProperty('--blue-l', a.l);
  if (!isDark()) { const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', a.main); }
  if (map) {
    for (const f of shown) if (f.marker) f.marker.setIcon(f === selected ? nearestIcon(f) : fountainIcon(f));
    if (userMarker) userMarker.setIcon(userIcon());
  }
}
/* refresca el tema del sistema en vivo si está en modo "sistema" */
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); }); } catch (_) {}

function exportData() {
  const data = { v: 1, favs: [...favs], settings: settings, target: (function () { try { return localStorage.getItem(TARGET_KEY) || ''; } catch (_) { return ''; } })() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'fuentes-madrid-config.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Configuración exportada');
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (Array.isArray(d.favs)) { favs = new Set(d.favs); saveFavs(); }
      if (d.settings && typeof d.settings === 'object') { settings = Object.assign(settings, d.settings); saveSettings(); applyTheme(); applyMapTheme(); }
      if (typeof d.target === 'string') { try { localStorage.setItem(TARGET_KEY, d.target); } catch (_) {} }
      if (map) { for (const f of shown) if (f.marker) f.marker.setIcon(f === selected ? nearestIcon(f) : fountainIcon(f)); applyFilters(); renderMarkers(); }
      syncSettingsUI();
      toast('Configuración importada ✓');
    } catch (e) { toast('Ese archivo no es válido'); }
  };
  r.readAsText(file);
}
function syncSettingsUI() {
  const st = $('setTheme'), sm = $('setMap'), sa = $('setAccent');
  if (st) st.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.theme === settings.theme));
  if (sm) sm.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.map === settings.map));
  if (sa) sa.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.accent === settings.accent));
}

applyAccent();   // color de acento (variables CSS)
applyTheme();    // tema cuanto antes (evita parpadeo)

/* orientación del mapa */
let mapMode = 'north';           // north | free
let programmaticBearing = false;

/* AR */
let arHeading = null;            // brújula suavizada (deg)
let arPitch = null;              // inclinación del móvil suavizada (0 plano … 90 vertical)

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
function smoothAngle(cur, target, alpha) {
  if (cur == null) return target;
  let d = ((target - cur + 540) % 360) - 180;   // diferencia más corta
  return (cur + alpha * d + 360) % 360;
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
function toast(msg, ms = 2400) {
  const t = $('toast'); t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================================================
   DATA: dataset local fuentes.json (CC BY 4.0, reproyectado)
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
  setUpdated(dataUpdated, allFountains.filter(isOperative).length);
  return allFountains;
}
function makeFountain(f) { return { lat: f.lat, lon: f.lon, props: f.props, marker: null, dist: null }; }
function isOperative(f) { return (f.props.ESTADO || '').toUpperCase() === 'OPERATIVO'; }
function isDog(f) { const u = (f.props.USO || '').toUpperCase(); return u === 'MASCOTAS' || u === 'MIXTO'; }

function setUpdated(ms, n) {
  const d = new Date(ms);
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: '2-digit' });
  if ($('updatedText')) $('updatedText').textContent = `Datos actualizados: ${fmt} · ${n} fuentes`;
}

/* ============================================================
   ARRANQUE: salta la splash si ya hay permiso de ubicación
   ============================================================ */
async function autoStartIfAllowed() {
  let granted = false;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      granted = st.state === 'granted';
    }
  } catch (_) {}

  if (!granted) { $('loading').style.display = 'none'; $('splash').style.display = 'flex'; return; }

  // permiso ya concedido → directo al mapa, sin pedir nada
  navigator.geolocation.getCurrentPosition(
    (pos) => { userPos = posToObj(pos); startApp(); },
    () => { $('loading').style.display = 'none'; $('splash').style.display = 'flex'; },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

$('askLocation').addEventListener('click', requestLocation);
function requestLocation() {
  if (!('geolocation' in navigator)) { $('splashErr').textContent = 'Tu navegador no permite geolocalización.'; return; }
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
function posToObj(pos) { return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }; }

async function startApp() {
  try { if (!allFountains.length) await ensureData(); }
  catch (e) {
    $('loading').style.display = 'none';
    $('splash').style.display = 'flex';
    $('askLocation').disabled = false;
    $('askLocation').innerHTML = 'Reintentar';
    $('splashErr').textContent = 'No se pudieron cargar las fuentes. Recarga la página e inténtalo de nuevo.';
    return;
  }
  $('loading').style.display = 'none';
  $('splash').style.display = 'none';
  $('app').style.display = 'flex';
  initMap();
  watchPosition();
}

/* ---------- Panel "Acerca de" (al tocar el título) ---------- */
$('aboutBtn').addEventListener('click', () => $('about').classList.add('open'));
$('aboutClose').addEventListener('click', () => $('about').classList.remove('open'));

/* ============================================================
   FILTERS
   ============================================================ */
function matchesFilter(f) {
  if (filters.favOnly && !isFav(f)) return false;
  if (filters.operativeOnly && !isOperative(f)) return false;
  const u = (f.props.USO || '').toUpperCase();
  if (filters.uso === 'personas' && !(u === 'PERSONAS' || u === 'MIXTO')) return false;
  if (filters.uso === 'perros' && !(u === 'MASCOTAS' || u === 'MIXTO')) return false;
  return true;
}
function applyFilters() {
  fountains = allFountains.filter(matchesFilter);
  recomputeDistances();
  if ($('countN')) $('countN').textContent = `${fountains.length}`;
  if ($('filterCount')) $('filterCount').textContent = fountains.length;
}
function readFilterUI() {
  filters.operativeOnly = $('fOper').checked;
  filters.favOnly = $('fFav').checked;
  const active = $('fUso').querySelector('button.active');
  filters.uso = active ? active.dataset.uso : 'todas';
}
function onFilterChange() { readFilterUI(); applyFilters(); renderMarkers(); }
function openFilters() {
  $('fOper').checked = filters.operativeOnly;
  $('fFav').checked = filters.favOnly;
  $('fUso').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.uso === filters.uso));
  $('filterCount').textContent = fountains.length;
  $('filterSheet').classList.add('open');
}
function closeFilters() { $('filterSheet').classList.remove('open'); fitInitialView(); }

/* ============================================================
   MAP
   ============================================================ */
function userIcon() {
  return L.divIcon({
    className: '', iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="user-dot"><svg width="30" height="30" viewBox="0 0 30 30">
      <circle cx="15" cy="15" r="14" fill="${ACCENT}" fill-opacity="0.18"/>
      <circle cx="15" cy="15" r="7.5" fill="${ACCENT}" stroke="#fff" stroke-width="3.2"/></svg></div>`
  });
}
function dropSvg(w, h, color, inner) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 34 42">
      <path d="M17 1 C17 1 4 15 4 25 a13 13 0 0 0 26 0 C30 15 17 1 17 1 Z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      ${inner}</svg>`;
}
const DROP_PLAIN = `<path d="M17 12 c-3 4 -5 6.5 -5 9 a5 5 0 0 0 10 0 c0 -2.5 -2 -5 -5 -9 z" fill="#fff"/>`;
function pawInner(color) {
  return `<circle cx="17" cy="24" r="8.4" fill="#fff"/>
    <g fill="${color}">
      <ellipse cx="17" cy="27.2" rx="3.1" ry="2.5"/>
      <circle cx="12.6" cy="24" r="1.5"/>
      <circle cx="15.2" cy="21.4" r="1.6"/>
      <circle cx="18.8" cy="21.4" r="1.6"/>
      <circle cx="21.4" cy="24" r="1.5"/>
    </g>`;
}
const HEART_INNER = `<path d="M17 29 c-4.6 -3.6 -7.4 -6.1 -7.4 -9.4 a3.6 3.6 0 0 1 7.4 -1.4 a3.6 3.6 0 0 1 7.4 1.4 c0 3.3 -2.8 5.8 -7.4 9.4 z" fill="#fff"/>`;
function fountainIcon(f) {
  const off = !isOperative(f);
  let color, inner;
  if (isFav(f)) { color = off ? '#7fb6c0' : '#00bcd4'; inner = HEART_INNER; }       // favorita: gota cian con corazón
  else { color = off ? '#9aa7b6' : ACCENT; inner = isDog(f) ? pawInner(color) : DROP_PLAIN; }
  return L.divIcon({
    className: '', iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -38],
    html: `<div class="fountain-pin${off ? ' off' : ''}">${dropSvg(34, 42, color, inner)}</div>`
  });
}
function nearestIcon(f) {
  const inner = isFav(f) ? HEART_INNER : (isDog(f) ? pawInner(ACCENT) : DROP_PLAIN);   // la seleccionada también muestra corazón si es favorita
  return L.divIcon({
    className: '', iconSize: [46, 57], iconAnchor: [23, 53], popupAnchor: [0, -50],
    html: `<div class="fountain-pin nearest-pin">${dropSvg(46, 57, ACCENT_L, inner)}</div>`
  });
}

function initMap() {
  map = L.map('map', {
    zoomControl: true, attributionControl: true,
    rotate: true, touchRotate: true, shiftKeyRotate: true, rotateControl: false, bearing: 0
  }).setView([userPos.lat, userPos.lon], 16);

  applyMapTheme();   // capa de teselas según el tema de mapa elegido en ajustes
  if (map.attributionControl) map.attributionControl.setPrefix(false);

  userMarker = L.marker([userPos.lat, userPos.lon], { icon: userIcon(), zIndexOffset: 1000 })
               .addTo(map).bindTooltip('Estás aquí', { direction: 'top', offset: [0, -12] });
  accCircle = L.circle([userPos.lat, userPos.lon], {
    radius: userPos.acc || 30, color: '#1f7fe0', weight: 1, opacity: .3, fillOpacity: .08
  }).addTo(map);

  fountainLayer = L.layerGroup().addTo(map);
  applyFilters();

  map.on('moveend zoomend', debounce(renderMarkers, 90));
  map.on('rotate', onMapRotate);
  map.on('rotateend', updateModeButton);
  map.on('click', () => { closeSheet(); $('filterSheet').classList.remove('open'); });   // tocar fuera cierra los paneles

  $('recenter').addEventListener('click', () => { if (userPos) map.setView([userPos.lat, userPos.lon], 16, { animate: true }); });
  $('mapMode').addEventListener('click', onModeButton);
  $('fitBtn').addEventListener('click', fitUserAndFountain);

  restoreTarget();   // recupera la última fuente seleccionada (persistente)
  requestAnimationFrame(() => { map.invalidateSize(); fitInitialView(); renderMarkers(); updateModeButton(); updateFitBtn(); });
}

/* ---------- marcadores: solo lo visible, con tope ---------- */
function iconFor(f) { return f === selected ? nearestIcon(f) : fountainIcon(f); }   // nearestIcon = gota viva + parpadeo (ahora marca la seleccionada)
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
  if (selected && fountains.indexOf(selected) !== -1 && inView.indexOf(selected) === -1) inView.push(selected); // la seleccionada siempre visible
  const need = new Set(inView);
  for (const f of Array.from(shown)) {
    if (!need.has(f)) { if (f.marker) fountainLayer.removeLayer(f.marker); f.marker = null; shown.delete(f); }
  }
  for (const f of inView) {
    if (!f.marker) {
      f.marker = L.marker([f.lat, f.lon], { icon: iconFor(f) }).on('click', () => openSheet(f));
      if (f === selected) f.marker.setZIndexOffset(700);
      fountainLayer.addLayer(f.marker); shown.add(f);
    }
  }
}

/* fuente seleccionada = destino resaltado y persistente entre sesiones */
function setTarget(f) {
  const prev = selected;
  selected = f;
  try { localStorage.setItem(TARGET_KEY, f ? favKey(f) : ''); } catch (_) {}
  if (prev && prev !== f && prev.marker) { prev.marker.setIcon(fountainIcon(prev)); prev.marker.setZIndexOffset(0); }
  renderMarkers();
  if (f && f.marker) { f.marker.setIcon(nearestIcon(f)); f.marker.setZIndexOffset(700); }
  updateFitBtn();
}
function restoreTarget() {
  let key = null;
  try { key = localStorage.getItem(TARGET_KEY); } catch (_) {}
  if (!key) return;
  const f = allFountains.find((x) => favKey(x) === key);
  if (f) selected = f;
}

function recomputeDistances() {
  if (!userPos) return;
  for (const f of fountains) f.dist = haversine(userPos.lat, userPos.lon, f.lat, f.lon);
  fountains.sort((a, b) => a.dist - b.dist);
}
function nearest() { return fountains.length ? fountains[0] : null; }

function fitInitialView() {
  if (!userPos || !map) return;
  const near = nearest();
  if (!near) { map.setView([userPos.lat, userPos.lon], 15); toast('No hay fuentes con estos filtros.'); return; }
  const radius = Math.max(near.dist * 1.25, MIN_RADIUS);
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos(toRad(userPos.lat)));
  const bounds = L.latLngBounds([userPos.lat - dLat, userPos.lon - dLon], [userPos.lat + dLat, userPos.lon + dLon]);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
  toast(`Fuente más cercana: ${fmtDist(near.dist)}`);
}

/* ============================================================
   ORIENTACIÓN DEL MAPA — Norte arriba / Libre
   ============================================================ */
function setBearingSafe(deg) {
  if (!map || !map.setBearing) return;
  programmaticBearing = true;
  map.setBearing(deg);
  setTimeout(() => { programmaticBearing = false; }, 80);
}
function setMode(m) {
  mapMode = m;
  if (m === 'north') { setBearingSafe(0); toast('Norte arriba'); }
  updateModeButton();
}
function onModeButton() { setMode('north'); }   // el botón SOLO activa Norte arriba (si ya lo está, no hace nada visible)
function onMapRotate() {
  if (!programmaticBearing && mapMode !== 'free') { mapMode = 'free'; toast('Modo libre'); }   // girar a mano = modo libre
  updateModeButton();
}
function updateModeButton() {
  const btn = $('mapMode'); if (!btn) return;
  const brg = (map && map.getBearing) ? map.getBearing() : 0;
  const needle = btn.querySelector('.needle');
  if (needle) needle.style.transform = `rotate(${-brg}deg)`;   // la aguja indica la orientación; el botón nunca se resalta
}

/* ============================================================
   BOTÓN "ENCUADRAR" — ajusta la vista (una sola vez al pulsar)
   para ver mi posición Y la fuente seleccionada. Solo visible
   cuando hay una fuente seleccionada.
   ============================================================ */
function updateFitBtn() {
  const b = $('fitBtn'); if (b) b.style.display = selected ? 'flex' : 'none';
}
function fitZoom() {
  const dist = haversine(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const h = (map.getSize && map.getSize().y) || 500;
  const mpp = Math.max(dist, 40) / (h * 0.58);     // la distancia ocupa ~0.58 de la altura
  const z = Math.log2(156543.03 * Math.cos(toRad(userPos.lat)) / mpp);
  return Math.max(13, Math.min(18, z));
}
function fitUserAndFountain() {
  if (!userPos || !selected || !map) return;
  const z = fitZoom();
  // 1) me centro y fijo el zoom (quedo en el centro de la pantalla)
  map.setView([userPos.lat, userPos.lon], z, { animate: false });
  // 2) roto UNA vez para poner la fuente arriba: mido el ángulo en pantalla y giro lo justo
  if (map.setBearing && map.getBearing) {
    const ang = () => {
      const u = map.latLngToContainerPoint([userPos.lat, userPos.lon]);
      const f = map.latLngToContainerPoint([selected.lat, selected.lon]);
      return Math.atan2(f.y - u.y, f.x - u.x) * 180 / Math.PI;
    };
    const a0 = ang(), b0 = map.getBearing();
    map.setBearing(b0 + 20); let d = ang() - a0; map.setBearing(b0);   // detecta el sentido de giro
    d = ((d + 540) % 360) - 180; const k = d >= 0 ? 1 : -1;
    programmaticBearing = true;
    let err = -90 - ang(); err = ((err + 540) % 360) - 180;            // -90 = arriba
    map.setBearing(map.getBearing() + err / k);
    setTimeout(() => { programmaticBearing = false; }, 150);
    mapMode = 'free';
  }
  // 3) bajo la vista: quedo abajo-centro y la fuente sube, quedando arriba-centro
  const size = map.getSize();
  const newCenter = map.containerPointToLatLng([size.x / 2, size.y * 0.20]);
  map.setView(newCenter, z, { animate: false });
  updateModeButton();
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
      if (selected && $('sheet').classList.contains('open')) updateSheetDistance();
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
  MASCOTAS: '<svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="15.5" rx="3.4" ry="2.7"/><circle cx="7.2" cy="11.5" r="1.7"/><circle cx="10.1" cy="8.6" r="1.8"/><circle cx="13.9" cy="8.6" r="1.8"/><circle cx="16.8" cy="11.5" r="1.7"/></svg>',
  MIXTO: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="18" cy="14" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="12.5" r="1.4" fill="currentColor" stroke="none"/></svg>'
};
function usoLabel(u) {
  u = (u || '').toUpperCase();
  if (u === 'MIXTO') return ['MIXTO', 'Personas y perros'];
  if (u === 'MASCOTAS') return ['MASCOTAS', 'Para perros'];
  if (u === 'PERSONAS') return ['PERSONAS', 'Para personas'];
  return ['MIXTO', 'Uso no especificado'];
}
function openSheet(f) {
  setTarget(f);
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
  updateFavBtn();
  $('sheet').classList.add('open');
}
function updateFavBtn() {
  if (!selected) return;
  const on = isFav(selected);
  $('favBtn').classList.toggle('on', on);
  $('favBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
}
function updateSheetDistance() {
  if (!selected) return;
  const el = $('sChips').querySelector('.chip.dist');
  if (el) el.innerHTML = `${pinSvg()} ${fmtDist(selected.dist)}`;
}
function pinSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>'; }
function checkSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'; }
function crossSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; }

function closeSheet() { $('sheet').classList.remove('open'); }   // mantiene la selección (el resaltado persiste)
$('sheetClose').addEventListener('click', closeSheet);

/* arrastrar la ficha hacia abajo para cerrarla (y de paso bloquea el pull-to-refresh) */
(function enableSheetDrag() {
  const el = $('sheet'); let startY = null, dy = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    startY = e.touches[0].clientY; dy = 0; el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0) { el.style.transform = `translateY(${dy}px)`; e.preventDefault(); }
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (startY == null) return;
    el.style.transition = ''; el.style.transform = '';
    if (dy > 90) closeSheet();
    startY = null; dy = 0;
  });
})();

$('favBtn').addEventListener('click', () => {
  if (!selected) return;
  toggleFav(selected);
  updateFavBtn();
  if (selected.marker) selected.marker.setIcon(nearestIcon(selected));   // sigue siendo la seleccionada (resaltada) + corazón
  if (filters.favOnly) { applyFilters(); renderMarkers(); }
});

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
   AR MODE (cámara + flecha de brújula suavizada)
   ============================================================ */
let arStream = null;
$('btnAR').addEventListener('click', startAR);
$('arClose').addEventListener('click', stopAR);

async function startAR() {
  if (!selected) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Tu navegador no permite usar la cámara para AR.'); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
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
  arHeading = null; arPitch = null;
  startCompass();
  updateAR();
}
function stopAR() {
  $('ar').style.display = 'none';
  $('arTarget').style.display = 'none';
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
  if (typeof e.beta === 'number') {
    const p = Math.max(0, Math.min(90, e.beta));        // 0 plano (mira al suelo) … 90 vertical
    arPitch = (arPitch == null) ? p : arPitch + 0.10 * (p - arPitch);
  }
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (typeof e.alpha === 'number') h = 360 - e.alpha;
  if (h != null) {
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const raw = (h + so + 360) % 360;
    let alpha = HEADING_SMOOTH;
    if (arHeading != null) {
      const delta = Math.abs(((raw - arHeading + 540) % 360) - 180);
      if (delta > HEADING_JUMP) alpha = HEADING_SMOOTH * 0.2;   // salto brusco → casi lo ignoramos (anti-glitch)
    }
    arHeading = smoothAngle(arHeading, raw, alpha);            // filtro de paso bajo
  }
  updateAR();
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
    hintEl.textContent = arHeading == null ? 'Mueve el móvil en forma de 8 para calibrar la brújula'
                       : (arPitch != null && arPitch > 45 ? 'Sigue el icono o la flecha' : 'Levanta el móvil para ver la fuente');
  }
  // diferencia más corta entre el rumbo a la fuente y hacia dónde apuntas (−180..180, 0 = de frente)
  const offset = arHeading == null ? 0 : (((brg - arHeading + 540) % 360) - 180);
  // inclinación del móvil: 0 plano → flecha cenital ; 1 vertical → flecha tumbada en 3D
  const tilt = arPitch == null ? 0 : Math.max(0, Math.min(1, (arPitch - 8) / (78 - 8)));
  $('arArrow').style.transform = `rotateX(${tilt * 70}deg) rotateZ(${offset}deg)`;

  // icono del destino flotando sobre la cámara (cuando levantas el móvil y está en el campo de visión)
  const tgt = $('arTarget');
  if (tilt > 0.45 && Math.abs(offset) < 60) {
    const x = 50 + (offset / 60) * 42;
    tgt.style.left = Math.max(6, Math.min(94, x)) + '%';
    $('arTargetDist').textContent = fmtDist(dist);
    tgt.style.display = 'flex';
  } else {
    tgt.style.display = 'none';
  }
}

/* ============================================================
   UI wiring + BOOT
   ============================================================ */
if ($('appVersion')) $('appVersion').textContent = 'v' + APP_VERSION;
if ($('aboutVersion')) $('aboutVersion').textContent = 'v' + APP_VERSION;

async function forceUpdate(ev) {
  if (ev) ev.preventDefault();
  toast('Actualizando…');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (self.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
  } catch (_) {}
  location.replace(location.pathname + '?u=' + Date.now());
}
if ($('forceUpdate')) $('forceUpdate').addEventListener('click', forceUpdate);

$('count').addEventListener('click', openFilters);
$('filterClose').addEventListener('click', closeFilters);
$('filterApply').addEventListener('click', closeFilters);
$('fOper').addEventListener('change', onFilterChange);
$('fFav').addEventListener('change', onFilterChange);
$('fUso').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  $('fUso').querySelectorAll('button').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); onFilterChange();
}));

/* ---- Ajustes ---- */
$('settingsBtn').addEventListener('click', () => { syncSettingsUI(); $('settings').classList.add('open'); });
$('settingsClose').addEventListener('click', () => $('settings').classList.remove('open'));
$('setTheme').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.theme = b.dataset.theme; saveSettings(); applyTheme(); syncSettingsUI();
}));
$('setMap').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.map = b.dataset.map; saveSettings(); applyMapTheme(); syncSettingsUI();
}));
$('setAccent').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.accent = b.dataset.accent; saveSettings(); applyAccent(); syncSettingsUI();
}));
$('exportBtn').addEventListener('click', exportData);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

window.addEventListener('orientationchange', () => { if (map) setTimeout(() => map.invalidateSize(), 300); });

(async function boot() {
  try { await ensureData(); }
  catch (e) { setUpdated(Date.now(), 0); if ($('updatedText')) $('updatedText').textContent = 'No se pudo cargar la base de datos.'; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  autoStartIfAllowed();
})();
