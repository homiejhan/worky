/* Focus Overlay, the desktop app (desktop/): where its window goes (desktop/snap.js),
 * and the page in it (js/overlay.js) — the round button, dragged or clicked, the
 * panel beside it with the timers and Focus's tabs, closed again, the running
 * timers' clocks beside the closed button, and signing in through the browser. The app's window itself is played in tests/e2e_overlay.js
 * (Electron, not part of npm test). Here the app is a stand-in: window.focusOverlay,
 * keeping what the page asked of it.
 * Run: npm test -- overlay (or node --experimental-vm-modules tests/test_overlay.js) */
const path = require('path');
const { loadApp, ROOT } = require('./load-app');
const { createFakeFirebase } = require('./fake-firebase');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  return fn();
}

/* the desktop app, as the page sees it (desktop/preload.js); { old: true }: one
 * from before it said where its button is and made room for clocks */
function stand(startState = 'icon', { old = false } = {}) {
  let state = startState, tokenCb = null, layoutCb = null;
  const calls = [];
  const lay = { side: 'right', buttonTop: 0 };
  const layout = () => ({ state, ...lay });
  const api = {
    state: () => Promise.resolve(state),
    expand: () => { calls.push('expand'); state = 'panel'; return Promise.resolve(state); },
    collapse: () => { calls.push('collapse'); state = 'icon'; return Promise.resolve(state); },
    dragStart: () => calls.push('dragStart'),
    dragMove: (dx, dy) => calls.push(`dragMove ${dx},${dy}`),
    dragEnd: () => calls.push('dragEnd'),
    menu: () => calls.push('menu'),
    signIn: url => calls.push(`signIn ${url}`),
    onSignIn: cb => { tokenCb = cb; },
  };
  if (!old) Object.assign(api, {
    layout: () => Promise.resolve(layout()),
    onLayout: cb => { layoutCb = cb; },
    clocks: (w, h) => { calls.push(`clocks ${w}x${h}`); return Promise.resolve(layout()); },
  });
  return {
    calls, api, hand: t => tokenCb && tokenCb(t),
    moveTo: (side, buttonTop) => { Object.assign(lay, { side, buttonTop }); if (layoutCb) layoutCb(layout()); },
  };
}
const inApp = (app, storage, more = {}) => loadApp({
  storage,
  before: w => {
    w.focusOverlay = app.api; w.HTMLElement.prototype.scrollIntoView = function () {};
    w.open = (url, target) => { app.calls.push(`open ${url} ${target}`); return null; };   // (the app sends it to the browser)
    if (more.before) more.before(w);
  },
  transform: more.transform,
});
const CSS = require('fs').readFileSync(path.join(ROOT, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const overlayCss = CSS.slice(CSS.indexOf('.ov { display: none; }'));
/* the declarations a selector has in the overlay's part of style.css (every rule naming it) */
const rule = sel => [...overlayCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(r => r[1].split(',').map(x => x.trim()).includes(sel))
  .map(r => r[2].replace(/\s+/g, ' ').trim()).join(' ');
const press = (w, el, moves, { button = 0 } = {}) => {
  const ev = (type, x, y) => new w.PointerEvent(type, { bubbles: true, cancelable: true, button, pointerId: 1, screenX: x, screenY: y, clientX: 20, clientY: 20 });
  el.dispatchEvent(ev('pointerdown', 1000, 400));
  moves.forEach(([x, y]) => el.dispatchEvent(ev('pointermove', x, y)));
  const [x, y] = moves.length ? moves[moves.length - 1] : [1000, 400];
  el.dispatchEvent(ev('pointerup', x, y));
};

(async () => {
  console.log('\n── 1. Where the window goes (desktop/snap.js) ──');
  {
    const S = require(path.join(ROOT, 'desktop', 'snap.js'));
    const area = { x: 0, y: 25, width: 1440, height: 875 };          // a laptop's screen, below the menu bar
    const btn = (x, y) => ({ x, y, width: 64, height: 64 });
    eq(JSON.stringify(S.snapButton(btn(300, 400), area)), JSON.stringify({ side: 'left', x: 12, y: 400, width: 64, height: 64 }), 'let go left of the middle: against the left side, at that height');
    eq(S.snapButton(btn(900, 400), area).x, 1440 - 64 - 12, 'right of the middle: against the right side');
    eq(S.snapButton(btn(687, 400), area).side, 'left', 'its middle just left of the screen\'s: left');
    eq(S.snapButton(btn(689, 400), area).side, 'right', 'just right: right');
    eq(S.snapButton(btn(900, -200), area).y, 25 + 12, 'let go above the screen: kept on it, under the menu bar');
    eq(S.snapButton(btn(900, 5000), area).y, 25 + 875 - 64 - 12, 'below it: kept on it, above the Dock');
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };       // a screen to the right of the laptop's
    eq(S.snapButton(btn(1500, 300), second).x, 1440 + 12, 'on a second screen: against its own left side');

    const PANEL = { width: 760, height: 540 }, none = { width: 0, height: 0 };
    eq(JSON.stringify(S.around(btn(1300, 200), none, area)), JSON.stringify({ side: 'right', x: 1364, y: 200, width: 64, height: 64, buttonTop: 0 }), 'closed, nothing beside it: the window is the button');
    const open = S.around(btn(1364, 200), PANEL, area);
    ok(open.side === 'right' && open.width === 824 && open.height === 540 && open.x + open.width === 1440 - 12 && open.y === 200 && open.buttonTop === 0,
      `opened against the right side: the panel beside the button, toward the middle, the button where it was (${JSON.stringify(open)})`);
    const b = S.buttonIn(open, open.side, open.buttonTop, 64);
    ok(b.x === 1364 && b.y === 200, 'and the button is at the window\'s right edge, at its top');
    const fromLeft = S.around(btn(12, 200), PANEL, area);
    ok(fromLeft.side === 'left' && fromLeft.x === 12 && S.buttonIn(fromLeft, 'left', fromLeft.buttonTop, 64).x === 12, 'against the left side: the button at the window\'s left, the panel to its right');
    const low = S.around(btn(1364, 800), PANEL, area);
    ok(low.y === 900 - 540 - 12 && low.buttonTop === 800 - low.y && S.buttonIn(low, low.side, low.buttonTop, 64).y === 800,
      `low on the screen: the panel higher, so all of it shows, and the button still where it was (button ${low.buttonTop} px down the window)`);
    const dragged = S.around(S.buttonIn({ x: 200, y: 300, width: 824, height: 540 }, 'right', 0, 64), PANEL, area);
    ok(dragged.side === 'right' && dragged.x === 1440 - 12 - 824, 'the open panel dragged by its button, let go right of the middle: to the right side');
    const across = S.around(S.buttonIn({ x: -100, y: 300, width: 824, height: 540 }, 'right', 0, 64), PANEL, area);
    ok(across.side === 'left' && across.x === 12 && across.y === 300, 'let go with the button left of the middle: the button against the left side, the panel now to its right');
    const clocks = S.around(btn(1364, 200), { width: 84, height: 22 }, area);
    ok(clocks.width === 148 && clocks.height === 64 && clocks.x === 1440 - 12 - 148 && clocks.buttonTop === 0, 'one clock: its room beside the button, the window the button\'s height');
    const three = S.around(btn(1364, 200), { width: 84, height: 74 }, area);
    ok(three.height === 74 && three.buttonTop === 0, 'three: taller than the button, from its top down');
    const small = S.around(btn(0, 0), PANEL, { x: 0, y: 0, width: 600, height: 400 });
    ok(small.width === 576 && small.height === 376, 'a small screen: the panel smaller, so it fits');
  }

  console.log('\n── 2. In a browser, without the app: Focus as it is ──');
  {
    const { d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    ok(!d.getElementById('overlay') && !d.documentElement.classList.contains('overlay-app'), 'no button, no panel');
    ok(d.getElementById('timerStack-d').closest('#desktopApp'), 'the timers where they always are');
  }

  console.log('\n── 3. In the app: a round button, and the panel behind it ──');
  {
    const app = stand();
    const { w, d, errors } = await inApp(app, {});                       // a fresh install: the starter day
    const ov = d.getElementById('overlay');
    ok(d.documentElement.classList.contains('overlay-app') && ov && ov.dataset.state === 'icon', 'it opens as the button');
    ok(ov.querySelector('.ov-icon svg path'), 'with the checkmark on it');
    ok(ov.querySelector('.ov-timers #timerStack-d .timer-card') && ov.querySelector('.ov-main [data-ov-page="home"] #homeContainer-d .home-sec-today'),
      'the panel has the timers on the left, and on the right Focus\'s Home (today\'s tasks first)');
    ok(!ov.querySelector('.ov-head, .ov-brand') && !ov.querySelector('.ov-panel .ov-tabs') && ov.querySelector('.ov > .ov-tabs'), 'no bar along the top; the tabs are outside the panel, by the button');
    eq([...ov.querySelectorAll('.ov-top .ov-label')].map(l => l.textContent).join(), 'timers,home', 'along the top, only the columns\' names');
    ok(ov.querySelector('.ov-top .ov-more') && ov.querySelector('.ov-top .ov-min'), 'and ⋯ and – in the corner');
    ok(/-webkit-app-region: drag/.test(rule('.ov-top')) && /-webkit-app-region: no-drag/.test(rule('.ov-ctl')), 'the panel is dragged by its top (the names), its buttons still pressed');
    ok(!d.querySelector('#tourWelcomeModal.show'), 'no welcome tour (nothing it shows is here)');
    eq(errors.length, 0, 'without an error');

    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    ok(app.calls.includes('expand') && ov.dataset.state === 'panel', 'clicked: the app makes room for the panel beside the button, then the panel shows');
    ok(!/display: none/.test(rule('.ov-icon')) && /display: none/.test(rule('.ov-panel')) && /display: flex/.test(rule('.ov[data-state="panel"] .ov-panel')),
      'the button stays, open or closed (only the panel, its tabs and the clocks come and go)');
    ok(/right: 7px/.test(rule('.ov[data-side="right"] .ov-icon')) && /top: calc\(var\(--ov-btn-top/.test(rule('.ov-icon')), 'where the app has it in the window: against its side, as far down as it says');

    const id = w.eval('timers[0].id');
    ov.querySelector(`.ov-timers .playbtn-${id}`).click();
    ok(w.eval('timers[0].running'), 'a timer starts from the panel');
    ov.querySelector(`.ov-timers .playbtn-${id}`).click();
    const dbd = w.eval('dbdTasks.find(t => t.due === dbdTodayKey() && !t.done)');
    if (dbd) {
      ov.querySelector(`.ov-main .home-sec-today [onclick*="${dbd.id}"]`)?.click();
      ok(w.eval(`dbdTasks.find(t => t.id === ${dbd.id}).done`), 'and a task of today\'s is checked off there');
    }

    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'icon');
    ok(app.calls.slice(-1)[0] === 'collapse' && ov.dataset.state === 'icon', 'the button clicked again: closed, back to the button');
    eq(d.documentElement.dataset.ov, 'icon', 'the page knows (a toast doesn\'t show beside the button)');
    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    ov.querySelector('.ov-min').click();
    await until(() => ov.dataset.state === 'icon');
    ok(app.calls.slice(-1)[0] === 'collapse', 'the – in its corner closes it too');
    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => ov.dataset.state === 'icon');
    eq(ov.dataset.state, 'icon', 'Escape too');
  }

  console.log('\n── 4. Dragging the button ──');
  {
    const app = stand();
    const { w, d } = await inApp(app, { 'focus-tour-done': '1' });
    const icon = d.querySelector('.ov-icon');
    await sleep(20);
    app.calls.length = 0;
    press(w, icon, [[990, 410], [700, 450], [300, 460]]);
    eq(app.calls.join(' | '), 'dragStart | dragMove -10,10 | dragMove -300,50 | dragMove -700,60 | dragEnd',
      'pressed and moved: the window follows by as much as the pointer moved; let go, the app takes it to the nearer side');
    eq(d.getElementById('overlay').dataset.state, 'icon', 'and it stays the button');
    app.calls.length = 0;
    press(w, icon, [[1002, 402]]);
    await until(() => app.calls.includes('expand'));
    ok(!app.calls.some(c => c.startsWith('dragMove')) && app.calls.includes('expand'), 'moved by 3 px or less: a click, not a drag');
    await until(() => d.getElementById('overlay').dataset.state === 'panel');
    app.calls.length = 0;
    press(w, icon, [[960, 380], [700, 300]]);
    eq(app.calls.join(' | '), 'dragStart | dragMove -40,-20 | dragMove -300,-100 | dragEnd', 'open, dragged by the button: the window follows, the panel with it');
    eq(d.getElementById('overlay').dataset.state, 'panel', 'and stays open');
    app.moveTo('left', 40);
    ok(d.getElementById('overlay').dataset.side === 'left' && d.getElementById('overlay').style.getPropertyValue('--ov-btn-top') === '40px',
      'let go on the other side: the app says where the button is now, and the panel is drawn on its other side');
    app.moveTo('right', 0);
    d.querySelector('.ov-min').click();
    await until(() => d.getElementById('overlay').dataset.state === 'icon');
    app.calls.length = 0;
    icon.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    eq(app.calls.join(), 'menu', 'right-click: the app\'s menu (Start at login, Quit)');
    icon.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 0 }));
    await until(() => app.calls.includes('expand'));
    ok(app.calls.includes('expand'), 'Enter or Space on the button opens it too');
  }

  console.log('\n── 5. A dialog, and a window already open as the panel ──');
  {
    const app = stand('panel');
    const { d } = await inApp(app, { 'focus-tour-done': '1' });
    await until(() => d.getElementById('overlay').dataset.state === 'panel');
    eq(d.getElementById('overlay').dataset.state, 'panel', 'the app says the window is the panel (back from sign-in): the panel shows');
    const b = stand();
    const two = await inApp(b, { 'focus-tour-done': '1' });
    two.d.getElementById('confirmOverlay').classList.add('show');
    await until(() => b.calls.includes('expand'));
    ok(b.calls.includes('expand'), 'a dialog opening while it is the button: the panel opens, so the dialog has room');
  }

  console.log('\n── 5b. ⋯: Settings, Formats, Reset the day, the browser, the app ──');
  {
    const app = stand('panel');
    const { w, d, errors } = await inApp(app, { 'focus-tour-done': '1' });
    const ov = d.getElementById('overlay');
    await until(() => ov.dataset.state === 'panel');
    const more = ov.querySelector('.ov-more'), menu = ov.querySelector('.ov-menu');
    const item = what => menu.querySelector(`[data-ov-do="${what}"]`);
    ok(menu.hidden, 'closed to begin with');
    more.click();
    ok(!menu.hidden && more.getAttribute('aria-expanded') === 'true' && d.activeElement === item('settings'), '⋯ opens it, on its first item');
    eq([...menu.querySelectorAll('[role="menuitem"]')].map(b => b.textContent).join(' | '), 'settings | formats | reset the day | open in the browser | more…', 'what is in it');
    item('settings').click();
    ok(menu.hidden && d.getElementById('settingsModal').classList.contains('show'), 'settings: Settings opens (the panel stays)');
    d.getElementById('settingsModal').classList.remove('show');

    more.click();
    item('formats').click();
    ok(d.body.classList.contains('format-mode') && w.eval('formatMode'), 'formats: Formats on');
    ok(ov.querySelector('.ov-timers #addTimerBtn-d') && ov.querySelector('.ov-main [data-ov-page="daily"] #addDailyBtn'), 'its Add timer under the timers, its Add list over the Daily lists (their tab)');
    const n = w.eval('timers.length');
    ov.querySelector('#addTimerBtn-d').click();
    eq(w.eval('timers.length'), n + 1, 'Add timer adds one');
    ok(ov.querySelector('.ov-timers .timer-card:last-child .fmt-remove-timer'), 'and each can be removed');
    ov.querySelector('.ov-fmt[data-ov-do="templates"]').click();
    ok(d.getElementById('fmtTemplateModal').classList.contains('show'), 'templates (in the corner while Formats is on): the template picker');
    d.getElementById('fmtTemplateModal').classList.remove('show');
    ok(/display: inline-flex/.test(rule('body.format-mode .ov-fmt')) && /display: none/.test(rule('.ov-fmt')), 'templates and done show in the corner only while Formats is on');
    ov.querySelector('.ov-fmt[data-ov-do="formats"]').click();
    ok(!d.body.classList.contains('format-mode') && w.eval('timers.length') === n + 1, 'done: Formats off, the new timer kept');

    more.click();
    item('reset').click();
    ok(d.getElementById('confirmOverlay').classList.contains('show'), 'reset the day: asks first, as everywhere');
    d.getElementById('confirmOverlay').classList.remove('show');
    app.calls.length = 0;
    more.click();
    item('browser').click();
    eq(app.calls.join(), `open ${w.location.origin + w.location.pathname} _blank`, 'open in the browser: Focus, whole, in the browser');
    more.click();
    item('app').click();
    ok(app.calls.includes('menu') && menu.hidden, 'more…: the app\'s own menu (Start at login, Quit)');

    more.click();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(menu.hidden && ov.dataset.state === 'panel', 'Escape closes it first, and the panel stays');
    ov.querySelector('.ov-top').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ok(!menu.hidden, 'right-clicking along the top opens it too');
    ov.querySelector('.ov-timers').dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true }));
    ok(menu.hidden, 'pressing anywhere else closes it');
    eq(errors.length, 0, 'without an error');
  }

  console.log('\n── 5c. Plain: the typewriter, colour where it says something ──');
  {
    const app = stand('panel');
    const { w, d } = await inApp(app, { 'focus-tour-done': '1' });
    w.eval(`(() => {
      const dl = todoLists.find(l => l.title === 'Deadlines');
      dl.tasks.push({ id: 9901, text: 'Late essay', done: false, due: addDays(dbdTodayKey(), -1) });
      dbdTasks.push({ id: 9902, text: 'Untagged today', due: dbdTodayKey(), done: false });
      renderTodos(); renderDbd(); renderHome();
    })()`);
    const ov = d.getElementById('overlay');
    const dl = w.eval('todoLists.find(l => l.title === "Deadlines")');
    const late = [...ov.querySelectorAll('.ov-main .home-sec-today .home-dbd-row')].find(r => r.textContent.includes('Late essay'));
    ok(late && late.classList.contains('home-tone-overdue') && late.style.getPropertyValue('--lc') === dl.color, 'a task in a list carries its list\'s colour (--lc) on its row');
    const plain = [...ov.querySelectorAll('.home-sec-today .home-dbd-row')].find(r => r.textContent.includes('Untagged today'));
    ok(plain && !plain.getAttribute('style'), 'one in no list, none');
    ok(/color: var\(--lc, var\(--ink\)\)/.test(rule('.ov .home-dbd-row .home-task-text')) && /display: none/.test(rule('.ov .home-dbd-tag')), 'its text in that colour, instead of the dot beside it');
    ok(/font-weight: 700/.test(rule('.ov .home-tone-overdue .home-task-text')), 'bold when it is overdue');
    ok(/color: var\(--ink-3\)/.test(rule('.ov .home-dbd-date')) && /color: var\(--danger\)/.test(rule('.ov .home-tone-overdue .home-dbd-date')), 'its due date grey, red when overdue');
    ok(/Courier Prime/.test(rule('html.overlay-app')) && /!important/.test(rule('html.overlay-app')) && d.querySelector('link[href*="Courier+Prime"]'), 'a typewriter\'s letters, all through the window (over the theme\'s font)');
    const text = rule('.ov-col .home-task-text').match(/font-size: var\((--[\w-]+)\)/), time = rule('.ov .timer-display').match(/font-size: var\((--[\w-]+)\)/);
    ok(text && time && text[1] === time[1] && /--ov-text: 12px/.test(rule('html.overlay-app')), 'small: the timers\' time the size of a task\'s text (12 px)');
    ok(/display: block/.test(rule('.ov .timer-card')), 'a timer on two lines: its name over its time and buttons');
    ok(/color: var\(--ink-2\)/.test(rule('.ov .timer-title-input')), 'the name in grey (the theme\'s: light on a dark one, dark on a light one)');
    ok(/color: var\(--tc\)/.test(rule('.ov .timer-display')), 'the time in the timer\'s colour');
    ok(/width: 18px; height: 18px/.test(rule('.ov .play-btn')) && !/--tc/.test(rule('.ov .play-btn') + rule('.ov .play-btn.running') + rule('.ov .play-btn:hover')) && /display: none/.test(rule('.ov .timer-progress')),
      'small play and reset buttons, not in its colour, even running; no progress bar');
    ok(/display: none/.test(rule('.ov .todo-accent-strip')) && /color: var\(--lc\)/.test(rule('.ov .todo-title-input')), 'a Daily list: its name in its colour, no stripe');
    ok(/border: 1px solid var\(--line\)/.test(rule('.ov-panel')), 'the panel in the theme\'s outline');
    ok(/display: none/.test(rule('.ov-col .color-swatch')) && /display: block/.test(rule('body.format-mode .ov-col .color-swatch')), 'colour dots only in Formats, where colours are changed');
  }

  console.log('\n── 5d. Tabs: Home when it opens, the others under the button ──');
  {
    const app = stand();
    const { w, d, errors } = await inApp(app, { 'focus-tour-done': '1' });
    const ov = d.getElementById('overlay');
    const page = key => ov.querySelector(`[data-ov-page="${key}"]`);
    const shown = () => [...ov.querySelectorAll('[data-ov-page]')].filter(p => !p.hidden).map(p => p.dataset.ovPage).join();
    eq([...ov.querySelectorAll('.ov-tabs [data-ov-tab]')].filter(b => !b.hidden).map(b => b.dataset.ovTab).join(), 'home,lists,daily,calendar,budget', 'Focus\'s tabs, a round button each (Digest only while it is on)');
    ok([...ov.querySelectorAll('.ov-tab')].every(b => b.querySelector('svg')), 'with the sidebar\'s icons');
    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    ok(ov.dataset.tab === 'home' && shown() === 'home' && ov.querySelector('.ov-label-tab').textContent === 'home', 'opened: Home');
    ok(page('home').querySelector('#homeContainer-d .home-sec-today') && page('lists').querySelector('#listsSection-d #dbdContainer-d') && page('daily').querySelector('#dailySection-d #defaultContainer-d .todo-card')
      && page('calendar').querySelector('#calMobileGrid') && page('budget').querySelector('#budgetContainer-d .budget-wrap'), 'each tab has Focus\'s own page in it');
    ok(page('home').querySelector('.home-sec-daily') && !/display: none/.test(rule('.ov #homeContainer-d > .home-sec-daily')) && /display: none/.test(rule('.ov #homeContainer-d > .home-sec-timers')),
      'Home as it is (its starred Daily lists too), but the timers: they are on the left');
    ov.querySelector('[data-ov-tab="lists"]').click();
    ok(shown() === 'lists' && ov.querySelector('.ov-label-tab').textContent === 'lists' && ov.querySelector('[data-ov-tab="lists"]').getAttribute('aria-selected') === 'true', 'Lists: Day by Day and the lists');
    page('lists').querySelector('#dbdText-d').value = 'Typed in the overlay';
    page('lists').querySelector('#dbdAddBtn-d').click();
    ok(w.eval('dbdTasks.some(t => t.text === "Typed in the overlay")'), 'and a task added there is added');
    ov.querySelector('[data-ov-tab="calendar"]').click();
    ok(shown() === 'calendar' && page('calendar').querySelector('#calMobileGrid .cal-mobile-day-col') && page('calendar').querySelector('#calDayTitle').textContent.length > 0, 'Calendar: the day, drawn as it opens');
    page('calendar').querySelector('#calNavNext').click();
    ok(page('calendar').querySelector('#calDayTitle').textContent.length > 0, 'its arrows go through the days');
    w.homeInsightGo('budget');
    eq(ov.dataset.tab, 'budget', 'a Heads up card\'s button goes to its tab here');
    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'icon');
    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    eq(shown(), 'home', 'closed and opened again: Home');
    eq(errors.length, 0, 'without an error');
  }

  console.log('\n── 5e. Est. finish, and the running timers beside the closed button ──');
  {
    const app = stand();
    const { w, d } = await inApp(app, { 'focus-tour-done': '1' });
    const ov = d.getElementById('overlay');
    const finish = ov.querySelector('.ov-timers .ov-finish-time');
    ok(finish && finish.textContent === w.eval('timerFinishText()') && /^\d{1,2}:\d\d (am|pm)$/.test(finish.textContent), `under the timers: est. finish, all of their time left from now (${finish && finish.textContent})`);
    const kids = [...ov.querySelector('.ov-timers').children].map(el => el.id || el.className);
    ok(kids.indexOf('timerStack-d') < kids.indexOf('ov-finish') && kids.indexOf('ov-finish') < kids.indexOf('ov-switch-row'), 'est. finish under them all, the clocks\' switch under that');
    const sw = ov.querySelector('.ov-switch-input');
    ok(sw && !sw.checked && !sw.disabled && ov.querySelector('.ov-switch-hint').hidden, 'clocks when minimized: off to begin with');
    const [a, b] = w.eval('timers.slice(0, 2).map(t => t.id)');
    w.toggleTimer(a);
    await sleep(20);
    ok(!ov.querySelectorAll('.ov-clock').length && app.calls.filter(c => c.startsWith('clocks')).every(c => c === 'clocks 0x0'), 'off: a timer running shows no clock');
    sw.checked = true; sw.dispatchEvent(new w.Event('change', { bubbles: true }));
    let clocks = [...ov.querySelectorAll('.ov-clock')];
    ok(clocks.length === 1 && clocks[0].querySelector(`.tdisp-${a}`) && clocks[0].style.getPropertyValue('--tc') === w.eval(`timers.find(t => t.id === ${a}).color`), 'on: its time left, in its colour, kept going by the timers\' tick');
    eq(app.calls.slice(-1)[0], 'clocks 84x22', 'and the app is asked for its room beside the button');
    eq(w.localStorage.getItem('focus-overlay-clocks'), '1', 'kept on this device');
    w.toggleTimer(b);
    await sleep(20);
    ok(ov.querySelectorAll('.ov-clock').length === 2 && app.calls.slice(-1)[0] === 'clocks 84x48', 'two running: two clocks, more room');
    ok(/display: flex/.test(rule('.ov[data-state="icon"] .ov-clocks')) && /display: none/.test(rule('.ov-clocks')), 'shown only while the panel is closed');
    w.toggleTimer(a); w.toggleTimer(b);
    await sleep(20);
    ok(!ov.querySelectorAll('.ov-clock').length && app.calls.slice(-1)[0] === 'clocks 0x0', 'none running: no clocks, no room');
    w.toggleTimer(a);
    await sleep(20);
    ov.querySelector('.ov-clock').click();
    await until(() => ov.dataset.state === 'panel');
    eq(ov.dataset.state, 'panel', 'a clock clicked opens the panel');
    w.toggleTimer(a);

    const old = await inApp(stand('icon', { old: true }), { 'focus-tour-done': '1', 'focus-overlay-clocks': '1' });
    const osw = old.d.querySelector('.ov-switch-input');
    old.w.toggleTimer(old.w.eval('timers[0].id'));
    await sleep(20);
    ok(osw.disabled && !old.d.querySelector('.ov-switch-hint').hidden && !old.d.querySelectorAll('.ov-clock').length, 'an app from before this can\'t make room for them: the switch says to download the new one');
  }

  console.log('\n── 6. Signing in, through the browser ──');
  {
    const { install, cloud } = createFakeFirebase();
    /* the laptop's browser has the account's day */
    let dev = null;
    const laptop = await loadApp({ storage: { 'focus-tour-done': '1' }, before: w => { dev = install(w); w.HTMLElement.prototype.scrollIntoView = function () {}; } });
    laptop.w.eval('dbdTasks.push({ id: 900, text: "From the laptop", due: dbdTodayKey(), done: false }); dbdIdCounter = 901; saveToLocal();');
    dev.signIn();
    await until(() => cloud.val && typeof cloud.val.state === 'string' && cloud.val.state.includes('From the laptop'), 3000);
    ok(cloud.val && cloud.val.state.includes('From the laptop'), '(the account has a day in the cloud)');

    const app = stand();
    let mine = null;
    const { w, d } = await inApp(app, {}, { before: win => { mine = install(win); } });
    const ov = d.getElementById('overlay');
    const signIn = ov.querySelector('.ov-signin');
    mine.signOut();                                                       // (Firebase says so as it starts: nobody signed in)
    ok(await until(() => !signIn.hidden), 'nobody signed in: the panel offers to');
    signIn.click();
    const asked = app.calls.find(c => c.startsWith('signIn '));
    const url = asked && new URL(asked.slice(7));
    ok(url && url.origin === 'https://accounts.google.com' && url.searchParams.get('state') === 'worky-sync-app' && url.searchParams.get('redirect_uri') === 'https://homiejhan.github.io/worky/',
      'Sign in to sync: Google\'s sign-in, opened in the browser by the app, coming back to Focus there');
    app.hand('token-from-the-browser');
    await until(() => mine.user && w.eval('dbdTasks.some(t => t.text === "From the laptop")'), 3000);
    ok(mine.credentials.length === 1 && mine.credentials[0].accessToken === 'token-from-the-browser', 'the token the browser handed back signs the app in');
    ok(w.eval('dbdTasks.some(t => t.text === "From the laptop")'), 'and the app takes the account\'s day');
    ok(!d.querySelector('#syncChoiceModal.show'), 'without asking whether to send its own instead (its starter day)');
    ok(cloud.val.state.includes('From the laptop'), 'so the cloud keeps the account\'s day');
    await until(() => signIn.hidden);
    ok(signIn.hidden, 'and the panel no longer offers to sign in');

    /* Settings → Cloud sync → Sign in, in the app: through the browser too, never in its own window */
    const app2 = stand('panel');
    let other = null;
    const two = await inApp(app2, { 'focus-tour-done': '1' }, { before: win => { other = install(win); } });
    other.signOut();
    await sleep(50);
    two.w.openSettings('sync');
    two.d.getElementById('syncConnectBtn').click();
    const via = app2.calls.find(c => c.startsWith('signIn '));
    ok(via && new URL(via.slice(7)).searchParams.get('state') === 'worky-sync-app' && /\/worky\/$/.test(two.w.location.href.split('#')[0]),
      'Settings → Cloud sync → Sign in: the same, through the browser (the window stays on Focus)');

    /* the browser, where Google sends the sign-in back */
    const hook = 'function syncHandToApp(url) { window.location.href = url; }';
    let browserDev = null;
    const browser = await loadApp({
      url: 'https://localhost/worky/#access_token=abc%2B123&token_type=Bearer&state=worky-sync-app',
      storage: { 'focus-tour-done': '1' },
      before: win => { browserDev = install(win); },
      transform: (src, file) => {
        if (file !== 'js/sync.js') return src;
        if (!src.includes(hook)) throw new Error('js/sync.js changed: update the hand-over hook');
        return src.replace(hook, 'function syncHandToApp(url) { window.__handed = url; }');
      },
    });
    await sleep(50);
    eq(browser.w.__handed, 'focus-overlay://signin#access_token=abc%2B123', 'the browser\'s Focus hands the token to the app');
    ok(!browserDev.credentials.length && browser.w.location.hash === '', 'and signs nothing in there itself, nor keeps the token in its address');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
