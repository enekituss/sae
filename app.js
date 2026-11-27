(() => {
  "use strict";

  const WORKER_BASE = "https://burgos-sae-spotter.ecanteroalvarez.workers.dev";
  const GTFS_URL = "./burgos-data.json";
  const MODELS_URL = "./burgos-modelos.json";
  const REFRESH_MS = 45000;
  const $ = id => document.getElementById(id);
  const state = {
    gtfs: null,
    models: {},
    selectedCode: "",
    route: null,
    directions: [],
    live: null,
    lastUpdated: null,
    loading: false,
    timer: null
  };

  const normalize = value => String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es").replace(/[^a-z0-9]+/g, " ").trim();

  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  function normalizeLine(value) {
    const clean = String(value ?? "").trim().toUpperCase().replace(/^0+(?=\d)/, "");
    return clean || String(value ?? "").trim().toUpperCase();
  }

  function apiLineCode(value) {
    const normalized = normalizeLine(value);
    if (/^\d+$/.test(normalized) && Number(normalized) <= 23) {
      return normalized.padStart(2, "0");
    }
    return normalized;
  }

  function setConnection(message, mode) {
    $("connectionText").textContent = message;
    $("connectionDot").className = "connection-dot" + (mode ? " " + mode : "");
  }

  function setNotice(message, mode, loading) {
    const box = $("diagramNotice");
    box.className = "notice notice-" + (mode || "info");
    box.innerHTML = (loading ? '<span class="notice-spinner" aria-hidden="true"></span>' : "") +
      "<span>" + escapeHTML(message) + "</span>";
  }

  function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("es-ES", {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(date);
  }

  function formatETA(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "";
    const value = Math.max(0, Number(seconds));
    if (value <= 15) return "Llegada inminente";
    if (value < 60) return "Menos de 1 min";
    return "≈ " + Math.round(value / 60) + " min";
  }

  function formatDistance(meters) {
    if (meters === null || meters === undefined || !Number.isFinite(Number(meters)) || Number(meters) < 0) return "";
    const value = Number(meters);
    return value >= 1000 ? (value / 1000).toFixed(1).replace(".", ",") + " km" : Math.round(value) + " m";
  }

  function formatDelay(seconds) {
    if (seconds === null || !Number.isFinite(seconds)) {
      return { text: "Sin cálculo", className: "delay-unknown" };
    }
    if (seconds > 90) {
      return { text: "+" + Math.max(1, Math.round(seconds / 60)) + " min", className: "delay-late" };
    }
    if (seconds < -90) {
      return { text: "−" + Math.max(1, Math.round(Math.abs(seconds) / 60)) + " min", className: "delay-early" };
    }
    return { text: "En hora", className: "delay-ok" };
  }

  function stopForId(id) {
    return state.gtfs.stopById.get(String(id ?? "")) || null;
  }

  function stopRowsForTrip(trip) {
    return (Array.isArray(trip.stops) ? trip.stops : []).map((item, index) => {
      const id = String(item?.[0] ?? "").trim();
      const stop = stopForId(id);
      return {
        id,
        name: String(stop?.name || ("Parada " + id)),
        code: String(stop?.code || ""),
        lat: Number(stop?.lat),
        lon: Number(stop?.lon),
        arrival: String(item?.[1] ?? ""),
        departure: String(item?.[2] ?? ""),
        sequence: String(item?.[3] ?? index + 1),
        index
      };
    }).filter(stop => stop.id);
  }

  function buildDirections(route) {
    const allTrips = state.gtfs.trips.filter(trip => String(trip.routeId) === String(route.id));
    const groups = new Map();

    for (const trip of allTrips) {
      const directionId = String(trip.directionId ?? "").trim();
      const headsign = String(trip.headsign || "").trim();
      const directionToken = directionId !== "" ? "d:" + directionId : "h:" + normalize(headsign);
      const groupKey = directionToken + "|" + normalize(headsign);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          directionId,
          headsign,
          trips: [],
          token: directionToken
        });
      }
      groups.get(groupKey).trips.push(trip);
    }

    const preferred = new Map();
    for (const group of groups.values()) {
      const previous = preferred.get(group.token);
      if (!previous || group.trips.length > previous.trips.length) {
        preferred.set(group.token, group);
      }
    }

    const chosen = [...preferred.values()].sort((a, b) => {
      if (a.directionId !== "" && b.directionId !== "") {
        return Number(a.directionId) - Number(b.directionId);
      }
      if (a.directionId !== "") return -1;
      if (b.directionId !== "") return 1;
      return b.trips.length - a.trips.length;
    }).slice(0, 2);

    return chosen.map((group, index) => {
      const representative = [...group.trips].sort((a, b) => {
        const aStops = Array.isArray(a.stops) ? a.stops.length : 0;
        const bStops = Array.isArray(b.stops) ? b.stops.length : 0;
        return bStops - aStops;
      })[0];
      const stops = stopRowsForTrip(representative);
      const label = group.headsign || (index === 0 ? "Sentido 1" : "Sentido 2");
      const shapePoints = state.gtfs.shapeById.get(String(representative.shapeId || "")) || [];
      const stopMeasures = stops.map(stop => {
        const projected = projectPointToPolyline(stop, shapePoints);
        return projected && projected.distance <= 350 ? projected.measure : null;
      });
      return {
        id: group.directionId || label,
        directionId: group.directionId,
        headsign: label,
        trips: group.trips,
        representative,
        stops,
        shapeId: String(representative.shapeId || ""),
        shapePoints,
        stopMeasures,
        count: group.trips.length,
        color: index === 0 ? "#477a9c" : "#c47a28"
      };
    }).filter(direction => direction.stops.length > 1);
  }


  function validPosition(position) {
    if (!position || position.lat === null || position.lat === undefined ||
        position.lon === null || position.lon === undefined) return false;
    const lat = Number(position.lat);
    const lon = Number(position.lon);
    return Number.isFinite(lat) && lat >= 42 && lat <= 43 &&
      Number.isFinite(lon) && lon >= -4 && lon <= -3;
  }

  // Proyecta una coordenada sobre la geometría GTFS y devuelve su avance
  // acumulado por la línea, además de la distancia lateral al trazado.
  function projectPointToPolyline(point, points) {
    if (!validPosition(point) || !Array.isArray(points) || points.length < 2) return null;
    const lat0 = Number(point.lat);
    const lon0 = Number(point.lon);
    const metresLat = 111132;
    const metresLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    let cumulative = 0;
    let best = null;

    const coords = points.map(value => ({
      lat: Number(Array.isArray(value) ? value[0] : value.lat),
      lon: Number(Array.isArray(value) ? value[1] : value.lon)
    }));

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) ||
          !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
      const ax = (a.lon - lon0) * metresLon;
      const ay = (a.lat - lat0) * metresLat;
      const bx = (b.lon - lon0) * metresLon;
      const by = (b.lat - lat0) * metresLat;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const length = Math.sqrt(lengthSquared);
      if (!length) continue;
      const fraction = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
      const projectedX = ax + fraction * dx;
      const projectedY = ay + fraction * dy;
      const distance = Math.hypot(projectedX, projectedY);
      if (!best || distance < best.distance) {
        best = {
          distance,
          measure: cumulative + fraction * length,
          segmentIndex: i,
          fraction
        };
      }
      cumulative += length;
    }
    return best;
  }

  function busDiagramPosition(direction, bus, reverse) {
    const count = direction.stops.length;
    if (count < 2) return null;

    let actualSegment = -1;
    let actualFraction = 0.8;
    let source = "estimación";

    if (validPosition(bus.position) && direction.shapePoints?.length > 1) {
      const vehicleMeasure = projectPointToPolyline(bus.position, direction.shapePoints);
      if (vehicleMeasure && vehicleMeasure.distance <= 220) {
        let bestGap = Infinity;
        const measures = direction.stopMeasures || [];
        for (let i = 0; i < measures.length - 1; i++) {
          const start = measures[i];
          const end = measures[i + 1];
          if (!Number.isFinite(start) || !Number.isFinite(end) || Math.abs(end - start) < 1) continue;
          const low = Math.min(start, end);
          const high = Math.max(start, end);
          const gap = vehicleMeasure.measure < low
            ? low - vehicleMeasure.measure
            : vehicleMeasure.measure > high ? vehicleMeasure.measure - high : 0;
          if (gap < bestGap) {
            bestGap = gap;
            actualSegment = i;
            actualFraction = Math.max(0, Math.min(1,
              (vehicleMeasure.measure - start) / (end - start)));
          }
        }
        if (bestGap > 350) actualSegment = -1;
        else source = "GPS";
      }
    }

    // Si no hay coordenadas fiables, sitúa el coche justo antes de su próxima
    // parada publicada; nunca lo coloca en una parada de otro sentido.
    if (actualSegment < 0) {
      const nextStopIndex = findStopIndex(direction, bus);
      if (nextStopIndex < 0) return null;
      actualSegment = nextStopIndex === 0 ? 0 : nextStopIndex - 1;
      actualFraction = nextStopIndex === 0 ? 0.08 : 0.82;
      source = "estimación";
    }

    const displaySegment = reverse ? count - 2 - actualSegment : actualSegment;
    const displayFraction = reverse ? 1 - actualFraction : actualFraction;
    return {
      segmentIndex: Math.max(0, Math.min(count - 2, displaySegment)),
      fraction: Math.max(0, Math.min(1, displayFraction)),
      source
    };
  }

  function dateKey(date) {
    return String(date.getFullYear()) +
      String(date.getMonth() + 1).padStart(2, "0") +
      String(date.getDate()).padStart(2, "0");
  }

  function serviceIsActive(serviceId, date) {
    const key = dateKey(date);
    const exception = (state.gtfs.exceptions || []).find(item =>
      String(item.serviceId) === String(serviceId) && String(item.date) === key
    );
    if (exception) return Number(exception.exceptionType) === 1;

    const day = date.getDay();
    const weekdayIndex = (day + 6) % 7;
    const calendar = (state.gtfs.calendar || []).find(item =>
      String(item.serviceId) === String(serviceId)
    );
    if (!calendar) return false;
    const start = String(calendar.startDate || "").replace(/-/g, "");
    const end = String(calendar.endDate || "").replace(/-/g, "");
    const weekdays = Array.isArray(calendar.weekdays) ? calendar.weekdays : [];
    return key >= start && key <= end && Boolean(weekdays[weekdayIndex]);
  }

  function gtfsSeconds(value) {
    const match = String(value ?? "").trim().match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
  }

  function closestDayTime(rawSeconds, expectedSeconds) {
    let candidate = rawSeconds;
    while (candidate - expectedSeconds > 43200) candidate -= 86400;
    while (expectedSeconds - candidate > 43200) candidate += 86400;
    return candidate;
  }

  function findStopIndex(direction, bus) {
    const stopId = String(bus.stopId ?? "").trim();
    if (stopId) {
      const direct = direction.stops.findIndex(stop => stop.id === stopId || stop.code === stopId);
      if (direct >= 0) return direct;
    }

    const stopName = normalize(bus.stopName);
    if (stopName) {
      const exact = direction.stops.findIndex(stop => normalize(stop.name) === stopName);
      if (exact >= 0) return exact;
    }

    return -1;
  }

  function destinationScore(destination, headsign) {
    const a = normalize(destination);
    const b = normalize(headsign);
    if (!a || !b) return 0;
    if (a === b) return 10;
    if (a.includes(b) || b.includes(a)) return 5;
    const words = b.split(" ").filter(word => word.length > 3);
    return words.filter(word => a.includes(word)).length;
  }

  function assignVehicles(directions, vehicles) {
    const assignments = new Map(directions.map(direction => [direction.id, []]));
    const unassigned = [];

    for (const bus of vehicles) {
      const scored = directions.map(direction => {
        let score = 0;
        const reportedDirection = String(bus.direction ?? "").trim();
        if (reportedDirection && direction.directionId &&
            reportedDirection === direction.directionId) score += 100;

        const destination = destinationScore(bus.destination, direction.headsign);
        if (destination > 0) score += 30 + destination * 3;

        const stopIndex = findStopIndex(direction, bus);
        if (stopIndex >= 0) {
          const matchingDirections = directions.filter(item => findStopIndex(item, bus) >= 0).length;
          score += matchingDirections === 1 ? 45 : 3;
        }

        if (validPosition(bus.position) && direction.shapePoints?.length > 1) {
          const projection = projectPointToPolyline(bus.position, direction.shapePoints);
          if (projection && projection.distance <= 300) {
            score += Math.max(0, 38 - projection.distance / 10);
          }
        }
        return { direction, score };
      }).sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];
      const uniquelyMatched = best && best.score > 0 &&
        (!second || best.score > second.score + 1);
      if (uniquelyMatched) assignments.get(best.direction.id).push(bus);
      else if (directions.length === 1) assignments.get(directions[0].id).push(bus);
      else unassigned.push(bus);
    }

    return { assignments, unassigned };
  }

  function estimatedDelay(bus, direction) {
    if (bus.seconds === null || bus.seconds === undefined || !Number.isFinite(Number(bus.seconds))) return null;
    const stopName = normalize(bus.stopName);
    const stopId = String(bus.stopId ?? "").trim();
    if (!stopName && !stopId) return null;

    const now = new Date();
    const expected = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + Number(bus.seconds);
    let best = null;

    const trips = direction.trips.filter(trip => serviceIsActive(trip.serviceId, now));
    for (const trip of trips) {
      const tripStops = Array.isArray(trip.stops) ? trip.stops : [];
      for (const item of tripStops) {
        const id = String(item?.[0] ?? "").trim();
        const stop = stopForId(id);
        const idMatches = stopId && (id === stopId || String(stop?.code || "") === stopId);
        const nameMatches = stopName && stop && normalize(stop.name) === stopName;
        if (!idMatches && !nameMatches) continue;

        const planned = gtfsSeconds(item?.[1]) ?? gtfsSeconds(item?.[2]);
        if (planned === null) continue;
        const adjusted = closestDayTime(planned, expected);
        const difference = expected - adjusted;
        const distance = Math.abs(difference);
        if (!best || distance < best.distance) {
          best = { distance, difference, trip };
        }
      }
    }

    if (!best || best.distance > 2700) return null;
    return { seconds: best.difference, trip: best.trip };
  }

  function busStatus(bus, direction) {
    const delay = estimatedDelay(bus, direction);
    return delay ? formatDelay(delay.seconds) : formatDelay(null);
  }

  function renderBusMarker(bus, direction, position, slot) {
    const delay = busStatus(bus, direction);
    const eta = formatETA(bus.seconds);
    const distance = formatDistance(bus.meters);
    const detail = eta || (position.source === "GPS" ? "GPS en recorrido" : "Próxima parada");
    const title = "Coche " + bus.id + " · " + (eta || "sin estimación") +
      (distance ? " · " + distance : "") + " · " + delay.text;
    return '<div class="bus-marker" data-segment="' + position.segmentIndex +
      '" data-fraction="' + position.fraction + '" data-slot="' + slot +
      '" title="' + escapeHTML(title) + '">' +
      '<span class="bus-marker-icon" aria-hidden="true">🚌</span>' +
      '<strong>' + escapeHTML(bus.id) + '</strong>' +
      '<small>' + escapeHTML(detail) + '</small>' +
      '<span class="delay-pill ' + delay.className + '">' + escapeHTML(delay.text) + '</span>' +
      '</div>';
  }

  function renderBranch(branch, index, assignments, showOwnTerminals) {
    const direction = branch.direction;
    const buses = assignments.get(direction.id) || [];
    const displayStops = branch.reverse ? direction.stops.slice().reverse() : direction.stops;
    const placements = [];
    const unlocated = [];
    const slotBySegment = new Map();

    for (const bus of buses) {
      const position = busDiagramPosition(direction, bus, branch.reverse);
      if (!position) {
        unlocated.push(bus);
        continue;
      }
      const slot = slotBySegment.get(position.segmentIndex) || 0;
      slotBySegment.set(position.segmentIndex, slot + 1);
      placements.push(renderBusMarker(bus, direction, position, slot));
    }

    const stopsHTML = displayStops.map((stop, displayIndex) => {
      const sequence = branch.reverse ? direction.stops.length - displayIndex : displayIndex + 1;
      return '<li class="stop-item" data-stop-index="' + displayIndex + '">' +
        '<span class="stop-node" aria-hidden="true"></span>' +
        '<div class="stop-name"><span class="stop-sequence">' + sequence + '</span>' +
        escapeHTML(stop.name) + '</div>' +
        '</li>';
    }).join("");

    const start = direction.stops[0].name;
    const end = direction.stops[direction.stops.length - 1].name;
    const ownTerminals = showOwnTerminals
      ? '<div class="branch-terminals"><span><small>ORIGEN</small><strong>' +
        escapeHTML(start) + '</strong></span><i aria-hidden="true">→</i><span><small>DESTINO</small><strong>' +
        escapeHTML(end) + '</strong></span></div>'
      : "";

    const unlocatedHTML = unlocated.length
      ? '<div class="unlocated-buses"><strong>Sin parada o posición asociable</strong>' +
        unlocated.map(bus => '<span class="unlocated-bus">🚌 ' + escapeHTML(bus.id) + '</span>').join("") +
        '</div>'
      : "";

    const directionTitle = direction.headsign || ("Sentido " + (index + 1));
    const arrow = branch.reverse ? "↑" : "↓";
    const busCount = buses.length
      ? buses.length + (buses.length === 1 ? " autobús" : " autobuses")
      : "Sin autobuses detectados";

    return '<article class="branch-lane" style="--direction-color:' + direction.color + '">' +
      '<header class="branch-head">' +
        '<div><span class="direction-label">SENTIDO ' + (index + 1) + '</span>' +
        '<h3>' + escapeHTML(directionTitle) + '</h3></div>' +
        '<div class="branch-direction"><strong>' + arrow + '</strong><small>' +
        (branch.reverse ? "Circulación ascendente" : "Circulación descendente") +
        '</small><em>' + busCount + '</em></div>' +
      '</header>' +
      ownTerminals +
      '<div class="branch-body">' +
        '<ol class="stop-list">' + stopsHTML + '</ol>' +
        '<div class="bus-layer">' + placements.join("") + '</div>' +
      '</div>' +
      unlocatedHTML +
    '</article>';
  }

  function renderRouteConnector(type, single) {
    if (single) {
      const path = type === "top" ? "M50 0 V34" : "M50 0 V34";
      return '<div class="route-connector route-connector-' + type + ' single-connector">' +
        '<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><path d="' + path +
        '" fill="none" stroke="#9aabb5" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div>';
    }
    const path = type === "top"
      ? "M50 0 V12 H25 V34 M50 12 H75 V34"
      : "M25 0 V20 H50 V34 M75 0 V20 H50 V34";
    return '<div class="route-connector route-connector-' + type + '">' +
      '<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><path d="' + path +
      '" fill="none" stroke="#9aabb5" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div>';
  }

  function resolveRouteLayout(directions) {
    if (!directions.length) return { mode: "empty", branches: [] };
    if (directions.length === 1) {
      return {
        mode: "single",
        top: directions[0].stops[0],
        bottom: directions[0].stops.at(-1),
        branches: [{ direction: directions[0], reverse: false }]
      };
    }

    const first = directions[0];
    const second = directions[1];
    const firstStart = first.stops[0]?.id;
    const firstEnd = first.stops.at(-1)?.id;
    const secondStart = second.stops[0]?.id;
    const secondEnd = second.stops.at(-1)?.id;

    if (firstStart === secondEnd && firstEnd === secondStart) {
      return {
        mode: "paired",
        top: first.stops[0],
        bottom: first.stops.at(-1),
        branches: [
          { direction: first, reverse: false },
          { direction: second, reverse: true }
        ]
      };
    }
    return {
      mode: "independent",
      branches: directions.map(direction => ({ direction, reverse: false }))
    };
  }

  function renderLoopDiagram(directions, assignments) {
    const layout = resolveRouteLayout(directions);
    if (layout.mode === "empty") {
      return '<div class="empty-state">El GTFS actual no contiene viajes con paradas para esta línea. No se dibuja un recorrido inventado.</div>';
    }

    if (layout.mode === "independent") {
      return '<div class="route-loop independent-loop"><div class="loop-branches">' +
        layout.branches.map((branch, index) =>
          renderBranch(branch, index, assignments, true)
        ).join("") +
        '</div><p class="loop-note">El GTFS publica cabeceras distintas para estos recorridos; se muestran por separado sin unirlos artificialmente.</p></div>';
    }

    const topName = layout.top?.name || "Cabecera";
    const bottomName = layout.bottom?.name || "Cabecera";
    const single = layout.mode === "single";
    const branchesClass = single ? "loop-branches single-branch" : "loop-branches";
    const branchesHTML = layout.branches.map((branch, index) =>
      renderBranch(branch, index, assignments, false)
    ).join("");

    return '<div class="route-loop">' +
      '<div class="loop-terminal"><span>CABECERA</span><strong>' + escapeHTML(topName) + '</strong></div>' +
      renderRouteConnector("top", single) +
      '<div class="' + branchesClass + '">' + branchesHTML + '</div>' +
      renderRouteConnector("bottom", single) +
      '<div class="loop-terminal loop-terminal-bottom"><span>CABECERA</span><strong>' +
      escapeHTML(bottomName) + '</strong></div>' +
      '</div>';
  }

  function positionBusMarkers(root) {
    root.querySelectorAll(".branch-body").forEach(body => {
      const items = [...body.querySelectorAll(".stop-item")];
      const layer = body.querySelector(".bus-layer");
      if (!layer || !items.length) return;
      const layerRect = layer.getBoundingClientRect();

      layer.querySelectorAll(".bus-marker").forEach(marker => {
        const segment = Number(marker.dataset.segment);
        const fraction = Math.max(0, Math.min(1, Number(marker.dataset.fraction)));
        const firstItem = items[Math.max(0, Math.min(items.length - 1, segment))];
        const secondItem = items[Math.max(0, Math.min(items.length - 1, segment + 1))];
        const firstNode = firstItem?.querySelector(".stop-node");
        const secondNode = secondItem?.querySelector(".stop-node");
        if (!firstNode || !secondNode) return;

        const firstRect = firstNode.getBoundingClientRect();
        const secondRect = secondNode.getBoundingClientRect();
        const firstY = firstRect.top + firstRect.height / 2 - layerRect.top;
        const secondY = secondRect.top + secondRect.height / 2 - layerRect.top;
        const slot = Number(marker.dataset.slot) || 0;
        const stagger = slot === 0 ? 0 : (slot % 2 ? 18 : -18) * Math.ceil(slot / 2);
        marker.style.top = (firstY + (secondY - firstY) * fraction + stagger) + "px";
        marker.style.left = (43 + (slot % 3) * 13) + "px";
      });
    });
  }

  function renderFleet(vehicles, directions, assignments) {
    $("fleetCaption").textContent = vehicles.length
      ? vehicles.length + (vehicles.length === 1 ? " autobús detectado" : " autobuses detectados")
      : "No se han detectado autobuses";

    if (!vehicles.length) {
      $("fleetList").innerHTML = '<div class="empty-state">No aparecen autobuses en la respuesta actual de esta línea.</div>';
      return;
    }

    const directionForBus = new Map();
    for (const direction of directions) {
      for (const bus of assignments.get(direction.id) || []) directionForBus.set(String(bus.id), direction);
    }

    const html = vehicles.slice().sort((a, b) =>
      String(a.id).localeCompare(String(b.id), "es", { numeric: true })
    ).map(bus => {
      const direction = directionForBus.get(String(bus.id));
      const delay = direction ? busStatus(bus, direction) : formatDelay(null);
      const model = state.models[String(bus.id)] || "";
      const eta = formatETA(bus.seconds);
      const distance = formatDistance(bus.meters);
      const detail = [eta, distance].filter(Boolean).join(" · ");
      const nextStop = String(bus.stopName || "Próxima parada no publicada");
      const destination = String(bus.destination || "Destino no publicado");
      const block = direction ? estimatedDelay(bus, direction) : null;
      const blockText = block && block.trip && block.trip.blockId
        ? "Bloque GTFS " + block.trip.blockId
        : "";
      const position = bus.position && Number.isFinite(Number(bus.position.lat)) &&
        Number.isFinite(Number(bus.position.lon)) ? "GPS publicado" : "";
      return '<article class="fleet-card">' +
        '<span class="fleet-bus-icon" aria-hidden="true">🚌</span>' +
        '<div class="fleet-main"><strong>Coche ' + escapeHTML(bus.id) + ' · ' + escapeHTML(destination) + '</strong>' +
        '<small>' + escapeHTML(nextStop) + (detail ? " · " + escapeHTML(detail) : "") + '</small>' +
        (model ? '<span class="fleet-model">' + escapeHTML(model) + '</span>' : '') +
        '</div><div class="fleet-meta"><span class="delay-pill ' + delay.className + '">' +
        escapeHTML(delay.text) + '</span><small>' + escapeHTML(blockText || position || "Tiempo real") + '</small></div>' +
        '</article>';
    }).join("");

    $("fleetList").innerHTML = html;
  }

  function render() {
    const vehicles = Array.isArray(state.live?.vehicles) ? state.live.vehicles : [];
    const directions = state.directions;
    const assignments = assignVehicles(directions, vehicles);

    $("busCount").textContent = String(vehicles.length);
    const uniqueStops = new Set(directions.flatMap(direction => direction.stops.map(stop => stop.id)));
    $("stopCount").textContent = String(uniqueStops.size);
    $("updatedAt").textContent = state.lastUpdated ? formatTime(state.lastUpdated) : "—";

    const partial = Boolean(state.live?.partial);
    $("updateDetail").textContent = partial
      ? "Respuesta parcial del servicio municipal"
      : state.live ? "Datos recibidos de ISAENEXT" : "Esperando respuesta del SAE";

    $("directionGrid").innerHTML = renderLoopDiagram(directions, assignments.assignments);
    positionBusMarkers($("directionGrid"));

    if (assignments.unassigned.length) {
      const unassigned = assignments.unassigned.map(bus =>
        '<span class="unlocated-bus">🚌 ' + escapeHTML(bus.id) + '</span>'
      ).join("");
      $("directionGrid").insertAdjacentHTML("beforeend",
        '<div class="unassigned-fleet"><strong>Sentido no identificado con seguridad</strong>' + unassigned + '</div>');
    }

    renderFleet(vehicles, directions, assignments.assignments);
  }

  function findRoute(code) {
    const key = normalizeLine(code);
    return state.gtfs.routes.find(route => normalizeLine(route.shortName || route.id) === key) || null;
  }

  function populateRoutes() {
    const routes = state.gtfs.routes.slice().sort((a, b) =>
      String(a.shortName || a.id).localeCompare(String(b.shortName || b.id), "es", {
        numeric: true, sensitivity: "base"
      })
    );
    const options = routes.map(route => {
      const code = String(route.shortName || route.id);
      const label = "Línea " + code + (route.longName ? " · " + route.longName : "");
      return '<option value="' + escapeHTML(code) + '">' + escapeHTML(label) + '</option>';
    }).join("");

    $("routeSelect").innerHTML = options;
    $("routeSelect").disabled = false;
    $("refreshButton").disabled = false;

    const requested = new URLSearchParams(location.search).get("line");
    const initialRoute = requested && findRoute(requested) ? findRoute(requested) : findRoute("1");
    const selected = initialRoute ? String(initialRoute.shortName || initialRoute.id) :
      String(routes[0]?.shortName || routes[0]?.id || "");
    $("routeSelect").value = selected;
    state.selectedCode = selected;
  }

  async function loadStaticData() {
    const response = await fetch(GTFS_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error("No se pudo descargar la base GTFS (HTTP " + response.status + ").");
    const data = await response.json();
    if (!Array.isArray(data.routes) || !Array.isArray(data.stops) || !Array.isArray(data.trips)) {
      throw new Error("La base GTFS no contiene rutas, paradas y viajes válidos.");
    }
    data.stopById = new Map(data.stops.map(stop => [String(stop.id), stop]));
    data.shapeById = new Map((data.shapes || []).map(shape => [
      String(shape.id),
      (shape.points || []).map(point => [Number(point[0]), Number(point[1])])
    ]));
    state.gtfs = data;

    try {
      const modelResponse = await fetch(MODELS_URL, { cache: "force-cache" });
      if (modelResponse.ok) {
        const modelData = await modelResponse.json();
        state.models = modelData.models || {};
      }
    } catch (error) {
      console.warn("No se pudo cargar el catálogo de modelos:", error);
    }
  }


  function enrichLivePayload(payload) {
    const bestObservation = new Map();
    for (const observation of Array.isArray(payload?.observations) ? payload.observations : []) {
      const id = String(observation.vehicleId ?? "").trim();
      if (!id) continue;
      const seconds = observation.seconds === null || observation.seconds === undefined
        ? Infinity : Number(observation.seconds);
      const previous = bestObservation.get(id);
      if (!previous || seconds < previous.seconds) bestObservation.set(id, { observation, seconds });
    }

    const vehicles = (Array.isArray(payload?.vehicles) ? payload.vehicles : []).map(bus => {
      const id = String(bus.id ?? "").trim();
      const entry = bestObservation.get(id);
      const observation = entry?.observation;
      let position = bus.position;
      if (!validPosition(position) && observation &&
          observation.vehicleLat !== null && observation.vehicleLon !== null) {
        const fallback = { lat: observation.vehicleLat, lon: observation.vehicleLon };
        if (validPosition(fallback)) {
          position = { ...fallback, source: "GPS publicado por resourceEstimations" };
        }
      }
      return {
        ...bus,
        position,
        destination: bus.destination || observation?.destination || "",
        direction: bus.direction || observation?.direction || "",
        seconds: bus.seconds === null || bus.seconds === undefined
          ? observation?.seconds ?? null : bus.seconds,
        meters: bus.meters === null || bus.meters === undefined
          ? observation?.meters ?? null : bus.meters,
        stopId: bus.stopId || observation?.stopId || "",
        stopName: bus.stopName || observation?.stopName || ""
      };
    });
    return { ...payload, vehicles };
  }

  async function fetchLiveLine(code) {
    const line = apiLineCode(code);
    const url = WORKER_BASE + "/api/burgos/live?line=" + encodeURIComponent(line) + "&fresh=1";
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("El Worker municipal no ha devuelto una respuesta JSON válida.");
    }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || "El SAE no ha respondido correctamente (HTTP " + response.status + ").");
    }
    return enrichLivePayload(payload);
  }

  async function loadLine(code, showLoading) {
    if (state.loading) return;
    const route = findRoute(code);
    if (!route) {
      setNotice("No se ha encontrado esa línea en el GTFS municipal.", "error", false);
      return;
    }

    state.loading = true;
    state.selectedCode = String(route.shortName || route.id);
    state.route = route;
    state.directions = buildDirections(route);
    $("routeTitle").textContent = "Línea " + state.selectedCode;
    $("routeDescription").textContent = String(route.longName || route.description || "Recorrido y servicio en directo");
    $("refreshButton").disabled = true;
    $("routeSelect").disabled = true;
    if (showLoading || !state.live) {
      setNotice("Consultando autobuses y estimaciones de la línea " + state.selectedCode + "…", "info", true);
    }
    setConnection("Consultando línea " + state.selectedCode + "…", "");

    try {
      const payload = await fetchLiveLine(state.selectedCode);
      state.live = payload;
      state.lastUpdated = payload.fetchedAt ? new Date(payload.fetchedAt) : new Date();
      const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles.length : 0;

      if (payload.partial) {
        setConnection("Datos parciales · línea " + state.selectedCode, "error");
        setNotice("La lista de vehículos está disponible, pero alguna parte del trazado o de las estimaciones no ha respondido. Se muestran únicamente los datos recibidos.", "warning", false);
      } else {
        setConnection("En directo · línea " + state.selectedCode, "ok");
        setNotice(vehicles
          ? "Consulta completada. Los coches se colocan junto a su próxima parada estimada cuando coincide con el itinerario publicado."
          : "Consulta completada. En este momento la fuente no publica autobuses para esta línea.",
          "success", false);
      }
      render();
    } catch (error) {
      console.error("Error consultando SAE de Burgos:", error);
      state.live = null;
      state.lastUpdated = null;
      setConnection("Sin conexión con ISAENEXT", "error");
      setNotice(error?.message || "No se ha podido consultar el servicio municipal.", "error", false);
      render();
    } finally {
      state.loading = false;
      $("refreshButton").disabled = false;
      $("routeSelect").disabled = false;
    }
  }

  async function boot() {
    try {
      setConnection("Cargando rutas oficiales…", "");
      await loadStaticData();
      populateRoutes();
      await loadLine(state.selectedCode, true);
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(() => {
        if (!document.hidden && !state.loading && state.selectedCode) {
          loadLine(state.selectedCode, false);
        }
      }, REFRESH_MS);
    } catch (error) {
      console.error(error);
      setConnection("No se han podido cargar los datos", "error");
      setNotice(error?.message || "No se pudo iniciar la aplicación.", "error", false);
      $("directionGrid").innerHTML = '<div class="empty-state">Comprueba la conexión e inténtalo de nuevo.</div>';
    }
  }

  $("routeSelect").addEventListener("change", event => {
    const code = event.target.value;
    const url = new URL(location.href);
    url.searchParams.set("line", apiLineCode(code));
    history.replaceState(null, "", url);
    state.live = null;
    loadLine(code, true);
  });

  $("refreshButton").addEventListener("click", () => {
    if (state.selectedCode) loadLine(state.selectedCode, true);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.selectedCode && !state.loading) {
      loadLine(state.selectedCode, false);
    }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(error =>
        console.warn("No se pudo registrar el modo instalable:", error)
      );
    });
  }

  boot();
})();