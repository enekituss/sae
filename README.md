# SAE Burgos · Autobuses urbanos

Web estática para consultar las líneas de autobús urbano de Burgos mediante un diagrama de paradas en dos sentidos y los autobuses que publica el SAE municipal.

## Interfaz

- index.html es la entrada de GitHub Pages.
- app.js construye los sentidos a partir de los viajes GTFS y consulta únicamente la línea seleccionada.
- styles.css contiene el diseño adaptable para ordenador y móvil.
- manifest.webmanifest y service-worker.js permiten instalar la web como aplicación.

## Fuentes de datos

### Tiempo real · ISAENEXT

La aplicación usa el Worker independiente de Burgos:

https://burgos-sae-spotter.ecanteroalvarez.workers.dev

Para una línea se consulta:

- /api/burgos/live?line=01&fresh=1: vehículos publicados, destino, sentido, próxima parada, estimación en segundos y distancia cuando ISAENEXT lo facilita.
- /health: estado y versión del Worker.

La numeración se consulta individualmente: líneas 01–23, 73, 87, 88, 89, C1 y C2. La web no lanza las 29 consultas a la vez: solicita la línea seleccionada y la renueva cada 45 segundos.

La API municipal puede no publicar algún campo en una consulta concreta. La interfaz no inventa posiciones, destinos ni tiempos que falten. El esquema coloca el autobús junto a la próxima parada estimada cuando el identificador o el nombre de esa parada coincide con el itinerario GTFS. Esto es una posición esquemática, no una coordenada exacta sobre el mapa.

### Recorridos y horarios · GTFS

burgos-data.json contiene rutas, paradas, viajes, secuencias de parada, calendarios y geometrías GTFS.

scripts/update_burgos_gtfs.py descarga el conjunto municipal y genera el JSON. El workflow .github/workflows/update-burgos-gtfs.yml lo actualiza diariamente y permite ejecutarlo manualmente.

### Modelos de autobús

burgos-modelos.json relaciona los identificadores conocidos con el modelo de vehículo. Si un coche no está registrado, se muestra su número sin asignarle un modelo supuesto.

## Retrasos y turnos

El Worker publica estimaciones de llegada, no un campo universal de retraso oficial. Cuando la aplicación puede identificar el viaje y una parada del GTFS, compara la hora estimada de llegada con el horario de referencia y muestra un retraso calculado. El rótulo se identifica como estimación; no es una incidencia oficial del Ayuntamiento.

El campo GTFS block_id identifica un bloque de viajes asociado a un vehículo. No debe confundirse automáticamente con el turno interno de conductor o con el número de servicio operativo.

## Despliegue

La web está preparada para GitHub Pages desde la raíz de main. En Settings → Pages, selecciona Deploy from a branch, rama main y carpeta / (root).

El Worker vive en cloudflare-worker-burgos/ y se despliega mediante el workflow .github/workflows/deploy-burgos-worker.yml. La configuración CORS del Worker permite el origen https://enekituss.github.io, compatible con GitHub Pages del repositorio.

## Estructura mantenida

- burgos-data.json y burgos-modelos.json.
- cloudflare-worker-burgos/ para la API de ISAENEXT.
- scripts/update_burgos_gtfs.py y los workflows de actualización, comprobación y despliegue.
- Los iconos y archivos PWA de SAE Burgos.
