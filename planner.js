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
    const minSize = Math.min(...feasible.map(S => S.length));
    const tryList = feasible.filter(S => S.length <= minSize + 1);

    // --- optimise how passengers are split between cars for a fixed set of drivers ---
    function optimize(S, rng) {
      const P = all.filter(i => !S.includes(i));
      const cap = S.map(d => people[d].seats - 1);
      const cost = (c, list) => bestRoute(S[c], list).cost;
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

  return { plan, fallbackMatrix, haversineKm, DEFAULTS };
});
