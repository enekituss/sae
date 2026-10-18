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

- `/health`: debe devolver JSON con `"ok": true`, `apiVersion: "sae-three-resources-per-line-v1"` y `telegramScheduler.configured: true`. Si falta `apiVersion`, Cloudflare no está ejecutando todavía la revisión más reciente: despliega la última versión del directorio `cloudflare-worker-burgos`.
- `/api/burgos/vehicles?line=01&fresh=1`: consulta la línea 01 en los tres recursos del SAE.
- `/api/burgos/live?line=01&fresh=1`: devuelve las observaciones de estimación de una línea.
- Para consultar toda la red, pide cada línea por separado (`01`–`23`, `73`, `87`–`89`, `C1`, `C2`). No se agrega toda la red dentro de una única invocación del Worker para respetar sus límites de subpeticiones.

La URL del Worker se introduce en SAE Spotter → Burgos → **Configurar conexión**. Pega la URL base, sin añadir rutas.

El monitor utiliza el endpoint oficial `https://movilidad.aytoburgos.es/es/rutas-en-directo` y consulta por cada línea los tres recursos: `resourceRoutes` (recorrido/IDs de parada), `resourceVehicles` (coches publicados) y `resourceEstimations` (destino y próxima parada). Para `resourceRoutes` y `resourceVehicles` incluye tanto `_as_asac_isaenext_IsaenextWebPortlet_line` como `_as_asac_isaenext_IsaenextWebPortlet_label`; para `resourceEstimations` añade `line`, `tipo=1` y los IDs de parada del recorrido. Compara los IDs, la línea, el destino y el sentido entre snapshots completos. Si falla una línea, conserva el estado anterior y no genera alertas falsas. Solo se permite CORS para `https://enekituss.github.io`.

## Requisitos del bot de Telegram

En los secretos de **Settings → Secrets and variables → Actions** del repositorio `enekituss/sae` deben existir:

- `BURGOS_TELEGRAM_BOT_TOKEN`: token del bot de Burgos.
- `BURGOS_TELEGRAM_CHAT_ID`: chat principal donde recibir avisos.

El workflow también lee las preferencias individuales de la rama `telegram-data` y conserva el estado del detector en `burgos-telegram-state.json`. Los eventos confirmados incluyen autobuses nuevos en el feed, desapariciones tras varias comprobaciones y cambios publicados de línea, destino o sentido. Si una consulta municipal está incompleta o falla, se conserva el estado anterior para evitar falsas alertas de bajas.
