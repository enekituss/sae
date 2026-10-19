const REPOSITORY = "enekituss/sae";
const WORKFLOWS = [
  { file: "update-siri.yml", label: "Bizkaibus" },
  { file: "telegram-burgos.yml", label: "Telegram Burgos" }
];
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";
// URL canónica de Rutas en Directo que publica el portal de Movilidad.
const BURGOS_SOURCE = "https://movilidad.aytoburgos.es/rutas-en-directo";
const BURGOS_VEHICLES_SOURCE = BURGOS_SOURCE;
// Compatibilidad con las rutas /web/movilidad y el dominio municipal anterior.
const BURGOS_VEHICLES_COMPAT_SOURCE = "https://movilidad.aytoburgos.es/web/movilidad/rutas-en-directo";
const BURGOS_VEHICLES_LEGACY_SOURCE = "https://www.aytoburgos.es/web/movilidad/rutas-en-directo";
const BURGOS_LINES = [...Array.from({ length: 23 }, (_, i) => String(i + 1).padStart(2, "0")), "73", "87", "88", "89", "C1", "C2"];
const ALLOWED_ORIGIN = "https://enekituss.github.io";
const ISAENEXT_PORTLET = "as_asac_isaenext_IsaenextWebPortlet";
const TELEGRAM_WEBHOOK_BASE_URL = "https://bizkaibus-sae-dispatcher.ecanteroalvarez.workers.dev";

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
  const originalUrl = new URL(url.toString());
  const candidates = [originalUrl];

  // El portal oficial ha publicado el mismo módulo con dos rutas. Prueba ambas
  // en el dominio canónico y deja el dominio antiguo como último respaldo.
  if (originalUrl.hostname === "movilidad.aytoburgos.es") {
    const alternatePath = new URL(originalUrl.toString());
    alternatePath.pathname = originalUrl.pathname.startsWith("/web/movilidad/")
      ? originalUrl.pathname.replace("/web/movilidad/", "/")
      : originalUrl.pathname.replace("/", "/web/movilidad/");
    candidates.push(alternatePath);

    const legacyUrl = new URL(originalUrl.toString());
    legacyUrl.hostname = "www.aytoburgos.es";
    legacyUrl.pathname = "/web/movilidad/rutas-en-directo";
    candidates.push(legacyUrl);
  }

  const seen = new Set();
  const errors = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.toString())) continue;
    seen.add(candidate.toString());
    try {
      const response = await fetch(candidate.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter/1.0)",
          "Referer": "https://movilidad.aytoburgos.es/rutas-en-directo"
        },
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      try {
        return JSON.parse(body);
      } catch {
        throw new Error("respuesta no JSON");
      }
    } catch (error) {
      errors.push(candidate.hostname + candidate.pathname + ": " + (error?.message || String(error)));
    }
  }

  throw new Error("ISAENEXT falló en las rutas oficiales de Burgos. " + errors.join(" | "));
}


function isaenextVehiclesUrl(line, source = BURGOS_VEHICLES_SOURCE) {
  const timestamp = Date.now();
  const url = new URL(source);
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
  const sources = [BURGOS_VEHICLES_SOURCE, BURGOS_VEHICLES_COMPAT_SOURCE, BURGOS_VEHICLES_LEGACY_SOURCE];
  const errors = [];

  // Prioriza la dirección actual de Movilidad y conserva la antigua como respaldo.
  for (const source of sources) {
    try {
      const url = isaenextVehiclesUrl(line, source);
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter/1.0)",
          "Referer": source
        },
        signal: AbortSignal.timeout(12000)
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error("respuesta no es JSON reconocible");
      }
      if (!Array.isArray(payload)) {
        throw new Error("la respuesta no es una lista");
      }

      return payload.map(vehicle => ({
        ...vehicle,
        id: String(vehicle?.id ?? vehicle?.vehicleId ?? vehicle?.vehicle_id ?? "").trim(),
        lineId: line
      })).filter(vehicle => vehicle.id);
    } catch (error) {
      let host = source;
      try { host = new URL(source).hostname; } catch {}
      errors.push(host + ": " + (error?.message || String(error)));
    }
  }

  throw new Error("resourceVehicles de línea " + line + " falló en ambas direcciones. " + errors.join(" | "));
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


const TELEGRAM_PREFERENCES_BRANCH = "telegram-data";
const TELEGRAM_BOTS = {
  bizkaibus: {
    tokenEnv: "TELEGRAM_BIZKAIBUS_BOT_TOKEN",
    stateFile: "vehicle-alert-state.json",
    title: "🚌 Configuración de alertas SAE Bizkaibus"
  },
  burgos: {
    tokenEnv: "TELEGRAM_BURGOS_BOT_TOKEN",
    stateFile: "burgos-telegram-state.json",
    title: "🚌 SAE Spotter · Autobuses de Burgos"
  }
};
const TELEGRAM_KEYBOARD_ROWS = [
  ["🔔 Todos los avisos"],
  ["⚠️ Solo fuera de servicio"],
  ["🔄 Solo cambios de línea"],
  ["🟢 Nueva entrada (reaparición)"],
  ["📋 Ver coches seguidos", "➕ Añadir coche(s) por ID"],
  ["➖ Quitar coche(s) por ID"],
  ["⏸️ Pausar avisos", "❎ Cerrar menú"]
];

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToUtf8(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function githubAuthHeaders(env) {
  const token = String(env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("Falta el secreto GITHUB_TOKEN en Cloudflare Workers.");
  return {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SAE-Spotter-Cloudflare-Worker/1.0",
    "Authorization": "Bearer " + token
  };
}

async function readRepositoryFile(path, ref, env) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    GITHUB_API + "/repos/" + REPOSITORY + "/contents/" + encodedPath + "?ref=" + encodeURIComponent(ref),
    { headers: githubAuthHeaders(env) }
  );
  const raw = await response.text();
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error("GitHub no pudo leer " + path + " (HTTP " + response.status + "): " + raw.slice(0, 180));
  }
  const file = JSON.parse(raw);
  return {
    sha: file.sha,
    content: base64ToUtf8(file.content || "")
  };
}

async function writeRepositoryFile(path, content, message, refBranch, env) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readRepositoryFile(path, refBranch, env);
    const payload = {
      message,
      content: utf8ToBase64(content),
      branch: refBranch
    };
    if (current?.sha) payload.sha = current.sha;
    try {
      await githubRequest("/repos/" + REPOSITORY + "/contents/" + encodedPath, env, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return;
    } catch (error) {
      if (attempt === 2 || !/HTTP (409|422)/.test(error?.message || "")) throw error;
      // Re-read the latest SHA on the next attempt if another update won the race.
    }
  }
}

function defaultTelegramSubscription() {
  return {
    mode: "all",
    vehicleId: "",
    vehicleIds: [],
    awaitingVehicleId: false,
    awaitingVehicleAction: ""
  };
}

function parseTelegramIds(text) {
  return [...new Set(String(text || "").replace(/[,;]/g, " ").split(/\s+/)
    .map(value => value.trim()).filter(value => /^\d{1,12}$/.test(value)))];
}

function beginTelegramVehicleEdit(subscription, action) {
  if (!subscription.awaitingVehicleId) {
    subscription.modeBeforeVehicleEdit = String(subscription.mode || "all");
  }
  subscription.mode = "vehicle";
  subscription.awaitingVehicleId = true;
  subscription.awaitingVehicleAction = action === "remove" ? "remove" : "add";
}

function cancelTelegramVehicleEdit(subscription) {
  if (subscription.modeBeforeVehicleEdit) {
    subscription.mode = String(subscription.modeBeforeVehicleEdit);
  } else if (subscription.mode === "vehicle" && !normalizeTrackedIds(subscription).length) {
    subscription.mode = "all";
  }
  delete subscription.modeBeforeVehicleEdit;
  subscription.awaitingVehicleId = false;
  subscription.awaitingVehicleAction = "";
}

function applyTelegramVehicleIds(subscription, ids, action) {
  const existing = normalizeTrackedIds(subscription);
  const requested = [...new Set(ids)];
  if (action === "remove") {
    const removed = requested.filter(id => existing.includes(id));
    const notFound = requested.filter(id => !existing.includes(id));
    const remaining = existing.filter(id => !requested.includes(id));
    storeTrackedIds(subscription, remaining);
    subscription.mode = "vehicle";
    subscription.awaitingVehicleId = false;
    subscription.awaitingVehicleAction = "";
    delete subscription.modeBeforeVehicleEdit;
    const pieces = [];
    if (removed.length) pieces.push("🗑️ Eliminado(s): " + removed.join(", ") + ".");
    if (notFound.length) pieces.push("ℹ️ No estaban en tu lista: " + notFound.join(", ") + ".");
    pieces.push(remaining.length
      ? "📋 Sigues estos coches: " + remaining.join(", ") + "."
      : "📋 La lista está vacía; en modo de seguimiento por ID no recibirás avisos hasta añadir alguno o elegir otro filtro.");
    return pieces.join("\n");
  }

  const added = requested.filter(id => !existing.includes(id));
  const merged = existing.concat(added);
  storeTrackedIds(subscription, merged);
  subscription.mode = "vehicle";
  subscription.awaitingVehicleId = false;
  subscription.awaitingVehicleAction = "";
  delete subscription.modeBeforeVehicleEdit;
  let notice = added.length
    ? "✅ Añadido(s) al seguimiento: " + added.join(", ") + "."
    : "✅ Esos coches ya estaban en tu lista.";
  notice += "\n📋 Coches seguidos: " + (merged.length ? merged.join(", ") : "ninguno") + ".";
  return notice;
}
function normalizeTrackedIds(subscription) {
  const raw = Array.isArray(subscription.vehicleIds) ? subscription.vehicleIds : [];
  const legacy = String(subscription.vehicleId || "").trim();
  const candidates = legacy ? raw.concat([legacy]) : raw;
  const result = [];
  for (const value of candidates) {
    const id = String(value || "").trim();
    if (/^\d{1,12}$/.test(id) && !result.includes(id)) result.push(id);
  }
  return result;
}

function storeTrackedIds(subscription, ids) {
  const unique = [];
  for (const value of ids) {
    const id = String(value || "").trim();
    if (/^\d{1,12}$/.test(id) && !unique.includes(id)) unique.push(id);
  }
  subscription.vehicleIds = unique;
  subscription.vehicleId = unique[0] || "";
}

function telegramModeDescription(subscription) {
  const mode = String(subscription.mode || "all");
  if (mode === "off" || mode === "paused") return "Avisos pausados";
  if (mode === "missing") return "Solo autobuses cuya salida del servicio de datos se ha confirmado";
  if (mode === "line") return "Solo cambios de línea de vehículos que siguen activos";
  if (mode === "entry") return "Solo reapariciones de autobuses que habían desaparecido";
  if (mode === "vehicle") {
    const ids = normalizeTrackedIds(subscription);
    return ids.length ? "Siguiendo ID: " + ids.slice(0, 10).join(", ") + (ids.length > 10 ? " y " + (ids.length - 10) + " más" : "") : "Seguimiento por ID activado, pero la lista está vacía";
  }
  return "Todos los avisos";
}

function telegramKeyboard(city) {
  return {
    keyboard: TELEGRAM_KEYBOARD_ROWS.map(row => row.map(text => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
    input_field_placeholder: city === "burgos" ? "Elige tus avisos de Burgos" : "Elige tus avisos"
  };
}

function telegramTrackedListMessage(city, subscription) {
  const ids = normalizeTrackedIds(subscription);
  const title = TELEGRAM_BOTS[city].title;
  const shown = ids.slice(0, 180);
  let message = title + "\n\n📋 Coches seguidos por ID (" + ids.length + "):\n";
  message += shown.length ? shown.join(", ") : "No sigues ningún coche todavía.";
  if (ids.length > shown.length) message += "\n… y " + (ids.length - shown.length) + " más.";
  message += "\n\nAñadir: pulsa «➕ Añadir coche(s) por ID» o escribe /coche 123.";
  message += "\nEliminar: pulsa «➖ Quitar coche(s) por ID» o escribe /quitar 123.";
  message += "\nVer opciones: /avisos. Ocultar teclado: pulsa «❎ Cerrar menú».";
  message += "\nModo actual: " + telegramModeDescription(subscription) + ".";
  return message;
}
async function callTelegramApi(token, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error("Telegram " + method + " falló: " + String(result.description || response.statusText || response.status).slice(0, 200));
  }
  return result.result;
}

async function loadTelegramSubscription(city, chatId, env) {
  const path = "telegram-preferences/" + city + "/" + chatId + ".json";
  const saved = await readRepositoryFile(path, TELEGRAM_PREFERENCES_BRANCH, env);
  if (saved) {
    try {
      return JSON.parse(saved.content);
    } catch {
      throw new Error("Las preferencias guardadas de Telegram no son JSON válido.");
    }
  }

  // Migrate the subscriber's existing settings from the old shared monitor state.
  const legacyPath = TELEGRAM_BOTS[city].stateFile;
  try {
    const legacy = await readRepositoryFile(legacyPath, "main", env);
    const state = legacy ? JSON.parse(legacy.content) : {};
    const subscriptions = state.telegramSubscriptions || {};
    if (subscriptions[chatId] && typeof subscriptions[chatId] === "object") {
      return { ...defaultTelegramSubscription(), ...subscriptions[chatId] };
    }
  } catch (error) {
    console.warn("No se pudo migrar la preferencia anterior de " + city + ": " + (error?.message || String(error)));
  }
  return defaultTelegramSubscription();
}

async function saveTelegramSubscription(city, chatId, subscription, env) {
  const path = "telegram-preferences/" + city + "/" + chatId + ".json";
  const content = JSON.stringify(subscription, null, 2) + "\n";
  await writeRepositoryFile(path, content, "Guardar preferencias Telegram (" + city + ")", TELEGRAM_PREFERENCES_BRANCH, env);
}

async function sendTelegramMenu(token, city, chatId, subscription, notice = "") {
  const title = TELEGRAM_BOTS[city].title;
  const ids = normalizeTrackedIds(subscription);
  let message = title + "\n\n";
  if (notice) message += notice + "\n\n";
  message += "Configuración actual: " + telegramModeDescription(subscription) + "\n\nElige qué alertas quieres recibir:";
  if (String(subscription.mode || "all") === "vehicle") {
    message += "\n\nCoches seguidos: " + (ids.length ? ids.join(", ") : "ninguno") + ".";
  } else if (ids.length) {
    message += "\n\nCoches guardados para seguimiento por ID (" + ids.length + "): " +
      ids.slice(0, 20).join(", ") + (ids.length > 20 ? " y " + (ids.length - 20) + " más" : "") + ".";
  }
  if (String(subscription.mode || "all") === "off") {
    message += "\n\nPara reactivar los avisos, pulsa «Todos los avisos» o elige otro filtro.";
  }
  if (city === "bizkaibus") {
    message += "\n\n«Nueva entrada» avisa cuando un coche desaparecido vuelve a aparecer en el feed.";
  } else {
    message += "\n\nLa ausencia de posición publicada no confirma por sí sola una baja administrativa.";
  }
  message += "\n\nComandos: /avisos o /menu muestra este menú; /coches lista los IDs; /coche 123 añade un ID; /quitar 123 lo elimina.";
  message += "\nPulsa «❎ Cerrar menú» para ocultar los botones.";
  message += "\n\n⚡ Las preferencias se guardan al momento. Los avisos se ajustan en la siguiente comprobación de autobuses.";
  await callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    reply_markup: telegramKeyboard(city),
    disable_web_page_preview: true
  });
}
function telegramWebhookText(value) {
  return String(value || "").trim();
}

async function processTelegramWebhook(request, env, city) {
  const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const providedSecret = String(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "").trim();
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const botConfig = TELEGRAM_BOTS[city];
  const token = String(env[botConfig.tokenEnv] || "").trim();
  if (!token || !String(env.GITHUB_TOKEN || "").trim()) {
    return new Response("Webhook not configured", { status: 503 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = update?.message;
  const chat = message?.chat || {};
  const chatId = String(chat.id || "").trim();
  const rawText = telegramWebhookText(message?.text);
  if (!chatId || chat.type !== "private" || !rawText || !/^-?\d{1,20}$/.test(chatId)) {
    return new Response("ok", { status: 200 });
  }

  try {
    const subscription = {
      ...defaultTelegramSubscription(),
      ...(await loadTelegramSubscription(city, chatId, env))
    };
    const command = rawText.split(/\s+/)[0].split("@")[0].toLowerCase();
    let notice = "";
    let reply = "menu";
    let save = false;
    let handled = true;

    if (["/start", "/help", "/menu", "/menú", "/avisos", "/opciones", "menu", "menú"].includes(command)) {
      cancelTelegramVehicleEdit(subscription);
      notice = "Bot conectado. Tus preferencias son independientes de las de los demás usuarios.";
      save = true;
    } else if (["/coches", "/miscoches"].includes(command) ||
               ["📋 Ver coches seguidos", "Ver coches seguidos"].includes(rawText)) {
      if (subscription.awaitingVehicleId) cancelTelegramVehicleEdit(subscription);
      reply = "trackedList";
      save = true;
    } else if (["❎ Cerrar menú", "Cerrar menú", "Ocultar menú"].includes(rawText)) {
      cancelTelegramVehicleEdit(subscription);
      reply = "closeMenu";
      save = true;
    } else if (["➕ Añadir coche(s) por ID", "Añadir coche(s) por ID",
                "🚌 Seguir coche(s) por ID", "🚌 Seguir un coche por ID", "Seguir un coche por ID"].includes(rawText)) {
      beginTelegramVehicleEdit(subscription, "add");
      save = true;
      reply = "vehiclePrompt";
    } else if (["➖ Quitar coche(s) por ID", "Quitar coche(s) por ID"].includes(rawText)) {
      beginTelegramVehicleEdit(subscription, "remove");
      save = true;
      reply = "removePrompt";
    } else if (["/stop", "/pausar"].includes(command) || ["⏸️ Pausar avisos", "Pausar avisos"].includes(rawText)) {
      cancelTelegramVehicleEdit(subscription);
      subscription.mode = "off";
      subscription.awaitingVehicleId = false;
      subscription.awaitingVehicleAction = "";
      notice = "⏸️ Avisos pausados. No se enviarán más alertas hasta que los reactives.";
      save = true;
    } else if (["🔔 Todos los avisos", "Todos los avisos"].includes(rawText)) {
      cancelTelegramVehicleEdit(subscription);
      subscription.mode = "all";
      notice = "✅ Seleccionado: recibirás todos los avisos.";
      save = true;
    } else if (["⚠️ Solo fuera de servicio", "⚠️ Solo fuera de servicio (sin posición reciente)",
                "⚠️ Solo sin posición reciente", "Solo sin posición reciente"].includes(rawText)) {
      cancelTelegramVehicleEdit(subscription);
      subscription.mode = "missing";
      notice = city === "burgos"
        ? "✅ Seleccionado: solo recibirás avisos de coches que dejan de aparecer del servicio publicado tras las comprobaciones de confirmación."
        : "✅ Seleccionado: solo recibirás salidas de servicio confirmadas.";
      save = true;
    } else if (["🔄 Solo cambios de línea", "Solo cambios de línea"].includes(rawText)) {
      cancelTelegramVehicleEdit(subscription);
      subscription.mode = "line";
      notice = city === "burgos"
        ? "✅ Seleccionado: solo recibirás cambios confirmados de línea de autobuses que siguen activos."
        : "✅ Seleccionado: recibirás solo cambios de línea de vehículos que siguen activos.";
      save = true;
    } else if (["🟢 Nueva entrada (reaparición)", "🟢 Nueva entrada", "Nueva entrada"].includes(rawText)) {
      cancelTelegramVehicleEdit(subscription);
      subscription.mode = "entry";
      notice = city === "burgos"
        ? "✅ Seleccionado: recibirás avisos cuando un autobús desaparecido vuelva a aparecer en el feed."
        : "✅ Seleccionado: recibirás solo reapariciones de coches que habían desaparecido.";
      save = true;
    } else if (["/cancel", "/cancelar"].includes(command)) {
      cancelTelegramVehicleEdit(subscription);
      notice = "Operación cancelada.";
      save = true;
    } else if (["/coche", "/id"].includes(command)) {
      const requestedIds = parseTelegramIds(rawText.split(/\s+/).slice(1).join(" "));
      if (requestedIds.length) {
        notice = applyTelegramVehicleIds(subscription, requestedIds, "add");
        save = true;
      } else {
        beginTelegramVehicleEdit(subscription, "add");
        save = true;
        reply = "vehiclePrompt";
      }
    } else if (["/quitar", "/eliminar", "/borrar"].includes(command)) {
      const requestedIds = parseTelegramIds(rawText.split(/\s+/).slice(1).join(" "));
      if (requestedIds.length) {
        notice = applyTelegramVehicleIds(subscription, requestedIds, "remove");
        save = true;
      } else {
        beginTelegramVehicleEdit(subscription, "remove");
        save = true;
        reply = "removePrompt";
      }
    } else if (subscription.awaitingVehicleId) {
      const requestedIds = parseTelegramIds(rawText);
      if (requestedIds.length) {
        notice = applyTelegramVehicleIds(subscription, requestedIds, subscription.awaitingVehicleAction || "add");
        save = true;
      } else {
        reply = subscription.awaitingVehicleAction === "remove" ? "invalidRemoveIds" : "invalidVehicleId";
      }
    } else {
      handled = false;
    }

    if (!handled) return new Response("ok", { status: 200 });
    if (save) await saveTelegramSubscription(city, chatId, subscription, env);

    if (reply === "closeMenu") {
      await callTelegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: "✅ Menú ocultado. Para volver a mostrar las opciones, escribe /avisos o /menu.",
        reply_markup: { remove_keyboard: true }
      });
    } else if (reply === "trackedList") {
      await callTelegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: telegramTrackedListMessage(city, subscription),
        reply_markup: telegramKeyboard(city),
        disable_web_page_preview: true
      });
    } else if (reply === "vehiclePrompt" || reply === "removePrompt") {
      const remove = reply === "removePrompt";
      const ids = normalizeTrackedIds(subscription);
      await callTelegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: remove
          ? "➖ Escribe el ID o los ID que quieres dejar de seguir, separados por espacios o comas.\n\nAhora sigues: " + (ids.length ? ids.join(", ") : "ningún coche") + ".\n\nPuedes cancelar con /cancelar."
          : "➕ Escribe el ID o los ID de los autobuses que quieres añadir, separados por espacios o comas.\n\nYa guardados: " + (ids.length ? ids.join(", ") : "ninguno") + ".\n\nPuedes cancelar con /cancelar.",
        reply_markup: telegramKeyboard(city)
      });
    } else if (reply === "invalidVehicleId" || reply === "invalidRemoveIds") {
      await callTelegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: reply === "invalidRemoveIds"
          ? "No he reconocido IDs numéricos. Escribe los IDs que quieras quitar separados por espacios o comas, o usa /cancelar."
          : "No he reconocido IDs numéricos. Escribe los IDs que quieras añadir separados por espacios o comas, o usa /cancelar.",
        reply_markup: telegramKeyboard(city)
      });
    } else {
      await sendTelegramMenu(token, city, chatId, subscription, notice);
    }
    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("Telegram webhook " + city + ": " + (error?.message || String(error)));
    try {
      await callTelegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ No he podido guardar tu configuración. Comprueba que el secreto GITHUB_TOKEN del Worker permite Contents: Read and write."
      });
    } catch {
      return new Response("Temporary failure", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }
}

async function ensureTelegramWebhooks(env, origin = TELEGRAM_WEBHOOK_BASE_URL) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const missingCommon = [
    ["TELEGRAM_WEBHOOK_SECRET", secret],
    ["GITHUB_TOKEN", env.GITHUB_TOKEN]
  ].filter(([name, value]) => !String(value || "").trim()).map(([name]) => name);
  if (missingCommon.length) {
    throw new Error("Faltan secretos comunes del Worker: " + missingCommon.join(", "));
  }

  const configured = [];
  for (const city of ["bizkaibus", "burgos"]) {
    const tokenName = TELEGRAM_BOTS[city].tokenEnv;
    const token = String(env[tokenName] || "").trim();
    if (!token) {
      configured.push({
        bot: city,
        configured: false,
        alreadyConfigured: false,
        error: "Falta el secreto " + tokenName
      });
      continue;
    }

    const expectedUrl = origin + "/telegram/" + city;
    try {
      const info = await callTelegramApi(token, "getWebhookInfo", {});
      if (String(info?.url || "") === expectedUrl) {
        configured.push({ bot: city, configured: true, alreadyConfigured: true });
        continue;
      }
      const result = await callTelegramApi(token, "setWebhook", {
        url: expectedUrl,
        secret_token: secret,
        max_connections: 1,
        allowed_updates: ["message"],
        drop_pending_updates: false
      });
      configured.push({ bot: city, configured: Boolean(result), alreadyConfigured: false });
    } catch (error) {
      configured.push({
        bot: city,
        configured: false,
        alreadyConfigured: false,
        error: error?.message || String(error)
      });
    }
  }
  return configured;
}

async function setupTelegramWebhooks(request, env) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const authorization = String(request.headers.get("Authorization") || "").trim();
  if (!secret || authorization !== "Bearer " + secret) {
    return jsonResponse(request, { ok: false, error: "No autorizado." }, 401);
  }
  try {
    const configured = await ensureTelegramWebhooks(env, new URL(request.url).origin);
    return jsonResponse(request, {
      ok: true,
      webhooks: configured,
      message: "Webhooks registrados. Los mensajes del menú ya no dependen de GitHub Actions."
    });
  } catch (error) {
    console.error("No se pudieron registrar los webhooks de Telegram:", error?.message || String(error));
    return jsonResponse(request, { ok: false, error: error?.message || "Error al registrar webhooks." }, 502);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    try {
      const webhooks = await ensureTelegramWebhooks(env);
      const newlyConfigured = webhooks.filter(item => !item.alreadyConfigured);
      if (newlyConfigured.length) {
        console.log("Webhooks de Telegram configurados automáticamente: " + newlyConfigured.map(item => item.bot).join(", "));
      }
    } catch (error) {
      console.error("No se pudieron verificar/registrar automáticamente los webhooks de Telegram:", error?.message || String(error));
    }
    await dispatchUpdates(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/admin/telegram/setup") {
      return setupTelegramWebhooks(request, env);
    }

    if (request.method === "POST" && url.pathname === "/telegram/bizkaibus") {
      return processTelegramWebhook(request, env, "bizkaibus");
    }

    if (request.method === "POST" && url.pathname === "/telegram/burgos") {
      return processTelegramWebhook(request, env, "burgos");
    }


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
        telegramEndpoints: ["/telegram/bizkaibus", "/telegram/burgos", "POST /admin/telegram/setup"],
        telegramSecretStatus: {
          githubToken: Boolean(String(env.GITHUB_TOKEN || "").trim()),
          webhookSecret: Boolean(String(env.TELEGRAM_WEBHOOK_SECRET || "").trim()),
          bizkaibusBotToken: Boolean(String(env.TELEGRAM_BIZKAIBUS_BOT_TOKEN || "").trim()),
          burgosBotToken: Boolean(String(env.TELEGRAM_BURGOS_BOT_TOKEN || "").trim())
        },
        note: "Los webhooks de Telegram responden a las preferencias en el momento y guardan la configuración en una rama de datos separada. El Worker sigue lanzando los workflows de detección cada dos minutos. La fuente pública de Burgos entrega estimaciones por parada; las coordenadas sólo se consideran GPS si el servicio las publica."
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
