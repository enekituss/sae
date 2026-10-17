# Bizkaibus SAE · Spotter

Web de consulta de las líneas y vehículos Bizkaibus detectados por el feed público SIRI de Open Data Bizkaia. Incluye un listado de vehículos agrupado por línea y un directorio de paradas que relaciona IDs SIRI con nombres.

## Funciones
- Agrupación por línea con identificador del vehículo y búsqueda por línea, vehículo, destino o parada.
- Muestra el destino previsto cuando se puede asociar el viaje en curso con los horarios GTFS.
- Relaciona el campo SIRI `MonitoredCall/StopPointRef` con el directorio de paradas GTFS, mostrando nombre e ID.
- Cada ID de parada enlaza a `paradas.html?id=...`; allí se abre el directorio con ese ID ya buscado.
- El directorio contiene nombre e ID de cada parada y permite abrirla en OpenStreetMap si hay coordenadas.
- GitHub Actions consulta las posiciones SIRI, enriquece la información y publica `vehicles.json` y `vehicles-data.js` aproximadamente cada cinco minutos. Los directorios estáticos se guardan en caché y se renuevan periódicamente.

## Cómo se averiguan las paradas y los destinos
- **Paradas:** el `StopPointRef` de cada vehículo se cruza por ID con `stops.txt` del GTFS de producción. Se publican unos 2.300 registros de paradas y la última ejecución enlazó las 192 actividades de vehículo con un nombre de parada. Si un ID no se encuentra, la web conserva el identificador sin inventar un nombre.
- **Destino previsto:** primero se priorizan nombres explícitos de SIRI, luego datos de actualizaciones de viaje SIRI. Si el feed no ofrece un destino legible, se cruza `VehicleJourneyRef` con `trip_id` del GTFS y se toma `trip_headsign`. En la ejecución de validación con el GTFS de producción se encontraron destinos para los 192 vehículos detectados. Se muestra como **destino previsto** porque procede del horario publicado, no necesariamente de la lectura de un letrero frontal en tiempo real.
- El identificador de viaje contiene códigos técnicos útiles para el cruce, pero la web no intenta traducir arbitrariamente cada fragmento; cuando no hay una correspondencia fiable, deja el destino sin identificar.

## Fuentes
- Posiciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml
- Actualizaciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-trip-updates.xml
- GTFS de producción, que incluye `stops.txt` y `trips.txt`: https://baliabideak.bizkaia.eus/Bizkaibus/GTFS/Bizkaibus.zip
- API alternativa de paradas: https://apps.bizkaia.eus/BBOA000M/rest/BBOA/GetParadas

Open Data Bizkaia publica información de posiciones GPS, paradas, líneas y horarios de Bizkaibus. La información GTFS se actualiza antes que el directorio de horarios estáticos de pruebas; por eso se usa el ZIP de producción para cruzar viajes y destinos.

## Publicación
GitHub Pages se publica desde `main`, carpeta raíz. El flujo está en `.github/workflows/update-siri.yml`. Estado y ejecución manual: https://github.com/enekituss/sae/actions
