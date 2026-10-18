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


// ISAENEXT devuelve estimaciones por parada, no siempre una parada siguiente
// explícita dentro de resourceVehicles. Estas observaciones permiten asociar
// cada coche con su próxima parada y el tiempo/distancia estimados.
const BURGOS_LIVE_SOURCE = "https://movilidad.aytoburgos.es/rutas-en-directo";

function liveUrl(resource, extra = {}) {
  const url = new URL(BURGOS_LIVE_SOURCE);
  url.searchParams.set("p_p_id", PORTLET_ID);
  url.searchParams.set("p_p_lifecycle", "2");
  url.searchParams.set("p_p_state", "normal");
  url.searchParams.set("p_p_mode", "view");
  url.searchParams.set("p_p_cacheability", "cacheLevelPage");
  url.searchParams.set("p_p_resource_id", resource);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url;
}

async function fetchLiveJson(url) {
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter-Burgos/1.0)",
      "Referer": BURGOS_LIVE_SOURCE
    },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("ISAENEXT respondió HTTP " + response.status + ".");
  try { return JSON.parse(body); }
  catch { throw new Error("ISAENEXT no devolvió JSON reconocible."); }
}

function readLiveNodeId(node) {
  return String(node?.num ?? node?.id ?? node?.stopId ?? node?.nodeId ??
    node?.nodoId ?? node?.idNodo ?? node?.numNodo ?? "").trim();
}

function normalizeLiveObservations(nodes, results) {
  const nodeById = new Map(nodes.map(node => [readLiveNodeId(node), node]));
  const observations = [];
  const rows = Array.isArray(results) ? results : [];

  rows.forEach((result, resultIndex) => {
    const explicitId = readLiveNodeId(result);
    let stopId = explicitId;
    let node = nodeById.get(explicitId) || null;

    // Algunas versiones no devuelven el ID de la parada en cada objeto,
    // pero devuelven un resultado por nodo y mantienen el mismo orden.
    if (!node && rows.length === nodes.length && nodes[resultIndex]) {
      node = nodes[resultIndex];
      stopId = readLiveNodeId(node);
    }
    if (!node) node = result;

    const routeGroups = result?.routeEstimationByNode || result?.routes || [];
    for (const routeGroup of routeGroups) {
      const line = String(routeGroup?.line ?? routeGroup?.route ?? routeGroup?.lineName ?? "").trim();
      const estimates = routeGroup?.publicEstimationVHExts ||
        routeGroup?.estimations || routeGroup?.buses || [];
      for (const item of estimates) {
        const id = String(item?.vehicle ?? item?.vehicleId ?? item?.vehicle_id ?? "").trim();
        const secondsRaw = item?.seconds;
        const metersRaw = item?.meters;
        const secondsNum = secondsRaw === null || secondsRaw === undefined || secondsRaw === "" ? NaN : Number(secondsRaw);
        const metersNum = metersRaw === null || metersRaw === undefined || metersRaw === "" ? NaN : Number(metersRaw);
        const lat = Number(item?.lat ?? item?.latitude);
        const lon = Number(item?.lon ?? item?.lng ?? item?.longitude);
        observations.push({
          vehicleId: id && id !== "0" ? id : "",
          line,
          destination: String(item?.destination ?? "").trim(),
          seconds: Number.isFinite(secondsNum) ? secondsNum : null,
          meters: Number.isFinite(metersNum) ? metersNum : null,
          stopId,
          stopName: String(node?.name ?? node?.stop_name ?? node?.nombre ?? "").trim(),
          stopLat: Number(node?.lat ?? node?.latitude),
          stopLon: Number(node?.lng ?? node?.lon ?? node?.longitude),
          vehicleLat: Number.isFinite(lat) && lat >= 42 && lat <= 43 ? lat : null,
          vehicleLon: Number.isFinite(lon) && lon >= -4 && lon <= -3 ? lon : null
        });
      }
    }
  });
  return observations;
}

async function fetchLiveSnapshot() {
  const nodesPayload = await fetchLiveJson(liveUrl("resourceNodes"));
  if (!Array.isArray(nodesPayload) || !nodesPayload.length) {
    throw new Error("ISAENEXT no devolvió la lista de paradas.");
  }
  const nodes = nodesPayload.filter(node => readLiveNodeId(node));
  const chunks = [];
  // Keep the query URL size conservative while allowing more batches to run in parallel.
  for (let i = 0; i < nodes.length; i += 50) chunks.push(nodes.slice(i, i + 50));

  const results = new Array(chunks.length);
  const errors = [];
  let cursor = 0;
  const concurrency = Math.min(8, chunks.length);

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      try {
        const payload = await fetchLiveJson(liveUrl("resourceEstimations", {
          "_as_asac_isaenext_IsaenextWebPortlet_tipo": "1",
          "_as_asac_isaenext_IsaenextWebPortlet_nodoIds": chunk.map(readLiveNodeId).join(",")
        }));
        if (!Array.isArray(payload)) throw new Error("respuesta de estimaciones no reconocible");
        if (payload.length === 1 && chunk.length > 2) {
          throw new Error("ISAENEXT sólo devolvió un resultado para un grupo de " + chunk.length + " paradas");
        }
        results[index] = { nodes: chunk, rows: payload };
      } catch (error) {
        results[index] = null;
        errors.push("grupo " + (index + 1) + ": " + (error?.message || String(error)));
      }
    }
  }));

  const complete = results.filter(Boolean);
  if (!complete.length) {
    throw new Error("No se pudo consultar ninguna tanda de estimaciones. " + errors.slice(0, 3).join(" | "));
  }
  const observations = [];
  let resultCount = 0;
  for (const result of complete) {
    resultCount += result.rows.length;
    observations.push(...normalizeLiveObservations(result.nodes, result.rows));
  }

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: BURGOS_LIVE_SOURCE,
    sourceType: "ISAENEXT · estimaciones por parada",
    stopCount: nodes.length,
    resultCount,
    completedGroups: complete.length,
    totalGroups: chunks.length,
    partial: errors.length > 0,
    warnings: errors.slice(0, 5),
    observations
  };
}

const LIVE_CACHE_TTL_SECONDS = 300;
const LIVE_REFRESH_AFTER_MS = 45 * 1000;
let liveSnapshotRefreshPromise = null;

async function refreshLiveSnapshotCache(cache, cacheRequest) {
  if (liveSnapshotRefreshPromise) return liveSnapshotRefreshPromise;
  const promise = (async () => {
    const data = await fetchLiveSnapshot();
    try {
      await cache.put(cacheRequest, new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=" + LIVE_CACHE_TTL_SECONDS
        }
      }));
    } catch {
      // The fetched snapshot remains usable even if the edge cache is unavailable.
    }
    return data;
  })();
  liveSnapshotRefreshPromise = promise;
  try {
    return await promise;
  } finally {
    if (liveSnapshotRefreshPromise === promise) liveSnapshotRefreshPromise = null;
  }
}

export default {
  async fetch(request, env, ctx) {
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
        endpoints: ["/api/burgos/vehicles", "/api/burgos/vehicles?line=01", "/api/burgos/live"]
      });
    }

    if (url.pathname === "/api/burgos/live") {
      const cache = caches.default;
      const cacheRequest = new Request(new URL("/__cache/burgos-live", url.origin).toString(), { method: "GET" });
      try {
        const cached = await cache.match(cacheRequest);
        if (cached) {
          const data = await cached.json();
          const timestamp = Date.parse(data?.fetchedAt || "");
          const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Infinity;
          const stale = ageMs >= LIVE_REFRESH_AFTER_MS;

          // Return the saved estimate snapshot immediately. When it gets old,
          // refresh in the background rather than making users wait for all stops again.
          if (stale && ctx?.waitUntil) {
            ctx.waitUntil(refreshLiveSnapshotCache(cache, cacheRequest).catch(error => {
              console.error("No se pudo actualizar la caché de estimaciones de Burgos:", error?.message || String(error));
            }));
          }
          return jsonResponse(request, {
            ...data,
            cacheHit: true,
            stale,
            cacheAgeSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null
          }, 200, { "Cache-Control": "public, max-age=8" });
        }
      } catch {
        // La caché es opcional.
      }
      try {
        const data = await refreshLiveSnapshotCache(cache, cacheRequest);
        return jsonResponse(request, data, 200, { "Cache-Control": "public, max-age=8" });
      } catch (error) {
        return jsonResponse(request, {
          ok: false,
          error: error?.message || "No se pudieron consultar las estimaciones de Burgos.",
          source: BURGOS_LIVE_SOURCE,
          fetchedAt: new Date().toISOString()
        }, 502);
      }
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
