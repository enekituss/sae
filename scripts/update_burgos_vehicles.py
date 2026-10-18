#!/usr/bin/env python3
"""Descarga los autobuses activos de Burgos por línea desde ISAENEXT.

El resultado es una copia estática consumible desde GitHub Pages. Así el navegador
no consulta directamente al Ayuntamiento ni depende de CORS/Cloudflare Worker.
Este script está conectado a la actualización automática de autobuses de Burgos.
"""
import concurrent.futures
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCE_URL = "https://www.aytoburgos.es/web/movilidad/rutas-en-directo"
PORTLET_ID = "as_asac_isaenext_IsaenextWebPortlet"
PORTLET_PREFIX = "_as_asac_isaenext_IsaenextWebPortlet_"
OUTPUT = Path("burgos-vehicles.json")
USER_AGENT = "Mozilla/5.0 (compatible; SAE-Spotter/1.0)"
LINES = [f"{number:02d}" for number in range(1, 24)] + ["73", "87", "88", "89", "C1", "C2"]
MAX_WORKERS = 8
TIMEOUT_SECONDS = 8
PROXIES = [
    ("corsproxy.io", lambda url: "https://corsproxy.io/?" + urllib.parse.quote(url, safe="")),
    ("allorigins", lambda url: "https://api.allorigins.win/raw?url=" + urllib.parse.quote(url, safe="")),
    ("codetabs", lambda url: "https://api.codetabs.com/v1/proxy?quest=" + urllib.parse.quote(url, safe="")),
]


def first_text(item, *keys):
    for key in keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def number_or_none(item, *keys):
    for key in keys:
        value = item.get(key)
        if value is None or str(value).strip() == "":
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number == number and abs(number) != float("inf"):
            return number
    return None


def build_url(line):
    params = {
        "p_p_id": PORTLET_ID,
        "p_p_lifecycle": "2",
        "p_p_state": "normal",
        "p_p_mode": "view",
        "p_p_cacheability": "cacheLevelPage",
        "p_p_resource_id": "resourceVehicles",
        PORTLET_PREFIX + "formDate": str(int(time.time() * 1000)),
        PORTLET_PREFIX + "line": line,
        PORTLET_PREFIX + "label": line,
        "_t": str(int(time.time() * 1000)),
    }
    return SOURCE_URL + "?" + urllib.parse.urlencode(params)


def fetch_line(line):
    url = build_url(line)
    candidates = [("directo", url)]
    candidates.extend((name, make_url(url)) for name, make_url in PROXIES)
    errors = []

    for source_name, target_url in candidates:
        request = urllib.request.Request(
            target_url,
            headers={
                "Accept": "application/json, text/plain, */*",
                "User-Agent": USER_AGENT,
                "Cache-Control": "no-cache",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                body = response.read().decode("utf-8-sig")
            payload = json.loads(body)
            if not isinstance(payload, list):
                raise ValueError("la respuesta no es una lista JSON")
            vehicles = []
            skipped_without_id = 0
            for item in payload:
                if not isinstance(item, dict):
                    continue
                vehicle_id = first_text(
                    item, "id", "vehicleId", "vehicle_id", "vehicle", "vehiculo",
                    "vehicleNumber", "number", "fleetNumber", "calca"
                )
                if not vehicle_id:
                    skipped_without_id += 1
                    continue
                vehicles.append({
                    "id": vehicle_id,
                    "line": line,
                    "destination": first_text(item, "destination", "destino", "headsign", "destinationName", "destiny"),
                    "direction": first_text(item, "direction", "sentido", "direccion"),
                    "time": first_text(item, "time", "timestamp", "updatedAt", "lastUpdate", "lastPositionTime"),
                    "lat": number_or_none(item, "lat", "latitude"),
                    "lng": number_or_none(item, "lng", "lon", "longitude"),
                    "nextStop": first_text(item, "paradaProxima", "nextNodeId", "nextStop", "stopId", "stop_id"),
                    "route": first_text(item, "ruta", "route", "routeId", "route_id"),
                    "model": first_text(item, "model", "modelo", "vehicleModel"),
                    "registration": first_text(item, "matricula", "registration", "plate", "licensePlate"),
                })
            if source_name != "directo":
                print(f"Línea {line}: consulta completada mediante el proxy {source_name}.")
            return {
                "line": line,
                "vehicles": vehicles,
                "receivedCount": len(payload),
                "skippedWithoutId": skipped_without_id,
                "ok": True,
                "via": source_name,
            }
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError) as exc:
            errors.append(source_name + ": " + str(exc))
            print(f"Línea {line}: falló {source_name}; se prueba la siguiente fuente.")

    raise RuntimeError(f"Línea {line}: fallaron todas las fuentes. " + " | ".join(errors[-3:]))


def main():
    results = {}
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        future_lines = {pool.submit(fetch_line, line): line for line in LINES}
        for future in concurrent.futures.as_completed(future_lines):
            line = future_lines[future]
            try:
                results[line] = future.result()
                print(f"Línea {line}: {len(results[line]['vehicles'])} autobuses publicados.")
            except Exception as exc:
                errors.append(str(exc))
                print("ERROR: " + str(exc))

    # Publicar solo un snapshot completo. Si falla una línea, se conserva la
    # copia anterior para no dar una desaparición falsa de autobuses.
    if errors:
        raise RuntimeError(
            f"No se publica el snapshot: fallaron {len(errors)}/{len(LINES)} líneas. "
            + " | ".join(errors[:5])
        )
    if len(results) != len(LINES):
        raise RuntimeError(f"Snapshot incompleto: {len(results)}/{len(LINES)} líneas.")

    vehicles = []
    counts_by_line = []
    for line in LINES:
        rows = results[line]["vehicles"]
        counts_by_line.append({"line": line, "vehicleCount": len(rows)})
        vehicles.extend(rows)

    # El mismo coche podría aparecer en más de una respuesta por una transición
    # de línea. Conservamos el último registro recibido para cada ID.
    unique = {}
    for vehicle in vehicles:
        unique[vehicle["id"]] = vehicle
    vehicles = sorted(
        unique.values(),
        key=lambda item: (
            item["line"].casefold(),
            item["id"].casefold()
        )
    )
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    snapshot = {
        "schemaVersion": 1,
        "source": SOURCE_URL,
        "resource": "resourceVehicles",
        "fetchedAt": now,
        "lineCount": sum(1 for row in counts_by_line if row["vehicleCount"] > 0),
        "linesQueried": len(LINES),
        "vehicleCount": len(vehicles),
        "vehicles": vehicles,
        "lineCounts": counts_by_line,
        "note": "La presencia en resourceVehicles indica que el autobús aparece en el listado municipal; no es una confirmación independiente de su estado administrativo.",
    }
    OUTPUT.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        f"Publicado {OUTPUT}: {snapshot['vehicleCount']} coches en "
        f"{snapshot['lineCount']} líneas activas; consultas completas {len(LINES)}/{len(LINES)}."
    )


if __name__ == "__main__":
    main()
