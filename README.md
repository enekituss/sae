# SAE Burgos · Autobuses urbanos

Web estática para consultar las líneas de autobús urbano de Burgos mediante un diagrama de paradas en dos sentidos y los autobuses que publica el SAE municipal.

## Interfaz

- index.html es la entrada de GitHub Pages.
- app.js muestra una ficha permanente por línea, con los dos sentidos, las paradas y el inventario completo de coches. La red se consulta por línea con concurrencia limitada.
- styles.css contiene el diseño adaptable para ordenador y móvil.
- manifest.webmanifest y service-worker.js permiten instalar la web como aplicación.

## Fuentes de datos

### Tiempo real · ISAENEXT

La aplicación usa el Worker independiente de Burgos:

https://burgos-sae-spotter.ecanteroalvarez.workers.dev

Para una línea se consulta:

- /api/burgos/live?line=01&fresh=1: vehículos publicados, destino, sentido, próxima parada, estimación en segundos y distancia cuando ISAENEXT lo facilita.
- /health: estado y versión del Worker.

La numeración se consulta individualmente: líneas 01–23, 73, 87, 88, 89, C1 y C2. La portada muestra las 29 líneas a la vez. Por línea combina en paralelo el endpoint ligero del Worker y una consulta directa a ISAENEXT mediante proxies CORS públicos; después añade las estimaciones sin eliminar coches. Renueva la red cada tres minutos. Los coches sin posición GPS siguen apareciendo en el inventario.

La API municipal puede no publicar algún campo en una consulta concreta. La interfaz no inventa posiciones, destinos ni tiempos que falten. El esquema representa ambos sentidos como dos ramas entre las cabeceras compartidas cuando el GTFS confirma que los extremos coinciden. El autobús se proyecta sobre la geometría GTFS con su GPS si la fuente lo publica y utiliza el movimiento entre consultas sucesivas para intentar distinguir el sentido. Si no hay GPS, se aproxima a la próxima parada estimada. Todos los coches recibidos permanecen en el inventario de su línea aunque no se pueda confirmar su posición.

### Recorridos y horarios · GTFS

burgos-data.json contiene rutas, paradas, viajes, secuencias de parada, calendarios y geometrías GTFS.

scripts/update_burgos_gtfs.py descarga el conjunto municipal y genera el JSON. El workflow .github/workflows/update-burgos-gtfs.yml lo actualiza diariamente y permite ejecutarlo manualmente.

### Modelos de autobús

burgos-modelos.json relaciona los identificadores conocidos con el modelo de vehículo. Si un coche no está registrado, se muestra su número sin asignarle un modelo supuesto.

## Retrasos y turnos

El Worker se despliega mediante la integración oficial Cloudflare Workers Builds conectada al repositorio; no requiere secretos de despliegue en GitHub Actions. El workflow de este repositorio solo valida el código. El Worker extrae el campo tiempo desfase cuando ISAENEXT lo publica (incluidas las variantes de nombre habituales). Si no existe en la respuesta, la web calcula un desfase orientativo comparando la llegada estimada con la hora programada GTFS y marca su procedencia. El desfase calculado no es una incidencia oficial. Si la fuente no publica GPS o una próxima parada asociable, el vehículo se conserva en la lista de flota sin inventar su posición sobre el dibujo.

El campo GTFS block_id identifica un bloque de viajes asociado a un vehículo. No debe confundirse automáticamente con el turno interno de conductor o con el número de servicio operativo.

## Despliegue

La web está preparada para GitHub Pages desde la raíz de main. En Settings → Pages, selecciona Deploy from a branch, rama main y carpeta / (root).

El Worker vive en cloudflare-worker-burgos/ y se despliega mediante el workflow .github/workflows/deploy-burgos-worker.yml. La configuración CORS del Worker permite el origen https://enekituss.github.io, compatible con GitHub Pages del repositorio.

## Estructura mantenida

- burgos-data.json y burgos-modelos.json.
- cloudflare-worker-burgos/ para la API de ISAENEXT.
- scripts/update_burgos_gtfs.py y los workflows de actualización, comprobación y despliegue.
- Los iconos y archivos PWA de SAE Burgos.
