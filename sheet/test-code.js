// Tests the Apps Script against a simulated Google Sheets. Run: node sheet/test-code.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

// --- simulated sheet ---
let cells = new Map();
const key = (r, c) => r + ',' + c;
const calls = { geocode: 0, alerts: [], toasts: [], frozen: null };
let uiAnswer = 'YES';
let triggers = [];
let cfRules = [];
const validations = new Map();
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() }); // any formatting call = no-op

function makeRange(sheet, r, c, nr = 1, nc = 1) {
  const self = {
    getRow: () => r, getColumn: () => c, getLastRow: () => r + nr - 1, getLastColumn: () => c + nc - 1,
    getSheet: () => sheet,
    getValue: () => (cells.has(key(r, c)) ? cells.get(key(r, c)) : ''),
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells.get(key(r + i, c + j)) ?? '')),
    setValue: v => { cells.set(key(r, c), v); return proxied; },
    setFormula: f => { cells.set(key(r, c), f); return proxied; },
    clearDataValidations: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) validations.delete(key(r + i, c + j)); return proxied; },
    setDataValidation: v => { validations.set(key(r, c), v); return proxied; }, // stored under the top-left cell
    setValues: vs => { vs.forEach((row, i) => row.forEach((v, j) => cells.set(key(r + i, c + j), v))); return proxied; },
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.delete(key(r + i, c + j)); return proxied; },
    protect: () => ({ setWarningOnly: () => {} }),
    getA1Notation: () => r + ',' + c + ',' + nr + ',' + nc,
  };
  // unknown methods (formatting etc.) return the same range, as in Sheets, so calls can be chained
  const proxied = new Proxy(self, { get: (t, p) => (p in t ? t[p] : () => proxied) });
  return proxied;
}
const sheet = {
  getName: () => 'Tým', setName() {},
  getLastRow: () => Math.max(0, ...[...cells.keys()].map(k => +k.split(',')[0])),
  getLastColumn: () => 8,
  getProtections: () => [],
  getConditionalFormatRules: () => cfRules.slice(),
  clearConditionalFormatRules: () => { cfRules = []; },
  setConditionalFormatRules: rules => { cfRules = rules.slice(); },
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
['setColumnWidth'].forEach(n => { sheet[n] = () => {}; });
const ss = { getSheetByName: n => (n === 'Tým' ? sheet : null), getSheets: () => [sheet], insertSheet: () => sheet, toast: m => { calls.toasts.push(m); } };

// --- simulated geocoder ---
const answers = {
  'vinohradská 12, praha': { status: 'OK', results: [{ types: ['street_address'], formatted_address: 'Vinohradská 12, 120 00 Praha 2', geometry: { location: { lat: 50.0755381, lng: 14.4378005 } } }] },
  'praha': { status: 'OK', results: [{ types: ['locality', 'political'], formatted_address: 'Praha', geometry: { location: { lat: 50.08, lng: 14.42 } } }] },
  'vinohradska 12 prha': { status: 'OK', results: [{ types: ['street_address'], partial_match: true, formatted_address: 'Vinohradská 12, Praha', geometry: { location: { lat: 50.07, lng: 14.43 } } }] },
  'asdfgh qwerty': { status: 'ZERO_RESULTS', results: [] },
  'limit': { status: 'OVER_QUERY_LIMIT', results: [] },
  'boom': null, // throws an error
};
// builders that remember what matters for the assertions (formulas, help text)
function ruleBuilder() {
  const rule = { formula: null };
  const b = new Proxy({}, {
    get: (t, p) => p === 'whenFormulaSatisfied' ? f => { rule.formula = f; return b; }
      : p === 'setRanges' ? rs => { rule.ranges = rs; return b; }
      : p === 'build' ? () => ({ getBooleanCondition: () => (rule.formula ? { getCriteriaValues: () => [rule.formula] } : null), getRanges: () => rule.ranges || [], formula: rule.formula })
      : () => b,
  });
  return b;
}
function validationBuilder() {
  const v = {};
  const b = new Proxy({}, {
    get: (t, p) => p === 'requireFormulaSatisfied' ? f => { v.formula = f; return b; }
      : p === 'requireValueInList' ? l => { v.list = l; return b; }
      : p === 'setHelpText' ? h => { v.help = h; return b; }
      : p === 'build' ? () => v
      : () => b,
  });
  return b;
}
const sandbox = {
  console,
  SpreadsheetApp: {
    ProtectionType: { RANGE: 'RANGE' },
    getActive: () => ss,
    getUi: () => ({ alert: m => { calls.alerts.push(m); return uiAnswer; }, ButtonSet: { YES_NO: 1 }, Button: { YES: 'YES' }, createMenu: () => chain() }),
    newDataValidation: () => validationBuilder(), newConditionalFormatRule: () => ruleBuilder(),
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
const { LINK_ROW, HALL_ROW, DATE_ROW, TIME_ROW, HEADER_ROW, FIRST_ROW, COL, HEADER_LABELS, RETURN_MODES } = sandbox; // the row numbers are taken from the script
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
// a sheet with the labels of the current layout (rows are recognised by them)
function layoutCells(extra = []) {
  return new Map([
    [key(LINK_ROW, 1), 'Odkaz pro aplikaci'], [key(HALL_ROW, 1), 'Hala (adresa)'], [key(DATE_ROW, 1), 'Datum zápasu'],
    [key(TIME_ROW, 1), 'Čas příjezdu do haly'], [key(HEADER_ROW, 1), 'Jméno'], ...extra,
  ]);
}
const seatsCell = row => key(row, COL.SEATS);
const ruleCount = (formula, col) => cfRules.filter(r => r.getBooleanCondition() && r.getBooleanCondition().getCriteriaValues()[0] === formula &&
  (col === undefined || r.getRanges().some(g => +g.getA1Notation().split(',')[1] === col))).length;
const C = '$C' + FIRST_ROW, D = '$D' + FIRST_ROW;
const GREY = '=NOT(OR(' + C + '="Určitě beru auto",' + C + '="Můžu vzít auto"))';
const ORANGE = '=AND(OR(' + C + '="Určitě beru auto",' + C + '="Můžu vzít auto"),NOT(ISNUMBER(' + D + ')))';

test('seat validation: a seat count is allowed only for drivers (2-9, whole number)', () => {
  cells = new Map(); cfRules = []; validations.clear();
  sandbox.setup();
  const v = validations.get(seatsCell(FIRST_ROW));
  assert(v, 'validation must be set on the seats column');
  assert(v.formula.startsWith('=OR(D' + FIRST_ROW + '="",AND('), v.formula);
  assert(v.formula.includes('"Určitě beru auto"') && v.formula.includes('"Můžu vzít auto"'), v.formula);
  assert(!v.formula.includes('Potřebuji odvoz') && !v.formula.includes('Nejedu'), 'passengers must not be allowed a seat count');
  assert(v.formula.includes('>=2') && v.formula.includes('<=9') && v.formula.includes('INT('), v.formula);
  assert(v.help.includes('jen u řidiček'), 'the help text must explain the rule');
});
test('seat colours: orange for a driver without seats, grey for everyone else (each rule once)', () => {
  assert.strictEqual(ruleCount(ORANGE, COL.SEATS), 1);
  assert.strictEqual(ruleCount(GREY, COL.SEATS), 1);
});
test('choosing a passenger status clears a stale seat count; driver and empty statuses keep it', () => {
  const set = (k, status, seats) => { cells.set(key(row(k), COL.STATUS), status); cells.set(seatsCell(row(k)), seats); edit(row(k), COL.STATUS); };
  set(0, 'Potřebuji odvoz', 4); assert.strictEqual(get(row(0), COL.SEATS), '');
  set(1, 'Nejedu', 5); assert.strictEqual(get(row(1), COL.SEATS), '');
  set(2, 'Můžu vzít auto', 4); assert.strictEqual(get(row(2), COL.SEATS), 4);
  set(3, 'Určitě beru auto', 5); assert.strictEqual(get(row(3), COL.SEATS), 5);
  set(4, '', 4); assert.strictEqual(get(row(4), COL.SEATS), 4, 'an emptied status (new match) must keep the car size');
});
test('a multi-row status paste clears seats row by row, and only inside the player rows', () => {
  cells = layoutCells();
  for (let k = 0; k < 3; k++) { cells.set(key(row(k), COL.STATUS), 'Potřebuji odvoz'); cells.set(seatsCell(row(k)), 4); }
  cells.set(seatsCell(HEADER_ROW), 'Míst v autě'); cells.set(key(HEADER_ROW, COL.STATUS), 'Nejedu');
  edit(HEADER_ROW, COL.STATUS, row(2) - HEADER_ROW + 1, 1); // the range starts on the header row
  for (let k = 0; k < 3; k++) assert.strictEqual(get(row(k), COL.SEATS), '');
  assert.strictEqual(get(HEADER_ROW, COL.SEATS), 'Míst v autě', 'the header must be left alone');
});
test('newMatch keeps the seat counts of drivers', () => {
  cells = layoutCells([[key(row(0), COL.STATUS), 'Určitě beru auto'], [seatsCell(row(0)), 4]]);
  sandbox.newMatch();
  assert.strictEqual(get(row(0), COL.STATUS), ''); assert.strictEqual(get(row(0), COL.SEATS), 4);
});
test('migrate() applies the seat rules to an older sheet once, and tidies stale passenger seats', () => {
  cells = new Map(); cfRules = []; validations.clear();
  // a current-layout sheet from before the seat rules: no seat colours, number validation only
  cells.set(key(LINK_ROW, 1), 'Odkaz pro aplikaci'); cells.set(key(HALL_ROW, 1), 'Hala (adresa)');
  cells.set(key(DATE_ROW, 1), 'Datum zápasu'); cells.set(key(TIME_ROW, 1), 'Čas příjezdu do haly');
  cells.set(key(HEADER_ROW, 1), 'Jméno');
  cells.set(key(row(0), COL.STATUS), 'Potřebuji odvoz'); cells.set(seatsCell(row(0)), 4);   // stale
  cells.set(key(row(1), COL.STATUS), 'Můžu vzít auto'); cells.set(seatsCell(row(1)), 5);    // driver: keep
  cells.set(key(row(2), COL.STATUS), 'Určitě beru auto');                                   // driver without seats
  sandbox.migrate();
  assert.strictEqual(get(row(0), COL.SEATS), '', 'the stale passenger seat count must be cleared');
  assert.strictEqual(get(row(1), COL.SEATS), 5);
  assert(calls.alerts[calls.alerts.length - 1].includes('Vymazán zbylý počet míst'));
  assert(validations.get(seatsCell(FIRST_ROW)).formula.includes('INT('), 'the new validation must be applied');
  assert.strictEqual(ruleCount(ORANGE, COL.SEATS), 1); assert.strictEqual(ruleCount(GREY, COL.SEATS), 1);
  sandbox.migrate(); sandbox.migrate();
  assert.strictEqual(ruleCount(ORANGE, COL.SEATS), 1, 'no duplicate rules after repeated runs');
  assert.strictEqual(ruleCount(GREY, COL.SEATS), 1);
});
test('migrate() fills in missing column headings, keeps existing ones and leaves a complete header alone', () => {
  cells = new Map();
  cells.set(key(LINK_ROW, 1), 'Odkaz pro aplikaci'); cells.set(key(HALL_ROW, 1), 'Hala (adresa)');
  cells.set(key(DATE_ROW, 1), 'Datum zápasu'); cells.set(key(TIME_ROW, 1), 'Čas příjezdu do haly');
  cells.set(key(HEADER_ROW, 1), 'Jméno'); cells.set(key(HEADER_ROW, 4), 'Kapacita auta'); // renamed by hand
  cells.set(key(row(0), 1), 'Anna');
  sandbox.migrate();
  const header = Array.from({ length: HEADER_LABELS.length }, (_, i) => get(HEADER_ROW, i + 1));
  assert.deepStrictEqual(header, Array.from(HEADER_LABELS).map((l, i) => (i === 3 ? 'Kapacita auta' : l)));
  assert(calls.alerts[calls.alerts.length - 1].includes('Doplněny chybějící nadpisy'));
  assert.strictEqual(get(row(0), 1), 'Anna', 'players must not be touched');
  const before = new Map(cells);
  sandbox.migrate();
  assert.deepStrictEqual([...cells], [...before], 'a complete header is left alone');
  assert(!calls.alerts[calls.alerts.length - 1].includes('Doplněny chybějící nadpisy'));
});
test('layout guard: when the sheet does not match the script nothing is written', () => {
  // the previous layout (no date row): the header is in row 5 and the first player in row 6
  cells = new Map([
    [key(1, 1), 'Odkaz pro aplikaci'], [key(2, 1), 'Hala (adresa)'], [key(3, 1), 'Čas příjezdu do haly'],
    [key(5, 1), 'Jméno'], [key(5, 3), 'Stav'], [key(5, 4), 'Míst v autě'], [key(5, 5), 'Kontrola adresy'],
    [key(6, 1), 'Anna'], [key(6, 2), 'Praha 1'], [key(6, 3), 'Nejedu'], [key(6, 4), 4],
    [key(7, 1), 'Bára'], [key(7, 3), 'Potřebuji odvoz'],
  ]);
  const before = new Map(cells), n = calls.geocode, toasts = calls.toasts.length, alerts = calls.alerts.length;
  edit(6, COL.STATUS); edit(6, COL.ADDR); edit(7, COL.STATUS);
  assert.deepStrictEqual([...cells], [...before], 'an edit must not change anything');
  assert.strictEqual(calls.geocode, n, 'no geocoding either');
  assert(calls.toasts.length > toasts && calls.toasts[calls.toasts.length - 1].includes('migrate'));
  sandbox.checkAll(); sandbox.newMatch();
  assert.deepStrictEqual([...cells], [...before], 'menu actions must not change anything');
  assert(calls.alerts.length === alerts + 2 && calls.alerts.every(a => typeof a === 'string'));
  assert(calls.alerts[calls.alerts.length - 1].includes('migrate'));
});
test('migrate() repairs a damaged header: restores headings and removes dropdowns from it', () => {
  cells = layoutCells([[key(HEADER_ROW, 2), 'Adresa']]);  // C..H of the header row are gone
  validations.clear();
  validations.set(key(HEADER_ROW, COL.STATUS), { formula: 'x' }); validations.set(key(HEADER_ROW, COL.SEATS), { formula: 'y' });
  sandbox.migrate();
  const header = Array.from({ length: HEADER_LABELS.length }, (_, i) => get(HEADER_ROW, i + 1));
  assert.deepStrictEqual(header, Array.from(HEADER_LABELS));
  assert(!validations.has(key(HEADER_ROW, COL.STATUS)) && !validations.has(key(HEADER_ROW, COL.SEATS)), 'no dropdown on headings');
  assert(validations.has(key(FIRST_ROW, COL.STATUS)), 'the status dropdown starts at the first player row');
  assert(validations.has(key(FIRST_ROW, COL.SEATS)));
  // once the layout matches again, the guarded functions work
  sandbox.newMatch();
  assert.strictEqual(get(HEADER_ROW, COL.STATUS), 'Stav', 'newMatch must never touch the header row');
});
test('the new-match reminder is worded correctly (no function name in a sentence)', () => {
  cells = layoutCells();
  sandbox.newMatch();
  const msg = calls.alerts[calls.alerts.length - 1];
  assert(msg.includes('nastavit nové datum'), msg);
  assert(!msg.includes('setup'), msg);
});
const RET_RULES = () => {   // [formula, column]
  const r = FIRST_ROW;
  return [
    ['=LEFT($L' + r + ',1)="✗"', COL.RET_CHECK], ['=LEFT($L' + r + ',1)="⚠"', COL.RET_CHECK], ['=LEFT($L' + r + ',1)="✓"', COL.RET_CHECK],
    ['=AND($I' + r + '="Jinam",$K' + r + '="")', COL.RET_ADDR], ['=$I' + r + '<>"Jinam"', COL.RET_ADDR],
    ['=NOT(OR($C' + r + '="Určitě beru auto",$C' + r + '="Můžu vzít auto"))', COL.SEATS_BACK],
    ['=AND(OR($C' + r + '="Určitě beru auto",$C' + r + '="Můžu vzít auto"),ISNUMBER($J' + r + '),ISNUMBER($D' + r + '),$J' + r + '>$D' + r + ')', COL.SEATS_BACK],
  ];
};
test('trip back: setup() creates the headings, dropdowns and colour rules of columns I-O', () => {
  cells = new Map(); cfRules = []; validations.clear();
  sandbox.setup();
  assert.deepStrictEqual(Array.from({ length: 7 }, (_, i) => get(HEADER_ROW, COL.RETURN + i)),
    ['Návrat', 'Míst zpět', 'Adresa návratu', 'Kontrola návratu', 'Nalezená adresa návratu', 'Lat zpět', 'Lon zpět']);
  assert.deepStrictEqual(Array.from(validations.get(key(FIRST_ROW, COL.RETURN)).list), ['Stejně jako tam', 'Jinam', 'Odvoz zpět nepotřebuji']);
  const sb = validations.get(key(FIRST_ROW, COL.SEATS_BACK));
  assert(sb.formula.startsWith('=OR(J' + FIRST_ROW + '="",AND('), sb.formula);
  assert(sb.formula.includes('"Určitě beru auto"') && !sb.formula.includes('Potřebuji odvoz'), 'drivers only');
  assert(sb.formula.includes('>=1') && sb.formula.includes('INT(') && sb.formula.includes('<=IF(ISNUMBER(D' + FIRST_ROW + ')'), sb.formula);
  assert(sb.help.includes('1 = nikoho nevezmu'), sb.help);
  RET_RULES().forEach(([f, col]) => assert.strictEqual(ruleCount(f, col), 1, 'rule once: ' + f));
  assert.strictEqual(ruleCount(GREY), 2, 'the same grey formula is used for the seats and for "takes back" (two ranges)');
});
test('trip back: the return address is checked like an address (columns L-O) and leaves E-H alone', () => {
  const r = row(0);
  cells.set(key(r, COL.STATUS), 'Určitě beru auto'); cells.set(key(r, COL.RETURN), 'Jinam');
  cells.set(key(r, COL.RET_ADDR), 'Vinohradská 12, Praha');
  cells.set(key(r, COL.CHECK), 'untouched');
  edit(r, COL.RET_ADDR);
  assert.strictEqual(get(r, COL.RET_CHECK), '✓ Adresa nalezena');
  assert.strictEqual(get(r, COL.RET_FOUND), 'Vinohradská 12, 120 00 Praha 2');
  assert.strictEqual(get(r, COL.RET_LAT), '50.075538'); assert.strictEqual(get(r, COL.RET_LON), '14.437801');
  assert.strictEqual(typeof get(r, COL.RET_LAT), 'string');
  assert.strictEqual(get(r, COL.CHECK), 'untouched', 'the outbound check must not be touched');
});
test('trip back: typing the address first and choosing "Jinam" afterwards still checks it', () => {
  const r = row(1);
  cells.set(key(r, COL.RET_ADDR), 'Vinohradská 12, Praha');             // typed while the mode was still empty
  cells.set(key(r, COL.RETURN), 'Jinam');
  edit(r, COL.RETURN);
  assert.strictEqual(get(r, COL.RET_CHECK), '✓ Adresa nalezena');
});
const returnCols = r => [COL.RET_ADDR, COL.RET_CHECK, COL.RET_FOUND, COL.RET_LAT, COL.RET_LON].map(c => get(r, c));
const seatsBackDefault = r => '=IF(ISNUMBER(D' + r + '),D' + r + ',"")';
const outboundCols = r => [COL.ADDR, COL.CHECK, COL.FOUND, COL.LAT, COL.LON].map(c => get(r, c));

test('trip back defaults: a row with content gets "Stejně jako tam", and drivers also "ano"', () => {
  cells = new Map(); cfRules = []; validations.clear();
  sandbox.setup();
  const r = row(0);
  cells.set(key(r, COL.NAME), 'Anna'); edit(r, COL.NAME);
  assert.strictEqual(get(r, COL.RETURN), 'Stejně jako tam');
  assert.strictEqual(get(r, COL.SEATS_BACK), '', 'a passenger-to-be is not asked yet');
  cells.set(key(r, COL.STATUS), 'Můžu vzít auto'); edit(r, COL.STATUS);
  assert.strictEqual(get(r, COL.SEATS_BACK), seatsBackDefault(r), 'the default follows the seats there');
  const blank = row(1);
  cells.set(key(blank, COL.STATUS), 'Určitě beru auto'); edit(blank, COL.STATUS);   // no name, no address
  assert.strictEqual(get(blank, COL.RETURN), '', 'an empty row gets no defaults');
});
test('trip back defaults: a choice that was made is never overwritten', () => {
  const r = row(2);
  cells.set(key(r, COL.NAME), 'Bára'); cells.set(key(r, COL.RETURN), 'Jinam'); cells.set(key(r, COL.STATUS), 'Určitě beru auto'); cells.set(key(r, COL.SEATS_BACK), 2);
  edit(r, COL.STATUS);
  assert.strictEqual(get(r, COL.RETURN), 'Jinam'); assert.strictEqual(get(r, COL.SEATS_BACK), 2, 'an overridden number stays');
});
test('"Stejně jako tam": the return address, its check and coordinates are a copy of the outbound ones', () => {
  const r = row(3);
  cells.set(key(r, COL.NAME), 'Cecílie'); cells.set(key(r, COL.ADDR), 'Vinohradská 12, Praha');
  edit(r, COL.NAME); edit(r, COL.ADDR);
  assert.strictEqual(get(r, COL.RETURN), 'Stejně jako tam');
  assert.deepStrictEqual(returnCols(r), outboundCols(r));
  assert.strictEqual(get(r, COL.RET_ADDR), 'Vinohradská 12, Praha');
  assert.strictEqual(get(r, COL.RET_CHECK), '✓ Adresa nalezena');
  assert.strictEqual(get(r, COL.RET_LAT), '50.075538');
});
test('"Stejně jako tam": changing the outbound address updates the copy (without a second geocoding)', () => {
  const r = row(3);
  cells.set(key(r, COL.ADDR), 'Praha');
  const n = calls.geocode; edit(r, COL.ADDR);
  assert(calls.geocode - n <= 1, 'at most the outbound address is geocoded, the copy costs nothing');
  assert.deepStrictEqual(returnCols(r), outboundCols(r));
  assert(get(r, COL.RET_CHECK).startsWith('⚠ Upřesněte'), get(r, COL.RET_CHECK));
});
test('typing a different address into the return column switches the mode to "Jinam" and checks it', () => {
  const r = row(3);
  cells.set(key(r, COL.ADDR), 'Vinohradská 12, Praha'); edit(r, COL.ADDR);
  cells.set(key(r, COL.RET_ADDR), 'Vinohradska 12 prha'); edit(r, COL.RET_ADDR);
  assert.strictEqual(get(r, COL.RETURN), 'Jinam');
  assert(get(r, COL.RET_CHECK).startsWith('⚠ Zkontrolujte'), 'the typed address is geocoded: ' + get(r, COL.RET_CHECK));
  assert.strictEqual(get(r, COL.RET_ADDR), 'Vinohradska 12 prha', 'her own address stays');
  assert.deepStrictEqual(outboundCols(r)[0], 'Vinohradská 12, Praha', 'the outbound address is untouched');
});
test('"Jinam": her own address stays when the outbound address changes', () => {
  const r = row(3);
  cells.set(key(r, COL.ADDR), 'Praha'); edit(r, COL.ADDR);
  assert.strictEqual(get(r, COL.RET_ADDR), 'Vinohradska 12 prha');
});
test('choosing "Jinam" in a row that has the automatic copy removes the copy so she can type her own', () => {
  const r = row(4);
  cells.set(key(r, COL.NAME), 'Dana'); cells.set(key(r, COL.ADDR), 'Vinohradská 12, Praha');
  edit(r, COL.NAME); edit(r, COL.ADDR);
  assert.strictEqual(get(r, COL.RET_ADDR), 'Vinohradská 12, Praha');
  cells.set(key(r, COL.RETURN), 'Jinam'); edit(r, COL.RETURN);
  assert.deepStrictEqual(returnCols(r), ['', '', '', '', ''], 'the copy is gone');
  cells.set(key(r, COL.RET_ADDR), 'Vinohradská 12, Praha ');   // typing the very same address again
  edit(r, COL.RET_ADDR);
  assert.strictEqual(get(r, COL.RETURN), 'Jinam');
});
test('"Odvoz zpět nepotřebuji": the return columns are emptied', () => {
  const r = row(4);
  cells.set(key(r, COL.RETURN), 'Odvoz zpět nepotřebuji'); edit(r, COL.RETURN);
  assert.deepStrictEqual(returnCols(r), ['', '', '', '', '']);
  assert.strictEqual(get(r, COL.RETURN), 'Odvoz zpět nepotřebuji');
});
test('switching back to "Stejně jako tam" copies the outbound address again', () => {
  const r = row(4);
  cells.set(key(r, COL.RETURN), 'Stejně jako tam'); edit(r, COL.RETURN);
  assert.deepStrictEqual(returnCols(r), outboundCols(r));
  assert.strictEqual(get(r, COL.RET_ADDR), 'Vinohradská 12, Praha');
});
test('newMatch brings the way home back to the defaults, but keeps the seat counts', () => {
  const r = row(0);
  cells.set(key(r, COL.STATUS), 'Určitě beru auto'); cells.set(seatsCell(r), 5); cells.set(key(r, COL.SEATS_BACK), 2);
  cells.set(key(r, COL.ADDR), 'Vinohradská 12, Praha'); edit(r, COL.ADDR);
  cells.set(key(r, COL.RETURN), 'Jinam'); cells.set(key(r, COL.RET_ADDR), 'Chata'); edit(r, COL.RET_ADDR);
  sandbox.newMatch();
  assert.strictEqual(get(r, COL.STATUS), '');
  assert.strictEqual(get(r, COL.RETURN), 'Stejně jako tam', 'the exception of the last match is gone');
  assert.strictEqual(get(r, COL.SEATS_BACK), '');
  assert.strictEqual(get(r, COL.SEATS), 5, 'the size of the car stays');
  assert.deepStrictEqual(returnCols(r), outboundCols(r), 'the return address is the outbound one again');
  assert.strictEqual(get(row(9), COL.RETURN), '', 'rows without content stay empty');
  assert(calls.alerts[calls.alerts.length - 1].includes('výchozí hodnoty'));
});
test('trip back: an address in a row that is not "Jinam" is not geocoded', () => {
  const r = row(2), n = calls.geocode;
  cells.set(key(r, COL.RETURN), 'Odvoz zpět nepotřebuji'); cells.set(key(r, COL.RET_ADDR), 'Vinohradská 12, Praha');
  edit(r, COL.RET_ADDR);
  assert.strictEqual(calls.geocode, n); assert.strictEqual(get(r, COL.RET_CHECK), '');
  assert.strictEqual(get(r, COL.RET_ADDR), '', 'nothing is asked in this mode, so the typed address is dropped');
});
test('trip back: a passenger status clears "takes passengers back" together with the seat count', () => {
  const r = row(3);
  cells.set(key(r, COL.STATUS), 'Potřebuji odvoz'); cells.set(key(r, COL.SEATS), 4); cells.set(key(r, COL.SEATS_BACK), 2);
  edit(r, COL.STATUS);
  assert.strictEqual(get(r, COL.SEATS), ''); assert.strictEqual(get(r, COL.SEATS_BACK), '');
  cells.set(key(r, COL.STATUS), 'Můžu vzít auto'); cells.set(key(r, COL.SEATS_BACK), 2);
  edit(r, COL.STATUS);
  assert.strictEqual(get(r, COL.SEATS_BACK), 2, 'a driver keeps the number');
});
test('trip back: the hall row and the rows above the players are not return rows', () => {
  const n = calls.geocode;
  cells.set(key(HALL_ROW, COL.RET_ADDR), 'Vinohradská 12, Praha');
  edit(HALL_ROW, COL.RET_ADDR); edit(HEADER_ROW, COL.RET_ADDR);
  assert.strictEqual(calls.geocode, n); assert.strictEqual(get(HALL_ROW, COL.RET_CHECK), '');
});
test('trip back: checkAll also checks the return addresses', () => {
  const r = row(5);
  cells.set(key(r, COL.RETURN), 'Jinam'); cells.set(key(r, COL.RET_ADDR), 'asdfgh qwerty');
  sandbox.checkAll();
  assert(get(r, COL.RET_CHECK).startsWith('✗'), get(r, COL.RET_CHECK));
});
test('trip back: migrate() adds the return columns to a sheet without them, once and without touching anything', () => {
  cells = layoutCells([[key(HEADER_ROW, 2), 'Adresa'], [key(row(0), 1), 'Anna'], [key(row(0), COL.STATUS), 'Určitě beru auto'], [seatsCell(row(0)), 4]]);
  cfRules = []; validations.clear();
  sandbox.migrate();
  assert.deepStrictEqual(Array.from({ length: 7 }, (_, i) => get(HEADER_ROW, COL.RETURN + i)),
    ['Návrat', 'Míst zpět', 'Adresa návratu', 'Kontrola návratu', 'Nalezená adresa návratu', 'Lat zpět', 'Lon zpět']);
  assert.deepStrictEqual(Array.from(validations.get(key(FIRST_ROW, COL.RETURN)).list), Array.from(RETURN_MODES));
  RET_RULES().forEach(([f, col]) => assert.strictEqual(ruleCount(f, col), 1, f));
  assert.strictEqual(get(row(0), 1), 'Anna'); assert.strictEqual(get(row(0), COL.SEATS), 4);
  sandbox.migrate(); sandbox.migrate();
  RET_RULES().forEach(([f, col]) => assert.strictEqual(ruleCount(f, col), 1, 'no duplicates after reruns: ' + f));
  assert.strictEqual(ruleCount(GREY, COL.SEATS), 1); assert.strictEqual(ruleCount(GREY, COL.SEATS_BACK), 1);
});
test('migrate() gives the existing players the trip-back defaults and fills in their return addresses', () => {
  cells = layoutCells([
    [key(row(0), COL.NAME), 'Anna'], [key(row(0), COL.ADDR), 'Vinohradská 12, Praha'], [key(row(0), COL.CHECK), '✓ Adresa nalezena'],
    [key(row(0), COL.FOUND), 'Vinohradská 12, 120 00 Praha 2'], [key(row(0), COL.LAT), '50.075538'], [key(row(0), COL.LON), '14.437801'],
    [key(row(0), COL.STATUS), 'Určitě beru auto'], [seatsCell(row(0)), 4],
    [key(row(1), COL.NAME), 'Bára'], [key(row(1), COL.STATUS), 'Potřebuji odvoz'],
    [key(row(2), COL.NAME), 'Cecílie'], [key(row(2), COL.RETURN), 'Jinam'], [key(row(2), COL.RET_ADDR), 'Chata 1'],   // an exception that exists already
  ]);
  sandbox.migrate();
  assert.strictEqual(get(row(0), COL.RETURN), 'Stejně jako tam'); assert.strictEqual(get(row(0), COL.SEATS_BACK), seatsBackDefault(row(0)));
  assert.deepStrictEqual(returnCols(row(0)), outboundCols(row(0)), 'the return address copies the outbound one');
  assert.strictEqual(get(row(1), COL.RETURN), 'Stejně jako tam'); assert.strictEqual(get(row(1), COL.SEATS_BACK), '', 'only drivers are asked');
  assert.strictEqual(get(row(2), COL.RETURN), 'Jinam'); assert.strictEqual(get(row(2), COL.RET_ADDR), 'Chata 1', 'an existing exception is kept');
  assert.strictEqual(get(row(5), COL.RETURN), '', 'rows without content stay empty');
});
test('migrate() converts the old yes/no answers of column J into seats back and renames the heading', () => {
  cells = layoutCells([
    [key(HEADER_ROW, COL.SEATS_BACK), 'Zpět vezmu spolucestující'],
    [key(row(0), COL.NAME), 'Anna'], [key(row(0), COL.STATUS), 'Určitě beru auto'], [seatsCell(row(0)), 4], [key(row(0), COL.SEATS_BACK), 'ano'],
    [key(row(1), COL.NAME), 'Bára'], [key(row(1), COL.STATUS), 'Můžu vzít auto'], [seatsCell(row(1)), 4], [key(row(1), COL.SEATS_BACK), 'ne'],
    [key(row(2), COL.NAME), 'Cecílie'], [key(row(2), COL.STATUS), 'Určitě beru auto'], [seatsCell(row(2)), 5], [key(row(2), COL.SEATS_BACK), 3],
  ]);
  sandbox.migrate();
  assert.strictEqual(get(HEADER_ROW, COL.SEATS_BACK), 'Míst zpět', 'the old heading is renamed');
  assert.strictEqual(get(row(0), COL.SEATS_BACK), seatsBackDefault(row(0)), '"ano" becomes the default (as many as there)');
  assert.strictEqual(get(row(1), COL.SEATS_BACK), 1, '"ne" becomes 1: only the driver');
  assert.strictEqual(get(row(2), COL.SEATS_BACK), 3, 'a number that is already there stays');
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
