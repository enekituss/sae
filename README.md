# Bizkaibus SAE · Spotter

Web ligera para consultar las líneas y los vehículos Bizkaibus que aparecen en el feed público SIRI de Open Data Bizkaia. La interfaz se centra en una lista agrupada por línea; no incluye mapa.

## Funciones
- Agrupación por línea y listado de identificadores de vehículos presentes en SIRI.
- Contador de registros y líneas detectadas.
- Información de destino/sentido, hora de posición y parada cuando el feed la incluye.
- Búsqueda por línea, ID de vehículo, destino o referencia de parada.
- La página carga `vehicles.json` desde el mismo dominio de GitHub Pages, sin intentar leer el XML directamente desde el navegador.
- GitHub Actions descarga el XML SIRI del lado del servidor, genera la copia `vehicles.json` y la actualiza automáticamente cada 5 minutos aproximadamente. También se puede iniciar manualmente desde la pestaña **Actions**.

## Por qué se publica una copia
Que el XML SIRI sea público y tenga una URL fija no garantiza que un navegador permita a JavaScript leerlo desde otra web: eso depende de la política CORS del servidor de origen. Por eso, un flujo de GitHub Actions consulta el feed y publica un JSON en este repositorio. La página lee ese JSON del mismo sitio, evitando ese bloqueo del navegador.

La actualización automática depende de GitHub Actions y puede retrasarse algunos minutos; la página consulta la copia publicada cada 30 segundos, pero esos sondeos no implican que el XML de origen se haya descargado en cada ocasión.

## Fuente de datos
Feed de posiciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml

Solo se listan registros presentes en el feed. El origen puede no incluir todas las unidades que estén circulando ni informar todos los campos; cuando no viene un identificador de vehículo, la web lo señala y no lo presenta como un ID confirmado.

## Publicación
El sitio se publica mediante GitHub Pages desde la rama `main`, carpeta raíz (`/(root)`). Si la web devuelve 404 o no carga, comprueba en **Settings → Pages** que GitHub Pages esté activado y que la fuente de despliegue sea `main / (root)`.

La tarea automática está en `.github/workflows/update-siri.yml`. Ejecución manual: https://github.com/enekituss/sae/actions
