/* Insight cards on Home: a shift that collides with a deadline, and cash that
 * runs out before payday. Sections 1–2 check the pure rules in js/insights.js
 * against fixtures; the rest check the cards on Home.
 * Run: npm test (or node --experimental-vm-modules tests/test_insights.js) */
const path = require('path');
const { loadApp, ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

(async () => {
  const I = await import(path.join(ROOT, 'js', 'insights.js'));

  console.log('\n── 1. A shift collides with a deadline (due 11:59pm; the 24 hours before it) ──');
  const now = { date: '2026-09-23', minutes: 10 * 60 };           // Wed 10am
  const dl = (id, due, text = id) => ({ id, text, due });
  const sh = (date, start, minutes, title = 'Cafe') => ({ date, start, minutes, title });
  let c = I.deadlineClashes([sh('2026-09-25', '17:00', 300)], [dl('ps3', '2026-09-25')], now);
  eq(c.length === 1 && c[0].overlap, 300, 'Fri 5–10pm shift, due Fri: clash, 5 h of overlap');
  eq(I.deadlineClashes([sh('2026-09-24', '18:00', 300)], [dl('ps3', '2026-09-25')], now).length, 0, 'Thu 6–11pm is more than 24 h before Fri 11:59pm: no clash');
  c = I.deadlineClashes([sh('2026-09-24', '22:00', 480)], [dl('ps3', '2026-09-25')], now);
  eq(c.length === 1 && c[0].overlap, 360, 'Thu 10pm–6am runs 6 h into the due date: clash');
  eq(I.deadlineClashes([sh('2026-09-26', '09:00', 240)], [dl('ps3', '2026-09-25')], now).length, 0, 'a shift after the deadline: no clash');
  eq(I.deadlineClashes([sh('2026-09-23', '06:00', 180)], [dl('lab', '2026-09-23')], now).length, 0, 'a shift that already ended: no clash');
  eq(I.deadlineClashes([sh('2026-09-23', '09:00', 180)], [dl('lab', '2026-09-23')], now)[0].overlap, 180, 'a shift under way still counts');
  eq(I.deadlineClashes([sh('2026-09-22', '17:00', 300)], [dl('old', '2026-09-22')], now).length, 0, 'a deadline already past: no clash');
  c = I.deadlineClashes([sh('2026-09-27', '12:00', 240, 'B'), sh('2026-09-25', '17:00', 300, 'A')], [dl('ps3', '2026-09-25'), dl('essay', '2026-09-27')], now);
  eq(c.map(x => `${x.shift.title}/${x.deadline.id}`).join(' '), 'A/ps3 B/essay', 'soonest first');
  c = I.deadlineClashes([sh('2026-09-25', '17:00', 300)], [dl('ps3', '2026-09-25'), dl('quiz', '2026-09-25')], now);
  eq(c.length, 2, 'one shift against two deadlines that day: two clashes');
  eq(I.deadlineClashes([], [dl('ps3', '2026-09-25')], now).length + I.deadlineClashes([sh('2026-09-25', '17:00', 300)], [], now).length, 0, 'no shifts or no deadlines: nothing');

  console.log('\n── 2. Cash runs out before payday ──');
  eq(I.runwayWarning(null), null, 'no runway: nothing');
  eq(I.runwayWarning({ short: false }), null, 'covered: nothing');
  const w8 = I.runwayWarning({ short: true, runsOutOn: '2026-10-01', runsOutWith: ['Rent'], shortBy: 1, daysToPayday: 9, payday: '2026-10-02', shortfall: 423.5 });
  eq(JSON.stringify(w8), JSON.stringify({ runsOutOn: '2026-10-01', runsOutWith: ['Rent'], shortBy: 1, daysToPayday: 9, payday: '2026-10-02', shortfall: 423.5 }), 'short: when, why, by how many days and dollars');

  console.log('\n── 3. Home: no cards on a normal day ──');
  {
    const { d } = await loadApp();
    eq(d.querySelector('#homeContainer-d .home-sec-insights'), null, 'a fresh start has nothing to warn about');
  }

  console.log('\n── 4. Home: both cards, and where their buttons go ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    const today = w.eval('dbdTodayKey()');
    const tomorrow = w.addDays(today, 1);
    // 1. a Focus shift tomorrow evening + a deadline due tomorrow
    w.eval(`calEnsureDay('${tomorrow}'); calEvents['${tomorrow}'].push({ id: 9301, title: 'Campus cafe', start: '17:00', end: '22:00', color: '#22C55E', type: 'event', shift: true, wage: 15 });
            todoLists.find(l => l.title === 'Deadlines').tasks.push({ id: 9302, text: 'Essay draft', done: false, due: '${tomorrow}' });
            renderHome();`);
    let cards = [...d.querySelectorAll('#homeContainer-d .home-insight')];
    ok(w.eval(`dbdTasks.some(t => t.due === '${tomorrow}' && !t.done)`), 'a Day by Day task is dated tomorrow too (a plan, not a deadline)');
    eq(cards.length, 1, 'one card: the clash');
    ok(cards[0].classList.contains('hi-clash') && cards[0].querySelector('.hi-title').textContent === 'A shift lands on a deadline', 'shift vs. deadline card');
    eq(cards[0].querySelector('.hi-text').textContent, 'Campus cafe tomorrow 5pm–10pm is in the 24 hours before “Essay draft” is due. Finish it earlier or swap the shift.', 'says which shift and which deadline');
    const sec = d.querySelector('#homeContainer-d .home-sec-insights');
    ok(sec.previousElementSibling && sec.previousElementSibling.classList.contains('home-hero'), 'Heads up sits right under the greeting');
    // 2. cash that runs out before payday
    w.eval(`runway.payday = addDays('${today}', 6); budget = normalizeBudget({ initial: 40, daily: 20, lastDate: '${today}', purchases: [] }); renderHome();`);
    cards = [...d.querySelectorAll('#homeContainer-d .home-insight')];
    const cash = cards.find(c => c.classList.contains('hi-cash'));
    ok(cash && cash.querySelector('.hi-title').textContent === 'Cash runs out before payday', 'cash card');
    ok(/^Your money runs out .+, 4 days before payday\. About \$80\.00 more would carry you to .+\.$/.test(cash.querySelector('.hi-text').textContent),
      'short by 4 days; $80 more covers it ($40 now, today $20, 5 more days at $20)');
    eq(cards.map(c => c.className.replace('home-insight ', '')).join(' '), 'hi-clash hi-cash', 'both, in a fixed order');
    // buttons: phone layout (jsdom shows #mobileApp)
    cards[0].querySelector('.hi-go').click();
    eq(w.eval('currentView'), 'calendar', 'Calendar button opens the calendar');
    w.goTab('home', false);
    d.querySelector('#homeContainer-m .hi-cash .hi-go').click();
    eq(w.eval('currentView'), 'budget', 'Budget button opens the budget');
    // fixing the problem removes the card
    w.eval(`todoLists.find(l => l.title === 'Deadlines').tasks.find(t => t.id === 9302).done = true; renderHome();`);
    ok(!d.querySelector('#homeContainer-d .hi-clash'), 'finishing the deadline clears the clash');
    w.eval(`budget.initial = 500; renderHome();`);
    ok(!d.querySelector('#homeContainer-d .hi-cash'), 'enough cash clears the cash card');
    eq(d.querySelector('#homeContainer-d .home-sec-insights'), null, 'and with nothing left, Heads up goes away');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
