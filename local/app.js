/*
 * Local version: a single device, no sharing.
 * The roster is stored in the browser only (localStorage); addresses are looked up via Nominatim.
 */
(function () {
  'use strict';

  const { $, esc, uid, STATUS, DRIVER, geoHtml, setupPlan } = Common;
  const STORE = 'spolujizdy.v1'; // key unchanged from earlier versions so a saved roster is kept
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

  // ---------- state and persistence ----------
  function defaults() {
    return {
      people: [],
      hall: { address: '', lat: null, lon: null, label: '', fail: false },
      arrive: '18:00',
      settings: { carPenalty: 20, maxDetour: 20, maxDriverDetour: 25, stopMin: 2 },
    };
  }
  function merge(s) {
    const d = defaults();
    return Object.assign(d, s, { hall: Object.assign(d.hall, s.hall), settings: Object.assign(d.settings, s.settings) });
  }
  function normPerson(raw) {
    const p = Object.assign({
      id: uid(), name: '', address: '', lat: null, lon: null, label: '', fail: false, seats: 4, status: '',
    }, raw);
    p.seats = Math.max(2, Math.min(9, parseInt(p.seats, 10) || 4));
    p.fail = !!p.fail;
    return p;
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) return merge(JSON.parse(raw));
    } catch (e) { /* browser without storage: carry on without saving */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  let state = load();
  state.people = state.people.map(normPerson);

  // ---------- geocoding (Nominatim, max. 1 request/s) ----------
  const geoQueue = [];
  let geoRunning = false;
  const isHall = t => t === state.hall;
  function geoRefresh(t) { if (isHall(t)) renderHallStatus(); else updateGeoCell(t); }
  function geocode(target) {
    const empty = !target.address.trim();
    target.lat = target.lon = null; target.fail = false; target.label = '';
    target.pending = !empty;
    geoRefresh(target);
    if (empty) { save(); return; }
    geoQueue.push(target);
    if (!geoRunning) runGeo();
  }
  async function runGeo() {
    geoRunning = true;
    while (geoQueue.length) {
      const target = geoQueue.shift();
      const query = target.address.trim();
      try {
        const res = await fetch(`${NOMINATIM}?format=json&limit=1&accept-language=cs&q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (target.address.trim() !== query) continue; // changed in the meantime
        if (data.length) {
          target.lat = parseFloat(data[0].lat); target.lon = parseFloat(data[0].lon);
          target.label = data[0].display_name; target.fail = false;
        } else { target.fail = true; target.label = ''; }
      } catch (e) { target.fail = true; target.label = 'Služba pro vyhledání adres je nedostupná'; }
      target.pending = false;
      save(); geoRefresh(target);
      if (geoQueue.length) await new Promise(r => setTimeout(r, 1100));
    }
    geoRunning = false;
  }

  // ---------- roster ----------
  function renderRoster() {
    $('roster').innerHTML = state.people.map(p => `
      <tr data-id="${esc(p.id)}">
        <td><input type="text" data-f="name" value="${esc(p.name)}" placeholder="Jméno" aria-label="Jméno" autocomplete="off"></td>
        <td><input type="text" data-f="address" value="${esc(p.address)}" placeholder="Ulice 12, Město" aria-label="Adresa" autocomplete="off"></td>
        <td data-geo>${geoHtml(p)}</td>
        <td data-label="Míst v autě (s řidičkou)"><input type="number" data-f="seats" min="2" max="9" value="${DRIVER(p.status) ? p.seats : ''}" ${DRIVER(p.status) ? '' : 'disabled'} aria-label="Míst v autě"></td>
        <td data-label="Stav"><select data-f="status" aria-label="Stav">${STATUS.map(([v, l]) =>
          `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><button class="link" data-act="del" title="Odebrat">✕</button></td>
      </tr>`).join('') ||
      '<tr><td colspan="6" class="small">Zatím nikdo. Přidejte první hráčku.</td></tr>';
  }
  function updateGeoCell(p) {
    const cell = document.querySelector(`tr[data-id="${CSS.escape(p.id)}"] [data-geo]`);
    if (cell) cell.innerHTML = geoHtml(p);
  }
  function addPerson() {
    const p = normPerson({});
    state.people.push(p);
    save(); renderRoster();
    return p;
  }

  $('roster').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const p = state.people.find(x => x.id === tr.dataset.id);
    if (!p) return;
    const f = e.target.dataset.f;
    if (f === 'name') p.name = e.target.value;
    else if (f === 'address') {
      if (e.target.value === p.address) return; // unchanged (browsers can fire 'change' twice)
      p.address = e.target.value; geocode(p);
    } else if (f === 'seats') {
      p.seats = Math.max(2, Math.min(9, parseInt(e.target.value, 10) || 4)); e.target.value = p.seats;
    } else if (f === 'status') {
      p.status = e.target.value;
      const seats = tr.querySelector('[data-f="seats"]');
      seats.disabled = !DRIVER(p.status);
      seats.value = DRIVER(p.status) ? p.seats : ''; // passengers have no seat count; the number returns if they become drivers
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
    state.people.forEach(p => { if (p.address.trim() && p.lat == null && !p.pending) geocode(p); });
    if (state.hall.address.trim() && state.hall.lat == null && !state.hall.pending) geocode(state.hall);
  });
  $('newMatch').addEventListener('click', () => {
    if (!confirm('Vynulovat stav všech hráček pro nový zápas?')) return;
    state.people.forEach(p => { p.status = ''; });
    save(); renderRoster();
  });

  // ---------- match and settings ----------
  function renderHallStatus() { $('hallStatus').innerHTML = state.hall.address ? geoHtml(state.hall) : ''; }
  $('hall').value = state.hall.address;
  $('arrive').value = state.arrive;
  $('hall').addEventListener('change', e => {
    if (e.target.value === state.hall.address) return;
    state.hall.address = e.target.value; geocode(state.hall); save();
  });
  $('arrive').addEventListener('change', e => { state.arrive = e.target.value; save(); });
  ['carPenalty', 'maxDetour', 'maxDriverDetour', 'stopMin'].forEach(k => {
    $(k).value = state.settings[k];
    $(k).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      state.settings[k] = isNaN(v) ? Planner.DEFAULTS[k] : Math.max(0, v);
      save();
    });
  });

  // ---------- backup ----------
  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'carpool-roster.json'; a.click();
    URL.revokeObjectURL(a.href);
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!Array.isArray(s.people)) throw new Error('bad');
      if (state.people.length && !confirm('Nahrání souboru přepíše současnou soupisku. Pokračovat?')) return;
      state = merge(s);
      state.people = state.people.map(normPerson);
      save(); location.reload();
    } catch (err) { alert('Soubor se nepodařilo načíst. Je to soubor exportovaný z této aplikace?'); }
  });

  // ---------- plan ----------
  setupPlan({ getState: () => state });

  // ---------- start ----------
  if (!state.people.length) { addPerson(); addPerson(); addPerson(); } // a few blank rows to start with
  else renderRoster();
  renderHallStatus();
})();
