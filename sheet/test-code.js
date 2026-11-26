// Tests the Apps Script against a simulated Google Sheets. Run: node sheet/test-code.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

// --- simulated sheet ---
let cells = new Map();
const key = (r, c) => r + ',' + c;
const calls = { geocode: 0, alerts: [], frozen: null };
let uiAnswer = 'YES';
let triggers = [];
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() }); // any formatting call = no-op

function makeRange(sheet, r, c, nr = 1, nc = 1) {
  const self = {
    getRow: () => r, getColumn: () => c, getLastRow: () => r + nr - 1, getLastColumn: () => c + nc - 1,
    getSheet: () => sheet,
    getValue: () => (cells.has(key(r, c)) ? cells.get(key(r, c)) : ''),
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells.get(key(r + i, c + j)) ?? '')),
    setValue: v => { cells.set(key(r, c), v); return proxied; },
    setFormula: f => { cells.set(key(r, c), f); return proxied; },
    setValues: vs => { vs.forEach((row, i) => row.forEach((v, j) => cells.set(key(r + i, c + j), v))); return proxied; },
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.delete(key(r + i, c + j)); return proxied; },
    protect: () => ({ setWarningOnly: () => {} }),
  };
  // unknown methods (formatting etc.) return the same range, as in Sheets, so calls can be chained
  const proxied = new Proxy(self, { get: (t, p) => (p in t ? t[p] : () => proxied) });
  return proxied;
}
const sheet = {
  getName: () => 'Tým', setName() {},
  getLastRow: () => Math.max(0, ...[...cells.keys()].map(k => +k.split(',')[0])),
  getLastColumn: () => 8,
  getConditionalFormatRules: () => [],
  clear: () => cells.clear(),
  insertRowBefore(n) {
    const next = new Map();
    cells.forEach((v, k) => { const [r, c] = k.split(',').map(Number); next.set(key(r >= n ? r + 1 : r, c), v); });
    cells = next;
  },
  setFrozenRows(n) { calls.frozen = n; },
  getRange(a, b, c, d) {
    if (typeof a === 'string') { // 'B2', 'A1:A2'
      const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(a);
      const col = ch => ch.charCodeAt(0) - 64;
      return makeRange(sheet, +m[2], col(m[1]), m[4] ? +m[4] - +m[2] + 1 : 1, m[3] ? col(m[3]) - col(m[1]) + 1 : 1);
    }
    return makeRange(sheet, a, b, c || 1, d || 1);
  },
};
['clearConditionalFormatRules', 'setColumnWidth', 'setConditionalFormatRules'].forEach(n => { sheet[n] = () => {}; });
const ss = { getSheetByName: n => (n === 'Tým' ? sheet : null), getSheets: () => [sheet], insertSheet: () => sheet, toast() {} };

// --- simulated geocoder ---
const answers = {
  'vinohradská 12, praha': { status: 'OK', results: [{ types: ['street_address'], formatted_address: 'Vinohradská 12, 120 00 Praha 2', geometry: { location: { lat: 50.0755381, lng: 14.4378005 } } }] },
  'praha': { status: 'OK', results: [{ types: ['locality', 'political'], formatted_address: 'Praha', geometry: { location: { lat: 50.08, lng: 14.42 } } }] },
  'vinohradska 12 prha': { status: 'OK', results: [{ types: ['street_address'], partial_match: true, formatted_address: 'Vinohradská 12, Praha', geometry: { location: { lat: 50.07, lng: 14.43 } } }] },
  'asdfgh qwerty': { status: 'ZERO_RESULTS', results: [] },
  'limit': { status: 'OVER_QUERY_LIMIT', results: [] },
  'boom': null, // throws an error
};
const sandbox = {
  console,
  SpreadsheetApp: {
    getActive: () => ss,
    getUi: () => ({ alert: m => { calls.alerts.push(m); return uiAnswer; }, ButtonSet: { YES_NO: 1 }, Button: { YES: 'YES' }, createMenu: () => chain() }),
    newDataValidation: () => chain(), newConditionalFormatRule: () => chain(),
  },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
    newTrigger: name => ({
      forSpreadsheet() { return this; }, onEdit() { return this; },
      create() { triggers.push({ getHandlerFunction: () => name }); },
    }),
    deleteTrigger: t => { triggers = triggers.filter(x => x !== t); },
  },
  CacheService: (() => { const m = new Map(); return { getScriptCache: () => ({ get: k => m.get(k) ?? null, put: (k, v) => m.set(k, v) }) }; })(),
  Utilities: { base64EncodeWebSafe: s => Buffer.from(String(s)).toString('base64url'), computeDigest: (_, s) => Buffer.from(String(s)), DigestAlgorithm: { MD5: 'MD5' } },
  Maps: {
    newGeocoder: () => ({
      setRegion() { return this; }, setLanguage() { return this; },
      geocode(addr) {
        calls.geocode++;
        const a = answers[addr.toLowerCase()];
        if (a === null) throw new Error('boom');
        return a || { status: 'ZERO_RESULTS', results: [] };
      },
    }),
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
const { LINK_ROW, HALL_ROW, DATE_ROW, TIME_ROW, HEADER_ROW, FIRST_ROW, COL } = sandbox; // the row numbers are taken from the script
const get = (r, c) => cells.get(key(r, c)) ?? '';
const edit = (r, c, nr = 1, nc = 1) => sandbox.onEditCheck({ range: makeRange(sheet, r, c, nr, nc) });
const row = k => FIRST_ROW + k; // the k-th player

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

test('layout: link -> hall -> date -> time -> header -> players', () => {
  assert(LINK_ROW < HALL_ROW && HALL_ROW < DATE_ROW && DATE_ROW < TIME_ROW && TIME_ROW < HEADER_ROW && HEADER_ROW < FIRST_ROW);
  assert.strictEqual(LINK_ROW, 1, 'the link row must be at the very top');
});
test('setup() creates the labels, the header and an empty cell for the link', () => {
  sandbox.setup();
  assert.strictEqual(get(LINK_ROW, COL.NAME), 'Odkaz pro aplikaci');
  assert.strictEqual(get(LINK_ROW, COL.ADDR), '');
  assert.strictEqual(get(HALL_ROW, COL.NAME), 'Hala (adresa)');
  assert.strictEqual(get(TIME_ROW, COL.ADDR), '18:30');
  assert.strictEqual(get(DATE_ROW, COL.NAME), 'Datum zápasu');
  assert.strictEqual(get(DATE_ROW, COL.ADDR), '', 'the date is filled in by hand');
  assert.strictEqual(get(HEADER_ROW, COL.NAME), 'Jméno'); assert.strictEqual(get(HEADER_ROW, COL.CHECK), 'Kontrola adresy');
});
test('weekday: formula in Czech, independent of the sheet language', () => {
  const f = get(DATE_ROW, COL.STATUS);
  assert(f.startsWith('=IF(B' + DATE_ROW + '="","",'), f);
  assert(f.includes('WEEKDAY(B' + DATE_ROW + ',2)'), 'the week starts on Monday');
  assert(f.includes('"pondělí","úterý","středa","čtvrtek","pátek","sobota","neděle"'), f);
});
test('precise address -> check mark, found address and coordinates as text with a decimal point', () => {
  cells.set(key(row(0), 2), 'Vinohradská 12, Praha'); edit(row(0), 2);
  assert.strictEqual(get(row(0), 5), '✓ Adresa nalezena');
  assert.strictEqual(get(row(0), 6), 'Vinohradská 12, 120 00 Praha 2');
  assert.strictEqual(get(row(0), 7), '50.075538'); assert.strictEqual(get(row(0), 8), '14.437801');
  assert.strictEqual(typeof get(row(0), 7), 'string');
});
test('city only -> warning, coordinates are not filled in', () => {
  cells.set(key(row(1), 2), 'Praha'); edit(row(1), 2);
  assert(get(row(1), 5).startsWith('⚠ Upřesněte')); assert.strictEqual(get(row(1), 7), ''); assert.strictEqual(get(row(1), 8), '');
  assert.strictEqual(get(row(1), 6), 'Praha');
});
test('partial match (typo) -> warning, coordinates are kept', () => {
  cells.set(key(row(2), 2), 'Vinohradska 12 prha'); edit(row(2), 2);
  assert(get(row(2), 5).startsWith('⚠ Zkontrolujte')); assert.notStrictEqual(get(row(2), 7), '');
});
test('not found -> cross mark', () => {
  cells.set(key(row(3), 2), 'asdfgh qwerty'); edit(row(3), 2);
  assert(get(row(3), 5).startsWith('✗')); assert.strictEqual(get(row(3), 7), '');
});
test('a service outage is not cached and reports a warning', () => {
  cells.set(key(row(4), 2), 'limit'); edit(row(4), 2);
  assert(get(row(4), 5).startsWith('⚠ Služba'));
  const n = calls.geocode;
  edit(row(4), 2); assert.strictEqual(calls.geocode, n + 1, 'an outage must not be cached');
  cells.set(key(row(5), 2), 'boom'); edit(row(5), 2);
  assert(get(row(5), 5).startsWith('⚠ Služba'));
});
test('a repeated address comes from the cache', () => {
  const n = calls.geocode;
  cells.set(key(row(6), 2), 'Vinohradská 12, Praha'); edit(row(6), 2);
  assert.strictEqual(calls.geocode, n); assert.strictEqual(get(row(6), 5), '✓ Adresa nalezena');
});
test('deleting an address clears the check', () => {
  cells.delete(key(row(0), 2)); edit(row(0), 2);
  assert.strictEqual(get(row(0), 5), ''); assert.strictEqual(get(row(0), 7), '');
});
test('the hall is checked the same way', () => {
  cells.set(key(HALL_ROW, 2), 'Vinohradská 12, Praha'); edit(HALL_ROW, 2);
  assert.strictEqual(get(HALL_ROW, 5), '✓ Adresa nalezena');
});
test('the link, date, time and header rows are not checked as addresses', () => {
  const n = calls.geocode;
  cells.set(key(LINK_ROW, 2), 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=0&single=true&output=csv');
  edit(LINK_ROW, 2); edit(DATE_ROW, 2); edit(TIME_ROW, 2); edit(HEADER_ROW, 2); edit(201, 2);
  assert.strictEqual(calls.geocode, n);
  assert.strictEqual(get(LINK_ROW, 5), '', 'no check may appear on the link row');
});
test('editing another column does not re-check the address', () => {
  const n = calls.geocode; edit(row(6), 3); edit(row(6), 4); edit(row(6), 1);
  assert.strictEqual(calls.geocode, n);
});
test('pasting many rows at once is limited', () => {
  for (let k = 20; k < 70; k++) cells.set(key(row(k), 2), 'Vinohradská 12, Praha');
  edit(row(20), 2, 50, 1);
  assert(String(get(row(20 + 30), 5)).startsWith('⚠ Příliš mnoho'));
});
test('checkAll goes through every row', () => {
  cells.set(key(row(80), 2), 'Vinohradská 12, Praha');
  sandbox.checkAll();
  assert.strictEqual(get(row(80), 5), '✓ Adresa nalezena');
});
test('newMatch clears only the Status column', () => {
  cells.set(key(row(0), 3), 'Nejedu'); cells.set(key(row(0), 1), 'Anna'); cells.set(key(row(0), 4), 4);
  sandbox.newMatch();
  assert.strictEqual(get(row(0), 3), ''); assert.strictEqual(get(row(0), 1), 'Anna'); assert.strictEqual(get(row(0), 4), 4);
  assert(calls.alerts[calls.alerts.length - 1].includes('datum'), 'it must remind to set a new date');
});
test('running setup() again keeps the link and asks before erasing data', () => {
  test('setup() installs exactly one edit trigger under the new name', () => {
  triggers = [];
  cells = new Map();
  sandbox.setup(); sandbox.setup();
  assert.deepStrictEqual(triggers.map(t => t.getHandlerFunction()), ['onEditCheck']);
});
test('migrate() replaces the trigger left by an older version (old handler name)', () => {
  triggers = [{ getHandlerFunction: () => 'priUprave' }, { getHandlerFunction: () => 'somethingElse' }];
  cells = new Map([[key(1, 1), 'Něco jiného']]); // an unknown layout: the trigger is refreshed anyway
  sandbox.migrate();
  assert.deepStrictEqual(triggers.map(t => t.getHandlerFunction()).sort(), ['onEditCheck', 'somethingElse']);
});
const link = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=0&single=true&output=csv';
  cells.set(key(LINK_ROW, 2), link); cells.set(key(row(0), 1), 'Anna');
  uiAnswer = 'NO'; const before = new Map(cells);
  sandbox.setup();
  assert.deepStrictEqual([...cells], [...before], 'nothing may change when the user declines');
  uiAnswer = 'YES';
  sandbox.setup();
  assert.strictEqual(get(LINK_ROW, 2), link, 'the link must be kept');
  assert.strictEqual(get(row(0), 1), '', 'players are erased after confirmation');
});
const link = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=0&single=true&output=csv';
test('migrate(): the oldest sheet (hall in row 1) gets a link row and a date row, data stays', () => {
  cells = new Map();
  // oldest format: 1 hall, 2 time, 3 note, 4 header, 5+ players
  cells.set(key(1, 1), 'Hala (adresa)'); cells.set(key(1, 2), 'Vinohradská 12, Praha'); cells.set(key(1, 5), '✓ Adresa nalezena');
  cells.set(key(2, 1), 'Čas příjezdu do haly'); cells.set(key(2, 2), '18:30');
  cells.set(key(4, 1), 'Jméno'); cells.set(key(5, 1), 'Anna'); cells.set(key(5, 2), 'Praha 1'); cells.set(key(5, 3), 'Nejedu');
  sandbox.migrate();
  assert.strictEqual(get(LINK_ROW, 1), 'Odkaz pro aplikaci');
  assert.strictEqual(get(HALL_ROW, 1), 'Hala (adresa)'); assert.strictEqual(get(HALL_ROW, 2), 'Vinohradská 12, Praha');
  assert.strictEqual(get(DATE_ROW, 1), 'Datum zápasu');
  assert.strictEqual(get(TIME_ROW, 1), 'Čas příjezdu do haly'); assert.strictEqual(get(TIME_ROW, 2), '18:30');
  assert.strictEqual(get(HEADER_ROW, 1), 'Jméno');
  assert.strictEqual(get(FIRST_ROW, 1), 'Anna'); assert.strictEqual(get(FIRST_ROW, 3), 'Nejedu');
  assert.strictEqual(calls.frozen, HEADER_ROW);
  assert(calls.alerts[calls.alerts.length - 1].includes('odkaz'), 'it must remind to paste the link');
});
test('migrate(): a sheet with a link but no date gets only the date row and keeps the link', () => {
  cells = new Map();
  // previous format: 1 link, 2 hall, 3 time, 4 note, 5 header, 6+ players
  cells.set(key(1, 1), 'Odkaz na zveřejněnou tabulku'); cells.set(key(1, 2), link);
  cells.set(key(2, 1), 'Hala (adresa)'); cells.set(key(2, 2), 'Vinohradská 12, Praha');
  cells.set(key(3, 1), 'Čas příjezdu do haly'); cells.set(key(3, 2), '18:30');
  cells.set(key(5, 1), 'Jméno'); cells.set(key(6, 1), 'Anna'); cells.set(key(6, 3), 'Můžu vzít auto'); cells.set(key(6, 4), 5);
  sandbox.migrate();
  assert.strictEqual(get(LINK_ROW, 2), link, 'the link must not be lost');
  assert.strictEqual(get(HALL_ROW, 1), 'Hala (adresa)');
  assert.strictEqual(get(DATE_ROW, 1), 'Datum zápasu');
  assert.strictEqual(get(TIME_ROW, 2), '18:30');
  assert.strictEqual(get(HEADER_ROW, 1), 'Jméno');
  assert.strictEqual(get(FIRST_ROW, 1), 'Anna'); assert.strictEqual(get(FIRST_ROW, 3), 'Můžu vzít auto'); assert.strictEqual(get(FIRST_ROW, 4), 5);
  assert.strictEqual(calls.frozen, HEADER_ROW);
  assert(!calls.alerts[calls.alerts.length - 1].includes('vložte odkaz'), 'the link is already there, do not remind');
});
test('migrate() a second time moves nothing', () => {
  const before = new Map(cells);
  sandbox.migrate();
  assert.deepStrictEqual([...cells], [...before]);
  assert(calls.alerts[calls.alerts.length - 1].includes('už má'));
});
test('migrate() on an unknown layout changes nothing', () => {
  cells = new Map([[key(1, 1), 'Něco jiného']]);
  const before = new Map(cells);
  sandbox.migrate();
  assert.deepStrictEqual([...cells], [...before]);
});

console.log(`\nAll ${passed} tests passed.`);
