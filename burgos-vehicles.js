(() => {
  const BASE_URL = "https://www.aytoburgos.es/web/movilidad/rutas-en-directo";
  const PORTLET_ID = "as_asac_isaenext_IsaenextWebPortlet";
  const PORTLET_PREFIX = "_as_asac_isaenext_IsaenextWebPortlet_";
  // El Worker propio es la conexión preferida. Los proxies públicos son solo respaldo.
  const PROXIES = [
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest="
  ];
  // Worker dedicado a Burgos: viene configurado por defecto en el proyecto.
  const DEFAULT_WORKER_URL = "https://burgos-sae-spotter.ecanteroalvarez.workers.dev";
  const WORKER_STORAGE_KEY = "saeBurgosDedicatedWorkerUrl";
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
  const expandedLines = new Set();
  let lastSuccessfulUpdate = null;
  let updateRunning = false;
  let lastQueryHadSuccess = false;
  let nextStopByVehicle = new Map();
  let nextStopQueryRunning = false;
  let gtfsData = null;
  let gtfsLoading = false;
  const itineraryByVehicle = new Map();

  function normalizeLineKey(value) {
    return String(value ?? "").trim().toUpperCase()
      .replace(/^L[IÍ]NEA\s*/u, "")
      .replace(/^L(?=\d)/, "")
      .replace(/^0+(?=\d)/, "")
      .replace(/[^A-Z0-9]/g, "");
  }

  function vehicleStopKey(vehicleId, line) {
    const id = String(vehicleId ?? "").trim();
    const lineKey = normalizeLineKey(line);
    return id && lineKey ? id + "|" + lineKey : "";
  }

  function nonNegativeNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function isBetterStop(candidate, current) {
    if (!current) return true;
    if (candidate.seconds !== null && current.seconds !== null) {
      return candidate.seconds < current.seconds ||
        (candidate.seconds === current.seconds &&
          candidate.meters !== null && (current.meters === null || candidate.meters < current.meters));
    }
    if (candidate.seconds !== null) return true;
    if (current.seconds !== null) return false;
    if (candidate.meters !== null && current.meters !== null) return candidate.meters < current.meters;
    return candidate.meters !== null && current.meters === null;
  }

  function formatEstimatedArrival(seconds) {
    const value = nonNegativeNumber(seconds);
    if (value === null) return "";
    if (value <= 15) return "Llegada inminente";
    if (value < 60) return "menos de 1 min";
    return "≈ " + Math.round(value / 60) + " min";
  }

  function normalizeWords(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  function destinationScore(a, b) {
    const ignored = new Set(["de", "del", "la", "el", "los", "las", "a", "al", "y", "estacion", "parada"]);
    const aa = normalizeWords(a).filter(word => !ignored.has(word));
    const bb = normalizeWords(b).filter(word => !ignored.has(word));
    if (!aa.length || !bb.length) return 0;
    const bset = new Set(bb);
    let shared = 0;
    for (const token of aa) if (bset.has(token)) shared++;
    return shared / Math.max(aa.length, bb.length);
  }

  function distanceMeters(a, b) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
  }

  async function loadGtfsForItinerary() {
    if (gtfsLoading || gtfsData) return;
    gtfsLoading = true;
    try {
      const response = await fetch("./burgos-data.json", {
        method: "GET",
        cache: "force-cache",
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error("burgos-data.json respondió HTTP " + response.status);
      const data = await response.json();
      data.stops = Array.isArray(data.stops) ? data.stops : [];
      data.routes = Array.isArray(data.routes) ? data.routes : [];
      data.trips = Array.isArray(data.trips) ? data.trips : [];
      data.stopById = new Map(data.stops.map(stop => [String(stop.id), stop]));
      data.routeById = new Map(data.routes.map(route => [String(route.id), route]));
      data.tripsByLineStop = new Map();

      for (const trip of data.trips) {
        const route = data.routeById.get(String(trip.routeId));
        const lineKeys = [...new Set([route?.shortName, route?.id]
          .map(normalizeLineKey).filter(Boolean))];
        const stops = Array.isArray(trip.stops) ? trip.stops : [];
        stops.forEach((stopTime, stopIndex) => {
          const stopId = String(stopTime?.[0] ?? "").trim();
          if (!stopId) return;
          for (const line of lineKeys) {
            const key = line + "|" + stopId;
            if (!data.tripsByLineStop.has(key)) data.tripsByLineStop.set(key, []);
            data.tripsByLineStop.get(key).push({ trip, route, stopIndex });
          }
        });
      }

      gtfsData = data;
      itineraryByVehicle.clear();
      console.info("SAE Burgos: GTFS cargado para itinerarios.",
        "Líneas:", data.routes.length, "paradas:", data.stops.length, "viajes:", data.trips.length);
      render();
    } catch (error) {
      console.warn("No se pudieron cargar los itinerarios GTFS de Burgos:", error?.message || String(error));
    } finally {
      gtfsLoading = false;
    }
  }

  function matchTripForNextStop(observation) {
    if (!gtfsData || !Array.isArray(gtfsData.stops)) return null;
    const lat = Number(observation.stopLat);
    const lon = Number(observation.stopLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const line = normalizeLineKey(observation.line);
    if (!line) return null;

    const nearby = [];
    for (const stop of gtfsData.stops) {
      const stopLat = Number(stop.lat);
      const stopLon = Number(stop.lon);
      if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) continue;
      const distance = distanceMeters({ lat, lon }, { lat: stopLat, lon: stopLon });
      if (distance <= 280) nearby.push({ stop, distance });
    }
    nearby.sort((a, b) => a.distance - b.distance);

    const candidates = [];
    for (const item of nearby.slice(0, 8)) {
      const rows = gtfsData.tripsByLineStop.get(line + "|" + String(item.stop.id)) || [];
      for (const row of rows) {
        const trip = row.trip;
        candidates.push({
          ...row,
          matchedStop: item.stop,
          stopDistance: item.distance,
          score: destinationScore(observation.destination, trip.headsign)
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || a.stopDistance - b.stopDistance);

    if (candidates[0].score === 0) {
      const possibleDestinations = new Set(candidates.map(candidate =>
        normalizeWords(candidate.trip.headsign).join(" ")
      ));
      if (possibleDestinations.size > 1) return null;
    }
    return candidates[0];
  }

  function getVehicleItinerary(vehicle) {
    const key = vehicleStopKey(vehicle.id, vehicle.line);
    if (!key) return null;
    if (itineraryByVehicle.has(key)) return itineraryByVehicle.get(key);
    const observation = nextStopByVehicle.get(key);
    if (!observation || !gtfsData) return null;

    const match = matchTripForNextStop({ ...observation, line: vehicle.line });
    if (!match) {
      itineraryByVehicle.set(key, null);
      return null;
    }
    const tripStops = Array.isArray(match.trip.stops) ? match.trip.stops : [];
    const remaining = tripStops.slice(match.stopIndex);
    if (!remaining.length) {
      itineraryByVehicle.set(key, null);
      return null;
    }
    const stops = remaining.map(item => {
      const id = String(item?.[0] ?? "").trim();
      const stop = gtfsData.stopById.get(id);
      return { id, name: String(stop?.name || ("Parada " + id)).trim() };
    }).filter(stop => stop.id && stop.name);
    if (stops.length < 2) {
      itineraryByVehicle.set(key, null);
      return null;
    }
    const itinerary = {
      destination: String(match.trip.headsign || observation.destination || "").trim(),
      stops,
      totalStops: stops.length,
      source: "GTFS de Burgos; secuencia orientativa desde la próxima parada estimada"
    };
    itineraryByVehicle.set(key, itinerary);
    return itinerary;
  }

  async function refreshNextStopData(workerBase) {
    if (!workerBase || nextStopQueryRunning) return;
    nextStopQueryRunning = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch(workerBase + "/api/burgos/live", {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error("La API de estimaciones no devolvió JSON."); }
      if (!response.ok) throw new Error(payload?.error || ("API de próximas paradas HTTP " + response.status));
      if (!Array.isArray(payload?.observations)) {
        throw new Error(payload?.error || "La API no devuelve estimaciones por parada.");
      }

      const next = new Map();
      for (const observation of payload.observations) {
        const key = vehicleStopKey(observation.vehicleId, observation.line);
        if (!key) continue;
        const stopId = String(observation.stopId ?? "").trim();
        const stopName = String(observation.stopName ?? "").trim();
        if (!stopName && !stopId) continue;
        const candidate = {
          stopId,
          stopName: stopName || ("Parada " + stopId),
          seconds: nonNegativeNumber(observation.seconds),
          meters: nonNegativeNumber(observation.meters),
          destination: String(observation.destination ?? "").trim(),
          line: String(observation.line ?? "").trim(),
          vehicleId: String(observation.vehicleId ?? "").trim(),
          stopLat: observation.stopLat === null || observation.stopLat === undefined ? null : Number(observation.stopLat),
          stopLon: observation.stopLon === null || observation.stopLon === undefined ? null : Number(observation.stopLon)
        };
        const current = next.get(key);
        if (isBetterStop(candidate, current)) next.set(key, candidate);
      }

      nextStopByVehicle = next;
      itineraryByVehicle.clear();
      // Carga de la secuencia GTFS en paralelo con la consulta en directo.
      loadGtfsForItinerary();
      console.info("SAE Burgos: próxima parada localizada para", next.size, "combinaciones vehículo/línea;",
        "estimaciones recibidas:", payload.observations.length,
        "paradas consultadas:", payload.stopCount,
        "consulta parcial:", Boolean(payload.partial));
      render();
    } catch (error) {
      console.warn("No se pudieron actualizar las próximas paradas de Burgos:", error?.message || String(error));
      // Si la fuente de estimaciones falla, conservamos las próximas paradas de la última consulta válida.
    } finally {
      clearTimeout(timeoutId);
      nextStopQueryRunning = false;
    }
  }

  function normalizeWorkerBase(value) {
    let base = String(value || "").trim();
    if (!base) return "";
    if (!/^https?:\/\//i.test(base)) throw new Error("La URL debe comenzar por https://");
    base = base.replace(/\/+$/, "");
    base = base.replace(/\/api\/burgos\/vehicles$/i, "");
    return base;
  }

  function getWorkerBaseUrl() {
    try {
      // Una URL guardada permite sustituirla en el futuro; si no hay ninguna,
      // utiliza automáticamente el Worker de Burgos incluido en este proyecto.
      return normalizeWorkerBase(localStorage.getItem(WORKER_STORAGE_KEY) || DEFAULT_WORKER_URL);
    } catch {
      return DEFAULT_WORKER_URL;
    }
  }

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
      nextStop: String(bus.paradaProxima ?? bus.nextNodeId ?? bus.nextStop ?? bus.stopId ?? bus.stop_id ?? "").trim(),
      nextStopName: String(bus.nextStopName ?? bus.paradaProximaName ?? bus.stopName ?? "").trim()
    };
  }

  async function fetchWorkerSnapshot(workerBase) {
    // Una sola petición al Worker evita saturarlo con 29 llamadas paralelas.
    // El Worker consulta las líneas de forma limitada y comunica cuáles fallan.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(workerBase + "/api/burgos/vehicles", {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("El Worker no devolvió JSON.");
      }
      if (!response.ok) {
        throw new Error(payload?.error || ("Worker HTTP " + response.status));
      }
      if (!Array.isArray(payload?.vehicles)) {
        throw new Error("El Worker no devolvió la lista de autobuses.");
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchLine(line) {
    const payload = await fetchVehicleJson(buildVehicleUrl(line));
    const vehicles = payload.map(bus => normalizeVehicle(bus, line)).filter(Boolean);
    return {line, vehicles};
  }

  function vehicleSearchFields(vehicle) {
    return [
      vehicle.id, vehicle.line, vehicle.destination, vehicle.direction,
      vehicle.model, vehicle.registration, vehicle.nextStop, vehicle.nextStopName, vehicle.ruta, vehicle.route,
      nextStopByVehicle.get(vehicleStopKey(vehicle.id, vehicle.line))?.stopName,
      ...(getVehicleItinerary(vehicle)?.stops || []).map(stop => stop.name)
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
        message = getWorkerBaseUrl()
          ? "No se ha podido consultar ISAENEXT a través del Worker configurado."
          : "Los proxies públicos no han respondido. Configura el Worker de Cloudflare para una conexión estable.";
        container.innerHTML = '<div class="message error"><strong>' + escapeHTML(message) + '</strong><br>' +
          '<span>En «Configurar conexión», pega la URL base del Worker de Cloudflare (la que termina en workers.dev) y guarda.</span><br><br>' +
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
      const isOpen = expandedLines.has(line) || Boolean(query);
      const section = document.createElement("section");
      section.className = "line" + (isOpen ? " open" : "");
      let cards = "";
      for (const vehicle of lineVehicles) {
        const destination = vehicle.destination
          ? '<div class="vehicle-direction"><strong>Destino:</strong> ' + escapeHTML(vehicle.destination) + "</div>"
          : "";
        const direction = vehicle.direction
          ? '<div class="vehicle-direction"><strong>Sentido:</strong> ' + escapeHTML(vehicle.direction) + "</div>"
          : "";
        const nextStop = nextStopByVehicle.get(vehicleStopKey(vehicle.id, vehicle.line));
        const nextStopTitle = nextStop?.stopName || vehicle.nextStopName ||
          (vehicle.nextStop ? "Parada " + vehicle.nextStop : "");
        const arrivalText = nextStop ? formatEstimatedArrival(nextStop.seconds) : "";
        const distanceText = nextStop && nextStop.meters !== null && nextStop.meters > 0
          ? Math.round(nextStop.meters) + " m" : "";
        const itinerary = nextStop ? getVehicleItinerary(vehicle) : null;
        const itineraryDetail = itinerary
          ? '<details class="upcoming-stops"><summary>Ver itinerario (' + itinerary.stops.length + ' paradas)</summary><ol>' +
            itinerary.stops.map((stop, index) => '<li' + (index === 0 ? ' class="upcoming-stop-next"' : '') + '>' +
              escapeHTML(stop.name) + '</li>').join("") + '</ol><small>Recorrido de referencia del GTFS. La estimación en directo se muestra solo para la próxima parada.</small></details>'
          : "";
        const nextStopDetail = nextStopTitle
          ? "<strong>Próxima parada:</strong><br>" + escapeHTML(nextStopTitle) +
            (arrivalText ? "<br><span>Llegada estimada: " + escapeHTML(arrivalText) + "</span>" : "") +
            (distanceText ? "<br><span>Distancia estimada: " + escapeHTML(distanceText) + "</span>" : "") +
            itineraryDetail
          : "";
        const details = [
          vehicle.registration ? "<strong>Matrícula:</strong><br>" + escapeHTML(vehicle.registration) : "",
          vehicle.model ? "<strong>Modelo:</strong><br>" + escapeHTML(vehicle.model) : "",
          nextStopDetail
        ].filter(Boolean).join("<br>");
        cards += '<article class="vehicle"><div class="vehicle-main">' +
          '<div class="vehicle-id"><span class="bus-icon" aria-hidden="true">🚌</span><span>' +
          escapeHTML(vehicle.id) + "</span></div>" + destination + direction + "</div>" +
          '<div class="vehicle-meta">' + (details || "<strong>Estado</strong><br>Publicado en resourceVehicles") +
          "</div></article>";
      }
      section.innerHTML =
        '<button class="line-head" type="button" aria-expanded="' + isOpen +
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
        if (expandedLines.has(line)) expandedLines.delete(line);
        else expandedLines.add(line);
        const open = expandedLines.has(line) || Boolean($("search").value.trim());
        section.classList.toggle("open", open);
        section.querySelector(".line-head").setAttribute("aria-expanded", open ? "true" : "false");
      });
      container.appendChild(section);
    }
  }

  async function load() {
    if (updateRunning) return;
    updateRunning = true;
    $("refresh").disabled = true;
    $("refresh").innerHTML = '<span aria-hidden="true">↻</span> Consultando';
    setStatus(getWorkerBaseUrl()
      ? "Consultando coches por línea a través del Worker…"
      : "Sin Worker configurado · probando conexiones de respaldo…", "");
    try {
      const workerBase = getWorkerBaseUrl();
      let nextStaleLines = new Set();
      let successfulCount = 0;

      if (workerBase) {
        const snapshot = await fetchWorkerSnapshot(workerBase);
        const failedLines = new Set((Array.isArray(snapshot.failedLines) ? snapshot.failedLines : [])
          .map(line => String(line).trim().toUpperCase()));
        const rows = Array.isArray(snapshot.vehicles) ? snapshot.vehicles : [];

        for (const line of ALL_LINES) {
          if (failedLines.has(line)) {
            if (lineSnapshots.has(line)) nextStaleLines.add(line);
            continue;
          }
          const lineRows = rows.filter(bus =>
            String(bus.lineId ?? bus.line ?? "").trim().toUpperCase() === line
          );
          lineSnapshots.set(line, lineRows.map(bus => normalizeVehicle(bus, line)).filter(Boolean));
          successfulCount++;
        }

        if (successfulCount === 0) {
          throw new Error("El Worker no ha podido consultar ninguna línea de autobús.");
        }
        if (failedLines.size) {
          console.warn("SAE Spotter · líneas de Burgos que no respondieron:", [...failedLines], snapshot.warnings || []);
        }
        staleLines = nextStaleLines;
        lastQueryHadSuccess = true;
        lastSuccessfulUpdate = new Date();
        $("lastUpdated").textContent = "Consulta: " + formatTime(snapshot.fetchedAt || lastSuccessfulUpdate.toISOString());

        const vehicleCount = [...lineSnapshots.values()].reduce((total, list) => total + list.length, 0);
        if (failedLines.size || snapshot.partial) {
          setStatus("Datos parciales · " + (snapshot.lineCount ?? successfulCount) + "/" +
            (snapshot.totalLines ?? ALL_LINES.length) + " líneas consultadas. " +
            "Fallos: " + [...failedLines].join(", ") +
            (failedLines.size ? "; se conserva la última respuesta de esas líneas." : ""), "error");
        } else {
          setStatus("Datos en directo · " + vehicleCount + " autobuses en " +
            allVehiclesByLine().size + " líneas (" + successfulCount + "/" + ALL_LINES.length + " consultadas)", "ok");
        }
        render();
        refreshNextStopData(workerBase);
      } else {
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
      }
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

  $("workerUrlInput").value = getWorkerBaseUrl();
  $("saveWorkerUrl").addEventListener("click", async () => {
    try {
      const base = normalizeWorkerBase($("workerUrlInput").value);
      if (!base) throw new Error("Pega la URL base de tu Worker de Cloudflare.");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let healthResponse;
      try {
        healthResponse = await fetch(base + "/health", {
          method: "GET",
          cache: "no-store",
          headers: { "Accept": "application/json" },
          signal: controller.signal
        });
      } catch {
        throw new Error("No se puede abrir esa URL. Comprueba la dirección workers.dev y que el Worker esté desplegado.");
      } finally {
        clearTimeout(timeoutId);
      }
      if (!healthResponse.ok) throw new Error("El Worker respondió HTTP " + healthResponse.status + " en /health.");
      const health = await healthResponse.json();
      if (health?.ok !== true) throw new Error("La URL no parece corresponder al Worker de SAE Spotter.");
      localStorage.setItem(WORKER_STORAGE_KEY, base);
      setStatus("Worker verificado · consultando autobuses…", "");
      await load();
    } catch (error) {
      setStatus(error?.message || "No se ha podido guardar la conexión.", "error");
    }
  });
  $("clearWorkerUrl").addEventListener("click", async () => {
    try { localStorage.removeItem(WORKER_STORAGE_KEY); } catch {}
    $("workerUrlInput").value = DEFAULT_WORKER_URL;
    setStatus("URL predeterminada del Worker de Burgos restaurada.", "");
    await load();
  });

  load();
  setInterval(load, REFRESH_MS);
})();
