(() => {
  const DATA_FILE = "./burgos-vehicles.json";
  const REFRESH_MS = 60000;
  const STALE_AFTER_MS = 15 * 60 * 1000;
  const $ = id => document.getElementById(id);

  let vehicles = [];
  let snapshot = null;
  let lastSuccessfulUpdate = null;
  let updateRunning = false;
  const expandedLines = new Set();

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function setStatus(message, state) {
    $("statusText").textContent = message;
    $("dot").className = "status-dot" + (state ? " " + state : "");
  }

  function formatDate(value) {
    if (!value) return "Hora no disponible";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("es-ES", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  function displayLine(value) {
    const line = String(value || "").trim();
    return /^\d{1,2}$/.test(line) ? "Línea " + line.padStart(2, "0") : "Línea " + line;
  }

  function vehicleSearchFields(vehicle) {
    return [
      vehicle.id, vehicle.line, vehicle.destination, vehicle.direction,
      vehicle.model, vehicle.registration, vehicle.nextStop, vehicle.route
    ];
  }

  function groupByLine(list) {
    const groups = new Map();
    for (const vehicle of list) {
      const line = String(vehicle.line || vehicle.lineId || "").trim() || "Sin línea identificada";
      if (!groups.has(line)) groups.set(line, []);
      groups.get(line).push(vehicle);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => String(a.id).localeCompare(String(b.id), "es", {
        numeric: true, sensitivity: "base"
      }));
    }
    return groups;
  }

  function applySnapshot(data) {
    if (!data || !Array.isArray(data.vehicles)) {
      throw new Error("burgos-vehicles.json no contiene una lista válida de autobuses.");
    }
    snapshot = data;
    vehicles = data.vehicles.filter(item => item && String(item.id ?? "").trim());
    lastSuccessfulUpdate = data.fetchedAt ? new Date(data.fetchedAt) : null;
    if (lastSuccessfulUpdate && Number.isNaN(lastSuccessfulUpdate.getTime())) {
      lastSuccessfulUpdate = null;
    }
    $("lastUpdated").textContent = lastSuccessfulUpdate
      ? "Datos: " + formatDate(data.fetchedAt)
      : "Pendiente de primera actualización";
    render();
  }

  function render() {
    const groups = groupByLine(vehicles);
    const allLines = [...groups.keys()].sort((a, b) =>
      a.localeCompare(b, "es", { numeric: true, sensitivity: "base" })
    );
    $("vehicleCount").textContent = String(vehicles.length);
    $("lineCount").textContent = String(allLines.length);

    const query = $("search").value.trim().toLocaleLowerCase("es");
    const matchingLines = allLines.filter(line => {
      const lineMatches = line.toLocaleLowerCase("es").includes(query) ||
        displayLine(line).toLocaleLowerCase("es").includes(query);
      return !query || lineMatches || groups.get(line).some(vehicle =>
        vehicleSearchFields(vehicle).some(value =>
          String(value || "").toLocaleLowerCase("es").includes(query)
        )
      );
    });

    const container = $("lines");
    container.innerHTML = "";
    if (!matchingLines.length) {
      let message;
      if (query) {
        message = "No hay líneas ni autobuses activos que coincidan con la búsqueda.";
      } else if (!lastSuccessfulUpdate) {
        message = "Esperando a que termine la primera actualización automática de autobuses de Burgos.";
      } else {
        message = "La última consulta completa no ha encontrado autobuses activos publicados por ISAENEXT.";
      }
      container.innerHTML = '<div class="message">' + escapeHTML(message) +
        (!lastSuccessfulUpdate && !query
          ? '<br><br><a href="https://github.com/enekituss/sae/actions/workflows/update-burgos-vehicles.yml" target="_blank" rel="noopener noreferrer">Ver o ejecutar la actualización de Burgos</a>'
          : "") + "</div>";
      return;
    }

    for (const line of matchingLines) {
      const lineVehicles = groups.get(line);
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
        const details = [
          vehicle.registration ? "<strong>Matrícula:</strong><br>" + escapeHTML(vehicle.registration) : "",
          vehicle.model ? "<strong>Modelo:</strong><br>" + escapeHTML(vehicle.model) : "",
          vehicle.nextStop ? "<strong>Próxima parada:</strong><br>" + escapeHTML(vehicle.nextStop) : ""
        ].filter(Boolean).join("<br>");
        cards += '<article class="vehicle"><div class="vehicle-main">' +
          '<div class="vehicle-id"><span class="bus-icon" aria-hidden="true">🚌</span><span>' +
          escapeHTML(vehicle.id) + "</span></div>" + destination + direction + "</div>" +
          '<div class="vehicle-meta">' + (details || "<strong>Estado</strong><br>Publicado en la lista activa municipal") +
          "</div></article>";
      }
      section.innerHTML =
        '<button class="line-head" type="button" aria-expanded="' + isOpen +
        '" aria-label="Mostrar autobuses de ' + escapeHTML(displayLine(line)) + '">' +
        '<span class="line-leading"><span class="line-chevron" aria-hidden="true">›</span><span>' +
        '<span class="line-name">' + escapeHTML(displayLine(line)) + "</span>" +
        '<span class="line-subtitle">' + lineVehicles.length + (lineVehicles.length === 1 ? " autobús activo" : " autobuses activos") + "</span>" +
        "</span></span><span class=\"badge\">" + lineVehicles.length + (lineVehicles.length === 1 ? " activo" : " activos") +
        "</span></button><div class=\"vehicles\">" + cards + "</div>";
      section.querySelector(".line-head").addEventListener("click", () => {
        if (expandedLines.has(line)) expandedLines.delete(line);
        else expandedLines.add(line);
        render();
      });
      container.appendChild(section);
    }
  }

  async function load() {
    if (updateRunning) return;
    updateRunning = true;
    $("refresh").disabled = true;
    $("refresh").innerHTML = '<span aria-hidden="true">↻</span> Cargando';
    setStatus("Leyendo la copia publicada de autobuses de Burgos…", "");
    try {
      const url = new URL(DATA_FILE, window.location.href);
      url.searchParams.set("_", String(Date.now()));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      let response;
      try {
        response = await fetch(url.toString(), {
          cache: "no-store",
          headers: { "Accept": "application/json" },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!response.ok) throw new Error("burgos-vehicles.json respondió HTTP " + response.status);
      applySnapshot(await response.json());
      if (!lastSuccessfulUpdate) {
        setStatus("Esperando la primera actualización automática", "");
      } else {
        const age = Date.now() - lastSuccessfulUpdate.getTime();
        if (age > STALE_AFTER_MS) {
          setStatus("Copia antigua · " + Math.floor(age / 60000) + " min desde la última actualización", "error");
        } else {
          setStatus("Datos publicados · " + vehicles.length + " autobuses activos", "ok");
        }
      }
    } catch (error) {
      console.error("No se pudo leer la copia de autobuses de Burgos:", error);
      setStatus("No se ha podido leer la copia publicada", "error");
      if (!snapshot) {
        $("lines").innerHTML = '<div class="message error"><strong>No se han podido cargar los autobuses urbanos de Burgos.</strong><br>' +
          '<span>' + escapeHTML(error.message || error) + '</span><br><br>' +
          '<a href="https://github.com/enekituss/sae/actions/workflows/update-burgos-vehicles.yml" target="_blank" rel="noopener noreferrer">Abrir la actualización automática de Burgos</a></div>';
      } else {
        $("lastUpdated").textContent = "No se pudo actualizar; se conserva la última copia cargada";
      }
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
