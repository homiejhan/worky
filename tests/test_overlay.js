/* Focus Overlay, the desktop app (desktop/): where its window goes (desktop/snap.js),
 * and the page in it (js/overlay.js) — the round button, dragged or clicked, the
 * panel with the timers and today's tasks, minimized back, and signing in through
 * the browser. The app's window itself is played in tests/e2e_overlay.js
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

/* the desktop app, as the page sees it (desktop/preload.js) */
function stand(startState = 'icon') {
  let state = startState, tokenCb = null;
  const calls = [];
  return {
    calls, hand: t => tokenCb && tokenCb(t),
    api: {
      state: () => Promise.resolve(state),
      expand: () => { calls.push('expand'); state = 'panel'; return Promise.resolve(state); },
      collapse: () => { calls.push('collapse'); state = 'icon'; return Promise.resolve(state); },
      dragStart: () => calls.push('dragStart'),
      dragMove: (dx, dy) => calls.push(`dragMove ${dx},${dy}`),
      dragEnd: () => calls.push('dragEnd'),
      menu: () => calls.push('menu'),
      signIn: url => calls.push(`signIn ${url}`),
      onSignIn: cb => { tokenCb = cb; },
    },
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
    const panel = S.panelFrom(S.snapButton(btn(1300, 700), area), { width: 760, height: 540 }, area);
    ok(panel.x === 1440 - 760 - 12 && panel.y === 900 - 540 - 12, `the panel opens against the button's side, all of it on the screen (${panel.x}, ${panel.y})`);
    const leftPanel = S.panelFrom(S.snapButton(btn(10, 200), area), { width: 760, height: 540 }, area);
    ok(leftPanel.x === 12 && leftPanel.y === 200, 'from the left side: against the left, its top at the button\'s');
    const small = S.panelFrom(btn(0, 0), { width: 760, height: 540 }, { x: 0, y: 0, width: 600, height: 400 });
    ok(small.width === 576 && small.height === 376, 'a small screen: smaller, so it fits');
    const back = S.buttonFrom({ x: 300, y: 120, width: 760, height: 540 }, 64, area);
    ok(back.side === 'left' && back.x === 12 && back.y === 120, 'minimized after the panel was moved: the button goes to the side nearer the panel');
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
    ok(ov.querySelector('.ov-timers #timerStack-d .timer-card') && ov.querySelector('.ov-tasks #homeContainer-d .home-sec-today') && ov.querySelector('.ov-tasks #defaultContainer-d .todo-card'),
      'the panel has the timers on the left; today\'s tasks and the Daily lists on the right');
    const right = [...ov.querySelector('.ov-tasks').children].map(el => el.id || el.className);
    ok(right.indexOf('homeContainer-d') < right.indexOf('ov-label ov-label-daily') && right.indexOf('ov-label ov-label-daily') < right.indexOf('defaultContainer-d'),
      `both at once, no tabs: today's tasks, then "daily" and the Daily lists (${right.join(' · ')})`);
    ok(!ov.querySelector('.ov-head, .ov-tabs, [data-ov-tab], .ov-brand'), 'no bar along the top: no name, no tabs');
    eq([...ov.querySelectorAll('.ov-top .ov-label')].map(l => l.textContent).join(), 'timers,today', 'only the columns\' names there');
    ok(ov.querySelector('.ov-top .ov-more') && ov.querySelector('.ov-top .ov-min'), 'and ⋯ and – in the corner');
    ok(/-webkit-app-region: drag/.test(rule('.ov-top')) && /-webkit-app-region: no-drag/.test(rule('.ov-ctl')), 'the panel is dragged by its top (the names), its buttons still pressed');
    ok(!d.querySelector('#tourWelcomeModal.show'), 'no welcome tour (nothing it shows is here)');
    eq(errors.length, 0, 'without an error');

    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    ok(app.calls.includes('expand') && ov.dataset.state === 'panel', 'clicked: the app makes the window the panel\'s size, then the panel shows');

    const id = w.eval('timers[0].id');
    ov.querySelector(`.ov-timers .playbtn-${id}`).click();
    ok(w.eval('timers[0].running'), 'a timer starts from the panel');
    ov.querySelector(`.ov-timers .playbtn-${id}`).click();
    const dbd = w.eval('dbdTasks.find(t => t.due === dbdTodayKey() && !t.done)');
    if (dbd) {
      ov.querySelector(`.ov-tasks .home-sec-today [onclick*="${dbd.id}"]`)?.click();
      ok(w.eval(`dbdTasks.find(t => t.id === ${dbd.id}).done`), 'and a task of today\'s is checked off there');
    }

    ov.querySelector('.ov-min').click();
    await until(() => ov.dataset.state === 'icon');
    ok(app.calls.slice(-1)[0] === 'collapse' && ov.dataset.state === 'icon', 'minimize: back to the button');
    eq(d.documentElement.dataset.ov, 'icon', 'the page knows (a toast doesn\'t show beside the button)');
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
    press(w, icon, [[990, 410], [700, 450], [300, 460]]);
    eq(app.calls.join(' | '), 'dragStart | dragMove -10,10 | dragMove -300,50 | dragMove -700,60 | dragEnd',
      'pressed and moved: the window follows by as much as the pointer moved; let go, the app takes it to the nearer side');
    eq(d.getElementById('overlay').dataset.state, 'icon', 'and it stays the button');
    app.calls.length = 0;
    press(w, icon, [[1002, 402]]);
    await until(() => app.calls.includes('expand'));
    ok(!app.calls.some(c => c.startsWith('dragMove')) && app.calls.includes('expand'), 'moved by 3 px or less: a click, not a drag');
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
    ok(ov.querySelector('.ov-timers #addTimerBtn-d') && ov.querySelector('.ov-tasks #addDailyBtn'), 'its Add timer under the timers, its Add list over the Daily lists');
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
    const late = [...ov.querySelectorAll('.home-sec-today .home-dbd-row')].find(r => r.textContent.includes('Late essay'));
    ok(late && late.classList.contains('home-tone-overdue') && late.style.getPropertyValue('--lc') === dl.color, 'a task in a list carries its list\'s colour (--lc) on its row');
    const plain = [...ov.querySelectorAll('.home-sec-today .home-dbd-row')].find(r => r.textContent.includes('Untagged today'));
    ok(plain && !plain.getAttribute('style'), 'one in no list, none');
    ok(/color: var\(--lc, var\(--ink\)\)/.test(rule('.ov .home-task-text')) && /display: none/.test(rule('.ov .home-dbd-tag')), 'its text in that colour, instead of the dot beside it');
    ok(/font-weight: 700/.test(rule('.ov .home-tone-overdue .home-task-text')), 'bold when it is overdue');
    ok(/color: var\(--ink-3\)/.test(rule('.ov .home-dbd-date')) && /color: var\(--danger\)/.test(rule('.ov .home-tone-overdue .home-dbd-date')), 'its due date grey, red when overdue');
    ok(/Courier Prime/.test(rule('html.overlay-app')) && /!important/.test(rule('html.overlay-app')) && d.querySelector('link[href*="Courier+Prime"]'), 'a typewriter\'s letters, all through the window (over the theme\'s font)');
    const text = rule('.ov .home-task-text').match(/font-size: var\((--[\w-]+)\)/), time = rule('.ov .timer-display').match(/font-size: var\((--[\w-]+)\)/);
    ok(text && time && text[1] === time[1] && /--ov-text: 12px/.test(rule('html.overlay-app')), 'small: the timers\' time the size of a task\'s text (12 px)');
    ok(/color: var\(--tc\)/.test(rule('.ov .timer-title-input')) && /color: var\(--tc\)/.test(rule('.ov .timer-display')), 'a timer\'s name and time in its colour');
    ok(/width: 18px; height: 18px/.test(rule('.ov .play-btn')) && /display: none/.test(rule('.ov .timer-progress')), 'small play and reset buttons, no progress bar');
    ok(/display: none/.test(rule('.ov .todo-accent-strip')) && /color: var\(--lc\)/.test(rule('.ov .todo-title-input')), 'a Daily list: its name in its colour, no stripe');
    ok(/border: 1px solid var\(--line\)/.test(rule('.ov-panel')), 'the panel in the theme\'s outline');
    ok(/display: none/.test(rule('.ov-col .color-swatch')) && /display: block/.test(rule('body.format-mode .ov-col .color-swatch')), 'colour dots only in Formats, where colours are changed');
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
