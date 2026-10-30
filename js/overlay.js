/* overlay.js — Focus as a small overlay on a laptop's screen. The desktop app
 * (desktop/) opens this page in a see-through window that stays above every
 * other window, and hands over window.focusOverlay (desktop/preload.js) to move
 * and size that window. In it, Focus is a round button with its checkmark:
 * dragged, the window follows the pointer, and dropped, it goes to the nearer
 * side of the screen (the app works that out); clicked, it opens a panel with
 * the timers on the left and today's tasks and the Daily lists on the right, and
 * the panel minimizes back to the button. The panel has no bar: the columns'
 * names along its top (where it is dragged by) and, in its corner, ⋯ (Settings,
 * Formats, Reset the day, the browser, the app's own menu) and – (minimize). The
 * cards are the app's own, moved in here as they are, so they work, save and
 * sync as everywhere else, in a plainer dress (style.css). In a browser, without
 * the app, none of this runs. */
import { $ } from './util.js';
import { syncAppSignInUrl, syncSignInWithToken } from './sync.js';

const OVERLAY_DRAG_PX = 4;                         // moved further than this between press and release: a drag, not a click
const OVERLAY_FONT = 'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap';   // the typewriter's (style.css)
const OVERLAY_CHECK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 12.6l4.3 4.3 8.7-9.6" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const overlayApp = () => typeof window !== 'undefined' && !!window.focusOverlay;
let overlayEl = null;
let overlaySignIn = false;                         // sync is set up and nobody is signed in: the panel offers it

/* 'icon' or 'panel'. The window is resized first (the app answers once it is),
 * so the panel never shows squeezed into the button's window, nor the button in
 * the panel's: in between, nothing shows. */
async function overlayShow(state) {
  overlayMenu(false);
  overlayState('moving');
  try { await (state === 'panel' ? window.focusOverlay.expand() : window.focusOverlay.collapse()); } catch (e) {}
  overlayState(state);
}
/* (on the page too: a toast has no room while it's the button, style.css) */
function overlayState(state) {
  overlayEl.dataset.state = state;
  document.documentElement.dataset.ov = state;
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
  overlayEl.innerHTML = `
    <button class="ov-icon" type="button" aria-label="Open Focus" title="Focus: click to open, drag to move">${OVERLAY_CHECK}</button>
    <section class="ov-panel" aria-label="Focus">
      <div class="ov-top">
        <span class="ov-label">timers</span>
        <span class="ov-label">today</span>
        <div class="ov-ctl">
          <button class="ov-btn ov-signin" type="button" hidden>sign in</button>
          <button class="ov-btn ov-fmt" type="button" data-ov-do="templates">templates</button>
          <button class="ov-btn ov-fmt" type="button" data-ov-do="formats">done</button>
          <button class="ov-btn ov-more" type="button" aria-label="More" title="More" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <button class="ov-btn ov-min" type="button" aria-label="Minimize to the button" title="Minimize">–</button>
        </div>
      </div>
      <div class="ov-cols">
        <div class="ov-col ov-timers"></div>
        <div class="ov-col ov-tasks">
          <div class="ov-none">nothing due today.</div>
          <div class="ov-label ov-label-daily">daily</div>
        </div>
      </div>
      <div class="ov-menu" role="menu" aria-label="More" hidden>
        <button type="button" role="menuitem" data-ov-do="settings">settings</button>
        <button type="button" role="menuitem" data-ov-do="formats">formats</button>
        <button type="button" role="menuitem" data-ov-do="reset">reset the day</button>
        <button type="button" role="menuitem" data-ov-do="browser">open in the browser</button>
        <button type="button" role="menuitem" data-ov-do="app">more…</button>
      </div>
    </section>`;
  document.body.appendChild(overlayEl);
  overlayState('icon');
  /* left: the timers (and Formats' Add timer); right: today's tasks (Home's,
   * with its progress), then the Daily lists (and Formats' Add list) */
  const timers = overlayEl.querySelector('.ov-timers'), tasks = overlayEl.querySelector('.ov-tasks');
  [$('timerStack-d'), $('addTimerBtn-d')].forEach(el => el && timers.appendChild(el));
  const none = tasks.querySelector('.ov-none');
  if ($('homeContainer-d')) tasks.insertBefore($('homeContainer-d'), none);
  [$('addDailyBtn'), $('defaultContainer-d')].forEach(el => el && tasks.appendChild(el));

  /* the button: a press that moves is a drag (the window follows; let go, the app
   * puts it at the nearer side), one that doesn't is a click (open) */
  const icon = overlayEl.querySelector('.ov-icon');
  let press = null;
  icon.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    try { icon.setPointerCapture(e.pointerId); } catch (err) {}
    press = { x: e.screenX, y: e.screenY, moved: false };
    app.dragStart();
  });
  icon.addEventListener('pointermove', e => {
    if (!press) return;
    const dx = e.screenX - press.x, dy = e.screenY - press.y;
    if (!press.moved && Math.hypot(dx, dy) <= OVERLAY_DRAG_PX) return;
    press.moved = true;
    app.dragMove(Math.round(dx), Math.round(dy));
  });
  icon.addEventListener('pointerup', () => {
    if (!press) return;
    const moved = press.moved;
    press = null;
    if (moved) app.dragEnd();
    else overlayShow('panel');
  });
  icon.addEventListener('pointercancel', () => { if (press && press.moved) app.dragEnd(); press = null; });
  icon.addEventListener('click', e => { if (e.detail === 0) overlayShow('panel'); });   // the keyboard (Enter, Space)
  icon.addEventListener('contextmenu', e => { e.preventDefault(); app.menu(); });       // Start at login, Quit

  /* the panel's corner, and ⋯ (right-clicking along the top opens it too) */
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

  /* a dialog (a confirmation, say) needs the panel's room */
  const dialogs = new MutationObserver(() => {
    if (overlayEl.dataset.state === 'icon' && document.querySelector('.modal-overlay.show')) overlayShow('panel');
  });
  document.querySelectorAll('.modal-overlay').forEach(m => dialogs.observe(m, { attributes: true, attributeFilter: ['class'] }));

  if (app.onSignIn) app.onSignIn(token => syncSignInWithToken(token));   // handed over by the browser (sync.js)
  overlaySyncChanged(overlaySignIn);
  Promise.resolve(app.state ? app.state() : 'icon').then(s => overlayState(s === 'panel' ? 'panel' : 'icon'), () => {});
  return true;
}

/* sync.js, whenever who is signed in changes: offer to sign in while nobody is */
export function overlaySyncChanged(offer) {
  overlaySignIn = !!offer;
  const b = overlayEl && overlayEl.querySelector('.ov-signin');
  if (b) b.hidden = !overlaySignIn;
}
