/*
 * Code shared by both app versions (local and Google Sheet):
 * player statuses, route calculation (OSRM), the plan, the map and the group message.
 *
 * Each version passes its state in through setupPlan({ getState, hint, warnings }):
 *   getState() -> { people, hall, arrive, settings }
 *   hint()     -> extra sentence for the 'address missing' error (e.g. a pointer to the sheet)
 *   warnings() -> array of notices shown before the plan (e.g. a past match date)
 */
(function (root) {
  'use strict';

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

  const TIMES_DISCLAIMER = 'Časy jsou jen orientační. Před odjezdem doporučujeme zkontrolovat aktuální dopravní situaci v Google Maps nebo Waze.';
  const TIMES_DISCLAIMER_SHORT = 'Časy jsou orientační, před odjezdem zkontrolujte dopravu (Google Maps / Waze).';

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 12));
  const nameOf = p => (p.name || '').trim() || '(bez jména)';
  const fmtTime = mins => {
    const m = ((Math.round(mins) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };

  // address lookup status of a player or the hall
  function geoHtml(t) {
    if (t.pending) return '<span class="geo wait">hledám…</span>';
    if (t.warn) return `<span class="geo bad" title="${esc(t.check || t.label || '')}">⚠ ${t.lat != null ? 'zkontrolovat' : 'upřesnit'}</span>`;
    if (t.lat != null) return `<span class="geo ok" title="${esc(t.label || '')}">✓ nalezeno</span>`;
    if (t.fail) return `<span class="geo bad" title="${esc(t.label || '')}">✗ nenalezeno</span>`;
    return '<span class="geo wait">–</span>';
  }

  // ---------- routes ----------
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

  function notice(kind, text) {
    const d = document.createElement('div');
    d.className = 'notice ' + kind; d.textContent = text;
    $('notices').appendChild(d);
  }

  // ---------- plan ----------
  function setupPlan(cfg) {
    const getState = cfg.getState, hint = () => (cfg.hint ? cfg.hint() : '');

    $('plan').addEventListener('click', async () => {
      const state = getState();
      $('notices').innerHTML = '';
      const waiting = state.people.filter(p => !p.status && ((p.name || '').trim() || (p.address || '').trim()));
      if (waiting.length) notice('warn', 'Zatím nevyplnily stav: ' + waiting.map(nameOf).join(', ') + '. Do plánu se nepočítají.');
      (cfg.warnings ? cfg.warnings() : []).forEach(t => notice('warn', t));
      const attendees = state.people.filter(p => ATTENDING(p.status));
      if (attendees.length < 2) return notice('bad', 'Zatím jedou méně než dvě hráčky.');
      if (state.hall.lat == null) return notice('bad', 'Adresa haly zatím nebyla nalezena. Zkontrolujte ji.' + hint());
      const missing = attendees.filter(p => p.lat == null);
      if (missing.length) return notice('bad', 'Chybí nalezená adresa u: ' + missing.map(nameOf).join(', ') + '.' + hint());
      const unsure = attendees.filter(p => p.warn).concat(state.hall.warn ? [{ name: 'hala' }] : []);
      if (unsure.length) notice('warn', 'Adresa není jistá u: ' + unsure.map(nameOf).join(', ') + '. Plán s ní počítá, ale ověřte ji.');

      $('plan').disabled = true; $('planStatus').textContent = 'Počítám trasy…';
      const points = attendees.map(p => ({ lat: p.lat, lon: p.lon })).concat({ lat: state.hall.lat, lon: state.hall.lon });
      let dur, estimated = false;
      try { dur = await osrmMatrix(points); }
      catch (e) { dur = Planner.fallbackMatrix(points); estimated = true; }

      const people = attendees.map(p => ({ canDrive: DRIVER(p.status), mustDrive: p.status === 'must', seats: p.seats }));
      const result = Planner.plan({ dur, people, options: state.settings });
      $('plan').disabled = false; $('planStatus').textContent = '';

      if (result.error === 'NO_DRIVERS') return notice('bad', 'Nikdo zatím nenabídl auto. Aspoň jedna hráčka musí mít stav „Určitě beru auto“ nebo „Můžu vzít auto“.');
      if (result.error === 'NOT_ENOUGH_SEATS') return notice('bad', `Nedostatek míst v autech: chybí aspoň ${result.missing}. Další hráčka musí nabídnout auto, nebo někdo zvýšit počet míst.`);
      if (estimated) notice('warn', 'Veřejný routovací server není dostupný, časy jsou odhadnuté vzdušnou čarou. Skutečné časy se mohou lišit.');

      await renderResult(state, result, attendees, estimated);
    });

    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('msg').value); $('copyStatus').textContent = 'Zkopírováno.'; }
      catch (e) { $('msg').parentElement.open = true; $('msg').select(); $('copyStatus').textContent = 'Text označte a zkopírujte ručně.'; }
      setTimeout(() => { $('copyStatus').textContent = ''; }, 3000);
    });
  }

  async function renderResult(state, result, attendees, estimated) {
    const arrive = (() => { const [h, m] = state.arrive.split(':').map(Number); return h * 60 + m; })();
    const hallName = state.hall.address.trim();
    const lines = [`Zápas${state.dateText ? ' ' + state.dateText : ''} – sraz v hale ${state.arrive}${hallName ? ' (' + hallName + ')' : ''}`, ''];
    let html = `<p class="small" style="margin-top:0">${result.carCount} ${result.carCount === 1 ? 'auto' : result.carCount < 5 ? 'auta' : 'aut'}, celkem ${Math.round(result.totalDrivingMin)} minut jízdy${estimated ? ' (odhad)' : ''}.</p>`;

    // the times come from typical driving times: remind everyone to check live traffic before leaving
    html += `<p class="info">${esc(TIMES_DISCLAIMER)}</p>`;

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

    lines.push('', TIMES_DISCLAIMER_SHORT);
    $('result').innerHTML = html;
    $('msg').value = lines.join('\n');
    $('resultSec').hidden = false;
    $('resultSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await renderMap(state, result, attendees);
  }

  // ---------- map ----------
  let map = null, mapLayer = null;
  async function renderMap(state, result, attendees) {
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

  root.Common = { $, esc, uid, nameOf, STATUS, DRIVER, ATTENDING, geoHtml, setupPlan };
})(window);
