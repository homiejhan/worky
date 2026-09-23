/* Timers past zero, the groundwork for the timer-overrun insight.
 * Run: npm test (or node --experimental-vm-modules tests/test_insights.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n── 1. Timers keep counting past zero ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    const id = w.eval('timers[1].id');   // Work, 4h
    w.eval(`const t = timers[1]; t.running = true; t.startedAt = Date.now() - 64000; t.secondsAtStart = 5; renderTimers();`);
    await sleep(1100);                   // tickAll only acts when the clock second changes
    const card = () => d.querySelector(`#timerStack-d .tcard-${id}`);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
