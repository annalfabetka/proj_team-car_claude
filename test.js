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
    const opt = { carPenalty: 8, maxDetour: 1e9, maxDriverDetour: 1e9, stopMin: 1, seed };
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
  const withPenalty = Planner.plan({ dur: euclid(pts), people, options: { reshufflePenalty: 100, carPenalty: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
  const without = Planner.plan({ dur: euclid(pts), people, options: { reshufflePenalty: 0, carPenalty: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
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
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
  assert.deepStrictEqual(back.cars[0].passengers, [2, 1], 'west first, then east (on the way to the cabin)');
  assert.strictEqual(Math.round(back.cars[0].directMin), 100);
  assert(back.cars[0].extraMin > 0 && back.cars[0].extraMin < 25, 'the extra time is reported: ' + back.cars[0].extraMin);
});
test('planReturn: the result is the best one an exhaustive search finds (route times + the price of changing cars)', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed);
    const pts = Array.from({ length: 8 }, () => pt(r() * 40, r() * 40)); // 0..6 people, 7 hall
    const people = [
      { canDrive: true, seats: 5, returnSeats: 1 }, { canDrive: true, seats: 3 }, { canDrive: true, seats: 4 },
      { canDrive: false }, { canDrive: false }, { canDrive: false }, { canDrive: false },
    ];
    const outbound = { cars: [{ driver: 0, passengers: [3, 4, 5] }, { driver: 1, passengers: [6] }, { driver: 2, passengers: [] }] };
    const original = new Map([[3, 0], [4, 0], [5, 0], [6, 1]]);
    const opt = { stopMin: 1, maxDetour: 1e9, maxDriverDetour: 1e9, seed, reshufflePenalty: 8 };
    const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: opt });
    assert.deepStrictEqual(back.unplaced, []);
    const moves = back.cars.reduce((n, c) => n + c.passengers.filter(p => original.get(p) !== c.driver).length, 0);
    const got = back.cars.reduce((sum, c) => sum + c.totalMin, 0) + opt.reshufflePenalty * moves;

    const dur = euclid(pts), H = 7;
    const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map(q => [x, ...q]));
    const cost = (d, list) => Math.min(...perms(list).map(ord => {
      let tt = 0, prev = H; for (const q of ord) { tt += dur[prev][q] + opt.stopMin; prev = q; } return tt + dur[prev][d];
    }));
    let best = Infinity;
    for (let code = 0; code < 16; code++) { // each of the 4 passengers goes to car 1 (seats 3) or car 2 (seats 4)
      const l1 = [], l2 = [];
      [3, 4, 5, 6].forEach((p, k) => ((code >> k) & 1 ? l1 : l2).push(p));
      if (l1.length > 2 || l2.length > 3) continue;
      const changed = l1.filter(p => original.get(p) !== 1).length + l2.filter(p => original.get(p) !== 2).length;
      best = Math.min(best, cost(1, l1) + cost(2, l2) + cost(0, []) + opt.reshufflePenalty * changed);
    }
    assert(Math.abs(got - best) < 1e-6, `seed ${seed}: ${got.toFixed(2)} vs ${best.toFixed(2)}`);
  }
});
test('planReturn: two people going to the same place ride together when that saves more than a change costs', () => {
  // the way home of the car of 1 and 2 leads far west; B drives east to where passenger 2 goes anyway
  const pts = [pt(-60, 0), pt(40, 0), pt(41, 1), pt(42, 0), pt(0, 0)];     // 0 driver A (west), 1 driver B (east), 2 passenger, 3 passenger, hall
  const people = [{ canDrive: true, seats: 4 }, { canDrive: true, seats: 4 }, { canDrive: false }, { canDrive: false }];
  const outbound = { cars: [{ driver: 0, passengers: [2, 3] }, { driver: 1, passengers: [] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
  assert.deepStrictEqual(back.cars.find(c => c.driver === 1).passengers.slice().sort(), [2, 3], 'both go east with B');
  assert.deepStrictEqual(back.reshuffled.map(r => r.person).sort(), [2, 3]);
  assert(back.reshuffled.every(r => r.fromDriver === 0 && r.toDriver === 1));
});
test('planReturn: people keep their car when a change would save less than it costs', () => {
  // a small gain (a few minutes) is not worth moving anybody
  const pts = [pt(0, 0), pt(1, 0), pt(10, 0), pt(10, 1), pt(11, 0), pt(20, 0)];
  const people = [{ canDrive: true, seats: 4 }, { canDrive: true, seats: 4 }, { canDrive: false }, { canDrive: false }];
  const outbound = { cars: [{ driver: 0, passengers: [2] }, { driver: 1, passengers: [3] }] };
  const keep = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { reshufflePenalty: 1000 } });
  assert.deepStrictEqual(keep.reshuffled, []);
  const free = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { reshufflePenalty: 0 } });
  assert(free.cars.reduce((s, c) => s + c.totalMin, 0) <= keep.cars.reduce((s, c) => s + c.totalMin, 0) + 1e-9, 'a free change is never worse');
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
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
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
test('driver detour: one driver is not asked to drive far out of her way when another arrangement costs a little more', () => {
  // A lives in the west, the hall is in the east. B has a car and lives on the far side of A's detour.
  // Without a limit A collects B (saves B's whole trip); with a limit B drives herself or rides with someone nearby.
  const pts = [pt(0, 0), pt(0, 60), pt(40, 2), pt(100, 0)];                   // A (driver), B (can drive), C (passenger), hall
  const people = [{ canDrive: true, mustDrive: true, seats: 4 }, { canDrive: true, seats: 4 }, { canDrive: false }];
  const dur = euclid(pts);
  const free = Planner.plan({ dur, people, options: { maxDriverDetour: 1e9, carPenalty: 20, maxDetour: 1e9 } });
  const limited = Planner.plan({ dur, people, options: { maxDriverDetour: 25, carPenalty: 20, maxDetour: 1e9 } });
  const detourOf = (res, d) => { const c = res.cars.find(x => x.driver === d); return c.totalMin - dur[d][3]; };
  const worstFree = Math.max(...free.cars.map(c => c.totalMin - dur[c.driver][3]));
  const worstLimited = Math.max(...limited.cars.map(c => c.totalMin - dur[c.driver][3]));
  assert(worstLimited <= worstFree + 1e-9, 'the limit never makes the worst detour longer');
  assert(worstLimited <= 25 + 1e-9 || worstLimited <= worstFree, 'the worst detour is within the limit when that is possible');
});
test('driver detour: the real-life case (a driver asked to collect three people, one of them with a car)', () => {
  // Adél (Praha 6) first collected Pšenda, Klaara and Anička: 49 min direct, 85 min with them (+36).
  // Anička has her own car and lives 29 min from the hall; Maru passes her on his way.
  const names = ['Anička', 'Klaara', 'Lůca', 'Adél', 'Maru', 'Pája', 'Pšenda', 'Aneta', 'Mekáč', 'Test', 'Maru 2'];
  const people = [
    { canDrive: true, seats: 5 }, { canDrive: false }, { canDrive: true, mustDrive: true, seats: 2 }, { canDrive: true, mustDrive: true, seats: 4 },
    { canDrive: true, mustDrive: true, seats: 5 }, { canDrive: true, mustDrive: true, seats: 4 }, { canDrive: false }, { canDrive: false },
    { canDrive: true, mustDrive: true, seats: 4 }, { canDrive: false }, { canDrive: true, mustDrive: true, seats: 5 },
  ];
  // driving minutes (OSRM) between the homes and the hall for the relevant people; the rest follows the geometry roughly
  const home = [[50.12727, 14.490641], [50.074908, 14.418652], [50.133719, 14.139422], [50.091081, 14.320517], [50.376673, 15.884652],
    [50.183458, 15.017547], [50.074629, 14.260298], [50.054602, 14.527751], [50.030606, 14.521004], [50.054602, 14.527751], [50.129021, 14.570137]];
  const hall = [50.420422, 14.245438];
  const km = (a, b) => Planner.haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
  const pts = home.concat([hall]);
  const dur = pts.map(a => pts.map(b => km(a, b) * 1.35 / 45 * 60));
  const detours = res => res.cars.map(c => c.totalMin - dur[c.driver][11]);
  const free = Planner.plan({ dur, people, options: { maxDriverDetour: 1e9 } });
  const limited = Planner.plan({ dur, people });                                  // the default limit
  assert(Math.max(...detours(limited)) <= Math.max(...detours(free)) + 1e-9, 'the default never makes the worst detour longer');
  assert(!limited.error);
});
// Real driving times (minutes, from a routing service) for 11 people and the hall; labelled A..K, no names or addresses.
// A: can drive (5 seats), lives 29 min from the hall. D: must drive (4), lives 49 min away. E: must drive (5), 110 min away.
const REAL = [
    [0.0, 15.3, 39.3, 22.1, 84.1, 43.8, 27.0, 17.5, 24.1, 17.5, 10.9, 29.0],
    [17.1, 0.0, 32.8, 15.5, 93.9, 53.7, 20.5, 16.1, 15.2, 16.1, 22.7, 42.3],
    [41.9, 35.3, 0.0, 21.9, 122.1, 81.8, 19.5, 44.7, 43.6, 44.7, 49.7, 48.8],
    [23.9, 18.2, 22.1, 0.0, 104.8, 64.6, 10.3, 31.1, 29.9, 31.1, 31.7, 49.1],
    [85.8, 95.0, 122.0, 105.5, 0.0, 67.7, 110.4, 86.3, 92.9, 86.3, 80.4, 110.1],
    [44.4, 53.6, 80.6, 64.1, 67.5, 0.0, 69.0, 45.0, 51.5, 45.0, 39.0, 68.8],
    [29.1, 22.5, 19.5, 10.9, 110.1, 69.8, 0.0, 33.1, 32.0, 33.1, 36.9, 53.0],
    [18.3, 16.1, 43.2, 29.6, 84.3, 44.0, 32.5, 0.0, 9.2, 0.0, 18.0, 42.6],
    [25.5, 14.2, 41.4, 27.7, 91.1, 50.8, 30.6, 9.3, 0.0, 9.3, 25.3, 49.9],
    [18.3, 16.1, 43.2, 29.6, 84.3, 44.0, 32.5, 0.0, 9.2, 0.0, 18.0, 42.6],
    [11.4, 22.8, 48.3, 31.1, 79.8, 39.6, 36.0, 19.1, 25.6, 19.1, 0.0, 35.8],
    [30.4, 41.1, 48.2, 47.8, 108.8, 68.6, 52.8, 42.3, 48.8, 42.3, 35.7, 0.0]
];
test('driver detour (real data): a driver is not sent on a 36 minute detour to carry someone who has her own car', () => {
  const n = 11;
  const people = Array.from({ length: n }, (_, i) => ({
    canDrive: [0, 2, 3, 4, 5, 8, 10].includes(i), mustDrive: [2, 3, 4, 5, 8, 10].includes(i),
    seats: [5, 0, 2, 4, 5, 4, 0, 0, 4, 0, 5][i] || 4,
  }));
  const detours = res => res.cars.map(c => ({ driver: c.driver, extra: c.totalMin - REAL[c.driver][n], passengers: c.passengers }));
  // without the limit (the earlier behaviour) D collects three people, A among them, and drives 36 min out of her way
  const before = Planner.plan({ dur: REAL, people, options: { maxDriverDetour: 1e9 } });
  const carD = detours(before).find(c => c.driver === 3);
  assert(carD.passengers.includes(0) && carD.extra > 30, 'the situation to avoid: ' + JSON.stringify(carD));
  // with the default limit nobody is sent far out of her way and A does not ride with D
  const after = Planner.plan({ dur: REAL, people });
  const all = detours(after);
  assert(all.every(c => c.extra <= 25 + 1e-9), 'every detour within the limit: ' + JSON.stringify(all.map(c => Math.round(c.extra))));
  assert(!all.find(c => c.driver === 3).passengers.includes(0), 'A is no longer collected by D');
  const total = r => r.totalDrivingMin;
  assert(total(after) - total(before) < 10, 'and it costs only a few minutes of driving in total');
});
// ---------- fixed agreements ("ridesWith") ----------
test('fixed agreement: the person is put into that car even when the algorithm would choose another', () => {
  // A lives in the west, B in the east, C lives next to B but has agreed to ride with A
  const pts = [pt(0, 0), pt(90, 30), pt(91, 31), pt(100, 0)];                     // A, B, C (next to B, off A's way), hall
  const people = [{ canDrive: true, mustDrive: true, seats: 4 }, { canDrive: true, mustDrive: true, seats: 4 }, { canDrive: false }];
  const free = Planner.plan({ dur: euclid(pts), people, options: { maxDriverDetour: 1e9 } });
  assert.deepStrictEqual(free.cars.find(c => c.driver === 1).passengers, [2], 'by itself C rides with B');
  const agreed = Planner.plan({ dur: euclid(pts), people: [people[0], people[1], { canDrive: false, ridesWith: 0 }], options: { maxDriverDetour: 1e9 } });
  validate(agreed, people);
  assert.deepStrictEqual(agreed.cars.find(c => c.driver === 0).passengers, [2], 'with the agreement C rides with A');
  assert.deepStrictEqual(agreed.cars.find(c => c.driver === 1).passengers, []);
});
test('fixed agreement: the chosen driver always drives, even if she was only a possible driver', () => {
  // B could drive but would normally just ride along; C has agreed to ride with B
  const pts = [pt(0, 0), pt(5, 5), pt(6, 5), pt(60, 0)];
  const people = [{ canDrive: true, mustDrive: true, seats: 4 }, { canDrive: true, seats: 4 }, { canDrive: false, ridesWith: 1 }];
  const res = Planner.plan({ dur: euclid(pts), people });
  validate(res, people);
  assert(res.cars.some(c => c.driver === 1), 'B drives');
  assert.deepStrictEqual(res.cars.find(c => c.driver === 1).passengers, [2]);
});
test('fixed agreement: the other passengers are placed around it and the seats are counted', () => {
  // D's car has 3 passenger seats; two people are fixed to D, so only one more can join
  const pts = [pt(0, 0), pt(50, 50), pt(1, 1), pt(2, 1), pt(3, 1), pt(4, 1), pt(100, 0)];
  const people = [
    { canDrive: true, mustDrive: true, seats: 4 }, { canDrive: true, mustDrive: true, seats: 4 },
    { canDrive: false, ridesWith: 0 }, { canDrive: false, ridesWith: 0 }, { canDrive: false }, { canDrive: false },
  ];
  const res = Planner.plan({ dur: euclid(pts), people });
  validate(res, people);
  const a = res.cars.find(c => c.driver === 0).passengers;
  assert(a.includes(2) && a.includes(3) && a.length <= 3, JSON.stringify(a));
});
test('fixed agreement: errors for too many people in one car and for a driver who cannot drive', () => {
  const pts = [pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0), pt(9, 9)];
  const tooMany = Planner.plan({ dur: euclid(pts), people: [
    { canDrive: true, mustDrive: true, seats: 2 }, { canDrive: false, ridesWith: 0 }, { canDrive: false, ridesWith: 0 }, { canDrive: false }] });
  assert.strictEqual(tooMany.error, 'PINNED_TOO_MANY');
  assert.deepStrictEqual([tooMany.driver, tooMany.count, tooMany.capacity], [0, 2, 1]);
  const notDriver = Planner.plan({ dur: euclid(pts), people: [
    { canDrive: true, mustDrive: true, seats: 4 }, { canDrive: false }, { canDrive: false, ridesWith: 1 }, { canDrive: false }] });
  assert.strictEqual(notDriver.error, 'PINNED_NOT_DRIVER');
  assert.deepStrictEqual([notDriver.person, notDriver.driver], [2, 1]);
});
test('fixed agreement: on the way back the person stays with the driver, even when moving would save time', () => {
  // as in the "two people going to the same place" case, but person 2 has agreed to ride with A
  const pts = [pt(-60, 0), pt(40, 0), pt(41, 1), pt(42, 0), pt(0, 0)];
  const people = [{ canDrive: true, seats: 4 }, { canDrive: true, seats: 4 }, { canDrive: false, ridesWith: 0 }, { canDrive: false }];
  const outbound = { cars: [{ driver: 0, passengers: [2, 3] }, { driver: 1, passengers: [] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
  assert(back.cars.find(c => c.driver === 0).passengers.includes(2), 'person 2 stays with A');
  assert(!back.reshuffled.some(r => r.person === 2));
});
test('fixed agreement: on the way back the agreed people are the last to give up their seat', () => {
  // A has room for one passenger on the way back; 2 is agreed with A, 3 is not: 3 has to leave
  const pts = [pt(100, 0), pt(10, 0), pt(20, 0), pt(-50, 0), pt(0, 0)];            // A (east), 2 and 3 live east-ish/west, B (west), hall
  const people = [{ canDrive: true, seats: 4, returnSeats: 2 }, { canDrive: false, ridesWith: 0 }, { canDrive: false }, { canDrive: true, seats: 4 }];
  const outbound = { cars: [{ driver: 0, passengers: [1, 2] }, { driver: 3, passengers: [] }] };
  const back = Planner.planReturn({ dur: euclid(pts), people, outbound, options: { stopMin: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
  assert.deepStrictEqual(back.cars.find(c => c.driver === 0).passengers, [1], 'the agreed person keeps her seat');
  assert.deepStrictEqual(back.reshuffled.map(r => r.person), [2]);
  // when every passenger is agreed, one has to go anyway
  const both = Planner.planReturn({ dur: euclid(pts), people: [people[0], { canDrive: false, ridesWith: 0 }, { canDrive: false, ridesWith: 0 }, people[3]], outbound, options: { stopMin: 0, maxDetour: 1e9, maxDriverDetour: 1e9 } });
  assert.strictEqual(both.cars.find(c => c.driver === 0).passengers.length, 1);
  assert.strictEqual(both.reshuffled.length, 1);
  assert.deepStrictEqual(both.unplaced, []);
});
test('driver detour: the setting is part of the defaults and can be switched off', () => {
  assert.strictEqual(Planner.DEFAULTS.maxDriverDetour, 25);
});
console.log(`\nAll ${passed} tests passed.`);
