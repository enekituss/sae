# Worker independiente de SAE Spotter · Burgos

Este Worker se dedica únicamente a consultar la lista de autobuses urbanos de Burgos publicada por el servicio municipal ISAENEXT. No ejecuta la tarea programada de Bizkaibus ni necesita secretos de GitHub o Telegram.

## Despliegue en Cloudflare

1. En Cloudflare abre **Workers & Pages → Create application → Import a repository**.
2. Conecta GitHub y elige `enekituss/sae`.
3. Como directorio raíz selecciona exactamente `cloudflare-worker-burgos`.
4. El nombre del Worker debe ser `burgos-sae-spotter`.
5. Deja vacío el comando de compilación y usa `npx wrangler deploy` como comando de despliegue si el asistente lo solicita.
6. Pulsa **Save and Deploy**. No necesitas configurar `GITHUB_TOKEN`, Telegram ni una programación cron para este Worker.

## Comprobarlo

Abre la URL `workers.dev` asignada por Cloudflare:

- `/health`: debe devolver JSON con `"ok": true`.
- `/api/burgos/vehicles?line=01`: devuelve la lista publicada para la línea 01.
- `/api/burgos/vehicles`: intenta consultar todas las líneas conocidas.

La URL del Worker se introduce en SAE Spotter → Burgos → **Configurar conexión**. Pega la URL base, sin añadir rutas.

La fuente es el recurso público `resourceVehicles` de ISAENEXT. Si el origen municipal no responde, la API devuelve un error explicativo y no inventa autobuses. Solo se permite CORS para `https://enekituss.github.io`.
