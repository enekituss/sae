# Bizkaibus SAE · Spotter

Web de consulta de las líneas y vehículos Bizkaibus detectados por el feed público SIRI de Open Data Bizkaia. Incluye listado agrupado de vehículos y un directorio que relaciona los IDs de parada con sus nombres.

## Funciones
- Agrupación por línea, con identificador del vehículo y búsqueda.
- Muestra destino/sentido cuando puede obtenerlo de SIRI o del GTFS.
- Intenta traducir `MonitoredCall/StopPointRef` a un nombre mediante el directorio público de paradas.
- Enlace desde cada ficha de vehículo a `paradas.html?id=...`, donde se abre el directorio filtrado por ese ID.
- Directorio de paradas con búsqueda por ID, nombre y municipio, y enlace al mapa cuando hay coordenadas.
- GitHub Actions consulta SIRI y genera `vehicles.json` y `vehicles-data.js`; las posiciones se renuevan aproximadamente cada cinco minutos.
- El directorio de paradas y el índice de destinos GTFS se mantienen en caché y se actualizan de forma periódica para no descargar todos los datos estáticos cada cinco minutos.

## Cómo se relacionan los datos
- **Parada:** se usa el `StopPointRef` del bloque `MonitoredCall` en SIRI. El flujo busca su ID en el directorio de paradas oficial y, como alternativa, en `stops.txt` del GTFS público. Si no hay correspondencia, la web sigue mostrando el ID sin inventar un nombre.
- **Destino:** prioridad para un nombre explícito en el feed de posiciones SIRI, luego datos de `bizkaibus-trip-updates.xml`, y finalmente `trip_headsign` del GTFS cuando `VehicleJourneyRef` coincide con `trip_id`. Si el feed no incluye los campos y no hay coincidencia, el destino aparecerá como no identificado. No se supone que cada fragmento del ID de viaje codifique por sí solo un destino legible.
- **Actualización:** el navegador lee los datos del mismo sitio donde está alojada la web, evitando un intento directo del navegador al XML SIRI que podría fallar por CORS.

## Fuentes públicas
- Posiciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml
- Actualizaciones de viaje SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-trip-updates.xml
- Paradas de Bizkaia: https://apps.bizkaia.eus/BBOA000M/rest/BBOA/GetParadas
- GTFS de respaldo: https://baliabideak.bizkaia.eus/Bizkaibus/GTFS-PRUEBAS/

El catálogo de Open Data Bizkaia publica datos de paradas, líneas, horarios y posicionamiento de Bizkaibus, y el recurso de posicionamiento SIRI incluye referencias `VehicleRef`, `VehicleJourneyRef` y `StopPointRef`. El directorio puede ser estático y tener una fecha de actualización distinta de la posición en tiempo real.

## Publicación
GitHub Pages se publica desde la rama `main`, carpeta raíz (`/(root)`). La tarea automática está en `.github/workflows/update-siri.yml`. Consulta o ejecuta tareas manualmente en https://github.com/enekituss/sae/actions
