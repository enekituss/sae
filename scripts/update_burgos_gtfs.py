#!/usr/bin/env python3
"""Descarga el GTFS oficial de Burgos y publica una copia JSON compacta."""
import csv
import io
import json
import os
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SOURCE_URL = "https://www.aytoburgos.es/GTFS/Google_transit.zip"
OUTPUT = Path("burgos-data.json")
USER_AGENT = "SAE-Spotter/1.0 (+https://github.com/enekituss/sae)"


def download_feed():
    # La URL municipal a veces no responde desde GitHub Actions. En ese caso
    # utilizamos el archivo espejo de MobilityDatabase y mostramos su vigencia
    # real a partir de los calendarios incluidos en el propio ZIP.
    sources = [
        SOURCE_URL,
        "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-castile-and-leon-autobuses-urbanos-de-burgos-gtfs-3145.zip?alt=media",
    ]
    errors = []
    for url in sources:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/zip, application/octet-stream, */*",
            },
        )
        try:
            print(f"Intentando fuente GTFS: {url}")
            with urllib.request.urlopen(request, timeout=22) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                content = response.read()
            if not content.startswith(b"PK"):
                raise RuntimeError("la respuesta no parece un ZIP")
            print(f"Descarga correcta desde {url} ({len(content):,} bytes)")
            return content, url
        except Exception as exc:
            message = f"{url}: {type(exc).__name__}: {exc}"
            errors.append(message)
            print(f"No se pudo descargar esta fuente: {message}")
    raise RuntimeError("No se pudo obtener ningún GTFS. " + " | ".join(errors))

def read_rows(archive, filename, required=False):
    members = [name for name in archive.namelist()
               if name.rsplit("/", 1)[-1].lower() == filename.lower()]
    if not members:
        if required:
            raise RuntimeError(f"El fichero GTFS obligatorio {filename} no existe")
        return []
    with archive.open(members[0], "r") as raw:
        text_stream = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        return list(csv.DictReader(text_stream))


def clean(value):
    return (value or "").strip()


def main():
    print(f"Descargando {SOURCE_URL}")
    zipped, downloaded_from = download_feed()
    print(f"ZIP recibido: {len(zipped):,} bytes")
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        routes_raw = read_rows(archive, "routes.txt", required=True)
        stops_raw = read_rows(archive, "stops.txt", required=True)
        trips_raw = read_rows(archive, "trips.txt", required=True)
        stop_times_raw = read_rows(archive, "stop_times.txt", required=True)
        calendar_raw = read_rows(archive, "calendar.txt")
        exceptions_raw = read_rows(archive, "calendar_dates.txt")
        agency_raw = read_rows(archive, "agency.txt")
        shapes_raw = read_rows(archive, "shapes.txt")

    routes = []
    for row in routes_raw:
        route_id = clean(row.get("route_id"))
        if not route_id:
            continue
        routes.append({
            "id": route_id,
            "shortName": clean(row.get("route_short_name")),
            "longName": clean(row.get("route_long_name")),
            "description": clean(row.get("route_desc")),
            "type": clean(row.get("route_type")),
            "color": clean(row.get("route_color")),
            "textColor": clean(row.get("route_text_color")),
        })

    stops = []
    for row in stops_raw:
        stop_id = clean(row.get("stop_id"))
        if not stop_id:
            continue
        stops.append({
            "id": stop_id,
            "name": clean(row.get("stop_name")),
            "code": clean(row.get("stop_code")),
            "lat": clean(row.get("stop_lat")),
            "lon": clean(row.get("stop_lon")),
        })

    trips_by_id = {}
    for row in trips_raw:
        trip_id = clean(row.get("trip_id"))
        if not trip_id:
            continue
        trips_by_id[trip_id] = {
            "id": trip_id,
            "routeId": clean(row.get("route_id")),
            "serviceId": clean(row.get("service_id")),
            "headsign": clean(row.get("trip_headsign")),
            "directionId": clean(row.get("direction_id")),
            "blockId": clean(row.get("block_id")),
            "shortName": clean(row.get("trip_short_name")),
            "shapeId": clean(row.get("shape_id")),
            "stops": [],
        }

    # Each stop time is encoded compactly to avoid repeating names and fields:
    # [stop_id, arrival_time, departure_time, stop_sequence, timepoint]
    missing_trip_refs = 0
    for row in stop_times_raw:
        trip_id = clean(row.get("trip_id"))
        trip = trips_by_id.get(trip_id)
        if not trip:
            missing_trip_refs += 1
            continue
        stop_id = clean(row.get("stop_id"))
        if not stop_id:
            continue
        trip["stops"].append([
            stop_id,
            clean(row.get("arrival_time")),
            clean(row.get("departure_time")),
            clean(row.get("stop_sequence")),
            clean(row.get("timepoint")),
        ])
    trips = list(trips_by_id.values())
    for trip in trips:
        trip["stops"].sort(key=lambda item: int(item[3] or 0))

    # Shapes GTFS: needed to place live stop-distance estimates on the
    # correct route geometry. Keep only coordinates and sequence, not CSV rows.
    shapes_by_id = {}
    for row in shapes_raw:
        shape_id = clean(row.get("shape_id"))
        lat = clean(row.get("shape_pt_lat"))
        lon = clean(row.get("shape_pt_lon"))
        if not shape_id or not lat or not lon:
            continue
        shapes_by_id.setdefault(shape_id, []).append([
            lat,
            lon,
            clean(row.get("shape_pt_sequence")),
            clean(row.get("shape_dist_traveled")),
        ])
    shapes = []
    for shape_id, points in shapes_by_id.items():
        points.sort(key=lambda item: int(item[2] or 0))
        shapes.append({"id": shape_id, "points": points})

    calendar = []
    service_dates = []
    for row in calendar_raw:
        service_id = clean(row.get("service_id"))
        start_date = clean(row.get("start_date"))
        end_date = clean(row.get("end_date"))
        if not service_id:
            continue
        days = [
            clean(row.get("monday")) == "1",
            clean(row.get("tuesday")) == "1",
            clean(row.get("wednesday")) == "1",
            clean(row.get("thursday")) == "1",
            clean(row.get("friday")) == "1",
            clean(row.get("saturday")) == "1",
            clean(row.get("sunday")) == "1",
        ]
        calendar.append({
            "serviceId": service_id,
            "startDate": start_date,
            "endDate": end_date,
            "weekdays": days,
        })
        if start_date:
            service_dates.append(start_date)
        if end_date:
            service_dates.append(end_date)

    exceptions = []
    for row in exceptions_raw:
        service_id = clean(row.get("service_id"))
        date = clean(row.get("date"))
        exception_type = clean(row.get("exception_type"))
        if not service_id or not date or exception_type not in ("1", "2"):
            continue
        exceptions.append({
            "serviceId": service_id,
            "date": date,
            "exceptionType": int(exception_type),
        })
        service_dates.append(date)

    agency = []
    for row in agency_raw:
        if clean(row.get("agency_id")) or clean(row.get("agency_name")):
            agency.append({
                "id": clean(row.get("agency_id")),
                "name": clean(row.get("agency_name")),
                "timezone": clean(row.get("agency_timezone")),
                "url": clean(row.get("agency_url")),
            })

    service_start = min(service_dates) if service_dates else None
    service_end = max(service_dates) if service_dates else None
    payload = {
        "sourceUrl": downloaded_from,
        "producerUrl": SOURCE_URL,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "agency": agency,
        "serviceStart": service_start,
        "serviceEnd": service_end,
        "routes": sorted(routes, key=lambda item: (
            item["shortName"] or item["id"], item["id"]
        )),
        "stops": sorted(stops, key=lambda item: item["id"]),
        "trips": trips,
        "shapes": shapes,
        "calendar": calendar,
        "exceptions": exceptions,
        "stats": {
            "routeCount": len(routes),
            "stopCount": len(stops),
            "tripCount": len(trips),
            "shapeCount": len(shapes),
            "shapePointCount": sum(len(shape["points"]) for shape in shapes),
            "stopTimeCount": sum(len(trip["stops"]) for trip in trips),
            "missingTripRefs": missing_trip_refs,
            "zipBytes": len(zipped),
        },
    }

    temp = OUTPUT.with_suffix(".json.tmp")
    temp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temp.replace(OUTPUT)
    print(
        "Datos preparados: "
        f"{len(routes)} líneas, {len(stops)} paradas, {len(trips)} viajes, "
        f"{payload['stats']['stopTimeCount']} horarios de parada."
    )
    print(f"Vigencia del calendario declarada: {service_start} a {service_end}")
    if missing_trip_refs:
        print(f"Aviso: {missing_trip_refs} horarios referían viajes inexistentes; omitidos.")
    print(f"Archivo actualizado: {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
