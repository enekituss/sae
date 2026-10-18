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
- `/api/burgos/live`: consulta las estimaciones por parada de ISAENEXT e incluye `observations` con ID de vehículo, línea, parada, segundos y metros estimados cuando el origen los publica.

La URL del Worker se introduce en SAE Spotter → Burgos → **Configurar conexión**. Pega la URL base, sin añadir rutas.

La fuente de flota es el recurso público `resourceVehicles`; las próximas paradas se obtienen del recurso `resourceEstimations` por parada. La página asocia las estimaciones al ID de vehículo y la línea y elige la parada con menor tiempo estimado no negativo. Las estimaciones pueden no estar disponibles para todos los coches; el visor no inventa paradas. Solo se permite CORS para `https://enekituss.github.io`.
