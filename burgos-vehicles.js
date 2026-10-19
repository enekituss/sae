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
  const WORKER_API_VERSION = "sae-three-resources-per-line-v6";
  const WORKER_STORAGE_KEY = "saeBurgosDedicatedWorkerUrl";
  const WORKER_CONFIG_VERSION_KEY = "saeBurgosDedicatedWorkerApiVersion";
  const ALL_LINES = [
    ...Array.from({length: 23}, (_, i) => String(i + 1).padStart(2, "0")),
    "73", "87", "88", "89", "C1", "C2"
  ];
  const REFRESH_MS = 60000;
  const REQUEST_TIMEOUT_MS = 8000;
  const MAX_CONCURRENT_LINES = 5;
  const $ = id => document.getElementById(id);

  let lineSnapshots = new Map();
  let staleLines = new Set();
  const expandedLines = new Set();
  let lastSuccessfulUpdate = null;
  let updateRunning = false;
  let lineFetchProgress = { completed: 0, total: 0, successful: 0, failed: 0 };
  let liveEnrichmentRunning = false;
  let lastQueryHadSuccess = false;
  let nextStopByVehicle = new Map();
  let nextStopQueryRunning = false;
  let gtfsData = null;
  let gtfsLoading = false;
  let gtfsPromise = null;
  let nextStopPromise = null;
  let nextStopCachedAt = 0;
  const NEXTSTOP_CACHE_KEY = "saeBurgosNextStopCacheV1";
  const NEXTSTOP_CACHE_TTL_MS = 5 * 60 * 1000;
  const GEO_CELL_DEGREES = 0.005;
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

  function formatScheduledStopTime(value) {
    const raw = String(value ?? "").trim();
    const match = raw.match(/^(\d{1,3}):([0-5]\d)(?::[0-5]\d)?$/);
    if (!match) return raw || "—";
    const hours = Number(match[1]);
    const clock = String(hours % 24).padStart(2, "0") + ":" + match[2];
    return hours >= 24 ? clock + " (+1 día)" : clock;
  }

  function gtfsTimeToSeconds(value) {
    const raw = String(value ?? "").trim();
    const match = raw.match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
  }

  function scheduledTimeDistance(trip, stopIndex, observation) {
    const item = Array.isArray(trip?.stops) ? trip.stops[stopIndex] : null;
    const values = [gtfsTimeToSeconds(item?.[1]), gtfsTimeToSeconds(item?.[2])]
      .filter(value => value !== null);
    if (!values.length) return Infinity;
    const now = new Date();
    const eta = nonNegativeNumber(observation?.seconds) ?? 0;
    const expected = (now.getHours() * 3600 + now.getMinutes() * 60 +
      now.getSeconds() + eta) % 86400;
    return Math.min(...values.map(value => {
      const clock = value % 86400;
      const delta = Math.abs(clock - expected);
      return Math.min(delta, 86400 - delta);
    }));
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
    if (gtfsData) return gtfsData;
    if (gtfsPromise) return gtfsPromise;
    gtfsLoading = true;

    const promise = (async () => {
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
        data.stopsByGeoCell = new Map();

        // Spatial index: itinerary matching now checks nearby stops only,
        // rather than calculating distances to every stop for every bus.
        for (const stop of data.stops) {
          const lat = Number(stop.lat);
          const lon = Number(stop.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const cellKey = Math.floor(lat / GEO_CELL_DEGREES) + "|" +
            Math.floor(lon / GEO_CELL_DEGREES);
          if (!data.stopsByGeoCell.has(cellKey)) data.stopsByGeoCell.set(cellKey, []);
          data.stopsByGeoCell.get(cellKey).push(stop);
        }

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
          "Líneas:", data.routes.length,
          "paradas:", data.stops.length,
          "viajes:", data.trips.length,
          "celdas geográficas:", data.stopsByGeoCell.size);
        return data;
      } catch (error) {
        console.warn("No se pudieron cargar los itinerarios GTFS de Burgos:", error?.message || String(error));
        return null;
      } finally {
        gtfsLoading = false;
      }
    })();

    gtfsPromise = promise;
    try {
      return await promise;
    } finally {
      if (gtfsPromise === promise) gtfsPromise = null;
    }
  }
  function matchTripForNextStop(observation) {
    if (!gtfsData || !Array.isArray(gtfsData.stops)) return null;
    const lat = Number(observation.stopLat);
    const lon = Number(observation.stopLon);
    const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon);
    const line = normalizeLineKey(observation.line);
    if (!line) return null;

    // Prioridad: coordenadas del SAE, ID de parada compatible y, como respaldo,
    // nombre normalizado. Así la falta de coordenadas no inutiliza el itinerario.
    const stopCandidates = new Map();
    const addStop = (stop, distance, matchType) => {
      if (!stop?.id) return;
      const id = String(stop.id);
      const previous = stopCandidates.get(id);
      const priority = { id: 0, coordinates: 1, name: 2 };
      const candidate = { stop, distance, matchType };
      if (!previous || priority[matchType] < priority[previous.matchType] ||
          (matchType === previous.matchType && distance < previous.distance)) {
        stopCandidates.set(id, candidate);
      }
    };

    if (hasCoordinates) {
      const latCell = Math.floor(lat / GEO_CELL_DEGREES);
      const lonCell = Math.floor(lon / GEO_CELL_DEGREES);
      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          const cellKey = (latCell + dLat) + "|" + (lonCell + dLon);
          const cellStops = gtfsData.stopsByGeoCell?.get(cellKey) || [];
          for (const stop of cellStops) {
            const stopLat = Number(stop.lat);
            const stopLon = Number(stop.lon);
            const distance = distanceMeters({ lat, lon }, { lat: stopLat, lon: stopLon });
            if (distance <= 280) addStop(stop, distance, "coordinates");
          }
        }
      }
    }

    const observedStopId = String(observation.stopId ?? "").trim();
    const observedStopName = normalizeWords(observation.stopName).join(" ");
    if (observedStopId) {
      const direct = gtfsData.stopById.get(observedStopId) ||
        gtfsData.stops.find(stop => String(stop.code ?? "").trim() === observedStopId);
      const directName = normalizeWords(direct?.name).join(" ");
      if (direct && (!observedStopName || !directName || directName === observedStopName)) {
        addStop(direct, -1, "id");
      }
    }

    if (observedStopName) {
      // El nombre solo se usa para las paradas que coinciden exactamente tras
      // quitar acentos y puntuación; no se inventa una parada por semejanza parcial.
      for (const stop of gtfsData.stops) {
        if (normalizeWords(stop.name).join(" ") !== observedStopName) continue;
        const stopLat = Number(stop.lat);
        const stopLon = Number(stop.lon);
        const distance = hasCoordinates && Number.isFinite(stopLat) && Number.isFinite(stopLon)
          ? distanceMeters({ lat, lon }, { lat: stopLat, lon: stopLon })
          : 0;
        addStop(stop, distance, "name");
      }
    }

    if (!stopCandidates.size) return null;
    const nearby = [...stopCandidates.values()].sort((a, b) =>
      ({ id: 0, coordinates: 1, name: 2 }[a.matchType] -
       { id: 0, coordinates: 1, name: 2 }[b.matchType]) ||
      a.distance - b.distance
    );

    const candidates = [];
    for (const item of nearby.slice(0, 12)) {
      const rows = gtfsData.tripsByLineStop.get(line + "|" + String(item.stop.id)) || [];
      for (const row of rows) {
        candidates.push({
          ...row,
          matchedStop: item.stop,
          stopDistance: item.distance,
          matchType: item.matchType,
          score: destinationScore(observation.destination, row.trip.headsign),
          timeDistance: scheduledTimeDistance(row.trip, row.stopIndex, observation)
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) =>
      b.score - a.score ||
      a.stopDistance - b.stopDistance ||
      a.timeDistance - b.timeDistance
    );

    if (candidates[0].score === 0) {
      const possibleDestinations = new Set(candidates.map(candidate =>
        normalizeWords(candidate.trip.headsign).join(" ")
      ));
      if (possibleDestinations.size > 1) {
        // Si el texto de destino del SAE no coincide con los rótulos GTFS,
        // solo elegimos un sentido cuando el horario aporta una ventaja clara.
        const byTime = candidates.filter(candidate => Number.isFinite(candidate.timeDistance))
          .sort((a, b) => a.timeDistance - b.timeDistance || a.stopDistance - b.stopDistance);
        const bestByTime = byTime[0];
        const otherDirection = bestByTime && byTime.find(candidate =>
          normalizeWords(candidate.trip.headsign).join(" ") !==
          normalizeWords(bestByTime.trip.headsign).join(" ")
        );
        if (!bestByTime || bestByTime.timeDistance > 45 * 60 ||
            (otherDirection && otherDirection.timeDistance - bestByTime.timeDistance < 5 * 60)) {
          return null;
        }
        return bestByTime;
      }
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
    if (remaining.length < 2) {
      itineraryByVehicle.set(key, null);
      return null;
    }
    const stops = remaining.map(item => {
      const id = String(item?.[0] ?? "").trim();
      const stop = gtfsData.stopById.get(id);
      return {
        id,
        name: String(stop?.name || ("Parada " + id)).trim(),
        arrivalTime: String(item?.[1] ?? "").trim(),
        departureTime: String(item?.[2] ?? "").trim(),
        sequence: String(item?.[3] ?? "").trim(),
        timepoint: String(item?.[4] ?? "").trim()
      };
    }).filter(stop => stop.id && stop.name);
    if (stops.length < 2) {
      itineraryByVehicle.set(key, null);
      return null;
    }
    const itinerary = {
      destination: String(match.trip.headsign || observation.destination || "").trim(),
      stops,
      totalStops: stops.length,
      matchedStopId: String(match.matchedStop?.id || ""),
      source: "GTFS de Burgos; secuencia desde la próxima parada estimada"
    };
    itineraryByVehicle.set(key, itinerary);
    return itinerary;
  }

  function setItineraryDialogMessage(message, isError = false) {
    const content = $("itineraryContent");
    content.innerHTML = '<div class="itinerary-message' + (isError ? ' error' : '') + '">' +
      (isError ? '' : '<span class="spinner" aria-hidden="true"></span>') +
      escapeHTML(message) + '</div>';
  }

  async function openVehicleItinerary(vehicle) {
    const dialog = $("itineraryDialog");
    if (!dialog || !vehicle) return;
    $("itineraryTitle").textContent = "Itinerario · " + displayLine(vehicle.line) + " · Coche " + vehicle.id;
    $("itinerarySubtitle").textContent = vehicle.destination
      ? "Destino publicado: " + vehicle.destination
      : "Recorrido de referencia del horario municipal";
    setItineraryDialogMessage("Preparando el itinerario…");
    if (!dialog.open) dialog.showModal();

    const key = vehicleStopKey(vehicle.id, vehicle.line);
    let observation = nextStopByVehicle.get(key);

    // If the live request is already in flight, wait for that same request.
    // On later visits the cached stop data lets us skip the long wait entirely.
    if (!observation) {
      await refreshNextStopData(getWorkerBaseUrl(), null, "", [], vehicle.line);
      observation = nextStopByVehicle.get(key);
    }
    if (!observation) {
      setItineraryDialogMessage(
        "El servicio municipal todavía no ha publicado una próxima parada suficiente para identificar este viaje. Comprueba la conexión y vuelve a intentarlo.",
        true
      );
      return;
    }

    setItineraryDialogMessage("Buscando el viaje coincidente en los horarios de Burgos…");
    const data = await loadGtfsForItinerary();
    if (!data) {
      setItineraryDialogMessage("No se ha podido cargar la base de horarios de Burgos. Prueba de nuevo cuando la conexión esté disponible.", true);
      return;
    }

    const itinerary = getVehicleItinerary(vehicle);
    if (!itinerary) {
      setItineraryDialogMessage(
        "No se ha encontrado un viaje GTFS inequívoco para este coche. Puede que el destino publicado no coincida con el horario o que la próxima parada estimada no corresponda a una parada del itinerario.",
        true
      );
      return;
    }

    $("itinerarySubtitle").textContent =
      (itinerary.destination ? "Destino: " + itinerary.destination + " · " : "") +
      " " + itinerary.stops.length + " paradas restantes · primera parada estimada: " +
      (observation.stopName || "no disponible");

    const content = $("itineraryContent");
    content.innerHTML =
      '<ol class="itinerary-list">' +
      itinerary.stops.map((stop, index) => {
        const arrival = formatScheduledStopTime(stop.arrivalTime || stop.departureTime);
        const departure = formatScheduledStopTime(stop.departureTime || stop.arrivalTime);
        const timeDetail = arrival !== "—" || departure !== "—"
          ? '<span class="itinerary-stop-times">Llegada prevista: ' + escapeHTML(arrival) +
            ' · Salida prevista: ' + escapeHTML(departure) +
            (stop.timepoint === "0" ? ' · hora aproximada en GTFS' : '') + '</span>'
          : '<span class="itinerary-stop-times">Horario no publicado para esta parada</span>';
        return '<li' + (index === 0 ? ' class="itinerary-next"' : '') + '>' +
          '<span class="itinerary-sequence">' + (index + 1) + '</span>' +
          '<span class="itinerary-stop-content">' +
            '<span class="itinerary-stop-name">' + escapeHTML(stop.name) + '</span>' +
            timeDetail +
          '</span>' +
          (index === 0 ? '<span class="itinerary-next-badge">Próxima estimada</span>' : '') +
        '</li>';
      }).join("") +
      '</ol><p class="itinerary-note">Horarios de paso programados del GTFS municipal. La etiqueta de próxima parada procede de la estimación del SAE; las horas mostradas son las previstas, no predicciones en tiempo real.</p>';
  }

  function restoreNextStopCache() {
    try {
      const raw = localStorage.getItem(NEXTSTOP_CACHE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved?.entries) || !Number.isFinite(Number(saved.savedAt))) return;
      const age = Date.now() - Number(saved.savedAt);
      if (age < 0 || age > NEXTSTOP_CACHE_TTL_MS) return;
      nextStopByVehicle = new Map(saved.entries);
      nextStopCachedAt = Number(saved.savedAt);
      if (nextStopByVehicle.size) {
        console.info("SAE Burgos: restauradas", nextStopByVehicle.size,
          "próximas paradas de la caché local (", Math.round(age / 1000), "s ).");
      }
    } catch {
      // La caché del navegador es opcional.
    }
  }

  function saveNextStopCache(sourceFetchedAt = "") {
    try {
      const sourceTime = Date.parse(sourceFetchedAt);
      nextStopCachedAt = Number.isFinite(sourceTime) ? sourceTime : Date.now();
      localStorage.setItem(NEXTSTOP_CACHE_KEY, JSON.stringify({
        savedAt: nextStopCachedAt,
        entries: [...nextStopByVehicle.entries()]
      }));
    } catch {
      // No bloquear la interfaz si el navegador no permite almacenamiento.
    }
  }

  async function refreshNextStopData(
    workerBase,
    sourceObservations = null,
    sourceFetchedAt = "",
    failedLines = [],
    onlyLine = ""
  ) {
    if (!workerBase) return null;
    if (nextStopPromise) return nextStopPromise;

    nextStopQueryRunning = true;
    const promise = (async () => {
      try {
        let observations = sourceObservations;
        let fetchedAt = sourceFetchedAt;
        const replaceLines = new Set();

        if (onlyLine) {
          replaceLines.add(normalizeLineKey(onlyLine));
        } else if (Array.isArray(observations)) {
          const failed = new Set(failedLines.map(normalizeLineKey));
          for (const line of ALL_LINES) {
            if (!failed.has(normalizeLineKey(line))) {
              replaceLines.add(normalizeLineKey(line));
            }
          }
        } else {
          return nextStopByVehicle;
        }

        // The vehicle endpoint already includes the line's estimations. Only make
        // another request if a user opens an itinerary without cached stop data.
        if (!Array.isArray(observations)) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          try {
            const endpoint = workerBase + "/api/burgos/live?line=" + encodeURIComponent(onlyLine) + "&fresh=1";
            const response = await fetch(endpoint, {
              method: "GET",
              cache: "no-store",
              headers: { "Accept": "application/json" },
              signal: controller.signal
            });
            const text = await response.text();
            let payload;
            try { payload = JSON.parse(text); }
            catch { throw new Error("La API de Burgos no devolvió JSON."); }
            if (!response.ok || payload?.ok === false) {
              throw new Error(payload?.error || ("API de próximas paradas HTTP " + response.status));
            }
            if (!Array.isArray(payload?.observations)) {
              throw new Error("La API de Burgos no devuelve estimaciones para esa línea.");
            }
            observations = payload.observations;
            fetchedAt = payload.fetchedAt || "";
          } finally {
            clearTimeout(timeoutId);
          }
        }

        // Preserve cached stops for lines that failed, but replace every line
        // successfully checked in this snapshot (or just the requested popup line).
        const next = new Map([...nextStopByVehicle.entries()].filter(([, current]) =>
          !replaceLines.has(normalizeLineKey(current.line))
        ));

        for (const observation of observations) {
          const observationLine = String(observation.line ?? onlyLine ?? "").trim();
          if (onlyLine && normalizeLineKey(observationLine) !== normalizeLineKey(onlyLine)) continue;
          const key = vehicleStopKey(observation.vehicleId, observationLine);
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
            line: observationLine,
            vehicleId: String(observation.vehicleId ?? "").trim(),
            stopLat: observation.stopLat === null || observation.stopLat === undefined ? null : Number(observation.stopLat),
            stopLon: observation.stopLon === null || observation.stopLon === undefined ? null : Number(observation.stopLon)
          };
          const current = next.get(key);
          if (isBetterStop(candidate, current)) next.set(key, candidate);
        }

        nextStopByVehicle = next;
        saveNextStopCache(fetchedAt);
        itineraryByVehicle.clear();
        console.info("SAE Burgos: próxima parada localizada para", next.size,
          "combinaciones vehículo/línea;",
          "estimaciones recibidas:", observations.length,
          "líneas conservadas por fallos:", failedLines.length);
        render();
        return next;
      } catch (error) {
        console.warn("No se pudieron actualizar las próximas paradas de Burgos:", error?.message || String(error));
        return nextStopByVehicle;
      }
    })();

    nextStopPromise = promise;
    try {
      return await promise;
    } finally {
      if (nextStopPromise === promise) nextStopPromise = null;
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
      // Solo se acepta una URL alternativa si fue verificada contra la versión
      // específica del Worker de Burgos. Una URL antigua o de Bizkaibus se ignora.
      const saved = String(localStorage.getItem(WORKER_STORAGE_KEY) || "").trim();
      const version = String(localStorage.getItem(WORKER_CONFIG_VERSION_KEY) || "").trim();
      if (saved && version === WORKER_API_VERSION) {
        return normalizeWorkerBase(saved) || DEFAULT_WORKER_URL;
      }
      return DEFAULT_WORKER_URL;
    } catch {
      return DEFAULT_WORKER_URL;
    }
  }

  async function verifyBurgosWorker(workerBase) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(workerBase + "/health", {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      let health;
      try { health = await response.json(); }
      catch { throw new Error("El Worker de Burgos no devolvió un estado JSON válido."); }
      if (!response.ok || health?.ok !== true) {
        throw new Error(health?.error || ("El Worker de Burgos respondió HTTP " + response.status + "."));
      }
      const supportedVersions = [
        "sae-three-resources-per-line-v3",
        "sae-three-resources-per-line-v4",
        "sae-three-resources-per-line-v5",
        WORKER_API_VERSION
      ];
      if (!supportedVersions.includes(String(health?.apiVersion || "")) ||
          !String(health?.service || "").toLowerCase().includes("burgos")) {
        throw new Error("El Worker de Burgos necesita una versión compatible. Revisa el despliegue de cloudflare-worker-burgos; no se ha utilizado el Worker de Bizkaibus.");
      }
      return health;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("El Worker de Burgos no respondió dentro del tiempo esperado.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
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

  function destinationText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (typeof value === "object") {
      return String(value.destinationName ?? value.destinationText ?? value.name ?? value.nombre ??
        value.description ?? value.descripcion ?? value.headsign ?? value.label ?? value.text ?? "").trim();
    }
    return "";
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
      destination: destinationText(bus.destination ?? bus.destino ?? bus.headsign ??
        bus.destinationName ?? bus.destinationText ?? bus.destiny ?? bus.destinoNombre ??
        bus.nombreDestino ?? bus.destinationLabel ?? bus.destinationDescription ?? ""),
      destinationId: String(bus.destinationId ?? bus.destination_id ?? bus.destinoId ??
        bus.destino_id ?? bus.idDestino ?? bus.id_destino ?? bus.destId ??
        bus.dest_id ?? bus.destinationCode ?? bus.codigoDestino ?? bus.codDestino ?? "").trim(),
      direction: String(bus.direction ?? bus.sentido ?? bus.direccion ?? "").trim(),
      model: String(bus.model ?? bus.modelo ?? bus.vehicleModel ?? "").trim(),
      registration: String(bus.matricula ?? bus.registration ?? bus.plate ?? bus.licensePlate ?? "").trim(),
      nextStop: String(bus.paradaProxima ?? bus.nextNodeId ?? bus.nextStop ?? bus.stopId ?? bus.stop_id ?? "").trim(),
      nextStopName: String(bus.nextStopName ?? bus.paradaProximaName ?? bus.stopName ?? "").trim()
    };
  }

  async function fetchWorkerSnapshot(workerBase, onLineResult = null) {
    // Una petición por línea, respetando los identificadores 01…23, 73, 87…89, C1 y C2.
    const results = new Array(ALL_LINES.length);
    let cursor = 0;
    let completed = 0;
    let successful = 0;
    let failed = 0;
    const concurrency = Math.min(MAX_CONCURRENT_LINES, ALL_LINES.length);

    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= ALL_LINES.length) return;
        const line = ALL_LINES[index];
        const controller = new AbortController();
        // resourceVehicles solo consulta un recurso; se permite margen para probar
        // las direcciones alternativas del Ayuntamiento sin dejar el panel bloqueado.
        const timeoutId = setTimeout(() => controller.abort(), 22000);

        try {
          const endpoint = workerBase + "/api/burgos/vehicles?line=" + encodeURIComponent(line);
          const response = await fetch(endpoint, {
            method: "GET",
            cache: "no-store",
            headers: { "Accept": "application/json" },
            signal: controller.signal
          });
          const body = await response.text();
          let payload;
          try { payload = JSON.parse(body); }
          catch { throw new Error("el Worker no devolvió JSON"); }
          if (!response.ok || payload?.ok === false) {
            throw new Error(payload?.error || ("Worker HTTP " + response.status));
          }
          if (!Array.isArray(payload?.vehicles)) {
            throw new Error("el Worker no devolvió la lista de autobuses");
          }
          results[index] = { line, payload };
          successful++;
        } catch (error) {
          const message = error?.name === "AbortError"
            ? "tiempo de espera agotado (22 s)"
            : String(error?.message || error);
          results[index] = { line, error: message };
          failed++;
        } finally {
          clearTimeout(timeoutId);
        }

        completed++;
        lineFetchProgress = { completed, total: ALL_LINES.length, successful, failed };
        if (typeof onLineResult === "function") {
          try { onLineResult(results[index], lineFetchProgress); }
          catch (error) { console.warn("No se pudo representar el resultado de línea", line, error); }
        }
      }
    }));

    const vehicles = [];
    const observations = [];
    const failedLines = [];
    const warnings = [];
    let lineCount = 0;
    for (const result of results) {
      if (!result || result.error) {
        const line = result?.line || "desconocida";
        failedLines.push(line);
        warnings.push({ line, error: result?.error || "sin respuesta" });
        continue;
      }
      lineCount++;
      for (const vehicle of result.payload.vehicles) {
        vehicles.push({ ...vehicle, lineId: result.line, line: result.line });
      }
      if (Array.isArray(result.payload.observations)) {
        for (const observation of result.payload.observations) {
          observations.push({ ...observation, line: result.line });
        }
      }
    }

    if (lineCount === 0) {
      const detail = warnings.slice(0, 3)
        .map(item => item.line + ": " + item.error)
        .join("; ");
      throw new Error("No se ha podido consultar ninguna línea del Worker de Burgos." +
        (detail ? " " + detail : ""));
    }

    return {
      ok: failedLines.length === 0,
      vehicles,
      observations,
      failedLines,
      warnings,
      lineCount,
      totalLines: ALL_LINES.length,
      partial: failedLines.length > 0,
      fetchedAt: new Date().toISOString()
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
      vehicle.model, vehicle.registration, vehicle.nextStop, vehicle.nextStopName, vehicle.ruta, vehicle.route,
      nextStopByVehicle.get(vehicleStopKey(vehicle.id, vehicle.line))?.stopName,
      ...((itineraryByVehicle.get(vehicleStopKey(vehicle.id, vehicle.line))?.stops) || []).map(stop => stop.name)
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
      } else if (updateRunning && lineFetchProgress.total > 0 &&
          lineFetchProgress.completed < lineFetchProgress.total) {
        message = "Consultando líneas del SAE municipal (" + lineFetchProgress.completed +
          "/" + lineFetchProgress.total + "). Los autobuses aparecerán conforme respondan las líneas.";
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
        const nextStopDetail = nextStopTitle
          ? "<strong>Próxima parada:</strong><br>" + escapeHTML(nextStopTitle) +
            (arrivalText ? "<br><span>Llegada estimada: " + escapeHTML(arrivalText) + "</span>" : "") +
            (distanceText ? "<br><span>Distancia estimada: " + escapeHTML(distanceText) + "</span>" : "")
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
          '<button class="itinerary-open" type="button" data-vehicle-id="' + escapeHTML(vehicle.id) +
          '" data-line="' + escapeHTML(line) + '">Ver itinerario</button>' +
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
      section.querySelectorAll(".itinerary-open").forEach(button => {
        button.addEventListener("click", () => {
          const vehicle = lineVehicles.find(item => item.id === button.dataset.vehicleId);
          if (vehicle) openVehicleItinerary(vehicle);
        });
      });
      container.appendChild(section);
    }
  }

  async function fetchLiveLineDetails(workerBase, line) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
      const endpoint = workerBase + "/api/burgos/live?line=" +
        encodeURIComponent(line) + "&fresh=1";
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      const body = await response.text();
      let payload;
      try { payload = JSON.parse(body); }
      catch { throw new Error("La API de estimaciones no devolvió JSON."); }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || ("API live HTTP " + response.status));
      }
      if (!Array.isArray(payload?.vehicles) || !Array.isArray(payload?.observations)) {
        throw new Error("La API live no devolvió vehículos y observaciones para la línea " + line + ".");
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function mergeLiveLineDetails(line, payload) {
    const detailById = new Map();
    for (const raw of payload.vehicles || []) {
      const id = String(raw?.id ?? raw?.vehicleId ?? raw?.vehicle_id ?? "").trim();
      if (!id) continue;
      detailById.set(id, normalizeVehicle(raw, line));
    }

    // Las estimaciones se enlazan con los coches usando conjuntamente la línea y el ID
    // publicado; así un número repetido en otra línea no recibe la parada incorrecta.
    const bestByVehicle = new Map();
    for (const observation of payload.observations || []) {
      const id = String(observation?.vehicleId ?? observation?.vehicle_id ?? observation?.vehicle ?? "").trim();
      const reportedLine = String(observation?.line ?? line).trim();
      if (!id || normalizeLineKey(reportedLine) !== normalizeLineKey(line)) continue;

      const stopId = String(observation.stopId ?? observation.stop_id ?? "").trim();
      const stopName = String(observation.stopName ?? observation.stop_name ?? observation.nombreParada ?? "").trim();
      const candidate = {
        stopId,
        stopName: stopName || (stopId ? "Parada " + stopId : ""),
        seconds: nonNegativeNumber(observation.seconds),
        meters: nonNegativeNumber(observation.meters),
        destination: destinationText(observation.destination ?? observation.destinationName ??
          observation.destinationText ?? observation.destino ?? observation.destinoNombre ??
          observation.nombreDestino ?? observation.destinationLabel ?? observation.destinationDescription ?? ""),
        destinationId: String(observation.destinationId ?? observation.destination_id ??
          observation.destinoId ?? observation.destino_id ?? observation.idDestino ??
          observation.id_destino ?? observation.destId ?? observation.dest_id ??
          observation.destinationCode ?? observation.codigoDestino ?? observation.codDestino ?? "").trim(),
        direction: String(observation.direction ?? observation.directionName ??
          observation.sentido ?? observation.direccion ?? "").trim(),
        line,
        vehicleId: id,
        stopLat: observation.stopLat === null || observation.stopLat === undefined ? null : Number(observation.stopLat),
        stopLon: observation.stopLon === null || observation.stopLon === undefined ? null : Number(observation.stopLon)
      };
      const current = bestByVehicle.get(id);
      if (isBetterStop(candidate, current)) bestByVehicle.set(id, candidate);
    }

    const currentVehicles = lineSnapshots.get(line) || [];
    const enrichedVehicles = currentVehicles.map(vehicle => {
      const detail = detailById.get(String(vehicle.id));
      const observation = bestByVehicle.get(String(vehicle.id));
      const detailDestination = detail?.destination && detail.destination !== "Destino no publicado"
        ? detail.destination : "";
      const destination = observation?.destination || detailDestination || vehicle.destination || "";
      const destinationId = observation?.destinationId || detail?.destinationId || vehicle.destinationId || "";
      const direction = observation?.direction || detail?.direction || vehicle.direction || "";
      return normalizeVehicle({
        ...(detail || {}),
        ...vehicle,
        id: vehicle.id,
        line,
        destination,
        destinationId,
        direction,
        nextStop: observation?.stopId || detail?.nextStop || vehicle.nextStop || "",
        nextStopName: observation?.stopName || detail?.nextStopName || vehicle.nextStopName || ""
      }, line);
    }).filter(Boolean);

    lineSnapshots.set(line, enrichedVehicles);

    // Solo reemplaza la caché de próximas paradas cuando la consulta está completa.
    // Si falla resourceRoutes/resourceEstimations, conserva la última estimación conocida.
    if (!payload.partial) {
      const next = new Map([...nextStopByVehicle.entries()].filter(([, item]) =>
        normalizeLineKey(item?.line) !== normalizeLineKey(line)
      ));
      for (const [id, observation] of bestByVehicle.entries()) {
        if (!observation.stopId && !observation.stopName) continue;
        next.set(vehicleStopKey(id, line), observation);
      }
      nextStopByVehicle = next;
      saveNextStopCache(payload.fetchedAt);
    }
    itineraryByVehicle.clear();
    render();
  }

  async function enrichAllLinesWithLive(workerBase) {
    if (liveEnrichmentRunning || !workerBase) return;
    liveEnrichmentRunning = true;
    // El enriquecimiento solo hace falta para líneas con autobuses actuales.
    // Saltamos líneas vacías o que fallaron en la consulta principal para reducir carga al SAE.
    const lines = ALL_LINES.filter(line => {
      const vehicles = lineSnapshots.get(line);
      return lineSnapshots.has(line) && !staleLines.has(line) &&
        Array.isArray(vehicles) && vehicles.length > 0;
    });
    let cursor = 0;
    let completed = 0;
    let successful = 0;
    let failed = 0;

    if (lines.length) {
      setStatus("Autobuses cargados · enlazando destinos y próximas paradas en " + lines.length + " líneas con coches (0 completadas)…", "");
    }

    try {
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= lines.length) return;
          const line = lines[index];
          try {
            const payload = await fetchLiveLineDetails(workerBase, line);
            mergeLiveLineDetails(line, payload);
            if (payload.partial) {
              failed++;
              console.warn("SAE Burgos: datos parciales de la línea " + line + ":",
                Array.isArray(payload.warnings) ? payload.warnings.join(" · ") : "faltan datos de recorrido o estimaciones");
            } else {
              successful++;
            }
          } catch (error) {
            failed++;
            console.warn("SAE Burgos: no se pudieron enlazar destino/próxima parada de la línea " +
              line + ":", error?.message || String(error));
          } finally {
            completed++;
            $("lastUpdated").textContent = "Destinos y próximas paradas: " +
              completed + "/" + lines.length + " líneas consultadas";
            setStatus("Autobuses en directo · destinos y próximas paradas: " +
              successful + "/" + lines.length + " líneas completadas" +
              (failed ? " · " + failed + " con error" : ""), failed ? "error" : "");
          }
        }
      }));
    } finally {
      liveEnrichmentRunning = false;
      const vehicleCount = [...lineSnapshots.values()].reduce((total, list) => total + list.length, 0);
      if (successful) {
        setStatus("Conexión de autobuses activa · " + vehicleCount + " autobuses. Destinos/próximas paradas completos en " +
          successful + "/" + lines.length + " líneas con coches" +
          (failed ? "; " + failed + " consultas incompletas o fallidas" : ""),
          failed ? "error" : "ok");
      } else if (lines.length) {
        setStatus("Conexión de autobuses activa · " + vehicleCount + " autobuses cargados. El SAE municipal no ha devuelto destinos y próximas paradas completos en esta pasada; se conserva la lista y se reintentará en el siguiente refresco.",
          "error");
      }
    }
  }

  async function load() {
    if (updateRunning) return;
    updateRunning = true;
    lineFetchProgress = { completed: 0, total: ALL_LINES.length, successful: 0, failed: 0 };
    $("refresh").disabled = true;
    $("refresh").innerHTML = '<span aria-hidden="true">↻</span> Consultando';
    setStatus(getWorkerBaseUrl()
      ? "Consultando coches por línea a través del Worker…"
      : "Sin Worker configurado · probando conexiones de respaldo…", "");
    try {
      const workerBase = getWorkerBaseUrl();
      if (workerBase) await verifyBurgosWorker(workerBase);
      let nextStaleLines = new Set();
      let successfulCount = 0;

      if (workerBase) {
        const snapshot = await fetchWorkerSnapshot(workerBase, (result, progress) => {
          const line = result.line;
          if (result.error) {
            if (lineSnapshots.has(line)) staleLines.add(line);
          } else {
            const vehiclesForLine = result.payload.vehicles
              .map(bus => normalizeVehicle(bus, line))
              .filter(Boolean);
            lineSnapshots.set(line, vehiclesForLine);
            staleLines.delete(line);
            lastQueryHadSuccess = true;
            lastSuccessfulUpdate = new Date();
            $("lastUpdated").textContent = "Consultadas " + progress.completed +
              "/" + progress.total + " líneas · " + formatTime(lastSuccessfulUpdate.toISOString());
            render();
          }
          setStatus("Consultando líneas de Burgos: " + progress.completed + "/" +
            progress.total + " · " + progress.successful + " correctas" +
            (progress.failed ? " · " + progress.failed + " con error" : "") +
            ". Los resultados se muestran conforme llegan.", progress.failed ? "error" : "");
        });
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
        // Destinos y próximas paradas se obtienen después de mostrar la flota, línea por línea.
        loadGtfsForItinerary();
        enrichAllLinesWithLive(workerBase);
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
      lineFetchProgress = { completed: ALL_LINES.length, total: ALL_LINES.length, successful: 0, failed: ALL_LINES.length };
      if (!lineSnapshots.size) lastQueryHadSuccess = false;
      setStatus(error?.message || "Error al consultar la fuente de autobuses de Burgos.", "error");
      render();
    } finally {
      updateRunning = false;
      $("refresh").disabled = false;
      $("refresh").innerHTML = '<span aria-hidden="true">↻</span> Actualizar';
    }
  }

  $("refresh").addEventListener("click", load);
  $("search").addEventListener("input", render);
  $("closeItinerary").addEventListener("click", () => $("itineraryDialog").close());
  $("itineraryDialog").addEventListener("click", event => {
    if (event.target === $("itineraryDialog")) $("itineraryDialog").close();
  });
  restoreNextStopCache();

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
      if (health?.ok !== true || health?.apiVersion !== WORKER_API_VERSION ||
          !String(health?.service || "").toLowerCase().includes("burgos")) {
        throw new Error("La URL no corresponde al Worker independiente actualizado de Burgos. No uses el Worker de Bizkaibus.");
      }
      localStorage.setItem(WORKER_STORAGE_KEY, base);
      localStorage.setItem(WORKER_CONFIG_VERSION_KEY, WORKER_API_VERSION);
      setStatus("Worker de Burgos verificado · consultando autobuses…", "");
      await load();
    } catch (error) {
      setStatus(error?.message || "No se ha podido guardar la conexión.", "error");
    }
  });
  $("clearWorkerUrl").addEventListener("click", async () => {
    try { localStorage.removeItem(WORKER_STORAGE_KEY); localStorage.removeItem(WORKER_CONFIG_VERSION_KEY); } catch {}
    $("workerUrlInput").value = DEFAULT_WORKER_URL;
    setStatus("URL predeterminada del Worker de Burgos restaurada.", "");
    await load();
  });

  load();
  setInterval(load, REFRESH_MS);
})();
