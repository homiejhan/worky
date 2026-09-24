/* formats.js — Formats: the mode that edits the default timers, Daily lists and weekly
 * calendar templates. */
import { $, getRemaining, showToast } from './util.js';
import { saveToLocal } from './persistence.js';
import { renderTimers, setTimerDefaults, TIMER_DEFAULTS, timers, updateTimerUI } from './timers.js';
import { nextTodoId, renderTodos, setTodoLists, todoLists } from './lists.js';
import { currentView } from './views.js';
import {
  calDesktopOpen, calRenderDesktop, calRenderMobile, setCalFmtMobileDay,
} from './calendar.js';
import { syncCommitFormat, syncFlushPending, syncUpdateUI } from './sync.js';
import { digestInboxFlush } from './digest.js';

export let formatMode = false;
export let formatTimerIdCounter = 900;
export function nextFormatTimerId() { return formatTimerIdCounter++; }
export let preFormatTimerState = [];   // live timer progress, parked while Formats shows the defaults
export function setPreFormatTimerState(v) { preFormatTimerState = v; }

/* ───────────────────────── FORMAT MODE ───────────────────────── */
export function toggleFormatMode() {
  if (formatMode) commitFormatMode();
  else enterFormatMode();
}

function enterFormatMode() {
  // Anything already queued for the cloud reflects pre-Formats state —
  // send it now so no edit made inside Formats can ride along with it.
  syncFlushPending();

  // snapshot live remaining times
  preFormatTimerState = timers.map(t => ({
    id: t.id,
    seconds: Math.round(getRemaining(t)),
    running: t.running,
    startedAt: t.startedAt,
    secondsAtStart: t.secondsAtStart,
    over: t.over || 0,             // time past zero before the current run
  }));

  // pause everything
  timers.forEach(t => {
    if (t.running) {
      t.seconds = getRemaining(t);
      t.running = false;
      updateTimerUI(t.id);
    }
  });

  // show defaults in displays + set t.seconds to defaults for editing
  timers.forEach((t, i) => {
    const def = TIMER_DEFAULTS[i];
    if (def) t.seconds = def.seconds;
    t.over = 0;
  });

  formatMode = true;
  document.body.classList.add('format-mode');
  const btn = $('fmtBtn');
  if (btn) { btn.textContent = 'Done'; btn.classList.add('active'); }

  renderTimers();
  renderTodos();
  setCalFmtMobileDay(0);
  if (calDesktopOpen) calRenderDesktop();
  if (currentView === 'calendar') calRenderMobile();
  syncUpdateUI();
}

export function commitFormatMode() {
  // adopt format-mode values as the new defaults
  setTimerDefaults(timers.map(t => ({ label: t.label, seconds: t.seconds, color: t.color })));

  formatMode = false;
  document.body.classList.remove('format-mode');
  const btn = $('fmtBtn');
  if (btn) { btn.textContent = 'Formats'; btn.classList.remove('active'); }

  // restore live progress
  timers.forEach(t => {
    const pre = preFormatTimerState.find(p => p.id === t.id);
    if (pre) {
      t.seconds = pre.seconds;
      t.running = pre.running;
      t.startedAt = pre.startedAt;
      t.secondsAtStart = pre.secondsAtStart;
      t.over = pre.over || 0;
    }
  });
  preFormatTimerState = [];

  renderTimers();
  renderTodos();
  if (calDesktopOpen) calRenderDesktop();
  if (currentView === 'calendar') calRenderMobile();
  saveToLocal();
  const overrode = syncCommitFormat();   // Done = the one moment Formats reaches the cloud
  digestInboxFlush();                    // a digest delivered during Formats can land now
  showToast(overrode ? 'Format saved ✓ · replaced a newer cloud copy' : 'Format saved ✓');
}

export function addFormatTimer() {
  if (!formatMode) return;
  const id = formatTimerIdCounter++;
  const newT = { id, label: 'New Timer', seconds: 3600, color: '#5DCAA5', running: false, startedAt: null, secondsAtStart: null };
  timers.push(newT);
  TIMER_DEFAULTS.push({ label: newT.label, seconds: newT.seconds, color: newT.color });
  renderTimers();
  saveToLocal();
}

export function removeFormatTimer(id) {
  if (!formatMode) return;
  if (timers.length <= 1) { showToast('Need at least one timer.'); return; }
  const idx = timers.findIndex(t => t.id === id);
  if (idx === -1) return;
  timers.splice(idx, 1);
  TIMER_DEFAULTS.splice(idx, 1);
  preFormatTimerState = preFormatTimerState.filter(p => p.id !== id);
  renderTimers();
  saveToLocal();
}

export function addFormatDaily() {
  if (!formatMode) return;
  const id = nextTodoId();
  todoLists.push({ id, title: 'New List', color: '#5DCAA5', isDefault: true, activeDays: null, tasks: [] });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = $(`todo-title-${id}-d`) || $(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

export function removeFormatDaily(id) {
  if (!formatMode) return;
  setTodoLists(todoLists.filter(l => l.id !== id));
  renderTodos();
  saveToLocal();
}
