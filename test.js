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

// ---------- the trip back ----------
// passenger seats a driver offers on the way back: the seats back (default: as many as there, never more) minus the driver
const returnSeatsOf = (people, res) => res.cars.reduce((sum, c) => {
  const p = people[c.driver];
  return sum + Math.max(1, Math.min(p.returnSeats == null ? p.seats : p.returnSeats, p.seats)) - 1;
}, 0);
const pt = (x, y) => ({ x, y });

test('return: drivers are chosen so that there are enough seats on the way back', () => {
  // A sits in the middle and would be the natural driver, but takes nobody back
  const pts = [pt(0, 0), pt(30, 30), pt(-2, 1), pt(1, -2), pt(-1, -1), pt(0, 5)];
  const people = [
    { canDrive: true, seats: 4, returnSeats: 1 },   // 0 A
    { canDrive: true, seats: 2 },                       // 1 B
    { canDrive: true, seats: 4 },                       // 2 C
    { canDrive: false }, { canDrive: false },           // 3, 4 passengers
  ];
  const res = Planner.plan({ dur: euclid(pts), people, options: { carPenalty: 5 } });
  validate(res, people);
  const demand = people.length - res.carCount;
  assert(returnSeatsOf(people, res) >= demand, 'the chosen cars must have room for everybody on the way back');
  assert(res.cars.some(c => c.driver === 2), 'C (who takes people back) must drive');
});
test('return: an error when no choice of drivers has enough seats back', () => {
  const pts = [pt(0, 0), pt(1, 0), pt(5, 5)];
  const people = [{ canDrive: true, seats: 4, returnSeats: 1 }, { canDrive: false }];
  const res = Planner.plan({ dur: euclid(pts), people });
  assert.strictEqual(res.error, 'NOT_ENOUGH_RETURN_SEATS');
  assert.strictEqual(res.missing, 1);
});
test('return: people who get home on their own do not need a seat back', () => {
  const pts = [pt(0, 0), pt(1, 0), pt(5, 5)];
  const people = [{ canDrive: true, seats: 4, returnSeats: 1 }, { canDrive: false, needsReturnRide: false }];
  const res = Planner.plan({ dur: euclid(pts), people });
  assert(!res.error, 'nobody needs a ride back, so a driver who takes nobody is fine');
  validate(res, people);
});
test('return: without any return information the plan is exactly the same as before', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = rng(seed);
    const n = 8;
    const pts = Array.from({ length: n + 1 }, () => pt(r() * 40, r() * 40));
    const base = Array.from({ length: n }, (_, i) => ({ canDrive: i < 3, seats: 4 }));
    const explicit = base.map(p => Object.assign({ needsReturnRide: true, returnSeats: p.seats }, p));
    const a = Planner.plan({ dur: euclid(pts), people: base, options: { seed } });
    const b = Planner.plan({ dur: euclid(pts), people: explicit, options: { seed } });
    assert.deepStrictEqual(a, b);
  }
});
test('return: passengers prefer a driver who also takes them back (the penalty has effect)', () => {
  // A (west, takes nobody back) is closest to the passengers, B is far east
  const pts = [pt(-10, 0), pt(40, 0), pt(-12, 1), pt(-11, -1), pt(-13, 0), pt(0, 0)];
  const people = [
    { canDrive: true, seats: 5, returnSeats: 1 }, { canDrive: true, seats: 4 },
    { canDrive: false }, { canDrive: false }, { canDrive: false },
  ];
  const withPenalty = Planner.plan({ dur: euclid(pts), people, options: { reshufflePenalty: 100, carPenalty: 0, maxDetour: 1e9 } });
  const without = Planner.plan({ dur: euclid(pts), people, options: { reshufflePenalty: 0, carPenalty: 0, maxDetour: 1e9 } });
  const carOf = (res, d) => res.cars.find(c => c.driver === d);
  assert.strictEqual(carOf(withPenalty, 0).passengers.length, 0, 'with the penalty nobody rides with A');
  assert.strictEqual(carOf(withPenalty, 1).passengers.length, 3);
  assert(carOf(without, 0).passengers.length > 0, 'without the penalty the nearby driver is used');
});

test('planReturn: by default everyone rides home in the same car as on the way there', () => {
  const r = rng(7);
  const n = 9;
  const pts = Array.from({ length: n + 1 }, () => pt(r() * 40, r() * 40));
  const people = Array.from({ length: n }, (_, i) => ({ canDrive: i < 3, seats: 4 }));
  const out = Planner.plan({ dur: euclid(pts), people });
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound: out });
  assert.deepStrictEqual(back.reshuffled, []); assert.deepStrictEqual(back.unplaced, []);
  out.cars.forEach(c => {
    const b = back.cars.find(x => x.driver === c.driver);
    assert.deepStrictEqual(b.passengers.slice().sort(), c.passengers.slice().sort(), 'same people in the same car');
  });
});
test('planReturn: only people whose driver takes nobody back change cars', () => {
  // cars: A drives 2,3; B drives 4; C drives 5. A takes nobody back; B and C have a free seat each
  const pts = [pt(0, 0), pt(10, 0), pt(-10, 0), pt(-3, 1), pt(-2, 2), pt(11, 1), pt(-4, -1), pt(0, 0)];
  const people = [
    { canDrive: true, seats: 4, returnSeats: 1 }, { canDrive: true, seats: 3 }, { canDrive: true, seats: 3 },
    { canDrive: false }, { canDrive: false }, { canDrive: false },
  ];
  const outbound = { cars: [
    { driver: 0, passengers: [3, 4] }, { driver: 1, passengers: [5] }, { driver: 2, passengers: [] },
  ] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound });
  assert.deepStrictEqual(back.cars.find(c => c.driver === 0).passengers, [], 'A takes nobody');
  assert.deepStrictEqual(back.unplaced, []);
  assert.deepStrictEqual(back.reshuffled.map(r => r.person).sort(), [3, 4]);
  assert(back.reshuffled.every(r => r.fromDriver === 0 && r.toDriver !== 0));
  assert.deepStrictEqual(back.cars.find(c => c.driver === 1).passengers.includes(5), true, 'the others stay where they were');
  const placed = back.cars.flatMap(c => c.passengers).sort();
  assert.deepStrictEqual(placed, [3, 4, 5]);
  back.cars.forEach(c => assert(c.passengers.length <= people[c.driver].seats - 1, 'capacity respected'));
});
test('planReturn: someone who gets home on their own is not planned and frees a seat', () => {
  const pts = [pt(0, 0), pt(-5, 0), pt(5, 0), pt(0, 0)];
  const people = [{ canDrive: true, seats: 3 }, { canDrive: false, needsReturnRide: false }, { canDrive: false }];
  const outbound = { cars: [{ driver: 0, passengers: [1, 2] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound });
  assert.deepStrictEqual(back.cars[0].passengers, [2]);
  assert.deepStrictEqual(back.selfReturn, [1]);
});
test("planReturn: the driver's own destination shapes the route (drop-offs on the way come first)", () => {
  // hall at the origin; the driver goes far east (the cabin); one passenger lives east, one west
  const pts = [pt(100, 0), pt(10, 0), pt(-10, 0), pt(0, 0)];
  const people = [{ canDrive: true, seats: 3 }, { canDrive: false }, { canDrive: false }];
  const outbound = { cars: [{ driver: 0, passengers: [1, 2] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9 } });
  assert.deepStrictEqual(back.cars[0].passengers, [2, 1], 'west first, then east (on the way to the cabin)');
  assert.strictEqual(Math.round(back.cars[0].directMin), 100);
  assert(back.cars[0].extraMin > 0 && back.cars[0].extraMin < 25, 'the extra time is reported: ' + back.cars[0].extraMin);
});
test('planReturn: the placement of re-seated people equals an exhaustive search', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed);
    const pts = Array.from({ length: 8 }, () => pt(r() * 40, r() * 40)); // 0..6 people, 7 hall
    const people = [
      { canDrive: true, seats: 5, returnSeats: 1 }, { canDrive: true, seats: 3 }, { canDrive: true, seats: 4 },
      { canDrive: false }, { canDrive: false }, { canDrive: false }, { canDrive: false },
    ];
    const outbound = { cars: [{ driver: 0, passengers: [3, 4, 5] }, { driver: 1, passengers: [6] }, { driver: 2, passengers: [] }] };
    const opt = { stopMin: 1, maxDetour: 1e9, seed };
    const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: opt });
    const got = back.cars.reduce((sum, c) => sum + c.totalMin, 0);
    assert.deepStrictEqual(back.unplaced, []);

    const dur = euclid(pts), H = 7;
    const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map(q => [x, ...q]));
    const cost = (d, list) => Math.min(...perms(list).map(ord => {
      let t = 0, prev = H; for (const q of ord) { t += dur[prev][q] + opt.stopMin; prev = q; } return t + dur[prev][d];
    }));
    let best = Infinity;
    for (let code = 0; code < 8; code++) { // each of the 3 orphans goes to car 1 or car 2
      const l1 = [6], l2 = [];
      [3, 4, 5].forEach((p, k) => ((code >> k) & 1 ? l1 : l2).push(p));
      if (l1.length > 2 || l2.length > 3) continue;
      best = Math.min(best, cost(1, l1) + cost(2, l2) + cost(0, []));
    }
    assert(Math.abs(got - best) < 1e-6, `seed ${seed}: ${got.toFixed(2)} vs ${best.toFixed(2)}`);
  }
});
test('planReturn: reports people who cannot be placed when there is not enough room', () => {
  const pts = [pt(0, 0), pt(5, 0), pt(-5, 0), pt(0, 5), pt(0, 0)];
  const people = [
    { canDrive: true, seats: 3, returnSeats: 1 }, { canDrive: true, seats: 2 },
    { canDrive: false }, { canDrive: false },
  ];
  const outbound = { cars: [{ driver: 0, passengers: [2, 3] }, { driver: 1, passengers: [] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound });
  assert.strictEqual(back.unplaced.length, 1, 'one seat is missing');
  assert.strictEqual(back.cars.flatMap(c => c.passengers).length, 1);
});

test('return seats: a driver with fewer seats back counts with the smaller number', () => {
  // A has 4 seats there but only 2 on the way back (1 passenger); B and C are normal cars
  const pts = [pt(0, 0), pt(30, 30), pt(-30, 30), pt(1, 1), pt(-1, 1), pt(1, -1), pt(0, 3), pt(0, 0)];
  const people = [
    { canDrive: true, seats: 4, returnSeats: 2 }, { canDrive: true, seats: 4 }, { canDrive: true, seats: 4 },
    { canDrive: false }, { canDrive: false }, { canDrive: false }, { canDrive: false },
  ];
  const res = Planner.plan({ dur: euclid(pts), people, options: { carPenalty: 5 } });
  validate(res, people);
  assert(returnSeatsOf(people, res) >= people.length - res.carCount, 'enough seats on the way back');
});
test('return seats: not enough seats back is reported with the right number', () => {
  const pts = [pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0), pt(0, 5)];
  const people = [{ canDrive: true, seats: 4, returnSeats: 2 }, { canDrive: false }, { canDrive: false }, { canDrive: false }];
  const res = Planner.plan({ dur: euclid(pts), people });
  assert.strictEqual(res.error, 'NOT_ENOUGH_RETURN_SEATS');
  assert.strictEqual(res.missing, 2, '3 people need a ride back, the car takes 1');
});
test('return seats: more seats back than there is ignored (never more than the car has)', () => {
  const pts = [pt(0, 0), pt(1, 0), pt(0, 5)];
  const people = [{ canDrive: true, seats: 2, returnSeats: 9 }, { canDrive: false }];
  const res = Planner.plan({ dur: euclid(pts), people });
  assert(!res.error); validate(res, people);
});
test('planReturn: a car with fewer seats back lets go of the passengers who fit worst', () => {
  // driver 0 heads east (her own destination at x=100) with 3 passengers from the way there, but has room for 1
  const pts = [pt(100, 0), pt(10, 0), pt(-40, 0), pt(-50, 0), pt(30, 0), pt(0, 0)];  // 0 driver, 1..3 passengers, 4 driver B, hall
  const people = [{ canDrive: true, seats: 4, returnSeats: 2 }, { canDrive: false }, { canDrive: false }, { canDrive: false }, { canDrive: true, seats: 4 }];
  const outbound = { cars: [{ driver: 0, passengers: [1, 2, 3] }, { driver: 4, passengers: [] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9 } });
  const a = back.cars.find(c => c.driver === 0), b = back.cars.find(c => c.driver === 4);
  assert.deepStrictEqual(a.passengers, [1], 'only the passenger on her way (east) stays');
  assert.deepStrictEqual(b.passengers.slice().sort(), [2, 3]);
  assert.deepStrictEqual(back.reshuffled.map(r => r.person).sort(), [2, 3]);
  assert(back.reshuffled.every(r => r.fromDriver === 0 && r.toDriver === 4));
  assert.deepStrictEqual(back.unplaced, []);
});
test('planReturn: nobody has to move when the passengers fit into the seats back', () => {
  const pts = [pt(100, 0), pt(10, 0), pt(20, 0), pt(0, 0)];
  const people = [{ canDrive: true, seats: 4, returnSeats: 3 }, { canDrive: false }, { canDrive: false }];
  const outbound = { cars: [{ driver: 0, passengers: [1, 2] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound });
  assert.deepStrictEqual(back.cars[0].passengers.slice().sort(), [1, 2]);
  assert.deepStrictEqual(back.reshuffled, []);
});
console.log(`\nAll ${passed} tests passed.`);
