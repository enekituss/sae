const BURGOS_SOURCE = "https://www.aytoburgos.es/web/movilidad/rutas-en-directo";
const PORTLET_ID = "as_asac_isaenext_IsaenextWebPortlet";
const PORTLET_PREFIX = "_as_asac_isaenext_IsaenextWebPortlet_";
const ALLOWED_ORIGIN = "https://enekituss.github.io";
const BURGOS_LINES = [
  ...Array.from({ length: 23 }, (_, i) => String(i + 1).padStart(2, "0")),
  "73", "87", "88", "89", "C1", "C2"
];

function responseHeaders(request, extra = {}) {
  const headers = new Headers(extra);
  if (request.headers.get("Origin") === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  }
  return headers;
}

function jsonResponse(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders(request, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra
    })
  });
}

function vehicleUrl(line) {
  const timestamp = String(Date.now());
  const url = new URL(BURGOS_SOURCE);
  url.searchParams.set("p_p_id", PORTLET_ID);
  url.searchParams.set("p_p_lifecycle", "2");
  url.searchParams.set("p_p_state", "normal");
  url.searchParams.set("p_p_mode", "view");
  url.searchParams.set("p_p_cacheability", "cacheLevelPage");
  url.searchParams.set("p_p_resource_id", "resourceVehicles");
  url.searchParams.set(PORTLET_PREFIX + "formDate", timestamp);
  url.searchParams.set(PORTLET_PREFIX + "line", line);
  url.searchParams.set(PORTLET_PREFIX + "label", line);
  url.searchParams.set("_t", timestamp);
  return url;
}

async function fetchVehiclesForLine(line) {
  const response = await fetch(vehicleUrl(line).toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter-Burgos/1.0)",
      "Referer": BURGOS_SOURCE
    },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("ISAENEXT respondió HTTP " + response.status + " para la línea " + line + ".");
  }

  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("ISAENEXT no devolvió JSON para la línea " + line + ".");
  }
  if (!Array.isArray(rows)) {
    throw new Error("ISAENEXT no devolvió una lista para la línea " + line + ".");
  }

  return rows.map(vehicle => ({
    ...vehicle,
    id: String(vehicle?.id ?? vehicle?.vehicleId ?? vehicle?.vehicle_id ?? "").trim(),
    lineId: line
  })).filter(vehicle => vehicle.id);
}

async function fetchSnapshot() {
  const results = new Array(BURGOS_LINES.length);
  const errors = [];
  let cursor = 0;
  const concurrency = Math.min(5, BURGOS_LINES.length);

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= BURGOS_LINES.length) return;
      const line = BURGOS_LINES[index];
      try {
        results[index] = await fetchVehiclesForLine(line);
      } catch (error) {
        results[index] = null;
        errors.push({ line, error: error?.message || String(error) });
      }
    }
  }));

  const completed = results.filter(Array.isArray);
  if (!completed.length) {
    throw new Error("No se pudo consultar ninguna línea de Burgos. " +
      errors.slice(0, 3).map(item => item.error).join(" "));
  }

  const byId = new Map();
  results.forEach(rows => {
    if (!Array.isArray(rows)) return;
    rows.forEach(vehicle => byId.set(vehicle.id, vehicle));
  });

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: BURGOS_SOURCE,
    sourceType: "ISAENEXT · resourceVehicles por línea",
    lineCount: completed.length,
    totalLines: BURGOS_LINES.length,
    partial: errors.length > 0,
    failedLines: errors.map(item => item.line),
    warnings: errors.slice(0, 5).map(item => "Línea " + item.line + ": " + item.error),
    count: byId.size,
    vehicles: [...byId.values()]
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(request, { "Access-Control-Max-Age": "86400" })
      });
    }
    if (request.method !== "GET") {
      return jsonResponse(request, { ok: false, error: "Método no permitido. Usa GET." }, 405);
    }

    if (url.pathname === "/health") {
      return jsonResponse(request, {
        ok: true,
        service: "SAE Spotter · proxy independiente de Burgos",
        source: BURGOS_SOURCE,
        lines: BURGOS_LINES.length,
        endpoints: ["/api/burgos/vehicles", "/api/burgos/vehicles?line=01"]
      });
    }

    if (url.pathname !== "/api/burgos/vehicles") {
      return jsonResponse(request, { ok: false, error: "Ruta no encontrada." }, 404);
    }

    const requestedLine = (url.searchParams.get("line") || "").trim().toUpperCase();
    if (requestedLine && !BURGOS_LINES.includes(requestedLine)) {
      return jsonResponse(request, {
        ok: false,
        error: "Línea no válida.",
        allowedLines: BURGOS_LINES
      }, 400);
    }

    const cache = caches.default;
    const cacheKey = new URL("/__cache/burgos-vehicles?line=" +
      encodeURIComponent(requestedLine || "all"), url.origin);
    const cacheRequest = new Request(cacheKey.toString(), { method: "GET" });

    try {
      const cached = await cache.match(cacheRequest);
      if (cached) {
        const data = await cached.json();
        return jsonResponse(request, { ...data, cacheHit: true }, 200, {
          "Cache-Control": "public, max-age=10"
        });
      }
    } catch {
      // Un fallo de caché no debe impedir la consulta a la fuente.
    }

    try {
      let data;
      if (requestedLine) {
        const vehicles = await fetchVehiclesForLine(requestedLine);
        data = {
          ok: true,
          fetchedAt: new Date().toISOString(),
          source: BURGOS_SOURCE,
          sourceType: "ISAENEXT · resourceVehicles por línea",
          line: requestedLine,
          lineCount: 1,
          totalLines: 1,
          partial: false,
          failedLines: [],
          warnings: [],
          count: vehicles.length,
          vehicles
        };
      } else {
        data = await fetchSnapshot();
      }

      try {
        await cache.put(cacheRequest, new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=10"
          }
        }));
      } catch {
        // La respuesta sigue siendo válida si no se puede guardar en caché.
      }

      return jsonResponse(request, data, 200, { "Cache-Control": "public, max-age=10" });
    } catch (error) {
      return jsonResponse(request, {
        ok: false,
        error: error?.message || "No se pudieron consultar los autobuses de Burgos.",
        source: BURGOS_SOURCE,
        fetchedAt: new Date().toISOString()
      }, 502);
    }
  }
};
