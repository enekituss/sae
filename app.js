const DATA_FILE = './vehicles.json';
const FEED = 'https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml';
const REFRESH_MS = 30000;
const REQUEST_TIMEOUT_MS = 8000;
const $ = id => document.getElementById(id);

let vehicles = [];
let expandedLines = new Set();
let lastSuccessfulUpdate = null;
let updateRunning = false;

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatTime(value) {
  if (!value) return 'Hora no disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatClock(value) {
  if (!value) return 'Hora no disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function vehicleSearchFields(vehicle) {
  const nextStops = Array.isArray(vehicle.upcomingStops) ? vehicle.upcomingStops.map(stop => stop.name) : [];
  return [
    vehicle.id, vehicle.idType, vehicle.lineRef, vehicle.direction, vehicle.destination,
    vehicle.destinationRef, vehicle.stop, vehicle.stopName, vehicle.journeyRef,
    vehicle.blockId, vehicle.tripShortName, vehicle.serviceNumber, vehicle.serviceCode, ...nextStops
  ];
}

function setStatus(message, state) {
  $('statusText').textContent = message;
  $('dot').className = 'status-dot' + (state ? ' ' + state : '');
}

function groupByLine(list) {
  const groups = new Map();
  for (const vehicle of list) {
    const line = vehicle.line || 'Sin línea identificada';
    if (!groups.has(line)) groups.set(line, []);
    groups.get(line).push(vehicle);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, {
      numeric: true, sensitivity: 'base'
    }));
  }
  return groups;
}

function render() {
  const groups = groupByLine(vehicles);
  const allLines = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' })
  );
  $('vehicleCount').textContent = vehicles.length;
  $('lineCount').textContent = allLines.length;

  const query = $('search').value.trim().toLocaleLowerCase('es');
  const matchingLines = allLines.filter(line => {
    const lineMatches = line.toLocaleLowerCase('es').includes(query);
    return !query || lineMatches || groups.get(line).some(v =>
      vehicleSearchFields(v)
        .some(value => String(value || '').toLocaleLowerCase('es').includes(query))
    );
  });

  $('lines').innerHTML = '';
  if (!matchingLines.length) {
    let message;
    if (query) {
      message = 'No hay líneas ni vehículos que coincidan con la búsqueda.';
    } else if (!lastSuccessfulUpdate) {
      message = 'La primera descarga de datos SIRI todavía no se ha completado. La web leerá aquí la copia pública en cuanto termine la primera ejecución automática.';
    } else {
      message = 'La última consulta del feed no contiene registros de vehículos.';
    }
    $('lines').innerHTML = '<div class="message">' + escapeHTML(message) +
      (!lastSuccessfulUpdate && !query
        ? '<br><br><a href="https://github.com/enekituss/sae/actions" target="_blank" rel="noopener noreferrer">Ver / ejecutar la actualización de datos</a>'
        : '') + '</div>';
    return;
  }

  for (const line of matchingLines) {
    const allVehicles = groups.get(line);
    const matchingVehicles = allVehicles.filter(v => !query ||
      line.toLocaleLowerCase('es').includes(query) ||
      vehicleSearchFields(v)
        .some(value => String(value || '').toLocaleLowerCase('es').includes(query))
    );
    const isOpen = expandedLines.has(line) || Boolean(query);
    const section = document.createElement('section');
    section.className = 'line' + (isOpen ? ' open' : '');
    section.innerHTML = `
      <button class="line-head" type="button" aria-expanded="${isOpen}" aria-label="Mostrar vehículos de la línea ${escapeHTML(line)}">
        <span class="line-leading">
          <span class="line-chevron" aria-hidden="true">›</span>
          <span>
            <span class="line-name">${escapeHTML(line)}</span>
            <span class="line-subtitle">${matchingVehicles.length === 1 ? '1 vehículo detectado' : matchingVehicles.length + ' vehículos detectados'}</span>
          </span>
        </span>
        <span class="badge">${matchingVehicles.length} ${matchingVehicles.length === 1 ? 'activo' : 'activos'}</span>
      </button>
      <div class="vehicles">
        ${matchingVehicles.map((vehicle, vehicleIndex) => `
          <article class="vehicle">
            <div class="vehicle-main">
              <div class="vehicle-id"><span class="bus-icon" aria-hidden="true">🚌</span><span>${escapeHTML(vehicle.id)}</span></div>
              <div class="vehicle-direction"><strong>Destino previsto:</strong> ${escapeHTML(vehicle.destination || 'No identificado en los datos disponibles')}${vehicle.destinationSource ? ` <span class="destination-source">· ${escapeHTML(vehicle.destinationSource)}</span>` : ''} </div>
              ${vehicle.direction ? `<div class="vehicle-direction"><strong>Sentido:</strong> ${escapeHTML(vehicle.direction)}</div>` : ''}
            </div>
            <div class="vehicle-meta">
              <div><strong>${escapeHTML(vehicle.idType || 'ID de vehículo')}</strong><br>${escapeHTML(vehicle.id)}</div>
              <div><strong>Línea</strong><br>${escapeHTML(vehicle.line || line)}${vehicle.lineRef && vehicle.lineRef !== vehicle.line ? ' · ref. ' + escapeHTML(vehicle.lineRef) : ''}</div>
              ${vehicle.serviceNumber ? `<div><strong>Servicio (inferido de SIRI)</strong><br>Servicio ${escapeHTML(vehicle.serviceNumber)}${vehicle.serviceCode ? ' · código ' + escapeHTML(vehicle.serviceCode) : ''}</div>` : ''}
              ${vehicle.blockId ? `<div><strong>Bloque de vehículo (GTFS)</strong><br>${escapeHTML(vehicle.blockId)}</div>` : ''}
              ${vehicle.tripShortName ? `<div><strong>N.º corto del viaje (GTFS)</strong><br>${escapeHTML(vehicle.tripShortName)}</div>` : ''}
              <div><strong>Última posición comunicada</strong><br>${escapeHTML(formatTime(vehicle.time))}</div>
              ${vehicle.stop ? `<div><strong>Parada SIRI</strong><br><a class="stop-link" href="./paradas.html?id=${escapeHTML(encodeURIComponent(vehicle.stop))}">${escapeHTML(vehicle.stopName || 'Consultar nombre en el directorio')}</a> · ID ${escapeHTML(vehicle.stop)}</div>` : ''}
            </div>
            ${Array.isArray(vehicle.upcomingStops) && vehicle.upcomingStops.length ? `
              <div class="vehicle-upcoming-action">
                <button class="upcoming-open" type="button" data-vehicle-index="${vehicleIndex}">
                  <span aria-hidden="true">☷</span> Ver itinerario completo <span class="upcoming-count">${vehicle.upcomingStops.length}</span>
                </button>
                <span class="upcoming-note">Horario previsto y estimaciones en tiempo real cuando están disponibles</span>
              </div>` : `
              <div class="vehicle-upcoming-action"><span class="no-upcoming">Itinerario próximo no disponible</span></div>`}
          </article>`).join('')}
      </div>`;
    section.querySelector('.line-head').addEventListener('click', () => {
      if (expandedLines.has(line)) expandedLines.delete(line);
      else expandedLines.add(line);
      render();
    });
    section.querySelectorAll('.upcoming-open').forEach(button => {
      button.addEventListener('click', () => {
        const vehicle = matchingVehicles[Number(button.dataset.vehicleIndex)];
        if (vehicle) openUpcomingDialog(vehicle);
      });
    });
    $('lines').appendChild(section);
  }
}

function openUpcomingDialog(vehicle) {
  const dialog = $('upcomingDialog');
  if (!dialog) return;

  $('upcomingDialogTitle').textContent = 'Itinerario hasta el final · ' + vehicle.id;
  const details = [
    vehicle.line ? 'Línea ' + vehicle.line : '',
    vehicle.serviceNumber ? 'Servicio ' + vehicle.serviceNumber : '',
    vehicle.destination ? 'Destino: ' + vehicle.destination : ''
  ].filter(Boolean);
  $('upcomingDialogSubtitle').textContent = details.join(' · ') || 'Itinerario publicado en los datos disponibles';

  $('upcomingDialogStops').innerHTML = '<ol class="dialog-stop-list">' +
    vehicle.upcomingStops.map((stop, index) => {
      const timingInfo = [stop.timeSource, stop.status].filter(Boolean).join(' · ') || 'Horario GTFS';
      const stopName = stop.name || ('Parada ' + (stop.stopId || ''));
      return `<li class="dialog-stop-row${stop.status ? ' dialog-stop-has-status' : ''}">
        <span class="dialog-stop-index">${index + 1}</span>
        <div class="dialog-stop-main">
          <strong>${escapeHTML(stopName)}</strong>
          <span>${stop.stopId ? 'ID ' + escapeHTML(stop.stopId) : ''}${stop.stopId ? ' · ' : ''}${escapeHTML(timingInfo)}</span>
        </div>
        <div class="dialog-stop-time">
          <time>${escapeHTML(formatClock(stop.arrivalTime || stop.departureTime))}</time>
          <small>hora prevista</small>
        </div>
      </li>`;
    }).join('') + '</ol>';

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

// La web está alojada en GitHub Pages, por lo que el navegador no puede leer
// necesariamente el XML de otro dominio (CORS). El flujo de GitHub Actions
// consulta SIRI del lado del servidor y publica esta copia JSON en el mismo sitio.
function applySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.vehicles)) throw new Error('La copia de datos no contiene vehículos en un formato válido');

  vehicles = snapshot.vehicles.map(v => ({
    id: String(v.id || 'ID no publicado'),
    idType: String(v.idType || 'ID de vehículo'),
    line: String(v.line || 'Sin línea identificada'),
    lineRef: String(v.lineRef || ''),
    direction: String(v.direction || ''),
    destination: String(v.destination || ''),
    destinationRef: String(v.destinationRef || ''),
    destinationSource: String(v.destinationSource || ''),
    blockId: String(v.blockId || ''),
    tripShortName: String(v.tripShortName || ''),
    calendarServiceId: String(v.calendarServiceId || ''),
    serviceNumber: String(v.serviceNumber || ''),
    serviceCode: String(v.serviceCode || ''),
    tripId: String(v.tripId || ''),
    upcomingStops: Array.isArray(v.upcomingStops) ? v.upcomingStops.map(stop => ({
      stopId: String(stop.stopId || ''),
      stopSequence: stop.stopSequence ?? null,
      name: String(stop.name || ''),
      arrivalTime: String(stop.arrivalTime || ''),
      departureTime: String(stop.departureTime || ''),
      timeSource: String(stop.timeSource || ''),
      status: String(stop.status || '')
    })) : [],
    time: String(v.time || ''),
    stop: String(v.stop || ''),
    stopName: String(v.stopName || ''),
    journeyRef: String(v.journeyRef || ''),
    lat: v.lat ?? '',
    lon: v.lon ?? ''
  }));

  const fetchedAt = snapshot.fetchedAt ? new Date(snapshot.fetchedAt) : null;
  lastSuccessfulUpdate = fetchedAt && !Number.isNaN(fetchedAt.getTime()) ? fetchedAt : null;
  render();
  $('lastUpdated').textContent = lastSuccessfulUpdate
    ? 'SIRI consultado: ' + lastSuccessfulUpdate.toLocaleTimeString('es-ES') + ' · ' + lastSuccessfulUpdate.toLocaleDateString('es-ES')
    : 'Fecha de consulta no disponible';
}

async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL('./vehicles.json', window.location.href);
    url.searchParams.set('_', String(Date.now()));
    const response = await fetch(url.toString(), {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error('vehicles.json respondió HTTP ' + response.status);
    const data = await response.json();
    if (!data || !Array.isArray(data.vehicles)) throw new Error('El fichero de datos no tiene el formato esperado');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('La copia de datos ha tardado demasiado en responder');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function load() {
  if (updateRunning) return;
  updateRunning = true;
  $('refresh').disabled = true;
  $('refresh').innerHTML = '<span aria-hidden="true">↻</span> Cargando';
  setStatus('Actualizando datos publicados…', '');

  try {
    const snapshot = await fetchSnapshot();
    applySnapshot(snapshot);
    const ageMinutes = lastSuccessfulUpdate
      ? Math.max(0, Math.round((Date.now() - lastSuccessfulUpdate.getTime()) / 60000))
      : null;
    if (ageMinutes !== null && ageMinutes >= 15) {
      setStatus('Copia de datos antigua · hace ' + ageMinutes + ' min', 'error');
    } else {
      setStatus('Datos disponibles · ' + vehicles.length + ' vehículos', 'ok');
    }
  } catch (error) {
    console.error('No se pudo leer vehicles.json:', error);
    // Si falla la petición JSON, seguimos mostrando la copia que se ha
    // cargado desde vehicles-data.js, en lugar de dejar vacía la página.
    if (window.BIZKAIBUS_DATA && Array.isArray(window.BIZKAIBUS_DATA.vehicles)) {
      try {
        applySnapshot(window.BIZKAIBUS_DATA);
        setStatus('Mostrando copia integrada · ' + vehicles.length + ' vehículos', vehicles.length ? 'ok' : 'error');
      } catch (fallbackError) {
        showLoadError(error);
      }
    } else {
      showLoadError(error);
    }
  } finally {
    updateRunning = false;
    $('refresh').disabled = false;
    $('refresh').innerHTML = '<span aria-hidden="true">↻</span> Actualizar';
  }
}

function showLoadError(error) {
  setStatus('No se han podido leer los datos', 'error');
  $('lines').innerHTML = `
    <div class="message error">
      <strong>No se ha podido leer la copia de datos publicada.</strong><br>
      <span>${escapeHTML(error.message)}</span>
      <br><br><a href="https://github.com/enekituss/sae/actions" target="_blank" rel="noopener noreferrer">Abrir el estado de la actualización SIRI</a>
      <br><br><a href="${FEED}" target="_blank" rel="noopener noreferrer">Abrir el feed oficial SIRI</a>
    </div>`;
  $('vehicleCount').textContent = '—';
  $('lineCount').textContent = '—';
  $('lastUpdated').textContent = 'Sin datos';
}


// Mostrar de inmediato la copia incluida en la página antes de consultar el JSON.
if (window.BIZKAIBUS_DATA && Array.isArray(window.BIZKAIBUS_DATA.vehicles)) {
  try {
    applySnapshot(window.BIZKAIBUS_DATA);
    setStatus('Copia integrada · ' + vehicles.length + ' vehículos', vehicles.length ? 'ok' : '');
  } catch (error) {
    console.warn('La copia integrada no se pudo procesar:', error);
  }
}

$('upcomingDialogClose').addEventListener('click', () => $('upcomingDialog').close());
$('upcomingDialog').addEventListener('click', event => {
  if (event.target === $('upcomingDialog')) $('upcomingDialog').close();
});

$('refresh').addEventListener('click', load);
$('search').addEventListener('input', render);
load();
setInterval(load, REFRESH_MS);
