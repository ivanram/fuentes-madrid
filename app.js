/* ============================================================
   Fuentes de Madrid — localizador de agua para beber
   Datos: Ayuntamiento de Madrid (CC BY 4.0)
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const APP_VERSION = '1.12.0';
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
let settings = { theme: 'system', map: 'moderno', accent: 'blue', trailOn: true, trailLen: 5, lang: 'auto' };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} }

/* ============================================================
   IDIOMA (es / en) — automático según el navegador, o elegido
   ============================================================ */
const I18N = {
  es: {
    app_short: 'Fuentes', app_full: 'Fuentes de Madrid',
    loading_text: 'Cargando fuentes…', splash_tag: '¿Dónde está la fuente más cercana?',
    splash_desc: 'Encuentra la fuente pública de agua potable más cercana, según los <a href="https://datos.madrid.es/dataset/300051-0-fuentes" target="_blank" rel="noopener">datos oficiales del Ayuntamiento</a>.',
    privacy1: 'La ubicación sólo se usa para ajustar el mapa y no se transmite ni guarda en ningún sitio.',
    privacy2: 'La configuración de fuentes favoritas se guarda de forma local en tu navegador.',
    btn_allow: 'Permitir ubicación', filter_h: 'Filtrar fuentes', settings_h: 'Ajustes',
    route: 'Ruta andando', ar_view: 'Ver con AR', f_estado: 'Estado', f_oper: 'Solo fuentes operativas',
    f_fav: 'Solo favoritas ❤️', f_who: '¿Para quién?', f_all: 'Todas', f_people: 'Personas', f_dogs: 'Perros 🐾',
    f_show: 'Ver', f_fountains: 'fuentes',
    about_desc: 'Datos oficiales del <a href="https://datos.madrid.es/dataset/300051-0-fuentes" target="_blank" rel="noopener">Ayuntamiento de Madrid</a> (CC BY 4.0).',
    set_idioma: 'Idioma', lang_auto: 'Automático', lang_es: 'Español', lang_en: 'Inglés',
    set_tema: 'Tema', set_claro: 'Claro', set_oscuro: 'Oscuro', set_sistema: 'Sistema', set_color: 'Color de acento',
    set_mapa: 'Mapa', map_moderno: 'Moderno', map_clasico: 'Clásico', map_minimalista: 'Minimalista',
    map_cyberpunk: 'Cyberpunk', map_colorido: 'Colorido', map_sepia: 'Sepia',
    set_estela: 'Estela de ubicación', set_estela_on: 'Mostrar el rastro de tu movimiento', set_estela_len: 'Longitud',
    set_datos: 'Datos · favoritas y ajustes', btn_export: 'Exportar', btn_import: 'Importar',
    set_datos_hint: 'Para llevar tu configuración a otro móvil o navegador.',
    footer: 'Creado por Ivan con ❤️ y mucha IA',
    update_available: 'Nueva versión disponible', update_to: 'Actualizar a',
    north: 'Norte arriba', free: 'Modo libre', nearest: 'Fuente más cercana', exported: 'Configuración exportada',
    imported: 'Configuración importada ✓', bad_file: 'Ese archivo no es válido', updating: 'Actualizando…',
    data_updated: 'Datos actualizados', db_error: 'No se pudo cargar la base de datos.',
    err_denied: 'Permiso denegado. Actívalo en los ajustes del navegador para ver las fuentes cercanas.',
    err_locate: 'No hemos podido obtener tu ubicación. Inténtalo de nuevo.',
    err_load: 'No se pudieron cargar las fuentes. Recarga la página e inténtalo de nuevo.',
    searching: 'Buscando tu posición…', retry: 'Reintentar', no_geo: 'Tu navegador no permite geolocalización.',
    fountain: 'Fuente', fountain_water: 'Fuente de agua', operative: 'Operativa', out_service: 'Sin servicio',
    use_people: 'Para personas', use_dogs: 'Para perros', use_both: 'Personas y perros', use_unknown: 'Uso no especificado',
    ar_almost: '¡Ya casi!', ar_steps: 'La fuente está a unos pasos de ti',
    ar_cal: 'Mueve el móvil en forma de 8 para calibrar la brújula', ar_lift: 'Levanta el móvil para ver la fuente',
    ar_follow: 'Sigue el icono o la flecha', ar_cam_no: 'Tu navegador no permite usar la cámara para AR.',
    ar_cam_err: 'No se pudo abrir la cámara. Revisa los permisos.', ar_perm: 'Necesito permiso de orientación para la brújula.'
  },
  en: {
    app_short: 'Fountains', app_full: 'Madrid Fountains',
    loading_text: 'Loading fountains…', splash_tag: "Where's the nearest fountain?",
    splash_desc: 'Find the nearest public drinking fountain, from the <a href="https://datos.madrid.es/dataset/300051-0-fuentes" target="_blank" rel="noopener">official City of Madrid data</a>.',
    privacy1: 'Your location is only used to frame the map; it is never sent or stored anywhere.',
    privacy2: 'Your favourite fountains are saved locally in your browser.',
    btn_allow: 'Allow location', filter_h: 'Filter fountains', settings_h: 'Settings',
    route: 'Walking route', ar_view: 'View in AR', f_estado: 'Status', f_oper: 'Working fountains only',
    f_fav: 'Favourites only ❤️', f_who: 'For whom?', f_all: 'All', f_people: 'People', f_dogs: 'Dogs 🐾',
    f_show: 'Show', f_fountains: 'fountains',
    about_desc: 'Official data from the <a href="https://datos.madrid.es/dataset/300051-0-fuentes" target="_blank" rel="noopener">City of Madrid</a> (CC BY 4.0).',
    set_idioma: 'Language', lang_auto: 'Automatic', lang_es: 'Spanish', lang_en: 'English',
    set_tema: 'Theme', set_claro: 'Light', set_oscuro: 'Dark', set_sistema: 'System', set_color: 'Accent colour',
    set_mapa: 'Map', map_moderno: 'Modern', map_clasico: 'Classic', map_minimalista: 'Minimal',
    map_cyberpunk: 'Cyberpunk', map_colorido: 'Colourful', map_sepia: 'Sepia',
    set_estela: 'Location trail', set_estela_on: 'Show the trail of your movement', set_estela_len: 'Length',
    set_datos: 'Data · favourites & settings', btn_export: 'Export', btn_import: 'Import',
    set_datos_hint: 'To move your settings to another phone or browser.',
    footer: 'Made by Ivan with ❤️ and lots of AI',
    update_available: 'New version available', update_to: 'Update to',
    north: 'North up', free: 'Free mode', nearest: 'Nearest fountain', exported: 'Settings exported',
    imported: 'Settings imported ✓', bad_file: "That file isn't valid", updating: 'Updating…',
    data_updated: 'Data updated', db_error: "Couldn't load the database.",
    err_denied: 'Permission denied. Enable it in your browser settings to see nearby fountains.',
    err_locate: "We couldn't get your location. Try again.",
    err_load: "Couldn't load the fountains. Reload the page and try again.",
    searching: 'Finding your position…', retry: 'Retry', no_geo: "Your browser doesn't support geolocation.",
    fountain: 'Fountain', fountain_water: 'Drinking fountain', operative: 'Working', out_service: 'Out of service',
    use_people: 'For people', use_dogs: 'For dogs', use_both: 'People and dogs', use_unknown: 'Unspecified use',
    ar_almost: 'Almost there!', ar_steps: 'The fountain is a few steps away',
    ar_cal: 'Move your phone in a figure 8 to calibrate the compass', ar_lift: 'Lift your phone to see the fountain',
    ar_follow: 'Follow the icon or the arrow', ar_cam_no: "Your browser can't use the camera for AR.",
    ar_cam_err: "Couldn't open the camera. Check permissions.", ar_perm: 'I need orientation permission for the compass.'
  }
};
function getLang() {
  if (settings.lang === 'es' || settings.lang === 'en') return settings.lang;
  return (navigator.language || 'es').toLowerCase().indexOf('es') === 0 ? 'es' : 'en';
}
function t(k) { const L = getLang(); return (I18N[L] && I18N[L][k]) || I18N.es[k] || k; }
function applyI18n() {
  const L = getLang();
  document.documentElement.setAttribute('lang', L);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (I18N[L][k] != null) { if (/[<&]/.test(I18N[L][k])) el.innerHTML = I18N[L][k]; else el.textContent = I18N[L][k]; }
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
  tileLayer = L.tileLayer(tile.url, { attribution: ATTRIB, subdomains: tile.sub, maxZoom: 20, detectRetina: true });
  tileLayer.addTo(map); tileLayer.setZIndex(0);
  const el = tileLayer.getContainer && tileLayer.getContainer();
  if (el) el.style.filter = cfg.f || '';                            // filtro CSS para sepia/cyber/colorido
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
  trailTimer = setInterval(sampleTrail, 3000);   // andamos despacio: cada 3 s basta
}
function sampleTrail() {
  if (!settings.trailOn || !userPos || !map) return;
  if (lastTrailPos && haversine(lastTrailPos.lat, lastTrailPos.lon, userPos.lat, userPos.lon) < 4) return;   // no te has movido
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
  const data = { v: 1, favs: [...favs], settings: settings, target: (function () { try { return localStorage.getItem(TARGET_KEY) || ''; } catch (_) { return ''; } })() };
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
      if (typeof d.target === 'string') { try { localStorage.setItem(TARGET_KEY, d.target); } catch (_) {} }
      if (map) { for (const f of shown) if (f.marker) f.marker.setIcon(f === selected ? nearestIcon(f) : fountainIcon(f)); applyFilters(); renderMarkers(); }
      syncSettingsUI();
      toast(t('imported'));
    } catch (e) { toast(t('bad_file')); }
  };
  r.readAsText(file);
}
function syncSettingsUI() {
  const st = $('setTheme'), sm = $('setMap'), sa = $('setAccent'), sl = $('setLang');
  if (st) st.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.theme === settings.theme));
  if (sm) sm.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.map === settings.map));
  if (sa) sa.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.accent === settings.accent));
  if (sl) sl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  if ($('fTrail')) $('fTrail').checked = !!settings.trailOn;
  if ($('fTrailLen')) $('fTrailLen').value = trailMax();
  if ($('trailLenVal')) $('trailLenVal').textContent = trailMax();
  if ($('trailLenRow')) $('trailLenRow').style.display = settings.trailOn ? '' : 'none';
}

applyI18n();     // idioma (es/en)
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
  if ($('updatedText')) $('updatedText').textContent = `${t('data_updated')}: ${fmt} · ${n} ${t('f_fountains')}`;
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

async function startApp() {
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
}

/* ---------- Panel "Acerca de" (al tocar el título) ---------- */
$('aboutBtn').addEventListener('click', () => { $('about').classList.add('open'); checkForUpdate(); });
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
      <circle cx="15" cy="15" r="14" fill="#1f7fe0" fill-opacity="0.18"/>
      <circle cx="15" cy="15" r="7.5" fill="#1f7fe0" stroke="#fff" stroke-width="3.2"/></svg></div>`
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

  startTrail();      // estela de ubicación
  restoreTarget();   // recupera la última fuente seleccionada (persistente)
  requestAnimationFrame(() => { map.invalidateSize(); fitInitialView(); renderMarkers(); updateModeButton(); updateFitBtn(); });
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
function setMode(m) {
  mapMode = m;
  if (m === 'north') { setBearingSafe(0); toast(t('north')); }
  updateModeButton();
}
function onModeButton() { setMode('north'); }   // el botón SOLO activa Norte arriba (si ya lo está, no hace nada visible)
function onMapRotate() {
  if (!programmaticBearing && mapMode !== 'free') { mapMode = 'free'; toast(t('free')); }   // girar a mano = modo libre
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
  const [usoKey, usoTxt] = usoLabel(p.USO);
  const operative = isOperative(f);
  const chips = [];
  chips.push(`<span class="chip dist">${pinSvg()} ${fmtDist(f.dist)}</span>`);
  chips.push(`<span class="chip">${USO_ICON[usoKey] || ''} ${usoTxt}</span>`);
  chips.push(`<span class="chip ${operative ? 'ok' : 'bad'}">${operative ? checkSvg() : crossSvg()} ${operative ? t('operative') : (p.ESTADO ? titleCase(p.ESTADO) : t('out_service'))}</span>`);
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
    dEl.textContent = t('ar_almost'); dEl.classList.add('ar-arrived');
    hintEl.textContent = t('ar_steps');
  } else {
    dEl.textContent = fmtDist(dist); dEl.classList.remove('ar-arrived');
    hintEl.textContent = arHeading == null ? t('ar_cal')
                       : (arPitch != null && arPitch > 45 ? t('ar_follow') : t('ar_lift'));
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
  toast(t('updating'));
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
function checkForUpdate() {
  fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
    .then(r => (r && r.ok) ? r.json() : null)
    .then(d => {
      if (d && d.version && d.version !== APP_VERSION) {
        updateAvailable = d.version;
        reflectUpdate();
        toast(`${t('update_available')} (v${d.version})`);
      }
    })
    .catch(() => {});
}

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
$('setLang').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.lang = b.dataset.lang; saveSettings(); applyI18n(); syncSettingsUI();
}));
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

(async function boot() {
  try { await ensureData(); }
  catch (e) { setUpdated(Date.now(), 0); if ($('updatedText')) $('updatedText').textContent = t('db_error'); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setTimeout(checkForUpdate, 2500);   // avisa si hay versión nueva publicada
  autoStartIfAllowed();
})();
