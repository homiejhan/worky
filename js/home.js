/* home.js — The Home page: greeting, balance, progress, today's tasks, starred lists,
 * timers, next 4 hours. */
import {
  $, calDateKey, calFmtTime, calMinsToStr, calTimeToMins, calToday, CHECK_SVG, escAttr, STAR_SVG,
} from './util.js';
import { timerDisplayText, timerIsOver, timers } from './timers.js';
import { todoLists } from './lists.js';
import { dbdAllEntries, dbdCompare, dbdLabelFor, dbdTasks, dbdTodayKey } from './dbd.js';
import { taskLinkEventTitle, taskLinkHomeChipHtml } from './tasklinks.js';
import { desktopNavSync, viewEnabled } from './views.js';
import { calDesktopOpen, calEvents, calToggleDesktop } from './calendar.js';
import { gcalEvents, gcalIsConnected } from './gcal.js';
import {
  budgetDesktopOpen, budgetToggleDesktop, money, todayBalance, totalBalance,
} from './budget.js';
import { homeDigestHtml } from './digest.js';

/* ───────────────────────── HOME PAGE ─────────────────────────
 * Read-mostly dashboard assembled from existing state. All interactions
 * delegate to existing functions (toggleDbdTask / toggleTask), and existing
 * live-update hooks keep it fresh: tickAll drives .tdisp-N timer text, and
 * paintTaskState drives .task-checks-N / .task-text-N on starred lists. */
export let homeDesktopOpen = false;
export function homeToggleDesktop(force) {
  const want = (typeof force === 'boolean') ? force : !homeDesktopOpen;
  if (want && calDesktopOpen) calToggleDesktop();   // close calendar overlay first
  if (want && budgetDesktopOpen) budgetToggleDesktop(false);
  homeDesktopOpen = want;
  const panel = $('homeDesktopPanel');
  const tab   = $('homeDesktopNavTab');
  const rp    = $('rightPanel');
  if (panel) panel.classList.toggle('active', homeDesktopOpen);
  if (tab)   tab.classList.toggle('active', homeDesktopOpen);
  if (rp)    rp.style.display = homeDesktopOpen ? 'none' : '';
  if (homeDesktopOpen) renderHome();
  desktopNavSync();
}

export function renderHome() {
  const dc = $('homeContainer-d');
  const mc = $('homeContainer-m');
  if (!dc && !mc) return;
  const html =
    homeHeroHtml() +
    homeDigestHtml() +
    homeDbdHtml() +
    homeStarredListsHtml(true) +   // starred Daily lists
    homeTimersHtml() +
    homeCalHtml() +
    homeStarredListsHtml(false);   // starred custom Lists
  if (dc) dc.innerHTML = html;
  if (mc) mc.innerHTML = html;
}

/* ── daily progress: starred Daily tasks + dbd tasks due today / overdue.
 *    A done dbd task counts only if it's due today OR was checked off today
 *    (doneOn), so clearing an overdue task fills the bar instead of shrinking
 *    the denominator. */
function homeProgressData() {
  const todayKey = dbdTodayKey();
  let total = 0, done = 0;
  todoLists.forEach(l => {
    if (!l.isDefault || !l.starred) return;
    l.tasks.forEach(t => { total++; if (t.done) done++; });
  });
  const countDated = t => {
    const counted = t.done
      ? (t.due === todayKey || t.doneOn === todayKey)
      : (t.due <= todayKey);
    if (counted) { total++; if (t.done) done++; }
  };
  dbdTasks.forEach(countDated);
  todoLists.forEach(l => {
    if (l.isDefault) return;
    l.tasks.forEach(t => { if (t.due) countDated(t); });
  });
  return { total, done, pct: total ? Math.round(done / total * 100) : 0 };
}

function homeProgressHtml() {
  const { total, done, pct } = homeProgressData();
  if (!total) return '';
  const complete = done === total;
  const label = complete ? 'All done for today' : `${done} of ${total} tasks done`;
  return `
    <div class="home-progress ${complete ? 'complete' : ''}">
      <div class="home-progress-meta">
        <span class="home-progress-label">${label}</span>
        <span class="home-progress-pct">${pct}%</span>
      </div>
      <div class="home-progress-track">
        <div class="home-progress-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

/* Patch the bar in place (no full re-render) — used by toggleTask, which
 * paints task state via classes instead of re-rendering the Home page. */
export function homeUpdateProgressDom() {
  const bars = document.querySelectorAll('.home-progress');
  if (!bars.length) { renderHome(); return; }
  const { total, done, pct } = homeProgressData();
  const complete = total > 0 && done === total;
  const label = complete ? 'All done for today' : `${done} of ${total} tasks done`;
  bars.forEach(bar => {
    bar.classList.toggle('complete', complete);
    const fill = bar.querySelector('.home-progress-fill');
    const lab  = bar.querySelector('.home-progress-label');
    const pc   = bar.querySelector('.home-progress-pct');
    if (fill) fill.style.width = pct + '%';
    if (lab)  lab.textContent = label;
    if (pc)   pc.textContent = pct + '%';
  });
}

/* ── hero ── */
function homeGreeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Still up?';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}
function homeHeroHtml() {
  const dateStr = new Date().toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });
  return `
    <div class="home-hero">
      <div class="home-hero-top">
        <div class="home-hero-text">
          <div class="home-welcome">${homeGreeting()}</div>
          <div class="home-date">${dateStr}</div>
        </div>
        <div class="home-balance" onclick="openBudgetTab()" title="Open Budget">
          <div class="home-balance-label">Daily balance</div>
          <div class="home-balance-value ${todayBalance() < 0 ? 'neg' : ''}">${money(todayBalance())}</div>
          <div class="home-balance-total">${money(totalBalance())}</div>
        </div>
      </div>
      ${homeProgressHtml()}
    </div>`;
}

/* ── day-by-day: overdue (red) + today (white) + next 3 upcoming (grey) ── */
function homeDbdRow(entry, tone) {
  const t = entry.task;
  const tagged = entry.kind === 'list';
  const dateChip = tone === 'today' ? '' :
    `<span class="home-dbd-date">${dbdLabelFor(t.due)}</span>`;
  const tagDot = tagged
    ? `<span class="home-dbd-tag" style="background:${entry.list.color}" title="${escAttr(entry.list.title || 'Untitled')}"></span>`
    : '';
  const toggle = tagged ? `toggleTask(${entry.list.id},${t.id})` : `toggleDbdTask(${t.id})`;
  const checkStyle = tagged && t.done ? ` style="background:${entry.list.color};border-color:${entry.list.color}"` : '';
  return `
    <div class="task-row home-dbd-row home-tone-${tone}">
      <div class="task-check home-dbd-check ${tagged ? `task-checks-${t.id} ` : ''}${t.done ? 'done' : ''}"${checkStyle} onclick="${toggle}">
        ${CHECK_SVG}
      </div>
      ${tagDot}
      <span class="home-task-text ${tagged ? `task-text-${t.id} ` : ''}${t.done ? 'done' : ''}">${escAttr(t.text)}</span>
      ${taskLinkHomeChipHtml(tagged ? 'list' : 'dbd', t.id)}
      ${dateChip}
    </div>`;
}

function homeDbdHtml() {
  const todayKey = dbdTodayKey();
  const all = dbdAllEntries();
  const overdue  = all.filter(e => !e.task.done && e.task.due <  todayKey).sort(dbdCompare);
  const today    = all.filter(e =>                 e.task.due === todayKey).sort(dbdCompare);
  const upcoming = all.filter(e => !e.task.done && e.task.due >  todayKey).sort(dbdCompare).slice(0, 3);
  if (!overdue.length && !today.length && !upcoming.length) return '';
  const emptyToday = (!overdue.length && !today.length)
    ? '<div class="home-muted-note">Nothing due today.</div>' : '';
  return `
    <section class="home-section home-sec-today">
      <div class="home-section-title">Today\u2019s tasks</div>
      <div class="home-card">
        ${overdue.map(e => homeDbdRow(e, 'overdue')).join('')}
        ${today.map(e => homeDbdRow(e, 'today')).join('')}
        ${emptyToday}
        ${upcoming.map(e => homeDbdRow(e, 'future')).join('')}
      </div>
    </section>`;
}

/* ── starred lists (daily=true → Daily lists; false → custom Lists) ── */
function homeListCard(list) {
  const rows = list.tasks.map(task => {
    const checkStyle = task.done ? `background:${list.color};border-color:${list.color}` : '';
    return `
      <div class="task-row home-list-row">
        <div class="task-check task-checks-${task.id} ${task.done ? 'done' : ''}" style="${checkStyle}"
          onclick="toggleTask(${list.id},${task.id})">
          ${CHECK_SVG}
        </div>
        <span class="home-task-text task-text-${task.id} ${task.done ? 'done' : ''}">${escAttr(task.text)}</span>
      </div>`;
  }).join('');
  return `
    <div class="home-list-card">
      <div class="home-list-strip" style="background:${list.color}"></div>
      <div class="home-list-title">
        <span class="home-list-star">${STAR_SVG}</span>
        ${escAttr(list.title || 'Untitled')}
      </div>
      <div class="home-list-tasks">${rows || '<div class="home-muted-note">No tasks</div>'}</div>
    </div>`;
}

function homeStarredListsHtml(daily) {
  const lists = todoLists.filter(l => !!l.isDefault === daily && l.starred);
  if (!lists.length) return '';
  const title = daily ? 'Starred daily' : 'Starred lists';
  return `
    <section class="home-section ${daily ? 'home-sec-daily' : 'home-sec-lists'}">
      <div class="home-section-title">${title}</div>
      <div class="home-lists-grid">${lists.map(homeListCard).join('')}</div>
    </section>`;
}

/* ── timers: compact remaining-time chips (tickAll keeps .tdisp-N live) ── */
function homeTimersHtml() {
  if (!viewEnabled('timers')) return '';   // the one Home section that follows its toggle
  if (!timers.length) return '';
  const chips = timers.map(t => `
    <div class="home-timer-chip hchip-${t.id}${timerIsOver(t) ? ' over' : ''}">
      <span class="home-timer-dot" style="background:${t.color}"></span>
      <span class="home-timer-label">${escAttr(t.label)}</span>
      <span class="home-timer-time tdisp-${t.id}">${timerDisplayText(t)}</span>
    </div>`).join('');
  return `
    <section class="home-section home-sec-timers">
      <div class="home-section-title">Timers</div>
      <div class="home-timer-row">${chips}</div>
    </section>`;
}

/* ── calendar: agenda of events overlapping [now, now + 4h] ── */
function homeCalTime(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return calFmtTime(calMinsToStr(wrapped));
}

function homeCalHtml() {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const winEnd  = nowMins + 240;
  const todayKey = calDateKey(calToday());
  const tmr = new Date(calToday()); tmr.setDate(tmr.getDate() + 1);
  const tomorrowKey = calDateKey(tmr);

  const collect = (dateKey, offset) => {
    const local = (calEvents[dateKey] || []).filter(e => e.type !== 'divider');
    const goog  = (gcalIsConnected() ? (gcalEvents[dateKey] || []) : []).filter(e => !e.allDay);
    return [...local, ...goog].map(ev => {
      const s = calTimeToMins(ev.start) + offset;
      return { title: taskLinkEventTitle(ev), color: ev.color || '#5dcaa5',
               s, e: Math.max(s + 1, calTimeToMins(ev.end) + offset) };
    });
  };
  let evs = collect(todayKey, 0);
  if (winEnd > 1440) evs = evs.concat(collect(tomorrowKey, 1440));
  evs = evs.filter(ev => ev.e > nowMins && ev.s < winEnd)
           .sort((a, b) => a.s - b.s || a.e - b.e);

  const items = evs.map(ev => {
    const ongoing  = ev.s <= nowMins;
    const startsIn = ev.s - nowMins;
    const inStr = startsIn >= 60
      ? `in ${Math.floor(startsIn / 60)}h${startsIn % 60 ? ' ' + (startsIn % 60) + 'm' : ''}`
      : `in ${startsIn}m`;
    const badge = ongoing
      ? '<span class="home-cal-badge now">Now</span>'
      : `<span class="home-cal-badge">${inStr}</span>`;
    const tmrTag = ev.s >= 1440 ? '<span class="home-cal-tmr">tomorrow</span>' : '';
    return `
      <div class="home-cal-event ${ongoing ? 'ongoing' : ''}"
        style="border-left-color:${ev.color};background:${ev.color}14">
        <div class="home-cal-event-main">
          <div class="home-cal-event-title" style="color:${ev.color}">${escAttr(ev.title || '(untitled)')}</div>
          <div class="home-cal-event-time">${homeCalTime(ev.s)} \u2013 ${homeCalTime(ev.e)} ${tmrTag}</div>
        </div>
        ${badge}
      </div>`;
  }).join('');

  const empty = `<div class="home-muted-note">Nothing on the calendar until ${homeCalTime(winEnd)}.</div>`;
  return `
    <section class="home-section home-sec-cal">
      <div class="home-section-title">Next 4 hours</div>
      <div class="home-card home-cal-card">${items || empty}</div>
    </section>`;
}
