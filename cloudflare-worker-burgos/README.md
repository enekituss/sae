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

- `/health`: debe devolver JSON con `"ok": true` y `telegramScheduler.configured: true`.
- `/api/burgos/vehicles?line=01`: devuelve la lista publicada para la línea 01.
- `/api/burgos/vehicles`: intenta consultar todas las líneas conocidas.
- `/api/burgos/live`: consulta las estimaciones por parada de ISAENEXT e incluye `observations` con ID de vehículo, línea, parada, segundos y metros estimados cuando el origen los publica.

La URL del Worker se introduce en SAE Spotter → Burgos → **Configurar conexión**. Pega la URL base, sin añadir rutas.

La fuente de flota es el recurso público `resourceVehicles`; las próximas paradas se obtienen del recurso `resourceEstimations` por parada. La página asocia las estimaciones al ID de vehículo y la línea y elige la parada con menor tiempo estimado no negativo. Las estimaciones pueden no estar disponibles para todos los coches; el visor no inventa paradas. Solo se permite CORS para `https://enekituss.github.io`.

## Requisitos del bot de Telegram

En los secretos de **Settings → Secrets and variables → Actions** del repositorio `enekituss/sae` deben existir:

- `BURGOS_TELEGRAM_BOT_TOKEN`: token del bot de Burgos.
- `BURGOS_TELEGRAM_CHAT_ID`: chat principal donde recibir avisos.

El workflow también lee las preferencias individuales de la rama `telegram-data` y conserva el estado del detector en `burgos-telegram-state.json`. Los eventos confirmados incluyen autobuses nuevos en el feed, desapariciones tras varias comprobaciones y cambios publicados de línea, destino o sentido. Si una consulta municipal está incompleta o falla, se conserva el estado anterior para evitar falsas alertas de bajas.
