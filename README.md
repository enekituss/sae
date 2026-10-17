# Bizkaibus SAE · Spotter

Web de consulta de líneas y vehículos Bizkaibus detectados por SIRI, con destinos, directorio de paradas, datos de bloque de vehículo y próximos horarios.

## Funciones
- Agrupación de vehículos por línea, búsqueda y consulta de ID.
- Relación de la parada SIRI actual con un nombre del directorio GTFS.
- Destino previsto cruzado con `trip_headsign` del GTFS.
- Directorio de paradas (`paradas.html`) con búsqueda por ID y nombre.
- **Número de servicio inferido de SIRI:** en las referencias observadas, un código como `O9SI3411_341102_12` contiene el código de la línea seguido de un identificador de servicio de dos dígitos (`02` → Servicio 2). Se muestra como inferido del identificador de viaje para distinguirlo de un campo oficial explícito. También se conservan el bloque de vehículo y el nombre corto GTFS cuando existen.
- **Itinerario completo hasta el final del viaje:** se muestran todas las paradas restantes que aparecen en `stop_times.txt` del GTFS estático, asociadas con el viaje actual de cada vehículo. El itinerario se abre en una ventana emergente desplazable.
- Si GTFS-Realtime proporciona predicciones para alguna de esas paradas, se usan sus horas estimadas; si no, se conserva el horario publicado y se marca como tal.

## Servicio, viaje y bloque: qué significa cada campo
- `trip_short_name`: nombre corto público del viaje si el feed lo ofrece.
- `block_id`: identifica en GTFS un bloque de viajes consecutivos asignados al mismo vehículo. Es el campo público más próximo a un número de servicio de vehículo, pero no garantiza que sea exactamente el “Servicio 1/2/3” usado internamente por el operador.
- `service_id`: identifica un calendario de servicio (qué días funciona), no un número de servicio del autobús.
- `trip_id` / SIRI `VehicleJourneyRef`: identifican el viaje concreto del autobús.

## Alertas de cambios de ruta por Telegram

La actualización automática compara dos snapshots consecutivos recientes para cada ID de vehículo SIRI. Si el mismo vehículo cambia de línea, destino o sentido, prepara una notificación individual de Telegram. Se ignoran altas/bajas de vehículos y cambios de campos vacíos, y no se generan alertas si el snapshot anterior tiene más de 20 minutos para evitar falsos avisos tras una interrupción del feed.

**Importante:** esta alerta detecta cambios de línea/destino/sentido asignados en los datos SIRI. No detecta todavía una desviación geográfica del autobús respecto al trazado de su línea; para eso habría que comparar su posición GPS con los shapes del GTFS y aplicar un margen de tolerancia.

Para activar Telegram:
1. Crear un bot con [@BotFather](https://t.me/BotFather) usando `/newbot` y guardar su token de forma privada.
2. Abrir el bot nuevo en Telegram, pulsar **Iniciar** y enviar `/start`.
3. Obtener el ID del chat personal (por ejemplo, consultando `getUpdates` con el token en un entorno privado) o el ID del grupo al que se haya añadido el bot.
4. En GitHub, abrir **Settings → Secrets and variables → Actions → New repository secret** y crear los secretos `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.

El token no debe guardarse en el código ni publicarse. Hasta que estén configurados ambos secretos, la web y la actualización de datos seguirán funcionando; simplemente no se enviarán mensajes.

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


## Selección de ciudad e instalación como aplicación
Después del login, `index.html` ofrece la elección entre Burgos y Bizkaibus. La vista anterior de Bizkaibus se conserva en `bizkaibus.html`; el directorio de paradas también vuelve a esa página. La navegación usa enlaces normales del navegador, y en la portada se añade un límite al historial para que Atrás no vuelva al formulario de login ni cierre la aplicación desde allí.

El manifiesto `manifest.webmanifest`, el Service Worker y los iconos permiten que Chrome ofrezca la instalación de SAE Spotter. En Android, se puede usar la opción **Instalar aplicación** cuando Chrome la ofrezca, o el menú de Chrome si todavía no aparece el botón de instalación dentro de la web.

## Horarios urbanos de Burgos
- `burgos.html` permite consultar líneas y viajes, y abrir la tabla completa de horas programadas para cada parada.
- `scripts/update_burgos_gtfs.py` descarga `https://www.aytoburgos.es/GTFS/Google_transit.zip` y genera `burgos-data.json`.
- `.github/workflows/update-burgos-gtfs.yml` actualiza el fichero diariamente y se puede lanzar manualmente desde GitHub Actions.
- Los identificadores `trip_id`, `service_id` y `block_id` son los campos del GTFS; no equivalen necesariamente al número físico de flota ni al turno operativo que conoce el conductor.
- El GTFS estático no contiene posiciones GPS ni confirma si un autobús está circulando. El panel lo señala y separa horarios del seguimiento real. La vigencia se comprueba usando las fechas declaradas en los calendarios del fichero.
