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

El bot tiene un menú personal por chat privado. Envía `/start` o `/menu` para elegir entre seis opciones. Una vez activados los webhooks de Telegram del Worker de Cloudflare, las selecciones se confirman al instante y las preferencias se guardan en la rama separada `telegram-data`. Si los webhooks todavía no están configurados, GitHub Actions conserva el procesamiento periódico de respaldo. La detección de cambios de autobuses sigue dependiendo de las siguientes consultas de los datos publicados y no se vuelve instantánea por acelerar el menú:

- **Todos los avisos:** recibe todas las clases de eventos confirmados.
- **Solo fuera de servicio:** avisa cuando un vehículo deja de aparecer en el feed tras varias comprobaciones. No confirma una baja administrativa.
- **Solo cambios de línea:** avisa cuando un coche que continúa activo aparece asignado a una línea diferente; los cambios solo de destino o sentido no cuentan.
- **Nueva entrada (reaparición):** avisa cuando un coche previamente desaparecido vuelve a aparecer.
- **Seguir coche(s) por ID:** escribe uno o varios identificadores, separados por espacios o comas. Se puede volver a seleccionar la opción para añadir más coches. También funciona `/id 1101 1102`.
- **Pausar avisos:** no envía más avisos hasta que se seleccione otra modalidad. También funciona `/stop` o `/pausar`.

### Activar el menú instantáneo (una sola vez)

En Cloudflare, dentro del Worker `bizkaibus-sae-dispatcher`, añade estos **Secrets** sin publicarlos ni enviarlos por el chat:

- `TELEGRAM_BIZKAIBUS_BOT_TOKEN`: el mismo valor que el secreto de Actions `TELEGRAM_BOT_TOKEN`.
- `TELEGRAM_BURGOS_BOT_TOKEN`: el mismo valor que `BURGOS_TELEGRAM_BOT_TOKEN`.
- `TELEGRAM_WEBHOOK_SECRET`: una cadena aleatoria de al menos 32 caracteres con letras, números, guion y guion bajo.
- `GITHUB_TOKEN`: necesita `Actions: Read and write` y `Contents: Read and write` para el repositorio `sae`.

Despliega el Worker actualizado. No hace falta usar PowerShell: el programador de Cloudflare comprobará los secretos y registrará automáticamente los webhooks en el siguiente ciclo (normalmente dentro de dos minutos). La comprobación aparecerá en **Workers & Pages → bizkaibus-sae-dispatcher → Logs** como "Webhooks de Telegram configurados automáticamente". Si falta algún secreto, el error de los logs indicará qué nombre falta.

Las preferencias principales se guardan por chat privado en la rama `telegram-data` (un fichero independiente por usuario), mientras que `vehicle-alert-state.json` conserva el estado del detector y la cola de eventos. El bot revisa la modalidad al enviar para evitar entregar mensajes pendientes que ya no corresponden a la configuración actual.
La actualización automática compara snapshots consecutivos de SIRI y mantiene una cola persistente de avisos de Telegram:

- **Entrada en el feed:** un vehículo con ID publicado que no estaba en el snapshot anterior debe aparecer en dos consultas válidas consecutivas separadas al menos dos minutos. La primera ejecución establece la referencia y no anuncia toda la flota como nueva.
- **Salida de observación reciente:** si un vehículo desaparece de la lista activa o su última posición supera 15 minutos mientras otros vehículos siguen actualizando, se confirma tras varias observaciones y un tiempo mínimo. Una reducción brusca de la flota exige una confirmación reforzada.
- **Feed completamente vacío:** para no confundir una lectura vacía aislada con el fin del servicio, se esperan cuatro consultas vacías consecutivas durante al menos seis minutos; entonces se preparan los avisos de los vehículos que estaban activos.
- **Posiciones antiguas:** un vehículo solo se considera observado recientemente si la marca temporal de su posición tiene como máximo 15 minutos. Si todas las posiciones del feed son antiguas, se pausan las alertas individuales y actúa la alerta general de feed desactualizado; si solo algunos vehículos dejan de comunicar mientras otros sí actualizan, se vigilan como posibles salidas.
- **Caída brusca de la flota:** las reducciones grandes necesitan seis observaciones y al menos 20 minutos. Si esa caída reforzada ya se está comprobando, el contador no se reinicia en cada consulta.
- **Reapariciones y cambios de ruta:** se notifican por separado y se evita interpretar un cambio observado después de una interrupción prolongada como un cambio de línea seguro.

Los mensajes describen altas y bajas **del feed publicado**, que es la evidencia disponible en SIRI; no prueban una baja administrativa ni el estado físico del vehículo si el operador deja de publicar datos. Las notificaciones quedan en una cola persistente hasta que la API de Telegram acepta el envío.

**Importante:** esta alerta detecta cambios de línea/destino/sentido asignados en los datos SIRI. No detecta todavía una desviación geográfica del autobús respecto al trazado de su línea; para eso habría que comparar su posición GPS con los shapes del GTFS y aplicar un margen de tolerancia.

### Bot independiente para autobuses de Burgos

El Worker independiente `cloudflare-worker-burgos` programa `.github/workflows/telegram-burgos.yml` cada dos minutos. GitHub Actions mantiene además una programación de respaldo cada cinco minutos. El detector compara primero la lista completa `resourceVehicles` de todas las líneas y usa las estimaciones por parada solo como fuente alternativa. Así detecta altas en el feed, ausencias confirmadas y cambios publicados de línea, destino o sentido; si la consulta de flota está incompleta o falla, conserva el estado anterior para no generar falsas bajas.

1. En [@BotFather](https://t.me/BotFather), crea un segundo bot con `/newbot` y guarda su token en privado.
2. Abre el bot nuevo en Telegram y envíale `/start`.
3. En el repositorio, entra en **Settings → Secrets and variables → Actions** y crea los secretos `BURGOS_TELEGRAM_BOT_TOKEN` (token del bot nuevo) y `BURGOS_TELEGRAM_CHAT_ID` (ID del chat personal donde tú recibirás avisos). No uses el ID del grupo comunitario salvo que quieras que todo el grupo reciba avisos comunes; cada miembro puede configurar su propia suscripción iniciando el bot en privado.
4. En Cloudflare, dentro del Worker independiente `burgos-sae-spotter`, crea el secreto `BURGOS_GITHUB_TOKEN` con permisos **Actions: Read and write** solamente sobre `enekituss/sae`; sirve para lanzar el detector cada dos minutos sin depender del Worker de Bizkaibus. Comprueba que `/health` devuelve `telegramScheduler.configured: true`.
5. En **Actions → Alertas Telegram · Autobuses de Burgos**, ejecuta **Run workflow** para la primera comprobación, o espera al siguiente ciclo programado.

Después, comparte el enlace [https://t.me/SAEBUR_bot](https://t.me/SAEBUR_bot) en tu grupo de comunidad. Los miembros deben pulsar **Iniciar** en el chat privado del bot para que se registren individualmente; no es necesario añadir el bot al grupo.

Envía `/start` o `/menu` a [@SAEBUR_bot](https://t.me/SAEBUR_bot) para abrir el menú individual. Cada persona debe iniciar el bot en su chat privado: sus preferencias se guardan por separado en la rama `telegram-data`. El menú dispone de todos los avisos, solo fuera de servicio, solo cambios de línea entre coches activos, nueva entrada/reaparición, seguimiento de varios coches por ID y pausa total de avisos. Para añadir varios coches, escribe sus ID separados por espacios o comas, o repite la opción de seguimiento; también funciona `/id 1101 1102`. `/misavisos` y `/estado` muestran el menú; `/stop` o `/pausar` detienen los avisos hasta reactivarlos. La modalidad se comprueba de nuevo antes del envío para no recibir alertas pendientes que ya no encajan con las preferencias actuales. Las horas de aviso se muestran en hora peninsular española. `burgos-telegram-state.json` conserva el estado del detector y la cola de avisos, y el token y preferencias de Burgos siguen separados de Bizkaibus.

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
- `burgos-vehicles.js` usa de forma predeterminada la URL fija `https://burgos-sae-spotter.ecanteroalvarez.workers.dev` y consulta cada línea por separado mediante `/api/burgos/vehicles?line=XX`, con un máximo de ocho peticiones simultáneas. La configuración solo acepta una URL alternativa si su `/health` identifica la versión del Worker específico de Burgos; una URL antigua o de Bizkaibus se ignora.
- La respuesta de `/api/burgos/vehicles?line=XX` también incluye las estimaciones ISAENEXT de esa línea, así que las próximas paradas se construyen con las mismas peticiones sin volver a consultar toda la red. Cuando la fuente publica segundos y metros, se muestra la llegada y distancia estimadas. El itinerario GTFS restante se abre en una **ventana emergente desplazable**; las próximas paradas se guardan temporalmente en la caché local del navegador. Solo la estimación de la primera parada se considera dato en directo.
- La lista muestra los identificadores y solo los campos adicionales que la fuente publique. Si alguna línea no responde, se conserva temporalmente su última respuesta y la cabecera indica que los datos son parciales.
- `scripts/update_burgos_gtfs.py` y `.github/workflows/update-burgos-gtfs.yml` mantienen `burgos-data.json` como fichero de horarios de referencia, pero la pantalla actual de Burgos ya no muestra el mapa ni la tabla GTFS.
- El Worker independiente `cloudflare-worker-burgos` expone la API por línea. La web ya lleva incorporada la URL base esperada de `burgos-sae-spotter`, por lo que no hace falta introducirla manualmente en cada navegador. El Worker `bizkaibus-sae-dispatcher` es distinto y continúa dedicado a sus tareas de Bizkaibus.
