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
 * Columns I-O describe the trip back: I "Návrat" (same as there / somewhere else / no ride needed),
 * J "Míst zpět" (drivers only: seats on the way back), K the return address with its check in L-O.
 * Columns P "Tam s (pevně)" and Q "Zpět s (pevně)" (passengers only): the driver she has agreed to ride with on the
 * way there / back; the planner always puts her into that car. Q empty = the same as there.
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
var COL = { NAME: 1, ADDR: 2, STATUS: 3, SEATS: 4, CHECK: 5, FOUND: 6, LAT: 7, LON: 8,
  // the trip back
  RETURN: 9, SEATS_BACK: 10, RET_ADDR: 11, RET_CHECK: 12, RET_FOUND: 13, RET_LAT: 14, RET_LON: 15,
  RIDES_WITH: 16, RETURN_WITH: 17 };   // a passenger's fixed agreements: the driver she rides with there / back
var RETURN_MODES = ['Stejně jako tam', 'Jinam', 'Odvoz zpět nepotřebuji'];
var RETURN_ELSEWHERE = 'Jinam';
var LEGACY_RIDES_WITH_LABEL = 'Jedu s (pevně)';   // the first version of column P
var LEGACY_TAKES_BACK_LABEL = 'Zpět vezmu spolucestující';   // the earlier yes/no version of column J
var WEEKDAYS = ['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'];
var DRIVER_STATUSES = ['Určitě beru auto', 'Můžu vzít auto'];
var NON_DRIVER_STATUSES = ['Potřebuji odvoz', 'Nejedu'];
var STATUSES = DRIVER_STATUSES.concat(NON_DRIVER_STATUSES);
var HEADER_LABELS = ['Jméno', 'Adresa', 'Stav', 'Míst v autě', 'Kontrola adresy', 'Nalezená adresa', 'Lat', 'Lon',
  'Návrat', 'Míst zpět', 'Adresa návratu', 'Kontrola návratu', 'Nalezená adresa návratu', 'Lat zpět', 'Lon zpět', 'Tam s (pevně)', 'Zpět s (pevně)'];
var LAST_COL = HEADER_LABELS.length;

// Result types that count as precise enough for a pickup (street + number / a specific place).
var PRECISE_TYPES = ['street_address', 'premise', 'subpremise', 'establishment',
  'point_of_interest', 'park', 'airport', 'train_station', 'transit_station'];

/* ---------- one-time setup ---------- */

/* ---------- shared row preparation (used by setup and migrate) ---------- */

function prepareLinkRow(sh, savedLink) {
  sh.getRange(LINK_ROW, 1, 1, LAST_COL).clearFormat();
  sh.getRange(LINK_ROW, COL.NAME).setValue('Odkaz pro aplikaci').setFontWeight('bold');
  sh.getRange(LINK_ROW, COL.ADDR).setNumberFormat('@').setValue(savedLink || '').setBackground('#fff8d6'); // cell for pasting the link
}

function prepareDateRow(sh) {
  sh.getRange(DATE_ROW, 1, 1, LAST_COL).clearFormat();
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
  var current = sh.getRange(HEADER_ROW, 1, 1, LAST_COL).getValues()[0];
  var filled = false;
  var labels = current.map(function (value, i) {
    if (String(value).trim() !== '') return value;
    filled = true;
    return HEADER_LABELS[i];
  });
  if (!filled) return false;
  sh.getRange(HEADER_ROW, 1, 1, LAST_COL).setValues([labels]).setFontWeight('bold').setBackground('#e8eaf0');
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

/**
 * The seat count and the seats on the way back only make sense for drivers: clears them for players whose
 * status says they are not driving. Returns how many players had something cleared.
 * Reads in one go (cell-by-cell reads are slow in Google Sheets).
 */
function clearDriverOnlyFields(sh, fromRow, toRow) {
  if (toRow < fromRow) return 0;
  var values = sh.getRange(fromRow, COL.STATUS, toRow - fromRow + 1, COL.SEATS_BACK - COL.STATUS + 1).getValues();
  var seatsAt = COL.SEATS - COL.STATUS, takesAt = COL.SEATS_BACK - COL.STATUS, cleared = 0;
  values.forEach(function (v, i) {
    if (NON_DRIVER_STATUSES.indexOf(String(v[0])) === -1) return;
    var any = false;
    if (String(v[seatsAt]) !== '') { sh.getRange(fromRow + i, COL.SEATS).clearContent(); any = true; }
    if (String(v[takesAt]) !== '') { sh.getRange(fromRow + i, COL.SEATS_BACK).clearContent(); any = true; }
    if (any) cleared++;
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


/* ---------- fixed agreements: "Tam s (pevně)" (P) and "Zpět s (pevně)" (Q) ---------- */

var PIN_COLUMNS = [COL.RIDES_WITH, COL.RETURN_WITH];
var COLUMN_LETTER = { 16: 'P', 17: 'Q' };

/** Dropdown with the names of the players: the driver this passenger has agreed to ride with. */
function ridesWithValidation(sh, helpText) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInRange(sh.getRange(FIRST_ROW, COL.NAME, LAST_ROW - FIRST_ROW + 1, 1), true)
    .setAllowInvalid(false)
    .setHelpText(helpText)
    .build();
}

function formulaRule(formula, ranges, background, font) {
  var b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setRanges(ranges);
  if (background) b = b.setBackground(background);
  if (font) b = b.setFontColor(font);
  return b.build();
}

/** Colours (both columns): grey for drivers (they drive themselves), orange when the name is no longer in the list. */
function pinRules(sh) {
  var r = FIRST_ROW, names = '$A$' + FIRST_ROW + ':$A$' + LAST_ROW;
  var rules = [];
  PIN_COLUMNS.forEach(function (col) {
    var range = [sh.getRange(FIRST_ROW, col, LAST_ROW - FIRST_ROW + 1, 1)];
    var cell = '$' + COLUMN_LETTER[col] + r;
    rules.push(formulaRule('=' + driverCondition(), range, '#eceef2', null));
    rules.push(formulaRule('=AND(' + cell + '<>"",COUNTIF(' + names + ',' + cell + ')=0)', range, '#ffe8b3', null));
  });
  return rules;
}

/** Validation and width of both columns. Safe to run repeatedly. */
function applyPinColumn(sh) {
  var rows = LAST_ROW - FIRST_ROW + 1;
  sh.getRange(FIRST_ROW, COL.RIDES_WITH, rows, 1).setDataValidation(ridesWithValidation(sh,
    'Jen pro spolucestující: jméno řidičky, se kterou jste se domluvila na cestu tam. Plánovač vás do jejího auta zařadí vždy.'));
  sh.getRange(FIRST_ROW, COL.RETURN_WITH, rows, 1).setDataValidation(ridesWithValidation(sh,
    'Jen pro spolucestující: jméno řidičky, se kterou jste se domluvila na cestu zpět. Prázdné = stejně jako tam.'));
  sh.setColumnWidth(COL.RIDES_WITH, 170);
  sh.setColumnWidth(COL.RETURN_WITH, 170);
}

/** A driver drives herself, so both "rides with" cells of players whose status says they drive are cleared. */
function clearPinsOfDrivers(sh, fromRow, toRow) {
  if (toRow < fromRow) return 0;
  var values = sh.getRange(fromRow, COL.STATUS, toRow - fromRow + 1, COL.RETURN_WITH - COL.STATUS + 1).getValues();
  var cleared = 0;
  values.forEach(function (v, i) {
    if (DRIVER_STATUSES.indexOf(String(v[0])) === -1) return;
    var any = false;
    PIN_COLUMNS.forEach(function (col) {
      if (String(v[col - COL.STATUS]) !== '') { sh.getRange(fromRow + i, col).clearContent(); any = true; }
    });
    if (any) cleared++;
  });
  return cleared;
}

/* ---------- the trip back (columns I-O) ---------- */

/** Protects a range (warning only) unless exactly that range is protected already, so reruns do not pile up. */
function protectOnce(range) {
  var a1 = range.getA1Notation();
  var exists = range.getSheet().getProtections(SpreadsheetApp.ProtectionType.RANGE)
    .some(function (p) { return p.getRange().getA1Notation() === a1; });
  if (!exists) range.protect().setWarningOnly(true);
}

function returnModeValidation() {
  return SpreadsheetApp.newDataValidation().requireValueInList(RETURN_MODES, true).setAllowInvalid(false)
    .setHelpText('Stejně jako tam = vracíte se na stejnou adresu. Jinam = napište adresu návratu. ' +
      'Odvoz zpět nepotřebuji = domů se dostanete sami.').build();
}

/** Formula of the default for "Míst zpět": as many seats as on the way there (it follows when that number changes). */
function seatsBackFormula(row) {
  return '=IF(ISNUMBER(D' + row + '),D' + row + ',"")';
}

/** Seats on the way back, driver included: 1 .. seats there (9 when unknown). Drivers only, so typed values only. */
function seatsBackValidation() {
  var j = 'J' + FIRST_ROW, d = 'D' + FIRST_ROW;
  return SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=OR(' + j + '="",AND(' + driverCondition() + ',ISNUMBER(' + j + '),' + j + '=INT(' + j + '),' +
      j + '>=1,' + j + '<=IF(ISNUMBER(' + d + '),' + d + ',9)))')
    .setAllowInvalid(false)
    .setHelpText('Jen pro řidičky: kolik míst bude v autě cestou zpět včetně řidičky (1 = nikoho nevezmu). ' +
      'Výchozí je stejný počet jako tam.').build();
}

/** Colour rules for the return columns (all formula based, so reruns can recognise them). */
function returnRules(sh) {
  var rows = LAST_ROW - FIRST_ROW + 1, r = FIRST_ROW;
  var column = function (col) { return [sh.getRange(FIRST_ROW, col, rows, 1)]; };
  var rule = function (formula, col, background, font) {
    var b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setRanges(column(col));
    if (background) b = b.setBackground(background);
    if (font) b = b.setFontColor(font);
    return b.build();
  };
  return [
    rule('=LEFT($L' + r + ',1)="✗"', COL.RET_CHECK, '#f8d7da', '#a4262c'),
    rule('=LEFT($L' + r + ',1)="⚠"', COL.RET_CHECK, '#ffe8b3', '#7a4b00'),
    rule('=LEFT($L' + r + ',1)="✓"', COL.RET_CHECK, null, '#1a7f3c'),
    rule('=AND($I' + r + '="' + RETURN_ELSEWHERE + '",$K' + r + '="")', COL.RET_ADDR, '#ffe8b3', null), // "Jinam" without an address
    rule('=$I' + r + '<>"' + RETURN_ELSEWHERE + '"', COL.RET_ADDR, '#eceef2', null),                      // address not asked
    rule('=NOT(' + driverCondition() + ')', COL.SEATS_BACK, '#eceef2', null),                              // only drivers are asked
    rule('=AND(' + driverCondition() + ',ISNUMBER($J' + r + '),ISNUMBER($D' + r + '),$J' + r + '>$D' + r + ')', COL.SEATS_BACK, '#ffe8b3', null), // more seats back than there
  ];
}

/** Validation, formats, widths and protection of the return columns. Safe to run repeatedly. */
function applyReturnColumns(sh) {
  var rows = LAST_ROW - FIRST_ROW + 1;
  sh.getRange(FIRST_ROW, COL.RETURN, rows, 1).setDataValidation(returnModeValidation());
  sh.getRange(FIRST_ROW, COL.SEATS_BACK, rows, 1).setDataValidation(seatsBackValidation());
  sh.getRange(FIRST_ROW, COL.RET_CHECK, rows, 4).setBackground('#f3f4f7');
  sh.getRange(FIRST_ROW, COL.RET_LAT, rows, 2).setNumberFormat('@').setFontColor('#8a93a5'); // coordinates as text
  sh.setColumnWidth(COL.RETURN, 170);
  sh.setColumnWidth(COL.SEATS_BACK, 100);
  sh.setColumnWidth(COL.RET_ADDR, 260);
  sh.setColumnWidth(COL.RET_CHECK, 220);
  sh.setColumnWidth(COL.RET_FOUND, 260);
  sh.setColumnWidth(COL.RET_LAT, 80);
  sh.setColumnWidth(COL.RET_LON, 80);
  protectOnce(sh.getRange(FIRST_ROW, COL.RET_CHECK, rows, 4));
}

/** Identifies a conditional-format rule by its formula and the ranges it covers (two columns may share a formula). */
function ruleKey(rule) {
  var condition = rule.getBooleanCondition();
  var formula = condition ? condition.getCriteriaValues()[0] : '';
  return formula + '|' + rule.getRanges().map(function (r) { return r.getA1Notation(); }).join(',');
}

/** Adds the rules the sheet does not have yet (same formula and range); never duplicates, never removes. */
function addMissingRules(sh, newRules) {
  var rules = sh.getConditionalFormatRules();
  var known = {};
  rules.forEach(function (r) { known[ruleKey(r)] = true; });
  newRules.forEach(function (rule) {
    if (known[ruleKey(rule)]) return;
    known[ruleKey(rule)] = true;
    rules = rules.concat(rule);
  });
  sh.setConditionalFormatRules(rules);
}

/**
 * Defaults for the trip back, filled in as soon as a player row has content: "Stejně jako tam" for everybody
 * and, for drivers, "Míst zpět" = a formula that equals the seats on the way there (overwrite it with a number to
 * offer fewer). Only empty cells are filled, a choice is never overwritten.
 */
function fillReturnDefaults(sh, fromRow, toRow) {
  if (toRow < fromRow) return;
  var values = sh.getRange(fromRow, COL.NAME, toRow - fromRow + 1, COL.SEATS_BACK - COL.NAME + 1).getValues();
  values.forEach(function (v, i) {
    var row = fromRow + i;
    var hasContent = String(v[COL.NAME - 1]).trim() !== '' || String(v[COL.ADDR - 1]).trim() !== '';
    if (!hasContent) return;
    if (String(v[COL.RETURN - 1]) === '') sh.getRange(row, COL.RETURN).setValue(RETURN_MODES[0]);
    var drives = DRIVER_STATUSES.indexOf(String(v[COL.STATUS - 1])) !== -1;
    if (drives && String(v[COL.SEATS_BACK - 1]) === '') sh.getRange(row, COL.SEATS_BACK).setFormula(seatsBackFormula(row));
  });
}

/**
 * Typing an address into the return column while the mode is "Stejně jako tam" means the person goes
 * somewhere else, so the mode switches to "Jinam" by itself.
 */
function adoptTypedReturnAddress(sh, fromRow, toRow) {
  if (toRow < fromRow) return;
  var values = sh.getRange(fromRow, COL.ADDR, toRow - fromRow + 1, COL.RET_ADDR - COL.ADDR + 1).getValues();
  values.forEach(function (v, i) {
    var mode = String(v[COL.RETURN - COL.ADDR]);
    var typed = String(v[COL.RET_ADDR - COL.ADDR]).trim(), home = String(v[0]).trim();
    if ((mode === '' || mode === RETURN_MODES[0]) && typed !== '' && typed !== home) {
      sh.getRange(fromRow + i, COL.RETURN).setValue(RETURN_ELSEWHERE);
    }
  });
}

/**
 * Keeps columns K-O in line with the chosen mode:
 *  - "Stejně jako tam" (or empty): the return address is the address of the way there, copied together with
 *    its check, found address and coordinates (so nothing needs to be typed);
 *  - "Odvoz zpět nepotřebuji": nothing to fill in, the columns are emptied;
 *  - "Jinam": the person's own address stays; the automatic copy of the outbound address is removed.
 * Only rows between fromRow and toRow are touched and only when something actually changes.
 */
function applyReturnMode(sh, fromRow, toRow) {
  if (toRow < fromRow) return;
  var n = toRow - fromRow + 1;
  var values = sh.getRange(fromRow, COL.ADDR, n, COL.RET_LON - COL.ADDR + 1).getValues();   // B..O
  var at = function (col) { return col - COL.ADDR; };
  var empty = ['', '', '', '', ''];
  var block = [], changed = false;
  values.forEach(function (v) {
    var mode = String(v[at(COL.RETURN)]);
    var current = v.slice(at(COL.RET_ADDR), at(COL.RET_LON) + 1);                              // K..O
    var next = current;
    if (mode === '' || mode === RETURN_MODES[0]) {
      next = [v[0], v[at(COL.CHECK)], v[at(COL.FOUND)], v[at(COL.LAT)], v[at(COL.LON)]];
    } else if (mode === RETURN_MODES[2]) {
      next = empty;
    } else if (mode === RETURN_ELSEWHERE && String(current[0]).trim() !== '' &&
               String(current[0]).trim() === String(v[0]).trim()) {
      next = empty;                                                                           // the automatic copy
    }
    if (next.some(function (x, k) { return String(x) !== String(current[k]); })) changed = true;
    block.push(next);
  });
  if (changed) sh.getRange(fromRow, COL.RET_ADDR, n, 5).setValues(block);
}

/**
 * The earlier version had a yes/no question in column J. Turns the old answers into seats on the way back:
 * "ano" -> the default formula, "ne" -> 1 (the driver only). Also renames the old heading.
 * Returns how many answers were converted.
 */
function convertLegacyTakesBack(sh, fromRow, toRow) {
  var pinHeading = sh.getRange(HEADER_ROW, COL.RIDES_WITH);   // the first version of column P was called "Jedu s (pevně)"
  if (String(pinHeading.getValue()) === LEGACY_RIDES_WITH_LABEL) pinHeading.setValue(HEADER_LABELS[COL.RIDES_WITH - 1]);
  var heading = sh.getRange(HEADER_ROW, COL.SEATS_BACK);
  if (String(heading.getValue()) === LEGACY_TAKES_BACK_LABEL) heading.setValue(HEADER_LABELS[COL.SEATS_BACK - 1]);
  if (toRow < fromRow) return 0;
  var values = sh.getRange(fromRow, COL.SEATS_BACK, toRow - fromRow + 1, 1).getValues();
  var converted = 0;
  values.forEach(function (v, i) {
    var answer = String(v[0]).trim().toLowerCase(), row = fromRow + i;
    if (answer === 'ano') { sh.getRange(row, COL.SEATS_BACK).setFormula(seatsBackFormula(row)); converted++; }
    else if (answer === 'ne') { sh.getRange(row, COL.SEATS_BACK).setValue(1); converted++; }
  });
  return converted;
}

/** A new match starts with the defaults: everybody goes home the way they came, drivers take passengers back,
 *  and the fixed agreements (P, Q) are gone. */
function resetReturnChoices(sh, fromRow, toRow) {
  if (toRow < fromRow) return;
  var n = toRow - fromRow + 1;
  var values = sh.getRange(fromRow, COL.NAME, n, COL.ADDR - COL.NAME + 1).getValues();
  var modes = values.map(function (v) {
    return [(String(v[0]).trim() !== '' || String(v[1]).trim() !== '') ? RETURN_MODES[0] : ''];
  });
  sh.getRange(fromRow, COL.RETURN, n, 1).setValues(modes);
  sh.getRange(fromRow, COL.SEATS_BACK, n, 1).clearContent();   // the statuses are empty again, nobody is a driver yet
  sh.getRange(fromRow, COL.RIDES_WITH, n, 2).clearContent();   // the agreements (P and Q) belong to one match
  applyReturnMode(sh, fromRow, toRow);
}

/** After "Jinam" is chosen for a row that already has an address typed in, check that address now. */
function checkNewReturnRows(sh, fromRow, toRow) {
  if (toRow < fromRow) return;
  var values = sh.getRange(fromRow, COL.RETURN, toRow - fromRow + 1, COL.RET_CHECK - COL.RETURN + 1).getValues();
  var done = 0;
  values.forEach(function (v, i) {
    var typed = String(v[COL.RET_ADDR - COL.RETURN]).trim() !== '', checked = String(v[COL.RET_CHECK - COL.RETURN]) !== '';
    if (String(v[0]) === RETURN_ELSEWHERE && typed && !checked && done++ < MAX_ROWS_PER_EDIT) checkReturnRow(sh, fromRow + i);
  });
}

/**
 * The dialog window, or a stand-in when the function runs where Google offers none (e.g. started from the script
 * editor without the sheet open, or from a trigger). The stand-in shows the text as a toast and in the log, and it
 * answers every question with "no", so nothing destructive can happen without a confirmation.
 */
function getDialogs() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    var quiet = {
      alert: function (message) {
        Logger.log(message);
        try { SpreadsheetApp.getActive().toast(String(message).slice(0, 200), 'Spolujízdy', 30); } catch (ignore) { /* no sheet at hand */ }
        return 'NO_DIALOG';
      },
      ButtonSet: { YES_NO: 'YES_NO' },
      Button: { YES: 'YES' },
    };
    return quiet;
  }
}

function setup() {
  var ss = SpreadsheetApp.getActive();
  var ui = getDialogs();
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
    'Vyplňujte jen bílá pole. Sloupce E–H a L–O se doplní samy. Odkaz v prvním řádku vložte po zveřejnění tabulky (Soubor → Sdílet → Publikovat na webu → CSV).');
  sh.getRange(HEADER_ROW, 1, 1, LAST_COL).setValues([HEADER_LABELS]);

  // appearance
  sh.getRange(LINK_ROW, COL.NAME, TIME_ROW, 1).setFontWeight('bold');
  sh.getRange(NOTE_ROW, COL.NAME).setFontStyle('italic').setFontColor('#6a7385');
  sh.getRange(HEADER_ROW, 1, 1, LAST_COL).setFontWeight('bold').setBackground('#e8eaf0');
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
  applyReturnColumns(sh);
  applyPinColumn(sh);

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
  ].concat(seatsRules(sh), dateRules(sh), returnRules(sh), pinRules(sh)));

  // protect labels, header and automatic columns from accidental edits (warning only)
  protectOnce(sh.getRange(LINK_ROW, COL.NAME, HEADER_ROW, 1));
  protectOnce(sh.getRange(HEADER_ROW, 1, 1, LAST_COL));
  protectOnce(sh.getRange(HALL_ROW, COL.CHECK, TIME_ROW - HALL_ROW + 1, 4));
  protectOnce(sh.getRange(DATE_ROW, COL.STATUS));
  protectOnce(sh.getRange(FIRST_ROW, COL.CHECK, LAST_ROW - FIRST_ROW + 1, 4));

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
  if (!sh) { getDialogs().alert('Nejdřív spusťte funkci „setup“.'); return; }
  if (!layoutMatches(sh)) { getDialogs().alert(LAYOUT_MISMATCH); return; }
  checkRow(sh, HALL_ROW);
  var last = Math.min(sh.getLastRow(), LAST_ROW);
  if (last >= FIRST_ROW) {
    // read columns B..L once; skip rows that have neither an address nor a check
    var values = sh.getRange(FIRST_ROW, COL.ADDR, last - FIRST_ROW + 1, COL.RET_CHECK - COL.ADDR + 1).getValues();
    var at = function (col) { return col - COL.ADDR; };
    values.forEach(function (v, i) {
      var row = FIRST_ROW + i;
      if (String(v[at(COL.ADDR)]).trim() !== '' || String(v[at(COL.CHECK)]) !== '') checkRow(sh, row);
      if (String(v[at(COL.RETURN)]) === RETURN_ELSEWHERE && String(v[at(COL.RET_ADDR)]).trim() !== '') checkReturnRow(sh, row);
    });
    fillReturnDefaults(sh, FIRST_ROW, last);
    applyReturnMode(sh, FIRST_ROW, last);
  }
  ss.toast('Kontrola dokončena.');
}

function newMatch() {
  var ui = getDialogs();
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) { ui.alert('Nejdřív spusťte funkci „setup“.'); return; }
  if (!layoutMatches(sh)) { ui.alert(LAYOUT_MISMATCH); return; }
  if (ui.alert('Vymazat stav všech hráček pro nový zápas?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).clearContent();
  resetReturnChoices(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW)); // the way home is chosen per match too
  ui.alert('Stavy jsou vymazané a cesta zpět je vrácená na výchozí hodnoty (stejně jako tam). Dohody „Tam s“ a „Zpět s“ jsou smazané. ' +
    'Nezapomeňte nastavit nové datum zápasu (řádek „Datum zápasu“).');
}

/**
 * Adds the rows a sheet from an older version lacks (link to the published sheet, match date)
 * and deletes nothing: players, addresses and statuses stay. Also reinstalls the edit trigger.
 * Run it right after pasting a new version of the script. Works for any older version
 * and only adds what is missing.
 */
function migrate() {
  var ui = getDialogs();
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

  // rules for the seat count and the trip back (validation + colours), added once and never duplicated
  addMissingRules(sh, seatsRules(sh).concat(returnRules(sh), pinRules(sh)));
  sh.getRange(HEADER_ROW, 1, 1, LAST_COL).clearDataValidations(); // headings must never carry a dropdown
  sh.getRange(FIRST_ROW, COL.STATUS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(statusValidation());
  sh.getRange(FIRST_ROW, COL.SEATS, LAST_ROW - FIRST_ROW + 1, 1).setDataValidation(seatsValidation());
  applyReturnColumns(sh);
  applyPinColumn(sh);
  clearPinsOfDrivers(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW));
  var cleared = clearDriverOnlyFields(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW));
  convertLegacyTakesBack(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW));
  fillReturnDefaults(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW));
  applyReturnMode(sh, FIRST_ROW, Math.min(sh.getLastRow(), LAST_ROW));
  var headerRestored = ensureHeader(sh);

  var msg = added.length
    ? 'Hotovo, přidáno: ' + added.join(', ') + '. Vyplňte datum zápasu' +
      (added[0] === 'řádek s odkazem' ? ' a vložte odkaz ze „Soubor → Sdílet → Publikovat na webu“ do žlutého pole v 1. řádku' : '') + '.'
    : 'Tabulka už má nové rozložení, nic se nepřidávalo.';
  msg += ' Pravidla pro počet míst (jen u řidiček), sloupce pro cestu zpět a pevné dohody (P, Q) a spouštěč kontroly adres jsou aktualizované.';
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
  var touches = function (col) { return range.getColumn() <= col && range.getLastColumn() >= col; };
  var fromRow = Math.max(range.getRow(), FIRST_ROW), toRow = Math.min(range.getLastRow(), LAST_ROW);

  // a passenger / non-attending player has no seat count and does not take anybody back
  if (touches(COL.STATUS)) { clearDriverOnlyFields(sh, fromRow, toRow); clearPinsOfDrivers(sh, fromRow, toRow); }
  // defaults for the trip back as soon as a row has content ("Stejně jako tam", drivers: "ano")
  if (touches(COL.NAME) || touches(COL.ADDR) || touches(COL.STATUS) || touches(COL.RETURN)) fillReturnDefaults(sh, fromRow, toRow);

  if (touches(COL.ADDR)) checkEditedRows(sh, range, true, checkRow, COL.CHECK);          // the hall row is included

  // the trip back: an address typed into column K means "Jinam"; then keep K-O in line with the mode
  if (touches(COL.RET_ADDR)) adoptTypedReturnAddress(sh, fromRow, toRow);
  if (touches(COL.ADDR) || touches(COL.RETURN) || touches(COL.RET_ADDR)) applyReturnMode(sh, fromRow, toRow);
  if (touches(COL.RET_ADDR)) checkEditedRows(sh, range, false, checkReturnRow, COL.RET_CHECK);
  if (touches(COL.RETURN)) checkNewReturnRows(sh, fromRow, toRow);
}

/** Runs checkFn for the edited hall / player rows, at most MAX_ROWS_PER_EDIT of them. */
function checkEditedRows(sh, range, includeHall, checkFn, checkCol) {
  var done = 0;
  for (var row = range.getRow(); row <= range.getLastRow(); row++) {
    var isPlayer = row >= FIRST_ROW && row <= LAST_ROW;
    if (!isPlayer && !(includeHall && row === HALL_ROW)) continue;
    if (done++ >= MAX_ROWS_PER_EDIT) {
      sh.getRange(row, checkCol).setValue('⚠ Příliš mnoho řádků najednou, použijte Spolujízdy → Zkontrolovat všechny adresy.');
      break;
    }
    checkFn(sh, row);
  }
}

function checkRow(sh, row) { checkAddress(sh, row, COL.ADDR, COL.CHECK); }

function checkReturnRow(sh, row) {
  // outside "Jinam" the columns are kept by applyReturnMode (a copy of the outbound address)
  if (String(sh.getRange(row, COL.RETURN).getValue()) !== RETURN_ELSEWHERE) return;
  checkAddress(sh, row, COL.RET_ADDR, COL.RET_CHECK);
}

/** Geocodes the address in addrCol and writes check / found address / lat / lon into the 4 cells from outCol. */
function checkAddress(sh, row, addrCol, outCol) {
  var addr = String(sh.getRange(row, addrCol).getValue()).trim();
  var out = addr ? geocode(addr) : { check: '', found: '', lat: '', lon: '' };
  sh.getRange(row, outCol, 1, 4).setValues([[out.check, out.found, out.lat, out.lon]]);
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
