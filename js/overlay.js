/* overlay.js — Focus as a small overlay on a laptop's screen. The desktop app
 * (desktop/) opens this page in a see-through window that stays above every
 * other window, and hands over window.focusOverlay (desktop/preload.js) to move
 * and size that window. In it, Focus is a round button with its checkmark:
 * dragged, the window follows the pointer, and dropped, it goes to the nearer
 * side of the screen (the app works that out); clicked, it opens a panel with
 * the timers on the left and today's tasks or the Daily lists on the right, and
 * the panel minimizes back to the button. The cards are the app's own, moved in
 * here as they are, so they work, save and sync as everywhere else. In a
 * browser, without the app, none of this runs. */
import { $ } from './util.js';
import { syncAppSignInUrl, syncSignInWithToken } from './sync.js';

const OVERLAY_TAB_LS_KEY = 'focus-overlay-tab';   // what the right column shows on this device: 'today' | 'daily'
const OVERLAY_DRAG_PX = 4;                         // moved further than this between press and release: a drag, not a click
const OVERLAY_CHECK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 12.6l4.3 4.3 8.7-9.6" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const overlayApp = () => typeof window !== 'undefined' && !!window.focusOverlay;
let overlayEl = null;
let overlaySignIn = false;                         // sync is set up and nobody is signed in: the panel offers it

function overlayStoredTab() {
  try { return localStorage.getItem(OVERLAY_TAB_LS_KEY) === 'daily' ? 'daily' : 'today'; } catch (e) { return 'today'; }
}
function overlayTab(tab) {
  overlayEl.dataset.tab = tab;
  overlayEl.querySelectorAll('[data-ov-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ovTab === tab)));
  try { localStorage.setItem(OVERLAY_TAB_LS_KEY, tab); } catch (e) {}
}
/* 'icon' or 'panel'. The window is resized first (the app answers once it is),
 * so the panel never shows squeezed into the button's window, nor the button in
 * the panel's: in between, nothing shows. */
async function overlayShow(state) {
  overlayEl.dataset.state = 'moving';
  try { await (state === 'panel' ? window.focusOverlay.expand() : window.focusOverlay.collapse()); } catch (e) {}
  overlayEl.dataset.state = state;
}

export function overlayInit() {
  if (!overlayApp()) return false;
  const app = window.focusOverlay;
  document.documentElement.classList.add('overlay-app');
  overlayEl = document.createElement('div');
  overlayEl.id = 'overlay';
  overlayEl.className = 'ov';
  overlayEl.dataset.state = 'icon';
  overlayEl.innerHTML = `
    <button class="ov-icon" type="button" aria-label="Open Focus" title="Focus: click to open, drag to move">${OVERLAY_CHECK}</button>
    <section class="ov-panel" aria-label="Focus">
      <header class="ov-head">
        <span class="ov-brand">${OVERLAY_CHECK}<b>Focus</b></span>
        <div class="ov-tabs" role="tablist" aria-label="Right column">
          <button class="ov-tab" type="button" role="tab" data-ov-tab="today">Today</button>
          <button class="ov-tab" type="button" role="tab" data-ov-tab="daily">Daily</button>
        </div>
        <button class="ov-signin" type="button" hidden>Sign in to sync</button>
        <button class="ov-min" type="button" aria-label="Minimize to the button" title="Minimize">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="ov-cols">
        <div class="ov-col ov-timers"></div>
        <div class="ov-col ov-tasks"></div>
      </div>
    </section>`;
  document.body.appendChild(overlayEl);
  const timers = overlayEl.querySelector('.ov-timers'), tasks = overlayEl.querySelector('.ov-tasks');
  [$('timerStack-d')].forEach(el => el && timers.appendChild(el));
  [$('homeContainer-d'), $('defaultContainer-d')].forEach(el => el && tasks.appendChild(el));
  overlayTab(overlayStoredTab());

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
  overlayEl.querySelector('.ov-min').addEventListener('click', () => overlayShow('icon'));
  overlayEl.querySelector('.ov-head').addEventListener('contextmenu', e => { e.preventDefault(); app.menu(); });
  overlayEl.querySelectorAll('[data-ov-tab]').forEach(b => b.addEventListener('click', () => overlayTab(b.dataset.ovTab)));
  overlayEl.querySelector('.ov-signin').addEventListener('click', () => app.signIn(syncAppSignInUrl()));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlayEl.dataset.state === 'panel' && !document.querySelector('.modal-overlay.show')) overlayShow('icon'); });

  /* a dialog (a confirmation, say) needs the panel's room */
  const dialogs = new MutationObserver(() => {
    if (overlayEl.dataset.state === 'icon' && document.querySelector('.modal-overlay.show')) overlayShow('panel');
  });
  document.querySelectorAll('.modal-overlay').forEach(m => dialogs.observe(m, { attributes: true, attributeFilter: ['class'] }));

  if (app.onSignIn) app.onSignIn(token => syncSignInWithToken(token));   // handed over by the browser (sync.js)
  overlaySyncChanged(overlaySignIn);
  Promise.resolve(app.state ? app.state() : 'icon').then(s => { overlayEl.dataset.state = s === 'panel' ? 'panel' : 'icon'; }, () => {});
  return true;
}

/* sync.js, whenever who is signed in changes: offer to sign in while nobody is */
export function overlaySyncChanged(offer) {
  overlaySignIn = !!offer;
  const b = overlayEl && overlayEl.querySelector('.ov-signin');
  if (b) b.hidden = !overlaySignIn;
}
