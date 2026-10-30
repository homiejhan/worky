/* Focus Overlay, played for real: the desktop app (desktop/, Electron) showing
 * Focus from this checkout, on a screen, driven with the mouse like a person
 * would: the button where it starts, dragged across and let go (it glides to the
 * nearer side), clicked open (the panel, against that side, with the timers and
 * today's tasks), minimized, its place kept for the next start, a sign-in handed
 * back by the browser, and a link that leaves Focus going to the browser.
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
  async function drag(app, page, from, to, steps = 14) {
    await mouseTo(app, page, from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await mouseTo(app, page, from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
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
  await drag(app, page, middle(await win(app)), { x: area.x + 150, y: area.y + 200 });
  await until(async () => (await win(app)).x === area.x + 12);

  console.log('\n── 3. Clicked: the panel ──');
  b = await win(app);
  await mouseTo(app, page, b.x + 32, b.y + 32);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForSelector('#overlay[data-state="panel"]', { timeout: 4000 });
  const p = await win(app);
  ok(p.width === 760 && p.height === 540 && p.x === area.x + 12 && p.y === b.y, `the panel opens against the left side, its top at the button's (${JSON.stringify(p)})`);
  const cols = await page.evaluate(() => {
    const box = el => el && el.getBoundingClientRect();
    const t = box(document.querySelector('.ov-timers .timer-card')), d = box(document.querySelector('.ov-tasks .home-sec-today'));
    return { timers: document.querySelectorAll('.ov-timers .timer-card').length, t: t && { x: t.x, w: t.width }, d: d && { x: d.x, w: d.width }, W: innerWidth };
  });
  ok(cols.timers >= 1 && cols.t && cols.d && cols.t.x < cols.d.x && cols.d.x + cols.d.w <= cols.W, `the timers on the left (${cols.timers}), today's tasks on the right, inside the window`);
  await shot(page, 'panel');
  const id = await page.evaluate(() => document.querySelector('.ov-timers .timer-card').dataset.timerId);
  await page.click(`.ov-timers .playbtn-${id}`);
  ok(await until(() => page.evaluate(i => !!document.querySelector(`.ov-timers .tcard-${i}.running`), id)), 'a timer started from it runs');
  await page.click(`.ov-timers .playbtn-${id}`);
  await page.click('[data-ov-tab="daily"]');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('defaultContainer-d')).display !== 'none' && getComputedStyle(document.getElementById('homeContainer-d')).display === 'none'),
    'Daily: the Daily lists on the right');
  await page.click('[data-ov-tab="today"]');

  console.log('\n── 4. Minimized, and its place kept ──');
  await page.click('.ov-min');
  await page.waitForSelector('#overlay[data-state="icon"]');
  b = await win(app);
  ok(b.width === 64 && b.x === area.x + 12 && b.y === p.y, `back to the button, where it was (${JSON.stringify(b)})`);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector('#overlay[data-state="icon"]', { timeout: 15000 });
  const again = await win(app);
  ok(again.x === b.x && again.y === b.y, `opened again: the button where it was left (${JSON.stringify(again)})`);

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
