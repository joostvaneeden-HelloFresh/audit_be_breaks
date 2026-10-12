/**
 * Audit: Quinyx-diensten van 6 uur of langer zonder pauze.
 *
 * Setup:
 *  1. Project Settings > Script Properties: zet QUINYX_API_KEY.
 *  2. (optioneel) Script Properties: RECIPIENTS (komma-gescheiden e-mails), FOLDER_ID (Drive-map voor de CSV).
 *  3. Draai runAudit() één keer handmatig (autorisatie), daarna createWeeklyTrigger() één keer.
 */
const CONFIG = {
  ENDPOINT: 'https://api.quinyx.com/FlexForceWebServices.php',
  MIN_HOURS: 6,          // dienst >= MIN_HOURS en 0 minuten pauze wordt gemarkeerd
  DAYS_BACK: 7,          // vandaag en 7 dagen eerder
  TIMEZONE: 'Europe/Amsterdam',
  TRIGGER_WEEKDAY: ScriptApp.WeekDay.MONDAY,
  TRIGGER_HOUR: 7,
};

const COLUMNS = ['scheduleId', 'persId', 'badgeNo', 'unitName', 'sectionName', 'categoryName',
                 'start', 'eind', 'uren_bruto', 'uren_veld', 'breakType', 'comment'];

/** Entry point voor de wekelijkse trigger. */
function runAudit() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('QUINYX_API_KEY');
  if (!apiKey) throw new Error('Script Property QUINYX_API_KEY ontbreekt');

  const today = new Date();
  const from = new Date(today.getTime() - CONFIG.DAYS_BACK * 86400000);
  const toStr = fmtDate_(today), fromStr = fmtDate_(from);

  const items = fetchSchedules_(apiKey, fromStr, toStr);
  const result = auditItems_(items, CONFIG.MIN_HOURS);

  const csv = toCsv_(result.rows);
  const name = `audit_breaks_${fromStr}_${toStr}.csv`;
  const blob = Utilities.newBlob('﻿' + csv, 'text/csv', name); // BOM voor Excel

  const folderId = props.getProperty('FOLDER_ID');
  const file = folderId ? DriveApp.getFolderById(folderId).createFile(blob) : DriveApp.createFile(blob);

  const summary = `${result.total} diensten gecontroleerd (${result.skipped} verlof/vrij overgeslagen), ` +
                  `${result.rows.length} van >= ${CONFIG.MIN_HOURS}u zonder pauze (${fromStr} t/m ${toStr}).`;
  Logger.log(summary + ' ' + file.getUrl());

  const recipients = props.getProperty('RECIPIENTS');
  if (recipients) {
    MailApp.sendEmail({
      to: recipients,
      subject: `Quinyx pauze-audit ${fromStr} t/m ${toStr}: ${result.rows.length} diensten`,
      body: `${summary}\n\nBestand: ${file.getUrl()}`,
      attachments: [blob],
    });
  }
  return summary;
}

/** Eenmalig draaien: maakt de wekelijkse trigger (verwijdert eerst bestaande voor runAudit). */
function createWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runAudit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runAudit').timeBased()
    .onWeekDay(CONFIG.TRIGGER_WEEKDAY).atHour(CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.TIMEZONE).create();
}

/** Debug: sla de ruwe response op in Drive om veldnamen te checken. */
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

/** Geeft per <item> met begDate een object {veldnaam: tekst}. */
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

// ---------- Logica (puur, geen Apps Script-afhankelijkheden) ----------

function timeToMinutes_(t) {
  const p = (t || '00:00:00').split(':').map(Number);
  return p[0] * 60 + (p[1] || 0) + (p[2] || 0) / 60;
}

/** Som van pauze 1-4; 00:00:00 - 00:00:00 = geen pauze. */
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

function auditItems_(items, minHours) {
  const rows = [];
  let skipped = 0;
  items.forEach(f => {
    // verlof / vrije dagen zijn geen werkdiensten
    if (f.isFreeDay === 'true' || f.approvedLeave === 'true' ||
        (f.leaveReasonId || '0') !== '0' || f.productiveTime === 'false') { skipped++; return; }
    const start = toMs_(f.begDate, f.begTime), end = toMs_(f.endDate, f.endTime);
    const hours = (end - start) / 3600000;
    if (hours >= minHours && breakMinutes_(f) <= 0) {
      rows.push({
        scheduleId: f.scheduleId, persId: f.persId, badgeNo: f.badgeNo, unitName: f.unitName,
        sectionName: f.sectionName, categoryName: f.categoryName,
        start: f.begDate + ' ' + f.begTime.slice(0, 5), eind: f.endDate + ' ' + f.endTime.slice(0, 5),
        uren_bruto: Math.round(hours * 100) / 100, uren_veld: f.hours, breakType: f.breakType, comment: f.comment,
      });
    }
  });
  rows.sort((a, b) => (a.start + a.badgeNo).localeCompare(b.start + b.badgeNo));
  return { rows, total: items.length, skipped };
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
