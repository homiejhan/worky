/* Focus Overlay, played for real: the desktop app (desktop/, Electron) showing
 * Focus from this checkout, on a screen, driven with the mouse like a person
 * would: the button where it starts, dragged across and let go (it glides to the
 * nearer side), clicked open (the panel beside it, the button staying, with the
 * timers and Focus's tabs), dragged open across the screen (the panel going with
 * it, then to the button's other side), clicked closed, the running timers'
 * clocks beside it, its place kept for the next start, a sign-in handed back by
 * the browser, and a link that leaves Focus going to the browser.
 * Not part of npm test: it needs desktop/'s packages (cd desktop && npm install)
 * and a screen (on Linux, a virtual one: xvfb-run).
 * Run: npm run overlay:e2e   (screenshots in tests/e2e_overlay-*.png are not kept) */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const { _electron: electron } = require(path.join(DESKTOP, 'node_modules', 'playwright-core'));
const ELECTRON = require(path.join(DESKTOP, 'node_modules', 'electron'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(40); }
  return fn();
}

/* this checkout, as GitHub Pages serves it (under /worky/) */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/worky/, '');
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const FOCUS_URL = `http://127.0.0.1:${server.address().port}/worky/`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-overlay-'));
  const env = { ...process.env, FOCUS_URL, FOCUS_OVERLAY_DATA: DATA };
  delete env.NODE_OPTIONS;
  const launch = () => electron.launch({ executablePath: ELECTRON, args: [DESKTOP, '--no-sandbox'], env });
  const win = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const shot = (page, name) => page.screenshot({ path: path.join(__dirname, `e2e_overlay-${name}.png`) }).catch(() => {});

  /* the mouse, at a point of the screen: the page is told where that is in its window, which moves */
  async function mouseTo(app, page, x, y) {
    const b = await win(app);
    await page.mouse.move(Math.round(x - b.x), Math.round(y - b.y));
  }
  /* pressed at `from`, moved through each point of `to` (one, or a list), let go */
  async function drag(app, page, from, to, steps = 14) {
    const start = await win(app);
    await mouseTo(app, page, from.x, from.y);
    await page.mouse.down();
    let at = from;
    for (const next of [].concat(to)) {
      for (let i = 1; i <= steps; i++) {
        const x = at.x + (next.x - at.x) * i / steps, y = at.y + (next.y - at.y) * i / steps;
        await mouseTo(app, page, x, y);
        /* the window follows a moment later: the next point is reckoned from where it is then */
        await until(async () => { const n = await win(app); return Math.abs(n.x - (start.x + x - from.x)) <= 2 && Math.abs(n.y - (start.y + y - from.y)) <= 2; }, 600);
      }
      at = next;
    }
    await page.mouse.up();
  }
  const middle = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

  console.log('\n── 1. The button, where it starts ──');
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForSelector('#overlay[data-state="icon"]', { timeout: 15000 });
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  let b = await win(app);
  ok(b.width === 64 && b.height === 64 && b.x === area.x + area.width - 64 - 12, `a 64 px button against the right side (${JSON.stringify(b)} on ${area.width}×${area.height})`);
  const top = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { onTop: w.isAlwaysOnTop(), resizable: w.isResizable() }; });
  ok(top.onTop && !top.resizable, 'above the other windows, and not resized by hand');
  ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && !!document.querySelector('.ov-icon svg')), 'see-through around the round, with the checkmark on it');
  await shot(page, 'button');

  console.log('\n── 2. Dragged across and let go ──');
  b = await win(app);
  const grab = middle(b);
  await drag(app, page, grab, { x: area.x + area.width * 0.3, y: area.y + area.height * 0.25 });
  ok(await until(async () => (await win(app)).x === area.x + 12), `let go left of the middle: it glides against the left side (x ${(await win(app)).x})`);
  b = await win(app);
  ok(Math.abs(b.y - (area.y + area.height * 0.25 - 32)) <= 2, `at the height it was let go (y ${b.y})`);
  await drag(app, page, middle(b), { x: area.x + area.width * 0.7, y: area.y + area.height * 2 });
  ok(await until(async () => { const n = await win(app); return n.x === area.x + area.width - 64 - 12 && n.y === area.y + area.height - 64 - 12; }),
    'let go right of the middle, below the screen: against the right side, kept on the screen');
  /* (round the middle of the screen: on a virtual one (xvfb) the real pointer rests there, and the
   * window passing under it ends the drag, which no person's pointer would) */
  await drag(app, page, middle(await win(app)), [{ x: area.x + 150, y: area.y + area.height - 60 }, { x: area.x + 150, y: area.y + 200 }]);
  await until(async () => (await win(app)).x === area.x + 12);

  console.log('\n── 3. Clicked: the panel ──');
  b = await win(app);
  await mouseTo(app, page, b.x + 32, b.y + 32);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForSelector('#overlay[data-state="panel"]', { timeout: 4000 });
  const p = await win(app);
  ok(p.width === 824 && p.height === 540 && p.x === area.x + 12 && p.y === b.y, `the window opens against the left side, its top at the button's, with room for the panel (${JSON.stringify(p)}, the button ${JSON.stringify(b)})`);
  /* where on the screen a thing in the window is (its place, not as a hover's zoom draws it) */
  const onScreen = async sel => { const w = await win(app); const r = await page.evaluate(q => { const e = document.querySelector(q); return { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }; }, sel); return { x: w.x + r.x, y: w.y + r.y, w: r.w, h: r.h }; };
  const kept = await onScreen('.ov-icon');
  ok(kept.w === 50 && kept.x === b.x + 7 && kept.y === b.y + 7, `the button stays, where it was (${JSON.stringify(kept)})`);
  const panelBox = await onScreen('.ov-panel');
  ok(panelBox.x >= kept.x + kept.w && panelBox.y === p.y + 8, 'the panel beside it, toward the middle of the screen');
  const cols = await page.evaluate(() => {
    const box = el => el && el.getBoundingClientRect();
    const t = box(document.querySelector('.ov-timers .timer-card')), d = box(document.querySelector('.ov-main .home-sec-today'));
    return { timers: document.querySelectorAll('.ov-timers .timer-card').length, t: t && { x: t.x, w: t.width }, d: d && { x: d.x, w: d.width }, W: innerWidth };
  });
  ok(cols.timers >= 1 && cols.t && cols.d && cols.t.x < cols.d.x && cols.d.x + cols.d.w <= cols.W, `the timers on the left (${cols.timers}), Home's today's tasks on the right, inside the window`);
  await shot(page, 'panel');
  const id = await page.evaluate(() => document.querySelector('.ov-timers .timer-card').dataset.timerId);
  await page.click(`.ov-timers .playbtn-${id}`);
  ok(await until(() => page.evaluate(i => !!document.querySelector(`.ov-timers .tcard-${i}.running`), id)), 'a timer started from it runs');
  await page.click(`.ov-timers .playbtn-${id}`);
  const tabs = await page.evaluate(() => {
    const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const t = [...document.querySelectorAll('.ov-tab')].filter(shown);
    const icon = document.querySelector('.ov-icon').getBoundingClientRect(), first = t[0] && t[0].getBoundingClientRect();
    return { keys: t.map(b => b.dataset.ovTab).join(), under: !!first && first.top >= icon.bottom && Math.abs(first.left + first.width / 2 - (icon.left + icon.width / 2)) <= 1,
      home: shown(document.querySelector('[data-ov-page="home"]')) && !shown(document.querySelector('[data-ov-page="daily"]')) };
  });
  ok(tabs.keys === 'home,lists,daily,calendar,budget' && tabs.under, `the tabs, small round buttons under the button (${tabs.keys})`);
  ok(tabs.home, 'Home to begin with');
  await page.click('.ov-tab[data-ov-tab="daily"]');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('[data-ov-page="daily"] #defaultContainer-d')).display !== 'none' && document.querySelector('[data-ov-page="home"]').hidden),
    'Daily: the Daily lists');
  await shot(page, 'tab-daily');
  await page.click('.ov-tab[data-ov-tab="calendar"]');
  ok(await page.evaluate(() => !!document.querySelector('[data-ov-page="calendar"] #calMobileGrid .cal-mobile-day-col') && document.querySelector('[data-ov-page="calendar"] #calMobileGrid').getBoundingClientRect().height > 100),
    'Calendar: the day, its hours scrolling');
  await shot(page, 'tab-calendar');
  await page.click('.ov-tab[data-ov-tab="lists"]');
  await shot(page, 'tab-lists');
  await page.click('.ov-tab[data-ov-tab="budget"]');
  await shot(page, 'tab-budget');
  await page.click('.ov-tab[data-ov-tab="home"]');

  /* plain, in the theme: a late task in a list and one in none (put in the day Focus keeps, and Focus opened again) */
  const listColor = await page.evaluate(() => {
    const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const st = JSON.parse(localStorage.getItem('focus-app-state'));
    const dl = st.todoLists.find(l => l.title === 'Deadlines');
    dl.tasks.push({ id: 9901, text: 'Late essay', done: false, due: key(yesterday) });
    st.dbdTasks.push({ id: 9902, text: 'Untagged today', due: key(new Date()), done: false });
    st.taskIdCounter = Math.max(st.taskIdCounter, 9902); st.dbdIdCounter = Math.max(st.dbdIdCounter, 9903);
    localStorage.setItem('focus-app-state', JSON.stringify(st));
    return dl.color;
  });
  await page.reload();
  await page.waitForSelector('#overlay[data-state="panel"] .home-dbd-row', { timeout: 15000 });
  const look = await page.evaluate(lc => {
    const css = el => el && getComputedStyle(el);
    const row = t => [...document.querySelectorAll('.ov-main .home-dbd-row')].find(r => r.textContent.includes(t));
    const rgb = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    const late = row('Late essay'), plain = row('Untagged today'), upcoming = document.querySelector('.ov-main .home-tone-future');
    const dl = { color: lc };
    const timer = document.querySelector('.ov-timers .timer-card');
    const t0 = timer && { color: timer.style.getPropertyValue('--tc').trim() };
    const panel = css(document.querySelector('.ov-panel'));
    return {
      font: css(document.querySelector('.ov-main .home-task-text')).fontFamily,
      menuFont: css(document.querySelector('.ov-menu button')).fontFamily,
      late: late && { color: css(late.querySelector('.home-task-text')).color, weight: css(late.querySelector('.home-task-text')).fontWeight, date: css(late.querySelector('.home-dbd-date')).color, dot: css(late.querySelector('.home-dbd-tag')).display, list: dl && rgb(dl.color),
        box: css(late.querySelector('.home-dbd-check')).borderTopColor },
      plain: plain && { color: css(plain.querySelector('.home-task-text')).color, ink: css(document.querySelector('.ov-panel')).color, box: css(plain.querySelector('.home-dbd-check')).borderTopColor },
      lines: (() => {
        const rows = [...document.querySelectorAll('.ov-main .home-sec-today .home-card > *')];
        const track = css(document.querySelector('.ov-main .home-progress-track'));
        const firsts = rows.filter((r, i) => i && r.className.match(/home-tone-\w+/)?.[0] !== rows[i - 1].className.match(/home-tone-\w+/)?.[0]);
        return { n: firsts.length, same: firsts.every(r => css(r).borderTopWidth === '1px' && css(r).borderTopColor === track.backgroundColor && track.height === '1px'),
          inside: rows.filter((r, i) => i && !firsts.includes(r)).every(r => css(r).borderTopWidth === '0px') };
      })(),
      upcoming: upcoming && css(upcoming.querySelector('.home-dbd-date')).color,
      grey: css(document.querySelector('.ov-label')).color,
      danger: rgb(getComputedStyle(document.documentElement).getPropertyValue('--danger').trim()),
      timer: timer && { title: css(timer.querySelector('.timer-title-input')).color, time: css(timer.querySelector('.timer-display')).color, timeSize: css(timer.querySelector('.timer-display')).fontSize,
        textSize: css(document.querySelector('.ov-main .home-task-text')).fontSize, play: timer.querySelector('.play-btn').getBoundingClientRect().width, own: t0 && rgb(t0.color),
        grey: rgb(getComputedStyle(document.documentElement).getPropertyValue('--ink-2').trim()), button: css(timer.querySelector('.play-btn')).color,
        lines: Math.round(timer.querySelector('.timer-display').getBoundingClientRect().top - timer.querySelector('.timer-title-input').getBoundingClientRect().top) },
      panel: { border: panel.borderTopColor, line: getComputedStyle(document.documentElement).getPropertyValue('--line').trim() },
    };
  }, listColor);
  ok(/Courier/.test(look.font) && /Courier/.test(look.menuFont), `a typewriter's letters (${look.font.split(',')[0]})`);
  ok(look.late && look.late.color === look.plain.ink && look.late.dot === 'none', `a task in a list: its text white, as in no list (${look.late && look.late.color}), no dot`);
  ok(look.late && /236, 54, 54|0\.92\d* 0\.21\d* 0\.21/.test(look.late.box) && look.late.box !== look.plain.box, `its checkbox in the list's colour (${look.late && look.late.box})`);
  ok(look.lines.n === 2 && look.lines.same && look.lines.inside, `a grey line, as under the progress, between the overdue ones, today's and the coming ones, and none within them (${JSON.stringify(look.lines)})`);
  ok(look.late && Number(look.late.weight) >= 700, 'bold when it is overdue');
  ok(look.late && look.late.date === look.danger, `its due date red when overdue (${look.late && look.late.date})`);
  ok(look.upcoming === look.grey, `an upcoming one's date grey (${look.upcoming})`);
  ok(look.plain && look.plain.color === look.plain.ink, 'one in no list: the text colour');
  ok(look.timer && look.timer.lines >= 12, `a timer on two lines: its time under its name (${look.timer && look.timer.lines} px lower)`);
  ok(look.timer && look.timer.title === look.timer.grey && look.timer.time === look.timer.own, `its name in grey (${look.timer && look.timer.title}), its time in its colour (${look.timer && look.timer.own})`);
  ok(look.timer && look.timer.button === look.timer.grey, 'its buttons not in its colour');
  ok(look.timer && look.timer.timeSize === look.timer.textSize && parseFloat(look.timer.textSize) <= 12, `its time as small as a task's text (${look.timer && look.timer.timeSize})`);
  ok(look.timer && look.timer.play <= 18, `small play and reset buttons (${look.timer && look.timer.play} px)`);
  ok(look.panel.border === 'rgb(255, 255, 255)' && look.panel.line === '#ffffff', 'Black: the panel in a white outline');
  await shot(page, 'panel-black');

  /* ⋯ → settings, in the window: the themes, chosen there */
  await page.click('.ov-more');
  await shot(page, 'menu');
  await page.click('.ov-menu [data-ov-do="settings"]');
  ok(await until(() => page.evaluate(() => document.getElementById('settingsModal').classList.contains('show'))), '⋯ → settings: Settings opens in the window');
  await shot(page, 'settings');
  await page.evaluate(() => document.querySelector('[data-settings-nav="appearance"]')?.click());
  await sleep(150);
  await shot(page, 'settings-appearance');
  ok(await page.evaluate(() => [...document.querySelectorAll('#themePresets-s .theme-chip')].map(c => c.textContent.trim()).join() === 'Black,Dark grey,Grey,Light grey,White'),
    'with the five themes to choose from');
  const borders = {};
  for (const id of ['darkgrey', 'grey', 'lightgrey', 'white', 'black']) {
    if (!(await page.evaluate(() => document.getElementById('settingsModal').classList.contains('show')))) {
      await page.click('.ov-more');
      await page.click('.ov-menu [data-ov-do="settings"]');
      await page.evaluate(() => document.querySelector('[data-settings-nav="appearance"]')?.click());
    }
    await page.click(`#themePresets-s [data-preset="${id}"]`);
    await page.click('#settingsModal [data-close="settingsModal"]');
    await sleep(200);
    borders[id] = await page.evaluate(() => getComputedStyle(document.querySelector('.ov-panel')).borderTopColor + ' on ' + getComputedStyle(document.querySelector('.ov-panel')).backgroundColor);
    if (id !== 'black') await shot(page, `panel-${id}`);
  }
  ok(borders.darkgrey === 'rgb(140, 140, 140) on rgb(42, 42, 42)' && borders.grey === 'rgb(230, 230, 230) on rgb(107, 107, 107)' && borders.lightgrey === 'rgb(77, 77, 77) on rgb(217, 217, 217)' && borders.white === 'rgb(0, 0, 0) on rgb(255, 255, 255)',
    `and each its background and outline (${JSON.stringify(borders)})`);

  /* ⋯ → formats: the timers and Daily lists to change, in the window, and done */
  await page.click('.ov-more');
  await page.click('.ov-menu [data-ov-do="formats"]');
  const fmt = await page.evaluate(() => {
    const seen = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    return { add: seen(document.querySelector('.ov-timers #addTimerBtn-d')), list: seen(document.querySelector('.ov-tasks #addDailyBtn')),
      dot: seen(document.querySelector('.ov-timers .color-swatch')), done: seen(document.querySelector('.ov-fmt[data-ov-do="formats"]')),
      timers: document.querySelectorAll('.ov-timers .timer-card').length };
  });
  ok(fmt.add && fmt.dot && fmt.done, `formats: Add timer, the colour dots and done all there (${JSON.stringify(fmt)})`);
  await page.click('.ov-tab[data-ov-tab="daily"]');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.ov-main #addDailyBtn')).display !== 'none'), 'and Add list, on the Daily tab');
  await page.click('.ov-tab[data-ov-tab="home"]');
  await page.click('.ov-timers #addTimerBtn-d');
  ok(await until(() => page.evaluate(n => document.querySelectorAll('.ov-timers .timer-card').length === n + 1, fmt.timers)), 'Add timer adds one');
  await shot(page, 'formats');
  await page.click('.ov-fmt[data-ov-do="formats"]');
  ok(await until(() => page.evaluate(() => !document.body.classList.contains('format-mode') && getComputedStyle(document.querySelector('.ov-timers .color-swatch')).display === 'none')),
    'done: back to the plain panel, the new timer kept');

  console.log('\n── 4. Dragged open, closed by the button, its clocks, and its place kept ──');
  /* the open panel dragged by its button to the right half: it goes along, and ends on the button's other
   * side (down, then across below the middle of the screen: see the drag before) */
  b = await win(app);
  const grip = await onScreen('.ov-icon');
  const low = area.y + area.height - 560;
  await drag(app, page, { x: grip.x + 25, y: grip.y + 25 }, [{ x: grip.x + 25, y: low }, { x: area.x + area.width * 0.8, y: low }]);
  ok(await until(async () => { const n = await win(app); return n.width === 824 && n.x === area.x + area.width - 824 - 12; }), `let go right of the middle: the window, the panel and all, against the right side (${JSON.stringify(await win(app))})`);
  const flipped = await onScreen('.ov-icon'), flippedPanel = await onScreen('.ov-panel');
  ok(flipped.x + flipped.w === area.x + area.width - 12 - 7 && flippedPanel.x + flippedPanel.w <= flipped.x && await page.evaluate(() => document.getElementById('overlay').dataset.state === 'panel'),
    'the button against the side, the panel now on its left, still open');
  await shot(page, 'panel-right');
  await page.click('.ov-icon');
  await page.waitForSelector('#overlay[data-state="icon"]');
  b = await win(app);
  ok(b.width === 64 && b.x === area.x + area.width - 64 - 12 && b.y === flipped.y - 7, `the button clicked: closed, the button where it was (${JSON.stringify(b)})`);
  /* clocks when minimized: a running timer's time left beside the button */
  await page.click('.ov-icon');
  await page.waitForSelector('#overlay[data-state="panel"]');
  await page.click('.ov-switch-row');
  await page.click(`.ov-timers .playbtn-${id}`);
  await page.click('.ov-icon');
  await page.waitForSelector('#overlay[data-state="icon"]');
  ok(await until(async () => (await win(app)).width === 148), `switched on, a timer running, closed: room for its clock beside the button (${JSON.stringify(await win(app))})`);
  const clock = await page.evaluate(() => { const c = document.querySelector('.ov-clock'); return c && { text: c.textContent.trim(), color: getComputedStyle(c).color, shown: getComputedStyle(c).display !== 'none', x: c.getBoundingClientRect().right, icon: document.querySelector('.ov-icon').getBoundingClientRect().left }; });
  ok(clock && clock.shown && /^\d+:\d\d:\d\d$/.test(clock.text) && clock.x <= clock.icon, `its time left, left of the button (${clock && clock.text})`);
  ok(await until(() => page.evaluate(t => document.querySelector('.ov-clock').textContent.trim() !== t, clock && clock.text), 3500), 'counting down');
  await shot(page, 'clocks');
  /* (toggleTimer is the play button's own: the page's, as on a phone that synced, or a timer running out) */
  await page.evaluate(i => toggleTimer(Number(i)), id);
  ok(await until(async () => (await win(app)).width === 64 && await page.evaluate(() => document.getElementById('overlay').dataset.state === 'icon')),
    'it stops while the panel is closed: the clock goes, the panel stays closed');
  await page.evaluate(i => toggleTimer(Number(i)), id);
  ok(await until(async () => (await win(app)).width === 148), 'and starts: the clock is back');
  await page.click('.ov-clock');
  await page.waitForSelector('#overlay[data-state="panel"]');
  await page.click(`.ov-timers .playbtn-${id}`);
  await page.click('.ov-icon');
  await page.waitForSelector('#overlay[data-state="icon"]');
  ok(await until(async () => (await win(app)).width === 64), 'the timer paused: no clock, the button alone');
  b = await win(app);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector('#overlay[data-state="icon"]', { timeout: 15000 });
  const again = await win(app);
  ok(again.x === b.x && again.y === b.y && again.width === 64, `opened again: the button where it was left (${JSON.stringify(again)})`);

  console.log('\n── 5. Signed in by the browser; links out go to the browser ──');
  await page.evaluate(() => { window.__tokens = []; window.focusOverlay.onSignIn(t => window.__tokens.push(t)); });
  await app.evaluate(({ app: a }) => a.emit('open-url', { preventDefault() {} }, 'focus-overlay://signin#access_token=tok%2B1'));
  ok(await until(() => page.evaluate(() => window.__tokens.join() === 'tok+1')), 'a focus-overlay:// link with the token reaches the page, which signs in with it (js/sync.js)');
  const patched = await app.evaluate(({ shell }) => {
    global.__opened = [];
    try { shell.openExternal = url => { global.__opened.push(url); return Promise.resolve(); }; return true; } catch (e) { return false; }
  });
  await page.evaluate(() => { location.href = 'https://example.com/elsewhere'; });
  await sleep(500);
  const opened = await app.evaluate(() => global.__opened);
  ok(page.url().startsWith(FOCUS_URL) && (!patched || opened.includes('https://example.com/elsewhere')), 'a link away from Focus stays out of the window (and opens in the browser)');
  await page.evaluate(() => window.focusOverlay.signIn('https://evil.example/steal'));
  await page.evaluate(() => window.focusOverlay.signIn('https://accounts.google.com/o/oauth2/v2/auth?state=worky-sync-app'));
  await sleep(300);
  const asked = await app.evaluate(() => global.__opened);
  ok(!asked.includes('https://evil.example/steal') && (!patched || asked.some(u => u.startsWith('https://accounts.google.com/'))), 'the page can open Google\'s sign-in in the browser, and nothing else that way');

  await app.close();
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
