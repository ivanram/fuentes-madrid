# Fuentes de Madrid 💧

Web app sencilla para encontrar la **fuente pública de agua para beber más cercana** en Madrid.

- Pantalla de inicio con permiso de ubicación y fecha de la base de datos.
- Mapa limpio centrado en ti (radio de 500 m; se amplía solo si la fuente más cercana está más lejos).
- Tu posición se ve con un marcador grande; las fuentes, con una gota de agua.
- Al tocar una fuente: dirección, tipo de uso (personas / mascotas / mixto), estado, y botones de **ruta andando** y **ver con AR** (cámara + brújula).
- Funciona como PWA: se puede "instalar" en el móvil y cargar sin conexión tras la primera vez.

## Datos

Fuente oficial: **Ayuntamiento de Madrid — "Fuentes de agua para beber"** (licencia CC BY 4.0).
La app consulta en vivo el servicio geográfico municipal, que entrega las coordenadas ya en
latitud/longitud, y guarda una copia en el navegador para cargas rápidas y uso offline.
Solo se muestran las fuentes en estado **OPERATIVO**.

## Cómo publicarla (sin instalar nada)

### Opción rápida — Netlify Drop
1. Entra en https://app.netlify.com/drop
2. Arrastra **toda esta carpeta**.
3. En segundos tienes una URL pública con HTTPS. Listo.

### GitHub Pages (desde el navegador)
1. En github.com: **+ → New repository**, nombre p. ej. `fuentes-madrid`, público, **Create**.
2. **Add file → Upload files**, arrastra todos los archivos de esta carpeta y **Commit changes**.
3. **Settings → Pages → Source: `main` / root → Save**.
4. En ~1 min tendrás la URL `tu-usuario.github.io/fuentes-madrid`.

> La ubicación y la cámara (AR) **solo funcionan sobre HTTPS**, que tanto Netlify como
> GitHub Pages dan automáticamente. Abrir el `index.html` directamente desde el disco no
> activará el GPS.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | Estructura de la app |
| `styles.css` | Estilos (mobile-first, minimalista) |
| `app.js` | Lógica: datos, mapa, ficha, ruta y AR |
| `icon.svg` | Icono de la fuente (logo y marcadores) |
| `manifest.webmanifest` + `sw.js` | Soporte PWA / offline |

## Notas

- **AR**: usa la cámara y la brújula del móvil para mostrar una flecha hacia la fuente.
  La precisión depende del sensor del teléfono; calíbralo moviendo el móvil en forma de 8.
- Para un icono de app más nítido en algunos Android, puedes añadir versiones PNG
  (192×192 y 512×512) y referenciarlas en `manifest.webmanifest`.

Creado con &lt;3 por Ivan.
