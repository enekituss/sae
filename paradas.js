const $ = id => document.getElementById(id);
let allStops = [];
let filteredStops = [];
let loading = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function normalized(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
}

function setStatus(message, state) {
  $('statusText').textContent = message;
  $('dot').className = 'status-dot' + (state ? ' ' + state : '');
}

function renderStops() {
  const query = normalized($('stopSearch').value);
  filteredStops = allStops.filter(stop =>
    !query || [stop.id, stop.name, stop.municipality].some(v => normalized(v).includes(query))
  );
  $('stopCount').textContent = allStops.length.toLocaleString('es-ES');
  $('summaryTitle').textContent = query
    ? 'Resultados de búsqueda'
    : 'Paradas Bizkaibus';
  $('stopResults').innerHTML = '';

  if (!filteredStops.length) {
    $('stopResults').innerHTML = '<div class="message">No se han encontrado paradas con ese término.</div>';
    return;
  }

  const limit = 400;
  const toRender = filteredStops.slice(0, limit);
  const fragment = document.createDocumentFragment();
  for (const stop of toRender) {
    const item = document.createElement('article');
    item.className = 'stop-result';
    const coords = Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon)) &&
      stop.lat !== '' && stop.lon !== '';
    const mapLink = coords
      ? '<a class="stop-map-link" target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/?mlat=' +
        encodeURIComponent(stop.lat) + '&mlon=' + encodeURIComponent(stop.lon) + '#map=18/' +
        encodeURIComponent(stop.lat) + '/' + encodeURIComponent(stop.lon) + '">Ver mapa ↗</a>'
      : '';
    item.innerHTML = `
      <div class="stop-result-main">
        <div class="stop-result-name">${esc(stop.name || 'Parada sin nombre en el directorio')}</div>
        <div class="stop-result-meta">${stop.municipality ? esc(stop.municipality) + ' · ' : ''}Identificador SIRI/GTFS: ${esc(stop.id)}</div>
      </div>
      <span class="stop-result-id">ID ${esc(stop.id)}</span>
      ${mapLink}`;
    fragment.appendChild(item);
  }
  $('stopResults').appendChild(fragment);

  if (filteredStops.length > limit) {
    const note = document.createElement('div');
    note.className = 'directory-status';
    note.textContent = 'Se muestran las primeras ' + limit + ' de ' + filteredStops.length.toLocaleString('es-ES') +
      ' coincidencias. Escribe un municipio, nombre o ID para afinar la búsqueda.';
    $('stopResults').appendChild(note);
  }
}

async function loadStops() {
  if (loading) return;
  loading = true;
  $('stopReload').disabled = true;
  $('stopReload').textContent = 'Cargando…';
  setStatus('Leyendo directorio…', '');
  try {
    const url = new URL('./stops.json', window.location.href);
    url.searchParams.set('_', String(Date.now()));
    const response = await fetch(url.toString(), { cache: 'no-store' });
    if (!response.ok) throw new Error('stops.json respondió HTTP ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data.stops)) throw new Error('El directorio no tiene el formato esperado');

    allStops = data.stops.map(s => ({
      id: String(s.id ?? s.stop_id ?? ''),
      name: String(s.name ?? s.stop_name ?? ''),
      lat: s.lat ?? s.stop_lat ?? '',
      lon: s.lon ?? s.stop_lon ?? '',
      municipality: String(s.municipality ?? '')
    })).filter(s => s.id && s.name)
     .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));

    $('stopUpdated').textContent = data.fetchedAt
      ? 'Directorio actualizado: ' + new Date(data.fetchedAt).toLocaleDateString('es-ES')
      : 'Fecha de actualización no indicada';
    setStatus('Directorio cargado · ' + allStops.length.toLocaleString('es-ES') + ' paradas', allStops.length ? 'ok' : 'error');

    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id && !$('stopSearch').value) $('stopSearch').value = id;
    renderStops();
  } catch (error) {
    console.error('No se pudo cargar el directorio de paradas:', error);
    setStatus('No se ha podido cargar el directorio', 'error');
    $('stopResults').innerHTML = `
      <div class="message error">
        <strong>El directorio de paradas todavía no está publicado o no se ha podido leer.</strong><br>
        ${esc(error.message)}
        <br><br><a href="https://github.com/enekituss/sae/actions" target="_blank" rel="noopener noreferrer">Comprobar la actualización de datos</a>
      </div>`;
  } finally {
    loading = false;
    $('stopReload').disabled = false;
    $('stopReload').textContent = '↻ Actualizar';
  }
}

$('stopSearch').addEventListener('input', renderStops);
$('stopReload').addEventListener('click', loadStops);
loadStops();
