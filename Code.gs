/**
 * Audit of Quinyx shifts. Produces one Google Sheet with a single colour-coded overview:
 *  - RED:  shifts of 6 hours or longer without a break (missing break).
 *  - BLUE: shifts with a break whose total is not 15 minutes (longer or shorter).
 *
 * Setup:
 *  1. Project Settings > Script Properties: set QUINYX_API_KEYS, one "label=apiKey" per line, e.g.
 *       NL=abc123
 *       BE=def456
 *     (a single QUINYX_API_KEY is still supported and gets the label "default").
 *  2. (optional) Script Properties: RECIPIENTS (comma-separated emails), FOLDER_ID (Drive folder for the Sheet).
 *  3. Run runAudit() once manually (authorization), then run createWeeklyTrigger() once.
 */
const CONFIG = {
  ENDPOINT: 'https://api.quinyx.com/FlexForceWebServices.php',
  EXPECTED_BREAK_MINUTES: 15, // a break (> 0) that differs from this is flagged blue
  MIN_HOURS: 6,          // shift >= MIN_HOURS with 0 minutes of break is flagged red
  DAYS_BACK: 7,          // today and 7 days earlier
  TIMEZONE: 'Europe/Amsterdam',
  TRIGGER_WEEKDAY: ScriptApp.WeekDay.MONDAY,
  TRIGGER_HOUR: 7,
};

const COLORS = { missing_break: '#f4c7c3', break_not_expected: '#c9daf8' }; // red, blue
const COLUMNS = ['account', 'issue', 'badgeNo', 'unitName', 'sectionName', 'categoryName',
                 'start', 'end', 'gross_hours', 'break_minutes', 'field_hours', 'comment'];

/** Entry point for the weekly trigger. */
function runAudit() {
  const props = PropertiesService.getScriptProperties();
  const accounts = getAccounts_(props);

  const today = new Date();
  const from = new Date(today.getTime() - CONFIG.DAYS_BACK * 86400000);
  const toStr = fmtDate_(today), fromStr = fmtDate_(from);

  // One failing account must not stop the others: collect errors and report them.
  const result = { rows: [], missing: 0, other: 0, total: 0, skipped: 0 };
  const errors = [];
  accounts.forEach(acc => {
    try {
      const r = auditItems_(fetchSchedules_(acc.key, fromStr, toStr), CONFIG.MIN_HOURS, CONFIG.EXPECTED_BREAK_MINUTES);
      r.rows.forEach(row => { row.account = acc.label; result.rows.push(row); });
      ['missing', 'other', 'total', 'skipped'].forEach(k => { result[k] += r[k]; });
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

  const recipients = props.getProperty('RECIPIENTS');
  if (recipients) {
    const xlsx = UrlFetchApp.fetch(
      'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }
    ).getBlob().setName(`quinyx_break_audit_${fromStr}_${toStr}.xlsx`);
    MailApp.sendEmail({
      to: recipients,
      subject: `${errors.length ? '[ERRORS] ' : ''}Quinyx break audit ${fromStr} to ${toStr}: ${result.missing} missing break, ${result.other} break != ${CONFIG.EXPECTED_BREAK_MINUTES} min`,
      body: `${summary}\n\nSheet: ${ss.getUrl()}`,
      attachments: [xlsx],
    });
  }
  if (errors.length === accounts.length) throw new Error('All accounts failed: ' + errors.join(' | '));
  return summary;
}

/** Reads accounts from QUINYX_API_KEYS ("label=key" per line) or the legacy QUINYX_API_KEY. */
function getAccounts_(props) {
  const multi = props.getProperty('QUINYX_API_KEYS');
  const accounts = (multi || '').split(/[\r\n;]+/).map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf('=');
    if (i < 1) throw new Error('QUINYX_API_KEYS: expected "label=apiKey" per line, got: ' + l.slice(0, 20));
    return { label: l.slice(0, i).trim(), key: l.slice(i + 1).trim() };
  });
  const single = props.getProperty('QUINYX_API_KEY');
  if (!accounts.length && single) accounts.push({ label: 'default', key: single });
  if (!accounts.length) throw new Error('Script Property QUINYX_API_KEYS is missing');
  return accounts;
}

/** Run once: creates the weekly trigger (first removes existing ones for runAudit). */
function createWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runAudit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runAudit').timeBased()
    .onWeekDay(CONFIG.TRIGGER_WEEKDAY).atHour(CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.TIMEZONE).create();
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
