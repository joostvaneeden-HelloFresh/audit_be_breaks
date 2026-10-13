// Draai: node tests/logic.test.js  (test de pure logica uit Code.gs)
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../Code.gs', 'utf8').replace('ScriptApp.WeekDay.MONDAY', '1');
const ctx = new Function(src + '; return {auditItems_, breakMinutes_, COLUMNS, getAccounts_};')();
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
const by = k => r.rows.filter(x => x.issue === k).map(x => x.badgeNo).sort();
assert.deepStrictEqual(by('missing_break'), ['EXACT6', 'LONG', 'NIGHT']);
assert.deepStrictEqual(by('break_not_expected'), ['BREAK']); // B15 / BREAK4 = 15 min, SHORT = no break but < 6h
assert.strictEqual(r.skipped, 1); assert.strictEqual(r.total, 8);
assert.strictEqual(r.missing, 3); assert.strictEqual(r.other, 1);
console.log('ok', r.rows.map(x => x.badgeNo + ':' + x.issue).join(' '));
console.log(ctx.COLUMNS.join(';'));

const props = v => ({ getProperties: () => v });
assert.deepStrictEqual(ctx.getAccounts_(props({ QUINYX_API_KEY_Utrecht: ' b ', QUINYX_API_KEY_Diemen: 'a', QUINYX_API_KEY_Empty: ' ', OTHER: 'x' })),
  [{ label: 'Diemen', key: 'a' }, { label: 'Utrecht', key: 'b' }]);
assert.deepStrictEqual(ctx.getAccounts_(props({ QUINYX_API_KEY: 'k' })), [{ label: 'default', key: 'k' }]);
assert.throws(() => ctx.getAccounts_(props({})));
console.log('accounts ok');
