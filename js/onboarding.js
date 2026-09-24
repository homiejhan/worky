/* onboarding.js — First run: the starter profile and the guided tour. */
import { $, calDateKey, calMinsToStr, calToday, closeModal, isMobileLayout } from './util.js';
import { setTimerDefaults, setTimers, setWokenUp, TIMER_DEFAULTS } from './timers.js';
import {
  makeTasks, nextTodoId, setTaskIdCounter, setTodoIdCounter, setTodoLists,
} from './lists.js';
import { commitFormatMode, formatMode } from './formats.js';
import { dbdTodayKey, nextDbdId, setDbdIdCounter, setDbdTasks } from './dbd.js';
import { homeToggleDesktop } from './home.js';
import { goTab, normalizeViews, setViews, showDesktopPage, viewEnabled } from './views.js';
import {
  calDesktopOpen, calEnsureDay, calEvents, calSave, calToggleDesktop, nextCalEventId,
  setCalEventIdCtr, setCalEvents, setCalTemplates,
} from './calendar.js';
import {
  budgetToggleDesktop, nextPurchaseId, normalizeBudget, setBudget, setPurchaseIdCounter,
} from './budget.js';
import { syncPendingRemote } from './sync.js';
import { normalizeTheme, setTheme, themeIsHex, themeLuma } from './theme.js';
import { DEFAULT_TEMPLATE, formatTemplateById } from './templates.js';

/* ───────────────────────── ONBOARDING ─────────────────────────
 * First run on a device (no saved state) → seed a starter profile that
 * shows a little of every feature, then offer a guided tour.
 *
 * The starter profile is ordinary state: it goes through the same save /
 * sync / export paths as anything the user builds, so there is nothing
 * special to unwind — rename, delete or "Clear storage" as usual.
 *
 * The tour flag is device-local (TOUR_LS_KEY), deliberately outside the
 * synced state: a new device is a new first run even for a returning cloud
 * user, and Skip is one tap. Settings → "Take the tour" replays it. */
const TOUR_LS_KEY = 'focus-tour-done';

function starterDateKey(offset) {
  const d = calToday(); d.setDate(d.getDate() + offset); return calDateKey(d);
}

/* Build the starter state in place: the default Formats template (Working
 * student, see templates.js) plus a little sample content. Dates are relative
 * to today so the profile always looks live: something due today, deadlines
 * coming up, an event in the next few hours. */
export function applyStarterProfile() {
  const today = dbdTodayKey();
  const tp = formatTemplateById(DEFAULT_TEMPLATE);

  /* timers */
  setTimerDefaults(tp.timers.map(t => ({ label: t.label, seconds: t.seconds, color: t.color })));
  setTimers(TIMER_DEFAULTS.map((t, i) => ({
    id: i, label: t.label, seconds: t.seconds, color: t.color,
    running: false, startedAt: null, secondsAtStart: null,
  })));
  setWokenUp(false);

  /* lists — the template's Daily lists and its Deadlines list, with sample
   * deadlines (a list task with a date also shows in Day by Day and on Home) */
  setTodoIdCounter(0);
  setTaskIdCounter(0);
  const mk = (title, color, texts, extra) => ({
    id: nextTodoId(), title, color,
    isDefault: false, starred: false, activeDays: null,
    tasks: makeTasks(texts),
    ...extra,
  });
  const daily = tp.daily.map(d => mk(d.title, d.color, d.tasks, {
    isDefault: true, starred: !!d.starred,
    activeDays: Array.isArray(d.activeDays) ? d.activeDays.slice() : null,   // Sunday planning: Sundays only
  }));
  const lists = tp.lists.map(l => mk(l.title, l.color, [], { starred: !!l.starred }));
  const deadlines = lists.find(l => l.title === 'Deadlines');
  deadlines.tasks = makeTasks(['Problem set 3', 'Lab report draft', 'Read chapter 5']);
  deadlines.tasks[0].due = starterDateKey(2);
  deadlines.tasks[1].due = starterDateKey(5);
  setTodoLists([
    ...daily,
    ...lists,
    mk('Someday', '#505050', ['Look up study-abroad deadlines', 'Plan a weekend trip']),
  ]);

  /* day by day */
  setDbdIdCounter(1);
  setDbdTasks([
    { id: nextDbdId(), text: 'Take a look around Focus',                   due: today,             done: false },
    { id: nextDbdId(), text: 'Connect Google Calendar to bring in shifts', due: starterDateKey(1), done: false },
    { id: nextDbdId(), text: 'Mark a shift as paid and add your wage',     due: starterDateKey(2), done: false },
  ]);

  /* calendar — the template's weekly blocks plus one event in the next few hours */
  setCalEvents({});
  setCalEventIdCtr(1);
  setCalTemplates(tp.cal.map(c => ({
    id: nextCalEventId(), title: c.title, start: c.start, end: c.end, color: c.color,
    type: c.type || 'event', isTemplate: true, repeatDays: c.repeatDays.slice(),
  })));
  calEnsureDay(today);
  const startMins = Math.min((new Date().getHours() + 1) * 60, 22 * 60);
  calEvents[today].push({
    id: nextCalEventId(), title: 'Explore the calendar',
    start: calMinsToStr(startMins), end: calMinsToStr(startMins + 45),
    color: '#5DCAA5', type: 'event',
  });

  /* budget — the envelope is on, with a small balance to play with */
  setPurchaseIdCounter(1);
  setBudget(normalizeBudget({
    initial: 60, daily: 20, todayAllowance: null, lastDate: today,
    purchases: [{ id: nextPurchaseId(), title: 'Coffee', amount: 4.5 }],
  }));

  const views = normalizeViews(null);
  tp.views.forEach(v => { views[v] = true; });
  setViews(views);
  setTheme(normalizeTheme(null));
  calSave();
}

/* ── Guided tour ──
 * A spotlight (one element with a huge box-shadow) plus a card. Each step
 * names the view it lives in; the tour switches to that view on whichever
 * layout is active, then measures the target after the DOM settles. */
const TOUR_ICONS = {
  home:     '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 7.2L8 2.6l5.5 4.6v5.6a1 1 0 0 1-1 1H9.8V9.6H6.2v4.2H3.5a1 1 0 0 1-1-1V7.2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  timers:   '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.5v3l2 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.2 1.8h3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  daily:    '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  dbd:      '<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 10l1.7 1.7L10.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lists:    '<svg viewBox="0 0 16 16" fill="none"><path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="2.6" cy="4" r="1.1" fill="currentColor"/><circle cx="2.6" cy="8" r="1.1" fill="currentColor"/><circle cx="2.6" cy="12" r="1.1" fill="currentColor"/></svg>',
  calendar: '<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12" stroke="currentColor" stroke-width="1.5"/><path d="M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  budget:   '<svg viewBox="0 0 16 16" fill="none"><rect x="1.5" y="4" width="13" height="9.5" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M1.5 7h13" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="10.4" r="1.1" fill="currentColor"/></svg>',
  formats:  '<svg viewBox="0 0 16 16" fill="none"><path d="M3 12.5l1-3.5L11.2 1.8a1.4 1.4 0 0 1 2 2L6 11l-3 1.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 3.5l3 3" stroke="currentColor" stroke-width="1.5"/></svg>',
  settings: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  data:     '<svg viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="5.5" ry="2.2" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" stroke="currentColor" stroke-width="1.5"/></svg>',
  finish:   '<svg viewBox="0 0 16 16" fill="none"><path d="M8 1.8l1.8 3.7 4 .6-2.9 2.8.7 4L8 11l-3.6 1.9.7-4L2.2 6.1l4-.6L8 1.8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
};
const TOUR_HUES = {
  home: 'var(--accent)', timers: 'var(--hue-timers)', daily: 'var(--hue-daily)', dbd: 'var(--hue-lists)',
  lists: 'var(--hue-lists)', calendar: 'var(--hue-calendar)', budget: 'var(--hue-budget)',
  formats: 'var(--accent)', settings: 'var(--accent-2)', data: 'var(--accent-3)', finish: 'var(--accent)',
};

const TOUR_STEPS = [
  { key: 'home', view: 'home', title: 'Home',
    body: 'Your whole day on one page: progress so far, what\'s due, timers, the next few hours of your calendar and any list you\'ve starred. Everything here is live — tap a task to check it off without leaving Home.',
    target: { d: '#homeContainer-d .home-hero', m: '#homeContainer-m .home-hero' } },
  { key: 'timers', view: 'timers', title: 'Timers',
    body: 'Time budgets for what you want to spend the day on. Press play to start one, tap the time to edit it, and the bar shows how much is left. Mark "Woke up" to see when you\'ll finish everything.',
    target: { d: '#timersSection-d', m: ['#wakeupRow-m', '#timerStack-m'] } },
  { key: 'daily', view: 'daily', title: 'Daily',
    body: 'Routines that reset every day. Star a list to pin it on Home. In Formats you can give a list a schedule — "Sunday planning" only shows up on Sundays. A task named after another Daily list checks itself off when that list is done.',
    target: { d: '#dailySection-d', m: '#dailySection-m' } },
  { key: 'dbd', view: 'lists', title: 'Day by Day',
    body: 'One-off tasks with a date. Overdue ones turn red and wait until you clear them. Use the tag menu to file a task under one of your lists — it keeps its date and still shows up here.',
    target: { d: ['#dbdAddRow-d', '#dbdContainer-d'], m: ['#dbdAddRow-m', '#dbdContainer-m'] } },
  { key: 'lists', view: 'lists', title: 'Lists',
    body: 'Lists for anything. Deadlines is where due dates go: give a task a date and it shows up in Day by Day and on Home too. Star a list to see it on Home, and drag lists or tasks to reorder them.',
    target: { d: '#todoContainer-d', m: '#todoContainer-m' } },
  { key: 'calendar', view: 'calendar', title: 'Calendar',
    body: 'Tap an empty slot to add an event, drag to move one. Mark an event as a paid shift with your wage and the header adds up the week\'s pay. Connect Google Calendar in Settings to see and send events — a When I Work, Sling, 7shifts or Homebase feed counts as shifts.',
    target: { d: '#calDesktopPanel', m: '#mobileCalPanel' } },
  { key: 'budget', view: 'budget', title: 'Budget',
    body: 'A daily envelope. Set a daily amount and a starting balance, log purchases as you go, and whatever is left rolls over at midnight. Add your payday and bills, and Cash runway tells you whether your money lasts until the next paycheck.',
    target: { d: '#budgetContainer-d .budget-wrap', m: '#budgetContainer-m .budget-wrap' } },
  { key: 'formats', title: 'Formats',
    body: 'Formats is where you edit your defaults: which timers exist and how long they run, which Daily lists there are, and the weekly calendar templates. Not sure where to start? Templates has ready-made setups to build on; you started from Working student. Press Done to save. Reset returns the day to whatever you set here.',
    target: { d: '#fmtBtn', m: '#fmtBtn' } },
  { key: 'settings', title: 'Settings',
    body: 'Hide sections you don\'t use, pick a theme or build your own, connect Google Calendar or a bank, and sign in to sync across your devices. Help has how-tos with pictures, the privacy policy, and this tour again.',
    target: { d: '#settingsBtn', m: '#settingsBtn' } },
  { key: 'data', title: 'Your data',
    body: 'Everything lives on this device unless you turn on cloud sync. Export saves a copy you can import anywhere; Reset starts a fresh day without touching your lists.',
    target: { d: ['#exportBtn', '#resetAllBtn'], m: '#moreBtn' } },
  { key: 'finish', view: 'home', title: 'That\'s the tour',
    body: 'The starter setup is only a starting point. Rename the timers, replace the lists, clear the calendar, or wipe it all from Settings → Clear storage. Have a good day.',
    target: null },
];

let tourActive   = false;
let tourIdx      = 0;
let tourSteps    = [];
export let tourReoffer  = false;   // welcome was hidden by the cloud-sync choice modal
export function setTourReoffer(v) { tourReoffer = v; }
let _tourRaf     = 0;
let _tourTimer   = null;

function tourSeen() {
  try { return localStorage.getItem(TOUR_LS_KEY) === '1'; } catch (e) { return false; }
}
export function tourMarkSeen() {
  try { localStorage.setItem(TOUR_LS_KEY, '1'); } catch (e) {}
}

/* Show the welcome card unless the tour was already seen or the cloud-sync
 * choice modal needs the user's attention first (it re-offers afterwards). */
export function tourOffer() {
  if (tourSeen() || tourActive) return;
  if (syncPendingRemote || $('syncChoiceModal')?.classList.contains('show')) { tourReoffer = true; return; }
  tourReoffer = false;
  $('tourWelcomeModal')?.classList.add('show');
}
function tourDismissWelcome() {
  closeModal('tourWelcomeModal');
  tourMarkSeen();
}

function tourStart() {
  document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
  if (formatMode) commitFormatMode();
  tourMarkSeen();
  tourSteps = TOUR_STEPS.filter(s => !s.view || viewEnabled(s.view));
  tourIdx = 0;
  tourActive = true;
  $('tourOverlay')?.classList.add('show');
  document.body.classList.add('tour-on');
  window.addEventListener('resize', tourRelayout);
  document.addEventListener('scroll', tourRelayout, true);
  document.addEventListener('keydown', tourKeydown);
  tourShowStep();
}

function tourEnd() {
  if (!tourActive) return;
  tourActive = false;
  clearTimeout(_tourTimer);
  cancelAnimationFrame(_tourRaf);
  $('tourOverlay')?.classList.remove('show');
  document.body.classList.remove('tour-on');
  window.removeEventListener('resize', tourRelayout);
  document.removeEventListener('scroll', tourRelayout, true);
  document.removeEventListener('keydown', tourKeydown);
  tourGoView('home');
}

function tourNext() {
  if (tourIdx >= tourSteps.length - 1) { tourEnd(); return; }
  tourIdx++;
  tourShowStep();
}
function tourPrev() {
  if (tourIdx === 0) return;
  tourIdx--;
  tourShowStep();
}

function tourKeydown(e) {
  if (!tourActive) return;
  if (e.key === 'Escape')                       { e.preventDefault(); tourEnd(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); tourNext(); }
  else if (e.key === 'ArrowLeft')               { e.preventDefault(); tourPrev(); }
}

/* Switch whichever layout is active to the view a step lives in. Desktop
 * views are overlays over the right panel, so opening one closes the rest. */
function tourGoView(view) {
  if (!view) return;
  if (isMobileLayout()) { goTab(view, false); return; }
  switch (view) {
    case 'home':
    case 'timers':
      homeToggleDesktop(true); break;
    case 'calendar':
      if (!calDesktopOpen) calToggleDesktop(); break;
    case 'budget':
      budgetToggleDesktop(true); break;
    default:                                   // daily / lists are pages of the right panel
      showDesktopPage(view);
  }
}

function tourTargets(step) {
  if (!step.target) return [];
  const sel = step.target[isMobileLayout() ? 'm' : 'd'];
  const list = Array.isArray(sel) ? sel : [sel];
  return list.map(s => document.querySelector(s)).filter(el => el && el.getClientRects().length > 0);
}

function tourShowStep() {
  const step = tourSteps[tourIdx];
  if (!step) { tourEnd(); return; }
  $('dataBar')?.classList.remove('open');
  tourGoView(step.view);

  const total = tourSteps.length;
  const prog = $('tourProgress');
  if (prog) prog.innerHTML = tourSteps.map((_, i) => `<i class="${i <= tourIdx ? 'on' : ''}${i === tourIdx ? ' cur' : ''}"></i>`).join('');
  const hue = TOUR_HUES[step.key] || 'var(--accent)';
  const card = $('tourCard'); if (card) card.style.setProperty('--sc', hue);
  /* resolve the hue to a hex so the button/icon ink stays readable on light fills (yellows) */
  let hueHex = hue;
  const m = /^var\((--[\w-]+)\)$/.exec(hue);
  if (m) hueHex = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  const scInk = themeIsHex(hueHex) && themeLuma(hueHex) > 0.55 ? '#1f1700' : '#ffffff';
  if (card) card.style.setProperty('--sc-ink', scInk);
  const spot = $('tourSpot'); if (spot) spot.style.setProperty('--sc', hue);
  const ico  = $('tourIcon');  if (ico)  ico.innerHTML = TOUR_ICONS[step.key] || '';
  const title = $('tourTitle'); if (title) title.textContent = step.title;
  const body  = $('tourBody');  if (body)  body.textContent  = step.body;
  const count = $('tourCount'); if (count) count.textContent = `Step ${tourIdx + 1} of ${total}`;
  const back  = $('tourBackBtn'); if (back) back.style.visibility = tourIdx === 0 ? 'hidden' : '';
  const next  = $('tourNextBtn'); if (next) next.textContent = tourIdx === total - 1 ? 'Finish' : 'Next';
  const skip  = $('tourSkipBtn'); if (skip) skip.style.visibility = tourIdx === total - 1 ? 'hidden' : '';
  if (card) { card.style.animation = 'none'; void card.offsetWidth; card.style.animation = ''; }

  /* let the view switch / render settle, then bring the target into view and measure */
  clearTimeout(_tourTimer);
  _tourTimer = setTimeout(() => {
    const els = tourTargets(step);
    if (els[0]) { try { els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
    tourRelayout();
  }, 60);
}

function tourRelayout() {
  if (!tourActive) return;
  cancelAnimationFrame(_tourRaf);
  _tourRaf = requestAnimationFrame(tourLayout);
}

function tourLayout() {
  const step = tourSteps[tourIdx];
  const spot = $('tourSpot');
  const card = $('tourCard');
  if (!step || !spot || !card) return;

  const vw = window.innerWidth, vh = window.innerHeight;
  const els = tourTargets(step);
  let rect = null;
  if (els.length) {
    const rs = els.map(el => el.getBoundingClientRect());
    const pad = 6;
    rect = {
      left:   Math.max(4,      Math.min(...rs.map(r => r.left))   - pad),
      top:    Math.max(4,      Math.min(...rs.map(r => r.top))    - pad),
      right:  Math.min(vw - 4, Math.max(...rs.map(r => r.right))  + pad),
      bottom: Math.min(vh - 4, Math.max(...rs.map(r => r.bottom)) + pad),
    };
    if (rect.right - rect.left < 8 || rect.bottom - rect.top < 8) rect = null;
  }

  spot.classList.toggle('none', !rect);
  if (rect) {
    spot.style.left   = rect.left + 'px';
    spot.style.top    = rect.top + 'px';
    spot.style.width  = (rect.right - rect.left) + 'px';
    spot.style.height = (rect.bottom - rect.top) + 'px';
  }

  /* card placement: mobile pins it above the data bar; desktop tries beside,
   * below, above the spotlight, and finally the screen centre */
  card.classList.toggle('bottom', isMobileLayout());
  if (isMobileLayout()) { card.style.left = card.style.top = ''; return; }

  const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
  let left, top;
  if (!rect) {
    left = (vw - cw) / 2; top = (vh - ch) / 2;
  } else if (rect.right + gap + cw <= vw - 16) {                 // right of target
    left = rect.right + gap; top = Math.min(Math.max(16, rect.top), vh - ch - 60);
  } else if (rect.bottom + gap + ch <= vh - 60) {                // below
    left = Math.min(Math.max(16, rect.left), vw - cw - 16); top = rect.bottom + gap;
  } else if (rect.top - gap - ch >= 16) {                        // above
    left = Math.min(Math.max(16, rect.left), vw - cw - 16); top = rect.top - gap - ch;
  } else if (rect.left - gap - cw >= 16) {                       // left of target
    left = rect.left - gap - cw; top = Math.min(Math.max(16, rect.top), vh - ch - 60);
  } else {                                                       // huge target → centre over it
    left = (vw - cw) / 2; top = Math.max(16, Math.min(vh - ch - 60, (rect.top + rect.bottom - ch) / 2));
  }
  card.style.left = Math.round(left) + 'px';
  card.style.top  = Math.round(top) + 'px';
}

export function bindTour() {
  $('tourStartBtn')?.addEventListener('click', tourStart);
  $('tourSkipWelcomeBtn')?.addEventListener('click', tourDismissWelcome);
  $('tourWelcomeModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) tourMarkSeen(); });
  $('tourReplayBtn')?.addEventListener('click', tourStart);
  $('tourNextBtn')?.addEventListener('click', tourNext);
  $('tourBackBtn')?.addEventListener('click', tourPrev);
  $('tourSkipBtn')?.addEventListener('click', tourEnd);
  $('tourOverlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) tourNext(); });
  /* Escape on the welcome card counts as a skip (the generic handler closes it) */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('tourWelcomeModal')?.classList.contains('show')) tourMarkSeen();
  });
}
