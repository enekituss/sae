const REPOSITORY = "enekituss/sae";
const WORKFLOWS = [
  { file: "update-siri.yml", label: "Bizkaibus" },
  { file: "telegram-burgos.yml", label: "Telegram Burgos" }
];
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";
const BURGOS_SOURCE = "https://movilidad.aytoburgos.es/rutas-en-directo";
const BURGOS_VEHICLES_SOURCE = "https://www.aytoburgos.es/web/movilidad/rutas-en-directo";
const BURGOS_LINES = [...Array.from({ length: 23 }, (_, i) => String(i + 1).padStart(2, "0")), "73", "87", "88", "89", "C1", "C2"];
const ALLOWED_ORIGIN = "https://enekituss.github.io";
const ISAENEXT_PORTLET = "as_asac_isaenext_IsaenextWebPortlet";

async function githubRequest(path, env, options = {}) {
  const token = (env.GITHUB_TOKEN || "").trim();
  if (!token) {
    throw new Error("Falta el secreto GITHUB_TOKEN en Cloudflare Workers.");
  }

  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "SAE-Spotter-Cloudflare-Worker/1.0");
  headers.set("Authorization", "Bearer " + token);

  const response = await fetch(GITHUB_API + path, {
    ...options,
    headers
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error("GitHub API respondió HTTP " + response.status + ": " + body.slice(0, 300));
  }

  return body ? JSON.parse(body) : null;
}

async function activeRuns(workflowFile, status, env) {
  const path =
    "/repos/" + REPOSITORY +
    "/actions/workflows/" + workflowFile +
    "/runs?status=" + encodeURIComponent(status) + "&per_page=5";
  const data = await githubRequest(path, env);
  return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
}

async function dispatchWorkflow(workflow, env) {
  const running = await activeRuns(workflow.file, "in_progress", env);
  if (running.length) {
    console.log(workflow.label + " omitido: ya existe una ejecución en curso.");
    return { workflow: workflow.file, dispatched: false, reason: "in_progress" };
  }

  const queued = await activeRuns(workflow.file, "queued", env);
  if (queued.length) {
    console.log(workflow.label + " omitido: ya existe una ejecución en cola.");
    return { workflow: workflow.file, dispatched: false, reason: "queued" };
  }

  await githubRequest(
    "/repos/" + REPOSITORY +
      "/actions/workflows/" + workflow.file + "/dispatches",
    env,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: BRANCH })
    }
  );

  console.log("Se ha solicitado la ejecución de " + workflow.label + " en GitHub Actions.");
  return { workflow: workflow.file, dispatched: true };
}

async function dispatchUpdates(env) {
  const results = [];
  // Execute independently so a failure in one workflow doesn't prevent the other
  // bot from processing its Telegram updates on this two-minute cycle.
  for (const workflow of WORKFLOWS) {
    try {
      results.push(await dispatchWorkflow(workflow, env));
    } catch (error) {
      console.error("No se pudo solicitar " + workflow.label + ":", error?.message || String(error));
      results.push({
        workflow: workflow.file,
        dispatched: false,
        error: error?.message || String(error)
      });
    }
  }
  return results;
}

function corsHeaders(request, extra = {}) {
  const headers = new Headers(extra);
  const origin = request.headers.get("Origin");
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  }
  return headers;
}

function jsonResponse(request, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    })
  });
}


function readNodeId(node) {
  return String(node?.num ?? node?.id ?? node?.stopId ?? node?.nodeId ??
    node?.nodoId ?? node?.idNodo ?? node?.numNodo ?? "").trim();
}

function normalizeObservations(nodes, results) {
  const nodeById = new Map(nodes.map(node => [readNodeId(node), node]));
  const rows = Array.isArray(results) ? results : [];
  const observations = [];
  rows.forEach((result, resultIndex) => {
    const explicitId = readNodeId(result);
    let stopId = explicitId;
    let node = nodeById.get(explicitId) || null;
    // Some ISAENEXT builds don't echo the node ID, but return one result per
    // requested node in the original order. Use this only when array sizes match.
    if (!node && rows.length === nodes.length && nodes[resultIndex]) {
      node = nodes[resultIndex];
      stopId = readNodeId(node);
    }
    if (!node) node = result;
    const routeGroups = result?.routeEstimationByNode || result?.routes || [];
    for (const routeGroup of routeGroups) {
      const line = String(routeGroup?.line ?? routeGroup?.route ?? routeGroup?.lineName ?? "").trim();
      const estimates = routeGroup?.publicEstimationVHExts ||
        routeGroup?.estimations || routeGroup?.buses || [];
      for (const item of estimates) {
        const id = String(item?.vehicle ?? item?.vehicleId ?? item?.vehicle_id ?? "").trim();
        const seconds = Number(item?.seconds);
        const meters = Number(item?.meters);
        const lat = Number(item?.lat ?? item?.latitude);
        const lon = Number(item?.lon ?? item?.lng ?? item?.longitude);
        observations.push({
          vehicleId: id && id !== "0" ? id : "",
          line,
          destination: String(item?.destination ?? "").trim(),
          seconds: Number.isFinite(seconds) ? seconds : null,
          meters: Number.isFinite(meters) ? meters : null,
          stopId,
          stopName: String(node?.name ?? node?.stop_name ?? "").trim(),
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

async function fetchBurgosLiveSnapshot() {
  const nodesPayload = await fetchIsaenextJson(isaenextURL("resourceNodes"));
  if (!Array.isArray(nodesPayload) || !nodesPayload.length) {
    throw new Error("ISAENEXT no devolvió la lista de paradas.");
  }
  const nodes = nodesPayload.filter(node => readNodeId(node));
  const chunks = [];
  for (let i = 0; i < nodes.length; i += 50) chunks.push(nodes.slice(i, i + 50));

  // El servicio trabaja con estimaciones por parada. Consultamos grupos
  // pequeños para evitar una URL enorme, respetar los límites del Worker y
  // conservar una correspondencia segura entre cada resultado y su parada.
  const chunkResults = new Array(chunks.length);
  const chunkErrors = [];
  let cursor = 0;
  const concurrency = Math.min(5, chunks.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const ids = chunk.map(readNodeId);
      try {
        const payload = await fetchIsaenextJson(isaenextURL("resourceEstimations", {
          "_as_asac_isaenext_IsaenextWebPortlet_tipo": "1",
          "_as_asac_isaenext_IsaenextWebPortlet_nodoIds": ids.join(",")
        }));
        if (!Array.isArray(payload)) {
          throw new Error("respuesta de estimaciones no reconocible");
        }
        if (payload.length === 1 && chunk.length > 2) {
          throw new Error("ISAENEXT sólo devolvió un resultado para un grupo de " + chunk.length + " paradas");
        }
        chunkResults[index] = { nodes: chunk, results: payload };
      } catch (error) {
        chunkErrors.push("grupo " + (index + 1) + ": " + (error?.message || String(error)));
        chunkResults[index] = null;
      }
    }
  }));

  const completed = chunkResults.filter(Boolean);
  if (!completed.length) {
    throw new Error("No se pudo consultar ninguna tanda de estimaciones. " + chunkErrors.slice(0, 3).join(" | "));
  }
  const observations = [];
  let resultCount = 0;
  for (const result of completed) {
    resultCount += result.results.length;
    observations.push(...normalizeObservations(result.nodes, result.results));
  }

  return {
    fetchedAt: new Date().toISOString(),
    source: BURGOS_SOURCE,
    sourceType: "ISAENEXT · estimaciones por parada",
    stopCount: nodes.length,
    resultCount,
    completedGroups: completed.length,
    totalGroups: chunks.length,
    partial: chunkErrors.length > 0,
    warnings: chunkErrors.slice(0, 5),
    observations
  };
}

function isaenextURL(resource, extra = {}) {
  const url = new URL(BURGOS_SOURCE);
  url.searchParams.set("p_p_id", ISAENEXT_PORTLET);
  url.searchParams.set("p_p_lifecycle", "2");
  url.searchParams.set("p_p_state", "normal");
  url.searchParams.set("p_p_mode", "view");
  url.searchParams.set("p_p_cacheability", "cacheLevelPage");
  url.searchParams.set("p_p_resource_id", resource);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function fetchIsaenextJson(url) {
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter/1.0)",
      "Referer": BURGOS_SOURCE
    },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("ISAENEXT respondió HTTP " + response.status);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("ISAENEXT no devolvió JSON; puede haber expirado o cambiado el servicio.");
  }
}


function isaenextVehiclesUrl(line) {
  const timestamp = Date.now();
  const url = new URL(BURGOS_VEHICLES_SOURCE);
  url.searchParams.set("p_p_id", ISAENEXT_PORTLET);
  url.searchParams.set("p_p_lifecycle", "2");
  url.searchParams.set("p_p_state", "normal");
  url.searchParams.set("p_p_mode", "view");
  url.searchParams.set("p_p_cacheability", "cacheLevelPage");
  url.searchParams.set("p_p_resource_id", "resourceVehicles");
  url.searchParams.set("_as_asac_isaenext_IsaenextWebPortlet_formDate", String(timestamp));
  url.searchParams.set("_as_asac_isaenext_IsaenextWebPortlet_line", line);
  url.searchParams.set("_as_asac_isaenext_IsaenextWebPortlet_label", line);
  url.searchParams.set("_t", String(timestamp));
  return url;
}

async function fetchBurgosVehicles(line) {
  const url = isaenextVehiclesUrl(line);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter/1.0)",
      "Referer": BURGOS_VEHICLES_SOURCE
    },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("resourceVehicles de línea " + line + " respondió HTTP " + response.status);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("resourceVehicles de línea " + line + " no devolvió JSON reconocible.");
  }
  if (!Array.isArray(payload)) {
    throw new Error("resourceVehicles de línea " + line + " no devolvió una lista.");
  }
  return payload.map(vehicle => ({
    ...vehicle,
    id: String(vehicle?.id ?? vehicle?.vehicleId ?? vehicle?.vehicle_id ?? "").trim(),
    lineId: line
  })).filter(vehicle => vehicle.id);
}

async function fetchBurgosVehiclesSnapshot() {
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
        results[index] = await fetchBurgosVehicles(line);
      } catch (error) {
        errors.push("Línea " + line + ": " + (error?.message || String(error)));
        results[index] = null;
      }
    }
  }));

  const completed = results.filter(Array.isArray);
  const vehicles = [];
  results.forEach((rows, index) => {
    if (Array.isArray(rows)) vehicles.push(...rows);
  });
  if (!completed.length) {
    throw new Error("No se pudo consultar ninguna línea con resourceVehicles. " + errors.slice(0, 3).join(" | "));
  }

  const uniqueVehicles = new Map();
  for (const vehicle of vehicles) {
    const id = String(vehicle.id || "").trim();
    if (id) uniqueVehicles.set(id, vehicle);
  }
  return {
    fetchedAt: new Date().toISOString(),
    source: BURGOS_VEHICLES_SOURCE,
    sourceType: "ISAENEXT · resourceVehicles por línea",
    lineCount: completed.length,
    totalLines: BURGOS_LINES.length,
    partial: errors.length > 0,
    warnings: errors.slice(0, 5),
    count: uniqueVehicles.size,
    failedLines: results.map((rows, index) => Array.isArray(rows) ? null : BURGOS_LINES[index]).filter(Boolean),
    vehicles: [...uniqueVehicles.values()]
  };
}

export default {
  async scheduled(controller, env, ctx) {
    await dispatchUpdates(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/burgos/")) {
      return new Response(null, { status: 204, headers: corsHeaders(request, { "Access-Control-Max-Age": "86400" }) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(request, {
        ok: true,
        service: "SAE Spotter scheduler y proxy público",
        cadence: "*/2 * * * *",
        dispatchWorkflows: WORKFLOWS.map(workflow => workflow.file),
        endpoints: ["/api/burgos/nodes", "/api/burgos/estimates?stopId=200", "/api/burgos/vehicles", "/api/burgos/vehicles?line=01", "/api/burgos/live"],
        note: "Cada dos minutos se intentan ejecutar los workflows de Bizkaibus y Telegram Burgos. Si ya hay una ejecución en cola o curso, se omite ese ciclo. La fuente pública de Burgos entrega estimaciones por parada; las coordenadas sólo se consideran GPS si el servicio las publica."
      });
    }

    if (request.method === "GET" && url.pathname === "/api/burgos/nodes") {
      try {
        const payload = await fetchIsaenextJson(isaenextURL("resourceNodes"));
        if (!Array.isArray(payload)) {
          return jsonResponse(request, { error: "Formato inesperado de paradas ISAENEXT." }, 502);
        }
        return jsonResponse(request, {
          fetchedAt: new Date().toISOString(),
          source: BURGOS_SOURCE,
          stops: payload
        }, 200, { "Cache-Control": "public, max-age=300" });
      } catch (error) {
        console.error("Fallo al consultar las paradas de Burgos:", error?.message || String(error));
        return jsonResponse(request, { error: error?.message || "No se pudo consultar ISAENEXT." }, 502);
      }
    }


    if (request.method === "GET" && url.pathname === "/api/burgos/vehicles") {
      const requestedLine = (url.searchParams.get("line") || "").trim().toUpperCase();
      if (requestedLine && !BURGOS_LINES.includes(requestedLine)) {
        return jsonResponse(request, {
          error: "Línea no válida. Usa una de estas: " + BURGOS_LINES.join(", "),
          allowedLines: BURGOS_LINES
        }, 400);
      }

      const cache = caches.default;
      const cacheKeyUrl = new URL("/__cache/burgos-vehicles" + (requestedLine ? "?line=" + encodeURIComponent(requestedLine) : "?line=all"), url.origin);
      const cacheRequest = new Request(cacheKeyUrl.toString());
      try {
        const cached = await cache.match(cacheRequest);
        if (cached) {
          return jsonResponse(request, { ...(await cached.json()), cacheHit: true }, 200, {
            "Cache-Control": "public, max-age=10"
          });
        }
      } catch {
        // La caché es opcional.
      }

      try {
        let payload;
        if (requestedLine) {
          const vehicles = await fetchBurgosVehicles(requestedLine);
          payload = {
            fetchedAt: new Date().toISOString(),
            source: BURGOS_VEHICLES_SOURCE,
            sourceType: "ISAENEXT · resourceVehicles por línea",
            line: requestedLine,
            lineCount: 1,
            totalLines: 1,
            partial: false,
            warnings: [],
            count: vehicles.length,
            vehicles
          };
        } else {
          payload = await fetchBurgosVehiclesSnapshot();
        }

        try {
          await cache.put(cacheRequest, new Response(JSON.stringify(payload), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=10"
            }
          }));
        } catch {
          // La respuesta sigue siendo válida aunque la caché no esté disponible.
        }
        return jsonResponse(request, payload, 200, { "Cache-Control": "public, max-age=10" });
      } catch (error) {
        console.error("Fallo al consultar los vehículos de Burgos por línea:", error?.message || String(error));
        return jsonResponse(request, {
          error: error?.message || "No se pudieron consultar los vehículos por línea.",
          source: BURGOS_VEHICLES_SOURCE,
          fetchedAt: new Date().toISOString()
        }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/burgos/live") {
      const cache = caches.default;
      const cacheRequest = new Request(new URL("/__cache/burgos-live-snapshot", url.origin).toString());
      try {
        const cached = await cache.match(cacheRequest);
        if (cached) {
          return jsonResponse(request, { ...(await cached.json()), cacheHit: true }, 200, { "Cache-Control": "public, max-age=8" });
        }
      } catch {
        // La caché es opcional.
      }
      try {
        const payload = await fetchBurgosLiveSnapshot();
        try {
          await cache.put(cacheRequest, new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=8" }
          }));
        } catch {
          // La respuesta sigue siendo válida aunque no se pueda guardar en caché.
        }
        return jsonResponse(request, payload, 200, { "Cache-Control": "public, max-age=8" });
      } catch (error) {
        console.error("Fallo al consultar las estimaciones en directo de Burgos:", error?.message || String(error));
        return jsonResponse(request, {
          error: error?.message || "No se pudo consultar ISAENEXT.",
          source: BURGOS_SOURCE,
          fetchedAt: new Date().toISOString()
        }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/burgos/estimates") {
      const stopId = (url.searchParams.get("stopId") || "").trim();
      if (!/^\d{1,8}$/.test(stopId)) {
        return jsonResponse(request, { error: "Incluye un stopId numérico válido, por ejemplo 200." }, 400);
      }
      try {
        const payload = await fetchIsaenextJson(isaenextURL("resourceEstimations", {
          "_as_asac_isaenext_IsaenextWebPortlet_tipo": "1",
          "_as_asac_isaenext_IsaenextWebPortlet_nodoIds": stopId
        }));
        return jsonResponse(request, {
          fetchedAt: new Date().toISOString(),
          stopId,
          source: BURGOS_SOURCE,
          estimations: payload
        });
      } catch (error) {
        console.error("Fallo al consultar tiempos estimados en Burgos:", error?.message || String(error));
        return jsonResponse(request, { error: error?.message || "No se pudieron consultar las estimaciones." }, 502);
      }
    }

    return new Response("Not found", { status: 404 });
  }
};
