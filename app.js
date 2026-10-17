const FEED='https://ctb-siri.s3.eu-south-2.amazonaws.com/bizkaibus-vehicle-positions.xml';
const REFRESH_MS=30000;
const map=L.map('map').setView([43.25,-2.93],11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const markers=new Map();let vehicles=[];let selectedLine='';
const $=id=>document.getElementById(id);

function text(el,name){const n=el.getElementsByTagNameNS('*',name)[0];return n?n.textContent.trim():''}
function parse(xml){
  return [...xml.getElementsByTagNameNS('*','VehicleActivity')].map(a=>{
    const j=a.getElementsByTagNameNS('*','MonitoredVehicleJourney')[0];
    if(!j)return null;
    const loc=j.getElementsByTagNameNS('*','VehicleLocation')[0];
    if(!loc)return null;
    const lat=Number(text(loc,'Latitude')),lon=Number(text(loc,'Longitude'));
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
    return {id:text(j,'VehicleRef')||'?',line:text(j,'LineRef')||text(j,'PublishedLineName')||'Sin línea',direction:text(j,'DirectionName')||text(j,'DestinationName')||'',time:text(a,'RecordedAtTime')||text(j,'LocationRecordedAtTime'),stop:text(j,'StopPointRef')||'',lat,lon};
  }).filter(Boolean);
}
function popup(v){return `<b>Vehículo ${esc(v.id)}</b><br>Línea: <b>${esc(v.line)}</b>${v.direction?`<br>Destino/sentido: ${esc(v.direction)}`:''}<br><span class="muted">${esc(v.time||'Hora no disponible')}</span>`}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(){
  $('vehicleCount').textContent=vehicles.length;
  const groups={};vehicles.forEach(v=>(groups[v.line]??=[]).push(v));
  const lines=Object.keys(groups).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  $('lineCount').textContent=lines.length;
  const q=$('search').value.trim().toLowerCase();
  $('lines').innerHTML='';
  const visible=lines.filter(line=>!q||line.toLowerCase().includes(q)||groups[line].some(v=>v.id.toLowerCase().includes(q)));
  if(!visible.length){$('lines').innerHTML='<div class="empty">No hay coincidencias.</div>';return}
  visible.forEach(line=>{
    const vs=groups[line].filter(v=>!q||line.toLowerCase().includes(q)||v.id.toLowerCase().includes(q));
    const el=document.createElement('div');el.className='line'+(selectedLine===line?' active':'');
    el.innerHTML=`<button><span class="line-name">${esc(line)}</span><span class="badge">${vs.length}</span></button><div class="vehicles">${vs.map(v=>`<div class="vehicle" data-id="${esc(v.id)}"><span>🚌 ${esc(v.id)}</span><span class="muted">${esc(v.direction||'')}</span></div>`).join('')}</div>`;
    el.querySelector('button').onclick=()=>{selectedLine=selectedLine===line?'':line;render();if(selectedLine)fitLine(groups[selectedLine]);};
    el.querySelectorAll('.vehicle').forEach(x=>x.onclick=()=>focusVehicle(x.dataset.id));
    $('lines').appendChild(el);
  });
}
function fitLine(vs){if(!vs.length)return;map.fitBounds(L.latLngBounds(vs.map(v=>[v.lat,v.lon])),{padding:[40,40]})}
function focusVehicle(id){const v=vehicles.find(x=>x.id===id),m=markers.get(id);if(!v||!m)return;map.setView([v.lat,v.lon],15);m.openPopup();openModal(v)}
function openModal(v){$('modalVehicle').textContent=v.id;$('modalLine').textContent=v.line;$('modalDirection').textContent=v.direction||'—';$('modalTime').textContent=v.time?new Date(v.time).toLocaleString('es-ES'):'—';$('modalStop').textContent=v.stop||'—';$('vehicleModal').classList.remove('hidden')}
function updateMarkers(){
  const active=new Set(vehicles.map(v=>v.id));
  markers.forEach((m,id)=>{if(!active.has(id)){map.removeLayer(m);markers.delete(id)}});
  vehicles.forEach(v=>{let m=markers.get(v.id);if(!m){m=L.circleMarker([v.lat,v.lon],{radius:7,weight:2,fillOpacity:.9}).addTo(map);m.on('click',()=>openModal(v));markers.set(v.id,m)}else m.setLatLng([v.lat,v.lon]);m.bindPopup(popup(v));});
}
async function load(){
  $('statusText').textContent='Actualizando…';
  try{
    const r=await fetch(FEED+'?t='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
    const xml=new DOMParser().parseFromString(await r.text(),'application/xml');
    if(xml.getElementsByTagName('parsererror').length)throw Error('XML inválido');
    vehicles=parse(xml);updateMarkers();render();$('statusText').textContent='En directo · '+new Date().toLocaleTimeString('es-ES');$('dot').style.background='#1a9b55';
  }catch(e){console.error(e);$('statusText').textContent='Error de conexión / CORS';$('dot').style.background='#d64545';if(!vehicles.length)$('lines').innerHTML='<div class="empty">No se pudo leer el feed SIRI directamente desde el navegador. Si el servidor bloquea CORS, añadiremos un proxy automático en GitHub Actions.</div>'}
}
$('refresh').onclick=load;$('search').oninput=render;$('closeModal').onclick=()=>$('vehicleModal').classList.add('hidden');$('vehicleModal').onclick=e=>{if(e.target.id==='vehicleModal')$('vehicleModal').classList.add('hidden')};
load();setInterval(load,REFRESH_MS);