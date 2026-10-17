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
