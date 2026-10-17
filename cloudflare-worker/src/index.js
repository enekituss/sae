const REPOSITORY = "enekituss/sae";
const WORKFLOW_FILE = "update-siri.yml";
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";

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
    // No escribimos cabeceras de autorización ni el token en los logs.
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
  // No acumulamos ejecuciones: si el procesamiento actual sigue en cola o en curso,
  // esta comprobación se omite y el siguiente Cron Trigger volverá a intentarlo.
  const running = await activeRuns("in_progress", env);
  if (running.length) {
    console.log("Actualización omitida: ya existe una ejecución en curso.");
    return { dispatched: false, reason: "in_progress" };
  }

  const queued = await activeRuns("queued", env);
  if (queued.length) {
    console.log("Actualización omitida: ya existe una ejecución en cola.");
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

export default {
  async scheduled(controller, env, ctx) {
    try {
      await dispatchUpdate(env);
    } catch (error) {
      // El siguiente intervalo vuelve a intentarlo automáticamente.
      console.error("No se pudo solicitar la actualización de GitHub Actions:", error?.message || String(error));
    }
  },

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "Bizkaibus SAE scheduler",
          cadence: "*/2 * * * *",
          purpose: "Solicita a GitHub Actions el procesamiento del feed y el envío de alertas de Telegram."
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    return new Response("Not found", { status: 404 });
  }
};
