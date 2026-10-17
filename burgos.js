(function () {
  const $ = id => document.getElementById(id);
  let data = null;
  let selectedRoute = '';
  let filteredTrips = [];
  const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const localISODate = date => [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
  const today = () => localISODate(new Date());
  const parseISO = s => String(s || '').replace(/-/g,'');
  const setStatus = (message, state) => {
    $('statusText').textContent = message;
    $('dot').className = 'status-dot' + (state ? ' ' + state : '');
  };
  function parseGTFSClock(value) {
    if (!value) return '—';
    const bits = String(value).split(':');
    if (bits.length < 2) return value;
    const h = Number(bits[0]), m = Number(bits[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return value;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + (h >= 24 ? ' (+1 día)' : '');
  }
  function routeLabel(route) {
    const number = route.shortName || route.id || 'Línea';
    return number + (route.longName && route.longName !== number ? ' · ' + route.longName : '');
  }
  function calendarActive(serviceId, dateIso) {
    const dateKey = parseISO(dateIso);
    const day = new Date(dateIso + 'T12:00:00').getDay();
    const weekdayIndex = (day + 6) % 7;
    let active = false;
    for (const cal of data.calendar || []) {
      if (cal.serviceId !== serviceId) continue;
      if (dateKey >= cal.startDate && dateKey <= cal.endDate && cal.weekdays && cal.weekdays[weekdayIndex]) active = true;
      break;
    }
    for (const item of data.exceptions || []) {
      if (item.serviceId === serviceId && item.date === dateKey) active = Number(item.exceptionType) === 1;
    }
    return active;
  }
  function servicesForDate(dateIso) {
    const active = new Set();
    const ids = new Set((data.trips || []).map(trip => trip.serviceId).filter(Boolean));
    for (const id of ids) if (calendarActive(id, dateIso)) active.add(id);
    return active;
  }
  function nextStopForTrip(trip, dateIso) {
    const now = new Date();
    if (dateIso !== today()) return (trip.stops || [])[0] || null;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    for (const item of trip.stops || []) {
      const time = item[1] || item[2];
      if (!time) continue;
      const [hh, mm] = String(time).split(':').map(Number);
      if (hh * 60 + mm >= currentMinutes) return item;
    }
    return null;
  }
  function stopName(id) {
    const stop = data.stopById.get(String(id));
    return stop ? stop.name : 'Parada ' + id;
  }
  function tripSearchFields(trip) {
    const route = data.routeById.get(trip.routeId) || {};
    const names = (trip.stops || []).flatMap(item => {
      const stop = data.stopById.get(String(item[0]));
      return [item[0], stop ? stop.name : ''];
    });
    return [trip.id, trip.routeId, trip.serviceId, trip.headsign, trip.blockId, trip.shortName,
      route.shortName, route.longName, ...names];
  }

  // ---- Seguimiento en directo de Burgos ----
  const BURGOS_LIVE_SOURCE = 'https://movilidad.aytoburgos.es/rutas-en-directo';
  const BURGOS_PORTLET = 'as_asac_isaenext_IsaenextWebPortlet';
  const BURGOS_PROXY_STORAGE = 'saeBurgosRealtimeProxy';
  const LIVE_REFRESH_MS = 25000;
  let liveMap = null;
  let liveLayer = null;
  let liveRefreshRunning = false;
  let liveFirstPositionFit = false;
  let liveInterval = null;

  function setLiveStatus(message, state) {
    const el = $('liveStatus');
    if (!el) return;
    el.className = 'live-status' + (state ? ' ' + state : '');
    el.textContent = message;
  }

  function liveProxyBase() {
    const fromPage = String(window.SAE_BURGOS_API_BASE || '').trim();
    const fromStorage = String(localStorage.getItem(BURGOS_PROXY_STORAGE) || '').trim();
    return (fromPage || fromStorage).replace(/\/+$/, '');
  }

  function initLiveMap() {
    if (!window.L) {
      setLiveStatus('No se ha podido cargar la librería del mapa. Comprueba la conexión a Internet y recarga la página.', 'error');
      return;
    }
    if (!liveMap) {
      liveMap = L.map('liveMap', { zoomControl: true }).setView([42.344, -3.696], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(liveMap);
      liveLayer = L.layerGroup().addTo(liveMap);
      window.setTimeout(() => liveMap && liveMap.invalidateSize(), 250);
    }

    const input = $('liveProxyUrl');
    if (input) input.value = liveProxyBase();
    $('liveConfigToggle').addEventListener('click', () => {
      const panel = $('liveConfigPanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) input.focus();
    });
    $('liveProxySave').addEventListener('click', () => {
      const value = String(input.value || '').trim().replace(/\/+$/, '');
      if (!value) {
        setLiveStatus('Introduce la URL base del Worker, por ejemplo https://nombre.subdominio.workers.dev.', 'warning');
        return;
      }
      if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(value)) {
        setLiveStatus('La URL debe empezar por https:// y contener solo el dominio del Worker, sin rutas.', 'warning');
        return;
      }
      localStorage.setItem(BURGOS_PROXY_STORAGE, value);
      $('liveConfigPanel').hidden = true;
      setLiveStatus('Conexión guardada. Probando el endpoint de posiciones…', '');
      refreshLivePositions();
    });
    $('liveProxyClear').addEventListener('click', () => {
      localStorage.removeItem(BURGOS_PROXY_STORAGE);
      input.value = '';
      setLiveStatus('Se ha quitado el Worker guardado. Se intentará consultar directamente la fuente municipal.', 'warning');
      refreshLivePositions();
    });
    $('liveRefresh').addEventListener('click', refreshLivePositions);
    window.setTimeout(() => liveMap && liveMap.invalidateSize(), 500);
    if (liveInterval) clearInterval(liveInterval);
    liveInterval = setInterval(refreshLivePositions, LIVE_REFRESH_MS);
  }

  function isaenextUrl(resource, extra) {
    const url = new URL(BURGOS_LIVE_SOURCE);
    url.searchParams.set('p_p_id', BURGOS_PORTLET);
    url.searchParams.set('p_p_lifecycle', '2');
    url.searchParams.set('p_p_state', 'normal');
    url.searchParams.set('p_p_mode', 'view');
    url.searchParams.set('p_p_cacheability', 'cacheLevelPage');
    url.searchParams.set('p_p_resource_id', resource);
    Object.entries(extra || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
  }

  async function jsonGet(url) {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(12000)
    });
    const body = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status);
    try { return JSON.parse(body); }
    catch (_) { throw new Error('La fuente no devolvió JSON reconocible.'); }
  }

  function readLiveNodeId(node) {
    return String((node && (node.num ?? node.id ?? node.stopId ?? node.nodeId ?? node.nodoId ?? node.idNodo ?? node.numNodo)) ?? '').trim();
  }

  function normalizeLiveObservations(nodes, results) {
    const nodeMap = new Map(nodes.map(node => [readLiveNodeId(node), node]));
    const rows = Array.isArray(results) ? results : [];
    const observations = [];
    rows.forEach((result, resultIndex) => {
      // Algunas versiones ISAENEXT no incluyen el ID de parada en cada
      // resultado, aunque devuelven un resultado por cada ID en el orden pedido.
      const explicitId = readLiveNodeId(result);
      let stopId = explicitId;
      let node = nodeMap.get(explicitId) || null;
      if (!node && rows.length === nodes.length && nodes[resultIndex]) {
        node = nodes[resultIndex];
        stopId = readLiveNodeId(node);
      }
      if (!node) node = result;
      const routeGroups = result.routeEstimationByNode || result.routes || [];
      for (const group of routeGroups) {
        const line = String(group.line ?? group.route ?? group.lineName ?? '').trim();
        const estimates = group.publicEstimationVHExts || group.estimations || group.buses || [];
        for (const item of estimates) {
          const id = String(item.vehicle ?? item.vehicleId ?? item.vehicle_id ?? '').trim();
          const secondsNumber = Number(item.seconds);
          const metersNumber = Number(item.meters);
          const lat = Number(item.lat ?? item.latitude);
          const lon = Number(item.lon ?? item.lng ?? item.longitude);
          observations.push({
            vehicleId: id && id !== '0' ? id : '',
            line,
            destination: String(item.destination ?? '').trim(),
            seconds: Number.isFinite(secondsNumber) ? secondsNumber : null,
            meters: Number.isFinite(metersNumber) ? metersNumber : null,
            stopId,
            stopName: String(node.name ?? node.stop_name ?? '').trim(),
            stopLat: Number(node.lat ?? node.latitude),
            stopLon: Number(node.lng ?? node.lon ?? node.longitude),
            vehicleLat: Number.isFinite(lat) && lat >= 42 && lat <= 43 ? lat : null,
            vehicleLon: Number.isFinite(lon) && lon >= -4 && lon <= -3 ? lon : null
          });
        }
      }
    });
    return observations;
  }

  async function directLiveSnapshot() {
    const nodes = await jsonGet(isaenextUrl('resourceNodes'));
    if (!Array.isArray(nodes) || !nodes.length) throw new Error('El Ayuntamiento no ha devuelto la lista de paradas.');
    const validNodes = nodes.filter(node => readLiveNodeId(node));
    const chunks = [];
    for (let i = 0; i < validNodes.length; i += 50) chunks.push(validNodes.slice(i, i + 50));
    const results = new Array(chunks.length);
    const errors = [];
    let cursor = 0;
    const concurrency = Math.min(5, chunks.length);
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        try {
          const payload = await jsonGet(isaenextUrl('resourceEstimations', {
            '_as_asac_isaenext_IsaenextWebPortlet_tipo': '1',
            '_as_asac_isaenext_IsaenextWebPortlet_nodoIds': chunk.map(readLiveNodeId).join(',')
          }));
          if (!Array.isArray(payload)) throw new Error('La respuesta no tiene formato de lista.');
          if (payload.length === 1 && chunk.length > 2) {
            throw new Error('ISAENEXT devolvió un único resultado para un grupo de ' + chunk.length + ' paradas.');
          }
          results[index] = { nodes: chunk, rows: payload };
        } catch (error) {
          errors.push('grupo ' + (index + 1) + ': ' + String(error.message || error));
          results[index] = null;
        }
      }
    }));
    const completed = results.filter(Boolean);
    if (!completed.length) {
      throw new Error('No se pudo consultar ninguna tanda de estimaciones. ' + errors.slice(0, 3).join(' | '));
    }
    const observations = [];
    let resultCount = 0;
    for (const group of completed) {
      resultCount += group.rows.length;
      observations.push(...normalizeLiveObservations(group.nodes, group.rows));
    }
    return {
      fetchedAt: new Date().toISOString(),
      sourceType: 'Consulta directa al visor ISAENEXT',
      stopCount: validNodes.length,
      resultCount,
      completedGroups: completed.length,
      totalGroups: chunks.length,
      partial: errors.length > 0,
      warnings: errors.slice(0, 5),
      observations
    };
  }

  async function proxyLiveSnapshot(base) {
    const response = await jsonGet(base + '/api/burgos/live');
    if (!Array.isArray(response.observations)) {
      throw new Error(response.error || 'El proxy no ha devuelto la lista de estimaciones.');
    }
    return response;
  }

  function normalizeLineKey(value) {
    return norm(value).replace(/^linea\s*/, '').replace(/^l(?=\d)/, '').replace(/^[0]+(?=\d)/, '').replace(/[^\da-z]/g, '');
  }

  function destinationTokens(value) {
    const ignored = new Set(['de','del','la','el','los','las','a','al','y','estacion','parada']);
    return norm(value).split(/[^a-z0-9]+/).filter(word => word && !ignored.has(word));
  }

  function destinationScore(a, b) {
    const aa = destinationTokens(a);
    const bb = destinationTokens(b);
    if (!aa.length || !bb.length) return 0;
    const bset = new Set(bb);
    let shared = 0;
    for (const token of aa) if (bset.has(token)) shared++;
    return shared / Math.max(aa.length, bb.length);
  }

  function haversine(a, b) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
  }

  function interpolatePoint(a, b, fraction) {
    return { lat: a.lat + (b.lat - a.lat) * fraction, lon: a.lon + (b.lon - a.lon) * fraction };
  }

  function projectBackAlongShape(shape, stop, meters) {
    if (!shape || !Array.isArray(shape.points) || shape.points.length < 2 || !stop) return null;
    const points = shape.points.map(point => ({ lat: Number(point[0]), lon: Number(point[1]) }))
      .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (points.length < 2) return null;

    let nearestIndex = -1;
    let nearestDistance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = haversine(points[i], stop);
      if (dist < nearestDistance) { nearestDistance = dist; nearestIndex = i; }
    }
    if (nearestIndex < 0 || nearestDistance > 250) return null;
    if (nearestIndex === 0) return meters <= 30 ? { ...points[0], source: 'Estimación junto a la primera parada' } : null;

    let remaining = Math.max(0, Number(meters) || 0);
    if (remaining === 0) return { ...points[nearestIndex], source: 'Parada indicada por ISAENEXT' };
    for (let i = nearestIndex; i > 0; i--) {
      const from = points[i];
      const to = points[i - 1];
      const segmentMeters = haversine(from, to);
      if (segmentMeters >= remaining && segmentMeters > 0) {
        return { ...interpolatePoint(from, to, remaining / segmentMeters), source: 'Estimación a partir de los metros a la parada' };
      }
      remaining -= segmentMeters;
    }
    return null;
  }

  function nearbyGtfsStops(observation, maxDistance = 280) {
    const lat = Number(observation.stopLat);
    const lon = Number(observation.stopLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !data || !Array.isArray(data.stops)) return [];
    const point = { lat, lon };
    return data.stops.map(stop => {
      const stopLat = Number(stop.lat);
      const stopLon = Number(stop.lon);
      if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) return null;
      return {
        stop,
        distance: haversine(point, { lat: stopLat, lon: stopLon })
      };
    }).filter(item => item && item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
  }

  function matchTripForObservation(observation) {
    if (!data || !data.routeById) return null;
    const lineKey = normalizeLineKey(observation.line);
    const nearbyStops = nearbyGtfsStops(observation);
    if (!nearbyStops.length) return null;
    const candidates = [];
    for (const nearby of nearbyStops) {
      const stopId = String(nearby.stop.id);
      const matches = data.liveTripIndex
        ? (data.liveTripIndex.get(lineKey + '|' + stopId) || [])
        : [];
      for (const candidate of matches) {
        if (!candidate.shape) continue;
        candidates.push({
          ...candidate,
          matchedStop: nearby.stop,
          stopDistance: nearby.distance,
          score: destinationScore(observation.destination, candidate.trip.headsign)
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || a.stopDistance - b.stopDistance);
    if (candidates[0].score === 0) {
      const possibleShapes = new Set(candidates.map(candidate => String(candidate.trip.shapeId || '')));
      if (possibleShapes.size > 1) return null;
    }
    return candidates[0];
  }

  function locateLiveVehicle(observation) {
    if (Number.isFinite(observation.vehicleLat) && Number.isFinite(observation.vehicleLon)) {
      return { lat: observation.vehicleLat, lon: observation.vehicleLon, source: 'GPS publicado por ISAENEXT' };
    }
    if (!Number.isFinite(observation.stopLat) || !Number.isFinite(observation.stopLon)) return null;
    if (!Number.isFinite(observation.meters) || observation.meters < 0 || observation.meters > 12000) return null;
    if (observation.meters === 0 && (!Number.isFinite(observation.seconds) || observation.seconds > 15)) return null;
    if (!data || !data.stopById) return null;

    const match = matchTripForObservation(observation);
    if (!match || !match.matchedStop) return null;
    const stop = match.matchedStop;
    if (!Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lon))) return null;
    const projected = projectBackAlongShape(match.shape, { lat: Number(stop.lat), lon: Number(stop.lon) }, observation.meters);
    if (!projected) return null;
    const offset = Math.round(match.stopDistance);
    return {
      ...projected,
      source: offset > 35
        ? 'Estimación sobre trazado GTFS · parada equivalente a ' + offset + ' m'
        : 'Estimación sobre trazado GTFS desde la parada equivalente'
    };
  }

  function deduplicateLiveVehicles(snapshot) {
    const bestByKey = new Map();
    for (const observation of (snapshot.observations || [])) {
      if (!observation.line || !observation.destination) continue;
      const key = observation.vehicleId
        ? 'vehicle:' + observation.vehicleId
        : 'estimate:' + normalizeLineKey(observation.line) + ':' + norm(observation.destination);
      const existing = bestByKey.get(key);
      const distanceA = Number.isFinite(observation.seconds) && observation.seconds >= 0 ? observation.seconds : Infinity;
      const distanceB = existing && Number.isFinite(existing.seconds) && existing.seconds >= 0 ? existing.seconds : Infinity;
      if (!existing || distanceA < distanceB) bestByKey.set(key, observation);
    }
    return [...bestByKey.values()].map(observation => {
      const route = data.routes.find(item => normalizeLineKey(item.shortName) === normalizeLineKey(observation.line));
      return {
        ...observation,
        route,
        position: locateLiveVehicle(observation)
      };
    }).sort((a, b) =>
      normalizeLineKey(a.line).localeCompare(normalizeLineKey(b.line), 'es', { numeric: true }) ||
      String(a.vehicleId || '').localeCompare(String(b.vehicleId || ''), 'es', { numeric: true })
    );
  }

  function secondsLabel(value) {
    if (!Number.isFinite(value) || value < 0) return 'sin estimación temporal';
    if (value < 60) return 'llegada estimada en menos de 1 min';
    return 'llegada estimada en ' + Math.ceil(value / 60) + ' min';
  }

  function markerIcon(vehicle) {
    const raw = String(vehicle.route && vehicle.route.color || '177456').replace('#', '');
    const color = /^[0-9a-f]{6}$/i.test(raw) ? '#' + raw : '#177456';
    const label = String(vehicle.line || '?');
    return L.divIcon({
      className: '',
      html: '<div class="bus-map-icon" style="background:' + color + '">🚌<span>' + esc(label) + '</span></div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });
  }

  function renderLiveVehicles(vehicles, snapshot) {
    if (!liveLayer || !liveMap) return;
    liveLayer.clearLayers();
    const positioned = [];
    for (const vehicle of vehicles) {
      if (!vehicle.position || !Number.isFinite(vehicle.position.lat) || !Number.isFinite(vehicle.position.lon)) continue;
      const marker = L.marker([vehicle.position.lat, vehicle.position.lon], { icon: markerIcon(vehicle) });
      const title = 'Línea ' + vehicle.line + (vehicle.vehicleId ? ' · Vehículo ' + vehicle.vehicleId : '');
      const locationLabel = vehicle.position.source || 'Posición estimada';
      const secondsText = secondsLabel(vehicle.seconds);
      const popup = '<div class="bus-popup"><strong>' + esc(title) + '</strong>' +
        '<div>Destino: ' + esc(vehicle.destination) + '</div>' +
        '<div>' + esc(secondsText) + '</div>' +
        '<small>Referencia: ' + esc(vehicle.stopName || ('Parada ' + vehicle.stopId)) + '</small>' +
        '<small>' + esc(locationLabel) + '</small></div>';
      marker.bindPopup(popup);
      marker.addTo(liveLayer);
      positioned.push([vehicle.position.lat, vehicle.position.lon]);
    }
    $('liveBusCount').textContent = String(vehicles.length);
    $('livePositionCount').textContent = String(positioned.length);
    $('liveStopCount').textContent = String(snapshot.stopCount || '—');

    if (!vehicles.length) {
      $('liveVehicleList').innerHTML = '<div class="live-empty">La consulta no ha devuelto estimaciones de autobuses para las paradas consultadas. Puede que no haya servicio activo en este momento o que ISAENEXT no esté publicando estimaciones ahora. <a href="https://webburgos.com/bus/" target="_blank" rel="noopener noreferrer">Abrir otro visor de seguimiento en directo ↗</a></div>';
    } else {
      $('liveVehicleList').innerHTML = vehicles.slice(0, 150).map(vehicle => {
        const routeLabel = vehicle.route ? (vehicle.route.shortName || vehicle.line) : vehicle.line;
        const positionLabel = vehicle.position
          ? '<span class="live-position-tag">' + esc(vehicle.position.source || 'Posición estimada en el trazado') + '</span>'
          : '<span>Sin coordenadas suficientes para situarlo con rigor</span>';
        const idLabel = vehicle.vehicleId ? 'Vehículo ' + vehicle.vehicleId : 'Vehículo sin ID publicado';
        const distanceLabel = Number.isFinite(vehicle.meters) && vehicle.meters > 0 ? ' · ' + Math.round(vehicle.meters) + ' m a la parada' : '';
        return '<article class="live-vehicle-card">' +
          '<div class="live-vehicle-chip">' + esc(routeLabel) + '</div>' +
          '<div class="live-vehicle-info"><strong>' + esc(idLabel + ' · ' + vehicle.destination) + '</strong>' +
          '<span>' + esc(secondsLabel(vehicle.seconds) + distanceLabel) + '</span>' +
          '<span>Próxima referencia: ' + esc(vehicle.stopName || ('Parada ' + vehicle.stopId)) + '</span>' +
          positionLabel + '</div></article>';
      }).join('');
    }

    if (!vehicles.length) {
      setLiveStatus('La fuente respondió, pero no devolvió estimaciones de vehículos para las paradas consultadas. Puede que no haya buses activos ahora o que ISAENEXT no esté publicando datos.', 'warning');
    } else if (!positioned.length) {
      setLiveStatus('La conexión de estimaciones funciona, pero no se han podido reconstruir coordenadas de los vehículos con suficiente fiabilidad. No se muestran marcadores falsos.', 'warning');
    } else {
      const located = vehicles.filter(v => v.position && String(v.position.source).includes('GPS publicado')).length;
      const estimated = positioned.length - located;
      setLiveStatus('Recibidas ' + vehicles.length + ' estimaciones; ' + positioned.length + ' vehículos aparecen en el mapa (' +
        located + ' coordenadas GPS publicadas y ' + estimated + ' posiciones estimadas sobre el trazado). Las estimaciones se renuevan automáticamente.', 'ok');
    }
    if (!liveFirstPositionFit && positioned.length) {
      liveMap.fitBounds(positioned, { padding: [30, 30], maxZoom: 14 });
      liveFirstPositionFit = true;
    }
  }

  async function refreshLivePositions() {
    if (liveRefreshRunning || !liveMap) return;
    if (!data || !data.routes || !data.routes.length) {
      setLiveStatus('Esperando a que carguen los recorridos GTFS para poder ubicar los vehículos en el mapa…', '');
      return;
    }
    liveRefreshRunning = true;
    $('liveRefresh').disabled = true;
    $('liveRefresh').textContent = 'Consultando…';
    setLiveStatus('Consultando la fuente municipal de estimaciones…', '');
    try {
      let snapshot;
      let directError = null;
      const base = liveProxyBase();
      if (base) {
        try {
          snapshot = await proxyLiveSnapshot(base);
        } catch (error) {
          directError = error;
          console.warn('No se pudo consultar el Worker guardado; se prueba la fuente directa:', error);
        }
      }
      if (!snapshot) {
        try {
          snapshot = await directLiveSnapshot();
        } catch (error) {
          directError = error;
          if (base) throw new Error('El Worker y la consulta directa han fallado. Worker: ' + String(directError.message || directError));
          throw error;
        }
      }
      const vehicles = deduplicateLiveVehicles(snapshot);
      renderLiveVehicles(vehicles, snapshot);
      $('liveUpdated').textContent = 'Consulta: ' + new Date(snapshot.fetchedAt || Date.now()).toLocaleTimeString('es-ES');
      if (snapshot.partial) {
        setLiveStatus('Datos parciales: se han podido consultar ' + snapshot.completedGroups + ' de ' + snapshot.totalGroups + ' grupos de paradas. ' + (Array.isArray(snapshot.warnings) ? snapshot.warnings.slice(0, 2).join(' · ') : ''), 'warning');
      }
    } catch (error) {
      console.error('No se pudieron consultar los autobuses de Burgos en directo:', error);
      $('liveBusCount').textContent = '—';
      $('livePositionCount').textContent = '—';
      $('liveStopCount').textContent = '—';
      $('liveUpdated').textContent = 'Sin conexión en directo';
      $('liveVehicleList').innerHTML = '<div class="live-empty">No se ha podido recuperar la fuente de autobuses en directo. <a href="https://webburgos.com/bus/" target="_blank" rel="noopener noreferrer">Abrir otro visor de seguimiento en directo ↗</a></div>';
      setLiveStatus('No se ha podido acceder a ISAENEXT desde el navegador: ' + String(error.message || error) +
        '. Si Chrome bloquea la conexión directa, despliega el Worker de Cloudflare del repositorio y guarda su URL en «Configurar conexión».', 'error');
      if (!liveProxyBase()) $('liveConfigPanel').hidden = false;
    } finally {
      liveRefreshRunning = false;
      $('liveRefresh').disabled = false;
      $('liveRefresh').textContent = '↻ Actualizar posiciones';
    }
  }

  function buildNotice() {
    const notice = $('dataNotice');
    if (!data || !data.fetchedAt) {
      notice.className = 'notice warning';
      notice.innerHTML = '<strong>Los horarios todavía no se han descargado.</strong> Se ha preparado la actualización automática del GTFS. Cuando termine la primera ejecución, la web mostrará el fichero publicado. <a href="https://github.com/enekituss/sae/actions/workflows/update-burgos-gtfs.yml" target="_blank" rel="noopener noreferrer">Abrir actualización de horarios</a>.';
      return;
    }
    const start = data.serviceStart || 'no indicada';
    const end = data.serviceEnd || 'no indicada';
    const expired = data.serviceEnd && parseISO(today()) > data.serviceEnd;
    const future = data.serviceStart && parseISO(today()) < data.serviceStart;
    if (expired || future) {
      notice.className = 'notice warning';
      notice.innerHTML = '<strong>Atención: calendario GTFS fuera de la fecha actual.</strong> El fichero descargado indica vigencia entre ' + esc(start) + ' y ' + esc(end) + '. Se pueden consultar como referencia los horarios publicados, pero no afirmar que sigan siendo los horarios vigentes de hoy.';
    } else {
      notice.className = 'notice';
      notice.innerHTML = '<strong>Calendario GTFS dentro de su intervalo declarado.</strong> Vigencia del fichero: ' + esc(start) + ' a ' + esc(end) + '. Esto es un calendario programado, no una confirmación de que cada viaje esté circulando ahora.';
    }
  }
  function renderRoutes() {
    const query = norm($('search').value);
    const routes = data.routes.filter(route => {
      const label = norm(routeLabel(route));
      return !query || label.includes(query) || route.tripsCount.toString().includes(query);
    });
    $('listTitle').textContent = 'LÍNEAS DE AUTOBÚS';
    $('clearLine').hidden = true;
    if (!routes.length) {
      $('results').innerHTML = '<div class="message">No hay líneas que coincidan con la búsqueda.</div>';
      return;
    }
    $('results').innerHTML = '<div class="route-grid">' + routes.map(route => `
      <button type="button" class="route-card" data-route-id="${esc(route.id)}">
        <span class="route-number">${esc(route.shortName || route.id)}</span>
        <span class="route-content"><span class="route-name">${esc(route.longName || route.shortName || route.id)}</span>
        <span class="route-meta">${route.tripsCount} viajes en el fichero · ID GTFS ${esc(route.id)}</span></span>
        <span class="route-chevron" aria-hidden="true">›</span>
      </button>`).join('') + '</div>';
    $('results').querySelectorAll('[data-route-id]').forEach(button => button.addEventListener('click', () => {
      selectedRoute = button.dataset.routeId;
      render();
    }));
  }
  function renderTrips() {
    const route = data.routeById.get(selectedRoute);
    if (!route) { selectedRoute = ''; renderRoutes(); return; }
    const dateIso = $('serviceDate').value || today();
    const activeServices = servicesForDate(dateIso);
    const includeAll = $('showAllSchedules').checked;
    const query = norm($('search').value);
    const allRouteTrips = data.trips.filter(trip => trip.routeId === selectedRoute);
    filteredTrips = allRouteTrips.filter(trip => (includeAll || activeServices.has(trip.serviceId)) &&
      (!query || tripSearchFields(trip).some(field => norm(field).includes(query))));
    filteredTrips.sort((a,b) => {
      const ta = (a.stops[0] || [,'99:99'])[1] || (a.stops[0] || [,, '99:99'])[2] || '99:99';
      const tb = (b.stops[0] || [,'99:99'])[1] || (b.stops[0] || [,, '99:99'])[2] || '99:99';
      return ta.localeCompare(tb);
    });
    $('listTitle').textContent = 'LÍNEA ' + (route.shortName || route.id) + ' · ' + (route.longName || route.shortName || '');
    $('clearLine').hidden = false;
    if (!filteredTrips.length) {
      const reason = includeAll ? 'No hay viajes del fichero que coincidan con la búsqueda.' :
        'El calendario GTFS no marca viajes de esta línea para la fecha seleccionada (o no hay coincidencias de búsqueda). Puedes activar «Mostrar también horarios de referencia de otras fechas» para ver todos los viajes publicados.';
      $('results').innerHTML = '<div class="message">' + esc(reason) + '</div>';
      return;
    }
    $('results').innerHTML = '<div class="trip-list">' + filteredTrips.map((trip, index) => {
      const next = nextStopForTrip(trip, dateIso);
      const routeText = routeLabel(route);
      const count = (trip.stops || []).length;
      const scheduledNext = next ? stopName(next[0]) + ' · ' + parseGTFSClock(next[1] || next[2]) : 'Sin próxima parada calculada para la hora actual';
      const currentFeedOnly = !activeServices.has(trip.serviceId);
      const hoursMeta = currentFeedOnly ? '<span>Calendario distinto de la fecha elegida</span>' : '<span>Servicio programado para la fecha elegida</span>';
      const block = trip.blockId ? '<span>Bloque GTFS: ' + esc(trip.blockId) + '</span>' : '';
      const short = trip.shortName ? '<span>Nombre corto: ' + esc(trip.shortName) + '</span>' : '';
      const stopsRows = (trip.stops || []).map((item, stopIndex) => {
        const stopId = item[0], arrival = item[1] || item[2], departure = item[2] || item[1];
        const exact = String(item[4] ?? '') !== '0';
        const quality = exact ? '<span class="time-exact">Hora publicada como exacta o sin marca de aproximación</span>' : '<span class="time-approx">Hora aproximada/interpolada según GTFS</span>';
        return '<tr><td class="stop-seq">' + esc(item[3] ?? (stopIndex+1)) + '</td><td><span class="stop-name">' + esc(stopName(stopId)) + '</span><span class="stop-id">ID GTFS: ' + esc(stopId) + '</span></td><td class="stop-time">' + esc(parseGTFSClock(arrival)) + quality + '</td><td class="stop-time">' + esc(parseGTFSClock(departure)) + '</td></tr>';
      }).join('');
      return `<article class="trip-card">
        <header class="trip-head"><div class="trip-title"><strong>${esc(trip.headsign || routeText || 'Viaje programado')}</strong><small>${currentFeedOnly ? 'Viaje de referencia · ' : ''}ID del viaje GTFS: ${esc(trip.id)}</small></div><span class="trip-tag">Viaje ${index+1}</span></header>
        <div class="trip-meta">${hoursMeta}<span>Servicio de calendario: ${esc(trip.serviceId || 'no indicado')}</span><span>${count} paradas</span>${block}${short}</div>
        <div class="next-stop">Siguiente parada según horario: ${esc(scheduledNext)}<small>No es una posición GPS ni una predicción en tiempo real. Las horas se muestran según la fecha de servicio seleccionada.</small></div>
        <details><summary>Ver ${count} paradas y todas las horas de paso</summary><div class="stop-table-wrap"><table class="stop-table"><thead><tr><th>Orden</th><th>Parada</th><th>Llegada prevista</th><th>Salida prevista</th></tr></thead><tbody>${stopsRows}</tbody></table></div></details>
      </article>`;
    }).join('') + '</div>';
  }
  function render() {
    if (!data) return;
    if (selectedRoute && !data.routeById.has(selectedRoute)) selectedRoute = '';
    if (selectedRoute) renderTrips(); else renderRoutes();
  }
  async function loadData() {
    $('refresh').disabled = true;
    $('refresh').textContent = 'Cargando…';
    setStatus('Descargando horarios publicados…', '');
    try {
      const url = new URL('./burgos-data.json', window.location.href);
      url.searchParams.set('_', String(Date.now()));
      const response = await fetch(url.toString(), {cache:'no-store',headers:{Accept:'application/json'}});
      if (!response.ok) throw new Error('burgos-data.json respondió HTTP ' + response.status);
      data = await response.json();
      data.routes = (data.routes || []).map(r => ({...r,tripsCount:0}));
      data.stopById = new Map((data.stops || []).map(s => [String(s.id),s]));
      data.routeById = new Map(data.routes.map(r => [String(r.id),r]));
      data.shapeById = new Map((data.shapes || []).map(shape => [String(shape.id), shape]));
      data.trips = data.trips || [];
      data.liveTripIndex = new Map();
      for (const trip of data.trips) {
        const route = data.routeById.get(String(trip.routeId));
        const lineKeys = route ? [route.shortName, route.id].map(normalizeLineKey).filter(Boolean) : [];
        for (const item of trip.stops || []) {
          for (const lineKey of lineKeys) {
            const key = lineKey + '|' + String(item[0]);
            if (!data.liveTripIndex.has(key)) data.liveTripIndex.set(key, []);
            data.liveTripIndex.get(key).push({
              trip,
              shape: data.shapeById.get(String(trip.shapeId))
            });
          }
        }
      }
      for (const trip of data.trips) {
        const route = data.routeById.get(String(trip.routeId));
        if (route) route.tripsCount += 1;
        trip.stops = trip.stops || [];
      }
      $('routeCount').textContent = data.routes.length.toLocaleString('es-ES');
      $('stopCount').textContent = (data.stops || []).length.toLocaleString('es-ES');
      $('tripCount').textContent = data.trips.length.toLocaleString('es-ES');
      $('lastUpdated').textContent = data.fetchedAt ? 'Descargado: ' + new Date(data.fetchedAt).toLocaleDateString('es-ES') : 'Datos pendientes';
      $('feedValidity').textContent = data.serviceStart && data.serviceEnd ? 'Fechas declaradas del calendario: ' + data.serviceStart + ' – ' + data.serviceEnd : 'El fichero no declara un periodo de vigencia.';
      if (data.sourceUrl && data.producerUrl && data.sourceUrl !== data.producerUrl) {
        $('sourceDescription').innerHTML = 'Publicación original: <a href="' + esc(data.producerUrl) + '" target="_blank" rel="noopener noreferrer">Ayuntamiento de Burgos</a> · Copia descargada desde <a href="https://mobilitydatabase.org/feeds/gtfs/mdb-3145" target="_blank" rel="noopener noreferrer">Mobility Database</a>.';
      }
      buildNotice();
      // Si el último GTFS publicado no cubre la fecha actual, mostrar los
      // viajes que sí contiene como referencia en vez de dejar cada línea vacía.
      if (data.serviceStart && data.serviceEnd) {
        const currentDateKey = parseISO(today());
        if (currentDateKey < data.serviceStart || currentDateKey > data.serviceEnd) {
          $('showAllSchedules').checked = true;
        }
      }
      setStatus('GTFS leído · ' + data.routes.length + ' líneas', data.routes.length ? 'ok' : 'error');
      const params = new URLSearchParams(window.location.search);
      const preset = params.get('line');
      if (preset) {
        const match = data.routes.find(r => r.id === preset || r.shortName === preset);
        if (match) selectedRoute = match.id;
      }
      render();
      refreshLivePositions();
    } catch (error) {
      console.error('No se pudieron cargar los horarios de Burgos:', error);
      setStatus('No se han podido cargar los horarios', 'error');
      $('dataNotice').className = 'notice warning';
      $('dataNotice').innerHTML = '<strong>La base de horarios todavía no está disponible.</strong> La página está preparada, pero la primera ejecución del actualizador debe descargar el GTFS municipal. <a href="https://github.com/enekituss/sae/actions/workflows/update-burgos-gtfs.yml" target="_blank" rel="noopener noreferrer">Abrir actualización de GTFS</a>.';
      $('results').innerHTML = '<div class="message error">No se ha podido leer la base de datos: ' + esc(error.message) + '. Comprueba el resultado del flujo de actualización.</div>';
    } finally {
      $('refresh').disabled = false;
      $('refresh').textContent = '↻ Actualizar';
    }
  }
  $('search').addEventListener('input', render);
  $('serviceDate').addEventListener('change', render);
  $('showAllSchedules').addEventListener('change', render);
  $('refresh').addEventListener('click', loadData);
  $('clearLine').addEventListener('click', () => { selectedRoute = ''; const url = new URL(window.location.href); url.searchParams.delete('line'); history.replaceState(history.state, '', url.toString()); render(); });
  $('serviceDate').value = today();
  initLiveMap();
  loadData();
})();