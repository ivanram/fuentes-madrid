/* ============================================================
   Datos de presentación: teselas, temas de mapa y paletas.
   Separado de app.js para que la lógica quede más ligera.
   (Variables globales: las usa app.js.)
   ============================================================ */

/* Teselas base (sin clave/API). Los temas las combinan con filtros CSS. */
const TILES = {
  voyager:  { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', sub: 'abcd' },
  positron: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', sub: 'abcd' },
  osm:      { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc' }
};

/* Cada tema = variante clara y oscura (según el tema de la app). f = filtro CSS.
   Los oscuros parten de un mapa CLARO invertido → gris oscuro legible (no negro). */
const MAP_THEMES = {
  moderno:     { light: { t: 'voyager',  f: '' },
                 dark:  { t: 'voyager',  f: 'invert(1) hue-rotate(180deg) contrast(.86) brightness(1.08)' } },
  clasico:     { light: { t: 'osm',      f: '' },
                 dark:  { t: 'osm',      f: 'invert(1) hue-rotate(180deg) contrast(.86) brightness(1.08)' } },
  minimalista: { light: { t: 'positron', f: '' },
                 dark:  { t: 'positron', f: 'invert(1) hue-rotate(180deg) contrast(.7) brightness(1.22)' } },
  /* Cyberpunk: neón morado/magenta/cian. Claro = fondo claro con neón; oscuro = fondo oscuro luminoso. */
  cyberpunk:   { light: { t: 'voyager',  f: 'saturate(3.4) hue-rotate(265deg) contrast(1.5) brightness(.97)' },
                 dark:  { t: 'voyager',  f: 'invert(1) hue-rotate(205deg) saturate(4) brightness(1.25) contrast(1.3)' } },
  /* Colorful: vivo pero menos amarillo (verdes/azules de parques y agua se mantienen). */
  colorido:    { light: { t: 'voyager',  f: 'saturate(2.1) hue-rotate(-8deg) contrast(1.1)' },
                 dark:  { t: 'voyager',  f: 'invert(1) hue-rotate(172deg) saturate(2.3) contrast(.9) brightness(1.2)' } },
  /* Sepia: monocromo amarronado (poca saturación → gris-marrón legible). */
  sepia:       { light: { t: 'osm',      f: 'sepia(.7) saturate(.55) contrast(1.18) brightness(.99)' },
                 dark:  { t: 'osm',      f: 'invert(1) hue-rotate(180deg) sepia(.6) saturate(1.3) contrast(.82) brightness(1.12)' } }
};

/* Paletas de color de acento. */
const ACCENTS = {
  blue:   { main: '#1f7fe0', d: '#1668bd', l: '#3ea8ff' },
  teal:   { main: '#0ca7a0', d: '#0a847e', l: '#2bc9c2' },
  green:  { main: '#2faa4e', d: '#24863d', l: '#46c969' },
  purple: { main: '#7c5cff', d: '#6442e6', l: '#9a82ff' },
  red:    { main: '#e23b4e', d: '#c02438', l: '#f06070' },
  orange: { main: '#f08a1d', d: '#cf6f0c', l: '#ffa84a' }
};
