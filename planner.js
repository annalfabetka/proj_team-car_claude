/*
 * Carpool planner for match trips.
 *
 * Pure logic with no dependencies (runs in the browser and in Node).
 *
 * The task: a group of people travels to one hall and some have a car. Choose which
 * drivers go, whom they pick up and in what order, so that the total driving
 * time is as short as possible (and the number of cars as small as possible).
 *
 * Input plan({ dur, people, options }):
 *   dur      matrix of driving times in minutes; indices 0..n-1 are people's homes
 *            (in the same order as `people`), index n is the hall.
 *   people   [{ name, canDrive, mustDrive, seats }]  (seats = seats including the driver)
 *            Optional, for the trip back (see planReturn):
 *              needsReturnRide  false = gets home on their own, takes no seat on the way back (default true)
 *              returnSeats      drivers: seats in the car on the way back, driver included (default: as many as
 *                               on the way there; 1 = takes nobody back)
 *   options  { carPenalty, maxDetour, stopMin, restarts, seed }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    carPenalty: 20,  // how many minutes each additional car 'costs' (prefers fewer cars)
    maxDetour: 20,   // extra minutes over a direct ride that are still OK for a passenger
    stopMin: 2,      // time to get in at each pickup
    restarts: 25,    // number of random starts of the local search
    reshufflePenalty: 8, // minutes: a passenger riding with a driver who takes nobody back must change cars on the way back
    seed: 1,
  };
  const DETOUR_PENALTY = 3;     // soft penalty for each minute of detour above the limit
  const MAX_EXACT_ORDER = 6;    // try every pickup order up to this many passengers per car

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // Fallback when routing is unavailable: straight line x 1.35, average 45 km/h.
  function fallbackMatrix(points) {
    return points.map(a => points.map(b => (haversineKm(a, b) * 1.35 / 45) * 60));
  }

  // Passenger seats a driver offers on the way back: the seats on the way back (default: as many as on the
  // way there, never more) minus the driver herself.
  function returnCapacityOf(person) {
    const back = person.returnSeats == null ? person.seats : person.returnSeats;
    return Math.max(1, Math.min(back, person.seats)) - 1;
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    (function rec(cur, rest) {
      if (!rest.length) { out.push(cur); return; }
      for (let i = 0; i < rest.length; i++) {
        rec(cur.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
      }
    })([], arr);
    return out;
  }

  function subsets(items) {
    const out = [];
    for (let mask = 0; mask < (1 << items.length); mask++) {
      const s = [];
      for (let i = 0; i < items.length; i++) if (mask & (1 << i)) s.push(items[i]);
      out.push(s);
    }
    return out;
  }

  function plan({ dur, people, options }) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const n = people.length;
    const H = n; // index of the hall
    const all = people.map((_, i) => i);

    const candidates = all.filter(i => people[i].canDrive);
    const must = all.filter(i => people[i].mustDrive);
    if (!candidates.length) return { error: 'NO_DRIVERS' };

    // --- cost of one car (driver d + list of passengers) ---
    const memo = new Map();
    function evalOrder(d, order) {
      const times = [];
      let t = 0, prev = d;
      for (const p of order) {
        t += dur[prev][p];
        times.push(t);
        t += o.stopMin;
        prev = p;
      }
      t += dur[prev][H];
      const total = t;
      let penalty = 0;
      order.forEach((p, k) => {
        const ride = total - times[k] - o.stopMin;
        const excess = ride - dur[p][H] - o.maxDetour;
        if (excess > 0) penalty += excess * DETOUR_PENALTY;
      });
      return { cost: total + penalty, total, order, times };
    }
    function bestRoute(d, pass) {
      const key = d + ':' + pass.slice().sort((a, b) => a - b).join(',');
      let r = memo.get(key);
      if (r) return r;
      if (pass.length <= MAX_EXACT_ORDER) {
        for (const ord of permutations(pass)) {
          const c = evalOrder(d, ord);
          if (!r || c.cost < r.cost) r = c;
        }
      } else { // for unusually large cars: nearest neighbour
        const rest = pass.slice(), ord = [];
        let prev = d;
        while (rest.length) {
          let bi = 0;
          for (let i = 1; i < rest.length; i++) if (dur[prev][rest[i]] < dur[prev][rest[bi]]) bi = i;
          prev = rest.splice(bi, 1)[0];
          ord.push(prev);
        }
        r = evalOrder(d, ord);
      }
      memo.set(key, r);
      return r;
    }

    // --- which sets of drivers are worth considering ---
    const seatsOf = S => S.reduce((s, d) => s + people[d].seats, 0);
    const feasible = subsets(candidates).filter(S =>
      S.length > 0 && must.every(m => S.includes(m)) && seatsOf(S) >= n);
    if (!feasible.length) {
      const maxSeats = seatsOf(candidates);
      return { error: 'NOT_ENOUGH_SEATS', missing: Math.max(1, n - maxSeats) };
    }
    // the cars stay at the hall, so the drivers chosen now are the only ones who can take people back:
    // their free seats on the way back must cover everybody who needs a ride home
    const needsRide = i => people[i].needsReturnRide !== false;
    const returnCap = d => returnCapacityOf(people[d]);
    const returnShortfall = S => all.filter(i => !S.includes(i) && needsRide(i)).length -
      S.reduce((sum, d) => sum + returnCap(d), 0);
    const withReturn = feasible.filter(S => returnShortfall(S) <= 0);
    if (!withReturn.length) {
      return { error: 'NOT_ENOUGH_RETURN_SEATS', missing: Math.min(...feasible.map(returnShortfall)) };
    }
    const minSize = Math.min(...withReturn.map(S => S.length));
    const tryList = withReturn.filter(S => S.length <= minSize + 1);

    // --- optimise how passengers are split between cars for a fixed set of drivers ---
    function optimize(S, rng) {
      const P = all.filter(i => !S.includes(i));
      const cap = S.map(d => people[d].seats - 1);
      // passengers who will not fit into the car on the way back have to change cars later: small penalty each
      const cost = (c, list) => bestRoute(S[c], list).cost +
        o.reshufflePenalty * Math.max(0, list.filter(needsRide).length - returnCap(S[c]));
      let best = null;

      for (let r = 0; r < o.restarts; r++) {
        const order = P.slice();
        if (r === 0) order.sort((a, b) => dur[b][H] - dur[a][H]);
        else for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const cars = S.map(() => []);
        let ok = true;
        for (const p of order) { // insert into the car with the smallest increase
          let bc = -1, bd = Infinity;
          for (let c = 0; c < S.length; c++) {
            if (cars[c].length >= cap[c]) continue;
            const delta = cost(c, cars[c].concat(p)) - cost(c, cars[c]);
            if (delta < bd) { bd = delta; bc = c; }
          }
          if (bc < 0) { ok = false; break; }
          cars[bc].push(p);
        }
        if (!ok) continue;

        let improved = true;
        while (improved) { // moves and swaps while anything improves
          improved = false;
          for (let a = 0; a < S.length; a++) {
            for (const p of cars[a].slice()) {
              for (let b = 0; b < S.length; b++) {
                if (a === b) continue;
                const aWithout = cars[a].filter(x => x !== p);
                if (cars[b].length < cap[b]) {
                  const delta = cost(b, cars[b].concat(p)) + cost(a, aWithout) -
                    cost(a, cars[a]) - cost(b, cars[b]);
                  if (delta < -1e-9) {
                    cars[a] = aWithout; cars[b] = cars[b].concat(p);
                    improved = true; break;
                  }
                }
                for (const q of cars[b].slice()) {
                  const bSwap = cars[b].filter(x => x !== q).concat(p);
                  const aSwap = aWithout.concat(q);
                  const delta = cost(a, aSwap) + cost(b, bSwap) -
                    cost(a, cars[a]) - cost(b, cars[b]);
                  if (delta < -1e-9) {
                    cars[a] = aSwap; cars[b] = bSwap;
                    improved = true; break;
                  }
                }
                if (improved) break;
              }
              if (improved) break;
            }
            if (improved) break;
          }
        }
        const total = cars.reduce((s, l, c) => s + cost(c, l), 0) + o.carPenalty * S.length;
        if (!best || total < best.total) best = { total, cars: cars.map(l => l.slice()) };
      }
      return best && { S, total: best.total, cars: best.cars };
    }

    const rng = mulberry32(o.seed);
    let best = null;
    for (const S of tryList) {
      const r = optimize(S, rng);
      if (r && (!best || r.total < best.total)) best = r;
    }
    if (!best) return { error: 'NOT_ENOUGH_SEATS', missing: 1 };

    const cars = best.S.map((d, c) => {
      const route = bestRoute(d, best.cars[c]);
      const timeline = [{ node: d, t: 0 }];
      route.order.forEach((p, k) => timeline.push({ node: p, t: route.times[k] }));
      timeline.push({ node: H, t: route.total });
      return {
        driver: d,
        passengers: route.order,
        totalMin: route.total,
        timeline,
        rides: route.order.map((p, k) => ({
          person: p,
          rideMin: route.total - route.times[k] - o.stopMin,
          directMin: dur[p][H],
        })),
      };
    }).sort((a, b) => a.driver - b.driver);

    return {
      cars,
      totalDrivingMin: cars.reduce((s, c) => s + c.totalMin, 0),
      carCount: cars.length,
    };
  }

  /**
   * Plan for the trip back. The cars are the outbound cars (they are at the hall), so by default everyone
   * rides home in the same car as on the way there; people are moved only when their driver takes nobody back.
   *
   *   dur       matrix of driving times between the RETURN points: indices 0..n-1 are the places people go to
   *             (their own return address or home), index n is the hall
   *   people    same array as for plan() (needsReturnRide / returnSeats / seats are read)
   *   outbound  the result of plan()
   *
   * Every car goes hall -> drop-offs -> the driver's own return point. The driver's route is the primary one:
   * the drop-offs are only a suggestion (a driver may refuse a detour), so the result reports the extra minutes.
   */
  function planReturn({ dur, people, outbound, options }) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const n = people.length, H = n;
    const needsRide = i => people[i].needsReturnRide !== false;
    const capacity = d => returnCapacityOf(people[d]);

    const memo = new Map();
    function route(d, list) { // best drop-off order for driver d's car
      const key = d + ':' + list.slice().sort((x, y) => x - y).join(',');
      let r = memo.get(key);
      if (r) return r;
      let orders;
      if (list.length <= MAX_EXACT_ORDER) orders = permutations(list);
      else { // unusually large car: nearest neighbour from the hall
        const rest = list.slice(), ord = [];
        let prev = H;
        while (rest.length) {
          let bi = 0;
          for (let i = 1; i < rest.length; i++) if (dur[prev][rest[i]] < dur[prev][rest[bi]]) bi = i;
          prev = rest.splice(bi, 1)[0];
          ord.push(prev);
        }
        orders = [ord];
      }
      for (const ord of orders) {
        let t = 0, prev = H;
        const ride = [];
        for (const p of ord) { t += dur[prev][p]; ride.push(t); t += o.stopMin; prev = p; }
        const total = t + dur[prev][d];
        let penalty = 0;
        ord.forEach((p, k) => {
          const excess = ride[k] - dur[H][p] - o.maxDetour;
          if (excess > 0) penalty += excess * DETOUR_PENALTY;
        });
        const cand = { cost: total + penalty, total, order: ord, ride };
        if (!r || cand.cost < r.cost) r = cand;
      }
      memo.set(key, r);
      return r;
    }

    // start from the outbound groups. A car that takes back fewer people than it brought lets go of the ones
    // who fit worst (the largest extra time for the driver); they are placed again below.
    const fromDriver = new Map();
    outbound.cars.forEach(c => c.passengers.forEach(p => fromDriver.set(p, c.driver)));
    const base = outbound.cars.map(c => ({ driver: c.driver, pass: c.passengers.filter(needsRide) }));
    const orphans = [];
    base.forEach(c => {
      while (c.pass.length > capacity(c.driver)) {
        const full = route(c.driver, c.pass).cost;
        let worst = c.pass[0], gain = -Infinity;
        c.pass.forEach(p => {
          const g = full - route(c.driver, c.pass.filter(x => x !== p)).cost;
          if (g > gain) { gain = g; worst = p; }
        });
        c.pass = c.pass.filter(x => x !== worst);
        orphans.push(worst);
      }
    });
    const willing = base.map((_, i) => i).filter(i => capacity(base[i].driver) > 0);

    let cars = base.map(c => c.pass.slice());
    let unplaced = [];
    if (orphans.length) {
      const rng = mulberry32(o.seed);
      const cost = (ci, list) => route(base[ci].driver, list).cost;
      let best = null;
      for (let r = 0; r < o.restarts; r++) {
        const order = orphans.slice();
        if (r === 0) order.sort((a, b) => dur[H][b] - dur[H][a]);
        else for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const trial = base.map(c => c.pass.slice());
        const miss = [];
        for (const p of order) { // insert into the willing car where it adds the least
          let bc = -1, bd = Infinity;
          for (const ci of willing) {
            if (trial[ci].length >= capacity(base[ci].driver)) continue;
            const delta = cost(ci, trial[ci].concat(p)) - cost(ci, trial[ci]);
            if (delta < bd) { bd = delta; bc = ci; }
          }
          if (bc < 0) miss.push(p); else trial[bc].push(p);
        }
        const moved = new Set(orphans); // only the people being re-placed may move again
        let improved = true;
        while (improved) {
          improved = false;
          for (const a of willing) {
            for (const p of trial[a].slice()) {
              if (!moved.has(p)) continue;
              for (const b of willing) {
                if (a === b) continue;
                const aWithout = trial[a].filter(x => x !== p);
                if (trial[b].length < capacity(base[b].driver)) {
                  const delta = cost(b, trial[b].concat(p)) + cost(a, aWithout) - cost(a, trial[a]) - cost(b, trial[b]);
                  if (delta < -1e-9) { trial[a] = aWithout; trial[b] = trial[b].concat(p); improved = true; break; }
                }
                for (const q of trial[b].slice()) {
                  if (!moved.has(q)) continue;
                  const bSwap = trial[b].filter(x => x !== q).concat(p), aSwap = aWithout.concat(q);
                  const delta = cost(a, aSwap) + cost(b, bSwap) - cost(a, trial[a]) - cost(b, trial[b]);
                  if (delta < -1e-9) { trial[a] = aSwap; trial[b] = bSwap; improved = true; break; }
                }
                if (improved) break;
              }
              if (improved) break;
            }
            if (improved) break;
          }
        }
        const total = trial.reduce((sum, l, ci) => sum + cost(ci, l), 0);
        if (!best || miss.length < best.miss.length || (miss.length === best.miss.length && total < best.total)) {
          best = { total, trial, miss };
        }
      }
      cars = best.trial; unplaced = best.miss;
    }

    const orphanSet = new Set(orphans);
    const resultCars = base.map((c, ci) => {
      const r = route(c.driver, cars[ci]);
      const direct = dur[H][c.driver];
      return {
        driver: c.driver,
        passengers: r.order,
        totalMin: r.total,
        directMin: direct,
        extraMin: Math.max(0, r.total - direct), // how much longer than driving straight to her own destination
        rides: r.order.map((p, k) => ({ person: p, rideMin: r.ride[k], directMin: dur[H][p] })),
      };
    });
    const reshuffled = [];
    resultCars.forEach(c => c.passengers.forEach(p => {
      if (orphanSet.has(p)) reshuffled.push({ person: p, fromDriver: fromDriver.get(p), toDriver: c.driver });
    }));
    const selfReturn = people.map((_, i) => i).filter(i => fromDriver.has(i) && !needsRide(i));
    return { cars: resultCars, reshuffled, unplaced, selfReturn };
  }

  return { plan, planReturn, fallbackMatrix, haversineKm, DEFAULTS };
});
