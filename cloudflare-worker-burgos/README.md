# Worker independiente de SAE Spotter · Burgos

Este Worker sirve los datos municipales de los autobuses de Burgos y programa, cada dos minutos, el flujo `.github/workflows/telegram-burgos.yml`. Burgos usa su propio Worker, secreto de disparo y estado de alertas; no utiliza el Worker ni la base de datos de Bizkaibus. El Worker no guarda tokens de Telegram ni envía mensajes directamente: el workflow de GitHub detecta cambios y envía los avisos usando los secretos de Telegram del repositorio.

## Despliegue en Cloudflare

1. En Cloudflare abre **Workers & Pages → Create application → Import a repository**.
2. Conecta GitHub y elige `enekituss/sae`.
3. Como directorio raíz selecciona exactamente `cloudflare-worker-burgos`.
4. El nombre del Worker debe ser `burgos-sae-spotter`.
5. Despliega con `npx wrangler deploy` si Cloudflare solicita un comando de despliegue. La configuración ya declara el cron `*/2 * * * *`.
6. En **Settings → Variables and Secrets**, crea el secreto **`BURGOS_GITHUB_TOKEN`**. Usa un token de GitHub con acceso solo al repositorio `enekituss/sae` y permiso **Actions: Read and write**. No reutilices el secreto del Worker de Bizkaibus: este secreto pertenece al Worker independiente de Burgos.

El secreto `BURGOS_GITHUB_TOKEN` permite al cron lanzar el workflow de alertas cada dos minutos. Si falta o no tiene permisos, el Worker lo dejará reflejado en los logs y seguirá existiendo la programación de respaldo de GitHub Actions, que se ejecuta cada cinco minutos cuando GitHub puede atenderla.

## Comprobarlo

Abre la URL `workers.dev` asignada por Cloudflare:

- `/health`: debe devolver JSON con `"ok": true`, `apiVersion: "sae-three-resources-per-line-v6"` y `buildId: "burgos-live-v6.5-2026-10-19"`. La API permanece en v6 para conservar compatibilidad, así que hay que comprobar también `buildId`: si aparece una versión anterior, Cloudflare sigue usando un código desactualizado. El build v6.5 añade `formDate` y `_t` a cada consulta para evitar respuestas cacheadas, prioriza la URL canónica del portal ISAENEXT y conserva rutas alternativas si falla el acceso.
- Para desplegarlo manualmente, abre **Workers & Pages → `burgos-sae-spotter` → Edit code/Deployments** y despliega la última versión de `main`. Si usas despliegue mediante Wrangler, entra en el directorio raíz `cloudflare-worker-burgos` y ejecuta `npx wrangler deploy`. Después, vuelve a abrir `/health` y confirma que el `buildId` sea `burgos-live-v6.5-2026-10-19`.
- Para que el Worker dispare las alertas cada 2 minutos, `telegramScheduler.configured` debe ser `true`. Si es `false`, falta el secreto `BURGOS_GITHUB_TOKEN` en **Settings → Variables and Secrets** del Worker; las comprobaciones de respaldo de GitHub Actions siguen programadas cada 5 minutos.
- `/api/burgos/vehicles?line=01&fresh=1`: devuelve la lista de autobuses de `resourceVehicles` de la línea 01 sin esperar al trazado ni a las estimaciones.
- `/api/burgos/live?line=01&fresh=1`: consulta los tres recursos de esa línea y devuelve las observaciones de estimación para próximas paradas/itinerario.
- Para consultar toda la red, pide cada línea por separado (`01`–`23`, `73`, `87`–`89`, `C1`, `C2`). No se agrega toda la red dentro de una única invocación del Worker para respetar sus límites de subpeticiones.

La URL del Worker se introduce en SAE Spotter → Burgos → **Configurar conexión**. Pega la URL base, sin añadir rutas.

La vista primero carga la lista ligera de coches y después consulta `/api/burgos/live?line=XX` de forma independiente por línea. En esa segunda respuesta, enlaza el ID del coche + línea con cada estimación y el ID de la parada con su nombre/coordenadas del recorrido; esto alimenta el destino, la próxima parada y la llegada/distancia estimadas sin bloquear el listado inicial.

El monitor de alertas construye un snapshot por cada línea con el endpoint ligero `/api/burgos/vehicles?line=XX&fresh=1`, basado en `resourceVehicles`. Así puede detectar nuevos coches, ausencias confirmadas y cambios en los campos que el feed publique sin bloquearse si el recurso de trazado tarda demasiado. La web mantiene el enriquecimiento separado mediante `/api/burgos/live?line=XX&fresh=1`, que consulta `resourceRoutes`, `resourceVehicles` y `resourceEstimations` para recorrido, destino y próxima parada. Si falla cualquier línea del snapshot, el monitor conserva el estado previo y no genera alertas falsas. Solo se permite CORS para `https://enekituss.github.io`.

## Requisitos del bot de Telegram

En los secretos de **Settings → Secrets and variables → Actions** del repositorio `enekituss/sae` deben existir:

- `BURGOS_TELEGRAM_BOT_TOKEN`: token del bot de Burgos.
- `BURGOS_TELEGRAM_CHAT_ID`: chat principal donde recibir avisos.

El bot de Burgos es independiente de Bizkaibus: su estado y preferencias se guardan solo en `burgos-telegram-state.json` dentro de este repositorio. El monitor procesa los mensajes de Telegram mediante `getUpdates`; después de comprobar que el token corresponde a `@SAEBUR_bot`, retira cualquier webhook anterior para no depender del Worker de Bizkaibus. Los eventos confirmados incluyen autobuses nuevos en el feed, desapariciones tras varias comprobaciones y cambios publicados de línea, destino o sentido. Si una consulta municipal está incompleta o falla, se conserva el estado anterior para evitar falsas alertas.
