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
  before: w => { w.focusOverlay = app.api; w.HTMLElement.prototype.scrollIntoView = function () {}; if (more.before) more.before(w); },
  transform: more.transform,
});
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
    ok(!d.querySelector('#tourWelcomeModal.show'), 'no welcome tour (nothing it shows is here)');
    eq(errors.length, 0, 'without an error');

    press(w, ov.querySelector('.ov-icon'), []);
    await until(() => ov.dataset.state === 'panel');
    ok(app.calls.includes('expand') && ov.dataset.state === 'panel', 'clicked: the app makes the window the panel\'s size, then the panel shows');
    eq(ov.dataset.tab, 'today', 'Today on the right to begin with');
    ov.querySelector('[data-ov-tab="daily"]').click();
    ok(ov.dataset.tab === 'daily' && w.localStorage.getItem('focus-overlay-tab') === 'daily', 'Daily: the Daily lists instead (kept on this device)');
    ov.querySelector('[data-ov-tab="today"]').click();

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
