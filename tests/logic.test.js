// Draai: node tests/logic.test.js  (test de pure logica uit Code.gs)
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../Code.gs', 'utf8').replace('ScriptApp.WeekDay.MONDAY', '1');
const ctx = new Function(src + '; return {auditItems_, breakMinutes_, toCsv_};')();
const base = { begDate: '2026-10-10', endDate: '2026-10-10', begBreak: '00:00:00', endBreak: '00:00:00',
  leaveReasonId: '0', productiveTime: 'true', isFreeDay: 'false', approvedLeave: 'false' };
const it = (o) => Object.assign({}, base, o);
const r = ctx.auditItems_([
  it({ badgeNo: 'SHORT', begTime: '07:33:00', endTime: '13:06:00' }),
  it({ badgeNo: 'EXACT6', begTime: '08:00:00', endTime: '14:00:00' }),
  it({ badgeNo: 'LONG', begTime: '07:00:00', endTime: '16:00:00' }),
  it({ badgeNo: 'BREAK', begTime: '07:00:00', endTime: '16:00:00', begBreak: '12:00:00', endBreak: '12:30:00' }),
  it({ badgeNo: 'BREAK4', begTime: '07:00:00', endTime: '16:00:00', begBreak4: '12:00:00', endBreak4: '12:15:00' }),
  it({ badgeNo: 'B15', begTime: '07:00:00', endTime: '16:00:00', begBreak: '12:00:00', endBreak: '12:15:00' }),
  it({ badgeNo: 'LEAVE', begTime: '07:00:00', endTime: '16:00:00', leaveReasonId: '12' }),
  it({ badgeNo: 'NIGHT', begTime: '22:00:00', endDate: '2026-10-11', endTime: '06:30:00' }),
], 6, 15);
assert.deepStrictEqual(r.rows.map(x => x.badgeNo).sort(), ['EXACT6', 'LONG', 'NIGHT']);
assert.strictEqual(r.skipped, 1); assert.strictEqual(r.total, 8);
// not 15 min: SHORT, EXACT6, LONG, BREAK(30), NIGHT; not B15/BREAK4 (15), not LEAVE (skipped)
assert.deepStrictEqual(r.breakMismatch.map(x => x.badgeNo).sort(), ['BREAK', 'EXACT6', 'LONG', 'NIGHT', 'SHORT']);
console.log('ok', r.rows.map(x => x.badgeNo + ':' + x.gross_hours).join(' '));
console.log(ctx.toCsv_(r.rows).split('\n')[0]);
