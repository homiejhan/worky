/* util.js — Small shared helpers: DOM lookup, time and date formatting, icons, the toast,
 * modal close. */
import { CAL_HOUR_PX } from './config.js';

/* ───────────────────────── UTIL ───────────────────────── */
export function $(id) { return document.getElementById(id); }
/* Which layout the CSS is showing (the breakpoint lives in style.css). */
export function isMobileLayout() {
  const m = $('mobileApp');
  return !!m && getComputedStyle(m).display !== 'none';
}

export function fmt(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}
export function parseTime(str) {
  const p = str.split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*3600 + p[1]*60;
  return NaN;
}
export function getRemaining(t) {
  if (t.running) return Math.max(0, t.secondsAtStart - (Date.now() - t.startedAt) / 1000);
  return t.seconds;
}
/* Seconds a timer has run past zero: what it carried when last paused (t.over)
 * plus how far the current run is past zero. */
export function getOvertime(t) {
  const base = t.over || 0;
  if (!t.running) return base;
  return base + Math.max(0, (Date.now() - t.startedAt) / 1000 - t.secondsAtStart);
}
export function playIcon()  { return '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1.2L9 6L1 10.8V1.2Z" fill="currentColor"/></svg>'; }
export function pauseIcon() { return '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="1" width="3" height="10" rx="1" fill="currentColor"/><rect x="6" y="1" width="3" height="10" rx="1" fill="currentColor"/></svg>'; }
export function resetIcon() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5A4 4 0 1 0 2.9 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M1.5 2V5.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
export const GRIP_SVG = '<svg width="10" height="14" viewBox="0 0 10 14" fill="none"><circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="3" cy="11" r="1.2" fill="currentColor"/><circle cx="7" cy="11" r="1.2" fill="currentColor"/></svg>';
export const DOTS_SVG = '<svg width="4" height="14" viewBox="0 0 4 14" fill="none"><circle cx="2" cy="2" r="1.5" fill="currentColor"/><circle cx="2" cy="7" r="1.5" fill="currentColor"/><circle cx="2" cy="12" r="1.5" fill="currentColor"/></svg>';
export const SYNC_SVG  = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5.8 8.2a2.4 2.4 0 0 1 0-3.4l1.5-1.5a2.4 2.4 0 0 1 3.4 3.4l-.8.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8.2 5.8a2.4 2.4 0 0 1 0 3.4l-1.5 1.5a2.4 2.4 0 0 1-3.4-3.4l.8-.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
// Badge shown on a task that has a linked child list, and on the child list header.
export const CHILD_SVG = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="1" y="1.5" width="12" height="3.5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="9" width="12" height="3.5" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M7 5v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
export const CHECK_SVG = '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const STAR_SVG  = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1.3l1.75 3.55 3.92.57-2.84 2.77.67 3.9L7 10.25l-3.5 1.84.67-3.9L1.33 5.42l3.92-.57L7 1.3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none" class="star-path"/></svg>';

/* Plain-object task copy that keeps the optional due/doneOn fields
 * (custom-list tasks with a date surface in Day by Day). */
export function cloneTask(t) {
  const o = { id: t.id, text: t.text, done: t.done };
  if (t.due) o.due = t.due;
  if (t.doneOn) o.doneOn = t.doneOn;
  return o;
}

export function escAttr(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let _toastTimer = null;
export function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* time helpers (calendar) */
export function calToday() { const d = new Date(); d.setHours(0,0,0,0); return d; }
export function calDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function calKeyToDate(key) {   // 'YYYY-MM-DD' → local midnight
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function calFmtFull(d)  { return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
export function calFmtShort(d) { return d.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase(); }
export function calTimeToMins(s) { const [h,m] = s.split(':').map(Number); return h*60+m; }
export function calMinsToStr(n)  { n = Math.max(0, Math.min(1439, n)); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
export function calFmtTime(s) {
  const [h,m] = s.split(':').map(Number);
  const ap = h>=12?'pm':'am'; const h12 = h%12||12;
  return m===0?`${h12}${ap}`:`${h12}:${String(m).padStart(2,'0')}${ap}`;
}
/* "45m" / "1h" / "1h 30m" */
export function calFmtDur(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}
/* Length of an event in minutes, or null when it has none (dividers). */
export function calEventDurMins(ev) {
  if (!ev || ev.type === 'divider' || !ev.start || !ev.end) return null;
  const d = calTimeToMins(ev.end) - calTimeToMins(ev.start);
  return d > 0 ? d : null;
}
export function calMinsToPx(n)  { return (n/60)*CAL_HOUR_PX; }
export function calPxToMins(px) { return Math.round((px/CAL_HOUR_PX)*60/15)*15; }
export function closeModal(id) { $(id).classList.remove('show'); }

/* ── Hold the page still across a delete ──
 * Deleting a task, list or event rebuilds whole sections (renderTodos,
 * renderDbd, renderHome). Chrome keeps the page where it was through that,
 * but Safari — on the Mac and on iPhone — can snap a panel back to the top,
 * sometimes a moment later as the tap and the keyboard settle. So note how far
 * each page panel is scrolled, run the change, and put them back: right away,
 * then a few more times over the next ~400ms — unless the user starts
 * scrolling or tapping in the meantime, in which case they are left alone. */
const PAGE_SCROLLERS = '.right-panel, .swipe-panel, .home-desktop-panel, .left-panel';
const USER_MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
export function keepScroll(fn) {
  const saved = [];
  document.querySelectorAll(PAGE_SCROLLERS).forEach(el => {
    if (el.scrollTop > 0) saved.push([el, el.scrollTop]);
  });
  if (!saved.length) return fn();
  let userMoved = false;
  const onMove = () => { userMoved = true; };
  const restore = () => {
    if (userMoved) return;
    saved.forEach(([el, top]) => {
      if (el.isConnected && Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    });
  };
  try {
    return fn();
  } finally {
    restore();
    USER_MOVES.forEach(t => window.addEventListener(t, onMove, { capture: true, passive: true }));
    requestAnimationFrame(restore);
    [80, 200, 400].forEach(ms => setTimeout(restore, ms));
    setTimeout(() => USER_MOVES.forEach(t => window.removeEventListener(t, onMove, { capture: true })), 450);
  }
}
