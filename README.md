# Bizkaibus SAE · Spotter

Web ligera para consultar las líneas y los vehículos Bizkaibus que aparecen como activos en el feed público SIRI de Open Data Bizkaia. La interfaz se centra en una lista agrupada por línea; no incluye mapa.

## Funciones
- Agrupación de vehículos detectados por línea.
- Contador de vehículos y líneas presentes en el feed.
- Listas desplegables por línea con identificador del vehículo, destino/sentido, última hora de posición y referencia de parada si está disponible.
- Búsqueda por línea, identificador de vehículo, destino o referencia de parada.
- Actualización automática cada 30 segundos y botón de actualización manual.
- Si la conexión directa falla por CORS, intenta leer el feed mediante AllOrigins como alternativa pública. Este servicio externo puede no estar disponible siempre.

## Fuente de datos
Feed de posiciones SIRI: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml

Solo se listan vehículos presentes en el feed en el momento de la consulta. No equivale necesariamente al total de vehículos que están circulando: puede haber vehículos que no estén reportando posición o campos que no vengan informados.

## Publicación
El sitio se publica mediante GitHub Pages desde la rama `main`, carpeta raíz (`/(root)`). Si la web devuelve 404 o no carga, comprueba en **Settings → Pages** que GitHub Pages esté activado y que la fuente de despliegue sea `main / (root)`.
