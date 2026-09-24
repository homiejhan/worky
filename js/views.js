/* views.js — Which views are on, mobile tabs and swipe, desktop panel navigation, the
 * touch-offset guard. */
import { $, isMobileLayout } from './util.js';
import { homeDesktopOpen, homeToggleDesktop, renderHome } from './home.js';
import { calDesktopOpen, calRenderMobile, calToggleDesktop } from './calendar.js';
import { budgetDesktopOpen, budgetToggleDesktop, renderBudget } from './budget.js';

/* view visibility — which sections appear in the UI, in tab-bar order.
 * 'home' is always on and is not stored. On mobile every view is one swipe
 * panel, and currentView holds the key of the one showing. */
export const VIEW_DEFS = [
  { key: 'home',     label: 'Home' },
  { key: 'timers',   label: 'Timers' },
  { key: 'lists',    label: 'My Lists' },
  { key: 'daily',    label: 'Daily' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'budget',   label: 'Budget' },
];
export let views = { timers: true, daily: true, lists: true, calendar: true, budget: true };
export function setViews(v) { views = v; }
export let currentView = 'home';

/* Desktop: Lists and Daily are separate pages that share the right panel.
 * desktopPage says which one it shows whenever no overlay (Home, Calendar,
 * Budget) is covering it. */
let desktopPage = 'lists';

/* Keep the sidebar nav in step with whichever desktop panel is showing. */
export function desktopNavSync() {
  const base = !homeDesktopOpen && !calDesktopOpen && !budgetDesktopOpen;
  const rp = $('rightPanel');
  if (rp) rp.dataset.page = desktopPage;          // CSS shows the matching .page-* blocks
  const listsTab = $('listsDesktopNavTab');
  const dailyTab = $('dailyDesktopNavTab');
  if (listsTab) listsTab.classList.toggle('active', base && desktopPage === 'lists');
  if (dailyTab) dailyTab.classList.toggle('active', base && desktopPage === 'daily');
}
/* Show the Lists or Daily page in the right panel, closing any overlay. */
export function showDesktopPage(page) {
  desktopPage = page === 'daily' ? 'daily' : 'lists';
  if (calDesktopOpen) calToggleDesktop();
  if (budgetDesktopOpen) budgetToggleDesktop(false);
  homeToggleDesktop(false);                       // ends in desktopNavSync()
  const rp = $('rightPanel');
  if (rp) rp.scrollTop = 0;
}
export function showDesktopLists() { showDesktopPage('lists'); }
export function showDesktopDaily() { showDesktopPage('daily'); }

/* ───────────────────────── VIEWS + MOBILE TABS ─────────────────────────
 * A disabled view disappears from the tab bar (mobile) and the left nav /
 * right panel (desktop). Nothing about its data or behaviour changes — the
 * Home page keeps showing day-by-day tasks, the balance, starred lists and
 * the agenda regardless. Timers is the one section Home drops when off. */
export function normalizeViews(v) {
  const out = { timers: true, daily: true, lists: true, calendar: true, budget: true };
  if (Array.isArray(v)) {                       // compressed form: list of disabled keys
    v.forEach(k => { if (k in out) out[k] = false; });
  } else if (v && typeof v === 'object') {
    Object.keys(out).forEach(k => { if (v[k] === false) out[k] = false; });
  }
  return out;
}
export function viewsOffList(v) {
  const n = normalizeViews(v);
  return Object.keys(n).filter(k => !n[k]);
}
export function viewEnabled(key) {
  if (!key) return true;
  if (key === 'home') return true;              // Home can never be turned off
  return views[key] !== false;
}
function visibleViews() { return VIEW_DEFS.filter(v => viewEnabled(v.key)); }
/* Mobile: is there a swipe panel showing for this key? Unlike viewEnabled,
 * a key that isn't a view at all counts as off. */
function panelEnabled(key) { return VIEW_DEFS.some(v => v.key === key) && viewEnabled(key); }

/* Show/hide every element tagged with data-view, close any desktop overlay
 * whose view was just disabled, and rebuild the mobile tab strip. */
export function applyViewVisibility() {
  document.querySelectorAll('[data-view]').forEach(el => {
    if (el.classList.contains('swipe-panel') || el.classList.contains('tab-btn')) return;
    el.style.display = viewEnabled(el.dataset.view) ? '' : 'none';
  });
  if (!viewEnabled('calendar') && calDesktopOpen)   calToggleDesktop();
  if (!viewEnabled('budget')   && budgetDesktopOpen) budgetToggleDesktop(false);
  /* The right panel shows Lists or Daily. If the page it is on was just
   * switched off, fall over to the other one — or Home when both are off. */
  if (!viewEnabled(desktopPage)) {
    const other = desktopPage === 'lists' ? 'daily' : 'lists';
    if (viewEnabled(other)) desktopPage = other;
    else if (!homeDesktopOpen && !calDesktopOpen && !budgetDesktopOpen) homeToggleDesktop(true);
  }
  desktopNavSync();
  if (!panelEnabled(currentView)) currentView = 'home';
  setSwipePanelWidths();
  renderHome();
}

function swipeFrameWidth() {
  const c = $('swipeContainer');
  return (c && c.clientWidth) || window.innerWidth;
}

export function setSwipePanelWidths() {
  const w = swipeFrameWidth();
  const track = $('swipeTrack');
  document.querySelectorAll('.swipe-panel').forEach(p => {
    const on = panelEnabled(p.dataset.view);
    p.style.display = on ? '' : 'none';
    if (on) p.style.width = w + 'px';
  });
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = panelEnabled(b.dataset.view);
    b.style.display = on ? '' : 'none';
    b.classList.toggle('active', b.dataset.view === currentView);
  });
  const vis = visibleViews();
  const idx = Math.max(0, vis.findIndex(v => v.key === currentView));
  if (track) {
    track.style.width = (w * vis.length) + 'px';
    track.style.transition = 'none';
    track.style.transform = `translateX(${-idx * w}px)`;
  }
}

/* Mobile: slide to a view's panel (Home when that view is off). */
export function goTab(key, animate) {
  if (!panelEnabled(key)) key = 'home';
  currentView = key;
  const idx = Math.max(0, visibleViews().findIndex(v => v.key === key));
  const w = swipeFrameWidth();
  const track = $('swipeTrack');
  if (track) {
    track.style.transition = animate === false ? 'none' : 'transform 0.32s cubic-bezier(0.3,0.7,0.4,1)';
    track.style.transform = `translateX(${-idx * w}px)`;
  }
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === key);
  });
  if (key === 'calendar') calRenderMobile({ fresh: true });   // opening the tab starts at 7am
  if (key === 'home')     renderHome();
  if (key === 'budget')   renderBudget();
}

/* Total-balance chip on Home opens Budget on whichever layout is active. */
export function openBudgetTab() {
  if (!viewEnabled('budget')) return;
  if (isMobileLayout()) goTab('budget', true);
  else budgetToggleDesktop(true);
}

export function initSwipe() {
  const swipeEl = $('swipeContainer');
  if (!swipeEl) return;
  let sx = 0, sy = 0, swiping = false;

  swipeEl.addEventListener('touchstart', e => {
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'SELECT'
      || t.closest('button') || t.closest('input')
      || t.closest('.drag-handle') || t.closest('.list-drag-handle')
      || t.closest('.cal-event') || t.closest('.cal-divider')) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });

  swipeEl.addEventListener('touchmove', e => {
    if (!sx) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) swiping = true;
  }, { passive: true });

  swipeEl.addEventListener('touchend', e => {
    if (!swiping) { sx = 0; return; }
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      const vis = visibleViews();
      const at = Math.max(0, vis.findIndex(v => v.key === currentView));
      const next = dx < 0 ? Math.min(at + 1, vis.length - 1) : Math.max(at - 1, 0);
      goTab(vis[next].key, true);
    }
    sx = 0; swiping = false;
  }, { passive: true });
}

/* ── Touch-offset guard (iOS keyboard / zoom drift) ──
 * On iOS, focusing an input scrolls the document (even a position:fixed
 * one) to bring the field above the keyboard, and it does not always
 * scroll back when the keyboard is dismissed. From then on the page is
 * painted offset from where it is hit-tested, so taps land on the wrong
 * element until something happens to reset the scroll. Reset it ourselves
 * whenever the keyboard goes away, the visual viewport changes, or the
 * device rotates — but never while a field is being edited, because that
 * scroll is what keeps the field visible. */
function isEditableEl(el) {
  if (!el || el === document.body) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || !!el.isContentEditable;
}

function resetViewportScroll() {
  if (isEditableEl(document.activeElement)) return;
  const de = document.documentElement, b = document.body;
  const off = window.scrollX || window.scrollY || (de && de.scrollTop) || (b && b.scrollTop);
  if (!off) return;
  try { window.scrollTo(0, 0); } catch (e) {}
  if (de) de.scrollTop = 0;
  if (b) b.scrollTop = 0;
}

export function initViewportGuard() {
  // Keyboard is dismissed via blur — iOS animates it out over ~250ms, and
  // the stray scroll can land at any point in that window.
  document.addEventListener('focusout', () => {
    [40, 160, 320].forEach(ms => setTimeout(resetViewportScroll, ms));
  }, true);

  // Visual viewport resize fires when the keyboard opens/closes and when
  // the page zooms; scroll fires when the visual viewport pans around.
  const vv = window.visualViewport;
  if (vv) {
    let _vt;
    const onVv = () => { clearTimeout(_vt); _vt = setTimeout(resetViewportScroll, 60); };
    vv.addEventListener('resize', onVv);
    vv.addEventListener('scroll', onVv);
  }
  window.addEventListener('orientationchange', () => setTimeout(resetViewportScroll, 300));

  // Belt-and-braces: a window scroll on a page that cannot scroll is always
  // WebKit's own doing.
  window.addEventListener('scroll', () => setTimeout(resetViewportScroll, 0), { passive: true });
}
