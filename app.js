(function () {
  'use strict';

  const STORE = 'spolujizdy.v1';
  const TEAM_KEY = 'spolujizdy.team';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OSRM = 'https://router.project-osrm.org';
  const COLORS = ['#1d6fe0', '#d9480f', '#2b8a3e', '#9c36b5', '#c2255c', '#0b7285', '#a07800', '#495057'];
  const STATUS = [
    ['', '— vyberte —'],
    ['must', 'Určitě beru auto'],
    ['can', 'Můžu vzít auto'],
    ['pass', 'Potřebuji odvoz'],
    ['no', 'Nejedu'],
  ];
  const DRIVER = s => s === 'must' || s === 'can';
  const ATTENDING = s => s === 'must' || s === 'can' || s === 'pass';
  const PLAYER_FIELDS = ['name', 'address', 'lat', 'lon', 'label', 'fail', 'seats', 'status', 'created'];

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 12));

  // ---------- konfigurace a režim (místní / sdílený tým) ----------
  const CFG = window.SPOLUJIZDY_CONFIG || {};
  const FB = CFG.firebase && CFG.firebase.apiKey && CFG.firebase.projectId ? CFG.firebase : null;
  const POLL_MS = CFG.pollMs || 15000;
  const TEAM_RE = /^[A-Za-z0-9]{16,64}$/;

  function readTeamId() {
    const m = /[#&]t=([A-Za-z0-9]+)/.exec(location.hash);
    if (m && TEAM_RE.test(m[1])) {
      try { localStorage.setItem(TEAM_KEY, m[1]); } catch (e) { /* ignoruj */ }
      return m[1];
    }
    try {
      const s = localStorage.getItem(TEAM_KEY);
      if (s && TEAM_RE.test(s)) { history.replaceState(null, '', '#t=' + s); return s; }
    } catch (e) { /* ignoruj */ }
    return null;
  }
  const teamId = FB ? readTeamId() : null;
  const shared = !!(FB && teamId);

  // ---------- stav a místní ukládání ----------
  let state = load();

  function defaults() {
    return {
      people: [],
      hall: { address: '', lat: null, lon: null, label: '', fail: false },
      arrive: '18:00',
      settings: { carPenalty: 20, maxDetour: 20, stopMin: 2 },
    };
  }
  function merge(s) {
    const d = defaults();
    return Object.assign(d, s, { hall: Object.assign(d.hall, s.hall), settings: Object.assign(d.settings, s.settings) });
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) return merge(JSON.parse(raw));
    } catch (e) { /* prohlížeč bez úložiště – jedeme bez ukládání */ }
    return defaults();
  }
  function save() {
    // ve sdíleném režimu se místně drží jen osobní nastavení plánování
    const data = shared ? { settings: state.settings } : state;
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (e) { /* ignoruj */ }
  }
  function normPerson(raw) {
    const p = Object.assign({
      id: uid(), name: '', address: '', lat: null, lon: null, label: '', fail: false,
      seats: 4, status: '', created: 0,
    }, raw);
    p.seats = Math.max(2, Math.min(9, parseInt(p.seats, 10) || 4));
    p.fail = !!p.fail;
    return p;
  }
  state.people = state.people.map(normPerson);

  // ---------- Firestore (REST, jen když je tým sdílený) ----------
  function fsUrl(path, params) {
    const q = new URLSearchParams();
    q.set('key', FB.apiKey);
    (params || []).forEach(([k, v]) => q.append(k, v));
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FB.projectId)}/databases/(default)/documents/${path}?${q}`;
  }
  const fsEnc = v => v === null || v === undefined ? { nullValue: null }
    : typeof v === 'boolean' ? { booleanValue: v }
    : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
    : { stringValue: String(v) };
  const fsDec = f => 'stringValue' in f ? f.stringValue : 'integerValue' in f ? Number(f.integerValue)
    : 'doubleValue' in f ? f.doubleValue : 'booleanValue' in f ? f.booleanValue : null;
  const fsDecodeFields = fields => {
    const o = {};
    Object.keys(fields || {}).forEach(k => { o[k] = fsDec(fields[k]); });
    return o;
  };
  async function fsPatch(path, obj) {
    const fields = {};
    Object.keys(obj).forEach(k => { fields[k] = fsEnc(obj[k]); });
    const res = await fetch(fsUrl(path, Object.keys(obj).map(k => ['updateMask.fieldPaths', k])), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error('firestore ' + res.status);
  }
  async function fsDelete(path) {
    const res = await fetch(fsUrl(path), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('firestore ' + res.status);
  }
  async function fsListPlayers(team) {
    const res = await fetch(fsUrl(`teams/${team}/players`, [['pageSize', '300']]));
    if (!res.ok) throw new Error('firestore ' + res.status);
    const data = await res.json();
    return (data.documents || []).map(d => Object.assign(fsDecodeFields(d.fields), { id: d.name.split('/').pop() }));
  }
  async function fsGetMeta(team) {
    const res = await fetch(fsUrl(`teams/${team}/meta/match`));
    if (res.status === 404) return {};
    if (!res.ok) throw new Error('firestore ' + res.status);
    return fsDecodeFields((await res.json()).fields);
  }
  const metaOf = s => ({
    hallAddress: s.hall.address, hallLat: s.hall.lat, hallLon: s.hall.lon,
    hallLabel: s.hall.label, hallFail: !!s.hall.fail, arrive: s.arrive,
  });

  // zápisy se řadí za sebe, aby na serveru zůstala vždy poslední změna
  let writeChain = Promise.resolve(), inFlight = 0;
  function enqueue(op) {
    inFlight++;
    setSync('save');
    writeChain = writeChain.then(op).then(
      () => { inFlight--; if (!inFlight) setSync('ok'); },
      () => { inFlight--; setSync('err'); });
  }
  function setSync(kind) {
    const el = $('syncStatus');
    if (!el) return;
    const t = {
      ok: ['✓ synchronizováno', 'ok'], save: ['ukládám…', 'wait'],
      err: ['⚠ nepodařilo se uložit/načíst, zkusím znovu', 'bad'], load: ['načítám…', 'wait'],
    }[kind];
    el.textContent = t[0]; el.className = 'geo ' + t[1];
  }

  function persistPerson(p, fields) {
    if (!shared) return save();
    const f = p._unsaved ? PLAYER_FIELDS : fields;
    p._unsaved = false;
    const body = {};
    f.forEach(k => { body[k] = p[k]; });
    enqueue(() => fsPatch(`teams/${teamId}/players/${p.id}`, body));
  }
  function persistMeta() {
    if (!shared) return save();
    enqueue(() => fsPatch(`teams/${teamId}/meta/match`, metaOf(state)));
  }

  // ---------- geokódování (Nominatim, max. 1 dotaz/s) ----------
  const geoQueue = [];
  let geoRunning = false;
  const isHall = t => t === state.hall;
  function geoRefresh(t) { if (isHall(t)) renderHallStatus(); else updateGeoCell(t); }
  function geoPersist(t) {
    if (isHall(t)) persistMeta();
    else persistPerson(t, ['lat', 'lon', 'label', 'fail']);
  }
  function geocode(target) {
    const empty = !target.address.trim();
    target.lat = target.lon = null; target.fail = false; target.label = '';
    target.pending = !empty;
    geoRefresh(target);
    if (empty) { geoPersist(target); return; }
    geoQueue.push(target);
    if (!geoRunning) runGeo();
  }
  async function runGeo() {
    geoRunning = true;
    while (geoQueue.length) {
      const target = geoQueue.shift();
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
      geoPersist(target); geoRefresh(target);
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
    $('roster').innerHTML = state.people.map(p => `
      <tr data-id="${esc(p.id)}">
        <td><input type="text" data-f="name" value="${esc(p.name)}" placeholder="Jméno" aria-label="Jméno" autocomplete="off"></td>
        <td><input type="text" data-f="address" value="${esc(p.address)}" placeholder="Ulice 12, Město" aria-label="Adresa" autocomplete="off"></td>
        <td data-geo>${geoHtml(p)}</td>
        <td data-label="Míst v autě (s řidičkou)"><input type="number" data-f="seats" min="2" max="9" value="${p.seats}" ${DRIVER(p.status) ? '' : 'disabled'} aria-label="Míst v autě"></td>
        <td data-label="Stav"><select data-f="status" aria-label="Stav">${STATUS.map(([v, l]) =>
          `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><button class="link" data-act="del" title="Odebrat">✕</button></td>
      </tr>`).join('') ||
      '<tr><td colspan="6" class="small">Zatím tu nikdo není. Přidejte se tlačítkem níže.</td></tr>';
  }
  function updateGeoCell(p) {
    const cell = document.querySelector(`tr[data-id="${CSS.escape(p.id)}"] [data-geo]`);
    if (cell) cell.innerHTML = geoHtml(p);
  }
  function addPerson(init) {
    const p = normPerson(Object.assign({ created: Date.now(), _unsaved: true }, init));
    state.people.push(p);
    if (!shared) save();
    renderRoster();
    return p;
  }

  $('roster').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const p = state.people.find(x => x.id === tr.dataset.id);
    if (!p) return;
    const f = e.target.dataset.f;
    if (f === 'name') { p.name = e.target.value; persistPerson(p, ['name']); }
    else if (f === 'address') {
      if (e.target.value === p.address) return; // beze změny (prohlížeč umí poslat change dvakrát)
      p.address = e.target.value; geocode(p); persistPerson(p, ['address', 'lat', 'lon', 'label', 'fail']);
    }
    else if (f === 'seats') {
      p.seats = Math.max(2, Math.min(9, parseInt(e.target.value, 10) || 4));
      e.target.value = p.seats; persistPerson(p, ['seats']);
    } else if (f === 'status') {
      p.status = e.target.value;
      tr.querySelector('[data-f="seats"]').disabled = !DRIVER(p.status);
      persistPerson(p, ['status']);
    }
  });
  $('roster').addEventListener('click', e => {
    if (e.target.dataset.act !== 'del') return;
    const id = e.target.closest('tr').dataset.id;
    const p = state.people.find(x => x.id === id);
    if (p && (p.name || p.address) && !confirm(`Odebrat ${p.name || 'tuto hráčku'}?`)) return;
    state.people = state.people.filter(x => x.id !== id);
    if (shared && p && !p._unsaved) enqueue(() => fsDelete(`teams/${teamId}/players/${id}`));
    else save();
    renderRoster();
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
    if (!confirm('Vynulovat stav všech hráček pro nový zápas? Změna se projeví všem.')) return;
    state.people.forEach(p => { p.status = ''; persistPerson(p, ['status']); });
    renderRoster();
  });

  // ---------- zápas a nastavení ----------
  function renderHallStatus() { $('hallStatus').innerHTML = state.hall.address ? geoHtml(state.hall) : ''; }
  $('hall').value = state.hall.address;
  $('arrive').value = state.arrive;
  $('hall').addEventListener('change', e => {
    if (e.target.value === state.hall.address) return;
    state.hall.address = e.target.value; geocode(state.hall); persistMeta();
  });
  $('arrive').addEventListener('change', e => { state.arrive = e.target.value; persistMeta(); });
  ['carPenalty', 'maxDetour', 'stopMin'].forEach(k => {
    $(k).value = state.settings[k];
    $(k).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      state.settings[k] = isNaN(v) ? Planner.DEFAULTS[k] : Math.max(0, v);
      save();
    });
  });

  // ---------- sdílený tým: načítání změn od ostatních ----------
  let deferred = null, lastSig = '', pulling = false;
  // Rozepsáno = v poli je text, který ještě není uložený (change se nespustil).
  // Pouhý kurzor v poli ani otevřený výběr příjem změn ostatních neblokuje.
  function committedValue(a) {
    const tr = a.closest('tr[data-id]');
    const p = tr && state.people.find(x => x.id === tr.dataset.id);
    const v = p ? p[a.dataset.f] : null;
    return v == null ? '' : String(v);
  }
  function isEditing() {
    const a = document.activeElement;
    return !!(a && $('roster').contains(a) && a.tagName === 'INPUT' && a.value !== committedValue(a));
  }
  function renderRosterKeepFocus() {
    const a = document.activeElement;
    let keep = null;
    if (a && $('roster').contains(a) && a.dataset.f) {
      keep = { id: a.closest('tr[data-id]').dataset.id, f: a.dataset.f, s: a.selectionStart, e: a.selectionEnd };
    }
    renderRoster();
    if (!keep) return;
    const el = document.querySelector(`tr[data-id="${CSS.escape(keep.id)}"] [data-f="${keep.f}"]`);
    if (!el) return;
    el.focus();
    try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch (e) { /* number input */ }
  }
  function applyRemote(list, meta) {
    if (isEditing()) { deferred = { list, meta }; return; }
    deferred = null;
    const prev = state.people;
    const onServer = new Set(list.map(x => x.id));
    const incoming = list.map(normPerson).sort((a, b) => (a.created || 0) - (b.created || 0));
    incoming.forEach(p => { const old = prev.find(x => x.id === p.id); if (old && old.pending) p.pending = true; });
    state.people = incoming.concat(prev.filter(p => p._unsaved && !onServer.has(p.id)));
    const sig = JSON.stringify(state.people.map(p => [p.id, p.name, p.address, p.lat, p.lon, p.fail, p.seats, p.status, !!p.pending]));
    if (sig !== lastSig) { lastSig = sig; renderRosterKeepFocus(); }

    if (meta && 'hallAddress' in meta) {
      const hallEditing = document.activeElement === $('hall');
      if (!hallEditing && !state.hall.pending) {
        state.hall = { address: meta.hallAddress || '', lat: meta.hallLat, lon: meta.hallLon, label: meta.hallLabel || '', fail: !!meta.hallFail };
        $('hall').value = state.hall.address; renderHallStatus();
      }
      if (document.activeElement !== $('arrive') && meta.arrive) { state.arrive = meta.arrive; $('arrive').value = meta.arrive; }
    }
  }
  async function pull() {
    if (!shared || pulling || inFlight) return; // během ukládání nepřepisovat rozepsané změny
    pulling = true;
    try {
      const [list, meta] = await Promise.all([fsListPlayers(teamId), fsGetMeta(teamId)]);
      applyRemote(list, meta);
      setSync('ok');
    } catch (e) { setSync('err'); }
    pulling = false;
  }
  $('roster').addEventListener('focusout', () => {
    setTimeout(() => { if (deferred && !isEditing()) applyRemote(deferred.list, deferred.meta); }, 250);
  });

  // ---------- panel týmu ----------
  function newTeamId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, x => chars[x % chars.length]).join('');
  }
  async function createTeam() {
    const id = newTeamId();
    $('createTeam').disabled = true;
    // počkat, až se dohledají právě zadané adresy, ať se do týmu přenesou i souřadnice
    $('createTeam').textContent = 'Čekám na nalezení adres…';
    for (let t = 0; (geoRunning || geoQueue.length) && t < 100; t++) await new Promise(r => setTimeout(r, 200));
    try {
      const now = Date.now();
      await Promise.all(state.people.filter(p => p.name || p.address).map((p, i) => {
        const body = {};
        PLAYER_FIELDS.forEach(k => { body[k] = k === 'created' ? (p.created || now + i) : p[k]; });
        return fsPatch(`teams/${id}/players/${p.id}`, body);
      }));
      await fsPatch(`teams/${id}/meta/match`, metaOf(state));
    } catch (e) {
      $('createTeam').disabled = false;
      alert('Tým se nepodařilo založit. Zkontrolujte připojení a nastavení databáze (viz README).');
      return;
    }
    try { localStorage.setItem(TEAM_KEY, id); } catch (e) { /* ignoruj */ }
    location.hash = '#t=' + id;
    location.reload();
  }
  function renderTeamBox() {
    const box = $('teamBox');
    if (!FB) { box.hidden = true; return; }
    box.hidden = false;
    if (!shared) {
      box.innerHTML = `<h2>Sdílený tým</h2>
        <p class="small" style="margin-top:0">Teď pracujete jen na tomto zařízení. Po založení sdíleného týmu dostanete odkaz, který pošlete hráčkám. Každá si pak sama zadá svou adresu a stav a vidí ostatní. Soupiska, kterou už tu máte, se do týmu přenese.</p>
        <button class="primary" id="createTeam">Založit sdílený tým</button>`;
      $('createTeam').addEventListener('click', createTeam);
      return;
    }
    const link = (location.protocol === 'file:' ? location.href.split('#')[0] : location.origin + location.pathname) + '#t=' + teamId;
    box.innerHTML = `<h2>Sdílený tým</h2>
      <p class="small" style="margin-top:0">Pošlete tento odkaz hráčkám. Každá si v něm vyplní svůj řádek a změny se objeví všem do několika sekund. Kdo má odkaz, vidí adresy všech a může je upravovat, proto ho posílejte jen do týmové skupiny.</p>
      <div class="row" style="margin-top:0">
        <input type="text" id="teamLink" readonly value="${esc(link)}" style="flex:1;min-width:12rem">
        <button id="copyLink">Zkopírovat odkaz</button>
      </div>
      <div class="row"><span id="syncStatus" class="geo wait">načítám…</span>
        <button class="link" id="leaveTeam" style="color:var(--muted)">Odpojit toto zařízení od týmu</button></div>`;
    $('copyLink').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); $('copyLink').textContent = 'Zkopírováno'; }
      catch (e) { $('teamLink').select(); }
      setTimeout(() => { $('copyLink').textContent = 'Zkopírovat odkaz'; }, 2500);
    });
    $('leaveTeam').addEventListener('click', () => {
      if (!confirm('Toto zařízení přestane být připojené k týmu. Data týmu zůstanou, vrátíte se k nim odkazem.')) return;
      try { localStorage.removeItem(TEAM_KEY); } catch (e) { /* ignoruj */ }
      history.replaceState(null, '', location.pathname); location.reload();
    });
  }

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

  $('plan').addEventListener('click', async () => {
    $('notices').innerHTML = '';
    const waiting = state.people.filter(p => !p.status && (p.name.trim() || p.address.trim()));
    if (waiting.length) notice('warn', 'Zatím nevyplnily stav: ' + waiting.map(nameOf).join(', ') + '. Do plánu se nepočítají.');
    const attendees = state.people.filter(p => ATTENDING(p.status));
    if (attendees.length < 2) return notice('bad', 'Zatím jedou méně než dvě hráčky.');
    if (state.hall.lat == null) return notice('bad', 'Adresa haly zatím nebyla nalezena. Zkontrolujte ji.');
    const missing = attendees.filter(p => p.lat == null);
    if (missing.length) return notice('bad', 'Chybí nalezená adresa u: ' + missing.map(nameOf).join(', ') + '.');

    $('plan').disabled = true; $('planStatus').textContent = 'Počítám trasy…';
    const points = attendees.map(p => ({ lat: p.lat, lon: p.lon })).concat({ lat: state.hall.lat, lon: state.hall.lon });
    let dur, estimated = false;
    try { dur = await osrmMatrix(points); }
    catch (e) { dur = Planner.fallbackMatrix(points); estimated = true; }

    const people = attendees.map(p => ({
      canDrive: DRIVER(p.status), mustDrive: p.status === 'must', seats: p.seats,
    }));
    const result = Planner.plan({ dur, people, options: state.settings });
    $('plan').disabled = false; $('planStatus').textContent = '';

    if (result.error === 'NO_DRIVERS') return notice('bad', 'Nikdo zatím nenabídl auto. Aspoň jedna hráčka musí mít stav „Určitě beru auto“ nebo „Můžu vzít auto“.');
    if (result.error === 'NOT_ENOUGH_SEATS') return notice('bad', `Nedostatek míst v autech: chybí aspoň ${result.missing}. Další hráčka musí nabídnout auto, nebo někdo zvýšit počet míst.`);
    if (estimated) notice('warn', 'Veřejný routovací server není dostupný, časy jsou odhadnuté vzdušnou čarou. Skutečné časy se mohou lišit.');

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

  // ---------- kopírování, záloha (jen místní režim) ----------
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
      if (state.people.length && !confirm('Nahrání souboru přepíše současnou soupisku. Pokračovat?')) return;
      state = merge(s);
      state.people = state.people.map(normPerson);
      save(); location.reload();
    } catch (err) { alert('Soubor se nepodařilo načíst. Je to soubor exportovaný z této aplikace?'); }
  });

  // ---------- start ----------
  async function start() {
    renderTeamBox();
    $('backupSec').hidden = shared;
    if (shared) {
      state.people = []; // data týmu jsou na serveru, ne v tomto zařízení
      $('hall').value = ''; $('arrive').value = state.arrive;
      renderRoster(); setSync('load');
      await pull();
      setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
      window.addEventListener('focus', pull);
    } else {
      if (!state.people.length) { addPerson(); addPerson(); addPerson(); } // prázdné řádky na rozjezd
      else renderRoster();
      renderHallStatus();
    }
  }
  start();
})();
