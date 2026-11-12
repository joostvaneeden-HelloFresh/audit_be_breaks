/**
 * Audit of Quinyx shifts. Every run covers the last 7 full days (8 days ago up to yesterday, no overlap).
 * It produces:
 *  1. A new Google Sheet with a single colour-coded overview of that week:
 *       RED  = shift of 6 hours or longer without a break (missing break)
 *       BLUE = shift with a break whose total is not 15 minutes (longer or shorter)
 *  2. A fixed trend Sheet (id in Script Property TREND_SHEET_ID; if the property is empty a new Sheet
 *     "Quinyx break audit - missing breaks trend" is created on the first run and its id stored there). Tab "Total" plus one tab per hub; each run adds one row per week
 *     (shifts checked, missing breaks) and each tab has a chart of the missing breaks over time.
 *
 * Setup:
 *  1. Project Settings > Script Properties: add one property per hub, with the hub's API key as value:
 *        QUINYX_API_KEY_Antwerpen
 *        QUINYX_API_KEY_Gent
 *        QUINYX_API_KEY_Brussel
 *        QUINYX_API_KEY_Namur
 *        QUINYX_API_KEY_Kluisbergen
 *        QUINYX_API_KEY_Houthalen
 *     (optional) FOLDER_ID = Drive folder where the trend Sheet is created
 *     (optional) RECIPIENTS = comma-separated emails that get the report, e.g. anna@x.nl, jan@x.be
 *  2. Run runAudit() once manually and click through the authorization.
 *  3. Set the schedule yourself: Triggers (clock icon) > Add Trigger > function runAudit > Time-driven.
 */
const HUBS = ['Antwerpen', 'Gent', 'Brussel', 'Namur', 'Kluisbergen', 'Houthalen'];

const CONFIG = {
  ENDPOINT: 'https://api.quinyx.com/FlexForceWebServices.php',
  EXPECTED_BREAK_MINUTES: 15, // a break (> 0) that differs from this is flagged blue
  MIN_HOURS: 6,          // shift >= MIN_HOURS with 0 minutes of break is flagged red
  TIMEZONE: 'Europe/Amsterdam',
};

const TREND_COLUMNS = ['week_from', 'week_to', 'shifts_checked', 'missing_break'];
const COLORS = { missing_break: '#f4c7c3', break_not_expected: '#c9daf8' }; // red, blue
const COLUMNS = ['account', 'issue', 'badgeNo', 'unitName', 'sectionName', 'categoryName',
                 'start', 'end', 'gross_hours', 'break_minutes', 'field_hours', 'comment'];

/** Entry point for the weekly trigger. */
function runAudit() {
  const props = PropertiesService.getScriptProperties();
  const accounts = getAccounts_(props);

  const period = periodRange_(new Date());
  const fromStr = fmtDate_(period.from), toStr = fmtDate_(period.to);

  // One failing account must not stop the others: collect errors and report them.
  const result = { rows: [], missing: 0, other: 0, total: 0, skipped: 0 };
  const errors = [], perHub = [];
  accounts.forEach(acc => {
    try {
      const r = auditItems_(fetchSchedules_(acc.key, fromStr, toStr), CONFIG.MIN_HOURS, CONFIG.EXPECTED_BREAK_MINUTES);
      r.rows.forEach(row => { row.account = acc.label; result.rows.push(row); });
      ['missing', 'other', 'total', 'skipped'].forEach(k => { result[k] += r[k]; });
      perHub.push({ hub: acc.label, row: weekRow_(fromStr, toStr, r.total - r.skipped, r.missing) });
    } catch (e) {
      errors.push(`${acc.label}: ${e.message}`);
      Logger.log(`Account ${acc.label} failed: ${e.message}`);
    }
  });
  result.rows.sort((a, b) => (a.account + a.start + a.badgeNo).localeCompare(b.account + b.start + b.badgeNo));

  const ss = SpreadsheetApp.create(`Quinyx break audit ${fromStr} to ${toStr}`);
  writeSheet_(ss.getSheets()[0].setName('Break audit'), result.rows);
  const folderId = props.getProperty('FOLDER_ID');
  if (folderId) DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(folderId));

  const summary = `${result.total} shifts checked (${result.skipped} leave/day-off skipped), ` +
                  `${result.missing} shifts of >= ${CONFIG.MIN_HOURS}h without a break (red), ` +
                  `${result.other} shifts with a break other than ${CONFIG.EXPECTED_BREAK_MINUTES} min (blue) (${fromStr} to ${toStr}), ${accounts.length} account(s).` +
                  (errors.length ? `\n\nFAILED accounts:\n${errors.join('\n')}` : '');
  Logger.log(summary + ' ' + ss.getUrl());

  // Trend sheet: a failure here must not stop the mail below.
  let trendUrl = '', trendError = '';
  try {
    trendUrl = updateTrend_(props, perHub);
  } catch (e) {
    trendError = e.message;
    errors.push('Trend sheet: ' + e.message);
    Logger.log('Trend sheet failed: ' + e.message);
  }

  const recipients = props.getProperty('RECIPIENTS');
  if (recipients) {
    const xlsx = UrlFetchApp.fetch(
      'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }
    ).getBlob().setName(`quinyx_break_audit_${fromStr}_${toStr}.xlsx`);
    MailApp.sendEmail({
      to: recipients,
      subject: `${errors.length ? '[ERRORS] ' : ''}Quinyx break audit ${fromStr} to ${toStr}: ${result.missing} missing break, ${result.other} break != ${CONFIG.EXPECTED_BREAK_MINUTES} min`,
      body: `${summary}\n\nSheet: ${ss.getUrl()}` + (trendUrl ? `\nTrend (missing breaks over time): ${trendUrl}` : '') +
              (trendError ? `\n\nTrend sheet NOT updated: ${trendError}` : ''),
      attachments: [xlsx],
    });
  }
  if (errors.filter(e => e.indexOf('Trend sheet') !== 0).length === accounts.length) throw new Error('All accounts failed: ' + errors.join(' | '));
  return summary;
}

/** One account per hub in HUBS, key from Script Property QUINYX_API_KEY_<hub>. */
function getAccounts_(props) {
  const all = props.getProperties();
  const accounts = HUBS.filter(h => (all['QUINYX_API_KEY_' + h] || '').trim())
    .map(h => ({ label: h, key: all['QUINYX_API_KEY_' + h].trim() }));
  const missing = HUBS.filter(h => !accounts.some(a => a.label === h));
  if (missing.length) Logger.log('No API key for: ' + missing.join(', '));
  if (!accounts.length) throw new Error('No API keys found: add Script Properties QUINYX_API_KEY_<hub> (see top of Code.gs)');
  return accounts;
}

/** The last 7 full days: from = 7 days ago, to = yesterday (both inclusive). Weekly runs never overlap. */
function periodRange_(today) {
  const from = new Date(today), to = new Date(today);
  from.setDate(from.getDate() - 7);
  to.setDate(to.getDate() - 1);
  return { from, to };
}

// ---------- Trend sheet (missing breaks per week) ----------

function weekRow_(weekFrom, weekTo, checked, missing) {
  return { week_from: weekFrom, week_to: weekTo, shifts_checked: checked, missing_break: missing };
}

/** Sum of the hub rows of one week (hubs whose API call failed are simply not included). */
function totalRow_(hubRows) {
  const first = hubRows[0];
  const row = weekRow_(first.week_from, first.week_to,
    hubRows.reduce((a, r) => a + r.shifts_checked, 0), hubRows.reduce((a, r) => a + r.missing_break, 0));
  row.hubs_included = hubRows.length;
  return row;
}

/** Existing rows + new rows; a rerun for the same week replaces that week's row. Sorted by week. */
function mergeWeeks_(existing, added) {
  const weeks = {};
  added.forEach(r => { weeks[r.week_from] = true; });
  return existing.filter(r => !weeks[r.week_from]).concat(added)
    .sort((a, b) => String(a.week_from).localeCompare(String(b.week_from)));
}

/** Opens the fixed trend Sheet (id in Script Property TREND_SHEET_ID) or creates it on the first run. */
function getTrendSpreadsheet_(props) {
  const id = props.getProperty('TREND_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id); // if it was deleted this fails loudly instead of silently starting over
  const ss = SpreadsheetApp.create('Quinyx break audit - missing breaks trend');
  props.setProperty('TREND_SHEET_ID', ss.getId());
  const folderId = props.getProperty('FOLDER_ID');
  if (folderId) DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(folderId));
  ss.getSheets()[0].setName('Total');
  return ss;
}

/** Adds this week's rows to tab "Total" and one tab per hub. Returns the Sheet URL. */
function updateTrend_(props, perHub) {
  if (!perHub.length) return '';
  const ss = getTrendSpreadsheet_(props);
  const total = totalRow_(perHub.map(p => p.row));
  let totalSheet = ss.getSheetByName('Total');
  if (!totalSheet) {
    // Use the empty default tab of a fresh Sheet as "Total" instead of leaving it behind empty.
    const first = ss.getSheets()[0];
    const isEmptyDefault = first.getLastRow() === 0 && first.getLastColumn() === 0;
    totalSheet = isEmptyDefault ? first.setName('Total') : ss.insertSheet('Total', 0);
  }
  updateTrendTab_(totalSheet, TREND_COLUMNS.concat(['hubs_included']), total);
  HUBS.forEach(hub => {
    const sheet = ss.getSheetByName(hub) || ss.insertSheet(hub);
    const p = perHub.filter(x => x.hub === hub)[0];
    updateTrendTab_(sheet, TREND_COLUMNS, p ? p.row : null); // no row this week if the hub's API call failed
  });
  return ss.getUrl();
}

/** Merges newRow into the tab's existing rows, rewrites the tab and redraws its chart (missing_pct over time). */
function updateTrendTab_(sheet, columns, newRow) {
  let existing = [];
  if (sheet.getLastRow() > 1) {
    // read by header name, so older layouts (e.g. with a missing_pct column) still load correctly
    const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    const header = values[0];
    existing = values.slice(1).map(v => {
      const o = {}; columns.forEach(c => { const i = header.indexOf(c); o[c] = i < 0 ? '' : v[i]; }); return o;
    });
  }
  const rows = newRow ? mergeWeeks_(existing, [newRow]) : existing;
  sheet.getCharts().forEach(c => sheet.removeChart(c));
  sheet.clear();
  sheet.getRange(1, 1, rows.length + 1, 2).setNumberFormat('@'); // dates stay text
  sheet.getRange(1, 1, rows.length + 1, columns.length)
    .setValues([columns].concat(rows.map(r => columns.map(c => r[c]))));
  sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold').setBackground('#d9d9d9');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, columns.length);
  if (!rows.length) return;
  sheet.insertChart(sheet.newChart().asColumnChart()
    .addRange(sheet.getRange(1, 1, rows.length + 1, 1))   // week_from (x axis)
    .addRange(sheet.getRange(1, 4, rows.length + 1, 1))   // missing_break
    .setNumHeaders(1)
    .setOption('title', sheet.getName() + ': shifts of 6h+ without a break (number per week)')
    .setOption('legend', { position: 'none' })
    .setOption('vAxis', { title: 'Shifts without a break', minValue: 0, format: '0' })
    .setOption('hAxis', { title: 'Week starting' })
    .setOption('width', 640).setOption('height', 320)
    .setPosition(2, columns.length + 2, 0, 0).build());
}

/** Debug: saves the raw response of each account to Drive to check field names. */
function dumpRaw() {
  const d = fmtDate_(new Date());
  getAccounts_(PropertiesService.getScriptProperties()).forEach(acc =>
    DriveApp.createFile(`quinyx_raw_${acc.label}.xml`, callApi_(acc.key, d, d), 'text/xml'));
}

// ---------- API ----------

function callApi_(apiKey, fromDate, toDate) {
  const body =
    '<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:uri="uri:FlexForce"><soapenv:Header/><soapenv:Body>' +
    '<uri:wsdlGetSchedulesV3 soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<apiKey xsi:type="xsd:string">' + escapeXml_(apiKey) + '</apiKey>' +
    '<GetSchedulesV3 xsi:type="flex:GetSchedulesV3" xmlns:flex="https://api.quinyx.com/soap/FlexForce">' +
    '<fromDate xsi:type="xsd:string">' + fromDate + '</fromDate>' +
    '<toDate xsi:type="xsd:string">' + toDate + '</toDate>' +
    '</GetSchedulesV3></uri:wsdlGetSchedulesV3></soapenv:Body></soapenv:Envelope>';
  const resp = UrlFetchApp.fetch(CONFIG.ENDPOINT, {
    method: 'post', contentType: 'text/xml; charset=utf-8', payload: body,
    headers: { SOAPAction: '' }, muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Quinyx HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 500));
  }
  return resp.getContentText();
}

function fetchSchedules_(apiKey, fromDate, toDate) {
  return parseItems_(callApi_(apiKey, fromDate, toDate));
}

/** Returns one {fieldName: text} object per <item> that has begDate. */
function parseItems_(xml) {
  const items = [];
  const walk = el => {
    if (el.getName() === 'item') {
      const f = {};
      el.getChildren().forEach(c => { f[c.getName()] = c.getText().trim(); });
      if (f.begDate && f.begTime) { items.push(f); return; }
    }
    el.getChildren().forEach(walk);
  };
  walk(XmlService.parse(xml).getRootElement());
  return items;
}

// ---------- Logic (pure, no Apps Script dependencies) ----------

function timeToMinutes_(t) {
  const p = (t || '00:00:00').split(':').map(Number);
  return p[0] * 60 + (p[1] || 0) + (p[2] || 0) / 60;
}

/** Sum of breaks 1-4; 00:00:00 - 00:00:00 = no break. */
function breakMinutes_(f) {
  let total = 0;
  ['', '2', '3', '4'].forEach(s => {
    const b = timeToMinutes_(f['begBreak' + s]), e = timeToMinutes_(f['endBreak' + s]);
    total += e >= b ? e - b : e + 1440 - b;
  });
  return total;
}

function toMs_(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss || 0);
}

function auditItems_(items, minHours, expectedBreak) {
  expectedBreak = expectedBreak == null ? 15 : expectedBreak;
  const rows = [];
  let skipped = 0;
  items.forEach(f => {
    // leave / days off are not work shifts
    if (f.isFreeDay === 'true' || f.approvedLeave === 'true' ||
        (f.leaveReasonId || '0') !== '0' || f.productiveTime === 'false') { skipped++; return; }
    const start = toMs_(f.begDate, f.begTime), end = toMs_(f.endDate, f.endTime);
    const hours = (end - start) / 3600000;
    const brk = breakMinutes_(f);
    const issue = hours >= minHours && brk <= 0 ? 'missing_break'
                : brk > 0 && Math.round(brk * 100) / 100 !== expectedBreak ? 'break_not_expected' : null;
    if (!issue) return;
    rows.push({
      issue, badgeNo: f.badgeNo, unitName: f.unitName,
      sectionName: f.sectionName, categoryName: f.categoryName,
      start: f.begDate + ' ' + f.begTime.slice(0, 5), end: f.endDate + ' ' + f.endTime.slice(0, 5),
      gross_hours: Math.round(hours * 100) / 100, break_minutes: Math.round(brk * 100) / 100,
      field_hours: f.hours, comment: f.comment,
    });
  });
  const bySort = (a, b) => (a.start + a.badgeNo).localeCompare(b.start + b.badgeNo);
  rows.sort(bySort);
  return { rows, missing: rows.filter(r => r.issue === 'missing_break').length,
           other: rows.filter(r => r.issue === 'break_not_expected').length, total: items.length, skipped };
}

// ---------- Helpers ----------

/** Writes rows to a sheet: bold frozen header, filter, rows coloured by issue. */
function writeSheet_(sheet, rows) {
  const values = [COLUMNS].concat(rows.map(r => COLUMNS.map(c => r[c] == null ? '' : r[c])));
  const range = sheet.getRange(1, 1, values.length, COLUMNS.length);
  range.setNumberFormat('@'); // keep ids and timestamps as text
  range.setValues(values);
  sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold').setBackground('#d9d9d9');
  sheet.setFrozenRows(1);
  rows.forEach((r, i) => sheet.getRange(i + 2, 1, 1, COLUMNS.length).setBackground(COLORS[r.issue]));
  if (rows.length) sheet.getRange(1, 1, values.length, COLUMNS.length).createFilter();
  sheet.autoResizeColumns(1, COLUMNS.length);
}

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd'); }

function escapeXml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
