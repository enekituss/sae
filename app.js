const FEED = 'https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml';
const PROXY_FEED = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(FEED);
const REFRESH_MS = 30000;
const $ = id => document.getElementById(id);

let vehicles = [];
let expandedLines = new Set();
let lastSuccessfulUpdate = null;

// SIRI normally declares a namespace, but tolerate XML responses without one too.
function elements(root, name) {
  if (!root) return [];
  let found = [];
  try { found = [...root.getElementsByTagNameNS('*', name)]; } catch (_) {}
  return found.length ? found : [...root.getElementsByTagName(name)];
}

function text(el, name) {
  const node = elements(el, name)[0];
  return node ? node.textContent.trim() : '';
}

function firstText(el, names) {
  for (const name of names) {
    const value = text(el, name);
    if (value) return value;
  }
  return '';
}

function parse(xml) {
  const activities = elements(xml, 'VehicleActivity');
  const result = [];

  activities.forEach((activity, index) => {
    const journey = elements(activity, 'MonitoredVehicleJourney')[0];
    if (!journey) return;

    // Do not discard an activity just because coordinates are absent: the goal
    // of this page is to show the vehicle identifier and the line it is serving.
    const vehicleId = firstText(journey, [
      'VehicleRef', 'VehicleIdentifier', 'VehicleId', 'FleetNumber'
    ]) || firstText(activity, [
      'VehicleRef', 'VehicleIdentifier', 'VehicleId', 'FleetNumber'
    ]);

    const lineName = firstText(journey, [
      'PublishedLineName', 'LineName', 'PublicLineCode', 'LinePublicNumber'
    ]);
    const lineRef = firstText(journey, ['LineRef', 'LineReference']);
    const line = lineName || lineRef || firstText(activity, [
      'PublishedLineName', 'LineName', 'LineRef', 'LineReference'
    ]) || 'Sin línea identificada';

    // VehicleRef is the vehicle's own identifier. VehicleJourneyRef is a trip
    // identifier, so only use it as a fallback and label that in the interface.
    const journeyRef = firstText(journey, [
      'VehicleJourneyRef', 'DatedVehicleJourneyRef'
    ]) || firstText(activity, ['VehicleJourneyRef', 'DatedVehicleJourneyRef']);
    const id = vehicleId || journeyRef || ('ID no publicado · registro ' + (index + 1));
    const idType = vehicleId ? 'ID de vehículo' : (journeyRef ? 'Referencia de viaje (sin ID de vehículo)' : 'Identificador no publicado');

    const recordedTime = firstText(journey, [
      'LocationRecordedAtTime', 'RecordedAtTime'
    ]) || firstText(activity, ['RecordedAtTime', 'ValidUntilTime']);

    result.push({
      id,
      idType,
      line,
      lineRef,
      direction: firstText(journey, ['DestinationName', 'DestinationDisplay', 'DirectionName']),
      time: recordedTime,
      stop: firstText(journey, ['StopPointRef', 'StopPointName']),
      journeyRef,
      lat: firstText(journey, ['Latitude']),
      lon: firstText(journey, ['Longitude'])
    });
  });

  // Avoid showing the same vehicle twice if the feed contains duplicated activities.
  const unique = new Map();
  for (const vehicle of result) {
    const key = vehicle.id + '|' + vehicle.line + '|' + vehicle.journeyRef;
    if (!unique.has(key)) unique.set(key, vehicle);
  }
  return [...unique.values()];
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
  return date.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit'
  });
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
    group.sort((a, b) => a.id.localeCompare(b.id, undefined, {
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
      [v.id, v.idType, v.lineRef, v.direction, v.stop, v.journeyRef]
        .some(value => String(value || '').toLocaleLowerCase('es').includes(query))
    );
  });

  $('lines').innerHTML = '';
  if (!matchingLines.length) {
    const message = !query && vehicles.length === 0
      ? 'El feed se ha leído correctamente, pero no contiene registros de vehículos en esta actualización.'
      : 'No hay líneas ni vehículos que coincidan con la búsqueda.';
    $('lines').innerHTML = '<div class="message">' + message + '</div>';
    return;
  }

  for (const line of matchingLines) {
    const allVehicles = groups.get(line);
    const matchingVehicles = allVehicles.filter(v => !query ||
      line.toLocaleLowerCase('es').includes(query) ||
      [v.id, v.idType, v.lineRef, v.direction, v.stop, v.journeyRef]
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
        ${matchingVehicles.map(vehicle => `
          <article class="vehicle">
            <div class="vehicle-main">
              <div class="vehicle-id"><span class="bus-icon" aria-hidden="true">🚌</span><span>${escapeHTML(vehicle.id)}</span></div>
              <div class="vehicle-direction">${escapeHTML(vehicle.direction || 'Sentido/destino no indicado')}</div>
            </div>
            <div class="vehicle-meta">
              <div><strong>${escapeHTML(vehicle.idType)}</strong><br>${escapeHTML(vehicle.id)}</div>
              <div><strong>Línea</strong><br>${escapeHTML(vehicle.line)}${vehicle.lineRef && vehicle.lineRef !== vehicle.line ? ' · ref. ' + escapeHTML(vehicle.lineRef) : ''}</div>
              <div><strong>Última posición comunicada</strong><br>${escapeHTML(formatTime(vehicle.time))}</div>
              ${vehicle.stop && typeof vehicle.stop === 'string' ? `<div><strong>Referencia de parada</strong><br>${escapeHTML(vehicle.stop)}</div>` : ''}
            </div>
          </article>`).join('')}
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
  if (xml.getElementsByTagName('parsererror').length || !xml.documentElement) {
    throw new Error('Respuesta XML no válida');
  }
  const hasActivities = elements(xml, 'VehicleActivity').length > 0;
  const isSiriResponse = /Siri|VehicleMonitoringDelivery|VehicleActivity/i.test(
    xml.documentElement.nodeName + ' ' + body.slice(0, 1000)
  );
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
      console.warn('No se pudo leer directamente el feed SIRI; se probará una ruta alternativa.', directError);
      xml = await fetchFeed(PROXY_FEED);
      usedProxy = true;
    }

    vehicles = parse(xml);
    lastSuccessfulUpdate = new Date();
    render();
    $('lastUpdated').textContent = 'Actualizado a las ' + lastSuccessfulUpdate.toLocaleTimeString('es-ES');
    setStatus((usedProxy ? 'Conectado mediante alternativa' : 'Feed actualizado') + ' · ' + vehicles.length + ' registros', 'ok');
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
