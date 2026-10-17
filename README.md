# Bizkaibus SAE · Spotter

Web para localizar vehículos Bizkaibus a partir del feed público SIRI de Open Data Bizkaia.

## Funciones actuales
- Mapa Leaflet con posiciones GPS.
- Agrupación automática por línea.
- Número de vehículos detectados por línea.
- Buscador por línea o vehículo.
- Ficha de vehículo con línea, sentido, hora y parada.
- Actualización automática cada 30 segundos.

## Fuente
Feed oficial: https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml

Los datos publicados por Open Data Bizkaia incluyen identificadores de vehículo (`VehicleRef`), posición, línea/sentido cuando están disponibles y marcas temporales. El feed está en formato SIRI/XML y se publica bajo CC BY 4.0.

## Próximos pasos
1. Comprobar CORS del feed en GitHub Pages.
2. Si el navegador bloquea el XML, añadir un proxy mediante GitHub Actions.
3. Incorporar catálogo completo de líneas y paradas desde los recursos NETEX.
4. Añadir filtros por línea, sentido y estado.
5. Añadir base de datos manual de matrícula/modelo/número de flota para spotting.
6. Guardar histórico de apariciones para saber cuándo se ha visto cada vehículo.
