# Programador rápido de Bizkaibus SAE

Este Worker no descarga ni modifica los datos por su cuenta: despierta el flujo de GitHub Actions cada dos minutos. El flujo existente sigue siendo la única fuente de datos procesados para `vehicles.json`, la web y la cola de avisos de Telegram.

## Configuración necesaria (una sola vez)

### 1. Crear un token de GitHub limitado al repositorio

1. Abre https://github.com/settings/personal-access-tokens/new
2. Crea un **Fine-grained personal access token**.
3. Selecciona como propietario `enekituss` y limita el acceso al repositorio `sae`.
4. En permisos del repositorio, concede **Actions: Read and write**. Conserva también el permiso Metadata de solo lectura que GitHub exige.
5. Crea el token y cópialo temporalmente en un lugar seguro. **No lo pegues en el código, en un issue ni en un chat.** Este token de GitHub es distinto del token del bot de Telegram.

### 2. Crear el Worker conectado a este repositorio

1. Entra en https://dash.cloudflare.com/ y abre **Workers & Pages**.
2. Pulsa **Create application** y elige **Import a repository**.
3. Conecta GitHub y selecciona `enekituss/sae`.
4. Pon como **Root directory** exactamente `cloudflare-worker`.
5. Comprueba que el nombre del Worker sea `bizkaibus-sae-dispatcher`, que no hace falta comando de compilación y que el comando de despliegue sea `npx wrangler deploy`.
6. Guarda y despliega.

### 3. Guardar el token como secreto

En el Worker recién creado, abre **Settings → Variables and Secrets** (la denominación puede variar ligeramente), añade una variable de tipo **Secret** con nombre `GITHUB_TOKEN` y pega el token de GitHub. Guarda el cambio.

No configures aquí el token de Telegram: los mensajes continúan enviándose desde el flujo de GitHub Actions, usando sus secretos `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.

### 4. Verificar el Worker

Abre la URL `workers.dev` que Cloudflare asignó, añadiendo `/health`. Debería aparecer un JSON con `"ok": true` y una cadencia `*/2 * * * *`.

Después, en **Logs / Observability**, comprueba que en el siguiente ciclo aparezca el mensaje de que se ha solicitado una actualización de GitHub Actions. Si aparece un error de permisos, revisa que el token sea para el repositorio correcto y tenga `Actions: Read and write`.

## Importante: activación por etapas

El flujo de GitHub Actions mantiene su programación actual de cinco minutos como respaldo durante la configuración. Cuando se compruebe que este Worker ya está disparando ejecuciones correctamente, se debe retirar la programación nativa de cinco minutos para evitar comprobaciones redundantes. No la quites antes de verificar el Worker.

El Worker también comprueba si hay una ejecución del mismo flujo en cola o en curso; si la hay, omite ese ciclo para no acumular ejecuciones. La hora real de publicación depende de cuánto tarde GitHub Actions en descargar y procesar los feeds y publicar los archivos.


## Proxy de información en directo de Burgos

El mismo Worker incluye ahora dos endpoints públicos, sin credenciales adicionales:
- `/api/burgos/nodes`: devuelve las paradas que publica el visor ISAENEXT.
- `/api/burgos/estimates?stopId=200`: consulta las estimaciones que publica el visor para una parada concreta (el ejemplo usa el identificador 200).

La respuesta de estimaciones puede incluir línea, destino, segundos estimados hasta la parada, distancia e identificador de vehículo. El visor no debe tratar estos campos como coordenadas GPS individuales; el endpoint de estimaciones por parada no es un feed de posiciones GPS.

Tras desplegar el Worker, prueba primero `/health`, después `/api/burgos/nodes` y por último `/api/burgos/estimates?stopId=200`. Si ISAENEXT responde con timeout o un formato distinto, el endpoint devuelve un error JSON en vez de inventar información.

El proxy permite peticiones desde `https://enekituss.github.io` mediante CORS. Otros orígenes no reciben permiso CORS.


## Coches urbanos de Burgos por línea

El Worker incorpora `GET /api/burgos/vehicles`, que usa el recurso municipal `resourceVehicles` para consultar los coches publicados de las 29 líneas urbanas conocidas. Combina las respuestas con concurrencia limitada e incluye el identificador de coche, la línea asignada y los campos de posición que publique el servicio.

También permite consultar una sola línea, por ejemplo `GET /api/burgos/vehicles?line=01`. Las líneas admitidas son `01`–`23`, `73`, `87`, `88`, `89`, `C1` y `C2`. La respuesta incluye `vehicles`, `count`, `lineCount`, `totalLines`, `partial` y `warnings`. Se aplica una caché breve para evitar consultas repetidas al origen.

El origen del recurso es `https://www.aytoburgos.es/web/movilidad/rutas-en-directo`, con los parámetros de portlet `resourceVehicles`, `line` y `label`. La web SAE Spotter intenta primero este recurso de vehículos, y usa la API de estimaciones por parada como respaldo si la consulta falla. Solo se dibujan posiciones si hay coordenadas válidas; los datos de vehículos sin coordenadas se mantienen en el listado.

## API opcional de estimaciones y vehículos de Burgos

El endpoint `GET /api/burgos/live` continúa disponible para consultas auxiliares: consulta las estimaciones de ISAENEXT para las paradas municipales en grupos pequeños y con concurrencia limitada. La respuesta puede contener línea, identificador de vehículo, destino y distancia/tiempo estimados hasta una parada. No es un feed de posiciones GPS individuales.

La página principal de Burgos en SAE Spotter ya no depende de este Worker. Su listado de líneas y autobuses activos consulta el recurso `resourceVehicles` por línea usando los proxies de acceso que también emplea SAMYT, con refresco aproximado cada 60 segundos. Así no intenta leer directamente el dominio municipal desde el navegador, donde Chrome puede bloquear la petición por CORS.

Para probar manualmente las API del Worker, usa `https://TU-WORKER.workers.dev/api/burgos/vehicles`, `https://TU-WORKER.workers.dev/api/burgos/vehicles?line=01` y `https://TU-WORKER.workers.dev/api/burgos/live`. Las dos primeras respuestas deben contener `vehicles`; la última, `observations`. Los fallos parciales por línea se indican en `warnings`.
