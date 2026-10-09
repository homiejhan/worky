/* Timers — headless tests. A timer counts down to zero and stops there: it never
 * shows time past zero, play at zero does nothing, and one that ran out while the
 * app was closed is stopped when it opens. States saved by the build that let
 * timers run on past zero (an `over` on a timer, a timerLog) still load.
 * Run: npm test (or node --experimental-vm-modules tests/test_timers.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* tickAll runs on a timeout, which can come late on a busy machine: wait for the result */
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await sleep(25);
  return fn();
}
const BOOT = { 'focus-tour-done': '1' };

(async () => {
  console.log('\n── 1. A running timer stops at zero ──');
  {
    const { w, d } = await loadApp({ storage: BOOT });
    const id = w.eval('timers[1].id');   // Work, 4 h
    const card = () => d.querySelector(`#timerStack-d .tcard-${id}`);
    w.eval('wokenUp = true; updateTimerSummary();');
    w.eval(`const t = timers[1]; t.running = true; t.startedAt = Date.now() - 64000; t.secondsAtStart = 5; renderTimers();`);
    ok(await waitFor(() => !w.eval('timers[1].running')), 'it stops by itself');
    eq(w.eval('timers[1].seconds'), 0, 'at zero');
    eq(card().querySelector('.timer-display').textContent, '00:00', 'showing 00:00, not the time since');
    ok(!card().classList.contains('running'), 'the card is not running any more');
    eq(card().querySelector('.timer-sub').textContent, 'Paused · tap the time to edit', 'and says what to do next');
    eq(d.querySelector(`#homeContainer-d .hchip-${id} .home-timer-time`).textContent, '00:00', 'the Home chip shows 00:00 too');
    const saved = JSON.parse(w.localStorage.getItem('focus-app-state')).timers[1];
    ok(!saved.running && saved.seconds === 0, 'the stop is saved, so other devices get it');
    ok(!('over' in saved), 'with nothing past zero');
    ok(!/-|\+|NaN/.test(d.getElementById('timerSummary-d').textContent), 'Time remaining never goes below zero');

    w.toggleTimer(id);
    ok(!w.eval('timers[1].running'), 'play at zero does nothing');
    eq(card().querySelector('.timer-display').textContent, '00:00', 'and the display stays at 00:00');

    w.startEditTimer(id, 'd');
    d.querySelector(`.tedit-${id}-d`).value = '0:10:00';
    w.commitEditTimer(id, 'd');
    w.toggleTimer(id);
    ok(w.eval('timers[1].running'), 'a new time starts again');
    w.toggleTimer(id);
    w.resetTimer(id);
    eq(w.eval('timers[1].seconds'), 14400, 'Reset brings back the full 4 h');
    eq(card().querySelector('.timer-display').textContent, '4:00:00', 'on the card');
  }

  console.log('\n── 2. A timer that ran out while the app was closed ──');
  {
    const a = await loadApp({ storage: BOOT });
    a.w.eval(`const t = timers[0]; t.running = true; t.startedAt = Date.now() - (t.seconds + 90) * 1000; t.secondsAtStart = t.seconds; saveToLocal();`);
    const raw = a.w.localStorage.getItem('focus-app-state');
    ok(JSON.parse(raw).timers[0].running, 'saved while running');
    const { w, d } = await loadApp({ storage: { ...BOOT, 'focus-app-state': raw } });
    ok(await waitFor(() => !w.eval('timers[0].running')), 'opening the app stops it');
    eq(d.querySelector(`#timerStack-d .tcard-${w.eval('timers[0].id')} .timer-display`).textContent, '00:00', 'at 00:00');
    ok(!JSON.parse(w.localStorage.getItem('focus-app-state')).timers[0].running, 'and saves that');
  }

  console.log('\n── 3. Saved data from the build that let timers run past zero ──');
  {
    const a = await loadApp({ storage: BOOT });
    const st = a.w.gatherState();
    const id = st.timers[1].id;
    st.timers[1] = { ...st.timers[1], seconds: 0, running: false, over: 754 };
    st.timerLog = { '2026-09-20': { work: { label: 'Work', over: 2700, budget: 14400 } } };
    const { w, d } = await loadApp({ storage: { ...BOOT, 'focus-app-state': JSON.stringify(st) } });
    eq(d.querySelector(`#timerStack-d .tcard-${id} .timer-display`).textContent, '00:00', 'a saved overrun shows as 00:00');
    ok(!('over' in w.eval('timers[1]')), 'the overrun is dropped');
    eq(JSON.stringify(w.gatherState().timerLog), JSON.stringify(st.timerLog),
      'an older device\'s timer log passes through untouched, so sync never strips it and bounces');
    eq(d.querySelector('#homeContainer-d .home-sec-insights'), null, 'no Heads up card comes from it');

    const c = w.compressState(w.gatherState());
    ok(!('tg' in c) && c.tm.every(t => !('ov' in t)), 'Export writes no overrun fields');
    const oldExport = { ...c, tm: c.tm.map((t, i) => (i === 1 ? { ...t, ov: 754 } : t)), tg: { '2026-09-20': { work: ['Work', 2700, 14400] } } };
    const back = w.decompressState(JSON.parse(JSON.stringify(oldExport)));
    ok(back && !('over' in back.timers[1]) && !('timerLog' in back), 'an Export from that build imports, without them');
  }

  console.log('\n── 4. Left open with nothing running, Focus does nothing ──');
  {
    let frames = 0, writes = 0;
    const spy = w => {
      const raf = w.requestAnimationFrame.bind(w);
      w.requestAnimationFrame = cb => { frames++; return raf(cb); };
      const set = w.Storage.prototype.setItem;
      w.Storage.prototype.setItem = function (k, v) { if (k === 'focus-app-state') writes++; return set.call(this, k, v); };
    };
    const { w, d } = await loadApp({ storage: BOOT, before: spy });
    const id = w.eval('timers[0].id');
    const shown = () => d.querySelector(`#timerStack-d .tcard-${id} .timer-display`).textContent;
    frames = 0; writes = 0;
    await sleep(4500);
    ok(frames === 0 && !w.eval('_tickNext'), `no animation frames, no tick with no timer running (frames: ${frames})`);
    eq(writes, 0, 'and nothing saved with nothing changed (the save every 2 s skips)');
    w.eval('budget.daily = 31');
    ok(await waitFor(() => writes === 1, 3000), 'a change nothing saved at once is saved within 2 s');
    ok(JSON.parse(w.localStorage.getItem('focus-app-state')).budget.daily === 31, 'with the change');

    w.toggleTimer(id);
    const at = shown();
    ok(w.eval('_tickNext') && await waitFor(() => shown() !== at, 2500), `a timer started: it ticks, once a second (${at} → ${shown()})`);
    eq(frames, 0, 'without animation frames');
    w.toggleTimer(id);
    ok(await waitFor(() => !w.eval('_tickNext'), 2500), 'paused, and nothing else running: the ticks stop');
    w.toggleWakeup();
    ok(w.eval('_tickNext'), 'Woke up checked: a tick at the next minute, for the finish time');
    ok(/Est\. finish/.test(d.getElementById('timerSummary-d').textContent), 'which shows at once');
    const left = () => d.querySelector('#timerSummary-d .timer-summary-value').textContent;
    const before = left();
    w.startEditTimer(id, 'd');
    d.querySelector(`.tedit-${id}-d`).value = '0:30:00';
    w.commitEditTimer(id, 'd');
    ok(left() !== before, `a paused timer's time edited: the time remaining follows at once, not at the next minute (${before} → ${left()})`);
    w.resetTimer(id);
    const total = w.eval('fmt(timers.reduce((s, t) => s + Math.round(getRemaining(t)), 0))');
    ok(left() === total, `and after Reset, at once (${left()})`);
    w.toggleWakeup();
    w.eval(`const t = timers[0]; t.running = true; t.startedAt = Date.now(); t.secondsAtStart = t.seconds; renderTimers();`);
    const from = shown();
    ok(await waitFor(() => shown() !== from, 2500), 'a timer running in a copy that arrives (sync, a reload) ticks too');
    w.toggleTimer(id);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
