const FEED = 'https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml';
const PROXY_FEED = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(FEED);
const REFRESH_MS = 30000;
const $ = id => document.getElementById(id);

let vehicles = [];
let expandedLines = new Set();
let lastSuccessfulUpdate = null;

function text(el, name) {
  if (!el) return '';
  const n = el.getElementsByTagNameNS('*', name)[0] || el.getElementsByTagName(name)[0];
  return n ? n.textContent.trim() : '';
}

function parse(xml) {
  const activities = [...xml.getElementsByTagNameNS('*', 'VehicleActivity')];
  return activities.map((activity, index) => {
    const journey = activity.getElementsByTagNameNS('*', 'MonitoredVehicleJourney')[0];
    if (!journey) return null;

    const location = journey.getElementsByTagNameNS('*', 'VehicleLocation')[0];
    if (!location) return null;

    const lat = Number(text(location, 'Latitude'));
    const lon = Number(text(location, 'Longitude'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const id = text(journey, 'VehicleRef') || text(journey, 'VehicleJourneyRef') || 'Vehículo ' + (index + 1);
    const line = text(journey, 'PublishedLineName') || text(journey, 'LineRef') || 'Sin línea identificada';
    const direction = text(journey, 'DestinationName') || text(journey, 'DirectionName') || '';
    const time = text(journey, 'LocationRecordedAtTime') || text(activity, 'RecordedAtTime') || text(journey, 'RecordedAtTime');

    return {
      id,
      line,
      direction,
      time,
      stop: text(journey, 'StopPointRef'),
      journeyRef: text(journey, 'VehicleJourneyRef')
    };
  }).filter(Boolean);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatTime(value) {
  if (!value) return 'Hora no disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(message, state) {
  $('statusText').textContent = message;
  $('dot').className = 'status-dot' + (state ? ' ' + state : '');
}

function groupByLine(list) {
  const groups = new Map();
  for (const vehicle of list) {
    if (!groups.has(vehicle.line)) groups.set(vehicle.line, []);
    groups.get(vehicle.line).push(vehicle);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
  }
  return groups;
}

function render() {
  const groups = groupByLine(vehicles);
  const allLines = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));
  $('vehicleCount').textContent = vehicles.length;
  $('lineCount').textContent = allLines.length;

  const query = $('search').value.trim().toLocaleLowerCase('es');
  const matchingLines = allLines.filter(line => {
    const lineMatches = line.toLocaleLowerCase('es').includes(query);
    return !query || lineMatches || groups.get(line).some(v =>
      [v.id, v.direction, v.stop, v.journeyRef].some(value => String(value || '').toLocaleLowerCase('es').includes(query))
    );
  });

  $('lines').innerHTML = '';
  if (!matchingLines.length) {
    const message = !query && vehicles.length === 0
      ? 'El feed se ha leído correctamente, pero ahora mismo no devuelve vehículos con posición.'
      : 'No hay líneas ni vehículos que coincidan con la búsqueda.';
    $('lines').innerHTML = '<div class="message">' + message + '</div>';
    return;
  }

  for (const line of matchingLines) {
    const allVehicles = groups.get(line);
    const matchingVehicles = allVehicles.filter(v => !query ||
      line.toLocaleLowerCase('es').includes(query) ||
      [v.id, v.direction, v.stop, v.journeyRef].some(value => String(value || '').toLocaleLowerCase('es').includes(query))
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
        ${matchingVehicles.map(vehicle => `
          <article class="vehicle">
            <div class="vehicle-main">
              <div class="vehicle-id"><span class="bus-icon" aria-hidden="true">🚌</span><span>${escapeHTML(vehicle.id)}</span></div>
              <div class="vehicle-direction">${escapeHTML(vehicle.direction || 'Sentido/destino no indicado')}</div>
            </div>
            <div class="vehicle-meta">
              <div><strong>Última posición</strong><br>${escapeHTML(formatTime(vehicle.time))}</div>
              ${vehicle.stop ? `<div><strong>Referencia de parada</strong><br>${escapeHTML(vehicle.stop)}</div>` : ''}
            </div>
          </article>`
        ).join('')}
      </div>`;
    section.querySelector('.line-head').addEventListener('click', () => {
      if (expandedLines.has(line)) expandedLines.delete(line);
      else expandedLines.add(line);
      render();
    });
    $('lines').appendChild(section);
  }
}

async function fetchFeed(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const body = await response.text();
  const xml = new DOMParser().parseFromString(body, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length || !xml.documentElement) throw new Error('Respuesta XML no válida');
  const hasActivities = xml.getElementsByTagNameNS('*', 'VehicleActivity').length > 0;
  const isSiriResponse = /Siri|VehicleMonitoringDelivery|VehicleActivity/i.test(xml.documentElement.nodeName + ' ' + body.slice(0, 1000));
  if (!hasActivities && !isSiriResponse) throw new Error('La respuesta no parece contener datos SIRI');
  return xml;
}

async function load() {
  $('refresh').disabled = true;
  $('refresh').innerHTML = '<span aria-hidden="true">↻</span> Cargando';
  setStatus('Actualizando datos…', '');

  try {
    let xml;
    let usedProxy = false;
    try {
      xml = await fetchFeed(FEED);
    } catch (directError) {
      console.warn('El feed SIRI directo no se pudo leer; se probará una ruta alternativa.', directError);
      xml = await fetchFeed(PROXY_FEED);
      usedProxy = true;
    }

    vehicles = parse(xml);
    lastSuccessfulUpdate = new Date();
    render();
    $('lastUpdated').textContent = 'Actualizado a las ' + lastSuccessfulUpdate.toLocaleTimeString('es-ES');
    setStatus((usedProxy ? 'Conectado mediante alternativa' : 'Feed actualizado') + ' · ' + vehicles.length + ' vehículos', 'ok');
  } catch (error) {
    console.error('No se pudo actualizar el feed Bizkaibus SIRI:', error);
    setStatus('No se pudieron cargar los datos', 'error');
    if (!lastSuccessfulUpdate) {
      $('lines').innerHTML = `
        <div class="message error">
          <strong>No se ha podido conectar con el feed de vehículos.</strong><br>
          Puede ser un bloqueo de conexión/CORS o un problema temporal de la fuente de datos. Pulsa «Actualizar» para volver a intentarlo.
          <br><br><a href="${FEED}" target="_blank" rel="noopener noreferrer">Abrir el feed oficial SIRI</a>
        </div>`;
      $('vehicleCount').textContent = '—';
      $('lineCount').textContent = '—';
      $('lastUpdated').textContent = 'Sin datos';
    } else {
      $('lastUpdated').textContent = 'Error al actualizar · datos anteriores de ' + lastSuccessfulUpdate.toLocaleTimeString('es-ES');
    }
  } finally {
    $('refresh').disabled = false;
    $('refresh').innerHTML = '<span aria-hidden="true">↻</span> Actualizar';
  }
}

$('refresh').addEventListener('click', load);
$('search').addEventListener('input', render);
load();
setInterval(load, REFRESH_MS);
