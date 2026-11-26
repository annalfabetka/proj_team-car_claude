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

  const TIMES_DISCLAIMER = 'Časy jsou jen orientační. Před odjezdem doporučujeme zkontrolovat aktuální dopravní situaci v Google Maps.';
  // shown when nobody travels differently on the way back (otherwise the section 'Cesta zpět' is shown)
  const SAME_BACK = 'Doprava zpět je stejná: všichni se vracejí ve stejných autech na stejné adresy jako cestou tam.';
  const SAME_BACK_SHORT = 'Zpět jedeme stejně jako tam (stejná auta, stejné adresy).';
  const TIMES_DISCLAIMER_SHORT = 'Časy jsou orientační, před odjezdem zkontrolujte dopravu (Google Maps).';

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 12));
  // Czech plural: 1 místo, 2-4 místa, 5+ míst
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
  // names are compared without case, diacritics and extra spaces ("Adél " = "adel")
  const nameKey = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  const nameOf = p => (p.name || '').trim() || '(bez jména)';
  const fmtTime = mins => {
    const m = ((Math.round(mins) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };

  // "48 min", "1 h", "1 h 12 min"
  const fmtDuration = mins => {
    const m = Math.max(0, Math.round(mins));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  };

  // ---------- navigation links ----------
  const coord = pt => `${(+pt.lat).toFixed(6)},${(+pt.lon).toFixed(6)}`;
  // Google Maps: one link for the whole route (start, stops in the given order, destination)
  function googleRouteUrl(origin, stops, destination) {
    const q = ['api=1', 'origin=' + coord(origin), 'destination=' + coord(destination), 'travelmode=driving'];
    if (stops.length) q.push('waypoints=' + encodeURIComponent(stops.slice(0, 9).map(coord).join('|'))); // 9 is the limit
    return 'https://www.google.com/maps/dir/?' + q.join('&');
  }
  const navLink = (href, label) => `<a class="navlink" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

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

  // ---------- trip back ----------
  // Where a person goes after the match: the return address when one is given, otherwise home.
  const returnPlaceOf = p => (p.returnMode === 'elsewhere' && p.retLat != null
    ? { lat: p.retLat, lon: p.retLon } : { lat: p.lat, lon: p.lon });
  const returnAddressOf = p => (p.returnMode === 'elsewhere' ? (p.retAddress || '') : (p.address || ''));
  // anything that differs from "everybody goes home the way they came"
  const isReturnException = (p, drives) => p.returnMode === 'elsewhere' ||
    (!drives && p.returnMode === 'self') || (drives && p.returnSeats != null && p.returnSeats < p.seats);

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
      const missingReturn = attendees.filter(p => p.returnMode === 'elsewhere' && p.retLat == null);
      if (missingReturn.length) return notice('bad', 'Chybí nalezená adresa návratu u: ' + missingReturn.map(nameOf).join(', ') + '.' + hint());
      const unsure = attendees.filter(p => p.warn || (p.returnMode === 'elsewhere' && p.retWarn))
        .concat(state.hall.warn ? [{ name: 'hala' }] : []);
      if (unsure.length) notice('warn', 'Adresa není jistá u: ' + unsure.map(nameOf).join(', ') + '. Plán s ní počítá, ale ověřte ji.');

      // fixed agreements ("Tam s"): a passenger rides with the named driver whatever the algorithm would prefer
      attendees.forEach(p => { p._pinned = false; });
      const driverIndex = new Map();
      attendees.forEach((p, i) => { if (DRIVER(p.status)) driverIndex.set(nameKey(p.name), i); });
      const ridesWith = attendees.map(() => null);
      const ignoredPins = [];
      attendees.forEach((p, i) => {
        const wanted = (p.ridesWithName || '').trim();
        if (!wanted || DRIVER(p.status)) return;
        const d = driverIndex.get(nameKey(wanted));
        if (d == null) ignoredPins.push(`${nameOf(p)} (${wanted})`); else ridesWith[i] = d;
      });
      if (ignoredPins.length) notice('warn', 'Dohoda „Tam s“ se ignoruje u: ' + ignoredPins.join(', ') + '. Ta řidička v plánu nejede jako řidička, nebo se jméno v tabulce neshoduje.');
      // the same for the way back ("Zpět s"); empty means "the same as there"
      const returnWithIdx = attendees.map(() => null);
      const ignoredBack = [];
      attendees.forEach((p, i) => {
        const wanted = (p.returnWithName || '').trim();
        if (!wanted || DRIVER(p.status) || p.returnMode === 'self') return;
        const d = driverIndex.get(nameKey(wanted));
        if (d == null) ignoredBack.push(`${nameOf(p)} (${wanted})`); else returnWithIdx[i] = d;
      });
      if (ignoredBack.length) notice('warn', 'Dohoda „Zpět s“ se ignoruje u: ' + ignoredBack.join(', ') + '. Ta řidička v plánu nejede jako řidička, nebo se jméno v tabulce neshoduje.');

      $('plan').disabled = true; $('planStatus').textContent = 'Počítám trasy…';
      const points = attendees.map(p => ({ lat: p.lat, lon: p.lon })).concat({ lat: state.hall.lat, lon: state.hall.lon });
      let dur, estimated = false;
      try { dur = await osrmMatrix(points); }
      catch (e) { dur = Planner.fallbackMatrix(points); estimated = true; }

      const people = attendees.map((p, i) => ({
        canDrive: DRIVER(p.status), mustDrive: p.status === 'must', seats: p.seats,
        ridesWith: ridesWith[i] != null ? ridesWith[i] : undefined,   // agreed to ride there with this driver
        returnWith: returnWithIdx[i] != null ? returnWithIdx[i] : undefined, // agreed to ride back with this driver
        needsReturnRide: p.returnMode !== 'self',   // false: gets home on their own
        returnSeats: DRIVER(p.status) && p.returnSeats != null ? p.returnSeats : undefined, // seats on the way back, driver included
      }));
      const result = Planner.plan({ dur, people, options: state.settings });

      if (result.error === 'PINNED_TOO_MANY') { $('plan').disabled = false; $('planStatus').textContent = ''; return notice('bad', `Do auta ${nameOf(attendees[result.driver])} je pevně zařazeno ${result.count} lidí, ale vejde se jich ${result.capacity}. Zrušte část dohod „Tam s“ nebo zvyšte počet míst.`); }
      if (result.error === 'PINNED_BACK_TOO_MANY') { $('plan').disabled = false; $('planStatus').textContent = ''; return notice('bad', `Zpět je do auta ${nameOf(attendees[result.driver])} pevně zařazeno ${result.count} lidí, ale zpět se vejde ${result.capacity}. Zrušte část dohod „Zpět s“ nebo zvyšte počet míst zpět.`); }
      if (result.error === 'PINNED_NOT_DRIVER') { $('plan').disabled = false; $('planStatus').textContent = ''; return notice('bad', `${nameOf(attendees[result.person])} má dohodnuto jet s ${nameOf(attendees[result.driver])}, která ale nemůže řídit.`); }
      if (result.error === 'NO_DRIVERS') { $('plan').disabled = false; $('planStatus').textContent = ''; return notice('bad', 'Nikdo zatím nenabídl auto. Aspoň jedna hráčka musí mít stav „Určitě beru auto“ nebo „Můžu vzít auto“.'); }
      if (result.error === 'NOT_ENOUGH_SEATS') { $('plan').disabled = false; $('planStatus').textContent = ''; return notice('bad', `Nedostatek míst v autech: chybí aspoň ${result.missing}. Další hráčka musí nabídnout auto, nebo někdo zvýšit počet míst.`); }
      if (result.error === 'NOT_ENOUGH_RETURN_SEATS') { $('plan').disabled = false; $('planStatus').textContent = ''; return notice('bad', `Zpět by chybělo aspoň ${result.missing} ${plural(result.missing, 'místo', 'místa', 'míst')}: řidičky nabízejí cestou zpět méně míst, než je potřeba pro ostatní. Je potřeba další řidička, která bude spolucestující vracet, nebo někdo zvýší počet míst zpět.`); }

      attendees.forEach((p, i) => {   // shown in the plan
        p._pinned = ridesWith[i] != null;
        p._pinnedBack = (returnWithIdx[i] != null ? returnWithIdx[i] : ridesWith[i]) != null;
      });
      const carOfPerson = i => (result.cars.find(c => c.passengers.includes(i)) || {}).driver;
      const returnsElsewhereCar = attendees.some((p, i) => returnWithIdx[i] != null && returnWithIdx[i] !== carOfPerson(i));

      // the trip back is planned only when somebody does not simply go home the way they came
      let back = null;
      const drivers = new Set(result.cars.map(c => c.driver));
      if (returnsElsewhereCar || attendees.some((p, i) => isReturnException(p, drivers.has(i)))) {
        const retPoints = attendees.map(returnPlaceOf).concat({ lat: state.hall.lat, lon: state.hall.lon });
        let durBack;
        try { durBack = await osrmMatrix(retPoints); }
        catch (e) { durBack = Planner.fallbackMatrix(retPoints); estimated = true; }
        back = Planner.planReturn({ dur: durBack, people, outbound: result, options: state.settings });
      }
      $('plan').disabled = false; $('planStatus').textContent = '';
      if (estimated) notice('warn', 'Veřejný routovací server není dostupný, časy jsou odhadnuté vzdušnou čarou. Skutečné časy se mohou lišit.');

      await renderResult(state, result, attendees, estimated, back);
    });

    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('msg').value); $('copyStatus').textContent = 'Zkopírováno.'; }
      catch (e) { $('msg').parentElement.open = true; $('msg').select(); $('copyStatus').textContent = 'Text označte a zkopírujte ručně.'; }
      setTimeout(() => { $('copyStatus').textContent = ''; }, 3000);
    });
  }

  async function renderResult(state, result, attendees, estimated, back) {
    const arrive = (() => { const [h, m] = state.arrive.split(':').map(Number); return h * 60 + m; })();
    const hallName = state.hall.address.trim();
    const lines = [`Zápas${state.dateText ? ' ' + state.dateText : ''} – sraz v hale ${state.arrive}${hallName ? ' (' + hallName + ')' : ''}`, ''];
    let html = `<p class="small" style="margin-top:0">${result.carCount} ${result.carCount === 1 ? 'auto' : result.carCount < 5 ? 'auta' : 'aut'}, celkem ${Math.round(result.totalDrivingMin)} minut jízdy${estimated ? ' (odhad)' : ''}.</p>`;

    // the times come from typical driving times: remind everyone to check live traffic before leaving
    html += `<p class="info">${esc(TIMES_DISCLAIMER)}</p>`;
    if (!back) html += `<p class="info">${esc(SAME_BACK)}</p>`;

    result.cars.forEach((car, i) => {
      const driver = attendees[car.driver];
      const depart = arrive - Math.ceil(car.totalMin);
      const color = COLORS[i % COLORS.length];
      const hallPoint = { lat: state.hall.lat, lon: state.hall.lon };
      const pointOf = node => (node === attendees.length ? hallPoint : attendees[node]);
      const stops = car.timeline.map((s, k) => {
        const when = fmtTime(depart + s.t);
        if (k === 0) return { t: when, text: `<b>${esc(nameOf(driver))}</b> vyjíždí z domu`, msg: `${nameOf(driver)} vyjíždí v ${when}` };
        if (k === car.timeline.length - 1) return { t: when, text: 'příjezd do haly', msg: `hala ${when}` };
        const p = attendees[s.node];
        const ride = car.rides[k - 1];
        return {
          t: when, text: `vyzvednout <b>${esc(nameOf(p))}</b> <span class="sub">${esc(p.address)} · v autě ${Math.round(ride.rideMin)} min</span>${p._pinned ? ' <span class="fixed-tag">dohodnuto</span>' : ''}`,
          msg: `${nameOf(p)} ${when}`,
        };
      });
      const route = googleRouteUrl(pointOf(car.driver), car.timeline.slice(1, -1).map(s => pointOf(s.node)), hallPoint);
      html += `<div class="car" style="border-left-color:${color}"><h3>Auto ${i + 1}: ${esc(nameOf(driver))} <span class="sub">(${car.passengers.length + 1} z ${driver.seats} míst)</span></h3><ol>` +
        stops.map(s => `<li><span class="t">${s.t}</span><span>${s.text}</span></li>`).join('') + '</ol>' +
        `<p class="car-foot">⏱ Celá cesta řidičky: <b>${fmtDuration(car.totalMin)}</b> · ${navLink(route, 'Trasa v Google Maps')}</p></div>`;
      lines.push(`🚗 ${stops.map(s => s.msg).join(' → ')}`);
    });

    if (back) html += renderBack(state, result, attendees, back, lines);
    else lines.push('', SAME_BACK_SHORT);

    lines.push('', TIMES_DISCLAIMER_SHORT);
    $('result').innerHTML = html;
    $('msg').value = lines.join('\n');
    $('resultSec').hidden = false;
    $('resultSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await renderMap(state, result, attendees);
  }

  // The trip back: returns the HTML and appends the matching lines of the group message.
  // No clock times (they are not needed); the driver's own destination is what matters most,
  // so the drop-offs are only a suggestion and the extra minutes are shown to her.
  function renderBack(state, result, attendees, back, lines) {
    const carNo = new Map(result.cars.map((c, i) => [c.driver, i + 1]));
    const moved = new Map(back.reshuffled.map(r => [r.person, r]));
    let html = '<h3 class="back-title">Cesta zpět</h3>' +
      '<p class="small" style="margin-top:0">Auta jsou stejná jako cestou tam a lidé se vracejí stejně. Přesouvají se jen ti, kdo mají domluvené jiné auto, pro které v autě zpět není místo, nebo kde změna výrazně zkrátí cestu (třeba když jedou na stejné místo). ' +
      'Směr řidičky je pro plán hlavní. Zda kvůli spolucestujícím zajede až k jejich adrese, je na domluvě s ní.</p>';
    lines.push('', '↩ Zpět:');
    back.cars.forEach(car => {
      const driver = attendees[car.driver];
      const color = COLORS[(carNo.get(car.driver) - 1) % COLORS.length];
      const elsewhere = driver.returnMode === 'elsewhere';
      const limited = driver.returnSeats != null && driver.returnSeats < driver.seats;
      const nobody = limited && driver.returnSeats <= 1;
      const room = limited ? driver.returnSeats - 1 : 0;   // passenger seats on the way back
      const roomText = `zpět max. ${room} ${plural(room, 'spolucestující', 'spolucestující', 'spolucestujících')}`;
      const dest = elsewhere ? `jinam (${esc(driver.retAddress || '')})` : 'domů';
      const items = car.passengers.map((pi, k) => {
        const p = attendees[pi], m = moved.get(pi);
        const note = m ? ` · přesun z auta ${carNo.get(m.fromDriver)}` : '';
        return `<li><span class="t">${k + 1}.</span><span>vysadit <b>${esc(nameOf(p))}</b> <span class="sub">${esc(returnAddressOf(p))}${note}</span>${p._pinnedBack ? ' <span class="fixed-tag">dohodnuto</span>' : ''}</span></li>`;
      });
      if (!items.length) items.push(`<li><span class="t"></span><span class="sub">${nobody ? 'nikoho nebere' : 'jede sama'}</span></li>`);
      else if (limited && !nobody) items.push(`<li><span class="t"></span><span class="sub">${roomText}</span></li>`);
      const hallPoint = { lat: state.hall.lat, lon: state.hall.lon };
      const goal = returnPlaceOf(driver);
      const extra = car.passengers.length && car.extraMin >= 1 ? ` · řidička jede o ${Math.round(car.extraMin)} min déle než přímo na svou adresu` : '';
      const route = googleRouteUrl(hallPoint, car.passengers.map(pi => returnPlaceOf(attendees[pi])), goal);
      html += `<div class="car" style="border-left-color:${color}"><h3>Auto ${carNo.get(car.driver)}: ${esc(nameOf(driver))} → ${dest}</h3><ol>${items.join('')}</ol>` +
        `<p class="car-foot">⏱ Celá cesta zpět: <b>${fmtDuration(car.totalMin)}</b>${extra} · ${navLink(route, 'Trasa v Google Maps')}</p></div>`;
      lines.push(`🚗 ${nameOf(driver)} (${elsewhere ? 'jinam' : 'domů'}${nobody ? ', nikoho nebere' : limited ? ', ' + roomText : ''}): ${car.passengers.map(pi => nameOf(attendees[pi])).join(' → ') || 'sama'}`);
    });
    if (back.reshuffled.length) {
      // names are not declined on purpose: "Dana (řidička tam: Anna, zpět: Hana)"
      const txt = back.reshuffled.map(r =>
        `${nameOf(attendees[r.person])} (řidička tam: ${nameOf(attendees[r.fromDriver])}, zpět: ${nameOf(attendees[r.toDriver])})`);
      html += `<p class="info">Změna oproti cestě tam: ${esc(txt.join('; '))}.</p>`;
      lines.push('Změna oproti cestě tam: ' + txt.join('; ') + '.');
    }
    if (back.unplaced.length) {
      const names = back.unplaced.map(pi => nameOf(attendees[pi])).join(', ');
      html += `<div class="notice bad">Zpět se nevešli: ${esc(names)}. Potřebují další odvoz.</div>`;
      lines.push(`⚠ Zpět zatím bez místa: ${names}.`);
    }
    if (back.selfReturn.length) {
      const names = back.selfReturn.map(pi => nameOf(attendees[pi])).join(', ');
      html += `<p class="small">Zpět bez odvozu (vrací se samy): ${esc(names)}.</p>`;
      lines.push(`Zpět se vrací samy: ${names}.`);
    }
    lines.push('Vyvezení zpět je návrh, zajížďky se domlouvají s řidičkou.');
    return html;
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

  root.Common = { $, esc, uid, nameOf, STATUS, DRIVER, ATTENDING, geoHtml, setupPlan, fmtDuration, googleRouteUrl };
})(window);
