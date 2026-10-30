/* main.js — Focus Overlay: Focus as a round button above every window on a
 * laptop, that opens a panel beside it with the timers and the app's tabs (the
 * page draws both: js/overlay.js).
 *
 * One window, without a frame, see-through, above the others, on every desktop
 * (Space). It shows the live Focus site (FOCUS_URL), so it is always the latest
 * version, opens offline from the site's own copy (its service worker), and
 * syncs with the other devices once signed in. The window is laid out round the
 * button (snap.js around): the button against a side of the screen, and beside
 * it, toward the middle, the panel while it is open, or the running timers'
 * clocks while it is the button (the page asks for their room). The page gets
 * window.focusOverlay (preload.js) to ask for what only the app can do: move
 * the window while the button is dragged (the panel with it) and, let go, glide
 * it to the nearer side; open the panel beside the button, or close it; make
 * room for the clocks; sign in through the browser; and the button's menu
 * (right-click): Start at login, Quit. It tells the page where the button is in
 * the window whenever that changes. Where the button was is kept for the next
 * start.
 *
 * Sign-in goes through the browser, as Google turns sign-in away in an app's
 * own window: the page opens Google's sign-in there, and the Focus page Google
 * then opens hands the token back through a focus-overlay:// link, which the
 * system gives this app. */
const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { around, buttonIn } = require('./snap');

const FOCUS_URL = process.env.FOCUS_URL || 'https://homiejhan.github.io/worky/';   // (tests: this checkout, served locally)
if (process.env.FOCUS_OVERLAY_DATA) app.setPath('userData', process.env.FOCUS_OVERLAY_DATA);   // (tests: a fresh one each run)
const SCHEME = 'focus-overlay';
const BUTTON = 64;                                 // the button's square in the window: the round, and room for its shadow
const PANEL = { width: 760, height: 540 };         // the panel, beside the button
const CLOCKS_MAX = { width: 240, height: 600 };    // the most room the page may ask for its clocks
const GLIDE_MS = 160;                              // to the side, once let go

let win = null;
let state = 'icon';                                // 'icon' | 'panel'
let side = 'right', buttonTop = 0;                 // the button: against which side, how far down the window
let clocks = { width: 0, height: 0 };              // the running timers' room beside the button, while it is the button
let dragFrom = null;                               // the window's position when the press began
let dragging = false;                              // and it has moved since (a press that doesn't is a click)
let glide = null;
let pendingToken = null;                           // handed over before the page was ready for it

/* ── one copy of the app; a focus-overlay:// link goes to it ── */
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_e, argv) => takeLink(argv.find(a => a.startsWith(`${SCHEME}://`))));
app.on('open-url', (e, url) => { e.preventDefault(); takeLink(url); });   // macOS
if (process.defaultApp) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1] || '.')]);
else app.setAsDefaultProtocolClient(SCHEME);

const focusSite = new URL(FOCUS_URL);
const onFocusSite = url => { try { const u = new URL(url); return u.origin === focusSite.origin && u.pathname.startsWith(focusSite.pathname); } catch (e) { return false; } };
const fromPage = e => !!win && e.sender === win.webContents && onFocusSite(e.sender.getURL());

/* ── where the button was, for the next start ── */
const stateFile = () => path.join(app.getPath('userData'), 'overlay.json');
function readSaved() {
  try { const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); return Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null; } catch (e) { return null; }
}
function save() {
  if (!win) return;
  const b = button();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ x: b.x, y: b.y })); } catch (e) {}
}

const areaAt = rect => screen.getDisplayNearestPoint({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }).workArea;
const bounds = () => win.getBounds();
const button = () => buttonIn(bounds(), side, buttonTop, BUTTON);
const room = () => (state === 'panel' ? PANEL : clocks);
const layoutNow = () => ({ state, side, buttonTop });
/* the page draws the button where the window has it, and what is beside it */
function tell() { if (win && !win.webContents.isLoading()) win.webContents.send('overlay:layout-changed', layoutNow()); }
function laidOut(l) { side = l.side; buttonTop = l.buttonTop; }
function place(b) {                                 // (a window that can't be resized can't be sized either, on some systems)
  win.setResizable(true);
  win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  win.setResizable(false);
}
function stopGlide() { clearInterval(glide); glide = null; }
function glideTo(target, done) {
  stopGlide();
  const [x0, y0] = win.getPosition(), t0 = Date.now();
  glide = setInterval(() => {
    if (!win) { stopGlide(); return; }
    const k = Math.min(1, (Date.now() - t0) / GLIDE_MS), e = 1 - Math.pow(1 - k, 3);
    win.setPosition(Math.round(x0 + (target.x - x0) * e), Math.round(y0 + (target.y - y0) * e));
    if (k >= 1) { stopGlide(); if (done) done(); }
  }, 12);
}
/* the window round the button, at once: opened, closed, the clocks' room changed */
function reshape() {
  const b = button();
  const l = around(b, room(), areaAt(b));
  laidOut(l);
  place(l);
  tell();
}
/* let go: the button against the nearer side, the window round it, gliding
 * there. If the button is to sit elsewhere in the window (the other side, or
 * lower), the window takes that shape round the button where it was let go
 * first, so the button doesn't jump; then all of it glides. */
function settle() {
  if (!win) return;
  const b = button();
  const l = around(b, room(), areaAt(b));
  const now = bounds();
  if (l.width !== now.width || l.height !== now.height) { laidOut(l); place(l); tell(); save(); return; }   // (another screen)
  if (l.side !== side || l.buttonTop !== buttonTop) {
    laidOut(l);
    tell();
    win.setPosition(Math.round(side === 'left' ? b.x : b.x + BUTTON - l.width), Math.round(b.y - buttonTop));
  }
  glideTo(l, save);
}

function createWindow() {
  const saved = readSaved();
  const primary = screen.getPrimaryDisplay().workArea;
  const from = saved ? { x: saved.x, y: saved.y, width: BUTTON, height: BUTTON }
    : { x: primary.x + primary.width, y: primary.y + primary.height * 0.35, width: BUTTON, height: BUTTON };
  const b = around(from, clocks, areaAt(from));
  laidOut(b);
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Focus',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.once('ready-to-show', () => win.show());
  /* Focus stays in the window; anything else (a link in a task) opens in the browser */
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!onFocusSite(url)) { e.preventDefault(); openOutside(url); } });
  win.webContents.on('did-finish-load', () => {
    tell();
    if (pendingToken) { win.webContents.send('overlay:sign-in-token', pendingToken); pendingToken = null; }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(FOCUS_URL);
}
function openOutside(url) {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
}

/* a focus-overlay://signin#access_token=… link, from the browser's sign-in */
function takeLink(url) {
  if (!url || !url.startsWith(`${SCHEME}://`)) return;
  const m = /[#&?]access_token=([^&]+)/.exec(url);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  if (win && !win.webContents.isLoading()) win.webContents.send('overlay:sign-in-token', token);
  else pendingToken = token;
  if (win) win.show();
}

function showMenu() {
  if (!win) return;
  const login = app.getLoginItemSettings();
  Menu.buildFromTemplate([
    { label: 'Open Focus in the browser', click: () => shell.openExternal(FOCUS_URL) },
    { label: 'Start at login', type: 'checkbox', checked: !!login.openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Quit Focus Overlay', click: () => app.quit() },
  ]).popup({ window: win });
}

/* ── what the page asks for (preload.js) ── */
ipcMain.handle('overlay:state', e => (fromPage(e) ? state : 'icon'));
ipcMain.handle('overlay:layout', e => (fromPage(e) ? layoutNow() : null));
ipcMain.on('overlay:drag-start', e => {                // the button, open or not: the window follows it
  if (!fromPage(e)) return;
  stopGlide();
  dragFrom = win.getPosition();
  dragging = false;
});
ipcMain.on('overlay:drag-move', (e, dx, dy) => {
  if (!fromPage(e) || !dragFrom) return;
  dragging = true;
  win.setPosition(Math.round(dragFrom[0] + (Number(dx) || 0)), Math.round(dragFrom[1] + (Number(dy) || 0)));
});
ipcMain.on('overlay:drag-end', e => {
  if (!fromPage(e)) return;
  dragFrom = null;
  dragging = false;
  settle();
});
const endPress = () => { dragFrom = null; dragging = false; };   // a click: opened or closed
ipcMain.handle('overlay:expand', e => {
  if (!fromPage(e)) return state;
  stopGlide();
  endPress();
  if (state !== 'panel') {
    state = 'panel';
    reshape();
    win.focus();
  }
  return state;
});
ipcMain.handle('overlay:collapse', e => {
  if (!fromPage(e)) return state;
  stopGlide();
  endPress();
  if (state !== 'icon') {
    state = 'icon';
    reshape();
    save();
  }
  return state;
});
/* the room the page needs beside the button for the running timers' clocks
 * (0 × 0: none); taken at once while it is the button, else on closing */
ipcMain.handle('overlay:clocks', (e, width, height) => {
  if (!fromPage(e)) return null;
  const fit = (v, max) => Math.round(Math.min(Math.max(Number(v) || 0, 0), max));
  const next = { width: fit(width, CLOCKS_MAX.width), height: fit(height, CLOCKS_MAX.height) };
  if (next.width !== clocks.width || next.height !== clocks.height) {
    clocks = next;
    if (state === 'icon' && !dragging) { stopGlide(); reshape(); }   // (mid-drag: when it's let go, settle)
  }
  return layoutNow();
});
ipcMain.on('overlay:sign-in', (e, url) => {
  if (fromPage(e) && /^https:\/\/accounts\.google\.com\//.test(String(url))) shell.openExternal(String(url));
});
ipcMain.on('overlay:menu', e => { if (fromPage(e)) showMenu(); });

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();   // (the built app says so itself: LSUIElement)
  createWindow();
  takeLink(process.argv.find(a => a.startsWith(`${SCHEME}://`)));   // started by a link (Windows, Linux)
  /* a screen unplugged: back onto one; one rearranged (or the Dock shown): the button back against its side */
  screen.on('display-removed', () => settle());
  screen.on('display-metrics-changed', () => settle());
});
app.on('window-all-closed', () => app.quit());
