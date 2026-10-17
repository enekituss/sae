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
      data.trips = data.trips || [];
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
  loadData();
})();