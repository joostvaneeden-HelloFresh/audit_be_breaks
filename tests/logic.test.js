// Draai: node tests/logic.test.js  (test de pure logica uit Code.gs)
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../Code.gs', 'utf8');
global.Logger = { log() {} };
const ctx = new Function(src + '; return {auditItems_, breakMinutes_, COLUMNS, getAccounts_, backfillPeriods_, periodRange_, weekRow_, totalRow_, mergeWeeks_};')();
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
assert.deepStrictEqual(ctx.getAccounts_(props({ QUINYX_API_KEY_Gent: ' b ', QUINYX_API_KEY_Antwerpen: 'a', QUINYX_API_KEY_Namur: ' ', OTHER: 'x' })),
  [{ label: 'Antwerpen', key: 'a' }, { label: 'Gent', key: 'b' }]);
assert.throws(() => ctx.getAccounts_(props({})));
console.log('accounts ok');

// ---- period: last 7 full days, no overlap between weekly runs ----
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const pr = ctx.periodRange_(new Date(2026, 10, 12)); // Thu 12 Nov 2026
assert.deepStrictEqual([ymd(pr.from), ymd(pr.to)], ['2026-11-05', '2026-11-11']);
const pr2 = ctx.periodRange_(new Date(2026, 10, 19)); // a week later
assert.strictEqual(ymd(pr2.from), '2026-11-12'); // starts the day after the previous period ended -> no overlap, no gap
assert.strictEqual(ymd(ctx.periodRange_(new Date(2026, 0, 3)).from), '2025-12-27'); // year boundary

// ---- trend rows ----
const w1 = ctx.weekRow_('2026-11-05', '2026-11-11', 200, 20);
assert.deepStrictEqual(w1, { week_from: '2026-11-05', week_to: '2026-11-11', shifts_checked: 200, missing_break: 20 });
const tot = ctx.totalRow_([w1, ctx.weekRow_('2026-11-05', '2026-11-11', 100, 5)]);
assert.deepStrictEqual([tot.shifts_checked, tot.missing_break, tot.hubs_included], [300, 25, 2]);
const w2 = ctx.weekRow_('2026-11-12', '2026-11-18', 100, 4);
const merged = ctx.mergeWeeks_([w2, w1], [ctx.weekRow_('2026-11-05', '2026-11-11', 200, 10)]); // rerun of week 1
assert.deepStrictEqual(merged.map(r => r.week_from + ':' + r.missing_break), ['2026-11-05:10', '2026-11-12:4']);
// overlapping period (e.g. an old test row Thu-Wed vs. new Sat-Fri week) is replaced, not duplicated
const ov = ctx.mergeWeeks_([w1], [ctx.weekRow_('2026-10-31', '2026-11-06', 50, 7)]);
assert.deepStrictEqual(ov.map(r => r.week_from + '..' + r.week_to), ['2026-10-31..2026-11-06']);
// adjacent weeks do not overlap
assert.strictEqual(ctx.mergeWeeks_([ctx.weekRow_('2026-10-24', '2026-10-30', 1, 1)], [ctx.weekRow_('2026-10-31', '2026-11-06', 1, 1)]).length, 2);
console.log('trend ok');

// ---- backfill periods: go-live Thu 1 Oct 2026, first period to Friday, then Saturday-Friday weeks ----
const bp = ctx.backfillPeriods_('2026-10-01', '2026-11-13'); // today = Fri 13 Nov: that week is not finished yet
assert.deepStrictEqual(bp.map(p => p.from + '..' + p.to), [
  '2026-10-01..2026-10-02', '2026-10-03..2026-10-09', '2026-10-10..2026-10-16',
  '2026-10-17..2026-10-23', '2026-10-24..2026-10-30', '2026-10-31..2026-11-06']);
assert.strictEqual(ctx.backfillPeriods_('2026-10-01', '2026-11-14').length, 7); // Saturday: week 7-13 Nov is complete
assert.strictEqual(ctx.backfillPeriods_('2026-10-01', '2026-10-02').length, 0); // Friday is not over yet
console.log('backfill ok');
