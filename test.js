// Run: node test.js
const assert = require('assert');
const Planner = require('./planner.js');

function euclid(points, perUnit = 1) {
  return points.map(a => points.map(b => Math.hypot(a.x - b.x, a.y - b.y) * perUnit));
}
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function validate(res, people) {
  const n = people.length;
  const seen = new Set();
  for (const c of res.cars) {
    assert(people[c.driver].canDrive, 'a driver must have a car');
    assert(c.passengers.length + 1 <= people[c.driver].seats, 'capacity exceeded');
    for (const x of [c.driver, ...c.passengers]) {
      assert(!seen.has(x), 'osoba ve dvou autech'); seen.add(x);
    }
  }
  assert.strictEqual(seen.size, n, 'someone was left without a seat');
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

// 1) Two groups on opposite sides of the hall are split into two cars by where they live.
test('splits people by area', () => {
  const pts = [
    { x: -10, y: 0 }, { x: -11, y: 1 }, { x: -9, y: -1 },   // 0 (driver), 1, 2 - west
    { x: 10, y: 0 }, { x: 11, y: 1 }, { x: 9, y: -1 },      // 3 (driver), 4, 5 - east
    { x: 0, y: 0 },                                         // hall
  ];
  const people = pts.slice(0, 6).map((_, i) => ({
    name: 'P' + i, canDrive: i === 0 || i === 3, seats: 4,
  }));
  const res = Planner.plan({ dur: euclid(pts), people, options: { carPenalty: 5 } });
  validate(res, people);
  assert.strictEqual(res.carCount, 2);
  const west = res.cars.find(c => c.driver === 0), east = res.cars.find(c => c.driver === 3);
  assert.deepStrictEqual(west.passengers.slice().sort(), [1, 2]);
  assert.deepStrictEqual(east.passengers.slice().sort(), [4, 5]);
});

// 2) The heuristic finds the same optimum as an exhaustive search (small instances).
test('matches an exhaustive search', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const r = rng(seed);
    const n = 6;
    const pts = Array.from({ length: n + 1 }, () => ({ x: r() * 40, y: r() * 40 }));
    const people = Array.from({ length: n }, (_, i) => ({
      name: 'P' + i, canDrive: i < 3, seats: 3 + Math.floor(r() * 2),
    }));
    const dur = euclid(pts);
    const opt = { carPenalty: 8, maxDetour: 1e9, stopMin: 1, seed };
    const res = Planner.plan({ dur, people, options: opt });
    validate(res, people);
    const got = res.totalDrivingMin + opt.carPenalty * res.carCount;

    // exhaustive search: every subset of drivers x every assignment x every order
    const H = n;
    function carCost(d, order) {
      let t = 0, prev = d;
      for (const p of order) { t += dur[prev][p] + opt.stopMin; prev = p; }
      return t + dur[prev][H];
    }
    function perms(a) {
      if (a.length <= 1) return [a];
      return a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map(p => [x, ...p]));
    }
    let best = Infinity;
    for (let mask = 1; mask < 8; mask++) {
      const S = [0, 1, 2].filter(i => mask & (1 << i));
      if (S.reduce((s, d) => s + people[d].seats, 0) < n) continue;
      const P = [...Array(n).keys()].filter(i => !S.includes(i));
      const k = S.length;
      for (let code = 0; code < k ** P.length; code++) {
        const cars = S.map(() => []);
        let c = code;
        P.forEach(p => { cars[c % k].push(p); c = Math.floor(c / k); });
        if (cars.some((l, i) => l.length + 1 > people[S[i]].seats)) continue;
        const cost = cars.reduce((s, l, i) =>
          s + Math.min(...perms(l).map(o => carCost(S[i], o))), 0) + opt.carPenalty * k;
        if (cost < best) best = cost;
      }
    }
    assert(Math.abs(got - best) < 1e-6, `seed ${seed}: plan ${got.toFixed(2)} vs optimum ${best.toFixed(2)}`);
  }
});

// 3) Realistic size: 15 people, 5 cars to choose from - fast and valid.
test('15 people, 5 drivers - fast and valid', () => {
  const r = rng(42);
  const n = 15;
  const pts = Array.from({ length: n + 1 }, () => ({ x: r() * 30, y: r() * 30 }));
  const people = Array.from({ length: n }, (_, i) => ({
    name: 'P' + i, canDrive: i < 5, seats: 4,
  }));
  const t0 = Date.now();
  const res = Planner.plan({ dur: euclid(pts), people, options: {} });
  const ms = Date.now() - t0;
  validate(res, people);
  assert(res.carCount >= 4, 'with 15 people and 4 seats per car at least 4 cars are needed');
  assert(ms < 5000, `trvalo ${ms} ms`);
  console.log(`      (${res.carCount} cars, ${res.totalDrivingMin.toFixed(0)} min in total, ${ms} ms)`);
});

// 4) 'Must drive' and error states.
test("respects 'must drive'", () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 50, y: 50 }];
  const people = [
    { name: 'A', canDrive: true, mustDrive: false, seats: 4 },
    { name: 'B', canDrive: true, mustDrive: true, seats: 4 },
    { name: 'C', seats: 0 }, { name: 'D', seats: 0 },
  ].map(p => Object.assign({ canDrive: false, mustDrive: false }, p));
  const res = Planner.plan({ dur: euclid(pts), people, options: {} });
  validate(res, people);
  assert(res.cars.some(c => c.driver === 1));
});
test('errors: no car / not enough seats', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const dur = euclid(pts);
  assert.strictEqual(Planner.plan({ dur, people: [{ canDrive: false }, { canDrive: false }] }).error, 'NO_DRIVERS');
  const r = Planner.plan({
    dur, people: [{ canDrive: true, seats: 1 }, { canDrive: false }],
  });
  assert.strictEqual(r.error, 'NOT_ENOUGH_SEATS');
  assert.strictEqual(r.missing, 1);
});

// 5) Timeline: pickup times add up consistently.
test('timeline is consistent', () => {
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  const people = [{ canDrive: true, seats: 4 }, { canDrive: false }, { canDrive: false }];
  const res = Planner.plan({ dur: euclid(pts), people, options: { stopMin: 2 } });
  const c = res.cars[0];
  assert.deepStrictEqual(c.passengers, [1, 2]);
  assert.strictEqual(c.timeline[0].t, 0);
  assert.strictEqual(c.timeline[c.timeline.length - 1].t, c.totalMin);
  assert.strictEqual(c.totalMin, 5 + 2 + 5 + 2 + 10);
});

console.log(`\nAll ${passed} tests passed.`);
