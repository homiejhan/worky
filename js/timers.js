/* timers.js — Timer state and cards, the woke-up checkbox and the time-remaining summary. */
import {
  $, calDateKey, calToday, escAttr, fmt, getOvertime, getRemaining, parseTime, pauseIcon, playIcon,
  resetIcon,
} from './util.js';
import { saveToLocal } from './persistence.js';
import { formatMode } from './formats.js';
import { renderHome } from './home.js';

export let TIMER_DEFAULTS = [
  { label: 'Productivity Timer',   seconds: 5*3600, color: '#378ADD' },
  { label: 'Personal Development', seconds: 3*3600, color: '#EC3636' },
  { label: 'Time with God',        seconds: 2*3600, color: '#8B5CF6' },
  { label: 'Skill Development',    seconds: 1*3600, color: '#F97316' },
];
export function setTimerDefaults(v) { TIMER_DEFAULTS = v; }
export let wokenUp = false;
export function setWokenUp(v) { wokenUp = v; }

export let timers = TIMER_DEFAULTS.map((t, i) => ({
  id: i, label: t.label, seconds: t.seconds, color: t.color,
  running: false, startedAt: null, secondsAtStart: null
}));
export function setTimers(v) { timers = v; }

/* Days a timer ran past zero, kept two weeks for the overrun insight (insights.js):
 * { 'YYYY-MM-DD': { key: { label, over, budget } } }. `key` is the label in lower
 * case, so a timer keeps its history through Formats and templates; `over` is the
 * most it went over that day, in seconds, and `budget` its default length. */
export let timerLog = {};
export function setTimerLog(v) { timerLog = v; }
const TIMER_LOG_DAYS = 14;
const TIMER_LOG_MAX_OVER = 4 * 3600;   // a timer left running all night shouldn't skew the average
export function normalizeTimerLog(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  Object.entries(v).forEach(([day, entries]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !entries || typeof entries !== 'object') return;
    const e = {};
    Object.entries(entries).forEach(([key, r]) => {
      if (!key || !r || typeof r !== 'object') return;
      e[key] = {
        label: String(r.label ?? key).slice(0, 60),
        over: Math.min(TIMER_LOG_MAX_OVER, Math.max(0, Math.round(Number(r.over) || 0))),
        budget: Number.isFinite(r.budget) && r.budget > 0 ? Math.round(r.budget) : null,
      };
    });
    if (Object.keys(e).length) out[day] = e;
  });
  return out;
}
/* Note in today's log that `t` went over, keeping the day's largest overrun.
 * Called when a running timer reaches zero and whenever one that went over is
 * paused, edited or reset, so the synced state doesn't change every second. */
export function timerLogOver(t) {
  if (!t || !(getOvertime(t) > 0 || (t.running && getRemaining(t) <= 0))) return;
  const today = calDateKey(calToday());
  const cutoff = new Date(calToday()); cutoff.setDate(cutoff.getDate() - TIMER_LOG_DAYS);
  const oldest = calDateKey(cutoff);
  const log = {};
  Object.entries(timerLog).forEach(([day, e]) => { if (day > oldest) log[day] = e; });
  const key = (t.label || '').trim().toLowerCase() || `timer ${t.id}`;
  const prev = log[today] && log[today][key];
  const def = timerDefault(t.id);
  log[today] = { ...(log[today] || {}), [key]: {
    label: t.label || 'Timer',
    over: Math.min(TIMER_LOG_MAX_OVER, Math.max(prev ? prev.over : 0, Math.round(getOvertime(t)))),
    budget: def && def.seconds > 0 ? def.seconds : (prev ? prev.budget : null),
  } };
  timerLog = log;
}

/* ───────────────────────── TIMERS ───────────────────────── */
function timerById(id) { return timers.find(x => x.id === id); }
/* A timer's default (template) record: TIMER_DEFAULTS runs parallel to timers. */
function timerDefault(id) { return TIMER_DEFAULTS[timers.findIndex(x => x.id === id)]; }

/* What a timer shows: time left, or +time over once it has passed zero. */
export function timerDisplayText(t) {
  const over = getOvertime(t);
  return getRemaining(t) <= 0 && over >= 1 ? '+' + fmt(over) : fmt(getRemaining(t));
}
export function timerIsOver(t) { return getRemaining(t) <= 0 && getOvertime(t) >= 1; }

/* Fraction of the timer's default budget still remaining (0–1). */
function timerPct(t) {
  const def = timerDefault(t.id);
  const total = def && def.seconds > 0 ? def.seconds : (t.secondsAtStart || t.seconds || 0);
  if (!total) return 0;
  return Math.max(0, Math.min(1, getRemaining(t) / total));
}
function timerPaintProgress(t) {
  const w = (timerPct(t) * 100).toFixed(1) + '%';
  document.querySelectorAll(`.tfill-${t.id}`).forEach(el => { if (el.style.width !== w) el.style.width = w; });
}

function timerCardHTML(t, pfx) {
  return `
    <div class="timer-header">
      <div class="color-swatch" style="background:${t.color}">
        <input type="color" value="${t.color}" oninput="changeTimerColor(${t.id}, this.value)">
      </div>
      <input class="timer-title-input" value="${escAttr(t.label)}" placeholder="Timer name"
        oninput="setTimerLabel(${t.id}, this.value)">
    </div>
    <div class="timer-body">
      <div class="timer-accent-bar tbar-${t.id}" style="background:${t.color}"></div>
      <div class="timer-display tdisp-${t.id}" onclick="startEditTimer(${t.id}, '${pfx}')">${timerDisplayText(t)}</div>
      <input class="timer-time-edit tedit-${t.id}-${pfx}" type="text" placeholder="h:mm:ss"
        onblur="commitEditTimer(${t.id}, '${pfx}')"
        onkeydown="if(event.key==='Enter') commitEditTimer(${t.id}, '${pfx}')">
      <button class="play-btn playbtn-${t.id} ${t.running ? 'running' : ''}" onclick="toggleTimer(${t.id})" title="Start / pause">
        ${t.running ? pauseIcon() : playIcon()}
      </button>
      <button class="reset-btn" onclick="resetTimer(${t.id})" title="Reset">${resetIcon()}</button>
      <button class="fmt-remove-timer" onclick="removeFormatTimer(${t.id})" title="Remove timer">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="timer-progress"><div class="timer-progress-fill tfill-${t.id}" style="width:${(timerPct(t) * 100).toFixed(1)}%"></div></div>
    <div class="timer-sub tsub-${t.id}">${timerSubText(t)}</div>`;
}
function timerSubText(t) {
  if (timerIsOver(t)) return t.running ? 'Over budget · still running' : `Paused · ${fmt(getOvertime(t))} over budget`;
  return t.running ? 'Running' : 'Paused · tap the time to edit';
}

export function renderTimers() {
  [['timerStack-d','d'],['timerStack-m','m']].forEach(([stackId, pfx]) => {
    const stack = $(stackId);
    if (!stack) return;
    stack.innerHTML = '';
    timers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'timer-card tcard-' + t.id + (t.running ? ' running' : '') + (timerIsOver(t) ? ' over' : '');
      card.style.setProperty('--tc', t.color);
      card.innerHTML = timerCardHTML(t, pfx);
      stack.appendChild(card);
    });
  });
  renderHome();
}

export function setTimerLabel(id, value) {
  const t = timerById(id);
  if (!t) return;
  t.label = value;
  const def = timerDefault(id);
  if (formatMode && def) def.label = value;
  saveToLocal();
}

export function changeTimerColor(id, color) {
  document.querySelectorAll(`.tcard-${id}`).forEach(el => el.style.setProperty('--tc', color));
  const t = timerById(id);
  if (!t) return;
  t.color = color;
  const def = timerDefault(id);
  if (formatMode && def) def.color = color;
  document.querySelectorAll(`.tbar-${id}`).forEach(el => el.style.background = color);
  saveToLocal();
}

export function toggleTimer(id) {
  const t = timerById(id);
  if (!t) return;
  if (t.running) {
    t.over = Math.round(getOvertime(t));   // keep the time past zero; it shows as +m:ss
    t.seconds = getRemaining(t);
    t.running = false;
    timerLogOver(t);
  } else {
    // At zero it starts anyway: the time counts as over budget.
    t._overNoted = false;
    t.startedAt = Date.now();
    t.secondsAtStart = t.seconds;
    t.running = true;
  }
  updateTimerUI(id);
  saveToLocal();
}

export function updateTimerUI(id) {
  const t = timerById(id);
  if (!t) return;
  document.querySelectorAll(`.playbtn-${id}`).forEach(btn => {
    btn.innerHTML = t.running ? pauseIcon() : playIcon();
    btn.classList.toggle('running', t.running);
  });
  document.querySelectorAll(`.tsub-${id}`).forEach(el => { el.textContent = timerSubText(t); });
  document.querySelectorAll(`.tcard-${id}`).forEach(el => {
    el.classList.toggle('running', t.running);
    el.classList.toggle('over', timerIsOver(t));
  });
  const txt = timerDisplayText(t);
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => { if (el.textContent !== txt) el.textContent = txt; });
  document.querySelectorAll(`.hchip-${id}`).forEach(el => el.classList.toggle('over', timerIsOver(t)));
  timerPaintProgress(t);
}

export function startEditTimer(id, pfx) {
  const t = timerById(id);
  if (!t || t.running) return;
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => el.style.display = 'none');
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) {
    edit.style.display = 'block';
    edit.value = fmt(t.seconds);
    edit.focus(); edit.select();
  }
}

export function commitEditTimer(id, pfx) {
  const t = timerById(id);
  if (!t) return;
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) {
    const parsed = parseTime(edit.value);
    if (!isNaN(parsed) && parsed >= 0) {
      timerLogOver(t);                     // a new time starts over: note any overrun first
      t.over = 0;
      t._overNoted = false;
      t.seconds = parsed;
      if (t.running) { t.startedAt = Date.now(); t.secondsAtStart = parsed; }
      const def = timerDefault(id);
      if (formatMode && def) def.seconds = parsed;
    }
    edit.style.display = 'none';
  }
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => {
    el.style.display = 'block';
    el.textContent = timerDisplayText(t);
  });
  updateTimerUI(id);
  saveToLocal();
}

export function resetTimer(id) {
  const t = timerById(id);
  if (!t) return;
  const def = timerDefault(id);
  timerLogOver(t);
  t.running = false;
  t.seconds = def ? def.seconds : t.seconds;
  t.startedAt = null;
  t.secondsAtStart = null;
  t.over = 0;
  t._overNoted = false;
  document.querySelectorAll(`.tedit-${id}-d, .tedit-${id}-m`).forEach(el => el.style.display = 'none');
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => {
    el.style.display = 'block';
    el.textContent = fmt(t.seconds);
  });
  updateTimerUI(id);
  saveToLocal();
}

/* Timer displays only change once a second, so the DOM is only touched
 * once a second. This used to rewrite every timer's text, progress bar
 * and the summary innerHTML on every animation frame (60x/s), which kept
 * the phone's main thread busy with layout and made taps feel late. */
let _tickLastSec = -1;
export function tickAll() {
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== _tickLastSec) {
    _tickLastSec = sec;
    timers.forEach(t => {
      if (!t.running) return;
      const rem = getRemaining(t);
      const txt = timerDisplayText(t);
      document.querySelectorAll(`.tdisp-${t.id}`).forEach(el => { if (el.textContent !== txt) el.textContent = txt; });
      timerPaintProgress(t);
      // Past zero a timer keeps running as overtime. The first tick over notes
      // the overrun in today's log and turns the card red.
      if (rem <= 0 && !t._overNoted) { t._overNoted = true; timerLogOver(t); updateTimerUI(t.id); saveToLocal(); }
    });
    if (wokenUp) updateTimerSummary();
  }
  requestAnimationFrame(tickAll);
}

/* ───────────────────────── WAKEUP + SUMMARY ───────────────────────── */
export function syncWakeupUI() {
  ['d','m'].forEach(p => {
    const row = $(`wakeupRow-${p}`);
    const box = $(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
}

export function toggleWakeup() {
  wokenUp = !wokenUp;
  syncWakeupUI();
  updateTimerSummary();
  saveToLocal();
}

export function updateTimerSummary() {
  const totalSecs = timers.reduce((sum, t) => sum + Math.round(getRemaining(t)), 0);
  const finishTime = new Date(Date.now() + totalSecs * 1000);
  const hh = finishTime.getHours();
  const mm = String(finishTime.getMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 || 12;

  const html = wokenUp ? `
    <div class="timer-summary-row">
      <span class="timer-summary-label">Time remaining</span>
      <span class="timer-summary-value">${fmt(totalSecs)}</span>
    </div>
    <div class="timer-summary-row">
      <span class="timer-summary-label">Est. finish</span>
      <span class="timer-summary-value">${h12}:${mm} ${ampm}</span>
    </div>` : '';

  ['d','m'].forEach(p => {
    const el = $(`timerSummary-${p}`);
    if (!el) return;
    if (el._lastHtml !== html) { el.innerHTML = html; el._lastHtml = html; }
    el.classList.toggle('visible', wokenUp);
  });
}
