/* Insight cards on Home: a shift that collides with a deadline, cash that runs
 * out before payday, and a timer over budget three days running.
 * Sections 1–3 check the pure rules in js/insights.js against fixtures; the rest
 * check timers running past zero and the cards on Home.
 * Run: npm test (or node --experimental-vm-modules tests/test_insights.js) */
const path = require('path');
const { loadApp, ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  console.log('\n── 3. A timer over budget three days running ──');
  const e = (over, budget = 14400, label = 'Work') => ({ label, over, budget });
  const log = {
    '2026-09-21': { work: e(3000), study: e(600, 10800, 'Study') },
    '2026-09-22': { work: e(2400), study: e(900, 10800, 'Study') },
    '2026-09-23': { work: e(2700) },
    '2026-09-19': { study: e(300, 10800, 'Study') },
  };
  let o = I.timerOverruns(log, '2026-09-23');
  eq(o.length, 1, 'Work went over Mon, Tue, Wed; Study only Mon and Tue');
  eq(JSON.stringify(o[0]), JSON.stringify({ key: 'work', label: 'Work', days: 3, avgOver: 2700, budget: 14400, suggested: 17100 }),
    'avg 45 min over a 4 h budget → try 4 h 45 min');
  eq(I.timerOverruns(log, '2026-09-24').map(x => x.key).join(), 'work', 'the morning after, before it goes over again, the streak still counts');
  eq(I.timerOverruns(log, '2026-09-25').length, 0, 'a day without an overrun ends the streak');
  eq(I.timerOverruns(log, '2026-09-22').length, 0, 'two days is not three');
  eq(I.timerOverruns(log, '2026-09-22', 2).map(x => x.key).join(), 'study,work', 'minDays is a parameter; ties sort by name');
  o = I.timerOverruns({ '2026-09-21': { x: e(100, null, 'X') }, '2026-09-22': { x: e(200, null, 'X') }, '2026-09-23': { x: e(300, null, 'X') } }, '2026-09-23');
  eq(o[0].suggested, null, 'no known budget, no suggestion');
  eq(I.timerOverruns({}, '2026-09-23').length, 0, 'empty log: nothing');

  console.log('\n── 4. Timers keep counting past zero ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    const id = w.eval('timers[1].id');   // Work, 4h
    w.eval(`const t = timers[1]; t.running = true; t.startedAt = Date.now() - 64000; t.secondsAtStart = 5; renderTimers();`);
    const card = () => d.querySelector(`#timerStack-d .tcard-${id}`);
    // tickAll updates the display once the clock second changes; on a busy machine
    // its animation frames can run late, so wait for the update instead of a fixed time
    for (let i = 0; i < 60 && card().querySelector('.timer-display').textContent === '+00:59'; i++) await sleep(50);
    ok(card().classList.contains('over') && card().classList.contains('running'), 'a timer past zero keeps running, marked over');
    ok(/^\+01:0[01]$/.test(card().querySelector('.timer-display').textContent), `it shows the time over: ${card().querySelector('.timer-display').textContent}`);
    eq(card().querySelector('.timer-sub').textContent, 'Over budget · still running', 'and says so');
    ok(d.querySelector(`#homeContainer-d .hchip-${id}`)?.classList.contains('over'), 'the Home chip turns red too');
    const today = w.eval('dbdTodayKey()');
    eq(w.eval(`JSON.stringify(timerLog['${today}'].work && { label: timerLog['${today}'].work.label, budget: timerLog['${today}'].work.budget })`),
      JSON.stringify({ label: 'Work', budget: 14400 }), 'today\'s log notes the overrun as soon as it happens');
    w.toggleTimer(id);                   // pause
    const t = w.eval('timers[1]');
    ok(!t.running && t.seconds === 0 && t.over >= 60 && t.over <= 62, 'pausing keeps the minute over');
    ok(/^Paused · 01:0[0-2] over budget$/.test(card().querySelector('.timer-sub').textContent), 'paused, still over');
    ok(w.eval(`timerLog['${today}'].work.over`) >= 60, 'the log now has the whole minute');
    eq(w.eval('Math.round(getOvertime(timers[1]))'), t.over, 'getOvertime reads it');
    w.toggleTimer(id);                   // at zero, play still starts: more overtime
    ok(w.eval('timers[1].running'), 'play at zero starts again (overtime)');
    w.eval('timers[1].startedAt -= 30000');
    w.toggleTimer(id);
    ok(w.eval('timers[1].over') >= 90, 'overtime adds up across runs');
    // Formats parks the overtime and gives it back
    d.getElementById('fmtBtn').click();
    eq(w.eval('timers[1].over'), 0, 'Formats shows the default, not the overtime');
    d.getElementById('fmtBtn').click();
    ok(w.eval('timers[1].over') >= 90, 'Done brings the overtime back');
    // saved and exported
    const st = w.gatherState();
    ok(st.timers[1].over >= 90, 'saved with the state');
    ok(st.build >= 6 && st.timerLog[today].work.over >= 90, 'the log is saved too (build 6)');
    const c2 = w.compressState(st);
    ok(c2.tm[1].ov >= 90 && Array.isArray(c2.tg[today].work), 'Export writes ov and tg');
    const back = w.decompressState(JSON.parse(JSON.stringify(c2)));
    eq(back.timers[1].over, st.timers[1].over, 'Import reads the overtime back');
    eq(JSON.stringify(back.timerLog), JSON.stringify(st.timerLog), 'and the log');
    // reset clears the overtime but the day still counts
    w.resetTimer(id);
    const r = w.eval('timers[1]');
    ok(!r.over && r.seconds === 14400, 'Reset starts the timer fresh');
    eq(card().querySelector('.timer-display').textContent, '4:00:00', 'showing its full budget');
    ok(w.eval(`timerLog['${today}'].work.over`) >= 90, 'the overrun stays in today\'s log');
    ok(!/-|NaN/.test(d.getElementById('timerSummary-d').textContent), 'time remaining never goes negative');
    // an older build's cloud copy has no timerLog: keep ours
    const old = { ...st, build: 5 }; delete old.timerLog;
    w.syncApplyRemote(JSON.stringify(old), Date.now());
    ok(w.eval(`timerLog['${today}'] && timerLog['${today}'].work.over`) >= 90, 'a build-5 cloud copy does not erase the log');
    eq(Object.keys(w.normalizeTimerLog({ bad: {}, '2026-09-01': { a: { label: 'A', over: -5, budget: 'x' } } })).join(), '2026-09-01', 'the log is normalized');
    eq(JSON.stringify(w.normalizeTimerLog({ '2026-09-01': { a: { label: 'A', over: 99999, budget: 'x' } } })['2026-09-01'].a), JSON.stringify({ label: 'A', over: 14400, budget: null }), 'overruns cap at 4 h so a forgotten timer can\'t skew the average');
  }

  console.log('\n── 5. Home: no cards on a normal day ──');
  {
    const { d } = await loadApp();
    eq(d.querySelector('#homeContainer-d .home-sec-insights'), null, 'a fresh start has nothing to warn about');
  }

  console.log('\n── 6. Home: the three cards, and where their buttons go ──');
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
    // 3. a timer over budget three days running
    w.eval(`timerLog = { [addDays('${today}', -2)]: { work: { label: 'Work', over: 3000, budget: 14400 } },
                        [addDays('${today}', -1)]: { work: { label: 'Work', over: 2400, budget: 14400 } },
                        ['${today}']:             { work: { label: 'Work', over: 2700, budget: 14400 } } }; renderHome();`);
    cards = [...d.querySelectorAll('#homeContainer-d .home-insight')];
    eq(cards.map(c => c.className.replace('home-insight ', '')).join(' '), 'hi-clash hi-cash hi-timer', 'all three, in a fixed order');
    const tc = cards[2];
    eq(tc.querySelector('.hi-title').textContent, 'Work: the budget is wrong, not you', 'timer card');
    eq(tc.querySelector('.hi-text').textContent, 'It ran over 3 days running, by 45 min on average. Try 4 h 45 min instead of 4 h.', 'with a suggested budget');
    // buttons: phone layout (jsdom shows #mobileApp)
    cards[0].querySelector('.hi-go').click();
    eq(w.eval('currentView'), 'calendar', 'Calendar button opens the calendar');
    w.goTab('home', false);
    d.querySelector('#homeContainer-m .hi-cash .hi-go').click();
    eq(w.eval('currentView'), 'budget', 'Budget button opens the budget');
    w.goTab('home', false);
    d.querySelector('#homeContainer-m .hi-timer .hi-go').click();
    ok(w.eval('formatMode') && w.eval('currentView') === 'timers', 'Formats button opens Formats on the timers');
    d.getElementById('fmtBtn').click();
    // fixing the problem removes the card
    w.eval(`todoLists.find(l => l.title === 'Deadlines').tasks.find(t => t.id === 9302).done = true; renderHome();`);
    ok(!d.querySelector('#homeContainer-d .hi-clash'), 'finishing the deadline clears the clash');
    w.eval(`budget.initial = 500; renderHome();`);
    ok(!d.querySelector('#homeContainer-d .hi-cash'), 'enough cash clears the cash card');
    w.eval(`timerLog = {}; renderHome();`);
    eq(d.querySelector('#homeContainer-d .home-sec-insights'), null, 'and with nothing left, Heads up goes away');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
