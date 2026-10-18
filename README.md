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

El bot tiene un menú personal por chat. Envía `/start` o `/menu` para elegir entre. Se usa el teclado de respuesta de Telegram para evitar el indicador de carga de los antiguos botones internos; como los mensajes se procesan en el siguiente ciclo de GitHub Actions, la respuesta no es instantánea:

- **Todos los avisos** de vehículos.
- **Solo vehículos sin posición reciente** (posible fin de servicio; no confirma una baja administrativa).
- **Solo cambios del campo línea**; los cambios únicamente de destino o sentido no entran en este filtro.
- **Seguir un coche por ID**, indicando su identificador numérico. También se puede usar `/id 1101` para configurarlo directamente.

Las preferencias se guardan por chat en `vehicle-alert-state.json`, así que los filtros de una persona no cambian los de las demás. El chat configurado en `TELEGRAM_CHAT_ID` conserva todos los avisos por defecto hasta que elija otra opción.
La actualización automática compara snapshots consecutivos de SIRI y mantiene una cola persistente de avisos de Telegram:

- **Entrada en el feed:** un vehículo con ID publicado que no estaba en el snapshot anterior debe aparecer en dos consultas válidas consecutivas separadas al menos dos minutos. La primera ejecución establece la referencia y no anuncia toda la flota como nueva.
- **Salida de observación reciente:** si un vehículo desaparece de la lista activa o su última posición supera 15 minutos mientras otros vehículos siguen actualizando, se confirma tras varias observaciones y un tiempo mínimo. Una reducción brusca de la flota exige una confirmación reforzada.
- **Feed completamente vacío:** para no confundir una lectura vacía aislada con el fin del servicio, se esperan cuatro consultas vacías consecutivas durante al menos seis minutos; entonces se preparan los avisos de los vehículos que estaban activos.
- **Posiciones antiguas:** un vehículo solo se considera observado recientemente si la marca temporal de su posición tiene como máximo 15 minutos. Si todas las posiciones del feed son antiguas, se pausan las alertas individuales y actúa la alerta general de feed desactualizado; si solo algunos vehículos dejan de comunicar mientras otros sí actualizan, se vigilan como posibles salidas.
- **Caída brusca de la flota:** las reducciones grandes necesitan seis observaciones y al menos 20 minutos. Si esa caída reforzada ya se está comprobando, el contador no se reinicia en cada consulta.
- **Reapariciones y cambios de ruta:** se notifican por separado y se evita interpretar un cambio observado después de una interrupción prolongada como un cambio de línea seguro.

Los mensajes describen altas y bajas **del feed publicado**, que es la evidencia disponible en SIRI; no prueban una baja administrativa ni el estado físico del vehículo si el operador deja de publicar datos. Las notificaciones quedan en una cola persistente hasta que la API de Telegram acepta el envío.

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
El Cloudflare Worker solicita una comprobación del feed aproximadamente cada dos minutos y GitHub Actions conserva además una programación de respaldo cada cinco minutos. Como el feed público SIRI se consulta por HTTP y no hay configurada una suscripción de eventos del proveedor, la detección ocurre en la siguiente consulta; no es una notificación instantánea emitida por CTB. Cada comprobación válida actualiza `vehicles.json` y `vehicles-data.js`, y la lógica de alertas compara los snapshots para notificar cambios confirmados.
Flujo y ejecuciones: https://github.com/enekituss/sae/actions


## Selección de ciudad e instalación como aplicación
Después del login, `index.html` ofrece la elección entre Burgos y Bizkaibus. La vista anterior de Bizkaibus se conserva en `bizkaibus.html`; el directorio de paradas también vuelve a esa página. La navegación usa enlaces normales del navegador, y en la portada se añade un límite al historial para que Atrás no vuelva al formulario de login ni cierre la aplicación desde allí.

El manifiesto `manifest.webmanifest`, el Service Worker y los iconos permiten que Chrome ofrezca la instalación de SAE Spotter. En Android, se puede usar la opción **Instalar aplicación** cuando Chrome la ofrezca, o el menú de Chrome si todavía no aparece el botón de instalación dentro de la web.

## Autobuses urbanos de Burgos
- `burgos.html` muestra únicamente las líneas con autobuses activos, agrupadas como en Bizkaibus, sin mapa ni tablas de horarios.
- `burgos-vehicles.js` consulta `resourceVehicles` para cada línea del servicio municipal ISAENEXT mediante el endpoint `/api/burgos/vehicles?line=XX` del Worker independiente `burgos-sae-spotter` (carpeta `cloudflare-worker-burgos`). La URL base del Worker se guarda en el navegador desde «Configurar conexión». Si no se ha configurado, intenta proxies públicos de respaldo, que pueden no estar disponibles; `corsproxy.io` ya no se usa por sus respuestas HTTP 403. Se actualiza aproximadamente cada 60 segundos.
- La lista muestra los identificadores y solo los campos adicionales que la fuente publique. Si alguna línea no responde, se conserva temporalmente su última respuesta y la cabecera indica que los datos son parciales.
- `scripts/update_burgos_gtfs.py` y `.github/workflows/update-burgos-gtfs.yml` mantienen `burgos-data.json` como fichero de horarios de referencia, pero la pantalla actual de Burgos ya no muestra el mapa ni la tabla GTFS.
- El Worker independiente `cloudflare-worker-burgos` expone `/api/burgos/vehicles`. Para que el listado de Burgos sea estable, despliega `burgos-sae-spotter` desde esa carpeta y configura su URL base en «Configurar conexión» dentro de `burgos.html`. El Worker `bizkaibus-sae-dispatcher` es distinto y continúa dedicado a sus tareas de Bizkaibus.
