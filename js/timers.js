/* timers.js — Timer state and cards, the woke-up checkbox and the time-remaining summary. */
import {
  $, escAttr, fmt, getRemaining, GRIP_SVG, parseTime, pauseIcon, playIcon, resetIcon,
} from './util.js';
import { saveToLocal } from './persistence.js';
import { formatMode } from './formats.js';
import { renderHome } from './home.js';
import { bindTimerDrags } from './drag.js';

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
/* Timers with an id each. Before build 13 a timer added in Formats after Focus
 * was opened again could take the id of one added before, and then coloring or
 * removing one did it to the other. The first keeps the id and each later one
 * takes the next id no timer has, from 1000 up (past the ids an older build
 * gives out, see formats.js): the same on every device, so their copies agree. */
export function timersWithOwnIds(list) {
  const seen = new Set();
  let next = Math.max(999, ...list.map(t => (Number.isFinite(t.id) ? t.id : -1))) + 1;
  return list.map(t => {
    if (Number.isFinite(t.id) && !seen.has(t.id)) { seen.add(t.id); return t; }
    seen.add(next);
    return { ...t, id: next++ };
  });
}

/* ───────────────────────── TIMERS ───────────────────────── */
function timerById(id) { return timers.find(x => x.id === id); }
/* A timer's default (template) record: TIMER_DEFAULTS runs parallel to timers. */
function timerDefault(id) { return TIMER_DEFAULTS[timers.findIndex(x => x.id === id)]; }

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
      <div class="timer-drag-handle" title="Drag to reorder">${GRIP_SVG}</div>
      <div class="color-swatch" style="background:${t.color}">
        <input type="color" value="${t.color}" oninput="changeTimerColor(${t.id}, this.value)">
      </div>
      <input class="timer-title-input" value="${escAttr(t.label)}" placeholder="Timer name"
        oninput="setTimerLabel(${t.id}, this.value)">
    </div>
    <div class="timer-body">
      <div class="timer-accent-bar tbar-${t.id}" style="background:${t.color}"></div>
      <div class="timer-display tdisp-${t.id}" onclick="startEditTimer(${t.id}, '${pfx}')">${fmt(getRemaining(t))}</div>
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
  return t.running ? 'Running' : 'Paused · tap the time to edit';
}

export function renderTimers() {
  [['timerStack-d','d'],['timerStack-m','m']].forEach(([stackId, pfx]) => {
    const stack = $(stackId);
    if (!stack) return;
    stack.innerHTML = '';
    timers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'timer-card tcard-' + t.id + (t.running ? ' running' : '');
      card.dataset.timerId = t.id;
      card.style.setProperty('--tc', t.color);
      card.innerHTML = timerCardHTML(t, pfx);
      stack.appendChild(card);
    });
  });
  bindTimerDrags();
  renderHome();
  if (wokenUp) updateTimerSummary();
  tickSchedule();
}

/* A timer dragged by its grip to just before or after another (drag.js). Its
 * default (TIMER_DEFAULTS, side by side with the timers) moves with it, so Reset
 * and Formats still give it its own; outside Formats too, like any other change. */
export function moveTimer(fromId, toId, after) {
  const from = timers.findIndex(t => t.id === fromId);
  if (from === -1 || fromId === toId || !timers.some(t => t.id === toId)) return;
  const [moved] = timers.splice(from, 1);
  const to = timers.findIndex(t => t.id === toId) + (after ? 1 : 0);
  timers.splice(to, 0, moved);
  if (from < TIMER_DEFAULTS.length) {
    const [def] = TIMER_DEFAULTS.splice(from, 1);
    TIMER_DEFAULTS.splice(Math.min(to, TIMER_DEFAULTS.length), 0, def);
  }
  renderTimers();
  saveToLocal();
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
    t.seconds = getRemaining(t);
    t.running = false;
  } else {
    if (t.seconds <= 0) return;            // a timer at zero is done: reset it or type a new time
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
  document.querySelectorAll(`.tcard-${id}`).forEach(el => el.classList.toggle('running', t.running));
  const txt = fmt(getRemaining(t));
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => { if (el.textContent !== txt) el.textContent = txt; });
  timerPaintProgress(t);
  if (wokenUp) updateTimerSummary();         // (the time remaining changed: no need to wait for a tick)
  tickSchedule();
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
      t.seconds = parsed;
      if (t.running) { t.startedAt = Date.now(); t.secondsAtStart = parsed; }
      const def = timerDefault(id);
      if (formatMode && def) def.seconds = parsed;
    }
    edit.style.display = 'none';
  }
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => {
    el.style.display = 'block';
    el.textContent = fmt(getRemaining(t));
  });
  updateTimerUI(id);
  saveToLocal();
}

export function resetTimer(id) {
  const t = timerById(id);
  if (!t) return;
  const def = timerDefault(id);
  t.running = false;
  t.seconds = def ? def.seconds : t.seconds;
  t.startedAt = null;
  t.secondsAtStart = null;
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
 * the phone's main thread busy with layout and made taps feel late. Nor
 * does it ask for animation frames any more: one asked for every frame
 * kept the browser drawing for as long as Focus was open, timers running
 * or not. */
let _tickLastSec = -1;
let _tickNext = 0;
export function tickAll() {
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== _tickLastSec) {
    _tickLastSec = sec;
    timers.forEach(t => {
      if (!t.running) return;
      const rem = getRemaining(t);
      const txt = fmt(rem);
      document.querySelectorAll(`.tdisp-${t.id}`).forEach(el => { if (el.textContent !== txt) el.textContent = txt; });
      timerPaintProgress(t);
      // A timer stops at zero, also when the app was closed while it ran out.
      if (rem <= 0) { t.seconds = 0; t.running = false; t.startedAt = null; t.secondsAtStart = null; updateTimerUI(t.id); saveToLocal(); }
    });
    if (wokenUp) updateTimerSummary();
  }
  tickSchedule();
}
/* The next tick: at the next second while a timer runs, at the next minute
 * while only the summary's finish time moves (Woke up checked), none
 * otherwise. Whatever starts a timer or checks Woke up asks for one again
 * (renderTimers, updateTimerUI, toggleWakeup). */
export function tickSchedule() {
  clearTimeout(_tickNext);
  _tickNext = 0;
  const running = timers.some(t => t.running);
  if (!running && !wokenUp) return;
  const every = running ? 1000 : 60000;
  _tickNext = setTimeout(tickAll, every - (Date.now() % every) + 20);
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
  tickSchedule();
  saveToLocal();
}

/* The timers' time left, all of it, and when it would be over if they ran one
 * after another from now ("9:42 pm"): the summary here, and the desktop
 * overlay's est. finish (overlay.js). */
export function timersRemaining() {
  return timers.reduce((sum, t) => sum + Math.round(getRemaining(t)), 0);
}
export function timerFinishText(totalSecs = timersRemaining()) {
  const finishTime = new Date(Date.now() + totalSecs * 1000);
  const hh = finishTime.getHours();
  const mm = String(finishTime.getMinutes()).padStart(2, '0');
  return `${hh % 12 || 12}:${mm} ${hh >= 12 ? 'pm' : 'am'}`;
}

export function updateTimerSummary() {
  const totalSecs = timersRemaining();

  const html = wokenUp ? `
    <div class="timer-summary-row">
      <span class="timer-summary-label">Time remaining</span>
      <span class="timer-summary-value">${fmt(totalSecs)}</span>
    </div>
    <div class="timer-summary-row">
      <span class="timer-summary-label">Est. finish</span>
      <span class="timer-summary-value">${timerFinishText(totalSecs)}</span>
    </div>` : '';

  ['d','m'].forEach(p => {
    const el = $(`timerSummary-${p}`);
    if (!el) return;
    if (el._lastHtml !== html) { el.innerHTML = html; el._lastHtml = html; }
    el.classList.toggle('visible', wokenUp);
  });
}
