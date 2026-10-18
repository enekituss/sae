const BURGOS_SOURCE = "https://movilidad.aytoburgos.es/es/rutas-en-directo";
const BURGOS_SOURCE_FALLBACKS = [
  BURGOS_SOURCE,
  "https://movilidad.aytoburgos.es/rutas-en-directo",
  "https://www.aytoburgos.es/web/movilidad/rutas-en-directo"
];
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

function resourceUrl(resource, extra = {}, base = BURGOS_SOURCE) {
  const url = new URL(base);
  url.searchParams.set("p_p_id", PORTLET_ID);
  url.searchParams.set("p_p_lifecycle", "2");
  url.searchParams.set("p_p_state", "normal");
  url.searchParams.set("p_p_mode", "view");
  url.searchParams.set("p_p_resource_id", resource);
  url.searchParams.set("p_p_cacheability", "cacheLevelPage");
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function stopIdFrom(value) {
  return String(value?.num ?? value?.id ?? value?.stopId ?? value?.nodeId ??
    value?.nodoId ?? value?.idNodo ?? value?.numNodo ?? "").trim();
}

function normalizeLineCode(value) {
  let line = String(value ?? "").trim().toUpperCase();
  line = line.replace(/^L[IÍ]NEA\s*/, "").replace(/^L(?=\d)/, "");
  const match = line.match(/(?:^|[^A-Z0-9])(C[12]|\d{1,2})(?=$|[^A-Z0-9])/);
  const token = match ? match[1] : line;
  if (/^\d+$/.test(token)) return String(Number(token));
  return token;
}

async function requestIsaenext(resource, extra = {}) {
  const errors = [];
  for (const base of BURGOS_SOURCE_FALLBACKS) {
    try {
      const url = resourceUrl(resource, extra, base);
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter-Burgos/1.0)",
          "Referer": BURGOS_SOURCE
        },
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.text();
      if (!response.ok) {
        errors.push(new URL(base).host + " HTTP " + response.status);
        continue;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        errors.push(new URL(base).host + " no devolvió JSON");
        continue;
      }
      return { data, source: base };
    } catch (error) {
      errors.push(new URL(base).host + ": " + (error?.message || String(error)));
    }
  }
  throw new Error(resource + " no respondió en el SAE municipal: " + errors.join(" | "));
}

async function fetchStopNodes() {
  const result = await requestIsaenext("resourceNodes");
  if (!Array.isArray(result.data) || !result.data.length) {
    throw new Error("resourceNodes no devolvió una lista de paradas.");
  }
  const seen = new Set();
  const nodes = [];
  for (const node of result.data) {
    const id = stopIdFrom(node);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ ...node, __stopId: id });
  }
  if (!nodes.length) throw new Error("resourceNodes no devolvió IDs de parada reconocibles.");
  return { nodes, source: result.source };
}

function extractLineEstimations(line, nodes, payload) {
  if (!Array.isArray(payload)) {
    throw new Error("resourceEstimations no devolvió una lista para la línea " + line + ".");
  }

  const nodeById = new Map(nodes.map(node => [node.__stopId || stopIdFrom(node), node]));
  const requestedLine = normalizeLineCode(line);
  const observations = [];

  payload.forEach((result, resultIndex) => {
    if (!result || typeof result !== "object") return;
    const explicitId = stopIdFrom(result);
    let stopId = explicitId;
    let stop = nodeById.get(explicitId) || null;

    // El SAE suele devolver los resultados en el mismo orden solicitado.
    if (!stop && payload.length === nodes.length && nodes[resultIndex]) {
      stop = nodes[resultIndex];
      stopId = stop.__stopId || stopIdFrom(stop);
    }

    const routeGroups = result.routeEstimationByNode || result.routes || [];
    if (!Array.isArray(routeGroups)) return;
    for (const routeGroup of routeGroups) {
      if (!routeGroup || typeof routeGroup !== "object") continue;
      const reportedLine = String(routeGroup.line ?? routeGroup.route ?? routeGroup.lineName ?? "").trim();
      if (reportedLine && normalizeLineCode(reportedLine) !== requestedLine) continue;
      const estimates = routeGroup.publicEstimationVHExts || routeGroup.estimations || routeGroup.buses || [];
      if (!Array.isArray(estimates)) continue;
      for (const item of estimates) {
        if (!item || typeof item !== "object") continue;
        const vehicleId = String(item.vehicle ?? item.vehicleId ?? item.vehicle_id ?? "").trim();
        if (!vehicleId || vehicleId === "0") continue;
        const seconds = item.seconds === null || item.seconds === undefined || item.seconds === "" ? null : Number(item.seconds);
        const meters = item.meters === null || item.meters === undefined || item.meters === "" ? null : Number(item.meters);
        const lat = Number(item.lat ?? item.latitude);
        const lon = Number(item.lon ?? item.lng ?? item.longitude);
        observations.push({
          vehicleId,
          line: reportedLine || line,
          destination: String(item.destination ?? routeGroup.destination ?? "").trim(),
          direction: String(item.direction ?? routeGroup.direction ?? "").trim(),
          seconds: Number.isFinite(seconds) ? seconds : null,
          meters: Number.isFinite(meters) ? meters : null,
          stopId: stopId || "",
          stopName: String(stop?.name ?? stop?.stop_name ?? stop?.nombre ?? "").trim(),
          stopLat: Number(stop?.lat ?? stop?.latitude),
          stopLon: Number(stop?.lng ?? stop?.lon ?? stop?.longitude),
          vehicleLat: Number.isFinite(lat) && lat >= 42 && lat <= 43 ? lat : null,
          vehicleLon: Number.isFinite(lon) && lon >= -4 && lon <= -3 ? lon : null
        });
      }
    }
  });

  return observations;
}

async function fetchLineObservations(line, nodes) {
  const nodeIds = nodes.map(node => node.__stopId || stopIdFrom(node)).filter(Boolean);
  if (!nodeIds.length) throw new Error("No hay IDs de paradas para consultar la línea " + line + ".");
  const response = await requestIsaenext("resourceEstimations", {
    [PORTLET_PREFIX + "line"]: line,
    [PORTLET_PREFIX + "tipo"]: "1",
    [PORTLET_PREFIX + "nodoIds"]: nodeIds.join(",")
  });
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("resourceEstimations devolvió una respuesta vacía o no reconocible para la línea " + line + ".");
  }
  if (response.data.length === 1 && nodes.length > 2) {
    throw new Error("resourceEstimations devolvió un único resultado para " +
      nodes.length + " IDs de parada; la respuesta podría estar incompleta.");
  }
  return {
    observations: extractLineEstimations(line, nodes, response.data),
    source: response.source
  };
}

function vehiclesFromObservations(observations, line) {
  const byId = new Map();
  for (const observation of observations) {
    const current = byId.get(observation.vehicleId);
    const seconds = Number.isFinite(observation.seconds) && observation.seconds >= 0 ? observation.seconds : Infinity;
    const previousSeconds = current && Number.isFinite(current.seconds) && current.seconds >= 0 ? current.seconds : Infinity;
    if (!current || seconds < previousSeconds) {
      byId.set(observation.vehicleId, {
        id: observation.vehicleId,
        lineId: line,
        line,
        destination: observation.destination,
        direction: observation.direction,
        seconds: observation.seconds,
        meters: observation.meters,
        stopId: observation.stopId,
        stopName: observation.stopName
      });
    }
  }
  return [...byId.values()];
}

async function fetchVehiclesForLine(line, cachedNodes = null) {
  const stopData = cachedNodes || await fetchStopNodes();
  const result = await fetchLineObservations(line, stopData.nodes);
  return vehiclesFromObservations(result.observations, line);
}

async function fetchSnapshot() {
  const stopData = await fetchStopNodes();
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
        const result = await fetchLineObservations(line, stopData.nodes);
        results[index] = vehiclesFromObservations(result.observations, line);
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
    rows.forEach(vehicle => {
      const old = byId.get(vehicle.id);
      // Si el mismo coche aparece en más de una observación, prefiere el
      // registro con menor estimación de llegada, pero conserva la línea reportada.
      if (!old || (Number.isFinite(vehicle.seconds) &&
          (!Number.isFinite(old.seconds) || vehicle.seconds < old.seconds))) {
        byId.set(vehicle.id, vehicle);
      }
    });
  });

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: stopData.source,
    sourceType: "ISAENEXT · resourceEstimations filtrado por línea",
    lineCount: completed.length,
    totalLines: BURGOS_LINES.length,
    partial: errors.length > 0,
    failedLines: errors.map(item => item.line),
    warnings: errors.slice(0, 5).map(item => "Línea " + item.line + ": " + item.error),
    count: byId.size,
    vehicles: [...byId.values()]
  };
}

// Live ISAENEXT feed: query each line using the municipal resourceEstimations endpoint.
async function fetchLiveSnapshot() {
  const stopData = await fetchStopNodes();
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
        const result = await fetchLineObservations(line, stopData.nodes);
        results[index] = result.observations;
      } catch (error) {
        results[index] = null;
        errors.push({ line, error: error?.message || String(error) });
      }
    }
  }));

  const complete = results.filter(Array.isArray);
  if (!complete.length) {
    throw new Error("No se pudo consultar ninguna línea mediante resourceEstimations. " +
      errors.slice(0, 4).map(item => "Línea " + item.line + ": " + item.error).join(" | "));
  }

  const observations = [];
  for (const rows of complete) observations.push(...rows);

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: stopData.source,
    sourceType: "ISAENEXT · resourceEstimations por línea y parada",
    stopCount: stopData.nodes.length,
    resultCount: observations.length,
    completedGroups: complete.length,
    totalGroups: BURGOS_LINES.length,
    partial: errors.length > 0,
    warnings: errors.slice(0, 5).map(item => "Línea " + item.line + ": " + item.error),
    observations
  };
}

const LIVE_CACHE_TTL_SECONDS = 300;
const LIVE_REFRESH_AFTER_MS = 30 * 1000;
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

async function dispatchBurgosTelegramWorkflow(env) {
  const token = String(env?.BURGOS_GITHUB_TOKEN || "").trim();
  if (!token) {
    console.warn("Falta BURGOS_GITHUB_TOKEN: Telegram Burgos queda con el respaldo programado de GitHub Actions.");
    return;
  }

  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": "Bearer " + token,
    "User-Agent": "SAE-Spotter-Burgos/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const runsEndpoint = "https://api.github.com/repos/enekituss/sae/actions/workflows/telegram-burgos.yml/runs?branch=main&per_page=5";
  const runsResponse = await fetch(runsEndpoint, { method: "GET", headers });
  if (!runsResponse.ok) {
    const detail = (await runsResponse.text()).slice(0, 300);
    throw new Error("No se pudo revisar la cola de Telegram Burgos (HTTP " + runsResponse.status + ")" + (detail ? ": " + detail : ""));
  }

  const runsPayload = await runsResponse.json();
  const activeRun = (Array.isArray(runsPayload?.workflow_runs) ? runsPayload.workflow_runs : [])
    .find(run => ["queued", "in_progress", "waiting", "pending", "requested"].includes(String(run?.status || "").toLowerCase()));
  if (activeRun) {
    console.log("Se omite la comprobación de Burgos: ya hay una ejecución " +
      String(activeRun.status) + " (run #" + String(activeRun.run_number || activeRun.id || "desconocido") + ").");
    return;
  }

  const endpoint = "https://api.github.com/repos/enekituss/sae/actions/workflows/telegram-burgos.yml/dispatches";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" })
  });

  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error("GitHub workflow dispatch HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  console.log("Comprobación Telegram Burgos lanzada en GitHub Actions.");
}

export default {
  async scheduled(controller, env, ctx) {
    const task = dispatchBurgosTelegramWorkflow(env).catch(error => {
      console.error("No se pudo lanzar la comprobación Telegram de Burgos:", error?.message || String(error));
    });
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
  },

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
        telegramScheduler: { configured: Boolean(env?.BURGOS_GITHUB_TOKEN), cadence: "*/2 * * * *" },
        endpoints: ["/api/burgos/vehicles", "/api/burgos/vehicles?line=01", "/api/burgos/live"]
      });
    }

    if (url.pathname === "/api/burgos/live") {
      const cache = caches.default;
      const cacheRequest = new Request(new URL("/__cache/burgos-live", url.origin).toString(), { method: "GET" });
      const forceRefresh = url.searchParams.get("fresh") === "1";
      if (!forceRefresh) {
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
          sourceType: "ISAENEXT · resourceEstimations filtrado por línea",
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
