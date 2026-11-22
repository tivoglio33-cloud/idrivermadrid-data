// ------------------------------------------------------------------
// DATOS DE CADA NOCHE DE iDriverMadrid (22/11/2026)
//
// Lo lanza GitHub cada noche desde el repo idrivermadrid-data
// (.github/workflows/datos-emt.yml). Pregunta a
// la EMT (MobilityLabs) por todas sus líneas, el recorrido de cada una y sus
// paradas, y lo deja en la carpeta "salida" con el MISMO formato que usaba
// iDriverBCN, para que la app lo lea igual:
//
//   salida/routes_shapes.gtfsdata      recorridos de todas las líneas
//   salida/web/lineas.json             lista de líneas (para el selector)
//   salida/web/parades/<código>.json   paradas de cada línea, por sentido
//   salida/web/paradas_todas.json      todas las paradas de la red (puntos grises)
//   salida/resumen.json                cuántas líneas han salido bien y cuáles no
//
// Gasto de cuota: 1 login + 1 lista + 3 por línea (recorrido + 2 sentidos)
// ≈ 700 peticiones de las 20.000 diarias.
//
// Necesita los secretos EMT_EMAIL y EMT_PASSWORD (la cuenta de MobilityLabs).
// Si algo sale muy mal (menos de 100 líneas), termina con error y NO se
// sube nada: la app se queda con los datos de la noche anterior.
// ------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BASE = 'https://openapi.emtmadrid.es';
// Dónde se dejan los archivos (la tarea de GitHub lo pone fuera del repo).
const SALIDA = process.env.SALIDA_DIR || path.join(__dirname, '..', 'salida');
const MIN_LINEAS_OK = 100;
const PAUSA_MS = 120; // un respiro entre peticiones para no agobiar a la EMT

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const redondear = (x) => Math.round(Number(x) * 1e5) / 1e5;
const normLinea = (s) => String(s ?? '').trim().replace(/^0+(?=\w)/, '').toUpperCase();

function fechaMadrid() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const v = (t) => p.find((x) => x.type === t).value;
  return v('year') + v('month') + v('day');
}

let token = null;

async function login() {
  const email = process.env.EMT_EMAIL, password = process.env.EMT_PASSWORD;
  if (!email || !password) throw new Error('Faltan los secretos EMT_EMAIL / EMT_PASSWORD');
  const r = await fetch(BASE + '/v1/mobilitylabs/user/login/', { headers: { email, password } });
  const j = await r.json();
  token = j?.data?.[0]?.accessToken;
  if (!token) throw new Error('Login EMT fallido: ' + JSON.stringify(j).slice(0, 300));
  console.log('Login EMT correcto');
}

async function pedir(ruta, intentos = 3) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      await esperar(PAUSA_MS * (i + 1));
      const r = await fetch(BASE + ruta, { headers: { accessToken: token } });
      const j = await r.json();
      if (j && (j.code === '00' || j.code === '01' || j.data)) return j;
      ultimo = new Error('Respuesta rara: ' + JSON.stringify(j).slice(0, 200));
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo;
}

// ---------- lista de líneas ----------
function buscarLineas(obj, salida) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((x) => buscarLineas(x, salida)); return; }
  if (obj.line != null && (obj.label != null || obj.nameA != null)) {
    const codigo = normLinea(obj.line);
    if (codigo && !salida.has(codigo)) {
      salida.set(codigo, {
        codigo,
        nombre: normLinea(obj.label ?? obj.line),
        nombreA: String(obj.nameA ?? obj.headerA ?? '').trim(),
        nombreB: String(obj.nameB ?? obj.headerB ?? '').trim(),
        grupo: String(obj.group ?? ''),
      });
    }
  }
  for (const k in obj) if (obj[k] && typeof obj[k] === 'object') buscarLineas(obj[k], salida);
}

async function listaLineas() {
  const hoy = fechaMadrid();
  const lineas = new Map();
  for (const ruta of [`/v1/transport/busemtmad/lines/info/${hoy}/`, '/v1/transport/busemtmad/lines/info/', `/v2/transport/busemtmad/lines/info/${hoy}/`]) {
    try {
      const j = await pedir(ruta, 2);
      buscarLineas(j?.data, lineas);
      if (lineas.size > 0) { console.log(`Lista de líneas: ${lineas.size} (de ${ruta})`); break; }
    } catch (e) {
      console.log('No va ' + ruta + ': ' + e.message);
    }
  }
  return [...lineas.values()];
}

// ---------- recorrido ----------
function coordsDe(fc) {
  const puntos = [];
  for (const f of fc?.features ?? []) {
    const g = f?.geometry;
    if (!g) continue;
    const tramos = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const tramo of tramos) {
      for (const c of tramo ?? []) {
        if (!Array.isArray(c) || typeof c[0] !== 'number') continue;
        const p = [redondear(c[1]), redondear(c[0])]; // [lat, lng] como en iDriverBCN
        const u = puntos[puntos.length - 1];
        if (!u || u[0] !== p[0] || u[1] !== p[1]) puntos.push(p);
      }
    }
  }
  return puntos;
}

// ---------- paradas ----------
function buscarParadas(obj, salida) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((x) => buscarParadas(x, salida)); return; }
  const id = obj.stop ?? obj.stopId ?? obj.node ?? obj.idStop;
  let lon = null, lat = null;
  if (obj.geometry && Array.isArray(obj.geometry.coordinates) && typeof obj.geometry.coordinates[0] === 'number') {
    [lon, lat] = obj.geometry.coordinates;
  } else if (obj.longitude != null && obj.latitude != null) {
    lon = Number(obj.longitude); lat = Number(obj.latitude);
  }
  if (id != null && lon != null && lat != null && !isNaN(lon) && !isNaN(lat) && /^\d+$/.test(String(id))) {
    if (!salida.some((p) => p.id === String(id))) {
      salida.push({ id: String(id), nombre: String(obj.name ?? obj.stopName ?? '').trim(), lon: redondear(lon), lat: redondear(lat) });
    }
  }
  for (const k in obj) if (obj[k] && typeof obj[k] === 'object') buscarParadas(obj[k], salida);
}

async function paradasSentido(codigo, sentido) {
  const j = await pedir(`/v1/transport/busemtmad/lines/${encodeURIComponent(codigo)}/stops/${sentido}/`);
  const lista = [];
  buscarParadas(j?.data, lista);
  return lista;
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * 0.76) ** 2;

async function procesarLinea(l) {
  const jr = await pedir(`/v1/transport/busemtmad/lines/${encodeURIComponent(l.codigo)}/route/`);
  const d = jr?.data ?? {};
  const it = d.itinerary ?? {};
  const nombre = normLinea(d.label ?? l.nombre);
  const nombreA = String(d.nameSectionA ?? l.nombreA ?? '').trim();
  const nombreB = String(d.nameSectionB ?? l.nombreB ?? '').trim();
  const haciaB = coordsDe(it.toB); // va de A hacia B
  const haciaA = coordsDe(it.toA); // va de B hacia A

  const s1 = await paradasSentido(l.codigo, 1);
  const s2 = await paradasSentido(l.codigo, 2);

  // ¿El sentido 1 de las paradas es el trazado "hacia B"? Se comprueba por
  // dónde empieza: la primera parada del sentido 1 tiene que estar cerca
  // del principio de su trazado. Así no dependemos de suponerlo.
  let ida = haciaB, vuelta = haciaA, destIda = nombreB, destVuelta = nombreA;
  if (s1.length && haciaB.length && haciaA.length) {
    const p = [s1[0].lat, s1[0].lon];
    if (dist2(p, haciaA[0]) < dist2(p, haciaB[0])) {
      ida = haciaA; vuelta = haciaB; destIda = nombreA; destVuelta = nombreB;
    }
  }
  if (!ida.length && !vuelta.length) throw new Error('sin recorrido');

  const variante = {
    headsign: [nombreA, nombreB].filter(Boolean).join(' - '),
    ida: ida.length >= 2 ? ida : null,
    vuelta: vuelta.length >= 2 ? vuelta : null,
  };

  const features = [];
  const meter = (lista, sentido, destino) => lista.forEach((p, i) => features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { CODI_PARADA: Number(p.id), NOM_PARADA: p.nombre, ORDRE: i + 1, ID_SENTIT: sentido, DESTI_SENTIT: destino },
  }));
  meter(s1, 1, destIda);
  meter(s2, 2, destVuelta);

  return { nombre, nombreA, nombreB, variante, features, s1, s2 };
}

async function main() {
  await login();
  const lineas = await listaLineas();
  if (lineas.length === 0) throw new Error('La EMT no ha dado la lista de líneas');

  const shapes = {};
  const lineasJson = [];
  const todas = new Map(); // id -> [id, nombre, lon, lat, Set(lineas)]
  const fallidas = [];
  fs.mkdirSync(path.join(SALIDA, 'web', 'parades'), { recursive: true });

  for (const l of lineas) {
    try {
      const r = await procesarLinea(l);
      shapes[r.nombre] = { variantes: [r.variante] };
      lineasJson.push({
        type: 'Feature',
        geometry: null,
        properties: {
          CODI_LINIA: l.codigo, NOM_LINIA: r.nombre,
          DESC_LINIA: [r.nombreA, r.nombreB].filter(Boolean).join(' - '),
          ORIGEN_LINIA: r.nombreA, DESTI_LINIA: r.nombreB, GRUPO_EMT: l.grupo,
        },
      });
      fs.writeFileSync(path.join(SALIDA, 'web', 'parades', l.codigo + '.json'), JSON.stringify({ type: 'FeatureCollection', features: r.features }));
      for (const p of [...r.s1, ...r.s2]) {
        if (!todas.has(p.id)) todas.set(p.id, [Number(p.id), p.nombre, p.lon, p.lat, new Set()]);
        todas.get(p.id)[4].add(r.nombre);
      }
      console.log(`OK ${r.nombre.padEnd(5)} ida ${r.variante.ida?.length ?? 0} pts, vuelta ${r.variante.vuelta?.length ?? 0} pts, paradas ${r.s1.length}+${r.s2.length}`);
    } catch (e) {
      fallidas.push(l.nombre);
      console.log(`MAL ${l.nombre}: ${e.message}`);
    }
  }

  const buenas = Object.keys(shapes).length;
  console.log(`\nLíneas bien: ${buenas}. Mal: ${fallidas.length} ${fallidas.join(', ')}`);
  if (buenas < MIN_LINEAS_OK) throw new Error(`Solo ${buenas} líneas: no se sube nada (se queda lo de ayer)`);

  const ordenar = (a, b) => a.localeCompare(b, 'es', { numeric: true });
  lineasJson.sort((a, b) => ordenar(a.properties.NOM_LINIA, b.properties.NOM_LINIA));
  fs.writeFileSync(path.join(SALIDA, 'routes_shapes.gtfsdata'), JSON.stringify(shapes));
  fs.writeFileSync(path.join(SALIDA, 'web', 'lineas.json'), JSON.stringify({ type: 'FeatureCollection', features: lineasJson }));
  fs.writeFileSync(path.join(SALIDA, 'web', 'paradas_todas.json'), JSON.stringify(
    [...todas.values()].map(([id, n, lon, lat, ls]) => [id, n, lon, lat, [...ls].sort(ordenar).join(' ')])
  ));
  fs.writeFileSync(path.join(SALIDA, 'resumen.json'), JSON.stringify({
    fecha: new Date().toISOString(), fuente: 'EMT Madrid MobilityLabs', lineas: buenas, fallidas, paradas: todas.size,
  }, null, 1));
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
