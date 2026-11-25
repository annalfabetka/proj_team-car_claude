(function () {
  'use strict';

  const STORE = 'spolujizdy.v1';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OSRM = 'https://router.project-osrm.org';
  const COLORS = ['#1d6fe0', '#d9480f', '#2b8a3e', '#9c36b5', '#c2255c', '#0b7285', '#a07800', '#495057'];
  const STATUS = [
    ['no', 'Nejede'],
    ['pass', 'Jede'],
    ['can', 'Může řídit'],
    ['must', 'Musí řídit'],
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);

  // ---------- stav a ukládání ----------
  let state = load();

  function defaults() {
    return {
      people: [],
      hall: { address: '', lat: null, lon: null, label: '', fail: false },
      arrive: '18:00',
      settings: { carPenalty: 20, maxDetour: 20, stopMin: 2 },
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaults();
        return Object.assign(d, s, {
          hall: Object.assign(d.hall, s.hall), settings: Object.assign(d.settings, s.settings),
        });
      }
    } catch (e) { /* prohlížeč bez úložiště – jedeme bez ukládání */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignoruj */ }
  }

  // ---------- geokódování (Nominatim, max. 1 dotaz/s) ----------
  const geoQueue = [];
  let geoRunning = false;
  function geocode(target, after) {
    if (!target.address.trim()) { target.lat = null; target.lon = null; target.label = ''; target.fail = false; after(); return; }
    target.lat = target.lon = null; target.fail = false; target.pending = true;
    after();
    geoQueue.push({ target, after });
    if (!geoRunning) runGeo();
  }
  async function runGeo() {
    geoRunning = true;
    while (geoQueue.length) {
      const { target, after } = geoQueue.shift();
      const query = target.address.trim();
      try {
        const url = `${NOMINATIM}?format=json&limit=1&accept-language=cs&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (target.address.trim() !== query) continue; // mezitím změněno
        if (data.length) {
          target.lat = parseFloat(data[0].lat); target.lon = parseFloat(data[0].lon);
          target.label = data[0].display_name; target.fail = false;
        } else { target.fail = true; target.label = ''; }
      } catch (e) { target.fail = true; target.label = 'Služba pro vyhledání adres je nedostupná'; }
      target.pending = false;
      save(); after();
      if (geoQueue.length) await new Promise(r => setTimeout(r, 1100));
    }
    geoRunning = false;
  }
  function geoHtml(t) {
    if (t.pending) return '<span class="geo wait">hledám…</span>';
    if (t.lat != null) return `<span class="geo ok" title="${esc(t.label)}">✓ nalezeno</span>`;
    if (t.fail) return `<span class="geo bad" title="${esc(t.label || '')}">✗ nenalezeno</span>`;
    return '<span class="geo wait">–</span>';
  }

  // ---------- soupiska ----------
  function renderRoster() {
    const body = $('roster');
    body.innerHTML = state.people.map(p => `
      <tr data-id="${p.id}">
        <td><input type="text" data-f="name" value="${esc(p.name)}" placeholder="Jméno" aria-label="Jméno"></td>
        <td><input type="text" data-f="address" value="${esc(p.address)}" placeholder="Ulice 12, Město" aria-label="Adresa"></td>
        <td data-geo>${geoHtml(p)}</td>
        <td data-label="Auto"><input type="checkbox" data-f="hasCar" ${p.hasCar ? 'checked' : ''} aria-label="Má auto"></td>
        <td data-label="Míst (s řidičkou)"><input type="number" data-f="seats" min="2" max="9" value="${p.seats}" ${p.hasCar ? '' : 'disabled'} aria-label="Míst v autě"></td>
        <td data-label="Dnes"><select data-f="status" aria-label="Dnes">${STATUS.map(([v, l]) =>
          `<option value="${v}" ${p.status === v ? 'selected' : ''} ${(v === 'can' || v === 'must') && !p.hasCar ? 'disabled' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><button class="link" data-act="del" title="Odebrat">✕</button></td>
      </tr>`).join('') ||
      '<tr><td colspan="7" class="small">Zatím nikdo. Přidejte první hráčku.</td></tr>';
  }
  function updateGeoCell(p) {
    const cell = document.querySelector(`tr[data-id="${p.id}"] [data-geo]`);
    if (cell) cell.innerHTML = geoHtml(p);
  }
  function addPerson(init) {
    const p = Object.assign({
      id: uid(), name: '', address: '', lat: null, lon: null, label: '', fail: false,
      hasCar: false, seats: 4, status: 'pass',
    }, init);
    state.people.push(p);
    save(); renderRoster();
    return p;
  }

  $('roster').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const p = state.people.find(x => x.id === tr.dataset.id);
    const f = e.target.dataset.f;
    if (f === 'name') p.name = e.target.value;
    else if (f === 'address') { p.address = e.target.value; geocode(p, () => updateGeoCell(p)); }
    else if (f === 'seats') p.seats = Math.max(2, Math.min(9, parseInt(e.target.value, 10) || 4));
    else if (f === 'status') p.status = e.target.value;
    else if (f === 'hasCar') {
      p.hasCar = e.target.checked;
      if (p.hasCar && p.status === 'pass') p.status = 'can';
      if (!p.hasCar && (p.status === 'can' || p.status === 'must')) p.status = 'pass';
      renderRoster();
    }
    save();
  });
  $('roster').addEventListener('click', e => {
    if (e.target.dataset.act !== 'del') return;
    const id = e.target.closest('tr').dataset.id;
    const p = state.people.find(x => x.id === id);
    if (p && (p.name || p.address) && !confirm(`Odebrat ${p.name || 'tuto hráčku'}?`)) return;
    state.people = state.people.filter(x => x.id !== id);
    save(); renderRoster();
  });
  $('add').addEventListener('click', () => {
    addPerson();
    const inputs = $('roster').querySelectorAll('input[data-f="name"]');
    inputs[inputs.length - 1].focus();
  });
  $('geoAll').addEventListener('click', () => {
    state.people.forEach(p => { if (p.address.trim() && p.lat == null) geocode(p, () => updateGeoCell(p)); });
    if (state.hall.address.trim() && state.hall.lat == null) geocode(state.hall, renderHallStatus);
  });

  // ---------- zápas a nastavení ----------
  function renderHallStatus() { $('hallStatus').innerHTML = state.hall.address ? geoHtml(state.hall) : ''; }
  $('hall').value = state.hall.address;
  $('arrive').value = state.arrive;
  $('hall').addEventListener('change', e => {
    state.hall.address = e.target.value; geocode(state.hall, renderHallStatus); save();
  });
  $('arrive').addEventListener('change', e => { state.arrive = e.target.value; save(); });
  ['carPenalty', 'maxDetour', 'stopMin'].forEach(k => {
    $(k).value = state.settings[k];
    $(k).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      state.settings[k] = isNaN(v) ? Planner.DEFAULTS[k] : Math.max(0, v);
      save();
    });
  });

  // ---------- routování ----------
  async function osrmMatrix(points) {
    const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
    const res = await fetch(`${OSRM}/table/v1/driving/${coords}?annotations=duration`);
    const data = await res.json();
    if (data.code !== 'Ok' || data.durations.some(r => r.some(v => v == null))) throw new Error('osrm');
    return data.durations.map(r => r.map(s => s / 60));
  }
  async function osrmGeometry(points) {
    const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
    const res = await fetch(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('osrm');
    return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  }

  // ---------- plánování ----------
  const fmtTime = mins => {
    const m = ((Math.round(mins) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };
  const nameOf = p => p.name.trim() || '(bez jména)';

  function notice(kind, text) {
    const d = document.createElement('div');
    d.className = 'notice ' + kind; d.textContent = text;
    $('notices').appendChild(d);
  }

  let lastPlan = null;
  $('plan').addEventListener('click', async () => {
    $('notices').innerHTML = '';
    const attendees = state.people.filter(p => p.status !== 'no');
    if (attendees.length < 2) return notice('bad', 'Označte aspoň dvě hráčky, které jedou.');
    if (state.hall.lat == null) return notice('bad', 'Adresa haly zatím nebyla nalezena. Zkontrolujte ji.');
    const missing = attendees.filter(p => p.lat == null);
    if (missing.length) return notice('bad', 'Chybí nalezená adresa u: ' + missing.map(nameOf).join(', ') + '.');

    $('plan').disabled = true; $('planStatus').textContent = 'Počítám trasy…';
    const points = attendees.map(p => ({ lat: p.lat, lon: p.lon })).concat({ lat: state.hall.lat, lon: state.hall.lon });
    let dur, estimated = false;
    try { dur = await osrmMatrix(points); }
    catch (e) { dur = Planner.fallbackMatrix(points); estimated = true; }

    const people = attendees.map(p => ({
      canDrive: p.hasCar && (p.status === 'can' || p.status === 'must'),
      mustDrive: p.status === 'must', seats: p.seats,
    }));
    const result = Planner.plan({ dur, people, options: state.settings });
    $('plan').disabled = false; $('planStatus').textContent = '';

    if (result.error === 'NO_DRIVERS') return notice('bad', 'Nikdo nemůže řídit. Označte aspoň jednu hráčku s autem jako „Může řídit“.');
    if (result.error === 'NOT_ENOUGH_SEATS') return notice('bad', `Nedostatek míst v autech: chybí aspoň ${result.missing}. Přidejte další řidičku nebo zvyšte počet míst.`);
    if (estimated) notice('warn', 'Veřejný routovací server není dostupný, časy jsou odhadnuté vzdušnou čarou. Skutečné časy se mohou lišit.');

    lastPlan = { result, attendees };
    await renderResult(result, attendees, estimated);
  });

  async function renderResult(result, attendees, estimated) {
    const arrive = (() => { const [h, m] = state.arrive.split(':').map(Number); return h * 60 + m; })();
    const hallName = state.hall.address.trim();
    const lines = [`Zápas – sraz v hale ${state.arrive}${hallName ? ' (' + hallName + ')' : ''}`, ''];
    let html = `<p class="small" style="margin-top:0">${result.carCount} ${result.carCount === 1 ? 'auto' : result.carCount < 5 ? 'auta' : 'aut'}, celkem ${Math.round(result.totalDrivingMin)} minut jízdy${estimated ? ' (odhad)' : ''}.</p>`;

    result.cars.forEach((car, i) => {
      const driver = attendees[car.driver];
      const depart = arrive - Math.ceil(car.totalMin);
      const color = COLORS[i % COLORS.length];
      const stops = car.timeline.map((s, k) => {
        const when = fmtTime(depart + s.t);
        if (k === 0) return { t: when, text: `<b>${esc(nameOf(driver))}</b> vyjíždí z domu`, msg: `${nameOf(driver)} vyjíždí v ${when}` };
        if (k === car.timeline.length - 1) return { t: when, text: 'příjezd do haly', msg: `hala ${when}` };
        const p = attendees[s.node];
        const ride = car.rides[k - 1];
        return {
          t: when, text: `vyzvednout <b>${esc(nameOf(p))}</b> <span class="sub">${esc(p.address)} · v autě ${Math.round(ride.rideMin)} min</span>`,
          msg: `${nameOf(p)} ${when}`,
        };
      });
      html += `<div class="car" style="border-left-color:${color}"><h3>Auto ${i + 1}: ${esc(nameOf(driver))} <span class="sub">(${car.passengers.length + 1} z ${driver.seats} míst)</span></h3><ol>` +
        stops.map(s => `<li><span class="t">${s.t}</span><span>${s.text}</span></li>`).join('') + '</ol></div>';
      lines.push(`🚗 ${stops.map(s => s.msg).join(' → ')}`);
    });

    $('result').innerHTML = html;
    $('msg').value = lines.join('\n');
    $('resultSec').hidden = false;
    $('resultSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await renderMap(result, attendees);
  }

  // ---------- mapa ----------
  let map = null, mapLayer = null;
  async function renderMap(result, attendees) {
    if (typeof L === 'undefined') { $('map').hidden = true; return; }
    $('map').hidden = false;
    if (!map) {
      map = L.map('map');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© přispěvatelé OpenStreetMap',
      }).addTo(map);
    }
    if (mapLayer) mapLayer.remove();
    mapLayer = L.featureGroup().addTo(map);
    const hall = { lat: state.hall.lat, lon: state.hall.lon };

    L.marker([hall.lat, hall.lon], {
      icon: L.divIcon({ className: '', html: '<div style="background:#111;color:#fff;border-radius:6px;padding:2px 6px;font:600 12px system-ui;white-space:nowrap">Hala</div>', iconAnchor: [-8, 10] }),
    }).addTo(mapLayer);

    await Promise.all(result.cars.map(async (car, i) => {
      const color = COLORS[i % COLORS.length];
      const pts = car.timeline.map(s => s.node === attendees.length ? hall : attendees[s.node]);
      let line;
      try { line = await osrmGeometry(pts); } catch (e) { line = pts.map(p => [p.lat, p.lon]); }
      L.polyline(line, { color, weight: 4, opacity: .85 }).addTo(mapLayer);
      car.timeline.slice(0, -1).forEach((s, k) => {
        const p = attendees[s.node];
        L.circleMarker([p.lat, p.lon], {
          radius: k === 0 ? 9 : 6, color, fillColor: k === 0 ? color : '#fff', fillOpacity: 1, weight: 3,
        }).bindTooltip(`${nameOf(p)}${k === 0 ? ' (řidička)' : ''}`, { permanent: false }).addTo(mapLayer);
      });
    }));
    map.invalidateSize();
    map.fitBounds(mapLayer.getBounds().pad(0.1));
  }

  // ---------- kopírování, záloha ----------
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('msg').value); $('copyStatus').textContent = 'Zkopírováno.'; }
    catch (e) { $('msg').parentElement.open = true; $('msg').select(); $('copyStatus').textContent = 'Text označte a zkopírujte ručně.'; }
    setTimeout(() => { $('copyStatus').textContent = ''; }, 3000);
  });
  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'spolujizdy-soupiska.json'; a.click();
    URL.revokeObjectURL(a.href);
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!Array.isArray(s.people)) throw new Error('bad');
      if (state.people.length && !confirm('Nahrání soubor přepíše současnou soupisku. Pokračovat?')) return;
      const d = defaults();
      state = Object.assign(d, s, { hall: Object.assign(d.hall, s.hall), settings: Object.assign(d.settings, s.settings) });
      save(); location.reload();
    } catch (err) { alert('Soubor se nepodařilo načíst. Je to soubor exportovaný z této aplikace?'); }
  });

  // ---------- start ----------
  if (!state.people.length) {
    addPerson(); addPerson(); addPerson(); // prázdné řádky na rozjezd
  } else renderRoster();
  renderHallStatus();
})();
