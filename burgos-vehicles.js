(() => {
  const BASE_URL = "https://www.aytoburgos.es/web/movilidad/rutas-en-directo";
  const PORTLET_ID = "as_asac_isaenext_IsaenextWebPortlet";
  const PORTLET_PREFIX = "_as_asac_isaenext_IsaenextWebPortlet_";
  const PROXIES = [
    "https://corsproxy.io/?",
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest="
  ];
  const ALL_LINES = [
    ...Array.from({length: 23}, (_, i) => String(i + 1).padStart(2, "0")),
    "73", "87", "88", "89", "C1", "C2"
  ];
  const REFRESH_MS = 60000;
  const REQUEST_TIMEOUT_MS = 8000;
  const MAX_CONCURRENT_LINES = 8;
  const $ = id => document.getElementById(id);

  let lineSnapshots = new Map();
  let staleLines = new Set();
  let lastSuccessfulUpdate = null;
  let updateRunning = false;
  let lastQueryHadSuccess = false;

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function setStatus(message, state) {
    $("statusText").textContent = message;
    $("dot").className = "status-dot" + (state ? " " + state : "");
  }

  function formatTime(value) {
    if (!value) return "Hora no disponible";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString("es-ES", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
  }

  function displayLine(value) {
    const line = String(value || "").trim();
    return /^\d{1,2}$/.test(line) ? "Línea " + line.padStart(2, "0") : "Línea " + line;
  }

  function buildVehicleUrl(line) {
    const timestamp = String(Date.now());
    const url = new URL(BASE_URL);
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
    return url.toString();
  }

  async function fetchVehicleJson(targetUrl) {
    const failures = [];
    for (const proxy of PROXIES) {
      const finalUrl = proxy + encodeURIComponent(targetUrl);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(finalUrl, {
          method: "GET",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        let text = await response.text();
        if (!text || text.trim() === "null" || text.trim() === "[]") return [];
        if (text.startsWith("URL_DECODED:")) {
          text = decodeURIComponent(text.slice("URL_DECODED:".length));
        }
        const payload = JSON.parse(text);
        if (!Array.isArray(payload)) throw new Error("La fuente no devolvió una lista.");
        return payload;
      } catch (error) {
        failures.push(error && error.message ? error.message : String(error));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw new Error(failures.join(" · ") || "No hay respuesta de los proxies.");
  }

  function normalizeVehicle(bus, line) {
    const rawId = bus.id ?? bus.vehicleId ?? bus.vehicle_id ?? bus.vehicle ??
      bus.vehiculo ?? bus.vehicleNumber ?? bus.number ?? bus.fleetNumber ?? bus.calca;
    const id = String(rawId ?? "").trim();
    if (!id) return null;
    return {
      ...bus,
      id,
      line: line,
      destination: String(bus.destination ?? bus.destino ?? bus.headsign ?? bus.destinationName ?? bus.destiny ?? "").trim(),
      direction: String(bus.direction ?? bus.sentido ?? bus.direccion ?? "").trim(),
      model: String(bus.model ?? bus.modelo ?? bus.vehicleModel ?? "").trim(),
      registration: String(bus.matricula ?? bus.registration ?? bus.plate ?? bus.licensePlate ?? "").trim(),
      nextStop: String(bus.paradaProxima ?? bus.nextNodeId ?? bus.nextStop ?? bus.stopId ?? bus.stop_id ?? "").trim()
    };
  }

  async function fetchLine(line) {
    const payload = await fetchVehicleJson(buildVehicleUrl(line));
    const vehicles = payload.map(bus => normalizeVehicle(bus, line)).filter(Boolean);
    return {line, vehicles};
  }

  function vehicleSearchFields(vehicle) {
    return [
      vehicle.id, vehicle.line, vehicle.destination, vehicle.direction,
      vehicle.model, vehicle.registration, vehicle.nextStop, vehicle.ruta, vehicle.route
    ];
  }

  function allVehiclesByLine() {
    const groups = new Map();
    for (const [line, vehicles] of lineSnapshots.entries()) {
      if (vehicles.length) groups.set(line, vehicles);
    }
    for (const vehicles of groups.values()) {
      vehicles.sort((a, b) => String(a.id).localeCompare(String(b.id), "es", {
        numeric: true, sensitivity: "base"
      }));
    }
    return groups;
  }

  function render() {
    const groups = allVehiclesByLine();
    const allLines = [...groups.keys()].sort((a, b) =>
      a.localeCompare(b, "es", {numeric: true, sensitivity: "base"})
    );
    const allVehicles = allLines.flatMap(line => groups.get(line));
    $("vehicleCount").textContent = String(allVehicles.length);
    $("lineCount").textContent = String(allLines.length);

    const query = $("search").value.trim().toLocaleLowerCase("es");
    const matchingLines = allLines.filter(line =>
      displayLine(line).toLocaleLowerCase("es").includes(query) ||
      line.toLocaleLowerCase("es").includes(query) ||
      groups.get(line).some(vehicle =>
        vehicleSearchFields(vehicle).some(value =>
          String(value || "").toLocaleLowerCase("es").includes(query)
        )
      )
    );

    const container = $("lines");
    container.innerHTML = "";
    if (!matchingLines.length) {
      let message;
      if (query) {
        message = "No hay líneas ni autobuses activos que coincidan con la búsqueda.";
      } else if (!lastQueryHadSuccess) {
        message = "No se ha podido consultar ISAENEXT mediante los proxies disponibles.";
        container.innerHTML = '<div class="message error"><strong>' + escapeHTML(message) + '</strong><br>' +
          '<span>Comprueba la conexión o consulta los visores que usan esta misma fuente.</span><br><br>' +
          '<a href="https://enekituss.github.io/samyt/" target="_blank" rel="noopener noreferrer">Abrir SAMYT</a> · ' +
          '<a href="https://webburgos.com/bus/" target="_blank" rel="noopener noreferrer">Abrir WebBurgos</a></div>';
        return;
      } else {
        message = "No hay autobuses activos en las respuestas consultadas.";
      }
      container.innerHTML = '<div class="message">' + escapeHTML(message) + "</div>";
      return;
    }

    for (const line of matchingLines) {
      const lineVehicles = groups.get(line);
      const isStale = staleLines.has(line);
      const section = document.createElement("section");
      section.className = "line" + (query ? " open" : "");
      let cards = "";
      for (const vehicle of lineVehicles) {
        const destination = vehicle.destination
          ? '<div class="vehicle-direction"><strong>Destino:</strong> ' + escapeHTML(vehicle.destination) + "</div>"
          : "";
        const direction = vehicle.direction
          ? '<div class="vehicle-direction"><strong>Sentido:</strong> ' + escapeHTML(vehicle.direction) + "</div>"
          : "";
        const details = [
          vehicle.registration ? "<strong>Matrícula:</strong><br>" + escapeHTML(vehicle.registration) : "",
          vehicle.model ? "<strong>Modelo:</strong><br>" + escapeHTML(vehicle.model) : "",
          vehicle.nextStop ? "<strong>Próxima parada:</strong><br>" + escapeHTML(vehicle.nextStop) : ""
        ].filter(Boolean).join("<br>");
        cards += '<article class="vehicle"><div class="vehicle-main">' +
          '<div class="vehicle-id"><span class="bus-icon" aria-hidden="true">🚌</span><span>' +
          escapeHTML(vehicle.id) + "</span></div>" + destination + direction + "</div>" +
          '<div class="vehicle-meta">' + (details || "<strong>Estado</strong><br>Publicado en resourceVehicles") +
          "</div></article>";
      }
      section.innerHTML =
        '<button class="line-head" type="button" aria-expanded="' + Boolean(query) +
        '" aria-label="Mostrar autobuses de ' + escapeHTML(displayLine(line)) + '">' +
        '<span class="line-leading"><span class="line-chevron" aria-hidden="true">›</span><span>' +
        '<span class="line-name">' + escapeHTML(displayLine(line)) + "</span>" +
        '<span class="line-subtitle">' + lineVehicles.length +
        (lineVehicles.length === 1 ? " autobús activo" : " autobuses activos") +
        (isStale ? " · última respuesta conservada" : "") + "</span>" +
        "</span></span><span class=\"badge\">" + lineVehicles.length +
        (lineVehicles.length === 1 ? " activo" : " activos") + "</span></button>" +
        '<div class="vehicles">' + cards + "</div>";
      section.querySelector(".line-head").addEventListener("click", () => {
        section.classList.toggle("open");
        section.querySelector(".line-head").setAttribute("aria-expanded", section.classList.contains("open") ? "true" : "false");
      });
      container.appendChild(section);
    }
  }

  async function load() {
    if (updateRunning) return;
    updateRunning = true;
    $("refresh").disabled = true;
    $("refresh").innerHTML = '<span aria-hidden="true">↻</span> Consultando';
    setStatus("Consultando coches por línea en ISAENEXT…", "");
    try {
      const results = new Array(ALL_LINES.length);
      let cursor = 0;
      const errors = [];
      await Promise.all(Array.from({length: MAX_CONCURRENT_LINES}, async () => {
        while (true) {
          const index = cursor++;
          if (index >= ALL_LINES.length) return;
          const line = ALL_LINES[index];
          try {
            results[index] = await fetchLine(line);
          } catch (error) {
            errors.push({line, message: String(error && error.message ? error.message : error)});
            results[index] = null;
          }
        }
      }));

      const successful = results.filter(Boolean);
      if (!successful.length) {
        lastQueryHadSuccess = false;
        setStatus("No se ha podido acceder a la API municipal ni a sus proxies.", "error");
        if (!lineSnapshots.size) render();
        return;
      }

      const nextStaleLines = new Set();
      for (const result of successful) lineSnapshots.set(result.line, result.vehicles);
      for (const error of errors) {
        if (lineSnapshots.has(error.line)) nextStaleLines.add(error.line);
      }
      staleLines = nextStaleLines;
      lastQueryHadSuccess = true;
      lastSuccessfulUpdate = new Date();
      $("lastUpdated").textContent = "Consulta: " + formatTime(lastSuccessfulUpdate.toISOString());

      const vehicleCount = [...lineSnapshots.values()].reduce((total, list) => total + list.length, 0);
      if (successful.length === ALL_LINES.length) {
        setStatus("Datos en directo · " + vehicleCount + " autobuses en " + allVehiclesByLine().size + " líneas", "ok");
      } else {
        setStatus("Datos parciales · " + successful.length + "/" + ALL_LINES.length +
          " líneas consultadas; se conserva la última respuesta de líneas con errores.", "error");
      }
      render();
    } catch (error) {
      console.error("No se pudieron consultar los autobuses de Burgos:", error);
      setStatus("Error al consultar la fuente de autobuses de Burgos.", "error");
      if (!lineSnapshots.size) render();
    } finally {
      updateRunning = false;
      $("refresh").disabled = false;
      $("refresh").innerHTML = '<span aria-hidden="true">↻</span> Actualizar';
    }
  }

  $("refresh").addEventListener("click", load);
  $("search").addEventListener("input", render);
  load();
  setInterval(load, REFRESH_MS);
})();
