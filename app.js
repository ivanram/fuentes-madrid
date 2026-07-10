/* ============================================================
   Fuentes de Madrid — localizador de agua para beber
   Datos: Ayuntamiento de Madrid (CC BY 4.0)
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const APP_VERSION = '1.12.26';
const FAV_KEY = 'fuentes_favs_v1';
const TARGET_KEY = 'fuentes_target_v1';
const SHEET_OPEN_KEY = 'fuentes_sheet_open_v1';
const VISITS_KEY = 'fuentes_visits_v1';
const LAST_ACTIVE_KEY = 'fuentes_last_active_v1';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;   // más de esto sin usarla = sesión nueva: sin selección ni vista previas
const VIEW_KEY = 'fuentes_view_v1';
const FILTERS_KEY = 'fuentes_filters_v1';
const DEV_UNLOCKED_KEY = 'fuentes_dev_unlocked_v1';
const DEV_FAKELOC_KEY = 'fuentes_dev_fakeloc_v1';
const INFO_URL = 'https://datos.madrid.es/dataset/300051-0-fuentes';
const MARKER_CAP = 350;          // máx. marcadores dibujados a la vez (rendimiento)
const MIN_RADIUS = 70;           // m: evita sobre-acercar si la fuente está pegada
const HEADING_SMOOTH = 0.16;     // suavizado de la brújula en AR (más bajo = más lento pero ignora saltos)
const HEADING_JUMP = 100;        // grados: cambio brusco = ruido del sensor → lo amortiguamos
const TRAIL_MIN_DIST = 14;       // m entre puntos de la estela: separados, como un rastro de peli, no un churro
const MAP_HEADING_SMOOTH = 0.045; // suavizado del modo brújula del mapa: prioriza calma sobre precisión
const MAP_BEARING_THROTTLE = 200; // ms mínimos entre giros del mapa en modo brújula (evita trabajo de más)
const OUTSIDE_MADRID_KM = 20;     // si la fuente más cercana está más lejos que esto, probablemente no estás en Madrid
const MADRID_SOL = { lat: 40.4168, lon: -3.7038 };

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
try { Object.assign(filters, JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}')); } catch (_) {}
function saveFilters() { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch (_) {} }

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

/* fuentes visitadas: nº de veces + fecha de la última, guardado en el móvil */
const VISIT_RADIUS_M = 15;             // hay que estar a menos de esto para que cuente como visita
const VISIT_COOLDOWN_MS = 30 * 60 * 1000;   // no cuentes otra visita si sigues junto a la misma fuente
let visits = {};
try { visits = JSON.parse(localStorage.getItem(VISITS_KEY) || '{}'); } catch (_) {}
function saveVisits() { try { localStorage.setItem(VISITS_KEY, JSON.stringify(visits)); } catch (_) {} }
function checkVisits() {
  const now = Date.now();
  let changed = false;
  for (const f of fountains) {   // `fountains` va ordenado por cercanía: en cuanto nos pasamos del radio, ya no hay más
    if (f.dist == null || f.dist > VISIT_RADIUS_M) break;
    const key = favKey(f);
    const v = visits[key];
    if (!v || (now - v.last) > VISIT_COOLDOWN_MS) {
      visits[key] = { count: (v ? v.count : 0) + 1, last: now };
      changed = true;
    }
  }
  if (changed) {
    saveVisits();
    if (selected && $('sheet').classList.contains('open')) renderVisitInfo(selected);
  }
}

/* ============================================================
   AJUSTES (tema, tema de mapa, import/export) — persistentes
   ============================================================ */
const SETTINGS_KEY = 'fuentes_settings_v1';
let settings = { theme: 'system', map: 'moderno', accent: 'blue', trailOn: true, trailLen: 5, lang: 'auto' };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} }

/* ============================================================
   IDIOMA (es / en) — automático según el navegador, o elegido
   ============================================================ */
/* Las cadenas viven en archivos languages/<código>.json (ver loadLanguages()).
   Aquí solo queda el estado en memoria una vez cargadas. */
let I18N = {};
let LANG_META = {};   // código -> { name: 'Español' }
async function loadLanguages() {
  try {
    const manifest = await fetch('languages/manifest.json', { cache: 'no-cache' }).then(r => r.json());
    const codes = Array.isArray(manifest.available) ? manifest.available : [];
    await Promise.all(codes.map(async (code) => {
      try {
        const data = await fetch(`languages/${code}.json`, { cache: 'no-cache' }).then(r => r.json());
        if (data && data.strings) { I18N[code] = data.strings; LANG_META[code] = data.meta || { name: code }; }
      } catch (_) { /* ese idioma en concreto no cargó: seguimos con los demás */ }
    }));
  } catch (_) { /* sin manifiesto (sin red la primera vez, etc.): nos quedamos con el texto estático del HTML */ }
}
function getLang() {
  // 'es'/'en' explícitos, o cualquier otro código ya elegido en el desplegable "Otros"
  if (settings.lang && settings.lang !== 'auto' && I18N[settings.lang]) return settings.lang;
  const nav = (navigator.language || 'es').toLowerCase().slice(0, 2);
  if (I18N[nav]) return nav;
  return I18N.es ? 'es' : (Object.keys(I18N)[0] || 'es');
}
function t(k) { const L = getLang(); return (I18N[L] && I18N[L][k]) || (I18N.es && I18N.es[k]) || k; }
const RTL_LANGS = ['ar'];
function applyI18n() {
  const L = getLang();
  if (!I18N[L]) return;   // aún no ha cargado ningún idioma: se queda el texto estático del HTML
  document.documentElement.setAttribute('lang', L);
  document.documentElement.dir = RTL_LANGS.includes(L) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (I18N[L][k] != null) { if (/[<&]/.test(I18N[L][k])) el.innerHTML = I18N[L][k]; else el.textContent = I18N[L][k]; }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (I18N[L][k] != null) el.title = I18N[L][k];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (I18N[L][k] != null) el.placeholder = I18N[L][k];
  });
}

const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> &middot; ' +
               '<a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> &middot; ' +
               '<a href="' + INFO_URL + '" target="_blank" rel="noopener">Ayto. de Madrid</a>';
/* TILES, MAP_THEMES y ACCENTS viven ahora en themes.js (cargado antes que app.js) */
let tileLayer = null;
let ACCENT = '#1f7fe0', ACCENT_L = '#3ea8ff';

function isDark() {
  const t = settings.theme;
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const dark = isDark();
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', ACCENT);   // la barra de estado sigue al acento (como la cabecera)
  applyMapTheme();   // el mapa sigue al tema: en oscuro, mapa oscuro
}
function applyMapTheme() {
  if (!map) return;
  const theme = MAP_THEMES[settings.map] || MAP_THEMES.moderno;
  const cfg = isDark() ? theme.dark : theme.light;                  // claro u oscuro según el tema de la app
  const tile = TILES[cfg.t] || TILES.voyager;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(tile.url, {
    attribution: ATTRIB, subdomains: tile.sub, maxZoom: 20, detectRetina: true,
    keepBuffer: 6   // más colchón de teselas precargadas alrededor: al girar en modo brújula, las esquinas nuevas ya suelen estar ahí
  });
  tileLayer.addTo(map); tileLayer.setZIndex(0);
  const el = tileLayer.getContainer && tileLayer.getContainer();
  if (el) el.style.filter = cfg.f || '';                            // filtro CSS (+ duotone SVG para cyberpunk)
  prefetchedTiles.clear();   // nuevo estilo de mapa: las claves anteriores ya no valen (URLs distintas)
}

/* ============================================================
   PRECACHE de teselas: cuando el mapa se queda quieto, pedimos también
   las teselas justo fuera de la pantalla (un anillo alrededor) para que
   ya estén en la caché del navegador si el usuario sigue moviéndose hacia
   ahí. Solo se dispara cuando el mapa se ESTABILIZA (moveend/zoomend con
   debounce), así que un barrido rápido no dispara descargas de más.
   ============================================================ */
const PREFETCH_RING = 5;          // teselas de margen a cada lado del encuadre visible
const PREFETCH_MAX_KEYS = 2000;   // evita que el Set crezca sin límite en sesiones muy largas
const prefetchedTiles = new Set();
function prefetchTileRing() {
  if (!map || !tileLayer || mapMode === 'compass') return;   // en modo brújula el encuadre gira constantemente: no merece la pena
  const z = Math.round(map.getZoom());
  const bounds = map.getBounds();
  const nw = map.project(bounds.getNorthWest(), z).divideBy(256).floor();
  const se = map.project(bounds.getSouthEast(), z).divideBy(256).floor();
  const maxTile = Math.pow(2, z);
  if (prefetchedTiles.size > PREFETCH_MAX_KEYS) prefetchedTiles.clear();
  for (let x = nw.x - PREFETCH_RING; x <= se.x + PREFETCH_RING; x++) {
    if (x < 0 || x >= maxTile) continue;
    for (let y = nw.y - PREFETCH_RING; y <= se.y + PREFETCH_RING; y++) {
      if (y < 0 || y >= maxTile) continue;
      const key = `${z}/${x}/${y}`;
      if (prefetchedTiles.has(key)) continue;
      prefetchedTiles.add(key);
      new Image().src = tileLayer.getTileUrl({ x, y, z });
    }
  }
}
function applyAccent() {
  const a = ACCENTS[settings.accent] || ACCENTS.blue;
  ACCENT = a.main; ACCENT_L = a.l;
  const s = document.documentElement.style;
  s.setProperty('--blue', a.main); s.setProperty('--blue-d', a.d); s.setProperty('--blue-l', a.l);
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', a.main);
  if (map) { for (const f of shown) if (f.marker) f.marker.setIcon(f === selected ? nearestIcon(f) : fountainIcon(f)); renderTrail(); }
}

/* ---- Estela de ubicación (rastro de puntos que se difuminan) ---- */
let trail = [];
let trailLayer = null;
let trailTimer = null;
let lastTrailPos = null;
function trailMax() { return Math.max(3, Math.min(10, parseInt(settings.trailLen, 10) || 5)); }
function clearTrailLayer() { trail = []; lastTrailPos = null; if (trailLayer) trailLayer.clearLayers(); }
function startTrail() {
  if (!map) return;
  if (!trailLayer) trailLayer = L.layerGroup().addTo(map);
  if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
  if (!settings.trailOn) { clearTrailLayer(); return; }
  trailTimer = setInterval(sampleTrail, 4000);   // comprobamos cada 4 s; quien manda es la distancia mínima
}
function sampleTrail() {
  if (!settings.trailOn || !userPos || !map) return;
  if (lastTrailPos && haversine(lastTrailPos.lat, lastTrailPos.lon, userPos.lat, userPos.lon) < TRAIL_MIN_DIST) return;   // no te has alejado lo suficiente
  trail.unshift({ lat: userPos.lat, lon: userPos.lon });
  lastTrailPos = { lat: userPos.lat, lon: userPos.lon };
  if (trail.length > trailMax()) trail.length = trailMax();
  renderTrail();
}
function renderTrail() {
  if (!trailLayer) return;
  trailLayer.clearLayers();
  if (!settings.trailOn) return;
  const n = trail.length;
  for (let i = 0; i < n; i++) {
    const op = 1 - i / (n + 0.6);                 // el punto más reciente es el más opaco
    L.circleMarker([trail[i].lat, trail[i].lon], {
      radius: 5, color: '#fff', weight: 1.4, opacity: op * 0.9, fillColor: ACCENT, fillOpacity: op
    }).addTo(trailLayer);
  }
}

/* refresca el tema del sistema en vivo si está en modo "sistema" */
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); }); } catch (_) {}

function exportData() {
  const data = {
    v: 2, favs: [...favs], settings: settings, visits: visits,
    target: (function () { try { return localStorage.getItem(TARGET_KEY) || ''; } catch (_) { return ''; } })()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'fuentes-madrid-config.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(t('exported'));
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (Array.isArray(d.favs)) { favs = new Set(d.favs); saveFavs(); }
      if (d.settings && typeof d.settings === 'object') { settings = Object.assign(settings, d.settings); saveSettings(); applyTheme(); applyMapTheme(); }
      if (d.visits && typeof d.visits === 'object') { visits = d.visits; saveVisits(); }
      if (typeof d.target === 'string') { try { localStorage.setItem(TARGET_KEY, d.target); } catch (_) {} }
      if (map) { for (const f of shown) if (f.marker) f.marker.setIcon(f === selected ? nearestIcon(f) : fountainIcon(f)); applyFilters(); renderMarkers(); }
      syncSettingsUI();
      toast(t('imported'));
    } catch (e) { toast(t('bad_file')); }
  };
  r.readAsText(file);
}
/* El desplegable "Otros" se rellena con todo lo que haya en el manifiesto de
   idiomas salvo es/en (que ya tienen su propio botón). */
function populateOtherLanguages() {
  const sel = $('setLangOther'); if (!sel) return;
  const others = Object.keys(I18N).filter(c => c !== 'es' && c !== 'en').sort();
  sel.innerHTML = '<option value="" disabled></option>' +
    others.map(c => `<option value="${c}">${(LANG_META[c] && LANG_META[c].name) || c}</option>`).join('');
}
/* true justo tras pulsar "Otros": muestra el desplegable sin cambiar aún el idioma activo */
let otherPickerOpen = false;
function syncSettingsUI() {
  const st = $('setTheme'), sm = $('setMap'), sa = $('setAccent'), sl = $('setLang'), slOther = $('setLangOther');
  if (st) st.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.theme === settings.theme));
  if (sm) sm.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.map === settings.map));
  if (sa) sa.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.accent === settings.accent));
  if (sl) {
    const resolved = getLang();
    const isOtherActive = resolved !== 'es' && resolved !== 'en';
    const group = isOtherActive || otherPickerOpen ? 'other' : resolved;
    sl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.lang === group));
    if (slOther) {
      const ph = slOther.querySelector('option[value=""]');
      if (ph) ph.textContent = t('lang_placeholder');
      slOther.style.display = group === 'other' ? 'block' : 'none';
      if (group === 'other') slOther.value = isOtherActive ? resolved : '';
    }
  }
  if ($('fTrail')) $('fTrail').checked = !!settings.trailOn;
  if ($('fTrailLen')) $('fTrailLen').value = trailMax();
  if ($('trailLenVal')) $('trailLenVal').textContent = trailMax();
  if ($('trailLenRow')) $('trailLenRow').style.display = settings.trailOn ? '' : 'none';
}

applyI18n();     // idioma (es/en)
applyAccent();   // color de acento (variables CSS)
applyTheme();    // tema cuanto antes (evita parpadeo)

/* orientación del mapa */
let mapMode = 'north';           // north | free | compass
let programmaticBearing = false;
let mapHeading = null;           // brújula suavizada para el modo brújula del mapa (deg)
let lastMapBearingUpdate = 0;
let lastTileRefresh = 0;
let headingConeEl = null;        // "foco" de orientación sobre el punto azul (como Google Maps)

/* AR */
let arHeading = null;            // brújula suavizada (deg)
let arPitch = null;              // inclinación del móvil suavizada (0 plano … 90 vertical)
let arArrivedVibrated = false;   // para vibrar solo una vez al llegar, no en cada frame

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
function fmtWalkMin(m) {
  if (m == null) return '';
  const min = Math.round(m / 80);   // ritmo de paseo, ~80 m/min
  return min < 1 ? '<1 min' : `${min} min`;
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

let _statusState = null;
function setUpdated(ms, n) {
  _statusState = { error: false, ms, n };
  renderStatus();
}
function setUpdatedError() {
  _statusState = { error: true };
  renderStatus();
}
function renderStatus() {
  if (!_statusState || !$('updatedText')) return;
  if (_statusState.error) { $('updatedText').textContent = t('db_error'); return; }
  const d = new Date(_statusState.ms);
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: '2-digit' });
  $('updatedText').textContent = `${t('data_updated')}: ${fmt} · ${_statusState.n} ${t('f_fountains')}`;
}

/* ============================================================
   ARRANQUE: salta la splash si ya hay permiso de ubicación
   ============================================================ */
/* ?fakeloc=lat,lon — para probar la app (p.ej. el aviso de "fuera de Madrid")
   sin moverte de sitio ni tocar la ubicación real del móvil. Solo de pruebas. */
function fakeLocationFromUrl() {
  const m = location.search.match(/[?&]fakeloc=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon, acc: 20 };
}
/* Igual que fakeloc por URL, pero puesta desde el modo desarrollador (persiste
   entre sesiones sin tener que tocar la URL — necesario en la app instalada). */
function fakeLocationFromDev() {
  try {
    const d = JSON.parse(localStorage.getItem(DEV_FAKELOC_KEY) || 'null');
    if (d && isFinite(d.lat) && isFinite(d.lon)) return { lat: d.lat, lon: d.lon, acc: 20 };
  } catch (_) {}
  return null;
}
function getFakeLocation() { return fakeLocationFromUrl() || fakeLocationFromDev(); }
async function autoStartIfAllowed() {
  const fake = getFakeLocation();
  if (fake) { userPos = fake; startApp(); return; }
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
  const fake = getFakeLocation();
  if (fake) { userPos = fake; startApp(); return; }
  if (!('geolocation' in navigator)) { $('splashErr').textContent = t('no_geo'); return; }
  const btn = $('askLocation');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${t('searching')}`;
  $('splashErr').textContent = '';
  navigator.geolocation.getCurrentPosition(
    (pos) => { userPos = posToObj(pos); startApp(); },
    (err) => {
      btn.disabled = false;
      btn.textContent = t('btn_allow');
      $('splashErr').textContent = err.code === 1 ? t('err_denied') : t('err_locate');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}
function posToObj(pos) { return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }; }

/* ---------- ¿sesión nueva o "seguimos donde lo dejamos"? ---------- */
function isFreshSession() {
  let last = null;
  try { last = parseInt(localStorage.getItem(LAST_ACTIVE_KEY), 10); } catch (_) {}
  if (!last || isNaN(last)) return true;   // primera vez, o nunca se guardó
  return (Date.now() - last) > SESSION_TIMEOUT_MS;
}
function markActive() { try { localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now())); } catch (_) {} }
document.addEventListener('visibilitychange', () => { if (document.hidden) markActive(); });
window.addEventListener('pagehide', markActive);
setInterval(() => { if (!document.hidden) markActive(); }, 60000);   // colchón si el proceso muere sin avisar
let freshSession = true;

async function startApp() {
  freshSession = isFreshSession();
  try { if (!allFountains.length) await ensureData(); }
  catch (e) {
    $('loading').style.display = 'none';
    $('splash').style.display = 'flex';
    $('askLocation').disabled = false;
    $('askLocation').textContent = t('retry');
    $('splashErr').textContent = t('err_load');
    return;
  }
  $('loading').style.display = 'none';
  $('splash').style.display = 'none';
  $('app').style.display = 'flex';
  initMap();
  watchPosition();
  checkOutsideMadrid();
}

/* ---------- Aviso "fuera de Madrid" ---------- */
function nearestDistanceKm(lat, lon) {
  let best = Infinity;
  for (const f of allFountains) { const d = haversine(lat, lon, f.lat, f.lon); if (d < best) best = d; }
  return best / 1000;
}
function checkOutsideMadrid() {
  if (!userPos || !allFountains.length) return;
  if (nearestDistanceKm(userPos.lat, userPos.lon) > OUTSIDE_MADRID_KM) $('outsideModal').style.display = 'flex';
}
$('teleportBtn').addEventListener('click', () => {
  userPos = { lat: MADRID_SOL.lat, lon: MADRID_SOL.lon, acc: 20 };
  $('outsideModal').style.display = 'none';
  if (userMarker) userMarker.setLatLng([userPos.lat, userPos.lon]);
  if (accCircle) { accCircle.setLatLng([userPos.lat, userPos.lon]); accCircle.setRadius(userPos.acc); }
  lastRecomputePos = null;
  recomputeDistances();
  renderMarkers();
  fitInitialView();
});
$('outsideDismiss').addEventListener('click', () => {
  $('outsideModal').style.display = 'none';
  // Movemos solo la VISTA a Madrid (tu ubicación real no cambia, así que
  // rutas/distancias seguirán sin tener sentido): si no, el mapa se queda
  // centrado en tu posición real y cae directo en el aviso de "demasiado
  // lejos" del propio mapa, un segundo aviso redundante tras este mismo.
  if (map) map.setView([MADRID_SOL.lat, MADRID_SOL.lon], 13, { animate: false });
});

/* ---------- Panel "Acerca de" (al tocar el título) ---------- */
$('aboutBtn').addEventListener('click', () => { closeSheet(); $('about').classList.add('open'); checkForUpdate(); });
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
  if ($('emptyState')) $('emptyState').style.display = fountains.length ? 'none' : 'flex';
}
if ($('emptyClearBtn')) $('emptyClearBtn').addEventListener('click', () => {
  filters.operativeOnly = true; filters.favOnly = false; filters.uso = 'todas';   // vuelve al filtro de fábrica, no a "todo sin filtrar"
  saveFilters(); applyFilters(); renderMarkers(); fitInitialView();
});
function readFilterUI() {
  filters.operativeOnly = $('fOper').checked;
  filters.favOnly = $('fFav').checked;
  const active = $('fUso').querySelector('button.active');
  filters.uso = active ? active.dataset.uso : 'todas';
  saveFilters();
}
function onFilterChange() { readFilterUI(); applyFilters(); renderMarkers(); }
function openFilters() {
  closeSheet();
  $('fOper').checked = filters.operativeOnly;
  $('fFav').checked = filters.favOnly;
  $('fUso').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.uso === filters.uso));
  $('filterCount').textContent = fountains.length;
  $('filterSheet').classList.add('open');
}
function closeFilters() { $('filterSheet').classList.remove('open'); fitInitialView(); }
function toggleFilters() { if ($('filterSheet').classList.contains('open')) closeFilters(); else openFilters(); }

/* ============================================================
   LIST (fuentes cercanas, ordenadas por distancia)
   ============================================================ */
const LIST_CAP = 200;   // suficiente para "cercanas"; más allá no aporta y castiga el render
function rowIcon(f) { return isFav(f) ? '❤️' : (isDog(f) ? '🐾' : '💧'); }
function normalizeSearch(s) { return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase(); }
let listQuery = '';
function renderListItems() {
  const wrap = $('listItems');
  const q = normalizeSearch(listQuery);
  const list = q
    ? fountains.filter(f => normalizeSearch([f.props.DIRECCION, f.props.BARRIO, f.props.DISTRITO].join(' ')).includes(q))
    : fountains;
  if (!list.length) { wrap.innerHTML = `<p class="list-empty">${t('list_empty')}</p>`; return; }
  wrap.innerHTML = list.slice(0, LIST_CAP).map((f) => {
    const p = f.props;
    const addr = [p.DIRECCION, p.DISTRITO].filter(Boolean).join(' — ') || t('fountain_water');
    return `<button class="list-row" data-k="${favKey(f)}">
      <span class="list-ico">${rowIcon(f)}</span>
      <span class="list-txt"><span class="list-name">${addr}</span></span>
      <span class="list-dist">${fmtDist(f.dist)}</span>
    </button>`;
  }).join('');
}
function openList() {
  closeSheet();
  listQuery = '';
  if ($('listSearch')) $('listSearch').value = '';
  renderListItems();
  $('listSheet').classList.add('open');
}
function closeList() { $('listSheet').classList.remove('open'); }
function toggleList() { if ($('listSheet').classList.contains('open')) closeList(); else openList(); }
$('listBtn').addEventListener('click', toggleList);
$('listClose').addEventListener('click', closeList);
if ($('listSearch')) $('listSearch').addEventListener('input', () => { listQuery = $('listSearch').value; renderListItems(); });
$('listItems').addEventListener('click', (e) => {
  const btn = e.target.closest('.list-row'); if (!btn) return;
  const f = fountains.find(x => favKey(x) === btn.dataset.k);
  if (!f) return;
  closeList();
  map.setView([f.lat, f.lon], 17, { animate: true });
  openSheet(f);
});

/* ============================================================
   MAP
   ============================================================ */
function userIcon() {
  return L.divIcon({
    className: '', iconSize: [130, 130], iconAnchor: [65, 65],
    html: `<div class="user-dot-wrap">
      <div class="heading-cone">
        <svg width="130" height="130" viewBox="0 0 130 130">
          <defs>
            <linearGradient id="coneGrad" x1="65" y1="65" x2="65" y2="5" gradientUnits="userSpaceOnUse">
              <stop offset="0%" style="stop-color:var(--blue);stop-opacity:.5"/>
              <stop offset="100%" style="stop-color:var(--blue);stop-opacity:0"/>
            </linearGradient>
          </defs>
          <path d="M65 65 L31 16 A60 60 0 0 1 99 16 Z" fill="url(#coneGrad)"/>
        </svg>
      </div>
      <svg width="30" height="30" viewBox="0 0 30 30" class="user-core">
        <circle cx="15" cy="15" r="14" style="fill:var(--blue)" fill-opacity="0.18"/>
        <circle cx="15" cy="15" r="7.5" style="fill:var(--blue)" stroke="#fff" stroke-width="3.2"/>
      </svg>
    </div>`
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
  calibrateBearingSign();   // una vez, para saber traducir rumbo real ⇄ giro en pantalla

  userMarker = L.marker([userPos.lat, userPos.lon], { icon: userIcon(), zIndexOffset: 1000, interactive: false })
               .addTo(map).bindTooltip('Estás aquí', { direction: 'top', offset: [0, -12] });
  const umEl = userMarker.getElement();
  headingConeEl = umEl && umEl.querySelector('.heading-cone');
  acquireCompass();   // brújula siempre activa mientras el mapa está abierto: para el "foco" de orientación
  accCircle = L.circle([userPos.lat, userPos.lon], {
    radius: userPos.acc || 30, color: '#1f7fe0', weight: 1, opacity: .3, fillOpacity: .08
  }).addTo(map);

  fountainLayer = L.layerGroup().addTo(map);
  applyFilters();

  map.on('moveend zoomend', debounce(renderMarkers, 90));
  map.on('moveend zoomend', debounce(saveView, 400));   // recuerda dónde estabas mirando, por si la app se recarga
  map.on('moveend zoomend', updateRecenterState);
  map.on('moveend zoomend', debounce(prefetchTileRing, 150));   // solo cuando el mapa se para: precarga el anillo de teselas de alrededor
  map.on('move', updateFarOverlay);
  map.on('rotate', onMapRotate);
  map.on('rotateend', updateModeButton);
  map.on('click', () => { closeSheet(); $('filterSheet').classList.remove('open'); closeList(); });   // tocar fuera cierra los paneles

  $('recenter').addEventListener('click', recenterToUser);
  $('farBackBtn').addEventListener('click', recenterToUser);
  $('mapMode').addEventListener('click', onModeButton);
  $('fitBtn').addEventListener('click', fitUserAndFountain);

  startTrail();      // estela de ubicación
  // Solo recuperamos selección/vista si venimos de una sesión reciente (<30 min).
  // Si ha pasado más, o es la primera vez, empezamos limpios: sin fuente
  // seleccionada y centrados en tu ubicación real.
  if (!freshSession) restoreTarget();
  requestAnimationFrame(() => {
    map.invalidateSize();
    // Prioridad al volver a abrir la app: enlace compartido > ficha que tenías
    // abierta > vista donde te quedaste > vista inicial por defecto.
    const resumed = !freshSession && (restoreSheetIfWasOpen() || restoreSavedView());
    if (!openSharedFountainIfAny() && !resumed) fitInitialView();
    renderMarkers(); updateModeButton(); updateFitBtn(); updateRecenterState(); updateFarOverlay();
  });
}

/* ---------- recordar dónde estabas al volver a abrir la app ---------- */
function saveView() {
  if (!map) return;
  const c = map.getCenter();
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() })); } catch (_) {}
}
function restoreSheetIfWasOpen() {
  let wasOpen = null;
  try { wasOpen = localStorage.getItem(SHEET_OPEN_KEY); } catch (_) {}
  if (wasOpen !== '1' || !selected) return false;
  map.setView([selected.lat, selected.lon], Math.max(map.getZoom(), 17), { animate: false });
  openSheet(selected);
  return true;
}
function restoreSavedView() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch (_) {}
  if (!v || typeof v.lat !== 'number' || typeof v.lon !== 'number') return false;
  map.setView([v.lat, v.lon], v.zoom || 16, { animate: false });
  return true;
}

/* ---------- abrir una fuente compartida por enlace (?f=lat,lon) ---------- */
function openSharedFountainIfAny() {
  const m = location.search.match(/[?&]f=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!m) return false;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lon)) return false;
  let best = null, bestD = Infinity;
  for (const f of allFountains) {
    const d = haversine(lat, lon, f.lat, f.lon);
    if (d < bestD) { bestD = d; best = f; }
  }
  if (!best || bestD > 30) return false;   // 30 m de margen por redondeo del enlace
  map.setView([best.lat, best.lon], 18, { animate: false });
  openSheet(best);
  return true;
}

/* ---------- marcadores: solo lo visible, con tope ---------- */
function iconFor(f) { return f === selected ? nearestIcon(f) : fountainIcon(f); }   // nearestIcon = gota viva + parpadeo (ahora marca la seleccionada)
/* Tamaño de celda (px) para fusionar marcadores: si varias fuentes caen en la
   misma celda de pantalla, solo se muestra una. Al hacer zoom las celdas se
   separan y reaparecen todas. Transparente: sin clic para desagrupar. */
const CLUSTER_CELL = 44;

function renderMarkers() {
  if (!map || !fountainLayer) return;
  const b = map.getBounds().pad(0.2);
  const z = map.getZoom();
  const seen = new Set();
  let inView = [];
  // `fountains` va ordenado por cercanía a ti → la representante de cada celda es la más cercana.
  for (const f of fountains) {
    if (!b.contains([f.lat, f.lon])) continue;
    if (f === selected) continue; // la seleccionada se añade aparte, siempre visible
    const p = map.project([f.lat, f.lon], z);
    const key = ((p.x / CLUSTER_CELL) | 0) + ':' + ((p.y / CLUSTER_CELL) | 0);
    if (seen.has(key)) continue; // celda ya ocupada → se fusiona
    seen.add(key);
    inView.push(f);
  }
  if (inView.length > MARKER_CAP) inView.length = MARKER_CAP; // tope de seguridad
  if (selected && fountains.indexOf(selected) !== -1) inView.push(selected); // la seleccionada siempre visible
  const need = new Set(inView);
  for (const f of Array.from(shown)) {
    if (!need.has(f)) { if (f.marker) fountainLayer.removeLayer(f.marker); f.marker = null; shown.delete(f); }
  }
  for (const f of inView) {
    if (!f.marker) {
      f.marker = L.marker([f.lat, f.lon], { icon: iconFor(f) }).on('click', () => handleMarkerClick(f));
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
  checkVisits();
}
function nearest() { return fountains.length ? fountains[0] : null; }

function fitInitialView() {
  if (!userPos || !map) return;
  const near = nearest();
  if (!near) { map.setView([userPos.lat, userPos.lon], 15); return; }   // el estado vacío ya lo explica, sin toast redundante
  const radius = Math.max(near.dist * 1.25, MIN_RADIUS);
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos(toRad(userPos.lat)));
  const bounds = L.latLngBounds([userPos.lat - dLat, userPos.lon - dLon], [userPos.lat + dLat, userPos.lon + dLon]);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
  toast(`${t('nearest')}: ${fmtDist(near.dist)}`);
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
/* Modo brújula: el mapa gira sobre la marcha para que "arriba" sea hacia donde
   apunta el móvil (como la navegación turn-by-turn). leaflet-rotate no documenta
   si su bearing crece en el mismo sentido que el rumbo geográfico, así que lo
   calibramos una vez girando un poco y midiendo el efecto (mismo truco que ya
   usaba fitUserAndFountain para acertar el sentido de giro). */
let mapBearingSign = null;
function calibrateBearingSign() {
  if (!map || !map.setBearing || !map.getBearing) { mapBearingSign = 1; return; }
  const c = map.getCenter();
  const topBearing = () => {
    const p = map.latLngToContainerPoint(c);
    const g = map.containerPointToLatLng({ x: p.x, y: p.y - 100 });
    return bearing(c.lat, c.lng, g.lat, g.lng);   // rumbo geográfico de "arriba" en pantalla
  };
  programmaticBearing = true;
  const b0 = map.getBearing(), a0 = topBearing();
  map.setBearing(b0 + 20);
  const a1 = topBearing();
  map.setBearing(b0);
  programmaticBearing = false;
  const d = ((a1 - a0 + 540) % 360) - 180;
  mapBearingSign = d >= 0 ? 1 : -1;
}
function setMapModeInternal(m) {
  if (mapMode === 'compass' && m !== 'compass') releaseCompass();
  if (mapMode !== 'compass' && m === 'compass') { if (mapBearingSign == null) calibrateBearingSign(); mapHeading = null; acquireCompass(); }
  mapMode = m;
}
function setMode(m) {
  setMapModeInternal(m);
  if (m === 'north') { setBearingSafe(0); toast(t('north')); }
  else if (m === 'compass') {
    // el modo brújula gira el mapa alrededor de su centro: si no estamos centrados
    // en nuestra posición al activarlo, el giro hace que el punto azul "vuele" por
    // la pantalla en vez de quedarse fijo.
    if (userPos && map) map.setView([userPos.lat, userPos.lon], map.getZoom(), { animate: true });
    toast(t('compass_mode'));
  }
  updateModeButton();
}
function onModeButton() { setMode(mapMode === 'compass' ? 'north' : 'compass'); }   // alterna Norte arriba ⇄ Brújula
function onMapRotate() {
  if (!programmaticBearing && mapMode !== 'free') { setMapModeInternal('free'); toast(t('free')); }   // girar a mano = modo libre
  updateModeButton();
}
function updateModeButton() {
  const btn = $('mapMode'); if (!btn) return;
  const brg = (map && map.getBearing) ? map.getBearing() : 0;
  const needle = btn.querySelector('.needle');
  if (needle) needle.style.transform = `rotate(${-brg}deg)`;   // la aguja indica la orientación
  btn.classList.toggle('active', mapMode === 'compass');
  updateHeadingCone();
}
/* invita a pulsar "centrar" cuando tu posición real ha quedado fuera (o casi)
   del encuadre visible — típicamente al volver a la app tras andar un rato */
const RECENTER_EDGE_MARGIN = 50;   // px: a menos de esto del borde ya cuenta como "casi fuera"
function updateRecenterState() {
  const btn = $('recenter'); if (!btn || !map || !userPos) return;
  const p = map.latLngToContainerPoint([userPos.lat, userPos.lon]);
  const size = map.getSize();
  const offCenter = p.x < RECENTER_EDGE_MARGIN || p.y < RECENTER_EDGE_MARGIN
                 || p.x > size.x - RECENTER_EDGE_MARGIN || p.y > size.y - RECENTER_EDGE_MARGIN;
  btn.classList.toggle('attention', offCenter);
}
function recenterToUser() {
  if (!userPos || !map) return;
  map.setView([userPos.lat, userPos.lon], 16, { animate: true });
  updateRecenterState();
}
/* Oscurece la pantalla según te alejas del área con fuentes; a partir de
   FAR_DARK_FULL_KM se queda en negro y ofrece "Volver" (= botón de centrar). */
const FAR_DARK_START_KM = 5;
const FAR_DARK_FULL_KM = 60;
function updateFarOverlay() {
  const overlay = $('farOverlay'); if (!overlay || !map || !allFountains.length) return;
  const c = map.getCenter();
  const km = nearestDistanceKm(c.lat, c.lng);
  const ratio = Math.max(0, Math.min(1, (km - FAR_DARK_START_KM) / (FAR_DARK_FULL_KM - FAR_DARK_START_KM)));
  overlay.style.opacity = ratio;
  overlay.classList.toggle('blackout', ratio >= 1);
}
/* "Foco" de orientación sobre el punto azul: hacia dónde apunta el móvil,
   relativo a lo que ahora mismo es "arriba" en pantalla (que cambia si el
   mapa está girado, en modo brújula o girado a mano). */
let coneHeading = null;              // rumbo del foco, suavizado igual de calmado que el modo brújula
let coneRotationDeg = 0;              // ángulo REAL aplicado al CSS, sin envolver a 0-360
function updateHeadingCone() {
  if (!headingConeEl) return;
  if (arHeading == null) { headingConeEl.classList.remove('show'); return; }
  // Mismo suavizado calmado que usa el modo brújula del mapa (antes usaba el
  // rumbo "rápido" del AR, que temblaba mucho más que el mapa).
  coneHeading = smoothAngle(coneHeading, arHeading, MAP_HEADING_SMOOTH);
  const brg = (map && map.getBearing) ? map.getBearing() : 0;
  const screenUp = (mapBearingSign || 1) * brg;
  const target = ((coneHeading - screenUp) % 360 + 360) % 360;   // objetivo, 0-360
  // Avanzamos desde el ángulo YA aplicado por el camino más corto, sin envolver:
  // si aplicáramos "target" tal cual, al cruzar 0/360 el CSS interpola el número
  // en bruto y el foco daría una vuelta entera de más antes de asentarse.
  const delta = ((target - coneRotationDeg) % 360 + 540) % 360 - 180;
  coneRotationDeg += delta;
  headingConeEl.style.transform = `rotate(${coneRotationDeg}deg)`;
  headingConeEl.classList.add('show');
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
  const mpp = Math.max(dist, 40) / (h * 0.50);     // distancia ~0.50 de la altura: deja margen arriba para la gota
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
    setMapModeInternal('free');
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
let lastRecomputePos = null;
function watchPosition() {
  if (getFakeLocation()) return;   // ubicación simulada: no la pisamos con el GPS real
  if (geoWatchId != null) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userPos = posToObj(pos);
      if (userMarker) userMarker.setLatLng([userPos.lat, userPos.lon]);
      if (accCircle) { accCircle.setLatLng([userPos.lat, userPos.lon]); accCircle.setRadius(userPos.acc || 30); }
      // en modo brújula seguimos centrados en todo momento: si no, cada giro deja
      // el punto azul en un sitio distinto de la pantalla (ver setMode).
      if (mapMode === 'compass' && map) map.setView([userPos.lat, userPos.lon], map.getZoom(), { animate: false });
      // el GPS reporta ruido de pocos metros aunque estés parado: si apenas te has
      // movido, no merece la pena recalcular y reordenar todas las distancias.
      if (!lastRecomputePos || haversine(lastRecomputePos.lat, lastRecomputePos.lon, userPos.lat, userPos.lon) >= 3) {
        lastRecomputePos = { lat: userPos.lat, lon: userPos.lon };
        recomputeDistances();
      }
      if (selected && $('sheet').classList.contains('open')) updateSheetDistance();
      if ($('ar').style.display === 'block') updateAR();
      updateRecenterState();
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
  if (u === 'MIXTO') return ['MIXTO', t('use_both')];
  if (u === 'MASCOTAS') return ['MASCOTAS', t('use_dogs')];
  if (u === 'PERSONAS') return ['PERSONAS', t('use_people')];
  return ['MIXTO', t('use_unknown')];
}
function openSheet(f) {
  setTarget(f);
  const p = f.props;
  const addr = [p.DIRECCION, p.DIRECCION_AUX].filter(Boolean).join(' · ');
  $('sName').textContent = p.BARRIO ? `${t('fountain')} · ${p.BARRIO}` : t('fountain_water');
  $('sAddr').textContent = [addr, p.DISTRITO].filter(Boolean).join(' — ');
  const rawUso = (p.USO || '').toUpperCase();
  const operative = isOperative(f);
  const chips = [];
  chips.push(`<span class="chip dist">${pinSvg()} ${fmtDist(f.dist)} · ${fmtWalkMin(f.dist)}</span>`);
  // Solo mostramos el chip de uso/estado cuando dice algo que no sea "lo normal":
  // la mayoría no tiene uso especificado, y con el filtro por defecto casi todas
  // están operativas — mostrarlo siempre en cada ficha era puro ruido repetido.
  if (rawUso === 'PERSONAS' || rawUso === 'MASCOTAS' || rawUso === 'MIXTO') {
    const [usoKey, usoTxt] = usoLabel(p.USO);
    chips.push(`<span class="chip">${USO_ICON[usoKey] || ''} ${usoTxt}</span>`);
  }
  if (!operative) {
    chips.push(`<span class="chip bad">${crossSvg()} ${p.ESTADO ? titleCase(p.ESTADO) : t('out_service')}</span>`);
  }
  $('sChips').innerHTML = chips.join('');
  renderVisitInfo(f);
  updateFavBtn();
  $('sheet').classList.add('open');
  try { localStorage.setItem(SHEET_OPEN_KEY, '1'); } catch (_) {}
}
function renderVisitInfo(f) {
  const el = $('sVisits'); if (!el) return;
  const v = visits[favKey(f)];
  if (!v) { el.textContent = ''; el.style.display = 'none'; return; }
  const d = new Date(v.last).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  el.textContent = (v.count === 1 ? t('visit_once') : t('visit_many').replace('{n}', v.count)) + ' ' + d;
  el.style.display = 'block';
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
  if (el) el.innerHTML = `${pinSvg()} ${fmtDist(selected.dist)} · ${fmtWalkMin(selected.dist)}`;
}
function pinSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>'; }
function checkSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'; }
function crossSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; }

function closeSheet() {
  $('sheet').classList.remove('open');   // mantiene la selección (el resaltado persiste)
  try { localStorage.setItem(SHEET_OPEN_KEY, '0'); } catch (_) {}
}
$('sheetClose').addEventListener('click', closeSheet);

/* tocar la fuente ya seleccionada la deselecciona y cierra su ficha */
function handleMarkerClick(f) {
  if (selected === f) { closeSheet(); setTarget(null); }
  else openSheet(f);
}

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
    if (dy > 0) { el.style.transform = (window.innerWidth >= 760 ? 'translateX(-50%) ' : '') + `translateY(${dy}px)`; e.preventDefault(); }
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

$('shareBtn').addEventListener('click', async () => {
  if (!selected) return;
  const p = selected.props;
  const addr = [p.DIRECCION, p.DIRECCION_AUX].filter(Boolean).join(' · ');
  const url = `${location.origin}${location.pathname}?f=${selected.lat.toFixed(5)},${selected.lon.toFixed(5)}`;
  const text = [t('share_msg'), addr].filter(Boolean).join(' — ');
  if (navigator.share) {
    try { await navigator.share({ title: t('share_msg'), text, url }); } catch (_) {}   // el usuario cancela → no hacemos nada
  } else {
    try { await navigator.clipboard.writeText(url); toast(t('share_copied')); }
    catch (_) { toast(url); }
  }
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
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(t('ar_cam_no')); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') toast(t('ar_perm'));
    }
  } catch (_) {}
  try {
    arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) { toast(t('ar_cam_err')); return; }
  $('arVideo').srcObject = arStream;
  $('ar').style.display = 'block';
  $('arName').textContent = $('sName').textContent;
  arHeading = null; arPitch = null; arArrivedVibrated = false;
  acquireCompass();
  updateAR();
}
function stopAR() {
  $('ar').style.display = 'none';
  $('arTarget').style.display = 'none';
  if (arStream) { arStream.getTracks().forEach(t => t.stop()); arStream = null; }
  releaseCompass();
}
/* AR y el modo brújula del mapa comparten el mismo listener de orientación;
   solo lo paramos cuando ninguno de los dos lo necesita ya. */
let compassUsers = 0;
function acquireCompass() { compassUsers++; if (compassUsers === 1) startCompass(); }
function releaseCompass() { compassUsers = Math.max(0, compassUsers - 1); if (compassUsers === 0) stopCompass(); }
let arAbsoluteSeen = false;      // ¿ya nos llegó un rumbo absoluto (real, no relativo al arranque)?
let arFallbackTimer = null;
function startCompass() {
  arAbsoluteSeen = false;
  // Preferimos SIEMPRE el evento absoluto (rumbo real). Si en 300ms no llega ninguno
  // (navegador que no lo soporta, p.ej. iOS Safari), caemos al relativo. Escuchar los
  // dos a la vez desde el principio hacía que compitieran entre sí y la flecha temblara.
  window.addEventListener('deviceorientationabsolute', onOrientAbsolute, true);
  arFallbackTimer = setTimeout(() => {
    if (!arAbsoluteSeen) window.addEventListener('deviceorientation', onOrient, true);
  }, 300);
}
function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrientAbsolute, true);
  window.removeEventListener('deviceorientation', onOrient, true);
  if (arFallbackTimer) { clearTimeout(arFallbackTimer); arFallbackTimer = null; }
  arAbsoluteSeen = false;
}
function onOrientAbsolute(e) { arAbsoluteSeen = true; onOrient(e); }
function onOrient(e) {
  if (typeof e.beta === 'number') {
    const p = Math.max(0, Math.min(90, e.beta));        // 0 plano (mira al suelo) … 90 vertical
    arPitch = (arPitch == null) ? p : arPitch + 0.10 * (p - arPitch);
  }
  let h = null, needsScreenFix = true;
  if (typeof e.webkitCompassHeading === 'number') { h = e.webkitCompassHeading; needsScreenFix = false; }  // iOS: ya viene corregido a la orientación de pantalla actual
  else if (typeof e.alpha === 'number') h = 360 - e.alpha;
  if (h != null) {
    const so = needsScreenFix ? ((screen.orientation && screen.orientation.angle) || window.orientation || 0) : 0;
    const raw = (h + so + 360) % 360;
    let alpha = HEADING_SMOOTH;
    if (arHeading != null) {
      const delta = Math.abs(((raw - arHeading + 540) % 360) - 180);
      if (delta > HEADING_JUMP) alpha = HEADING_SMOOTH * 0.2;   // salto brusco → casi lo ignoramos (anti-glitch)
    }
    arHeading = smoothAngle(arHeading, raw, alpha);            // filtro de paso bajo

    if (mapMode === 'compass') {
      mapHeading = smoothAngle(mapHeading, raw, MAP_HEADING_SMOOTH);   // muy suave: nada de mareos
      const now = Date.now();
      if (now - lastMapBearingUpdate > MAP_BEARING_THROTTLE) {
        lastMapBearingUpdate = now;
        // Recentramos justo antes de cada giro, no solo en cada lectura de GPS: la
        // brújula actualiza mucho más a menudo que el GPS, así que entre una lectura
        // de posición y la siguiente el punto azul podía irse desviando del centro
        // giro a giro hasta que llegaba la próxima corrección de posición.
        if (userPos && map) map.setView([userPos.lat, userPos.lon], map.getZoom(), { animate: false });
        setBearingSafe(mapBearingSign * mapHeading);
      }
      // Al girar sin parar, a leaflet-rotate a veces se le quedan huecos sin
      // teselas en las esquinas que va dejando al descubierto el giro, porque el
      // giro nunca "termina" (invalidateSize no sirve: el contenedor no cambia
      // de tamaño, así que no hace nada). Forzamos directamente al motor de
      // teselas a recalcular qué hace falta para el encuadre actual.
      if (tileLayer && now - lastTileRefresh > 800) {
        lastTileRefresh = now;
        if (typeof tileLayer._update === 'function') tileLayer._update(map.getCenter());
        else if (map) map.invalidateSize({ pan: false });
      }
    }
    updateHeadingCone();
  }
  updateAR();
}
function updateAR() {
  if (!selected || !userPos || $('ar').style.display !== 'block') return;
  const dist = haversine(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const brg = bearing(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const dEl = $('arDist'), hintEl = $('arHint');
  if (dist < 12) {
    dEl.textContent = t('ar_almost'); dEl.classList.add('ar-arrived');
    hintEl.textContent = t('ar_steps');
    if (!arArrivedVibrated) { arArrivedVibrated = true; if (navigator.vibrate) navigator.vibrate([40, 60, 90]); }
  } else {
    dEl.textContent = fmtDist(dist); dEl.classList.remove('ar-arrived');
    hintEl.textContent = arHeading == null ? t('ar_cal')
                       : (arPitch != null && arPitch > 45 ? t('ar_follow') : t('ar_lift'));
    arArrivedVibrated = false;   // te alejas de nuevo → si vuelves a llegar, que vibre otra vez
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
  updateArRadar(tilt);
}

/* ---------- radar: otras fuentes cercanas flotando en la cámara, más
   pequeñas/tenues que la seleccionada, y pulsables para cambiar de destino ---------- */
const AR_RADAR_MAX = 6;        // no saturar la vista de iconos
const AR_RADAR_RANGE_M = 400;  // más lejos que esto ya no aporta en AR
let arRadarEls = [];
function ensureArRadarEls(n) {
  const wrap = $('arRadar'); if (!wrap) return;
  while (arRadarEls.length < n) {
    const div = document.createElement('div');
    div.className = 'ar-radar-pin';
    div.innerHTML = `<svg viewBox="0 0 34 42"><path d="M17 1 C17 1 4 15 4 25 a13 13 0 0 0 26 0 C30 15 17 1 17 1 Z" fill="#8fcdff" stroke="#fff" stroke-width="2"/><path d="M17 12 c-3 4 -5 6.5 -5 9 a5 5 0 0 0 10 0 c0 -2.5 -2 -5 -5 -9 z" fill="#fff"/></svg><span class="ar-radar-d"></span>`;
    wrap.appendChild(div);
    arRadarEls.push(div);
  }
}
function updateArRadar(tilt) {
  const others = fountains.filter(f => f !== selected && f.dist != null && f.dist <= AR_RADAR_RANGE_M).slice(0, AR_RADAR_MAX);
  ensureArRadarEls(others.length);
  arRadarEls.forEach((el, i) => {
    const f = others[i];
    if (!f) { el.style.display = 'none'; return; }
    const brg = bearing(userPos.lat, userPos.lon, f.lat, f.lon);
    const offset = arHeading == null ? 0 : (((brg - arHeading + 540) % 360) - 180);
    if (tilt > 0.4 && Math.abs(offset) < 55) {
      const x = 50 + (offset / 55) * 44;
      el.style.left = Math.max(4, Math.min(96, x)) + '%';
      el.querySelector('.ar-radar-d').textContent = fmtDist(f.dist);
      el.style.display = 'flex';
      el.onclick = () => retargetAR(f);
    } else {
      el.style.display = 'none';
    }
  });
}
function retargetAR(f) {
  setTarget(f);
  $('arName').textContent = f.props.BARRIO ? `${t('fountain')} · ${f.props.BARRIO}` : t('fountain_water');
  arArrivedVibrated = false;
  updateAR();
}

/* ============================================================
   UI wiring + BOOT
   ============================================================ */
if ($('appVersion')) $('appVersion').textContent = 'v' + APP_VERSION;
if ($('aboutVersion')) $('aboutVersion').textContent = 'v' + APP_VERSION;

async function forceUpdate(ev) {
  if (ev) ev.preventDefault();
  toast(t('updating'));
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (self.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    // Lo anterior solo limpia la caché del service worker: la caché HTTP nativa del
    // navegador (GitHub Pages sirve Cache-Control: max-age=600) es independiente y no se
    // toca con eso. Si alguna vez quedó ahí una respuesta vieja para una URL versionada
    // (p.ej. durante el propio despliegue), "recargar" seguía sirviéndola durante minutos
    // y la app se quedaba anunciando la actualización sin instalarla nunca. Forzamos una
    // revalidación real de red (cache:'reload') del documento y de sus scripts/estilos
    // antes de navegar, para que esa caché quede con contenido de verdad fresco.
    const html = await fetch(location.pathname, { cache: 'reload' }).then(r => r.text()).catch(() => null);
    if (html) {
      const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map(m => m[1]);
      await Promise.all(urls.map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
    }
  } catch (_) {}
  location.replace(location.pathname + '?u=' + Date.now());
}
if ($('forceUpdate')) $('forceUpdate').addEventListener('click', forceUpdate);

/* ============================================================
   MODO DESARROLLADOR (oculto) — 5 toques en el ❤️ del pie de Ajustes.
   Sirve para tomar capturas de pantalla con una ubicación simulada (sin
   enseñar dónde vive el usuario) y para reiniciar la app sin datos.
   ============================================================ */
function showDevMode() {
  if ($('devGroup')) $('devGroup').style.display = '';
  syncDevUI();
}
function syncDevUI() {
  const fl = fakeLocationFromDev();
  if ($('devFakeLoc') && fl) $('devFakeLoc').value = `${fl.lat},${fl.lon}`;
  if ($('devFakeLocStatus')) {
    $('devFakeLocStatus').textContent = fl
      ? `Simulando ubicación: ${fl.lat}, ${fl.lon}`
      : 'Usando el GPS real.';
  }
}
let devUnlocked = false;
try { devUnlocked = localStorage.getItem(DEV_UNLOCKED_KEY) === '1'; } catch (_) {}
if (devUnlocked) showDevMode();

let heartTaps = 0, heartTapTimer = null;
// Delegado en document (no en el propio <span>): applyI18n() reemplaza el footer entero
// vía innerHTML al cargar/cambiar de idioma, así que un listener puesto directamente en
// el span original se queda huérfano en cuanto eso pasa una vez.
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#footerHeart')) return;
  heartTaps++;
  clearTimeout(heartTapTimer);
  heartTapTimer = setTimeout(() => { heartTaps = 0; }, 1500);
  if (heartTaps >= 5) {
    heartTaps = 0;
    if (!devUnlocked) {
      devUnlocked = true;
      try { localStorage.setItem(DEV_UNLOCKED_KEY, '1'); } catch (_) {}
      showDevMode();
      toast('🛠️ Modo desarrollador activado');
    }
  }
});
if ($('devFakeLocApply')) $('devFakeLocApply').addEventListener('click', () => {
  const v = ($('devFakeLoc').value || '').trim();
  const m = v.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
  if (!m) { toast('Formato: lat,lon (p.ej. 40.4169,-3.7035)'); return; }
  try { localStorage.setItem(DEV_FAKELOC_KEY, JSON.stringify({ lat: parseFloat(m[1]), lon: parseFloat(m[2]) })); } catch (_) {}
  toast('Ubicación simulada. Recargando…');
  setTimeout(() => location.replace(location.pathname), 500);
});
if ($('devFakeLocClear')) $('devFakeLocClear').addEventListener('click', () => {
  try { localStorage.removeItem(DEV_FAKELOC_KEY); } catch (_) {}
  toast('Volviendo al GPS real. Recargando…');
  setTimeout(() => location.replace(location.pathname), 500);
});
if ($('devWipeBtn')) $('devWipeBtn').addEventListener('click', () => {
  if (!confirm('¿Borrar todos los datos personales (favoritas, ajustes, visitas, filtros...) y empezar de cero? Esto no se puede deshacer.')) return;
  try {
    [FAV_KEY, TARGET_KEY, SHEET_OPEN_KEY, VISITS_KEY, LAST_ACTIVE_KEY, VIEW_KEY, FILTERS_KEY,
     SETTINGS_KEY, DEV_FAKELOC_KEY, DEV_UNLOCKED_KEY, 'fuentes_auto_updated_v']
      .forEach(k => localStorage.removeItem(k));
    sessionStorage.clear();
  } catch (_) {}
  location.replace(location.pathname);
});

/* ---- Comprobar si hay versión nueva publicada (vs. la cacheada) ---- */
let updateAvailable = null;
function reflectUpdate() {
  const b = $('forceUpdate'); if (!b) return;
  if (updateAvailable && updateAvailable !== APP_VERSION) {
    b.classList.add('has-update');
    b.textContent = `${t('update_to')} v${updateAvailable}`;
  } else {
    b.classList.remove('has-update');
    b.innerHTML = `<span id="aboutVersion">v${APP_VERSION}</span>`;
  }
}
function checkForUpdate(auto) {
  fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
    .then(r => (r && r.ok) ? r.json() : null)
    .then(d => {
      if (d && d.version && d.version !== APP_VERSION) {
        updateAvailable = d.version;
        reflectUpdate();
        // Recién abierta la app: actualiza sola en vez de esperar a que el usuario
        // entre en "Acerca de" y toque el botón. Guardamos en localStorage (no
        // sessionStorage) la última versión a la que ya nos auto-actualizamos, para
        // no recargar de nuevo en cada apertura si sigue siendo la misma versión —
        // sessionStorage no sobrevive a que Android mate el proceso en segundo plano,
        // así que con eso la app se recargaba entera cada vez que volvías a ella.
        let already = null;
        try { already = localStorage.getItem('fuentes_auto_updated_v'); } catch (_) {}
        if (auto && already !== d.version) {
          try { localStorage.setItem('fuentes_auto_updated_v', d.version); } catch (_) {}
          forceUpdate();
          return;
        }
        toast(`${t('update_available')} (v${d.version})`);
      }
    })
    .catch(() => {});
}

$('count').addEventListener('click', toggleFilters);
$('filterClose').addEventListener('click', closeFilters);
$('filterApply').addEventListener('click', closeFilters);
$('fOper').addEventListener('change', onFilterChange);
$('fFav').addEventListener('change', onFilterChange);
$('fUso').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  $('fUso').querySelectorAll('button').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); onFilterChange();
}));

/* ---- Ajustes ---- */
$('settingsBtn').addEventListener('click', () => { closeSheet(); otherPickerOpen = false; syncSettingsUI(); $('settings').classList.add('open'); });
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
$('setLang').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.lang === 'other') {
    // Solo mostramos el desplegable: el idioma activo no cambia hasta que
    // el usuario elija uno concreto (si ya había uno "otro" activo, se ve tal cual).
    otherPickerOpen = true;
  } else {
    otherPickerOpen = false;
    settings.lang = b.dataset.lang; saveSettings(); applyI18n(); renderStatus();
  }
  syncSettingsUI();
}));
if ($('setLangOther')) $('setLangOther').addEventListener('change', () => {
  const v = $('setLangOther').value;
  if (!v) return;   // opción de marcador de posición: no hace nada
  settings.lang = v; saveSettings(); applyI18n(); renderStatus(); syncSettingsUI();
});
$('fTrail').addEventListener('change', () => {
  settings.trailOn = $('fTrail').checked; saveSettings();
  if (settings.trailOn) startTrail(); else clearTrailLayer();
  renderTrail(); syncSettingsUI();
});
$('fTrailLen').addEventListener('input', () => {
  settings.trailLen = parseInt($('fTrailLen').value, 10); saveSettings();
  if ($('trailLenVal')) $('trailLenVal').textContent = trailMax();
  if (trail.length > trailMax()) trail.length = trailMax();
  renderTrail();
});
$('exportBtn').addEventListener('click', exportData);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

window.addEventListener('orientationchange', () => { if (map) setTimeout(() => map.invalidateSize(), 300); });

loadLanguages().then(() => {
  applyI18n(); populateOtherLanguages(); syncSettingsUI();   // re-aplica en cuanto los idiomas terminan de cargar
  renderStatus();   // por si setUpdated()/setUpdatedError() se ejecutaron antes de que cargaran los idiomas
});

// Se registra cuanto antes, sin esperar a los datos: algunos auditores (PWABuilder,
// Lighthouse con red simulada lenta) no lo detectan si tarda en llegar tras el fetch.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Google Play no permite donativos a un desarrollador particular por fuera de su
// sistema de pagos: si la app se abre dentro del envoltorio Android (TWA), el
// referrer viene como "android-app://<paquete>". Ocultamos el botón solo ahí;
// en la web/PWA normal sigue visible.
// OJO: ese referrer especial solo llega en el lanzamiento real desde Android —
// si la propia app se recarga a sí misma (p.ej. forceUpdate()), el referrer de
// esa recarga es la propia página y el aviso "TWA" se perdería. Por eso lo
// recordamos en sessionStorage la primera vez que lo vemos.
let isTWA = document.referrer.startsWith('android-app://');
if (isTWA) { try { sessionStorage.setItem('is_twa', '1'); } catch (_) {} }
else { try { isTWA = sessionStorage.getItem('is_twa') === '1'; } catch (_) {} }
if (isTWA && $('donateBtn')) {
  $('donateBtn').style.display = 'none';
}

(async function boot() {
  try { await ensureData(); }
  catch (e) { setUpdatedError(); }
  setTimeout(() => checkForUpdate(true), 600);   // comprueba versión y se actualiza sola si toca
  autoStartIfAllowed();
})();
