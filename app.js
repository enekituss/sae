(() => {
  "use strict";

  const WORKER_BASE = "https://burgos-sae-spotter.ecanteroalvarez.workers.dev";
  const GTFS_URL = "./burgos-data.json";
  const MODELS_URL = "./burgos-modelos.json";
  const REFRESH_MS = 120000;
  const LIVE_CONCURRENCY = 3;
  const REQUEST_TIMEOUT_MS = 40000;
  const $ = id => document.getElementById(id);
  const state = {
    gtfs: null,
    models: {},
    catalog: [],
    lineLive: new Map(),
    lastPositions: new Map(),
    refreshing: false,
    refreshProgress: 0,
    lastUpdated: null,
    lastRefreshStarted: 0,
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

    const currentPosition = vehiclePosition(bus);
    if (currentPosition && direction.shapePoints?.length > 1) {
      const vehicleMeasure = projectPointToPolyline(currentPosition, direction.shapePoints);
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


  function bearingBetweenPositions(from, to) {
    if (!validPosition(from) || !validPosition(to)) return null;
    const lat1 = Number(from.lat) * Math.PI / 180;
    const lat2 = Number(to.lat) * Math.PI / 180;
    const deltaLon = (Number(to.lon) - Number(from.lon)) * Math.PI / 180;
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function bearingForShapeSegment(points, index) {
    if (!Array.isArray(points) || index < 0 || index >= points.length - 1) return null;
    const first = points[index];
    const second = points[index + 1];
    return bearingBetweenPositions(
      { lat: first[0], lon: first[1] },
      { lat: second[0], lon: second[1] }
    );
  }

  function angularDifference(first, second) {
    return Math.abs(((first - second + 540) % 360) - 180);
  }

  function attachVehicleMotion(code, vehicles) {
    const now = Date.now();
    return vehicles.map(bus => {
      const position = vehiclePosition(bus);
      if (!position) return bus;
      const key = String(code) + "|" + String(bus.id);
      const previous = state.lastPositions.get(key);
      let motionBearing = null;
      if (previous) {
        const elapsed = (now - previous.at) / 1000;
        const distance = distanceBetweenPositions(previous, position);
        if (elapsed >= 10 && elapsed <= 1200 && distance >= 8 && distance / elapsed <= 35) {
          motionBearing = bearingBetweenPositions(previous, position);
        }
      }
      state.lastPositions.set(key, {
        lat: Number(position.lat),
        lon: Number(position.lon),
        at: now
      });
      return motionBearing === null ? bus : { ...bus, motionBearing };
    });
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

  function vehiclePosition(bus) {
    if (validPosition(bus?.position)) return bus.position;
    const fallback = {
      lat: bus?.lat ?? bus?.latitude,
      lon: bus?.lon ?? bus?.lng ?? bus?.longitude
    };
    return validPosition(fallback) ? fallback : null;
  }

  function distanceBetweenPositions(a, b) {
    if (!validPosition(a) || !validPosition(b)) return Infinity;
    const lat = (Number(a.lat) + Number(b.lat)) / 2;
    const metresLat = 111132;
    const metresLon = 111320 * Math.cos(lat * Math.PI / 180);
    return Math.hypot(
      (Number(a.lon) - Number(b.lon)) * metresLon,
      (Number(a.lat) - Number(b.lat)) * metresLat
    );
  }

  function findStopIndex(direction, bus) {
    const identifiers = [
      bus.stopId, bus.stopCode, bus.nodeId, bus.node_id,
      bus.stop_id, bus.paradaId, bus.numNodo
    ].map(value => String(value ?? "").trim()).filter(Boolean);

    for (const identifier of identifiers) {
      const direct = direction.stops.findIndex(stop =>
        stop.id === identifier || stop.code === identifier
      );
      if (direct >= 0) return direct;
    }

    const stopName = normalize(bus.stopName || bus.nextStopName || bus.nextStop);
    if (stopName) {
      const exact = direction.stops.findIndex(stop => normalize(stop.name) === stopName);
      if (exact >= 0) return exact;

      const wantedWords = stopName.split(" ").filter(word => word.length > 2);
      let bestIndex = -1;
      let bestScore = 0;
      let tied = false;
      direction.stops.forEach((stop, index) => {
        const words = normalize(stop.name).split(" ").filter(word => word.length > 2);
        if (!words.length || !wantedWords.length) return;
        const common = wantedWords.filter(word => words.includes(word)).length;
        const score = common / Math.max(wantedWords.length, words.length);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
          tied = false;
        } else if (score === bestScore && score > 0) {
          tied = true;
        }
      });
      if (!tied && bestScore >= 0.8) return bestIndex;
    }

    const stopPosition = {
      lat: bus.stopLat ?? bus.stopLatitude,
      lon: bus.stopLon ?? bus.stopLng ?? bus.stopLongitude
    };
    if (validPosition(stopPosition)) {
      let best = { index: -1, distance: Infinity };
      let second = Infinity;
      direction.stops.forEach((stop, index) => {
        const distance = distanceBetweenPositions(stopPosition, stop);
        if (distance < best.distance) {
          second = best.distance;
          best = { index, distance };
        } else if (distance < second) {
          second = distance;
        }
      });
      if (best.distance <= 180 && second - best.distance >= 5) return best.index;
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
        let semanticMatch = false;

        const reportedDirection = String(bus.direction ?? "").trim();
        if (reportedDirection && direction.directionId &&
            reportedDirection === direction.directionId) {
          score += 1000;
          semanticMatch = true;
        }

        const destination = destinationScore(bus.destination, direction.headsign);
        if (destination > 0) {
          score += 120 + destination * 8;
          semanticMatch = true;
        }

        const stopIndex = findStopIndex(direction, bus);
        if (stopIndex >= 0) {
          const matchingDirections = directions.filter(item => findStopIndex(item, bus) >= 0).length;
          score += matchingDirections === 1 ? 160 : 15;
          if (matchingDirections === 1) semanticMatch = true;
        }

        const currentPosition = vehiclePosition(bus);
        let projectionDistance = Infinity;
        if (currentPosition && direction.shapePoints?.length > 1) {
          const projection = projectPointToPolyline(currentPosition, direction.shapePoints);
          if (projection) {
            projectionDistance = projection.distance;
            if (projection.distance <= 400) {
              score += Math.max(0, 100 - projection.distance / 4);
            }
            if (Number.isFinite(Number(bus.motionBearing))) {
              const routeBearing = bearingForShapeSegment(direction.shapePoints, projection.segmentIndex);
              if (routeBearing !== null) {
                const difference = angularDifference(Number(bus.motionBearing), routeBearing);
                if (difference <= 45) score += 130;
                else if (difference >= 135) score -= 60;
              }
            }
          }
        }
        return { direction, score, semanticMatch, projectionDistance };
      }).sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];
      const hasDistinctWinner = best && best.score > 0 &&
        (!second || best.score - second.score >= 4);
      if (hasDistinctWinner) {
        assignments.get(best.direction.id).push(bus);
      } else if (directions.length === 1) {
        assignments.get(directions[0].id).push(bus);
      } else {
        // No se descarta el coche: si los dos sentidos son indistinguibles,
        // queda en el inventario de la línea como sentido no confirmado.
        unassigned.push(bus);
      }
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

  function renderBranch(branch, index, assignments, showOwnTerminals, singleLane) {
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

    const laneSide = singleLane ? "single" : (index === 0 ? "left" : "right");
    return '<article class="branch-lane branch-lane-' + laneSide + '" style="--direction-color:' + direction.color + '">' +
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
          renderBranch(branch, index, assignments, true, false)
        ).join("") +
        '</div><p class="loop-note">El GTFS publica cabeceras distintas para estos recorridos; se muestran por separado sin unirlos artificialmente.</p></div>';
    }

    const topName = layout.top?.name || "Cabecera";
    const bottomName = layout.bottom?.name || "Cabecera";
    const single = layout.mode === "single";
    const branchesClass = single ? "loop-branches single-branch" : "loop-branches";
    const branchesHTML = layout.branches.map((branch, index) =>
      renderBranch(branch, index, assignments, false, single)
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
        const lane = body.closest(".branch-lane");
        if (lane?.classList.contains("branch-lane-left")) {
          marker.style.left = "auto";
          marker.style.right = "calc(50% + " + (12 + (slot % 3) * 13) + "px)";
        } else {
          marker.style.right = "auto";
          marker.style.left = "calc(50% + " + (12 + (slot % 3) * 13) + "px)";
        }
      });
    });
  }

  function lineKey(code) {
    return "line-card-" + String(code).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function renderVehicleInventory(entry, vehicles, directions, assignments) {
    if (!vehicles.length) {
      return '<div class="vehicle-inventory vehicle-inventory-empty">' +
        '<strong>Autobuses detectados: 0</strong><span>La consulta no ha publicado coches para esta línea.</span></div>';
    }

    const directionForBus = new Map();
    const positionForBus = new Map();
    const layout = resolveRouteLayout(directions);

    for (const branch of layout.branches) {
      const branchBuses = assignments.get(branch.direction.id) || [];
      for (const bus of branchBuses) {
        directionForBus.set(String(bus.id), branch.direction);
        const position = busDiagramPosition(branch.direction, bus, branch.reverse);
        if (position) positionForBus.set(String(bus.id), position);
      }
    }

    const chips = vehicles.slice().sort((a, b) =>
      String(a.id).localeCompare(String(b.id), "es", { numeric: true })
    ).map(bus => {
      const id = String(bus.id);
      const direction = directionForBus.get(id);
      const position = positionForBus.get(id);
      const model = state.models[id] || "";
      const eta = formatETA(bus.seconds);
      const distance = formatDistance(bus.meters);
      const detail = [eta, distance].filter(Boolean).join(" · ");
      const delay = direction ? busStatus(bus, direction) : formatDelay(null);
      const placement = position
        ? (position.source === "GPS" ? "GPS en recorrido" : "Próxima parada")
        : (direction ? "Posición sin confirmar" : "Sentido sin confirmar");

      return '<div class="vehicle-chip" title="' + escapeHTML([
        "Coche " + id,
        model,
        bus.destination || "Destino no publicado",
        bus.stopName || "Próxima parada no publicada",
        detail,
        placement
      ].filter(Boolean).join(" · ")) + '">' +
        '<span class="vehicle-chip-bus">🚌</span>' +
        '<span class="vehicle-chip-info"><strong>' + escapeHTML(id) + '</strong>' +
        '<small>' + escapeHTML(detail || placement) + '</small></span>' +
        '<span class="delay-pill ' + delay.className + '">' + escapeHTML(delay.text) + '</span>' +
        '</div>';
    }).join("");

    const placed = positionForBus.size;
    return '<div class="vehicle-inventory">' +
      '<div class="vehicle-inventory-heading"><strong>COCHES DETECTADOS · ' + vehicles.length + '</strong>' +
      '<span>' + placed + ' situados en el esquema · ' + (vehicles.length - placed) + ' sin posición exacta</span></div>' +
      '<div class="vehicle-chip-list">' + chips + '</div>' +
      '</div>';
  }

  function renderLineCardContent(entry) {
    const lineState = state.lineLive.get(entry.code) || {
      status: "loading",
      vehicles: [],
      partial: false,
      warnings: []
    };
    const vehicles = Array.isArray(lineState.vehicles) ? lineState.vehicles : [];
    const directions = entry.directions;
    const assignments = assignVehicles(directions, vehicles);
    const statusText = {
      loading: "Consultando…",
      updating: "Actualizando…",
      ok: vehicles.length + (vehicles.length === 1 ? " coche" : " coches"),
      partial: "Datos parciales · " + vehicles.length + " coches",
      fallback: "Listado de respaldo · " + vehicles.length + " coches",
      stale: "Últimos datos conservados · " + vehicles.length + " coches",
      error: "Sin respuesta del SAE"
    }[lineState.status] || "Esperando consulta";

    const statusClass = lineState.status === "ok" ? "line-status-ok" :
      lineState.status === "partial" || lineState.status === "fallback" ? "line-status-warning" :
      lineState.status === "error" ? "line-status-error" :
      lineState.status === "stale" ? "line-status-stale" : "line-status-loading";

    const description = String(entry.route.longName || entry.route.description || "").trim();
    const busesUnknown = assignments.unassigned.length
      ? '<div class="unassigned-fleet"><strong>Vehículos sin sentido identificable</strong>' +
        assignments.unassigned.map(bus =>
          '<span class="unlocated-bus">🚌 ' + escapeHTML(bus.id) + '</span>'
        ).join("") + '</div>'
      : "";

    const warning = lineState.error
      ? '<p class="line-error-note">' + escapeHTML(lineState.error) + '</p>'
      : lineState.stale
        ? '<p class="line-error-note">Mostrando la última lectura guardada; la consulta nueva ha fallado.</p>'
        : "";

    const diagram = renderLoopDiagram(directions, assignments.assignments);
    const inventory = renderVehicleInventory(entry, vehicles, directions, assignments.assignments);

    return '<header class="network-line-header">' +
      '<div class="network-line-number">' + escapeHTML(entry.code) + '</div>' +
      '<div class="network-line-name"><span class="eyebrow">LÍNEA ' + escapeHTML(entry.code) + '</span>' +
      '<h3>' + escapeHTML(description || "Recorrido no descrito") + '</h3></div>' +
      '<div class="network-line-live"><span class="line-status ' + statusClass + '">' +
      escapeHTML(statusText) + '</span><small>' +
      (lineState.fetchedAt ? formatTime(lineState.fetchedAt) : "Pendiente") +
      '</small></div>' +
      '</header>' +
      '<div class="network-line-diagram">' + diagram + busesUnknown + '</div>' +
      inventory + warning;
  }

  function updateLineCard(entry) {
    const card = $(lineKey(entry.code));
    if (!card) return;
    card.innerHTML = renderLineCardContent(entry);
    positionBusMarkers(card);
  }

  function updateNetworkStats() {
    const vehicles = new Set();
    let loadedLines = 0;
    let failedLines = 0;
    let newest = null;

    for (const entry of state.catalog) {
      const lineState = state.lineLive.get(entry.code);
      if (!lineState) continue;
      if (["ok", "partial", "fallback", "stale"].includes(lineState.status)) loadedLines++;
      if (lineState.status === "error") failedLines++;
      for (const bus of lineState.vehicles || []) {
        vehicles.add(entry.code + "|" + String(bus.id));
      }
      const date = lineState.fetchedAt ? new Date(lineState.fetchedAt) : null;
      if (date && Number.isFinite(date.getTime()) && (!newest || date > newest)) newest = date;
    }

    $("lineCount").textContent = String(state.catalog.length);
    $("busCount").textContent = String(vehicles.size);
    $("updatedAt").textContent = newest ? formatTime(newest) : "—";
    $("updateDetail").textContent = state.refreshing
      ? "Consultadas " + state.refreshProgress + " de " + state.catalog.length + " líneas"
      : loadedLines + " líneas con respuesta" + (failedLines ? " · " + failedLines + " sin respuesta" : "");

    if (state.refreshing) {
      setConnection("Actualizando red · " + state.refreshProgress + "/" + state.catalog.length, "");
    } else if (failedLines > 0) {
      setConnection("Red parcialmente disponible · " + failedLines + " líneas con error", "error");
    } else if (loadedLines === state.catalog.length && loadedLines > 0) {
      setConnection("Red consultada · " + vehicles.size + " autobuses", "ok");
    } else {
      setConnection("Cargando datos de todas las líneas…", "");
    }
  }

  function renderNetworkCatalog() {
    const container = $("directionGrid");
    container.innerHTML = state.catalog.map(entry =>
      '<article class="network-line-card" id="' + lineKey(entry.code) + '">' +
      renderLineCardContent(entry) + '</article>'
    ).join("");
    for (const entry of state.catalog) positionBusMarkers($(lineKey(entry.code)));
  }

  async function loadStaticData() {
    const response = await fetch(GTFS_URL, { cache: "no-cache" });
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
      const modelResponse = await fetch(MODELS_URL, { cache: "no-cache" });
      if (modelResponse.ok) {
        const modelData = await modelResponse.json();
        state.models = modelData.models || {};
      }
    } catch (error) {
      console.warn("No se pudo cargar el catálogo de modelos:", error);
    }

    const routes = state.gtfs.routes.slice().sort((a, b) =>
      String(a.shortName || a.id).localeCompare(String(b.shortName || b.id), "es", {
        numeric: true, sensitivity: "base"
      })
    );
    state.catalog = routes.map(route => ({
      route,
      code: String(route.shortName || route.id),
      directions: buildDirections(route)
    }));
  }

  function enrichLivePayload(payload, code) {
    const bestObservation = new Map();
    for (const observation of Array.isArray(payload?.observations) ? payload.observations : []) {
      const id = String(observation.vehicleId ?? observation.vehicle ?? "").trim();
      if (!id || id === "0") continue;
      const secondsValue = observation.seconds === null || observation.seconds === undefined ||
        observation.seconds === "" ? Infinity : Number(observation.seconds);
      const seconds = Number.isFinite(secondsValue) ? secondsValue : Infinity;
      const previous = bestObservation.get(id);
      const hasGps = observation.vehicleLat !== null && observation.vehicleLat !== undefined &&
        observation.vehicleLon !== null && observation.vehicleLon !== undefined &&
        Number.isFinite(Number(observation.vehicleLat)) && Number(observation.vehicleLat) >= 42 &&
        Number(observation.vehicleLat) <= 43 && Number.isFinite(Number(observation.vehicleLon)) &&
        Number(observation.vehicleLon) >= -4 && Number(observation.vehicleLon) <= -3;
      const previousHasGps = previous && Number.isFinite(Number(previous.observation.vehicleLat)) &&
        Number.isFinite(Number(previous.observation.vehicleLon));
      if (!previous || seconds < previous.seconds || (seconds === previous.seconds && hasGps && !previousHasGps)) {
        bestObservation.set(id, { observation, seconds });
      }
    }

    const vehiclesById = new Map();
    for (const bus of Array.isArray(payload?.vehicles) ? payload.vehicles : []) {
      const id = String(bus.id ?? bus.vehicleId ?? bus.vehicle ?? bus.vehicle_id ?? "").trim();
      if (!id || id === "0") continue;
      vehiclesById.set(id, { ...bus, id, line: code, lineId: code });
    }

    // resourceEstimations puede mencionar un coche que no haya llegado en la
    // lista base. Se incorpora para no perder ningún vehículo visible en SAE.
    for (const [id, entry] of bestObservation.entries()) {
      const observation = entry.observation;
      const old = vehiclesById.get(id) || {};
      const gps = {
        lat: observation.vehicleLat,
        lon: observation.vehicleLon
      };
      const position = validPosition(old.position) ? old.position :
        (validPosition(gps) ? { ...gps, source: "GPS publicado por resourceEstimations" } :
          (vehiclePosition(old) || null));
      const oldSeconds = old.seconds === null || old.seconds === undefined ? Infinity : Number(old.seconds);
      const useObservation = !Number.isFinite(oldSeconds) ||
        (Number.isFinite(entry.seconds) && entry.seconds < oldSeconds);
      vehiclesById.set(id, {
        ...old,
        id,
        line: code,
        lineId: code,
        destination: old.destination || observation.destination || "",
        direction: old.direction || observation.direction || "",
        seconds: useObservation ? observation.seconds : old.seconds ?? observation.seconds ?? null,
        meters: useObservation ? observation.meters : old.meters ?? observation.meters ?? null,
        stopId: old.stopId || observation.stopId || "",
        stopName: old.stopName || observation.stopName || "",
        stopLat: old.stopLat ?? observation.stopLat ?? null,
        stopLon: old.stopLon ?? observation.stopLon ?? null,
        position
      });
    }

    return {
      ...payload,
      vehicles: [...vehiclesById.values()],
      observations: Array.isArray(payload?.observations) ? payload.observations : []
    };
  }

  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("El Worker no ha devuelto JSON válido.");
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || "Error HTTP " + response.status);
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Tiempo de espera agotado al consultar la línea.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchLiveLine(code) {
    const line = apiLineCode(code);
    const url = WORKER_BASE + "/api/burgos/live?line=" + encodeURIComponent(line) + "&fresh=1";
    return enrichLivePayload(await fetchJson(url, REQUEST_TIMEOUT_MS), line);
  }

  async function fetchVehicleListLine(code) {
    const line = apiLineCode(code);
    const url = WORKER_BASE + "/api/burgos/vehicles?line=" + encodeURIComponent(line);
    return enrichLivePayload(await fetchJson(url, REQUEST_TIMEOUT_MS), line);
  }

  async function refreshOneLine(entry) {
    const previous = state.lineLive.get(entry.code) || {
      vehicles: [],
      status: "loading",
      partial: false,
      warnings: []
    };
    state.lineLive.set(entry.code, {
      ...previous,
      status: previous.vehicles.length ? "updating" : "loading",
      error: ""
    });
    updateLineCard(entry);

    try {
      let payload;
      let fallback = false;
      try {
        payload = await fetchLiveLine(entry.code);
      } catch (liveError) {
        console.warn("La consulta completa de la línea " + entry.code + " ha fallado:", liveError);
        payload = await fetchVehicleListLine(entry.code);
        fallback = true;
      }

      const rawVehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];
      const vehicles = attachVehicleMotion(entry.code, rawVehicles);
      const nextState = {
        vehicles,
        status: fallback ? "fallback" : (payload.partial ? "partial" : "ok"),
        partial: payload.partial === true,
        warnings: payload.warnings || [],
        fetchedAt: payload.fetchedAt || new Date().toISOString(),
        stale: payload.stale === true,
        error: ""
      };
      state.lineLive.set(entry.code, nextState);
      state.lastUpdated = new Date(nextState.fetchedAt);
    } catch (error) {
      console.error("No se pudo consultar la línea " + entry.code + ":", error);
      if (previous.vehicles.length) {
        state.lineLive.set(entry.code, {
          ...previous,
          status: "stale",
          stale: true,
          error: error?.message || "No se pudo actualizar"
        });
      } else {
        state.lineLive.set(entry.code, {
          vehicles: [],
          status: "error",
          partial: true,
          warnings: [],
          fetchedAt: "",
          error: error?.message || "No se pudo consultar esta línea"
        });
      }
    }

    state.refreshProgress += 1;
    updateLineCard(entry);
    updateNetworkStats();
    setNotice(
      "Actualizando flota: " + state.refreshProgress + " de " + state.catalog.length + " líneas consultadas.",
      "info",
      true
    );
  }

  async function refreshAll(manual) {
    if (state.refreshing || !state.catalog.length) return;
    state.refreshing = true;
    state.refreshProgress = 0;
    state.lastRefreshStarted = Date.now();
    $("refreshButton").disabled = true;
    $("refreshButton").classList.add("is-loading");

    for (const entry of state.catalog) {
      const previous = state.lineLive.get(entry.code);
      if (!previous) {
        state.lineLive.set(entry.code, {
          vehicles: [],
          status: "loading",
          partial: false,
          warnings: []
        });
      }
    }

    updateNetworkStats();
    setNotice(
      (manual ? "Actualización manual" : "Consulta inicial") +
      ": consultando los autobuses de todas las líneas…",
      "info",
      true
    );

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(LIVE_CONCURRENCY, state.catalog.length) }, async () => {
      while (nextIndex < state.catalog.length) {
        const index = nextIndex++;
        await refreshOneLine(state.catalog[index]);
      }
    });

    await Promise.all(workers);
    state.refreshing = false;
    $("refreshButton").disabled = false;
    $("refreshButton").classList.remove("is-loading");
    updateNetworkStats();

    const errors = state.catalog.filter(entry =>
      state.lineLive.get(entry.code)?.status === "error"
    ).length;
    setNotice(
      errors
        ? "Consulta terminada. " + (state.catalog.length - errors) + " líneas respondieron; " +
          errors + " no han podido consultarse. Los itinerarios GTFS siguen visibles."
        : "Consulta terminada. Se muestran todos los recorridos y los vehículos publicados por ISAENEXT.",
      errors ? "warning" : "success",
      false
    );
  }

  async function boot() {
    try {
      setConnection("Cargando recorridos y paradas oficiales…", "");
      await loadStaticData();
      $("lineCount").textContent = String(state.catalog.length);
      renderNetworkCatalog();
      updateNetworkStats();
      await refreshAll(false);

      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(() => {
        if (!document.hidden) refreshAll(false);
      }, REFRESH_MS);
    } catch (error) {
      console.error(error);
      setConnection("No se han podido cargar los datos", "error");
      setNotice(error?.message || "No se pudo iniciar la aplicación.", "error", false);
      $("directionGrid").innerHTML = '<div class="empty-state">Comprueba la conexión e inténtalo de nuevo.</div>';
    }
  }

  $("refreshButton").addEventListener("click", () => refreshAll(true));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.lastRefreshStarted > 90000) {
      refreshAll(false);
    }
  });

  window.addEventListener("resize", () => {
    for (const entry of state.catalog) {
      const card = $(lineKey(entry.code));
      if (card) positionBusMarkers(card);
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