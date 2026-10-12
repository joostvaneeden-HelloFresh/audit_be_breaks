/**
 * Audit of Quinyx shifts. Produces two CSVs:
 *  1. Shifts of 6 hours or longer without a break.
 *  2. All shifts (any length) whose total break is not 15 minutes.
 *
 * Setup:
 *  1. Project Settings > Script Properties: set QUINYX_API_KEY.
 *  2. (optional) Script Properties: RECIPIENTS (comma-separated emails), FOLDER_ID (Drive folder for the CSV).
 *  3. Run runAudit() once manually (authorization), then run createWeeklyTrigger() once.
 */
const CONFIG = {
  ENDPOINT: 'https://api.quinyx.com/FlexForceWebServices.php',
  EXPECTED_BREAK_MINUTES: 15, // report 2 lists every shift whose total break differs from this
  MIN_HOURS: 6,          // shift >= MIN_HOURS with 0 minutes of break is flagged
  DAYS_BACK: 7,          // today and 7 days earlier
  TIMEZONE: 'Europe/Amsterdam',
  TRIGGER_WEEKDAY: ScriptApp.WeekDay.MONDAY,
  TRIGGER_HOUR: 7,
};

const COLUMNS = ['scheduleId', 'persId', 'badgeNo', 'unitName', 'sectionName', 'categoryName',
                 'start', 'end', 'gross_hours', 'break_minutes', 'field_hours', 'breakType', 'comment'];

/** Entry point for the weekly trigger. */
function runAudit() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('QUINYX_API_KEY');
  if (!apiKey) throw new Error('Script Property QUINYX_API_KEY is missing');

  const today = new Date();
  const from = new Date(today.getTime() - CONFIG.DAYS_BACK * 86400000);
  const toStr = fmtDate_(today), fromStr = fmtDate_(from);

  const items = fetchSchedules_(apiKey, fromStr, toStr);
  const result = auditItems_(items, CONFIG.MIN_HOURS, CONFIG.EXPECTED_BREAK_MINUTES);

  const folderId = props.getProperty('FOLDER_ID');
  const folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
  const makeBlob = (prefix, rows) =>
    Utilities.newBlob('\uFEFF' + toCsv_(rows), 'text/csv', `${prefix}_${fromStr}_${toStr}.csv`); // BOM for Excel
  const noBreakBlob = makeBlob('audit_no_break_6h_plus', result.rows);
  const breakNot15Blob = makeBlob('audit_break_not_' + CONFIG.EXPECTED_BREAK_MINUTES + 'min', result.breakMismatch);
  const file = folder.createFile(noBreakBlob);
  const file2 = folder.createFile(breakNot15Blob);

  const summary = `${result.total} shifts checked (${result.skipped} leave/day-off skipped), ` +
                  `${result.rows.length} shifts of >= ${CONFIG.MIN_HOURS}h without a break, ` +
                  `${result.breakMismatch.length} shifts with a total break other than ${CONFIG.EXPECTED_BREAK_MINUTES} min (${fromStr} to ${toStr}).`;
  Logger.log(summary + ' ' + file.getUrl() + ' ' + file2.getUrl());

  const recipients = props.getProperty('RECIPIENTS');
  if (recipients) {
    MailApp.sendEmail({
      to: recipients,
      subject: `Quinyx break audit ${fromStr} to ${toStr}: ${result.rows.length} without break, ${result.breakMismatch.length} break != ${CONFIG.EXPECTED_BREAK_MINUTES} min`,
      body: `${summary}\n\nFiles:\n${file.getUrl()}\n${file2.getUrl()}`,
      attachments: [noBreakBlob, breakNot15Blob],
    });
  }
  return summary;
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

/** Debug: saves the raw response to Drive to check field names. */
function dumpRaw() {
  const key = PropertiesService.getScriptProperties().getProperty('QUINYX_API_KEY');
  const d = fmtDate_(new Date());
  DriveApp.createFile('quinyx_raw.xml', callApi_(key, d, d), 'text/xml');
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
  const rows = [], breakMismatch = [];
  let skipped = 0;
  items.forEach(f => {
    // leave / days off are not work shifts
    if (f.isFreeDay === 'true' || f.approvedLeave === 'true' ||
        (f.leaveReasonId || '0') !== '0' || f.productiveTime === 'false') { skipped++; return; }
    const start = toMs_(f.begDate, f.begTime), end = toMs_(f.endDate, f.endTime);
    const hours = (end - start) / 3600000;
    const brk = breakMinutes_(f);
    const row = {
      scheduleId: f.scheduleId, persId: f.persId, badgeNo: f.badgeNo, unitName: f.unitName,
      sectionName: f.sectionName, categoryName: f.categoryName,
      start: f.begDate + ' ' + f.begTime.slice(0, 5), end: f.endDate + ' ' + f.endTime.slice(0, 5),
      gross_hours: Math.round(hours * 100) / 100, break_minutes: Math.round(brk * 100) / 100,
      field_hours: f.hours, breakType: f.breakType, comment: f.comment,
    };
    if (hours >= minHours && brk <= 0) rows.push(row);
    if (row.break_minutes !== expectedBreak) breakMismatch.push(row);
  });
  const bySort = (a, b) => (a.start + a.badgeNo).localeCompare(b.start + b.badgeNo);
  rows.sort(bySort); breakMismatch.sort(bySort);
  return { rows, breakMismatch, total: items.length, skipped };
}

// ---------- Helpers ----------

function toCsv_(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [COLUMNS.join(';')].concat(rows.map(r => COLUMNS.map(c => esc(r[c])).join(';'))).join('\n');
}

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd'); }

function escapeXml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
