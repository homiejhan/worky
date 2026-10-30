/* overlay.js — Focus as a small overlay on a laptop's screen. The desktop app
 * (desktop/) opens this page in a see-through window that stays above every
 * other window, and hands over window.focusOverlay (desktop/preload.js) to move
 * and size that window. In it, Focus is a round button with its checkmark,
 * against a side of the screen. Dragged, the window follows the pointer, and
 * dropped, it goes to the nearer side (the app works that out). Clicked, it
 * opens the panel beside it, toward the middle of the screen, and stays: clicked
 * again, it closes it, and dragged, the panel goes with it. The panel has the
 * timers on the left and a tab of Focus on the right, Home when it opens, the
 * others a click away on the small round buttons under the button. It has no
 * bar: the columns' names along its top (where it is dragged by too) and, in its
 * corner, ⋯ (Settings, Formats, Reset the day, the browser, the app's own menu)
 * and – (close). With clocks when minimized switched on, the running timers'
 * time left shows beside the button while the panel is closed. The cards and
 * pages are the app's own, moved in here as they are, so they work, save and
 * sync as everywhere else, in a plainer dress (style.css). In a browser,
 * without the app, none of this runs. */
import { $, escAttr, fmt, getRemaining } from './util.js';
import { syncAppSignInUrl, syncSignInWithToken } from './sync.js';
import { timerFinishText, timers } from './timers.js';
import { calRenderMobile } from './calendar.js';
import { viewExists } from './views.js';

const OVERLAY_DRAG_PX = 4;                         // moved further than this between press and release: a drag, not a click
const OVERLAY_FONT = 'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap';   // the typewriter's (style.css)
const OVERLAY_CHECK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 12.6l4.3 4.3 8.7-9.6" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const OVERLAY_BUTTON = 64;                         // the button's square in the window (the round, and room for its shadow)
const OVERLAY_CLOCKS_LS_KEY = 'focus-overlay-clocks';   // '1': the running timers' clocks beside the closed button (this device)
const OVERLAY_CLOCK = { room: 84, height: 22, gap: 4 };  // the clocks' room beside the button; each one's height, and between them
/* The tabs on the right: Focus's own, each with its page moved in here (the
 * timers have the left column), and its icon from the sidebar's. */
const OVERLAY_TABS = [
  { key: 'home',     label: 'Home',     nav: 'homeDesktopNavTab',   pages: ['homeContainer-d'] },
  { key: 'lists',    label: 'Lists',    nav: 'listsDesktopNavTab',  pages: ['listsSection-d'] },
  { key: 'daily',    label: 'Daily',    nav: 'dailyDesktopNavTab',  pages: ['dailySection-d'] },
  { key: 'calendar', label: 'Calendar', nav: 'calDesktopNavTab',    from: 'mobileCalPanel' },   // the phone's: one day, which fits
  { key: 'budget',   label: 'Budget',   nav: 'budgetDesktopNavTab', pages: ['budgetContainer-d'] },
  { key: 'digest',   label: 'Digest',   nav: 'digestDesktopNavTab', pages: ['digestContainer-d'] },
];

export const overlayApp = () => typeof window !== 'undefined' && !!window.focusOverlay;
let overlayEl = null;
let overlaySignIn = false;                         // sync is set up and nobody is signed in: the panel offers it
let overlayLay = { side: 'right', buttonTop: 0 };  // the button in the window: against which side, how far down
let overlayClockKey = null;                        // the clocks drawn: which timers, in which colours

/* 'icon' or 'panel'. The app makes the window the new shape first (it answers
 * once it has), and the panel shows once it has its room: in between, only the
 * button, which stays where it is. */
async function overlayShow(state, { home = false } = {}) {
  overlayMenu(false);
  if (state === 'panel' && home) overlayTab('home');   // opened from the button: Home
  overlayState('moving');
  try { await (state === 'panel' ? window.focusOverlay.expand() : window.focusOverlay.collapse()); } catch (e) {}
  await overlayAskLayout();
  overlayState(state);
}
/* (on the page too: a toast has no room while it's the button, style.css) */
function overlayState(state) {
  overlayEl.dataset.state = state;
  document.documentElement.dataset.ov = state;
  overlayPlace();
}

/* Where the app has put the button in the window: the panel, the tabs and the
 * clocks are laid out round it (style.css). An app from before it said so puts
 * it at the top of the window, against the nearer side of the screen. */
function overlayLayout(l) {
  if (!l) return;
  overlayLay = { side: l.side === 'left' ? 'left' : 'right', buttonTop: Math.max(0, Math.round(Number(l.buttonTop) || 0)) };
  overlayEl.dataset.side = overlayLay.side;
  overlayEl.style.setProperty('--ov-btn-top', `${overlayLay.buttonTop}px`);
  overlayPlace();
}
async function overlayAskLayout() {
  const app = window.focusOverlay;
  if (app.layout) { try { overlayLayout(await app.layout()); return; } catch (e) {} }
  overlayLayout({ side: screenX + innerWidth / 2 < (screen.availLeft || 0) + screen.availWidth / 2 ? 'left' : 'right', buttonTop: 0 });
}
/* the tabs under the button (over it when there's no room below), the clocks
 * level with it (down from its top when there are more than fit) */
function overlayPlace() {
  const tabs = overlayEl.querySelector('.ov-tabs');
  const th = tabs.offsetHeight;
  const below = overlayLay.buttonTop + OVERLAY_BUTTON;
  tabs.style.top = `${below + th <= innerHeight - 8 || !th ? below : Math.max(8, overlayLay.buttonTop - th)}px`;
  const clocks = overlayEl.querySelector('.ov-clocks');
  const n = clocks.children.length;
  const ch = n * OVERLAY_CLOCK.height + Math.max(0, n - 1) * OVERLAY_CLOCK.gap;
  clocks.style.top = `${Math.max(0, Math.min(overlayLay.buttonTop + (OVERLAY_BUTTON - ch) / 2, innerHeight - ch))}px`;
}

/* ⋯: what the toolbar does in Focus elsewhere (its buttons are hidden here, and
 * pressed for it), opening Focus in the browser, and the app's own menu */
function overlayMenu(open) {
  const menu = overlayEl.querySelector('.ov-menu');
  menu.hidden = !open;
  overlayEl.querySelector('.ov-more').setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('[role="menuitem"]').focus();
}
function overlayDo(what) {
  overlayMenu(false);
  const press = id => $(id)?.click();
  if (what === 'settings') press('settingsBtn');
  else if (what === 'formats') press('fmtBtn');
  else if (what === 'templates') press('fmtTplBtn');
  else if (what === 'reset') press('resetAllBtn');
  else if (what === 'browser') window.open(location.origin + location.pathname, '_blank');   // (the app sends it to the browser)
  else if (what === 'app') window.focusOverlay.menu();                                       // Start at login, Quit
}

/* The tab on the right: its page shows, and its name heads the column. */
export function overlayTab(key) {
  if (!overlayEl) return;
  const tab = OVERLAY_TABS.find(t => t.key === key && viewExists(t.key)) || OVERLAY_TABS[0];
  overlayEl.dataset.tab = tab.key;
  overlayEl.querySelector('.ov-label-tab').textContent = tab.label.toLowerCase();
  overlayEl.querySelectorAll('[data-ov-page]').forEach(p => { p.hidden = p.dataset.ovPage !== tab.key; });
  overlayEl.querySelectorAll('[data-ov-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ovTab === tab.key)));
  overlayEl.querySelector('.ov-main').scrollTop = 0;
  if (tab.key === 'calendar') calRenderMobile({ fresh: true });
}
/* the round tab buttons: one for each tab there is (Digest only while it's on) */
function overlayTabsShown() {
  overlayEl.querySelectorAll('[data-ov-tab]').forEach(b => { b.hidden = !viewExists(b.dataset.ovTab); });
  if (!viewExists(overlayEl.dataset.tab)) overlayTab('home');
}

/* ── under the timers: est. finish, and the clocks' switch ── */
function overlayClocksOn() {
  try { return localStorage.getItem(OVERLAY_CLOCKS_LS_KEY) === '1'; } catch (e) { return false; }
}
function overlayFinish() {
  const el = overlayEl.querySelector('.ov-finish-time');
  const txt = timerFinishText();
  if (el.textContent !== txt) el.textContent = txt;
}
/* The clocks: a running timer's time left each (its text kept going by the
 * timers' tick: tdisp-N), beside the button while the panel is closed. The app
 * is asked for their room as the running timers change. */
function overlayClocks() {
  const app = window.focusOverlay;
  const running = overlayClocksOn() && app.clocks ? timers.filter(t => t.running) : [];
  const key = running.map(t => `${t.id}:${t.color}:${t.label}`).join('|');
  if (key === overlayClockKey) return;
  overlayClockKey = key;
  overlayEl.querySelector('.ov-clocks').innerHTML = running.map(t => `
    <button class="ov-clock" type="button" style="--tc:${escAttr(t.color)}" title="${escAttr(t.label)}"><span class="tdisp-${t.id}">${fmt(getRemaining(t))}</span></button>`).join('');
  const n = running.length;
  overlayPlace();
  if (app.clocks) app.clocks(n ? OVERLAY_CLOCK.room : 0, n ? n * OVERLAY_CLOCK.height + (n - 1) * OVERLAY_CLOCK.gap : 0).then(overlayLayout, () => {});
}
let overlayTimersQueued = false;
function overlayTimersChanged() {
  if (overlayTimersQueued) return;
  overlayTimersQueued = true;
  queueMicrotask(() => { overlayTimersQueued = false; overlayClocks(); overlayFinish(); });
}

export function overlayInit() {
  if (!overlayApp()) return false;
  const app = window.focusOverlay;
  document.documentElement.classList.add('overlay-app');
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = OVERLAY_FONT;
  document.head.appendChild(font);
  overlayEl = document.createElement('div');
  overlayEl.id = 'overlay';
  overlayEl.className = 'ov';
  overlayEl.dataset.side = 'right';
  const icon = id => $(id)?.querySelector('.nav-ico svg')?.outerHTML || '';
  overlayEl.innerHTML = `
    <section class="ov-panel" aria-label="Focus">
      <div class="ov-top">
        <span class="ov-label">timers</span>
        <span class="ov-label ov-label-tab">home</span>
        <div class="ov-ctl">
          <button class="ov-btn ov-signin" type="button" hidden>sign in</button>
          <button class="ov-btn ov-fmt" type="button" data-ov-do="templates">templates</button>
          <button class="ov-btn ov-fmt" type="button" data-ov-do="formats">done</button>
          <button class="ov-btn ov-more" type="button" aria-label="More" title="More" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <button class="ov-btn ov-min" type="button" aria-label="Close the panel" title="Close">–</button>
        </div>
      </div>
      <div class="ov-cols">
        <div class="ov-col ov-timers">
          <div class="ov-finish">est. finish <span class="ov-finish-time"></span></div>
          <label class="ov-switch-row">
            <span>clocks when minimized</span>
            <input class="ov-switch-input" type="checkbox">
            <span class="ov-switch" aria-hidden="true"></span>
          </label>
          <div class="ov-switch-hint" hidden>needs the newest Focus Overlay: download it again</div>
        </div>
        <div class="ov-col ov-main">
          ${OVERLAY_TABS.map(t => `<div class="ov-page ov-page-${t.key}" data-ov-page="${t.key}" hidden></div>`).join('')}
        </div>
      </div>
      <div class="ov-menu" role="menu" aria-label="More" hidden>
        <button type="button" role="menuitem" data-ov-do="settings">settings</button>
        <button type="button" role="menuitem" data-ov-do="formats">formats</button>
        <button type="button" role="menuitem" data-ov-do="reset">reset the day</button>
        <button type="button" role="menuitem" data-ov-do="browser">open in the browser</button>
        <button type="button" role="menuitem" data-ov-do="app">more…</button>
      </div>
    </section>
    <nav class="ov-tabs" aria-label="Tabs">
      ${OVERLAY_TABS.map(t => `<button class="ov-tab" type="button" data-ov-tab="${t.key}" aria-label="${t.label}" title="${t.label}">${icon(t.nav)}</button>`).join('')}
    </nav>
    <div class="ov-clocks" aria-label="Running timers"></div>
    <button class="ov-icon" type="button" aria-label="Open Focus" title="Focus: click to open or close, drag to move">${OVERLAY_CHECK}</button>`;
  document.body.appendChild(overlayEl);
  overlayState('icon');

  /* left: the timers (and Formats' Add timer) over est. finish; right: each tab's page */
  const timerCol = overlayEl.querySelector('.ov-timers');
  [$('addTimerBtn-d'), $('timerStack-d')].forEach(el => el && timerCol.prepend(el));
  OVERLAY_TABS.forEach(t => {
    const page = overlayEl.querySelector(`[data-ov-page="${t.key}"]`);
    const els = t.from ? [...($(t.from)?.children || [])] : t.pages.map(id => $(id));
    els.forEach(el => el && page.appendChild(el));
  });
  overlayTab('home');
  overlayTabsShown();

  /* the button: a press that moves is a drag (the window follows, the panel
   * with it; let go, the app puts it at the nearer side), one that doesn't is a
   * click (open, or close) */
  const button = overlayEl.querySelector('.ov-icon');
  const toggle = () => {
    const st = overlayEl.dataset.state;
    if (st === 'panel') overlayShow('icon');
    else if (st === 'icon') { overlayTabsShown(); overlayShow('panel', { home: true }); }
  };
  let press = null;
  button.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    try { button.setPointerCapture(e.pointerId); } catch (err) {}
    press = { x: e.screenX, y: e.screenY, moved: false };
    app.dragStart();
  });
  button.addEventListener('pointermove', e => {
    if (!press) return;
    const dx = e.screenX - press.x, dy = e.screenY - press.y;
    if (!press.moved && Math.hypot(dx, dy) <= OVERLAY_DRAG_PX) return;
    press.moved = true;
    app.dragMove(Math.round(dx), Math.round(dy));
  });
  button.addEventListener('pointerup', () => {
    if (!press) return;
    const moved = press.moved;
    press = null;
    if (moved) app.dragEnd();
    else toggle();
  });
  button.addEventListener('pointercancel', () => { if (press && press.moved) app.dragEnd(); press = null; });
  button.addEventListener('click', e => { if (e.detail === 0) toggle(); });              // the keyboard (Enter, Space)
  button.addEventListener('contextmenu', e => { e.preventDefault(); app.menu(); });       // Start at login, Quit
  overlayEl.querySelector('.ov-clocks').addEventListener('click', e => { if (e.target.closest('.ov-clock')) toggle(); });

  /* the tabs, the panel's corner, and ⋯ (right-clicking along the top opens it too) */
  overlayEl.querySelectorAll('[data-ov-tab]').forEach(b => b.addEventListener('click', () => overlayTab(b.dataset.ovTab)));
  overlayEl.querySelector('.ov-min').addEventListener('click', () => overlayShow('icon'));
  overlayEl.querySelector('.ov-more').addEventListener('click', () => overlayMenu(overlayEl.querySelector('.ov-menu').hidden));
  overlayEl.querySelector('.ov-top').addEventListener('contextmenu', e => { e.preventDefault(); overlayMenu(true); });
  overlayEl.querySelectorAll('[data-ov-do]').forEach(b => b.addEventListener('click', () => overlayDo(b.dataset.ovDo)));
  overlayEl.querySelector('.ov-signin').addEventListener('click', () => app.signIn(syncAppSignInUrl()));
  document.addEventListener('pointerdown', e => {
    if (!overlayEl.querySelector('.ov-menu').hidden && !e.target.closest('.ov-menu, .ov-more')) overlayMenu(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || overlayEl.dataset.state !== 'panel' || document.querySelector('.modal-overlay.show')) return;
    if (!overlayEl.querySelector('.ov-menu').hidden) { overlayMenu(false); overlayEl.querySelector('.ov-more').focus(); }
    else overlayShow('icon');
  });

  /* est. finish and the clocks follow the timers (started, stopped, changed,
   * ticking); est. finish moves with the clock too while none runs */
  const sw = overlayEl.querySelector('.ov-switch-input');
  sw.checked = overlayClocksOn();
  sw.disabled = !app.clocks;
  overlayEl.querySelector('.ov-switch-hint').hidden = !!app.clocks;
  sw.addEventListener('change', () => {
    try { localStorage.setItem(OVERLAY_CLOCKS_LS_KEY, sw.checked ? '1' : '0'); } catch (e) {}
    overlayClocks();
  });
  const stack = $('timerStack-d');
  if (stack) new MutationObserver(overlayTimersChanged).observe(stack, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
  setInterval(overlayFinish, 20000);
  overlayFinish();
  overlayClocks();

  /* a dialog (a confirmation, say) needs the panel's room */
  const dialogs = new MutationObserver(() => {
    if (overlayEl.dataset.state === 'icon' && document.querySelector('.modal-overlay.show')) overlayShow('panel');
  });
  document.querySelectorAll('.modal-overlay').forEach(m => dialogs.observe(m, { attributes: true, attributeFilter: ['class'] }));

  if (app.onLayout) app.onLayout(overlayLayout);                         // dragged to the other side, say
  window.addEventListener('resize', overlayPlace);
  if (app.onSignIn) app.onSignIn(token => syncSignInWithToken(token));   // handed over by the browser (sync.js)
  overlaySyncChanged(overlaySignIn);
  Promise.resolve(app.state ? app.state() : 'icon')
    .then(s => overlayAskLayout().then(() => overlayState(s === 'panel' ? 'panel' : 'icon')), () => {});
  return true;
}

/* sync.js, whenever who is signed in changes: offer to sign in while nobody is */
export function overlaySyncChanged(offer) {
  overlaySignIn = !!offer;
  const b = overlayEl && overlayEl.querySelector('.ov-signin');
  if (b) b.hidden = !overlaySignIn;
}
