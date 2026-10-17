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
      [v.id, v.idType, v.lineRef, v.direction, v.stop, v.journeyRef]
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
              <div><strong>${escapeHTML(vehicle.idType || 'ID de vehículo')}</strong><br>${escapeHTML(vehicle.id)}</div>
              <div><strong>Línea</strong><br>${escapeHTML(vehicle.line || line)}${vehicle.lineRef && vehicle.lineRef !== vehicle.line ? ' · ref. ' + escapeHTML(vehicle.lineRef) : ''}</div>
              <div><strong>Última posición comunicada</strong><br>${escapeHTML(formatTime(vehicle.time))}</div>
              ${vehicle.stop ? `<div><strong>Referencia de parada</strong><br>${escapeHTML(vehicle.stop)}</div>` : ''}
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

// La web está alojada en GitHub Pages, por lo que el navegador no puede leer
// necesariamente el XML de otro dominio (CORS). El flujo de GitHub Actions
// consulta SIRI del lado del servidor y publica esta copia JSON en el mismo sitio.
async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(DATA_FILE, window.location.href);
    url.searchParams.set('_', String(Date.now()));
    const response = await fetch(url.toString(), {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error('vehicles.json respondió HTTP ' + response.status);
    const data = await response.json();
    if (!data || !Array.isArray(data.vehicles)) {
      throw new Error('El fichero de datos no tiene el formato esperado');
    }
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
  setStatus('Leyendo datos publicados…', '');

  try {
    const snapshot = await fetchSnapshot();
    vehicles = snapshot.vehicles.map(v => ({
      id: String(v.id || 'ID no publicado'),
      idType: String(v.idType || 'ID de vehículo'),
      line: String(v.line || 'Sin línea identificada'),
      lineRef: String(v.lineRef || ''),
      direction: String(v.direction || ''),
      time: String(v.time || ''),
      stop: String(v.stop || ''),
      journeyRef: String(v.journeyRef || ''),
      lat: v.lat ?? '',
      lon: v.lon ?? ''
    }));

    const fetchedAt = snapshot.fetchedAt ? new Date(snapshot.fetchedAt) : null;
    lastSuccessfulUpdate = fetchedAt && !Number.isNaN(fetchedAt.getTime()) ? fetchedAt : null;
    render();

    if (!lastSuccessfulUpdate) {
      $('lastUpdated').textContent = 'A la espera de la primera descarga SIRI';
      setStatus('Pendiente de la primera consulta SIRI', '');
    } else {
      const ageMinutes = Math.max(0, Math.round((Date.now() - lastSuccessfulUpdate.getTime()) / 60000));
      $('lastUpdated').textContent = 'SIRI consultado: ' + lastSuccessfulUpdate.toLocaleTimeString('es-ES') +
        ' · ' + lastSuccessfulUpdate.toLocaleDateString('es-ES');
      if (ageMinutes >= 15) {
        setStatus('Copia de datos antigua · hace ' + ageMinutes + ' min', 'error');
      } else {
        setStatus('Datos disponibles · ' + vehicles.length + ' registros', 'ok');
      }
    }
  } catch (error) {
    console.error('No se pudo leer la copia de datos de Bizkaibus:', error);
    setStatus('No se han podido leer los datos', 'error');
    $('lines').innerHTML = `
      <div class="message error">
        <strong>No se ha podido leer la copia de datos publicada.</strong><br>
        Comprueba que GitHub Pages esté actualizado y que la tarea de actualización SIRI haya terminado.
        <br><br><span>${escapeHTML(error.message)}</span>
        <br><br><a href="https://github.com/enekituss/sae/actions" target="_blank" rel="noopener noreferrer">Abrir el estado de la actualización SIRI</a>
        <br><br><a href="${FEED}" target="_blank" rel="noopener noreferrer">Abrir el feed oficial SIRI</a>
      </div>`;
    $('vehicleCount').textContent = '—';
    $('lineCount').textContent = '—';
    $('lastUpdated').textContent = 'Sin datos';
  } finally {
    updateRunning = false;
    $('refresh').disabled = false;
    $('refresh').innerHTML = '<span aria-hidden="true">↻</span> Actualizar';
  }
}

$('refresh').addEventListener('click', load);
$('search').addEventListener('input', render);
load();
setInterval(load, REFRESH_MS);
