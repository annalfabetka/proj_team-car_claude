// Test Apps Scriptu proti simulovanému Google Sheets. Spuštění: node tabulka/test-kod.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

// --- simulace tabulky ---
const cells = new Map();
const key = (r, c) => r + ',' + c;
const calls = { geocode: 0, alerts: [] };
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() }); // libovolné formátování = no-op

function makeRange(sheet, r, c, nr = 1, nc = 1) {
  const self = {
    getRow: () => r, getColumn: () => c, getLastRow: () => r + nr - 1, getLastColumn: () => c + nc - 1,
    getSheet: () => sheet,
    getValue: () => (cells.has(key(r, c)) ? cells.get(key(r, c)) : ''),
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells.get(key(r + i, c + j)) ?? '')),
    setValue: v => { cells.set(key(r, c), v); return self; },
    setValues: vs => { vs.forEach((row, i) => row.forEach((v, j) => cells.set(key(r + i, c + j), v))); return self; },
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.delete(key(r + i, c + j)); return self; },
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
  getRange(a, b, c, d) {
    if (typeof a === 'string') { // 'B2', 'A1:A2'
      const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(a);
      const col = ch => ch.charCodeAt(0) - 64;
      return makeRange(sheet, +m[2], col(m[1]), m[4] ? +m[4] - +m[2] + 1 : 1, m[3] ? col(m[3]) - col(m[1]) + 1 : 1);
    }
    return makeRange(sheet, a, b, c || 1, d || 1);
  },
};
['clearConditionalFormatRules', 'setFrozenRows', 'setColumnWidth', 'setConditionalFormatRules'].forEach(n => { sheet[n] = () => {}; });
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
    getUi: () => ({ alert: m => { calls.alerts.push(m); return 'YES'; }, ButtonSet: { YES_NO: 1 }, Button: { YES: 'YES' }, createMenu: () => chain() }),
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
const get = (r, c) => cells.get(key(r, c)) ?? '';
const edit = (r, c, nr = 1, nc = 1) => sandbox.priUprave({ range: makeRange(sheet, r, c, nr, nc) });

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

test('nastavit() proběhne a vytvoří záhlaví', () => {
  sandbox.nastavit();
  assert.strictEqual(get(4, 1), 'Jméno'); assert.strictEqual(get(4, 5), 'Kontrola adresy');
  assert.strictEqual(get(2, 2), '18:30');
});
test('přesná adresa → ✓, nalezená adresa a souřadnice jako text s tečkou', () => {
  cells.set(key(5, 2), 'Vinohradská 12, Praha'); edit(5, 2);
  assert.strictEqual(get(5, 5), '✓ Adresa nalezena');
  assert.strictEqual(get(5, 6), 'Vinohradská 12, 120 00 Praha 2');
  assert.strictEqual(get(5, 7), '50.075538'); assert.strictEqual(get(5, 8), '14.437801');
  assert.strictEqual(typeof get(5, 7), 'string');
});
test('jen město → ⚠ upřesnit, souřadnice se nevyplní', () => {
  cells.set(key(6, 2), 'Praha'); edit(6, 2);
  assert(get(6, 5).startsWith('⚠ Upřesněte')); assert.strictEqual(get(6, 7), ''); assert.strictEqual(get(6, 8), '');
  assert.strictEqual(get(6, 6), 'Praha');
});
test('částečná shoda (překlep) → ⚠ zkontrolovat, souřadnice zůstanou', () => {
  cells.set(key(7, 2), 'Vinohradska 12 prha'); edit(7, 2);
  assert(get(7, 5).startsWith('⚠ Zkontrolujte')); assert.notStrictEqual(get(7, 7), '');
});
test('nenalezeno → ✗', () => {
  cells.set(key(8, 2), 'asdfgh qwerty'); edit(8, 2);
  assert(get(8, 5).startsWith('✗')); assert.strictEqual(get(8, 7), '');
});
test('výpadek služby se nezapíše do cache a hlásí ⚠', () => {
  cells.set(key(9, 2), 'limit'); edit(9, 2);
  assert(get(9, 5).startsWith('⚠ Služba'));
  const before = sandbox.Maps.newGeocoder; let n = calls.geocode;
  edit(9, 2); assert.strictEqual(calls.geocode, n + 1, 'výpadek nesmí jít do cache');
  cells.set(key(10, 2), 'boom'); edit(10, 2);
  assert(get(10, 5).startsWith('⚠ Služba'));
});
test('opakovaná adresa jde z cache', () => {
  const n = calls.geocode;
  cells.set(key(11, 2), 'Vinohradská 12, Praha'); edit(11, 2);
  assert.strictEqual(calls.geocode, n); assert.strictEqual(get(11, 5), '✓ Adresa nalezena');
});
test('smazání adresy vyčistí kontrolu', () => {
  cells.delete(key(5, 2)); edit(5, 2);
  assert.strictEqual(get(5, 5), ''); assert.strictEqual(get(5, 7), '');
});
test('hala (řádek 1) se kontroluje stejně', () => {
  cells.set(key(1, 2), 'Vinohradská 12, Praha'); edit(1, 2);
  assert.strictEqual(get(1, 5), '✓ Adresa nalezena');
});
test('úprava jiného sloupce adresu nepřepočítává', () => {
  const n = calls.geocode; edit(11, 3); edit(11, 4); edit(11, 1);
  assert.strictEqual(calls.geocode, n);
});
test('úprava mimo oblast (řádek 3, 4, 201) se ignoruje', () => {
  const n = calls.geocode; cells.set(key(3, 2), 'Praha'); edit(3, 2); edit(4, 2); edit(201, 2);
  assert.strictEqual(calls.geocode, n);
});
test('vložení mnoha řádků najednou je omezeno', () => {
  for (let r = 20; r < 70; r++) cells.set(key(r, 2), 'Vinohradská 12, Praha');
  const n = calls.geocode; // z cache, ale smyčka se musí zastavit
  edit(20, 2, 50, 1);
  assert(String(get(20 + 30, 5)).startsWith('⚠ Příliš mnoho'));
});
test('zkontrolovatVse projde všechny řádky', () => {
  cells.set(key(80, 2), 'Vinohradská 12, Praha');
  sandbox.zkontrolovatVse();
  assert.strictEqual(get(80, 5), '✓ Adresa nalezena');
});
test('novyZapas smaže jen sloupec Stav', () => {
  cells.set(key(5, 3), 'Nejedu'); cells.set(key(5, 1), 'Anna'); cells.set(key(5, 4), 4);
  sandbox.novyZapas();
  assert.strictEqual(get(5, 3), ''); assert.strictEqual(get(5, 1), 'Anna'); assert.strictEqual(get(5, 4), 4);
});

console.log(`\nVšech ${passed} testů prošlo.`);
