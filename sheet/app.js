/*
 * Google Sheet prototype: the app only reads from the sheet.
 * Players fill in the sheet (the Code.gs script validates addresses), planning happens here.
 * The link to the published sheet lives in the URL after # (not in the repository).
 */
(function () {
  'use strict';

  const { $, esc, uid, STATUS, geoHtml, setupPlan } = Common;
  // Storage keys keep their original names so data saved by earlier versions is still found.
  const SHEET_KEY = 'spolujizdy.sheet';
  const SETTINGS_KEY = 'spolujizdy.tabulka.settings';
  const SHEET_REF_RE = /^[A-Za-z0-9_-]{20,}\.\d{1,12}$/;   // <publish id>.<gid of the sheet>
  const EDIT_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
  const POLL_MS = 30000;

  // ---------- link to the sheet: from the URL, otherwise from browser storage ----------
  const sheetHash = (ref, edit) => '#s=' + ref + (edit ? '&e=' + edit : '');
  function readSheet() {
    const hs = /[#&]s=([A-Za-z0-9_.-]+)/.exec(location.hash);
    const he = /[#&]e=([A-Za-z0-9_-]+)/.exec(location.hash);
    let ref = hs && SHEET_REF_RE.test(hs[1]) ? hs[1] : null;
    let edit = he && EDIT_ID_RE.test(he[1]) ? he[1] : null;
    try {
      if (ref) localStorage.setItem(SHEET_KEY, JSON.stringify({ ref, edit }));
      else {
        const s = JSON.parse(localStorage.getItem(SHEET_KEY) || 'null');
        if (s && SHEET_REF_RE.test(s.ref)) {
          ref = s.ref; edit = s.edit && EDIT_ID_RE.test(s.edit) ? s.edit : null;
          history.replaceState(null, '', sheetHash(ref, edit));
        }
      }
    } catch (e) { /* ignore */ }
    return ref ? { ref, edit } : null;
  }
  const sheetRef = readSheet();

  // ---------- state (memory only; only the personal planning settings are stored) ----------
  const state = {
    people: [],
    hall: { address: '', lat: null, lon: null, label: '', fail: false },
    arrive: '18:00',
    date: null,        // match Date (local midnight) or null
    dateText: '',      // e.g. 'středa 2. 12. 2026'
    settings: { carPenalty: 20, maxDetour: 20, stopMin: 2 },
  };
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* ignore */ }

  function normPerson(raw) {
    const p = Object.assign({ id: uid(), name: '', address: '', lat: null, lon: null, label: '', fail: false, seats: 4, status: '' }, raw);
    p.seats = Math.max(2, Math.min(9, parseInt(p.seats, 10) || 4));
    return p;
  }

  // ---------- sheet: loading and parsing ----------
  function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = ''; rows.push(row); row = [];
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  const plain = s => String(s == null ? '' : s).trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const cellNum = s => { const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : null; };
  const SHEET_STATUS = { 'urcite beru auto': 'must', 'muzu vzit auto': 'can', 'potrebuji odvoz': 'pass', 'nejedu': 'no' };

  function sheetPlace(r) { // address, check and coordinates from one row (columns B, E-H)
    const check = String(r[4] || '').trim();
    return {
      address: String(r[1] || '').trim(), check, label: String(r[5] || '').trim(),
      lat: cellNum(r[6]), lon: cellNum(r[7]), fail: check.startsWith('✗'), warn: check.startsWith('⚠'),
    };
  }
  // Date from the published CSV: '2. 12. 2026' (the script sets the format); 2026-12-02 and 12/2/2026 are accepted too, to be safe.
  function parseDate(txt) {
    const s = String(txt || '').trim();
    let m, y, mo, d;
    if ((m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
    else return null;
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
  }
  const WEEKDAYS = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
  const formatDate = dt => `${WEEKDAYS[dt.getDay()]} ${dt.getDate()}. ${dt.getMonth() + 1}. ${dt.getFullYear()}`;
  // warning about a missing or past date: this is how you can tell the statuses in the sheet belong to an old match
  function dateWarning() {
    if (!state.date) return 'Datum zápasu není vyplněné v tabulce, nejde poznat, ke kterému zápasu stavy patří.';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (state.date < today) return `Datum zápasu (${state.dateText}) je v minulosti, stavy v tabulce jsou nejspíš staré. Nový zápas nastavíte v tabulce (Spolujízdy → Nový zápas).`;
    return '';
  }

  function parseSheet(text) {
    const rows = parseCsv(text);
    const hallRow = rows.find(r => plain(r[0]).startsWith('hala'));
    const timeRow = rows.find(r => plain(r[0]).startsWith('cas'));
    const dateRow = rows.find(r => plain(r[0]).startsWith('datum'));
    const hdr = rows.findIndex(r => plain(r[0]) === 'jmeno');
    if (hdr < 0) throw new Error('format');
    const people = [];
    rows.slice(hdr + 1).forEach((r, i) => {
      if (!String(r[0] || '').trim() && !String(r[1] || '').trim()) return;
      people.push(normPerson(Object.assign(sheetPlace(r), {
        id: 'r' + (hdr + 2 + i), name: String(r[0] || '').trim(),
        status: SHEET_STATUS[plain(r[2])] || '', seats: r[3],
      })));
    });
    const m = timeRow && /(\d{1,2})[:.](\d{2})/.exec(timeRow[1] || '');
    return {
      people, hall: hallRow ? sheetPlace(hallRow) : null,
      date: dateRow ? parseDate(dateRow[1]) : null,
      arrive: m ? String(m[1]).padStart(2, '0') + ':' + m[2] : null,
    };
  }

  // ---------- rendering ----------
  function renderRoster() {
    $('roster').innerHTML = state.people.map(p => `
      <tr data-id="${esc(p.id)}">
        <td><input type="text" data-f="name" value="${esc(p.name)}" aria-label="Jméno" disabled></td>
        <td><input type="text" data-f="address" value="${esc(p.address)}" aria-label="Adresa" disabled></td>
        <td data-geo>${geoHtml(p)}</td>
        <td data-label="Míst v autě (s řidičkou)"><input type="number" data-f="seats" value="${p.seats}" aria-label="Míst v autě" disabled></td>
        <td data-label="Stav"><select data-f="status" aria-label="Stav" disabled>${STATUS.map(([v, l]) =>
          `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td></td>
      </tr>`).join('') || '<tr><td colspan="6" class="small">V tabulce zatím nikdo není.</td></tr>';
  }
  function renderHallStatus() { $('hallStatus').innerHTML = state.hall.address ? geoHtml(state.hall) : ''; }

  let lastSig = '';
  function applySheet(parsed) {
    state.people = parsed.people;
    if (parsed.hall) {
      const h = parsed.hall;
      state.hall = { address: h.address, lat: h.lat, lon: h.lon, label: h.label, fail: h.fail, warn: h.warn, check: h.check };
    }
    if (parsed.arrive) state.arrive = parsed.arrive;
    state.date = parsed.date; state.dateText = parsed.date ? formatDate(parsed.date) : '';
    $('hall').value = state.hall.address; $('arrive').value = state.arrive;
    $('matchDate').value = state.dateText;
    renderHallStatus();
    const w = dateWarning();
    $('dateStatus').textContent = w ? '⚠ ' + (state.date ? 'datum je v minulosti, stavy jsou nejspíš staré' : 'datum zápasu chybí') : '';
    $('dateStatus').className = 'geo bad';
    $('dateStatus').title = w;
    const sig = JSON.stringify(state.people);
    if (sig !== lastSig) { lastSig = sig; renderRoster(); }
  }

  // last successful load: "25. 11. 2026 14:32:05"
  let lastLoaded = null;
  const fmtStamp = d => `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ` +
    [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  function setSync(kind) {
    const el = $('syncStatus');
    if (!el) return;
    const when = lastLoaded ? ` Poslední načtení: ${fmtStamp(lastLoaded)}.` : '';
    const t = {
      ok: [`✓ načteno z tabulky (${lastLoaded ? fmtStamp(lastLoaded) : ''})`, 'ok'],
      load: ['načítám…' + (lastLoaded ? ` (naposledy ${fmtStamp(lastLoaded)})` : ''), 'wait'],
      err: ['⚠ tabulku se nepodařilo načíst (je zveřejněná a odkaz správný?).' + when, 'bad'],
    }[kind];
    el.textContent = t[0]; el.className = 'geo ' + t[1];
  }
  let fetching = false;
  async function refreshSheet() {
    if (fetching) return;
    fetching = true; setSync('load');
    try {
      const [pub, gid] = sheetRef.ref.split('.');
      const res = await fetch(`https://docs.google.com/spreadsheets/d/e/${pub}/pub?gid=${gid}&single=true&output=csv`, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      applySheet(parseSheet(await res.text()));
      lastLoaded = new Date();
      setSync('ok');
    } catch (e) { setSync('err'); }
    fetching = false;
  }

  // ---------- panel: connecting and sheet info ----------
  function connectSheet() {
    const pubUrl = $('sheetPub').value, editUrl = $('sheetEdit').value;
    const pub = /spreadsheets\/d\/e\/([A-Za-z0-9_-]+)\/pub/.exec(pubUrl);
    if (!pub) { $('sheetErr').textContent = 'Zadejte odkaz ze „Publikovat na webu“ (obsahuje /d/e/…/pub).'; return; }
    const gid = /[?&]gid=(\d+)/.exec(pubUrl);
    const ed = /spreadsheets\/d\/(?!e\/)([A-Za-z0-9_-]+)/.exec(editUrl);
    const ref = pub[1] + '.' + (gid ? gid[1] : '0');
    if (!SHEET_REF_RE.test(ref)) { $('sheetErr').textContent = 'Odkaz se nepodařilo přečíst.'; return; }
    const edit = ed && EDIT_ID_RE.test(ed[1]) ? ed[1] : null;
    try { localStorage.setItem(SHEET_KEY, JSON.stringify({ ref, edit })); } catch (e) { /* ignore */ }
    location.hash = sheetHash(ref, edit);
    location.reload();
  }
  function renderConnectBox(box) {
    box.innerHTML = `<h2>Připojit Google tabulku</h2>
      <p class="small" style="margin-top:0">Nejdřív je potřeba založit a zveřejnit tabulku (postup je v README, trvá asi 10 minut). Pak sem vložte odkaz ze zveřejnění. Odkaz se uloží jen v tomto prohlížeči a v adrese stránky, ne do repozitáře.</p>
      <label class="f"><span>Odkaz na zveřejněnou tabulku (Soubor → Sdílet → Publikovat na webu → list „Tým“ jako CSV)</span>
        <input type="text" id="sheetPub" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=0&amp;single=true&amp;output=csv"></label>
      <label class="f" style="margin-top:8px"><span>Odkaz na úpravy tabulky (nepovinné, pro tlačítko „Upravit tabulku“)</span>
        <input type="text" id="sheetEdit" placeholder="https://docs.google.com/spreadsheets/d/…/edit"></label>
      <div class="row"><button class="primary" id="sheetConnect">Připojit tabulku</button><span id="sheetErr" class="geo bad"></span></div>`;
    $('sheetConnect').addEventListener('click', connectSheet);
  }
  function renderSheetBox(box) {
    const base = location.protocol === 'file:' ? location.href.split('#')[0] : location.origin + location.pathname;
    const link = base + sheetHash(sheetRef.ref, sheetRef.edit);
    const editUrl = sheetRef.edit ? `https://docs.google.com/spreadsheets/d/${sheetRef.edit}/edit` : '';
    box.innerHTML = `<h2>Google tabulka</h2>
      <p class="small" style="margin-top:0">Hráčky vyplňují tabulku, tato stránka z ní jen čte. Změny se tu objeví s krátkým zpožděním, protože Google zveřejněnou tabulku obnovuje sám, i několik minut.</p>
      <div class="row" style="margin-top:0">
        ${editUrl ? '<button class="primary" id="editSheet">Upravit tabulku</button>' : ''}
        <button id="reloadSheet">Obnovit</button><span id="syncStatus" class="geo wait">načítám…</span>
      </div>
      <p class="small">Odkaz na tuto stránku pro hráčky:</p>
      <div class="row" style="margin-top:0">
        <input type="text" id="teamLink" readonly value="${esc(link)}" style="flex:1;min-width:12rem">
        <button id="copyLink">Zkopírovat odkaz</button>
      </div>
      <p class="small">V odkazu je i adresa zveřejněné tabulky, proto ho posílejte jen do týmové skupiny.</p>
      <div class="row"><button class="link" id="leaveTeam" style="color:var(--muted)">Odpojit toto zařízení od tabulky</button></div>`;
    $('copyLink').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); $('copyLink').textContent = 'Zkopírováno'; }
      catch (e) { $('teamLink').select(); }
      setTimeout(() => { $('copyLink').textContent = 'Zkopírovat odkaz'; }, 2500);
    });
    if (editUrl) $('editSheet').addEventListener('click', () => window.open(editUrl, '_blank', 'noopener'));
    $('reloadSheet').addEventListener('click', refreshSheet);
    $('leaveTeam').addEventListener('click', () => {
      if (!confirm('Toto zařízení přestane být připojené k tabulce. K ní se vrátíte odkazem.')) return;
      try { localStorage.removeItem(SHEET_KEY); } catch (e) { /* ignore */ }
      history.replaceState(null, '', location.pathname); location.reload();
    });
  }

  // ---------- planning settings (this device only) ----------
  ['carPenalty', 'maxDetour', 'stopMin'].forEach(k => {
    $(k).value = state.settings[k];
    $(k).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      state.settings[k] = isNaN(v) ? Planner.DEFAULTS[k] : Math.max(0, v);
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (err) { /* ignore */ }
    });
  });

  setupPlan({
    getState: () => state,
    hint: () => ' Podívejte se do sloupce „Kontrola adresy“ v tabulce.',
    warnings: () => [dateWarning()].filter(Boolean),
  });

  // ---------- start ----------
  async function start() {
    const box = $('teamBox');
    if (!sheetRef) { renderConnectBox(box); return; } // without a sheet nothing else is shown
    renderSheetBox(box);
    $('mainArea').hidden = false;
    renderRoster(); setSync('load');
    await refreshSheet();
    setInterval(() => { if (document.visibilityState === 'visible') refreshSheet(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSheet(); });
  }
  start();
})();
