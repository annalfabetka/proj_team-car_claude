/**
 * Spolujízdy na zápasy – Google tabulka s kontrolou adres.
 *
 * Jak na to: nová prázdná Google tabulka → Rozšíření → Apps Script → vložit tento
 * soubor → uložit → spustit funkci „nastavit“ (jednou, Google se zeptá na oprávnění).
 *
 * Co skript dělá:
 *  - připraví list „Tým“ (záhlaví, rozbalovací stav, kontrola počtu míst, barvy),
 *  - po zadání adresy ji ověří přes Google Mapy a do sloupců E–H doplní kontrolu,
 *    nalezenou adresu a souřadnice (ty pak čte plánovací aplikace),
 *  - přidá nabídku „Spolujízdy“ (zkontrolovat všechny adresy, nový zápas).
 *
 * Rozložení listu:
 *   řádek 1  A: „Odkaz na zveřejněnou tabulku“   B: sem jednou vložte odkaz ze „Publikovat na webu“
 *   řádek 2  A: „Hala (adresa)“                  B: adresa haly       E–H: kontrola (automaticky)
 *   řádek 3  A: „Čas příjezdu…“                  B: např. 18:30
 *   řádek 5  záhlaví: Jméno | Adresa | Stav | Míst v autě | Kontrola adresy | Nalezená adresa | Lat | Lon
 *   řádek 6+ hráčky
 *
 * Plánovací aplikace hledá řádky podle popisků v prvním sloupci („Hala…“, „Čas…“, „Jméno“),
 * proto je neměňte.
 */

var SHEET_NAME = 'Tým';
var LINK_ROW = 1;
var HALL_ROW = 2;
var TIME_ROW = 3;
var NOTE_ROW = 4;
var HEADER_ROW = 5;
var FIRST_ROW = 6;
var LAST_ROW = 200;
var MAX_ROWS_PER_EDIT = 30;
var COL = { NAME: 1, ADDR: 2, STATUS: 3, SEATS: 4, CHECK: 5, FOUND: 6, LAT: 7, LON: 8 };
var STATUSES = ['Určitě beru auto', 'Můžu vzít auto', 'Potřebuji odvoz', 'Nejedu'];

// Typy výsledků, které považujeme za dost přesné pro vyzvednutí (ulice + číslo / konkrétní místo).
var PRECISE_TYPES = ['street_address', 'premise', 'subpremise', 'establishment',
  'point_of_interest', 'park', 'airport', 'train_station', 'transit_station'];

/* ---------- jednorázové nastavení ---------- */

function nastavit() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var sh = ss.getSheetByName(SHEET_NAME);
  var savedLink = '';
  if (sh) {
    // opakované spuštění by smazalo data, proto se nejdřív zeptáme
    var hasData = sh.getLastRow() >= FIRST_ROW &&
      sh.getRange(FIRST_ROW, 1, sh.getLastRow() - FIRST_ROW + 1, 2).getValues()
        .some(function (r) { return String(r[0] || r[1]).trim() !== ''; });
    if (hasData && ui.alert('List „' + SHEET_NAME + '“ už obsahuje hráčky. Nastavení je přepíše. Pokračovat?',
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    savedLink = String(sh.getRange(LINK_ROW, COL.ADDR).getValue() || '');
  } else {
    var first = ss.getSheets()[0];
    if (ss.getSheets().length === 1 && first.getLastRow() <= 1 && first.getLastColumn() <= 1) {
      sh = first; sh.setName(SHEET_NAME);
    } else {
      sh = ss.insertSheet(SHEET_NAME);
    }
  }
  sh.clear();
  sh.clearConditionalFormatRules();

  // popisky
  sh.getRange(LINK_ROW, COL.NAME).setValue('Odkaz na zveřejněnou tabulku');
  sh.getRange(LINK_ROW, COL.ADDR).setNumberFormat('@').setValue(savedLink);
  sh.getRange(HALL_ROW, COL.NAME).setValue('Hala (adresa)');
  sh.getRange(TIME_ROW, COL.NAME).setValue('Čas příjezdu do haly');
  sh.getRange(TIME_ROW, COL.ADDR).setNumberFormat('@').setValue('18:30');
  sh.getRange(NOTE_ROW, COL.NAME).setValue(
    'Vyplňujte jen bílá pole. Sloupce E–H se doplní samy. Odkaz v prvním řádku vložte po zveřejnění tabulky (Soubor → Sdílet → Publikovat na webu → CSV).');
  sh.getRange(HEADER_ROW, 1, 1, 8).setValues([[
    'Jméno', 'Adresa', 'Stav', 'Míst v autě', 'Kontrola adresy', 'Nalezená adresa', 'Lat', 'Lon']]);

  // vzhled
  sh.getRange(LINK_ROW, COL.NAME, TIME_ROW, 1).setFontWeight('bold');
  sh.getRange(LINK_ROW, COL.ADDR).setBackground('#fff8d6'); // pole k vložení odkazu
  sh.getRange(NOTE_ROW, COL.NAME).setFontStyle('italic').setFontColor('#6a7385');
  sh.getRange(HEADER_ROW, 1, 1, 8).setFontWeight('bold').setBackground('#e8eaf0');
  sh.getRange(HALL_ROW, COL.CHECK, 2, 4).setBackground('#f3f4f7');
  sh.getRange(FIRST_ROW, COL.CHECK, LAST_ROW - FIRST_ROW + 1, 4).setBackground('#f3f4f7');
  sh.getRange(HALL_ROW, COL.LAT, LAST_ROW - HALL_ROW + 1, 2).setFontColor('#8a93a5');
  sh.setFrozenRows(HEADER_ROW);
  sh.setColumnWidth(COL.NAME, 190);
  sh.setColumnWidth(COL.ADDR, 280);
  sh.setColumnWidth(COL.STATUS, 160);
  sh.setColumnWidth(COL.SEATS, 90);
  sh.setColumnWidth(COL.CHECK, 260);
  sh.setColumnWidth(COL.FOUND, 300);
  sh.setColumnWidth(COL.LAT, 90);
  sh.setColumnWidth(COL.LON, 90);

  // souřadnice jako text, aby se nepletla desetinná čárka a tečka
  sh.getRange(HALL_ROW, COL.LAT, LAST_ROW - HALL_ROW + 1, 2).setNumberFormat('@');

  // ověřování vstupů
  var statusRule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true)
    .setAllowInvalid(false).setHelpText('Vyberte ze seznamu.').build();
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(statusRule);
  var seatsRule = SpreadsheetApp.newDataValidation().requireNumberBetween(2, 9)
    .setAllowInvalid(false).setHelpText('Počet míst v autě včetně řidičky (2–9).').build();
  sh.getRange(FIRST_ROW, COL.SEATS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(seatsRule);
  var timeRule = SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=REGEXMATCH(TO_TEXT(B' + TIME_ROW + '),"^\\d{1,2}[:.]\\d{2}$")')
    .setAllowInvalid(false).setHelpText('Čas ve tvaru 18:30.').build();
  sh.getRange(TIME_ROW, COL.ADDR).setDataValidation(timeRule);

  // barevné upozornění
  var checkRange = [sh.getRange(HALL_ROW, COL.CHECK, 1, 1),
    sh.getRange(FIRST_ROW, COL.CHECK, LAST_ROW - FIRST_ROW + 1, 1)];
  var seatsRange = sh.getRange(FIRST_ROW, COL.SEATS, LAST_ROW - FIRST_ROW + 1, 1);
  var r = FIRST_ROW;
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✗')
      .setBackground('#f8d7da').setFontColor('#a4262c').setRanges(checkRange).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('⚠')
      .setBackground('#ffe8b3').setFontColor('#7a4b00').setRanges(checkRange).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✓')
      .setFontColor('#1a7f3c').setRanges(checkRange).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(OR($C' + r + '="Určitě beru auto",$C' + r + '="Můžu vzít auto"),NOT(ISNUMBER($D' + r + ')))')
      .setBackground('#ffe8b3').setRanges([seatsRange]).build(),
  ]);

  // popisky, záhlaví a automatické sloupce chrání před nechtěným přepsáním (jen varování)
  sh.getRange(LINK_ROW, COL.NAME, HEADER_ROW, 1).protect().setWarningOnly(true);
  sh.getRange(HEADER_ROW, 1, 1, 8).protect().setWarningOnly(true);
  sh.getRange(HALL_ROW, COL.CHECK, 2, 4).protect().setWarningOnly(true);
  sh.getRange(FIRST_ROW, COL.CHECK, LAST_ROW - FIRST_ROW + 1, 4).protect().setWarningOnly(true);

  // spouštěč po úpravě (musí být „instalovaný“, aby směl volat Mapy)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'priUprave') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('priUprave').forSpreadsheet(ss).onEdit().create();

  ui.alert('Hotovo. Do sloupce „Adresa“ zkuste napsat adresu, vedle se objeví kontrola. ' +
    'Až tabulku zveřejníte, vložte odkaz do žlutého pole v prvním řádku.');
}

/* ---------- nabídka ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Spolujízdy')
    .addItem('Zkontrolovat všechny adresy', 'zkontrolovatVse')
    .addItem('Nový zápas (vymazat stavy)', 'novyZapas')
    .addSeparator()
    .addItem('Aktualizovat starší tabulku (řádek s odkazem)', 'migrovat')
    .addToUi();
}

function zkontrolovatVse() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) { SpreadsheetApp.getUi().alert('Nejdřív spusťte funkci „nastavit“.'); return; }
  kontrolaRadku(sh, HALL_ROW);
  var last = Math.min(sh.getLastRow(), LAST_ROW);
  for (var row = FIRST_ROW; row <= last; row++) kontrolaRadku(sh, row);
  SpreadsheetApp.getActive().toast('Kontrola dokončena.');
}

function novyZapas() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Vymazat stav všech hráček pro nový zápas?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).clearContent();
}

/**
 * Starší tabulka měla v 1. řádku halu. Tato funkce nahoru vloží řádek pro odkaz a nic nemaže:
 * hráčky, adresy ani stavy zůstanou. Spusťte ji hned po vložení nové verze skriptu.
 */
function migrovat() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) { ui.alert('List „' + SHEET_NAME + '“ nenalezen. Spusťte funkci „nastavit“.'); return; }
  var a1 = String(sh.getRange(1, COL.NAME).getValue()).toLowerCase();
  if (a1.indexOf('odkaz') === 0) { ui.alert('Tabulka už má nové rozložení (řádek s odkazem), nic se neměnilo.'); return; }
  if (a1.indexOf('hala') !== 0) { ui.alert('Rozložení listu nepoznávám, nic jsem neměnil.'); return; }
  sh.insertRowBefore(LINK_ROW);
  sh.getRange(LINK_ROW, COL.NAME).setValue('Odkaz na zveřejněnou tabulku').setFontWeight('bold');
  sh.getRange(LINK_ROW, COL.ADDR).setValue('').setNumberFormat('@').setBackground('#fff8d6');
  sh.setFrozenRows(HEADER_ROW);
  ui.alert('Hotovo. Do žlutého pole v prvním řádku vložte odkaz ze „Soubor → Sdílet → Publikovat na webu“.');
}

/* ---------- kontrola po úpravě ---------- */

function priUprave(e) {
  if (!e || !e.range) return;
  var range = e.range, sh = range.getSheet();
  if (sh.getName() !== SHEET_NAME) return;
  if (range.getLastColumn() < COL.ADDR || range.getColumn() > COL.ADDR) return; // adresa se nezměnila
  var done = 0;
  for (var row = range.getRow(); row <= range.getLastRow(); row++) {
    if (row !== HALL_ROW && (row < FIRST_ROW || row > LAST_ROW)) continue;
    if (done++ >= MAX_ROWS_PER_EDIT) {
      sh.getRange(row, COL.CHECK).setValue('⚠ Příliš mnoho řádků najednou, použijte Spolujízdy → Zkontrolovat všechny adresy.');
      break;
    }
    kontrolaRadku(sh, row);
  }
}

function kontrolaRadku(sh, row) {
  var addr = String(sh.getRange(row, COL.ADDR).getValue()).trim();
  var out = addr ? geokoduj(addr) : { check: '', found: '', lat: '', lon: '' };
  sh.getRange(row, COL.CHECK, 1, 4).setValues([[out.check, out.found, out.lat, out.lon]]);
}

/* ---------- geokódování ---------- */

function geokoduj(addr) {
  var cache = CacheService.getScriptCache();
  var key = 'g' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, addr.toLowerCase()));
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) { /* bez cache */ }

  var resp;
  try {
    resp = Maps.newGeocoder().setRegion('cz').setLanguage('cs').geocode(addr);
  } catch (err) {
    return { check: '⚠ Služba Mapy je dočasně nedostupná, zkuste to za chvíli.', found: '', lat: '', lon: '' };
  }
  var out = vyhodnot(resp);
  if (resp && (resp.status === 'OK' || resp.status === 'ZERO_RESULTS')) {
    try { cache.put(key, JSON.stringify(out), 21600); } catch (err) { /* ignoruj */ }
  }
  return out;
}

/** Čistá funkce: z odpovědi geokodéru udělá obsah sloupců kontrola / nalezená adresa / lat / lon. */
function vyhodnot(resp) {
  if (!resp || (resp.status !== 'OK' && resp.status !== 'ZERO_RESULTS')) {
    // výpadek, překročený limit apod. – nejde o chybu v adrese
    return { check: '⚠ Služba Mapy je dočasně nedostupná, zkuste to za chvíli.', found: '', lat: '', lon: '' };
  }
  if (resp.status === 'ZERO_RESULTS' || !resp.results || !resp.results.length) {
    return { check: '✗ Adresa nenalezena. Zkuste tvar „Ulice číslo, Město“.', found: '', lat: '', lon: '' };
  }
  var r = resp.results[0];
  var types = r.types || [];
  var found = r.formatted_address || '';
  var loc = r.geometry && r.geometry.location;
  var precise = types.some(function (t) { return PRECISE_TYPES.indexOf(t) !== -1; });

  if (!loc) return { check: '✗ Adresa nenalezena.', found: '', lat: '', lon: '' };
  if (!precise) {
    return { check: '⚠ Upřesněte adresu: chybí ulice a číslo domu.', found: found, lat: '', lon: '' };
  }
  var lat = String(Math.round(loc.lat * 1e6) / 1e6), lon = String(Math.round(loc.lng * 1e6) / 1e6);
  if (r.partial_match) {
    return { check: '⚠ Zkontrolujte, zda nalezená adresa sedí.', found: found, lat: lat, lon: lon };
  }
  return { check: '✓ Adresa nalezena', found: found, lat: lat, lon: lon };
}
