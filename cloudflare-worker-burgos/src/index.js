// URL canónica que publica el propio portal de Movilidad en «Rutas en directo».
// Las otras rutas quedan como respaldo si un alias del portal falla.
const BURGOS_SOURCE = "https://movilidad.aytoburgos.es/rutas-en-directo/-/isaenext/filter/23";
const BURGOS_SOURCE_FALLBACKS = [
  BURGOS_SOURCE,
  "https://movilidad.aytoburgos.es/es/rutas-en-directo",
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
// IDs de parada incluidos en la URL de resourceEstimations que ha facilitado el usuario.
// Se usan como respaldo si resourceNodes no responde; la línea se cambia en cada petición.
const BURGOS_KNOWN_NODE_IDS = ["402", "183", "209", "98", "26", "224", "71", "152", "164", "227", "228"];

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
  const formTimestamp = String(Date.now());
  url.searchParams.set(PORTLET_PREFIX + "formDate", formTimestamp);
  url.searchParams.set("_t", formTimestamp);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function stopIdFrom(value, allowGenericId = false) {
  const direct = value?.numNodo ?? value?.idNodo ?? value?.num ?? value?.stopId ??
    value?.stop_id ?? value?.nodeId ?? value?.node_id ?? value?.nodoId ??
    value?.paradaId ?? value?.idParada ?? value?.numParada ??
    value?.stop ?? value?.node ?? value?.nodo ?? value?.parada ??
    (allowGenericId ? value?.id : undefined);
  if (direct && typeof direct === "object") {
    return String(direct.num ?? direct.id ?? direct.stopId ?? direct.nodeId ?? "").trim();
  }
  return String(direct ?? "").trim();
}

function destinationText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    return String(value.destinationName ?? value.destinationText ?? value.name ?? value.nombre ??
      value.description ?? value.descripcion ?? value.headsign ?? value.label ?? value.text ?? "").trim();
  }
  return "";
}

function destinationId(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.destinationId ?? value.destination_id ?? value.destinoId ??
    value.destino_id ?? value.idDestino ?? value.id_destino ?? value.destId ??
    value.dest_id ?? value.destinationCode ?? value.codigoDestino ?? value.codDestino ?? "").trim();
}

function normalizeLineCode(value) {
  let line = String(value ?? "").trim().toUpperCase();
  line = line.replace(/^L[IÍ]NEA\s*/, "").replace(/^L(?=\d)/, "");
  const match = line.match(/(?:^|[^A-Z0-9])(C[12]|\d{1,2})(?=$|[^A-Z0-9])/);
  const token = match ? match[1] : line;
  if (/^\d+$/.test(token)) return String(Number(token));
  return token;
}

async function requestIsaenext(resource, extra = {}, options = {}) {
  const sources = BURGOS_SOURCE_FALLBACKS;
  // resourceVehicles es imprescindible para detectar altas y bajas. Se le da
  // hasta 10 s por host. Si un host agota el tiempo de espera, no repetimos
  // inmediatamente la petición contra otra ruta del mismo host: pasamos al
  // dominio de respaldo para no desperdiciar casi todo el tiempo del monitor.
  const timeoutValue = Number(options.timeoutMs);
  const defaultTimeoutMs = resource === "resourceVehicles" ? 10000 : 6000;
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
    ? Math.min(timeoutValue, defaultTimeoutMs) : defaultTimeoutMs;
  const sourceValue = Number(options.maxSources);
  const maxSources = Number.isFinite(sourceValue) && sourceValue > 0
    ? Math.min(Math.floor(sourceValue), sources.length) : sources.length;
  const errors = [];
  const timedOutHosts = new Set();

  for (const base of sources.slice(0, maxSources)) {
    const url = new URL(base);
    const host = url.host;
    if (timedOutHosts.has(host)) {
      errors.push(host + " omitido tras un timeout previo en el mismo host");
      continue;
    }
    url.searchParams.set("p_p_id", PORTLET_ID);
    url.searchParams.set("p_p_lifecycle", "2");
    url.searchParams.set("p_p_state", "normal");
    url.searchParams.set("p_p_mode", "view");
    url.searchParams.set("p_p_resource_id", resource);
    url.searchParams.set("p_p_cacheability", "cacheLevelPage");
    for (const [key, value] of Object.entries(extra)) {
      url.searchParams.set(key, String(value));
    }
    // Igual que la consulta directa de burgos-vehicles.js, incluye marca temporal
    // para que ISAENEXT no reutilice una respuesta cacheada de la petición anterior.
    const formTimestamp = String(Date.now());
    url.searchParams.set(PORTLET_PREFIX + "formDate", formTimestamp);
    url.searchParams.set("_t", formTimestamp);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
          "Referer": BURGOS_SOURCE
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await response.text();
      if (!response.ok) {
        errors.push(new URL(base).host + " HTTP " + response.status);
        continue;
      }
      try {
        return { data: JSON.parse(body), source: base };
      } catch {
        errors.push(new URL(base).host + " no devolvió JSON válido");
      }
    } catch (error) {
      const message = error?.message || String(error);
      errors.push(host + ": " + message);
      if (error?.name === "TimeoutError" || error?.name === "AbortError" ||
          /aborted|timed out|timeout/i.test(message)) {
        timedOutHosts.add(host);
      }
    }
  }

  throw new Error(resource + " línea " + String(extra[PORTLET_PREFIX + "line"] || "?") +
    " no respondió en ninguna ruta municipal: " + errors.join(" | "));
}

// resourceRoutes contiene el trazado y, según el formato publicado, los IDs de parada.
function extractRouteStopIds(payload) {
  const ids = [];
  const seen = new Set();
  const stopCollectionKey = /(?:stops?|paradas?|nodes?|nodos?|routepoints?|route_nodes?|route_stops?|waypoints?|itinerary|itinerario|puntos?)/i;
  const stopIdKey = /^(?:numNodo|idNodo|stopId|stop_id|nodeId|node_id|nodoId|paradaId|idParada|numParada)$/i;
  const add = value => {
    const id = String(value ?? "").trim();
    if (!/^\d{1,12}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  function visit(value, key = "", inStopCollection = false, depth = 0) {
    if (depth > 14 || value === null || value === undefined) return;
    const context = inStopCollection || stopCollectionKey.test(key);

    if (typeof value === "string" || typeof value === "number") {
      if (context) {
        const text = String(value).trim();
        if (/^\d{1,12}(?:\s*,\s*\d{1,12})+$/.test(text)) text.split(",").forEach(add);
        else add(text);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (context && (typeof item === "string" || typeof item === "number")) add(item);
        visit(item, "", context, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") return;

    const hasCoordinates = (value.lat !== undefined || value.latitude !== undefined) &&
      (value.lng !== undefined || value.lon !== undefined || value.longitude !== undefined);
    const hasStopName = value.name !== undefined || value.stopName !== undefined ||
      value.stop_name !== undefined || value.nombre !== undefined || value.parada !== undefined;
    const looksLikeStop = context || (hasCoordinates && hasStopName);

    for (const [field, fieldValue] of Object.entries(value)) {
      if (stopIdKey.test(field) && typeof fieldValue !== "object") add(fieldValue);
      if (field === "num" && looksLikeStop && typeof fieldValue !== "object") add(fieldValue);
      if (field === "id" && looksLikeStop && typeof fieldValue !== "object") add(fieldValue);
    }
    if (looksLikeStop) {
      const id = stopIdFrom(value, true);
      if (id) add(id);
    }
    for (const [field, fieldValue] of Object.entries(value)) {
      if (/(?:nodeIds|nodoIds|stopIds|paradaIds|idsNodos|idsParadas)/i.test(field) &&
          typeof fieldValue === "string") {
        fieldValue.split(",").forEach(add);
      } else {
        visit(fieldValue, field, context, depth + 1);
      }
    }
  }
  visit(payload);
  return ids;
}


function extractRouteNodeDetails(payload) {
  const nodes = new Map();
  const stopCollectionKey = /(?:stops?|paradas?|nodes?|nodos?|routepoints?|route_nodes?|route_stops?|waypoints?|itinerary|itinerario|puntos?)/i;

  function visit(value, key = "", inStopCollection = false, depth = 0) {
    if (depth > 14 || value === null || value === undefined || typeof value !== "object") return;
    const context = inStopCollection || stopCollectionKey.test(key);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, "", context, depth + 1);
      return;
    }

    const hasCoordinates = (value.lat !== undefined || value.latitude !== undefined) &&
      (value.lng !== undefined || value.lon !== undefined || value.longitude !== undefined);
    const hasStopName = value.name !== undefined || value.stopName !== undefined ||
      value.stop_name !== undefined || value.nombre !== undefined ||
      value.nombreNodo !== undefined || value.nombreParada !== undefined ||
      value.paradaNombre !== undefined;
    if (context || (hasCoordinates && hasStopName)) {
      const id = stopIdFrom(value, true);
      if (/^\d{1,12}$/.test(id)) {
        const name = String(value.name ?? value.stopName ?? value.stop_name ??
          value.nombre ?? value.nombreNodo ?? value.nombreParada ??
          value.paradaNombre ?? value.description ?? value.descripcion ?? "").trim();
        const latValue = Number(value.lat ?? value.latitude);
        const lonValue = Number(value.lng ?? value.lon ?? value.longitude);
        const previous = nodes.get(id) || { __stopId: id, num: id };
        nodes.set(id, {
          ...previous,
          __stopId: id,
          num: id,
          name: name || previous.name || "",
          lat: Number.isFinite(latValue) ? latValue : previous.lat,
          lng: Number.isFinite(lonValue) ? lonValue : previous.lng
        });
      }
    }

    for (const [field, child] of Object.entries(value)) {
      visit(child, field, context, depth + 1);
    }
  }

  visit(payload);
  return nodes;
}

function arrayFromResource(payload, resourceName) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new Error(resourceName + " no devolvió una lista.");
  }
  const preferred = resourceName === "resourceVehicles"
    ? ["vehicles", "vehicleList", "resourceVehicles", "data", "result", "rows", "items", "list"]
    : ["routes", "route", "resourceRoutes", "data", "result", "rows", "items", "list"];
  for (const key of preferred) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  const candidates = Object.values(payload).filter(Array.isArray);
  if (candidates.length === 1) return candidates[0];
  throw new Error(resourceName + " devolvió un formato JSON no reconocido.");
}

function extractVehicleRows(payload, line) {
  const rows = arrayFromResource(payload, "resourceVehicles");
  const vehicles = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.vehicleId ?? row.vehicle_id ?? row.vehicle ?? row.idVehicle ??
      row.numeroCoche ?? row.numVehiculo ?? row.id ?? "").trim();
    if (!id || id === "0") continue;
    vehicles.push({
      ...row,
      id,
      lineId: String(row.lineId ?? row.line ?? row.route ?? row.ruta ?? line).trim() || line,
      line: String(row.line ?? row.lineId ?? row.route ?? line).trim() || line,
      destination: destinationText(row.destination ?? row.destino ?? row.destinationName ??
        row.destinationText ?? row.headsign ?? row.destiny ?? row.destinoNombre ??
        row.nombreDestino ?? row.destinationLabel ?? row.destinationDescription ?? ""),
      destinationId: destinationId(row),
      direction: String(row.direction ?? row.sentido ?? row.direccion ?? "").trim()
    });
  }
  return vehicles;
}

function extractLineEstimations(line, nodes, payload) {
  if (!Array.isArray(payload)) {
    throw new Error("resourceEstimations no devolvió una lista para la línea " + line + ".");
  }
  const nodeById = new Map(nodes.map(node => [node.__stopId || stopIdFrom(node, true), node]));
  const requestedLine = normalizeLineCode(line);
  const observations = [];

  payload.forEach((result, resultIndex) => {
    if (!result || typeof result !== "object") return;
    const explicitId = stopIdFrom(result, true);
    let stopId = explicitId;
    let stop = nodeById.get(explicitId) || null;
    if (!stop && payload.length === nodes.length && nodes[resultIndex]) {
      stop = nodes[resultIndex];
      stopId = stop.__stopId || stopIdFrom(stop, true);
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
          destination: destinationText(item.destination ?? item.destinationName ?? item.destinationText ??
            item.destino ?? item.destinoNombre ?? item.nombreDestino ?? item.destinationLabel ??
            item.destinationDescription ?? item.headsign ?? routeGroup.destination ??
            routeGroup.destinationName ?? routeGroup.destinationText ?? routeGroup.destino ??
            routeGroup.destinoNombre ?? routeGroup.nombreDestino ?? ""),
          destinationId: destinationId(item) || destinationId(routeGroup),
          direction: String(item.direction ?? item.sentido ?? item.direccion ??
            routeGroup.direction ?? routeGroup.sentido ?? routeGroup.direccion ?? "").trim(),
          seconds: Number.isFinite(seconds) ? seconds : null,
          meters: Number.isFinite(meters) ? meters : null,
          stopId: stopId || "",
          stopName: String(result.stopName ?? result.stop_name ?? result.nombre ?? result.nombreNodo ??
            result.nombreParada ?? result.paradaNombre ?? result.name ?? stop?.name ??
            stop?.stop_name ?? stop?.nombre ?? "").trim(),
          stopLat: Number(result.lat ?? result.latitude ?? stop?.lat ?? stop?.latitude),
          stopLon: Number(result.lng ?? result.lon ?? result.longitude ??
            stop?.lng ?? stop?.lon ?? stop?.longitude),
          vehicleLat: Number.isFinite(lat) && lat >= 42 && lat <= 43 ? lat : null,
          vehicleLon: Number.isFinite(lon) && lon >= -4 && lon <= -3 ? lon : null
        });
      }
    }
  });
  return observations;
}

async function fetchVehicleListForLine(line) {
  const lineParams = {
    [PORTLET_PREFIX + "line"]: line,
    [PORTLET_PREFIX + "label"]: line
  };

  // La lista de vehículos no debe depender de resourceRoutes ni de las estimaciones.
  // Así una incidencia al extraer paradas no hace desaparecer la línea completa.
  let vehicleResult;
  try {
    vehicleResult = await requestIsaenext("resourceVehicles", lineParams);
  } catch (error) {
    throw new Error("resourceVehicles línea " + line + ": " + (error?.message || String(error)));
  }

  const vehicles = extractVehicleRows(vehicleResult.data, line).map(row => {
    const lat = Number(row.lat ?? row.latitude);
    const lon = Number(row.lng ?? row.lon ?? row.longitude);
    const validPosition = Number.isFinite(lat) && lat >= 42 && lat <= 43 &&
      Number.isFinite(lon) && lon >= -4 && lon <= -3;
    return {
      ...row,
      id: row.id,
      lineId: line,
      line,
      destination: row.destination || "Destino no publicado",
      direction: row.direction || "",
      position: {
        lat: validPosition ? lat : null,
        lon: validPosition ? lon : null,
        source: validPosition ? "GPS publicado por resourceVehicles" : ""
      }
    };
  });

  return {
    ok: true,
    line,
    fetchedAt: new Date().toISOString(),
    source: vehicleResult.source || BURGOS_SOURCE,
    sourceType: "ISAENEXT · resourceVehicles por línea",
    vehicleRowCount: vehicles.length,
    count: vehicles.length,
    partial: false,
    vehicles,
    observations: []
  };
}

async function fetchVehiclesForLine(line) {
  const lineParams = {
    [PORTLET_PREFIX + "line"]: line,
    [PORTLET_PREFIX + "label"]: line
  };

  // resourceVehicles es la base fiable de coches publicados. Debe consultarse
  // primero para que un fallo de trazado no haga perder el listado del SAE.
  let vehicleResult;
  try {
    vehicleResult = await requestIsaenext("resourceVehicles", lineParams);
  } catch (error) {
    throw new Error("resourceVehicles: " + (error?.message || String(error)));
  }

  const vehicleRows = extractVehicleRows(vehicleResult.data, line);
  const byId = new Map();

  for (const row of vehicleRows) {
    const lat = Number(row.lat ?? row.latitude);
    const lon = Number(row.lng ?? row.lon ?? row.longitude);
    const validLat = Number.isFinite(lat) && lat >= 42 && lat <= 43;
    const validLon = Number.isFinite(lon) && lon >= -4 && lon <= -3;
    byId.set(row.id, {
      ...row,
      id: row.id,
      lineId: line,
      line,
      destination: row.destination || "Destino no publicado",
      direction: row.direction || "",
      seconds: null,
      meters: null,
      stopId: "",
      stopName: "",
      position: {
        lat: validLat ? lat : null,
        lon: validLon ? lon : null,
        source: validLat && validLon ? "GPS publicado por resourceVehicles" : ""
      }
    });
  }

  let routePayload = null;
  let nodeIds = [];
  let routeCount = 0;
  let observations = [];
  const warnings = [];

  // El trazado es complementario. Si falla, se devuelve la lista de coches
  // con una advertencia y sin inventar próximas paradas.
  try {
    const routeResult = await requestIsaenext("resourceRoutes", lineParams, {
      timeoutMs: 2500,
      maxSources: 2
    });
    routePayload = routeResult.data;
    if (!routePayload || (Array.isArray(routePayload) && routePayload.length === 0)) {
      throw new Error("resourceRoutes no devolvió el recorrido de la línea " + line + ".");
    }

    nodeIds = extractRouteStopIds(routePayload);
    if (!nodeIds.length && line === "01") {
      // IDs que aparecen en el enlace de resourceEstimations facilitado por el usuario.
      nodeIds = [...BURGOS_KNOWN_NODE_IDS];
    }
    if (!nodeIds.length) {
      const topKeys = Array.isArray(routePayload)
        ? (routePayload[0] && typeof routePayload[0] === "object" ? Object.keys(routePayload[0]).slice(0, 20) : ["elementos no objeto"])
        : (routePayload && typeof routePayload === "object" ? Object.keys(routePayload).slice(0, 20) : [typeof routePayload]);
      throw new Error("no se pudieron extraer IDs de parada. Claves visibles: " + topKeys.join(", ") + ".");
    }
    routeCount = Array.isArray(routePayload) ? routePayload.length : 1;
  } catch (error) {
    warnings.push("resourceRoutes: " + (error?.message || String(error)));
  }

  // Solo hay estimaciones consultables cuando el trazado entregó IDs de parada.
  if (!warnings.length) {
    try {
      const estimationResult = await requestIsaenext("resourceEstimations", {
        [PORTLET_PREFIX + "line"]: line,
        [PORTLET_PREFIX + "tipo"]: "1",
        [PORTLET_PREFIX + "nodoIds"]: nodeIds.join(",")
      }, {
        timeoutMs: 2500,
        maxSources: 2
      });
      if (!Array.isArray(estimationResult.data)) {
        throw new Error("resourceEstimations no devolvió una lista para la línea " + line + ".");
      }
      const routeNodeDetails = extractRouteNodeDetails(routePayload);
      const routeNodes = nodeIds.map(id => routeNodeDetails.get(id) || ({ num: id, __stopId: id }));
      observations = extractLineEstimations(line, routeNodes, estimationResult.data);
    } catch (error) {
      warnings.push("resourceEstimations: " + (error?.message || String(error)));
    }
  }

  // Las estimaciones completan destino/próxima parada; nunca eliminan los coches
  // ya publicados en resourceVehicles si la parte adicional falla.
  const bestEta = new Map();
  for (const observation of observations) {
    const seconds = Number.isFinite(observation.seconds) && observation.seconds >= 0
      ? observation.seconds : Infinity;
    const old = byId.get(observation.vehicleId);
    const oldEta = bestEta.get(observation.vehicleId) ?? Infinity;
    if (!old || seconds < oldEta) {
      const validLat = observation.vehicleLat !== null && observation.vehicleLat >= 42 && observation.vehicleLat <= 43;
      const validLon = observation.vehicleLon !== null && observation.vehicleLon >= -4 && observation.vehicleLon <= -3;
      byId.set(observation.vehicleId, {
        ...(old || {}),
        id: observation.vehicleId,
        lineId: line,
        line,
        destination: observation.destination || old?.destination || "Destino no publicado",
        direction: observation.direction || old?.direction || "",
        seconds: observation.seconds,
        meters: observation.meters,
        stopId: observation.stopId,
        stopName: observation.stopName,
        position: old?.position || {
          lat: validLat ? observation.vehicleLat : null,
          lon: validLon ? observation.vehicleLon : null,
          source: validLat && validLon ? "GPS publicado por resourceEstimations" : ""
        }
      });
      bestEta.set(observation.vehicleId, seconds);
    }
  }

  return {
    ok: true,
    line,
    fetchedAt: new Date().toISOString(),
    source: vehicleResult.source || BURGOS_SOURCE,
    sourceType: warnings.length
      ? "ISAENEXT · resourceVehicles por línea (parcial)"
      : "ISAENEXT · resourceRoutes + resourceVehicles + resourceEstimations por línea",
    routeStopCount: nodeIds.length,
    routeCount,
    vehicleRowCount: vehicleRows.length,
    estimationCount: observations.length,
    count: byId.size,
    partial: warnings.length > 0,
    warnings,
    vehicles: [...byId.values()],
    observations
  };
}

async function fetchSnapshot() {
  throw new Error("Consulta cada línea por separado: /api/burgos/vehicles?line=01&fresh=1");
}

async function fetchLiveSnapshot() {
  throw new Error("Consulta estimaciones por línea: /api/burgos/live?line=01&fresh=1");
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
        apiVersion: "sae-three-resources-per-line-v6",
        buildId: "burgos-live-v6.5-2026-10-19",
        source: BURGOS_SOURCE,
        lines: BURGOS_LINES.length,
        telegramScheduler: { configured: Boolean(env?.BURGOS_GITHUB_TOKEN), cadence: "*/2 * * * *" },
        endpoints: ["/api/burgos/vehicles?line=01&fresh=1", "/api/burgos/live?line=01&fresh=1"]
      });
    }

    if (url.pathname === "/api/burgos/live") {
      const line = String(url.searchParams.get("line") || "").trim().toUpperCase();
      if (!line || !BURGOS_LINES.includes(line)) {
        return jsonResponse(request, {
          ok: false,
          error: "Indica una línea concreta, por ejemplo /api/burgos/live?line=01&fresh=1.",
          allowedLines: BURGOS_LINES
        }, 400);
      }
      try {
        const data = await fetchVehiclesForLine(line);
        return jsonResponse(request, {
          ...data,
          lineCount: 1,
          totalLines: 1,
          completedGroups: 1,
          totalGroups: 1,
          partial: data.partial === true,
          warnings: data.warnings || [],
          resultCount: data.observations.length
        });
      } catch (error) {
        return jsonResponse(request, {
          ok: false,
          error: error?.message || "No se pudieron consultar las estimaciones de Burgos.",
          source: BURGOS_SOURCE,
          line,
          fetchedAt: new Date().toISOString()
        }, 502);
      }
    }

    if (url.pathname !== "/api/burgos/vehicles") {
      return jsonResponse(request, { ok: false, error: "Ruta no encontrada." }, 404);
    }

    const requestedLine = String(url.searchParams.get("line") || "").trim().toUpperCase();
    if (!requestedLine || !BURGOS_LINES.includes(requestedLine)) {
      return jsonResponse(request, {
        ok: false,
        error: "Consulta una línea por petición: /api/burgos/vehicles?line=01&fresh=1.",
        allowedLines: BURGOS_LINES
      }, 400);
    }

    const forceRefresh = url.searchParams.get("fresh") === "1";
    const cache = caches.default;
    const cacheKey = new URL("/__cache/burgos-vehicles?line=" +
      encodeURIComponent(requestedLine), url.origin);
    const cacheRequest = new Request(cacheKey.toString(), { method: "GET" });

    let cachedData = null;
    let cachedAgeMs = Infinity;
    try {
      const cached = await cache.match(cacheRequest);
      if (cached) {
        const data = await cached.json();
        const fetchedAt = Date.parse(String(data?.fetchedAt || ""));
        cachedAgeMs = Number.isFinite(fetchedAt) ? Math.max(0, Date.now() - fetchedAt) : Infinity;
        cachedData = data;
        if (!forceRefresh && cachedAgeMs <= 20000) {
          return jsonResponse(request, {
            ...data,
            cacheHit: true,
            stale: false,
            cacheAgeSeconds: Math.floor(cachedAgeMs / 1000)
          }, 200, { "Cache-Control": "public, max-age=8" });
        }
      }
    } catch {
      // La caché es opcional; la consulta directa sigue siendo el camino principal.
    }

    try {
      const data = await fetchVehicleListForLine(requestedLine);
      try {
        // Se conserva hasta 3 minutos para poder servir una copia marcada como antigua
        // si el Ayuntamiento tiene una interrupción transitoria.
        await cache.put(cacheRequest, new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=180"
          }
        }));
      } catch {
        // La respuesta sigue siendo válida si no se puede guardar la caché.
      }
      return jsonResponse(request, { ...data, stale: false, cacheHit: false }, 200, {
        "Cache-Control": "public, max-age=8"
      });
    } catch (error) {
      const ageAfterFailure = cachedData
        ? Math.max(0, Date.now() - (Date.parse(String(cachedData.fetchedAt || "")) || 0))
        : Infinity;
      if (cachedData && ageAfterFailure <= 180000 && Array.isArray(cachedData.vehicles)) {
        return jsonResponse(request, {
          ...cachedData,
          cacheHit: true,
          stale: true,
          staleAgeSeconds: Math.floor(ageAfterFailure / 1000),
          staleReason: error?.message || "La fuente municipal no respondió."
        }, 200, { "Cache-Control": "no-store" });
      }
      return jsonResponse(request, {
        ok: false,
        error: error?.message || "No se pudieron consultar los autobuses de Burgos.",
        source: BURGOS_SOURCE,
        line: requestedLine,
        fetchedAt: new Date().toISOString()
      }, 502);
    }
  }
};
