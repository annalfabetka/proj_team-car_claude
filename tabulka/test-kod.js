// Test Apps Scriptu proti simulovanému Google Sheets. Spuštění: node tabulka/test-kod.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

// --- simulace tabulky ---
let cells = new Map();
const key = (r, c) => r + ',' + c;
const calls = { geocode: 0, alerts: [], frozen: null };
let uiAnswer = 'YES';
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() }); // libovolné formátování = no-op

function makeRange(sheet, r, c, nr = 1, nc = 1) {
  const self = {
    getRow: () => r, getColumn: () => c, getLastRow: () => r + nr - 1, getLastColumn: () => c + nc - 1,
    getSheet: () => sheet,
    getValue: () => (cells.has(key(r, c)) ? cells.get(key(r, c)) : ''),
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells.get(key(r + i, c + j)) ?? '')),
    setValue: v => { cells.set(key(r, c), v); return proxied; },
    setValues: vs => { vs.forEach((row, i) => row.forEach((v, j) => cells.set(key(r + i, c + j), v))); return proxied; },
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.delete(key(r + i, c + j)); return proxied; },
    protect: () => ({ setWarningOnly: () => {} }),
  };
  // neznámé metody (formátování apod.) jako v Sheets vrací zpět týž rozsah, aby šlo řetězit
  const proxied = new Proxy(self, { get: (t, p) => (p in t ? t[p] : () => proxied) });
  return proxied;
}
const sheet = {
  getName: () => 'Tým', setName() {},
  getLastRow: () => Math.max(0, ...[...cells.keys()].map(k => +k.split(',')[0])),
  getLastColumn: () => 8,
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

// --- simulace geokodéru ---
const answers = {
  'vinohradská 12, praha': { status: 'OK', results: [{ types: ['street_address'], formatted_address: 'Vinohradská 12, 120 00 Praha 2', geometry: { location: { lat: 50.0755381, lng: 14.4378005 } } }] },
  'praha': { status: 'OK', results: [{ types: ['locality', 'political'], formatted_address: 'Praha', geometry: { location: { lat: 50.08, lng: 14.42 } } }] },
  'vinohradska 12 prha': { status: 'OK', results: [{ types: ['street_address'], partial_match: true, formatted_address: 'Vinohradská 12, Praha', geometry: { location: { lat: 50.07, lng: 14.43 } } }] },
  'asdfgh qwerty': { status: 'ZERO_RESULTS', results: [] },
  'limit': { status: 'OVER_QUERY_LIMIT', results: [] },
  'boom': null, // vyhodí chybu
};
const sandbox = {
  console,
  SpreadsheetApp: {
    getActive: () => ss,
    getUi: () => ({ alert: m => { calls.alerts.push(m); return uiAnswer; }, ButtonSet: { YES_NO: 1 }, Button: { YES: 'YES' }, createMenu: () => chain() }),
    newDataValidation: () => chain(), newConditionalFormatRule: () => chain(),
  },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => chain(), deleteTrigger() {} },
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
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Kod.gs'), 'utf8'), sandbox);
const { LINK_ROW, HALL_ROW, TIME_ROW, HEADER_ROW, FIRST_ROW, COL } = sandbox; // řádky se berou ze skriptu
const get = (r, c) => cells.get(key(r, c)) ?? '';
const edit = (r, c, nr = 1, nc = 1) => sandbox.priUprave({ range: makeRange(sheet, r, c, nr, nc) });
const row = k => FIRST_ROW + k; // k-tá hráčka

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

test('rozložení: odkaz → hala → čas → záhlaví → hráčky', () => {
  assert(LINK_ROW < HALL_ROW && HALL_ROW < TIME_ROW && TIME_ROW < HEADER_ROW && HEADER_ROW < FIRST_ROW);
  assert.strictEqual(LINK_ROW, 1, 'odkaz musí být úplně nahoře');
});
test('nastavit() vytvoří popisky, záhlaví a prázdné pole pro odkaz', () => {
  sandbox.nastavit();
  assert.strictEqual(get(LINK_ROW, COL.NAME), 'Odkaz na zveřejněnou tabulku');
  assert.strictEqual(get(LINK_ROW, COL.ADDR), '');
  assert.strictEqual(get(HALL_ROW, COL.NAME), 'Hala (adresa)');
  assert.strictEqual(get(TIME_ROW, COL.ADDR), '18:30');
  assert.strictEqual(get(HEADER_ROW, COL.NAME), 'Jméno'); assert.strictEqual(get(HEADER_ROW, COL.CHECK), 'Kontrola adresy');
});
test('přesná adresa → ✓, nalezená adresa a souřadnice jako text s tečkou', () => {
  cells.set(key(row(0), 2), 'Vinohradská 12, Praha'); edit(row(0), 2);
  assert.strictEqual(get(row(0), 5), '✓ Adresa nalezena');
  assert.strictEqual(get(row(0), 6), 'Vinohradská 12, 120 00 Praha 2');
  assert.strictEqual(get(row(0), 7), '50.075538'); assert.strictEqual(get(row(0), 8), '14.437801');
  assert.strictEqual(typeof get(row(0), 7), 'string');
});
test('jen město → ⚠ upřesnit, souřadnice se nevyplní', () => {
  cells.set(key(row(1), 2), 'Praha'); edit(row(1), 2);
  assert(get(row(1), 5).startsWith('⚠ Upřesněte')); assert.strictEqual(get(row(1), 7), ''); assert.strictEqual(get(row(1), 8), '');
  assert.strictEqual(get(row(1), 6), 'Praha');
});
test('částečná shoda (překlep) → ⚠ zkontrolovat, souřadnice zůstanou', () => {
  cells.set(key(row(2), 2), 'Vinohradska 12 prha'); edit(row(2), 2);
  assert(get(row(2), 5).startsWith('⚠ Zkontrolujte')); assert.notStrictEqual(get(row(2), 7), '');
});
test('nenalezeno → ✗', () => {
  cells.set(key(row(3), 2), 'asdfgh qwerty'); edit(row(3), 2);
  assert(get(row(3), 5).startsWith('✗')); assert.strictEqual(get(row(3), 7), '');
});
test('výpadek služby se nezapíše do cache a hlásí ⚠', () => {
  cells.set(key(row(4), 2), 'limit'); edit(row(4), 2);
  assert(get(row(4), 5).startsWith('⚠ Služba'));
  const n = calls.geocode;
  edit(row(4), 2); assert.strictEqual(calls.geocode, n + 1, 'výpadek nesmí jít do cache');
  cells.set(key(row(5), 2), 'boom'); edit(row(5), 2);
  assert(get(row(5), 5).startsWith('⚠ Služba'));
});
test('opakovaná adresa jde z cache', () => {
  const n = calls.geocode;
  cells.set(key(row(6), 2), 'Vinohradská 12, Praha'); edit(row(6), 2);
  assert.strictEqual(calls.geocode, n); assert.strictEqual(get(row(6), 5), '✓ Adresa nalezena');
});
test('smazání adresy vyčistí kontrolu', () => {
  cells.delete(key(row(0), 2)); edit(row(0), 2);
  assert.strictEqual(get(row(0), 5), ''); assert.strictEqual(get(row(0), 7), '');
});
test('hala se kontroluje stejně', () => {
  cells.set(key(HALL_ROW, 2), 'Vinohradská 12, Praha'); edit(HALL_ROW, 2);
  assert.strictEqual(get(HALL_ROW, 5), '✓ Adresa nalezena');
});
test('řádek s odkazem, čas ani záhlaví se nekontrolují jako adresy', () => {
  const n = calls.geocode;
  cells.set(key(LINK_ROW, 2), 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=0&single=true&output=csv');
  edit(LINK_ROW, 2); edit(TIME_ROW, 2); edit(HEADER_ROW, 2); edit(201, 2);
  assert.strictEqual(calls.geocode, n);
  assert.strictEqual(get(LINK_ROW, 5), '', 'u odkazu se nesmí objevit kontrola');
});
test('úprava jiného sloupce adresu nepřepočítává', () => {
  const n = calls.geocode; edit(row(6), 3); edit(row(6), 4); edit(row(6), 1);
  assert.strictEqual(calls.geocode, n);
});
test('vložení mnoha řádků najednou je omezeno', () => {
  for (let k = 20; k < 70; k++) cells.set(key(row(k), 2), 'Vinohradská 12, Praha');
  edit(row(20), 2, 50, 1);
  assert(String(get(row(20 + 30), 5)).startsWith('⚠ Příliš mnoho'));
});
test('zkontrolovatVse projde všechny řádky', () => {
  cells.set(key(row(80), 2), 'Vinohradská 12, Praha');
  sandbox.zkontrolovatVse();
  assert.strictEqual(get(row(80), 5), '✓ Adresa nalezena');
});
test('novyZapas smaže jen sloupec Stav', () => {
  cells.set(key(row(0), 3), 'Nejedu'); cells.set(key(row(0), 1), 'Anna'); cells.set(key(row(0), 4), 4);
  sandbox.novyZapas();
  assert.strictEqual(get(row(0), 3), ''); assert.strictEqual(get(row(0), 1), 'Anna'); assert.strictEqual(get(row(0), 4), 4);
});
test('opakované nastavit() ukládá odkaz a před smazáním dat se ptá', () => {
  const link = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=0&single=true&output=csv';
  cells.set(key(LINK_ROW, 2), link); cells.set(key(row(0), 1), 'Anna');
  uiAnswer = 'NO'; const before = new Map(cells);
  sandbox.nastavit();
  assert.deepStrictEqual([...cells], [...before], 'při odmítnutí se nesmí změnit nic');
  uiAnswer = 'YES';
  sandbox.nastavit();
  assert.strictEqual(get(LINK_ROW, 2), link, 'odkaz se musí zachovat');
  assert.strictEqual(get(row(0), 1), '', 'hráčky se po potvrzení smažou');
});
test('migrovat(): starý list (hala v 1. řádku) dostane nahoře řádek s odkazem a data zůstanou', () => {
  cells = new Map();
  // starý formát: 1 hala, 2 čas, 3 poznámka, 4 záhlaví, 5+ hráčky
  cells.set(key(1, 1), 'Hala (adresa)'); cells.set(key(1, 2), 'Vinohradská 12, Praha'); cells.set(key(1, 5), '✓ Adresa nalezena');
  cells.set(key(2, 1), 'Čas příjezdu do haly'); cells.set(key(2, 2), '18:30');
  cells.set(key(4, 1), 'Jméno'); cells.set(key(5, 1), 'Anna'); cells.set(key(5, 2), 'Praha 1'); cells.set(key(5, 3), 'Nejedu');
  sandbox.migrovat();
  assert.strictEqual(get(LINK_ROW, 1), 'Odkaz na zveřejněnou tabulku');
  assert.strictEqual(get(HALL_ROW, 1), 'Hala (adresa)'); assert.strictEqual(get(HALL_ROW, 2), 'Vinohradská 12, Praha');
  assert.strictEqual(get(TIME_ROW, 2), '18:30');
  assert.strictEqual(get(HEADER_ROW, 1), 'Jméno');
  assert.strictEqual(get(FIRST_ROW, 1), 'Anna'); assert.strictEqual(get(FIRST_ROW, 3), 'Nejedu');
  assert.strictEqual(calls.frozen, HEADER_ROW);
});
test('migrovat() podruhé nic neposouvá', () => {
  const before = new Map(cells);
  sandbox.migrovat();
  assert.deepStrictEqual([...cells], [...before]);
  assert(calls.alerts[calls.alerts.length - 1].includes('už má'));
});
test('migrovat() na neznámém rozložení nic nemění', () => {
  cells = new Map([[key(1, 1), 'Něco jiného']]);
  const before = new Map(cells);
  sandbox.migrovat();
  assert.deepStrictEqual([...cells], [...before]);
});

console.log(`\nVšech ${passed} testů prošlo.`);
