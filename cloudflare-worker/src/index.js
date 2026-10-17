const REPOSITORY = "enekituss/sae";
const WORKFLOW_FILE = "update-siri.yml";
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";
const BURGOS_SOURCE = "https://movilidad.aytoburgos.es/rutas-en-directo";
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

async function activeRuns(status, env) {
  const path =
    "/repos/" + REPOSITORY +
    "/actions/workflows/" + WORKFLOW_FILE +
    "/runs?status=" + encodeURIComponent(status) + "&per_page=5";
  const data = await githubRequest(path, env);
  return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
}

async function dispatchUpdate(env) {
  const running = await activeRuns("in_progress", env);
  if (running.length) {
    console.log("Actualización Bizkaibus omitida: ya existe una ejecución en curso.");
    return { dispatched: false, reason: "in_progress" };
  }

  const queued = await activeRuns("queued", env);
  if (queued.length) {
    console.log("Actualización Bizkaibus omitida: ya existe una ejecución en cola.");
    return { dispatched: false, reason: "queued" };
  }

  await githubRequest(
    "/repos/" + REPOSITORY +
      "/actions/workflows/" + WORKFLOW_FILE + "/dispatches",
    env,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: BRANCH })
    }
  );

  console.log("Se ha solicitado una actualización del feed Bizkaibus SAE.");
  return { dispatched: true };
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

export default {
  async scheduled(controller, env, ctx) {
    try {
      await dispatchUpdate(env);
    } catch (error) {
      console.error("No se pudo solicitar la actualización de GitHub Actions:", error?.message || String(error));
    }
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
        endpoints: ["/api/burgos/nodes", "/api/burgos/estimates?stopId=200"],
        note: "El proxy da acceso al visor ISAENEXT desde la web. No añade coordenadas GPS de cada vehículo si la fuente no las publica."
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
