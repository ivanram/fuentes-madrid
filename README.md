# Fuentes de Madrid 💧

Web app sencilla para encontrar la **fuente pública de agua para beber más cercana** en Madrid.

- Pantalla de inicio con permiso de ubicación y fecha de la base de datos.
- Mapa limpio centrado en ti (radio de 500 m; se amplía solo si la fuente más cercana está más lejos).
- Tu posición se ve con un marcador grande; las fuentes, con una gota de agua.
- Al tocar una fuente: dirección, tipo de uso (personas / mascotas / mixto), estado, y botones de **ruta andando** y **ver con AR** (cámara + brújula).
- Funciona como PWA: se puede "instalar" en el móvil y cargar sin conexión tras la primera vez.

## Datos

Fuente oficial: **Ayuntamiento de Madrid — "Fuentes de agua para beber"** (licencia CC BY 4.0).
Los datos vienen **embebidos** en el archivo `fuentes.json` (2.285 fuentes), generado a partir
del CSV oficial del portal de datos abiertos y reproyectado de UTM ETRS89 (EPSG:25830) a
latitud/longitud (WGS84). Así la app no depende de ninguna red externa: carga al instante y
funciona sin conexión. Solo se muestran las fuentes en estado **OPERATIVO** (2.236).
