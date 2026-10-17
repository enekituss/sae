# Bizkaibus SAE · Spotter

Web de consulta de líneas y vehículos Bizkaibus detectados por SIRI, con destinos, directorio de paradas, datos de bloque de vehículo y próximos horarios.

## Funciones
- Agrupación de vehículos por línea, búsqueda y consulta de ID.
- Relación de la parada SIRI actual con un nombre del directorio GTFS.
- Destino previsto cruzado con `trip_headsign` del GTFS.
- Directorio de paradas (`paradas.html`) con búsqueda por ID y nombre.
- **Número de servicio inferido de SIRI:** en las referencias observadas, un código como `O9SI3411_341102_12` contiene el código de la línea seguido de un identificador de servicio de dos dígitos (`02` → Servicio 2). Se muestra como inferido del identificador de viaje para distinguirlo de un campo oficial explícito. También se conservan el bloque de vehículo y el nombre corto GTFS cuando existen.
- **Próximas cinco paradas previstas** usando `stop_times.txt` del GTFS estático, asociadas con el viaje actual de cada vehículo.
- Si GTFS-Realtime proporciona predicciones para esas paradas, se usan sus horas estimadas; si no, se conserva el horario publicado y se marca como tal.

## Servicio, viaje y bloque: qué significa cada campo
- `trip_short_name`: nombre corto público del viaje si el feed lo ofrece.
- `block_id`: identifica en GTFS un bloque de viajes consecutivos asignados al mismo vehículo. Es el campo público más próximo a un número de servicio de vehículo, pero no garantiza que sea exactamente el “Servicio 1/2/3” usado internamente por el operador.
- `service_id`: identifica un calendario de servicio (qué días funciona), no un número de servicio del autobús.
- `trip_id` / SIRI `VehicleJourneyRef`: identifican el viaje concreto del autobús.

## Horarios de próximas paradas
El flujo busca el viaje del vehículo en el GTFS de producción y cruza su secuencia con `stop_times.txt`. Las predicciones reales se leen del recurso oficial GTFS-Realtime Trip Updates (`FeedTripUpdates.pb`): sus actualizaciones `StopTimeUpdate` pueden incluir una hora absoluta de llegada/salida o un retraso respecto al horario. Si no hay una predicción actual, la web muestra el horario estático y lo diferencia visualmente. Esto evita presentar como tiempo real un horario que solo es planificado.

El archivo GTFS estático se mantiene en caché dentro de GitHub Actions, por lo que no se descarga el ZIP de producción cada cinco minutos.

## Fuentes públicas
- Posiciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml
- Actualizaciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-trip-updates.xml
- Actualizaciones de viaje GTFS-RT: https://baliabideak.bizkaia.eus/Bizkaibus/GTFSRealTime/FeedTripUpdates.pb
- GTFS de producción (incluye `trips.txt`, `stops.txt` y `stop_times.txt`): https://baliabideak.bizkaia.eus/Bizkaibus/GTFS/Bizkaibus.zip
- API alternativa de paradas: https://apps.bizkaia.eus/BBOA000M/rest/BBOA/GetParadas

## Actualización
GitHub Actions refresca la copia de posiciones aproximadamente cada cinco minutos y genera `vehicles.json` y `vehicles-data.js`. El navegador lee la copia del mismo dominio para evitar bloqueos CORS.
Flujo y ejecución manual: https://github.com/enekituss/sae/actions
