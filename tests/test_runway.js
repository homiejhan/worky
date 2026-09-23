/* Cash runway: days of cash against the next payday.
 * Sections 1–4 check the pure math in js/runway.js against fixtures; the rest
 * check it inside the Budget screen.
 * Run: npm test (or node --experimental-vm-modules tests/test_runway.js) */
const path = require('path');
const { loadApp, ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const R = await import(path.join(ROOT, 'js', 'runway.js'));

  console.log('\n── 1. Date keys ──');
  eq(R.addDays('2026-03-07', 2), '2026-03-09', 'across the spring DST change');
  eq(R.addDays('2026-12-30', 3), '2027-01-02', 'across a year end');
  eq(R.daysBetween('2026-10-31', '2026-11-02'), 2, 'across the fall DST change');
  eq(R.daysBetween('2026-09-23', '2026-09-23'), 0, 'same day');

  console.log('\n── 2. The next payday ──');
  eq(R.nextPayday('2026-10-02', 'biweekly', '2026-09-23'), '2026-10-02', 'a future payday is itself');
  eq(R.nextPayday('2026-09-04', 'biweekly', '2026-09-23'), '2026-10-02', 'every 2 weeks from Sep 4 → Oct 2');
  eq(R.nextPayday('2026-09-04', 'weekly', '2026-09-23'), '2026-09-25', 'every week from Sep 4 → Sep 25');
  eq(R.nextPayday('2026-09-04', 'weekly', '2026-09-25'), '2026-09-25', 'on payday, it is today');
  eq(R.nextPayday('2026-01-31', 'monthly', '2026-02-10'), '2026-02-28', 'the 31st pays on Feb 28');
  eq(R.nextPayday('2026-01-31', 'monthly', '2026-03-01'), '2026-03-31', 'and on Mar 31');
  eq(R.nextPayday('2027-01-29', 'monthly', '2028-02-02'), '2028-02-29', 'leap years keep the 29th');
  eq(R.nextPayday('2026-09-15', 'monthly', '2026-09-23'), '2026-10-15', 'monthly on the 15th');
  eq(R.nextPayday('2026-09-01', 'once', '2026-09-23'), null, 'a one-off payday that passed is gone');
  eq(R.nextPayday('', 'weekly', '2026-09-23'), null, 'no payday set');
  eq(R.nextPayday('Oct 2', 'weekly', '2026-09-23'), null, 'junk is no payday');

  console.log('\n── 3. Bills ──');
  const rent = { name: 'Rent', amount: 650, day: 1 }, phone = { name: 'Phone', amount: 35, day: 31 };
  eq(R.billsDueOn([rent, phone], '2026-10-01').map(b => b.name).join(), 'Rent', 'rent on the 1st');
  eq(R.billsDueOn([rent, phone], '2026-09-30').map(b => b.name).join(), 'Phone', 'a 31st bill falls on Sep 30');
  eq(R.billsDueOn([rent, phone], '2026-10-30').length, 0, 'but not on Oct 30 (October has a 31st)');
  eq(R.billsDueOn([{ name: 'x', amount: 5, day: 30 }], '2026-02-28').length, 1, 'the 30th falls on Feb 28');
  eq(R.billsDueOn([{ name: 'free', amount: 0, day: 1 }], '2026-10-01').length, 0, 'a $0 bill never counts');
  eq(R.billsDueBetween([rent, phone], '2026-09-28', '2026-10-02').map(b => `${b.name} ${b.date}`).join(', '),
    'Phone 2026-09-30, Rent 2026-10-01', 'bills since the last rollover, oldest first, the start day excluded');

  console.log('\n── 4. The runway ──');
  const T = '2026-09-23';
  let r = R.cashRunway({ today: T, payday: '2026-10-03', balance: 100, todaySpend: 10, dailySpend: 20 });
  eq(`${r.daysToPayday} ${r.daysOfCash} ${r.runsOutOn} ${r.short} ${r.shortBy} [${r.runsOutWith}]`, '10 5 2026-09-28 true 5 []',
    '$100 at $20/day (+$10 left today) lasts 5 days; payday in 10 → short by 5');
  r = R.cashRunway({ today: T, payday: '2026-10-03', balance: 300, todaySpend: 10, dailySpend: 20 });
  eq(`${r.daysOfCash} ${r.short}`, '15 false', '$300 lasts 15 days: covered');
  r = R.cashRunway({ today: T, payday: '2026-10-03', balance: 250, dailySpend: 20,
    shifts: [{ date: '2026-09-25', pay: 120 }, { date: '2026-10-04', pay: 500 }, { date: '2026-09-26', pay: null }] });
  eq(`${r.paycheck} ${r.unpricedShifts} ${r.daysOfCash}`, '120 1 19', 'shifts before payday ($120) land on payday and stretch 13 days to 19; a later shift waits for the next payday');
  r = R.cashRunway({ today: T, payday: '2026-09-28', balance: 50, dailySpend: 20, shifts: [{ date: '2026-09-24', pay: 1000 }] });
  eq(`${r.daysOfCash} ${r.short} ${r.shortBy} ${r.paycheck}`, '3 true 2 1000', 'a $1,000 shift tomorrow doesn\'t help before payday: short by 2 (timing, not literacy)');
  r = R.cashRunway({ today: '2026-09-27', payday: '2026-10-07', balance: 200, dailySpend: 10, bills: [rent] });
  eq(`${r.daysOfCash} ${r.billsBeforePayday} ${r.short} ${r.shortBy} ${r.runsOutWith}`, '4 650 true 6 Rent', '$650 rent on the 1st is more than the $170 left by then: out on day 4, short by 6, and rent is why');
  r = R.cashRunway({ today: '2026-09-27', payday: '2026-10-07', balance: 20, dailySpend: 10, bills: [rent, phone] });
  eq(`${r.daysOfCash} ${r.billsBeforePayday}`, '3 685', 'bills before payday count all of them ($35 phone Sep 30, $650 rent Oct 1), even past the day the money runs out');
  r = R.cashRunway({ today: '2026-10-01', payday: '2026-10-06', balance: 100, dailySpend: 10, bills: [rent] });
  eq(`${r.daysOfCash} ${r.billsBeforePayday}`, '11 0', 'a bill due today already came out at the morning rollover');
  r = R.cashRunway({ today: T, payday: '2026-10-03', balance: 5, dailySpend: 0 });
  eq(`${r.daysOfCash} ${r.short}`, 'null false', 'no daily spending, no bills: lasts past the horizon');
  r = R.cashRunway({ today: T, payday: '2026-10-03', balance: -20, dailySpend: 10 });
  eq(`${r.daysOfCash} ${r.runsOutOn} ${r.short}`, '0 2026-09-23 true', 'already negative: 0 days');
  r = R.cashRunway({ today: T, payday: T, balance: -20, dailySpend: 10 });
  eq(`${r.daysToPayday} ${r.short}`, '0 false', 'payday today is never short');
  r = R.cashRunway({ today: T, balance: 100, dailySpend: 20, shifts: [{ date: '2026-09-24', pay: 60 }] });
  eq(`${r.daysToPayday} ${r.paycheck} ${r.daysOfCash} ${r.short}`, 'null 0 6 false', 'no payday: $100 at $20/day is 6 days (today spends nothing more), nothing is "short"');

  console.log('\n── 5. Export, reload and older builds keep the runway ──');
  {
    const { w } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    const today = w.eval('dbdTodayKey()');
    w.eval(`runway.payday = addDays('${today}', 20); runway.repeat = 'weekly'; runway.bills = [{ id: 3, name: 'Rent', amount: 650, day: 1 }]`);
    const st = w.gatherState();
    eq(st.build, 5, 'state build 5 (runway is new)');
    const c = w.compressState(st);
    eq(JSON.stringify(c.rw), JSON.stringify({ p: st.runway.payday, r: 'weekly', b: [{ i: 3, n: 'Rent', a: 650, d: 1 }] }), 'Export writes rw');
    eq(JSON.stringify(w.decompressState(JSON.parse(JSON.stringify(c))).runway), JSON.stringify(st.runway), 'Import reads it back');
    eq(w.compressState({ ...st, runway: w.normalizeRunway(null) }).rw, undefined, 'an unused runway is left out of Export');
    const again = await loadApp({ storage: { 'focus-tour-done': '1', 'focus-app-state': JSON.stringify(st) } });
    eq(JSON.stringify(again.w.eval('runway')), JSON.stringify(st.runway), 'a reload restores it');
    const old = { ...st, build: 4 }; delete old.runway;
    again.w.syncApplyRemote(JSON.stringify(old), Date.now());
    eq(JSON.stringify(again.w.eval('runway')), JSON.stringify(st.runway), 'a build-4 cloud copy does not erase it');
    eq(JSON.stringify(again.w.normalizeRunway({ payday: 'soon', repeat: 'daily', bills: [{ name: 'x', amount: -4, day: 45 }] })),
      JSON.stringify({ payday: null, repeat: 'biweekly', bills: [{ id: 1, name: 'x', amount: 0, day: 31 }] }), 'settings are normalized');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
