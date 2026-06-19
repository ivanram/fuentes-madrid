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
