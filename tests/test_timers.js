/* Timers — headless tests. A timer counts down to zero and stops there: it never
 * shows time past zero, play at zero does nothing, and one that ran out while the
 * app was closed is stopped when it opens. States saved by the build that let
 * timers run on past zero (an `over` on a timer, a timerLog) still load.
 * Run: npm test (or node --experimental-vm-modules tests/test_timers.js) */
const { loadApp } = require('./load-app');
const { world, until } = require('./sync-world');

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

  console.log('\n── 5. Each timer its own id: added after Focus opened again, and saved data where two share one ──');
  {
    const boot = storage => loadApp({ storage: { ...BOOT, ...storage } });
    const cards = d => [...d.querySelectorAll('#timerStack-d .timer-card')];
    const recolor = (w, d, i, color) => {
      const swatch = cards(d)[i].querySelector('input[type=color]');
      swatch.value = color;
      swatch.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    const shade = (d, i) => cards(d)[i].style.getPropertyValue('--tc');
    const labels = w => w.eval('timers.map(t => t.label).join(", ")');
    let { w, d } = await boot();
    w.toggleFormatMode(); w.addFormatTimer(); w.setTimerLabel(w.eval('timers[timers.length - 1].id'), 'Reading'); w.toggleFormatMode();
    ({ w, d } = await boot({ 'focus-app-state': w.localStorage.getItem('focus-app-state') }));   // Focus opened again
    w.toggleFormatMode(); w.addFormatTimer();
    const ids = w.eval('timers.map(t => t.id)'), n = ids.length;
    ok(new Set(ids).size === n, `a timer added after Focus was opened again gets an id of its own (${ids.join(', ')})`);
    ok(ids.slice(-2).every(id => id >= 1000), 'from 1000 up: an older build, counting from 900 each time it opens, can\'t give one out');
    recolor(w, d, n - 1, '#ff0000');
    ok(shade(d, n - 1) === '#ff0000' && shade(d, n - 2) !== '#ff0000' && w.eval('timers[timers.length - 1].color') === '#ff0000'
      && w.eval('timers[timers.length - 2].color') !== '#ff0000', 'its color changes that timer alone, on screen and saved');
    cards(d)[n - 1].querySelector('.fmt-remove-timer').click();
    ok(w.eval('timers.length') === n - 1 && w.eval('timers[timers.length - 1].label') === 'Reading', 'removing it removes it, not the one added before');
    w.toggleFormatMode();

    /* saved by a build that counted from 900 each time Focus opened: two timers under one id */
    const st = JSON.parse(w.localStorage.getItem('focus-app-state'));
    const reading = st.timers[st.timers.length - 1];
    st.timers.push({ ...reading, label: 'Piano', color: '#00aa00' });
    if (Array.isArray(st.timerDefaults)) st.timerDefaults.push({ label: 'Piano', seconds: reading.seconds, color: '#00aa00' });
    const broken = JSON.stringify(st);
    ({ w, d } = await boot({ 'focus-app-state': broken }));
    const fixed = w.eval('timers.map(t => t.id)');
    ok(new Set(fixed).size === fixed.length && fixed[fixed.length - 2] === reading.id && fixed[fixed.length - 1] >= 1000,
      `two saved under one id: the first keeps it, the later one gets one of its own, from 1000 up (${fixed.join(', ')})`);
    eq(labels(w), st.timers.map(t => t.label).join(', '), 'every timer is still there, in its place');
    const saved = JSON.parse(w.localStorage.getItem('focus-app-state')).timers.map(t => t.id);
    ok(saved.join() === fixed.join(), 'and saved so (synced as a change, so the other devices get it)');
    const again = await boot({ 'focus-app-state': broken });
    ok(again.w.eval('timers.map(t => t.id)').join() === fixed.join(), 'every device gives the later one the same id, so their copies agree');
    w.toggleFormatMode();
    const k = fixed.length;
    recolor(w, d, k - 1, '#123456');
    ok(shade(d, k - 1) === '#123456' && shade(d, k - 2) !== '#123456' && w.eval('timers[timers.length - 2].color') === reading.color,
      'then coloring one of the two changes that one alone');
    cards(d)[k - 1].querySelector('.fmt-remove-timer').click();
    ok(labels(w).endsWith('Reading') && !labels(w).includes('Piano'), 'and removing one removes that one');
    w.toggleFormatMode();
  }

  console.log('\n── 6. Two timers under one id, from another device on the older build ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    L.w.eval('timers.push({ ...timers[timers.length - 1], label: "Piano" }); TIMER_DEFAULTS.push({ ...TIMER_DEFAULTS[TIMER_DEFAULTS.length - 1] }); saveToLocal();');   // as the older build could
    const ids = st => st.timers.map(t => t.id);
    const own = st => new Set(ids(st)).size === st.timers.length;
    ok(await until(() => own(W.cloud()) && W.fp(L) === W.fp(P), 8000), 'the phone gives the later one its own id and sends it back: the cloud and both devices agree');
    await W.net.idle();
    await sleep(1500);
    ok(own(W.cloud()) && W.cloud().timers.map(t => t.label).pop() === 'Piano' && P.w.__applies.length === 1 && L.w.__applies.length === 1,
      `once, without going back and forth (${ids(W.cloud()).join(', ')})`);
  }

  /* jsdom has no layout: each card of a stack gets a 90 px box, 100 px apart, and
   * elementFromPoint answers from those. A drag: press the grip, move past 5 px,
   * move to `toY`, let go. */
  const layOut = (d, stack) => {
    const cards = [...d.querySelectorAll(`#${stack} .timer-card`)];
    cards.forEach((c, i) => { c.getBoundingClientRect = () => ({ left: 0, right: 320, width: 320, top: i * 100, bottom: i * 100 + 90, height: 90, x: 0, y: i * 100 }); });
    d.elementFromPoint = (x, y) => { const c = cards[Math.floor(y / 100)]; return c && y >= 0 && y % 100 < 90 ? c.querySelector('.timer-display') : null; };
    return cards;
  };
  const dragTimer = (w, d, from, toY, { stack = 'timerStack-d', pointerType = 'mouse', during } = {}) => {
    const cards = layOut(d, stack);
    const ev = (type, y) => new w.PointerEvent(type, { clientX: 20, clientY: y, button: 0, pointerType, bubbles: true, cancelable: true });
    cards[from].querySelector('.timer-drag-handle').dispatchEvent(ev('pointerdown', from * 100 + 12));
    w.dispatchEvent(ev('pointermove', from * 100 + 30));
    w.dispatchEvent(ev('pointermove', toY));
    if (during) during(cards);
    w.dispatchEvent(ev('pointerup', toY));
  };
  const order = w => w.eval('timers.map(t => t.label).join(", ")');
  const defaults = w => w.eval('TIMER_DEFAULTS.map(t => t.label).join(", ")');

  console.log('\n── 7. Dragging a timer by its grip ──');
  {
    let { w, d } = await loadApp({ storage: BOOT });
    const start = order(w);
    const ids = w.eval('Object.fromEntries(timers.map(t => [t.label, t.id]))');
    ok(d.querySelectorAll('#timerStack-d .timer-drag-handle').length === w.eval('timers.length')
      && d.querySelectorAll('#timerStack-m .timer-drag-handle').length === w.eval('timers.length'), `every timer has a grip, on a computer and a phone (${start})`);
    let shown = null;
    dragTimer(w, d, 0, 270, { during: cards => { shown = { line: cards[2].classList.contains('timer-drop-after'), src: cards[0].classList.contains('drag-src'), ghost: !!d.querySelector('.drag-ghost') }; } });
    const [a, b, c] = start.split(', ');
    ok(shown && shown.line && shown.src && shown.ghost, 'while dragging: the card follows the pointer, and a line shows where it will land');
    eq(order(w), `${b}, ${c}, ${a}`, 'dropped on the lower half of the last one: it goes after it');
    ok(w.eval('timers.map(t => t.label + "=" + t.id).join()') === [b, c, a].map(l => `${l}=${ids[l]}`).join(), 'each keeps its id');
    eq(defaults(w), order(w), 'and its default goes with it');
    ok(!d.querySelector('.drag-ghost, .drag-src, .timer-drop-before, .timer-drop-after'), 'nothing of the drag is left on the page');
    eq(JSON.parse(w.localStorage.getItem('focus-app-state')).timers.map(t => t.label).join(', '), order(w), 'saved at once');

    dragTimer(w, d, 2, 10);
    eq(order(w), `${a}, ${b}, ${c}`, 'the last one dropped on the top half of the first: it goes before it');
    dragTimer(w, d, 1, 20, { stack: 'timerStack-m', pointerType: 'touch' });
    eq(order(w), `${b}, ${a}, ${c}`, 'on a phone, by touch, the same');
    const before = order(w);
    dragTimer(w, d, 1, 150);
    dragTimer(w, d, 0, 95);
    eq(order(w), before, 'dropped on itself, or between cards: it stays where it was');

    const sleepId = ids[c], sleepDefault = w.eval(`TIMER_DEFAULTS[timers.findIndex(t => t.id === ${sleepId})].seconds`);
    w.eval(`timers.find(t => t.id === ${sleepId}).seconds = 60`);
    dragTimer(w, d, 2, 10);
    w.resetTimer(sleepId);
    eq(w.eval(`timers.find(t => t.id === ${sleepId}).seconds`), sleepDefault, 'Reset after a move gives it its own time, not that of the timer that was there');

    await sleep(300);
    w.toggleFormatMode();
    dragTimer(w, d, 0, 270);
    const inFormats = order(w);
    w.toggleFormatMode();
    ok(order(w) === inFormats && defaults(w) === inFormats, `in Formats too, and Done keeps it (${inFormats})`);
    ({ w, d } = await loadApp({ storage: { ...BOOT, 'focus-app-state': w.localStorage.getItem('focus-app-state') } }));
    ok(order(w) === inFormats && defaults(w) === inFormats, 'and Focus opened again has it');
  }

  console.log('\n── 8. A timer dragged on one device, with the other changing something meanwhile ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const start = order(L.w);
    const [a, b, c] = start.split(', ');
    dragTimer(L.w, L.d, 0, 270);
    ok(await until(() => order(P.w) === `${b}, ${c}, ${a}`, 5000) && defaults(P.w) === order(P.w), `on the phone in a moment, each timer with its own default (${order(P.w)})`);

    L.dev.sleep();                                                        // the laptop drags while it can't reach the cloud …
    dragTimer(L.w, L.d, 2, 10);
    const started = P.w.eval('timers[0].id');
    P.w.toggleTimer(started);                                             // … and the phone starts a timer: both changed the timers
    P.w.toggleTask(0, 0);                                                 // (and checks a task off)
    await until(() => W.cloud().timers.some(t => t.running) && W.cloud().todoLists[0].tasks[0].done, 5000);
    L.dev.wake();                                                         // the two are merged
    const want = `${a}, ${b}, ${c}`;
    ok(await until(() => order(L.w) === want && order(P.w) === want && W.fp(L) === W.fp(P), 8000),
      `both changes stay: the order dragged on the laptop (${order(L.w)} / ${order(P.w)}) …`);
    const cloud = W.cloud();
    const running = st => st.timers.filter(t => t.running).map(t => t.id).join();
    ok(running(cloud) === String(started) && L.w.eval(`timers.find(t => t.id === ${started}).running`) && cloud.todoLists[0].tasks[0].done,
      '… and the timer started on the phone, running everywhere, with the task it checked off');
    ok(cloud.timerDefaults.map(t => t.label).join(', ') === cloud.timers.map(t => t.label).join(', ') && defaults(L.w) === order(L.w) && defaults(P.w) === order(P.w),
      'each timer\'s default still beside it, in the cloud and on both');
    P.w.toggleTimer(started);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
