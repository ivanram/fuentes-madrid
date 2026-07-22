/* ============================================================
   Regenera ../fuentes.json desde el CSV oficial del
   Ayuntamiento de Madrid (CC BY 4.0), reproyectando de
   UTM ETRS89 (EPSG:25830) a latitud/longitud (WGS84).

   Uso normal (en GitHub Actions):   node build-fuentes.mjs
   Prueba con un CSV local:          node build-fuentes.mjs ruta.csv /tmp/out.json
   ============================================================ */
import fs from 'node:fs';
import proj4 from 'proj4';
import { PNG } from 'pngjs';

/* ⚠️ URL del CSV del año en curso. Si algún año deja de actualizarse,
   es lo único que habría que cambiar: ve a
   https://datos.madrid.es/dataset/300051-0-fuentes → Descargas
   y copia el enlace del CSV más reciente. */
const CSV_URL = 'https://datos.madrid.es/dataset/300051-0-fuentes/resource/300051-26-fuentes/download/300051-26-fuentes.csv';

const localInput = process.argv[2] || null;
const OUT = process.argv[3] || new URL('../fuentes.json', import.meta.url);

proj4.defs('EPSG:25830', '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const toWGS = proj4('EPSG:25830', 'WGS84');
const ELEVATION_ZOOM = 12;

function terrainPixel(lat, lon) {
  const scale = 2 ** ELEVATION_ZOOM;
  const x = (lon + 180) / 360 * scale;
  const sinLat = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return {
    tileX: Math.floor(x), tileY: Math.floor(y),
    pixelX: Math.min(255, Math.floor((x - Math.floor(x)) * 256)),
    pixelY: Math.min(255, Math.floor((y - Math.floor(y)) * 256)),
  };
}

async function addElevations(features, previousFeatures = []) {
  const previous = new Map(previousFeatures.map((feature) => [
    `${feature.lat},${feature.lon}`, feature.props?.ELEVATION_M,
  ]));
  const tilePromises = new Map();
  const loadTile = (tileX, tileY) => {
    const key = `${tileX}/${tileY}`;
    if (!tilePromises.has(key)) tilePromises.set(key, (async () => {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ELEVATION_ZOOM}/${tileX}/${tileY}.png`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Elevación HTTP ${response.status}: ${url}`);
      return PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    })());
    return tilePromises.get(key);
  };
  await Promise.all(features.map(async (feature) => {
    const oldElevation = previous.get(`${feature.lat},${feature.lon}`);
    if (Number.isFinite(oldElevation)) {
      feature.props.ELEVATION_M = oldElevation;
      return;
    }
    const pixel = terrainPixel(feature.lat, feature.lon);
    const png = await loadTile(pixel.tileX, pixel.tileY);
    const offset = (pixel.pixelY * png.width + pixel.pixelX) * 4;
    feature.props.ELEVATION_M = Math.round(
      png.data[offset] * 256 + png.data[offset + 1] + png.data[offset + 2] / 256 - 32768
    );
  }));
  console.log(`Elevación precalculada con ${tilePromises.size} teselas Terrain Tiles.`);
}

const titleCase = (s) => !s ? '' : s.toLowerCase().replace(/(^|\s|\/|\(|-)([a-záéíóúñ])/g, (m, p, c) => p + c.toUpperCase());
const normUso = (u) => { u = (u || '').toUpperCase(); if (u.includes('PERSONAS_Y') || u.includes('MIXTO')) return 'MIXTO'; if (u === 'MASCOTAS') return 'MASCOTAS'; if (u === 'PERSONAS') return 'PERSONAS'; return ''; };

function parseCSV(raw) {
  const lines = raw.replace(/\r/g, '').split('\n').filter((l) => l.length);
  const parse = (l) => l.split(';').map((c) => c.replace(/^"|"$/g, '').trim());
  const H = parse(lines[0]); const idx = {}; H.forEach((h, i) => idx[h] = i);
  const need = ['COORD_GIS_X', 'COORD_GIS_Y', 'ESTADO', 'USO', 'NOM_VIA', 'NUM_VIA', 'DIRECCION_AUX', 'BARRIO', 'DISTRITO'];
  for (const c of need) if (!(c in idx)) throw new Error('Falta la columna esperada: ' + c + ' (¿cambió el formato del CSV?)');

  const feats = []; let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const r = parse(lines[i]);
    const x = parseFloat(r[idx.COORD_GIS_X]), y = parseFloat(r[idx.COORD_GIS_Y]);
    if (!isFinite(x) || !isFinite(y)) { skipped++; continue; }
    const [lon, lat] = toWGS.forward([x, y]);
    if (!(lat > 39 && lat < 41 && lon > -4.2 && lon < -3.3)) { skipped++; continue; }   // descarta coords absurdas
    const nom = titleCase(r[idx.NOM_VIA] || ''); const num = (r[idx.NUM_VIA] || '').trim();
    const direccion = nom ? (nom + (num && num !== '0' ? ', ' + num : '')) : '';
    feats.push({
      lat: +lat.toFixed(6), lon: +lon.toFixed(6),
      props: {
        ESTADO: r[idx.ESTADO] || '', USO: normUso(r[idx.USO]),
        DIRECCION: direccion, DIRECCION_AUX: titleCase(r[idx.DIRECCION_AUX] || ''),
        BARRIO: titleCase(r[idx.BARRIO] || ''), DISTRITO: titleCase(r[idx.DISTRITO] || '')
      }
    });
  }
  return { feats, skipped };
}

const raw = localInput
  ? fs.readFileSync(localInput, 'utf8')
  : await fetch(CSV_URL).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });

const { feats, skipped } = parseCSV(raw);

// Red de seguridad: si vienen muy pocas, algo falló; no machacamos los datos buenos.
if (feats.length < 1500) throw new Error(`Solo ${feats.length} fuentes; abortando para no romper fuentes.json`);

let previousFeatures = [];
try { previousFeatures = JSON.parse(fs.readFileSync(OUT, 'utf8')).features || []; } catch (_) { /* primera ejecución */ }
await addElevations(feats, previousFeatures);

// Si los datos no han cambiado, no reescribimos (evita commits y cambios de fecha inútiles).
try {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (JSON.stringify(prev.features) === JSON.stringify(feats)) {
    console.log(`Sin cambios (${feats.length} fuentes). No se reescribe.`);
    process.exit(0);
  }
} catch (_) { /* no existía: lo creamos */ }

const out = { updated: Date.now(), count: feats.length, source: 'Ayuntamiento de Madrid (CC BY 4.0)', features: feats };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Actualizado: ${feats.length} fuentes (descartadas ${skipped}).`);
