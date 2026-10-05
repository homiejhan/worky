/* views.js — Which tabs are on the phone's bottom bar, the ☰ menu with every tab, mobile
 * tabs and swipe, desktop panel navigation, the touch-offset guard. */
import { $, isMobileLayout } from './util.js';
import { homeDesktopOpen, homeToggleDesktop, renderHome } from './home.js';
import { calDesktopOpen, calRenderMobile, calToggleDesktop } from './calendar.js';
import { budgetDesktopOpen, budgetToggleDesktop, renderBudget } from './budget.js';
import { digestDesktopOpen, digestOn, digestToggleDesktop, renderDigest } from './digest.js';

/* The tabs, in tab-bar order. Every one of them is always reachable: on a
 * phone through the ☰ menu (and the bottom bar), on a computer through the
 * sidebar. The one exception is Digest, which exists while the email digest
 * is on (digest.enabled, digest.js). On mobile every tab is one swipe panel,
 * and currentView holds the key of the one showing. */
export const VIEW_DEFS = [
  { key: 'home',     label: 'Home' },
  { key: 'timers',   label: 'Timers' },
  { key: 'lists',    label: 'Lists' },
  { key: 'daily',    label: 'Daily' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'budget',   label: 'Budget' },
  { key: 'digest',   label: 'Digest' },
];
/* views — which tabs sit on the phone's bottom bar (Settings → Sections).
 * Home always does, so it isn't stored. Synced with the state. */
export let views = { timers: true, daily: true, lists: true, calendar: true, budget: true, digest: true };
export function setViews(v) { views = v; }
export let currentView = 'home';

/* Desktop: Lists and Daily are separate pages that share the right panel.
 * desktopPage says which one it shows whenever no overlay (Home, Calendar,
 * Budget, Digest) is covering it. */
let desktopPage = 'lists';

/* Keep the sidebar nav in step with whichever desktop panel is showing. */
export function desktopNavSync() {
  const base = !homeDesktopOpen && !calDesktopOpen && !budgetDesktopOpen && !digestDesktopOpen;
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
  if (digestDesktopOpen) digestToggleDesktop(false);
  homeToggleDesktop(false);                       // ends in desktopNavSync()
  const rp = $('rightPanel');
  if (rp) rp.scrollTop = 0;
}
export function showDesktopLists() { showDesktopPage('lists'); }
export function showDesktopDaily() { showDesktopPage('daily'); }

/* ───────────────────────── VIEWS + MOBILE TABS ───────────────────────── */
export function normalizeViews(v) {
  const out = { timers: true, daily: true, lists: true, calendar: true, budget: true, digest: true };
  if (Array.isArray(v)) {                       // compressed form: list of keys off the bar
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
/* Is there such a tab at all (in the ☰ menu, the sidebar, a panel to show)? */
export function viewExists(key) {
  if (!VIEW_DEFS.some(v => v.key === key)) return false;
  return key === 'digest' ? digestOn() : true;
}
/* Is it on the phone's bottom bar? (Settings → Sections) */
export function viewEnabled(key) {
  if (!key) return true;
  if (key === 'home') return true;              // Home always is
  return viewExists(key) && views[key] !== false;
}

/* Show/hide every element tagged with data-view (only Digest can be gone),
 * close the Digest page if the digest was switched off, and rebuild the
 * mobile tab strip and the ☰ menu. */
export function applyViewVisibility() {
  document.querySelectorAll('[data-view]').forEach(el => {
    if (el.classList.contains('swipe-panel') || el.classList.contains('tab-btn')) return;
    el.style.display = viewExists(el.dataset.view) ? '' : 'none';
  });
  if (!viewExists('digest') && digestDesktopOpen) digestToggleDesktop(false);
  desktopNavSync();
  if (!viewExists(currentView)) currentView = 'home';
  setSwipePanelWidths();
  renderSideMenu();
  renderHome();
}

function swipeFrameWidth() {
  const c = $('swipeContainer');
  return (c && c.clientWidth) || window.innerWidth;
}

/* Mobile: the swipe track holds the bottom bar's tabs, the one showing (it
 * may have come from the ☰ menu), and while a slide runs, the two it runs
 * between. Swiping moves through it in tab order. */
let keepInTrack = [];
let slideTimer = null;
function trackViews() {
  return VIEW_DEFS.map(v => v.key).filter(k => viewExists(k) && (viewEnabled(k) || k === currentView || keepInTrack.includes(k)));
}
function placeTrack(showKey, animate) {
  const w = swipeFrameWidth();
  const keys = trackViews();
  const track = $('swipeTrack');
  document.querySelectorAll('.swipe-panel').forEach(p => {
    const on = keys.includes(p.dataset.view);
    p.style.display = on ? '' : 'none';
    if (on) p.style.width = w + 'px';
  });
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.style.display = viewEnabled(b.dataset.view) ? '' : 'none';
    b.classList.toggle('active', b.dataset.view === currentView);
  });
  if (track) {
    track.style.width = (w * keys.length) + 'px';
    track.style.transition = animate ? 'transform 0.32s cubic-bezier(0.3,0.7,0.4,1)' : 'none';
    track.style.transform = `translateX(${-Math.max(0, keys.indexOf(showKey)) * w}px)`;
  }
}
export function setSwipePanelWidths() { placeTrack(currentView, false); }

/* Mobile: go to a tab (Home when there is no such tab). */
export function goTab(key, animate) {
  if (!viewExists(key)) key = 'home';
  const from = currentView;
  currentView = key;
  clearTimeout(slideTimer);
  const track = $('swipeTrack');
  if (animate !== false && from !== key && track) {
    keepInTrack = [from, key];                    // both in the track, still on `from`…
    placeTrack(from, false);
    void track.offsetWidth;                       // (start position committed)
    placeTrack(key, true);                        // …then slide
    slideTimer = setTimeout(() => { keepInTrack = []; placeTrack(currentView, false); }, 360);
  } else {
    keepInTrack = [];
    placeTrack(key, false);
  }
  renderSideMenu();
  if (key === 'calendar') calRenderMobile({ fresh: true });   // opening the tab starts at 7am
  if (key === 'home')     renderHome();
  if (key === 'budget')   renderBudget();
  if (key === 'digest')   renderDigest();
}

/* Home, from the logo, on whichever layout is showing. */
export function goHome() {
  closeSideMenu();
  if (isMobileLayout()) goTab('home', true);
  else homeToggleDesktop(true);
}

/* ── the ☰ menu (phones): every tab, in a panel from the left ── */
let sideMenuOpen = false;
export function renderSideMenu() {
  const list = $('sideMenuList');
  if (!list) return;
  list.innerHTML = VIEW_DEFS.filter(v => viewExists(v.key)).map(v => {
    const ico = document.querySelector(`.tab-btn[data-view="${v.key}"] .tab-ico`);
    const on = v.key === currentView;
    return `
      <button class="side-menu-item tab-${v.key}${on ? ' active' : ''}" data-menu-view="${v.key}"${on ? ' aria-current="page"' : ''}>
        <span class="side-menu-ico" aria-hidden="true">${ico ? ico.innerHTML : ''}</span>
        <span class="side-menu-label">${v.label}</span>
      </button>`;
  }).join('');
}
export function openSideMenu() {
  if (sideMenuOpen) return;
  sideMenuOpen = true;
  renderSideMenu();
  $('sideMenu')?.classList.add('open');
  $('sideMenuScrim')?.classList.add('open');
  $('menuBtn')?.setAttribute('aria-expanded', 'true');
  ($('sideMenu')?.querySelector('.side-menu-item.active') || $('sideMenu')?.querySelector('.side-menu-item'))?.focus();
}
export function closeSideMenu(refocus) {
  if (!sideMenuOpen) return;
  sideMenuOpen = false;
  $('sideMenu')?.classList.remove('open');
  $('sideMenuScrim')?.classList.remove('open');
  $('menuBtn')?.setAttribute('aria-expanded', 'false');
  if (refocus) $('menuBtn')?.focus();
}
export function toggleSideMenu() { if (sideMenuOpen) closeSideMenu(true); else openSideMenu(); }
export function bindSideMenu() {
  $('menuBtn')?.addEventListener('click', toggleSideMenu);
  $('sideMenuScrim')?.addEventListener('click', () => closeSideMenu(true));
  $('sideMenuBrand')?.addEventListener('click', goHome);
  $('sideMenuList')?.addEventListener('click', e => {
    const b = e.target.closest('[data-menu-view]');
    if (!b) return;
    closeSideMenu();
    goTab(b.dataset.menuView, false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sideMenuOpen) closeSideMenu(true); });
  /* a swipe to the left closes it, like the panel it is */
  const menu = $('sideMenu');
  let sx = 0, sy = 0;
  menu?.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  menu?.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (dx < -40 && Math.abs(dx) > Math.abs(dy)) closeSideMenu();
  }, { passive: true });
}

/* Total-balance chip on Home opens Budget on whichever layout is active. */
export function openBudgetTab() {
  if (isMobileLayout()) goTab('budget', true);
  else budgetToggleDesktop(true);
}
/* So does the Email digest button, the Digest tab. */
export function openDigestTab() {
  if (!viewExists('digest')) return;
  if (isMobileLayout()) goTab('digest', true);
  else digestToggleDesktop(true);
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
      const keys = trackViews();
      const at = Math.max(0, keys.indexOf(currentView));
      const next = keys[dx < 0 ? Math.min(at + 1, keys.length - 1) : Math.max(at - 1, 0)];
      if (next !== currentView) goTab(next, true);
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
