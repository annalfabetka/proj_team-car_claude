/**
 * Carpool planner - Google Sheet with address validation.
 *
 * How to use: new empty Google Sheet -> Extensions -> Apps Script -> paste this file ->
 * save -> run the `setup` function once (Google asks for permissions).
 *
 * What the script does:
 *  - prepares the "Tým" sheet (header, status dropdown, seat-count check, colours),
 *  - validates an address through Google Maps when it is entered and fills columns E-H
 *    with the check result, the found address and the coordinates (the planning app reads those),
 *  - adds a "Spolujízdy" menu (check all addresses, new match, update an older sheet).
 *
 * Sheet layout (the labels in column A are Czech on purpose, the app finds the rows by them):
 *   row 1   A: "Odkaz pro aplikaci"   B: paste the link from "Publish to web" here once
 *   row 2   A: "Hala (adresa)"        B: hall address        E-H: check (automatic)
 *   row 3   A: "Datum zápasu"         B: date, C: weekday (automatic)
 *   row 4   A: "Čas příjezdu..."      B: e.g. 18:30
 *   row 6   header: Jméno | Adresa | Stav | Míst v autě | Kontrola adresy | Nalezená adresa | Lat | Lon
 *   row 7+  players
 *
 * The planning app finds rows by the labels in the first column ("Hala...", "Datum...", "Čas...",
 * "Jméno"), so do not rename them.
 */

var SHEET_NAME = 'Tým';
var LINK_ROW = 1;
var HALL_ROW = 2;
var DATE_ROW = 3;
var TIME_ROW = 4;
var NOTE_ROW = 5;
var HEADER_ROW = 6;
var FIRST_ROW = 7;
var LAST_ROW = 200;
var MAX_ROWS_PER_EDIT = 30;
var COL = { NAME: 1, ADDR: 2, STATUS: 3, SEATS: 4, CHECK: 5, FOUND: 6, LAT: 7, LON: 8 };
var WEEKDAYS = ['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'];
var DRIVER_STATUSES = ['Určitě beru auto', 'Můžu vzít auto'];
var NON_DRIVER_STATUSES = ['Potřebuji odvoz', 'Nejedu'];
var STATUSES = DRIVER_STATUSES.concat(NON_DRIVER_STATUSES);
var HEADER_LABELS = ['Jméno', 'Adresa', 'Stav', 'Míst v autě', 'Kontrola adresy', 'Nalezená adresa', 'Lat', 'Lon'];

// Result types that count as precise enough for a pickup (street + number / a specific place).
var PRECISE_TYPES = ['street_address', 'premise', 'subpremise', 'establishment',
  'point_of_interest', 'park', 'airport', 'train_station', 'transit_station'];

/* ---------- one-time setup ---------- */

/* ---------- shared row preparation (used by setup and migrate) ---------- */

function prepareLinkRow(sh, savedLink) {
  sh.getRange(LINK_ROW, 1, 1, 8).clearFormat();
  sh.getRange(LINK_ROW, COL.NAME).setValue('Odkaz pro aplikaci').setFontWeight('bold');
  sh.getRange(LINK_ROW, COL.ADDR).setNumberFormat('@').setValue(savedLink || '').setBackground('#fff8d6'); // cell for pasting the link
}

function prepareDateRow(sh) {
  sh.getRange(DATE_ROW, 1, 1, 8).clearFormat();
  sh.getRange(DATE_ROW, COL.NAME).setValue('Datum zápasu').setFontWeight('bold');
  sh.getRange(DATE_ROW, COL.ADDR).setNumberFormat('d. M. yyyy').setValue('');
  var dateRule = SpreadsheetApp.newDataValidation().requireDate()
    .setAllowInvalid(false).setHelpText('Datum zápasu, např. 2. 12. 2026.').build();
  sh.getRange(DATE_ROW, COL.ADDR).setDataValidation(dateRule);
  // the weekday is filled in automatically (in Czech, independent of the sheet's language)
  var b = 'B' + DATE_ROW;
  sh.getRange(DATE_ROW, COL.STATUS).setFormula('=IF(' + b + '="","",IFERROR(CHOOSE(WEEKDAY(' + b + ',2),"' +
    WEEKDAYS.join('","') + '"),""))').setBackground('#f3f4f7');
  sh.getRange(DATE_ROW, COL.CHECK, 1, 4).setBackground('#f3f4f7');
}

/**
 * (Re)installs the edit trigger. It must be an installable trigger so that it may call Maps.
 * Also removes the trigger under its old name (`priUprave`) left by earlier versions of this script.
 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var name = t.getHandlerFunction();
    if (name === 'onEditCheck' || name === 'priUprave') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditCheck').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}

/**
 * Fills in column headings that are missing from the header row. Never overwrites existing text,
 * so a heading renamed by hand stays as it is. Returns true when something was filled in.
 */
function ensureHeader(sh) {
  var current = sh.getRange(HEADER_ROW, 1, 1, 8).getValues()[0];
  var filled = false;
  var labels = current.map(function (value, i) {
    if (String(value).trim() !== '') return value;
    filled = true;
    return HEADER_LABELS[i];
  });
  if (!filled) return false;
  sh.getRange(HEADER_ROW, 1, 1, 8).setValues([labels]).setFontWeight('bold').setBackground('#e8eaf0');
  return true;
}

/* ---------- layout guard ---------- */

var LAYOUT_MISMATCH = 'Rozložení tabulky neodpovídá skriptu, proto jsem nic neměnil. ' +
  'Spusťte funkci „migrate“ (Spolujízdy → Aktualizovat starší tabulku).';

/**
 * True when the sheet has the layout this script expects. Rows are recognised by their labels in
 * column A. When script and sheet disagree about the rows, writing could damage the sheet
 * (for example overwrite the header row), so every writing function checks this first.
 */
function layoutMatches(sh) {
  var label = function (r) { return String(sh.getRange(r, COL.NAME).getValue()).toLowerCase(); };
  return label(LINK_ROW).indexOf('odkaz') === 0 && label(HALL_ROW).indexOf('hala') === 0 &&
    label(DATE_ROW).indexOf('datum') === 0 && label(TIME_ROW).indexOf('čas') === 0 &&
    label(HEADER_ROW).indexOf('jm') === 0;
}

/* ---------- seat count: asked of drivers only ---------- */

/** Spreadsheet formula fragment: is the status in column C of the first player row a driver status? */
function driverCondition() {
  var c = '$C' + FIRST_ROW;
  return 'OR(' + c + '="' + DRIVER_STATUSES[0] + '",' + c + '="' + DRIVER_STATUSES[1] + '")';
}

function statusValidation() {
  return SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true)
    .setAllowInvalid(false).setHelpText('Vyberte ze seznamu.').build();
}

/** Seats may only be filled in for drivers (a whole number 2-9, driver included); otherwise the cell stays empty. */
function seatsValidation() {
  var d = 'D' + FIRST_ROW;
  return SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=OR(' + d + '="",AND(' + driverCondition() + ',ISNUMBER(' + d + '),' +
      d + '>=2,' + d + '<=9,' + d + '=INT(' + d + ')))')
    .setAllowInvalid(false)
    .setHelpText('Počet míst se vyplňuje jen u řidiček (stav „Určitě beru auto“ nebo „Můžu vzít auto“): celé číslo 2–9 včetně řidičky.')
    .build();
}

/** Colour rules: orange when a driver has no seat count, grey when the cell is not asked at all. */
function seatsRules(sh) {
  var range = [sh.getRange(FIRST_ROW, COL.SEATS, LAST_ROW - FIRST_ROW + 1, 1)];
  return [
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(' + driverCondition() + ',NOT(ISNUMBER($D' + FIRST_ROW + ')))')
      .setBackground('#ffe8b3').setRanges(range).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=NOT(' + driverCondition() + ')')
      .setBackground('#eceef2').setRanges(range).build(),
  ];
}

function hasFormulaRule(rules, formula) {
  return rules.some(function (rule) {
    var c = rule.getBooleanCondition();
    return !!c && c.getCriteriaValues().indexOf(formula) !== -1;
  });
}

/**
 * Clears the seat count of players whose status says they are not driving. Returns how many were cleared.
 * Reads the status and seat columns in one go (cell-by-cell reads are slow in Google Sheets).
 */
function clearSeatsOfPassengers(sh, fromRow, toRow) {
  if (toRow < fromRow) return 0;
  var values = sh.getRange(fromRow, COL.STATUS, toRow - fromRow + 1, COL.SEATS - COL.STATUS + 1).getValues();
  var cleared = 0;
  values.forEach(function (v, i) {
    if (NON_DRIVER_STATUSES.indexOf(String(v[0])) !== -1 && String(v[v.length - 1]) !== '') {
      sh.getRange(fromRow + i, COL.SEATS).clearContent();
      cleared++;
    }
  });
  return cleared;
}

/** Colour rules for the date: yellow when missing, red when in the past (stale statuses). */
function dateRules(sh) {
  var range = [sh.getRange(DATE_ROW, COL.ADDR)];
  var b = '$B$' + DATE_ROW;
  return [
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + b + '=""')
      .setBackground('#ffe8b3').setRanges(range).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER(' + b + '),' + b + '<TODAY())')
      .setBackground('#f8d7da').setFontColor('#a4262c').setRanges(range).build(),
  ];
}


function setup() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var sh = ss.getSheetByName(SHEET_NAME);
  var savedLink = '';
  if (sh) {
    // running it again would erase the data, so ask first
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

  // labels
  prepareLinkRow(sh, savedLink);
  sh.getRange(HALL_ROW, COL.NAME).setValue('Hala (adresa)');
  prepareDateRow(sh);
  sh.getRange(TIME_ROW, COL.NAME).setValue('Čas příjezdu do haly');
  sh.getRange(TIME_ROW, COL.ADDR).setNumberFormat('@').setValue('18:30');
  sh.getRange(NOTE_ROW, COL.NAME).setValue(
    'Vyplňujte jen bílá pole. Sloupce E–H se doplní samy. Odkaz v prvním řádku vložte po zveřejnění tabulky (Soubor → Sdílet → Publikovat na webu → CSV).');
  sh.getRange(HEADER_ROW, 1, 1, 8).setValues([HEADER_LABELS]);

  // appearance
  sh.getRange(LINK_ROW, COL.NAME, TIME_ROW, 1).setFontWeight('bold');
  sh.getRange(NOTE_ROW, COL.NAME).setFontStyle('italic').setFontColor('#6a7385');
  sh.getRange(HEADER_ROW, 1, 1, 8).setFontWeight('bold').setBackground('#e8eaf0');
  sh.getRange(HALL_ROW, COL.CHECK, TIME_ROW - HALL_ROW + 1, 4).setBackground('#f3f4f7');
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

  // coordinates as text so the decimal comma and point never get mixed up
  sh.getRange(HALL_ROW, COL.LAT, LAST_ROW - HALL_ROW + 1, 2).setNumberFormat('@');

  // input validation
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(statusValidation());
  sh.getRange(FIRST_ROW, COL.SEATS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(seatsValidation());
  var timeRule = SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=REGEXMATCH(TO_TEXT(B' + TIME_ROW + '),"^\\d{1,2}[:.]\\d{2}$")')
    .setAllowInvalid(false).setHelpText('Čas ve tvaru 18:30.').build();
  sh.getRange(TIME_ROW, COL.ADDR).setDataValidation(timeRule);

  // colour warnings
  var checkRange = [sh.getRange(HALL_ROW, COL.CHECK, 1, 1),
    sh.getRange(FIRST_ROW, COL.CHECK, LAST_ROW - FIRST_ROW + 1, 1)];
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✗')
      .setBackground('#f8d7da').setFontColor('#a4262c').setRanges(checkRange).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('⚠')
      .setBackground('#ffe8b3').setFontColor('#7a4b00').setRanges(checkRange).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✓')
      .setFontColor('#1a7f3c').setRanges(checkRange).build(),
  ].concat(seatsRules(sh), dateRules(sh)));

  // protect labels, header and automatic columns from accidental edits (warning only)
  sh.getRange(LINK_ROW, COL.NAME, HEADER_ROW, 1).protect().setWarningOnly(true);
  sh.getRange(HEADER_ROW, 1, 1, 8).protect().setWarningOnly(true);
  sh.getRange(HALL_ROW, COL.CHECK, TIME_ROW - HALL_ROW + 1, 4).protect().setWarningOnly(true);
  sh.getRange(DATE_ROW, COL.STATUS).protect().setWarningOnly(true);
  sh.getRange(FIRST_ROW, COL.CHECK, LAST_ROW - FIRST_ROW + 1, 4).protect().setWarningOnly(true);

  installTrigger();

  ui.alert('Hotovo. Do sloupce „Adresa“ zkuste napsat adresu, vedle se objeví kontrola. ' +
    'Nastavte datum zápasu a až tabulku zveřejníte, vložte odkaz do žlutého pole v prvním řádku.');
}

/* ---------- menu ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Spolujízdy')
    .addItem('Zkontrolovat všechny adresy', 'checkAll')
    .addItem('Nový zápas (vymazat stavy)', 'newMatch')
    .addSeparator()
    .addItem('Aktualizovat starší tabulku (nové řádky)', 'migrate')
    .addToUi();
}

function checkAll() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { SpreadsheetApp.getUi().alert('Nejdřív spusťte funkci „setup“.'); return; }
  if (!layoutMatches(sh)) { SpreadsheetApp.getUi().alert(LAYOUT_MISMATCH); return; }
  checkRow(sh, HALL_ROW);
  var last = Math.min(sh.getLastRow(), LAST_ROW);
  if (last >= FIRST_ROW) {
    // read the address and check columns once; skip rows that have neither
    var values = sh.getRange(FIRST_ROW, COL.ADDR, last - FIRST_ROW + 1, COL.CHECK - COL.ADDR + 1).getValues();
    values.forEach(function (v, i) {
      if (String(v[0]).trim() !== '' || String(v[v.length - 1]) !== '') checkRow(sh, FIRST_ROW + i);
    });
  }
  ss.toast('Kontrola dokončena.');
}

function newMatch() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) { ui.alert('Nejdřív spusťte funkci „setup“.'); return; }
  if (!layoutMatches(sh)) { ui.alert(LAYOUT_MISMATCH); return; }
  if (ui.alert('Vymazat stav všech hráček pro nový zápas?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).clearContent();
  ui.alert('Stavy jsou vymazané. Nezapomeňte nastavit nové datum zápasu (řádek „Datum zápasu“).');
}

/**
 * Adds the rows a sheet from an older version lacks (link to the published sheet, match date)
 * and deletes nothing: players, addresses and statuses stay. Also reinstalls the edit trigger.
 * Run it right after pasting a new version of the script. Works for any older version
 * and only adds what is missing.
 */
function migrate() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) { ui.alert('List „' + SHEET_NAME + '“ nenalezen. Spusťte funkci „setup“.'); return; }
  installTrigger(); // the trigger handler was renamed, so always refresh it
  var label = function (r) { return String(sh.getRange(r, COL.NAME).getValue()).toLowerCase(); };
  var first = label(1);
  if (first.indexOf('odkaz') !== 0 && first.indexOf('hala') !== 0) {
    ui.alert('Rozložení listu nepoznávám, nic jsem neměnil.'); return;
  }
  var added = [];
  if (label(LINK_ROW).indexOf('odkaz') !== 0) {
    sh.insertRowBefore(LINK_ROW);
    prepareLinkRow(sh, '');
    added.push('řádek s odkazem');
  }
  if (label(DATE_ROW).indexOf('datum') !== 0) {
    if (label(HALL_ROW).indexOf('hala') !== 0) { ui.alert('Rozložení listu nepoznávám, nic jsem neměnil.'); return; }
    sh.insertRowBefore(DATE_ROW);
    prepareDateRow(sh);
    sh.setConditionalFormatRules(sh.getConditionalFormatRules().concat(dateRules(sh)));
    added.push('řádek s datem zápasu');
  }
  if (added.length) sh.setFrozenRows(HEADER_ROW);

  // seat-count rules (validation + colours) and tidy-up of stale seat counts of passengers
  var rules = sh.getConditionalFormatRules();
  seatsRules(sh).forEach(function (rule) {
    if (!hasFormulaRule(rules, rule.getBooleanCondition().getCriteriaValues()[0])) rules = rules.concat(rule);
  });
  sh.setConditionalFormatRules(rules);
  sh.getRange(HEADER_ROW, 1, 1, 8).clearDataValidations(); // headings must never carry a dropdown
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(statusValidation());
  sh.getRange(FIRST_ROW, COL.SEATS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(seatsValidation());
  var cleared = clearSeatsOfPassengers(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW));
  var headerRestored = ensureHeader(sh);

  var msg = added.length
    ? 'Hotovo, přidáno: ' + added.join(', ') + '. Vyplňte datum zápasu' +
      (added[0] === 'řádek s odkazem' ? ' a vložte odkaz ze „Soubor → Sdílet → Publikovat na webu“ do žlutého pole v 1. řádku' : '') + '.'
    : 'Tabulka už má nové rozložení, nic se nepřidávalo.';
  msg += ' Pravidla pro počet míst (jen u řidiček) a spouštěč kontroly adres jsou aktualizované.';
  if (cleared) msg += ' Vymazán zbylý počet míst u spolucestujících: ' + cleared + '.';
  if (headerRestored) msg += ' Doplněny chybějící nadpisy sloupců v řádku ' + HEADER_ROW + '.';
  ui.alert(msg);
}

/* ---------- check after an edit ---------- */

function onEditCheck(e) {
  if (!e || !e.range) return;
  var range = e.range, sh = range.getSheet();
  if (sh.getName() !== SHEET_NAME) return;
  if (!layoutMatches(sh)) { SpreadsheetApp.getActive().toast(LAYOUT_MISMATCH); return; }
  // a passenger / non-attending player has no seat count: clear it when the status changes
  if (range.getColumn() <= COL.STATUS && range.getLastColumn() >= COL.STATUS) {
    clearSeatsOfPassengers(sh, Math.max(range.getRow(), FIRST_ROW), Math.min(range.getLastRow(), LAST_ROW));
  }
  if (range.getLastColumn() < COL.ADDR || range.getColumn() > COL.ADDR) return; // the address was not edited
  var done = 0;
  for (var row = range.getRow(); row <= range.getLastRow(); row++) {
    if (row !== HALL_ROW && (row < FIRST_ROW || row > LAST_ROW)) continue;
    if (done++ >= MAX_ROWS_PER_EDIT) {
      sh.getRange(row, COL.CHECK).setValue('⚠ Příliš mnoho řádků najednou, použijte Spolujízdy → Zkontrolovat všechny adresy.');
      break;
    }
    checkRow(sh, row);
  }
}

function checkRow(sh, row) {
  var addr = String(sh.getRange(row, COL.ADDR).getValue()).trim();
  var out = addr ? geocode(addr) : { check: '', found: '', lat: '', lon: '' };
  sh.getRange(row, COL.CHECK, 1, 4).setValues([[out.check, out.found, out.lat, out.lon]]);
}

/* ---------- geocoding ---------- */

function geocode(addr) {
  var cache = CacheService.getScriptCache();
  var key = 'g' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, addr.toLowerCase()));
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) { /* no cache */ }

  var resp;
  try {
    resp = Maps.newGeocoder().setRegion('cz').setLanguage('cs').geocode(addr);
  } catch (err) {
    return { check: '⚠ Služba Mapy je dočasně nedostupná, zkuste to za chvíli.', found: '', lat: '', lon: '' };
  }
  var out = evaluateGeocode(resp);
  if (resp && (resp.status === 'OK' || resp.status === 'ZERO_RESULTS')) {
    try { cache.put(key, JSON.stringify(out), 21600); } catch (err) { /* ignore */ }
  }
  return out;
}

/** Pure function: turns a geocoder response into the contents of the columns check / found address / lat / lon. */
function evaluateGeocode(resp) {
  if (!resp || (resp.status !== 'OK' && resp.status !== 'ZERO_RESULTS')) {
    // outage, exceeded quota etc.: not an error in the address
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
