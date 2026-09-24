/* tasklinks.js — Task ↔ calendar-event links: chips, the link modal and the event editor's
 * task picker. */
import { CAL_COLORS } from './config.js';
import {
  $, calDateKey, calEventDurMins, calFmtDur, calFmtFull, calFmtShort, calFmtTime, calMinsToStr,
  calTimeToMins, calToday, escAttr, showToast,
} from './util.js';
import { saveToLocal } from './persistence.js';
import { renderTodos, todoLists } from './lists.js';
import { dbdById, dbdLabelFor, dbdTasks, renderDbd } from './dbd.js';
import { renderHome } from './home.js';
import {
  calDisplayDays, calEnsureDay, calEvents, calRefresh, calSave, nextCalEventId, openCalModal,
} from './calendar.js';
import {
  gcalCalendars, gcalEvents, gcalIsConnected, gcalPushEvent, gcalSyncAll, gcalUpdateEvent,
} from './gcal.js';

/* ───────────────────────── TASK ↔ CALENDAR LINKS ─────────────────────────
 * A dated task (Day-by-Day task, or a custom-list task with a due date) can
 * be linked to ONE calendar event. The link lives on the EVENT
 * (ev.linkTaskId for custom-list tasks, ev.linkDbdId for Day-by-Day tasks),
 * so the task objects stay untouched and the existing task/dbd move & tag
 * flows only need to re-point the reference.
 *
 * Rules:
 *   • The task name is the source of truth — a linked event's title always
 *     mirrors the task text (locally and, if the event is synced, in GCal).
 *   • Linking sets the task's due date to the event's day (an undated list
 *     task therefore surfaces in Day by Day). Changing the task's due date
 *     moves the event; dragging the event to another day moves the task.
 *   • Deleting either side only removes the link — the other side survives.
 *   • The calendar only holds the visible 7-day window (calPruneDays), so
 *     links can only target days in that window; an event that scrolls out
 *     of the window is pruned like any other and the task shows as unlinked.
 */
// Chain icon on a linked calendar event; clock icon on the task-row chip.
export const LINK_SVG  = '<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M5.8 8.2a2.4 2.4 0 0 1 0-3.4l1.5-1.5a2.4 2.4 0 0 1 3.4 3.4l-.8.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8.2 5.8a2.4 2.4 0 0 1 0 3.4l-1.5 1.5a2.4 2.4 0 0 1-3.4-3.4l.8-.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const CLOCK_SVG = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.4V6l1.8 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function taskLinkRef(kind, id) { return { kind, id }; }
export function taskLinkRefOfEvent(ev) {
  if (!ev) return null;
  if (ev.linkTaskId != null) return { kind: 'list', id: ev.linkTaskId };
  if (ev.linkDbdId  != null) return { kind: 'dbd',  id: ev.linkDbdId };
  return null;
}
function taskLinkSameRef(a, b) { return !!a && !!b && a.kind === b.kind && a.id === b.id; }
export function taskLinkSetOnEvent(ev, ref) {
  delete ev.linkTaskId;
  delete ev.linkDbdId;
  if (!ref) return;
  if (ref.kind === 'list') ev.linkTaskId = ref.id;
  else ev.linkDbdId = ref.id;
}

/* Resolve a ref to its live task (+ owning list for list tasks). */
function taskLinkResolveTask(ref) {
  if (!ref) return null;
  if (ref.kind === 'dbd') {
    const t = dbdById(ref.id);
    return t ? { task: t, list: null, kind: 'dbd' } : null;
  }
  for (const l of todoLists) {
    if (l.isDefault) continue;
    const t = l.tasks.find(x => x.id === ref.id);
    if (t) return { task: t, list: l, kind: 'list' };
  }
  return null;
}

/* Find the event linked to a task: { ev, dateKey } or null. */
export function taskLinkGet(ref) {
  if (!ref) return null;
  for (const [dateKey, evs] of Object.entries(calEvents)) {
    const ev = (evs || []).find(e => taskLinkSameRef(taskLinkRefOfEvent(e), ref));
    if (ev) return { ev, dateKey };
  }
  return null;
}

/* Display title for any local event (linked → task text). */
export function taskLinkEventTitle(ev) {
  const res = taskLinkResolveTask(taskLinkRefOfEvent(ev));
  return res ? res.task.text : (ev.title || '');
}
export function taskLinkEventDone(ev) {
  const res = taskLinkResolveTask(taskLinkRefOfEvent(ev));
  return !!(res && res.task.done);
}

/* Heal drift after loads / cloud merges: mirror task text onto linked
 * events and drop links whose task no longer exists. Returns true if
 * anything changed. */
export function taskLinkSyncTitles() {
  let changed = false;
  Object.values(calEvents).forEach(evs => (evs || []).forEach(ev => {
    const ref = taskLinkRefOfEvent(ev);
    if (!ref) return;
    const res = taskLinkResolveTask(ref);
    if (!res) { taskLinkSetOnEvent(ev, null); changed = true; return; }
    if (ev.title !== res.task.text) { ev.title = res.task.text; changed = true; }
  }));
  return changed;
}

/* Remove every link that points at `ref` (the events keep their title). */
export function taskLinkClearAll(ref, exceptEv) {
  let changed = false;
  Object.values(calEvents).forEach(evs => (evs || []).forEach(ev => {
    if (ev !== exceptEv && taskLinkSameRef(taskLinkRefOfEvent(ev), ref)) {
      taskLinkSetOnEvent(ev, null);
      changed = true;
    }
  }));
  return changed;
}

/* A task changed identity (dbd ⇄ list via tagging): keep the link. */
export function taskLinkRepoint(oldRef, newRef) {
  Object.values(calEvents).forEach(evs => (evs || []).forEach(ev => {
    if (taskLinkSameRef(taskLinkRefOfEvent(ev), oldRef)) taskLinkSetOnEvent(ev, newRef);
  }));
}

/* Task renamed while typing: update the event title + patch the grid in
 * place (no re-render, so the input keeps focus). GCal is updated on blur. */
export function taskLinkOnTaskRenamed(ref, text) {
  const hit = taskLinkGet(ref);
  if (!hit) return;
  hit.ev.title = text;
  document.querySelectorAll(`.cal-event[data-ev-id="${hit.ev.id}"] .cal-event-title`)
    .forEach(el => { el.textContent = text || '(no title)'; });
  calSave();
}
export async function taskLinkFlushRename(kind, id) {
  const hit = taskLinkGet(taskLinkRef(kind, id));
  if (!hit || !hit.ev.gcalId || !gcalIsConnected()) return;
  await gcalUpdateEvent(hit.ev.gcalId, hit.ev.gcalCalId, hit.ev, hit.dateKey);
  await gcalSyncAll();
}

/* Task due date changed → move the event with it (same time of day).
 * Outside the calendar window the event can't live, so just unlink. */
export async function taskLinkOnTaskDueChanged(ref, newDue) {
  const hit = taskLinkGet(ref);
  if (!hit) return;
  const { ev, dateKey } = hit;
  if (!newDue) {
    taskLinkSetOnEvent(ev, null);
    calSave(); calRefresh();
    showToast('Unlinked from calendar event');
    return;
  }
  if (newDue === dateKey) return;
  const inWindow = calDisplayDays().map(calDateKey).includes(newDue);
  if (!inWindow) {
    taskLinkSetOnEvent(ev, null);
    calSave(); calRefresh();
    showToast('Unlinked — the calendar only shows the next 7 days');
    return;
  }
  calEvents[dateKey] = (calEvents[dateKey] || []).filter(e => e.id !== ev.id);
  calEnsureDay(newDue);
  calEvents[newDue].push({ ...ev, fromTemplate: false });
  calSave();
  calRefresh();
  if (ev.gcalId && gcalIsConnected()) {
    await gcalUpdateEvent(ev.gcalId, ev.gcalCalId, ev, newDue);
    await gcalSyncAll();
  }
}

/* Event dragged on the grid → keep the task's due date in step and refresh
 * the time chips on task rows. */
export function taskLinkAfterEventMoved(ev, fromKey, toKey) {
  const ref = taskLinkRefOfEvent(ev);
  if (!ref) return;
  const res = taskLinkResolveTask(ref);
  if (res && toKey !== fromKey && res.task.due !== toKey) res.task.due = toKey;
  renderTodos();
  renderDbd();
  saveToLocal();
}

/* Task checked / unchecked → repaint its event (done styling). */
export function taskLinkRepaint(ref) {
  const hit = taskLinkGet(ref);
  if (!hit) return;
  const done = taskLinkEventDone(hit.ev);
  document.querySelectorAll(`.cal-event[data-ev-id="${hit.ev.id}"]`)
    .forEach(el => el.classList.toggle('cal-linked-done', done));
  renderHome();
}

/* ── task-row chip ── */
export function taskLinkChipHtml(kind, id) {
  const hit = taskLinkGet(taskLinkRef(kind, id));
  if (hit) {
    const { ev, dateKey } = hit;
    const dur = calEventDurMins(ev);
    const durHtml = dur ? `<span class="task-cal-dur">${calFmtDur(dur)}</span>` : '';
    const range = dur ? `, ${calFmtTime(ev.start)}–${calFmtTime(ev.end)}` : '';
    return `<button class="task-cal-chip linked" style="color:${escAttr(ev.color)}"
      onclick="taskLinkOpenEvent('${kind}',${id})"
      title="Linked to a calendar event on ${escAttr(dbdLabelFor(dateKey))}${range} — tap to edit">${CLOCK_SVG}<span>${calFmtTime(ev.start)}</span>${durHtml}</button>`;
  }
  return `<button class="task-cal-chip" onclick="openTaskLinkModal('${kind}',${id})" title="Link to a calendar event">${CLOCK_SVG}</button>`;
}
export function taskLinkHomeChipHtml(kind, id) {
  const hit = taskLinkGet(taskLinkRef(kind, id));
  if (!hit) return '';
  // Home shows how long the task takes; events with no length (dividers)
  // fall back to their start time.
  const dur = calEventDurMins(hit.ev);
  const label = dur ? calFmtDur(dur) : calFmtTime(hit.ev.start);
  const range = dur ? `${calFmtTime(hit.ev.start)}–${calFmtTime(hit.ev.end)}` : calFmtTime(hit.ev.start);
  return `<span class="home-dbd-cal" style="color:${escAttr(hit.ev.color)}" title="${range}">${CLOCK_SVG}${label}</span>`;
}

/* Open the linked event in the regular event editor. */
export function taskLinkOpenEvent(kind, id) {
  const hit = taskLinkGet(taskLinkRef(kind, id));
  if (!hit) { openTaskLinkModal(kind, id); return; }
  openCalModal(hit.dateKey, hit.ev.id);
}

/* ── Link modal ── */
let taskLinkModalRef = null;
let taskLinkDay      = null;
let taskLinkColor    = CAL_COLORS[0];

export function openTaskLinkModal(kind, id) {
  const ref = taskLinkRef(kind, id);
  const res = taskLinkResolveTask(ref);
  if (!res) return;
  taskLinkModalRef = ref;
  const days = calDisplayDays().map(calDateKey);
  taskLinkDay = (res.task.due && days.includes(res.task.due)) ? res.task.due : calDateKey(calToday());
  taskLinkColor = res.list ? res.list.color : CAL_COLORS[0];
  if (!CAL_COLORS.some(c => c.toLowerCase() === taskLinkColor.toLowerCase())) taskLinkColor = CAL_COLORS[0];

  $('taskLinkSub').textContent = `“${res.task.text || 'Untitled task'}” — pick an event, or create one. The event takes the task's name.`;

  // default new-event time: next whole hour today, or 09:00 on other days
  const now = new Date();
  const startM = taskLinkDay === calDateKey(calToday())
    ? Math.min(23 * 60, (now.getHours() + 1) * 60) : 9 * 60;
  $('taskLinkStart').value = calMinsToStr(startM);
  $('taskLinkEnd').value   = calMinsToStr(Math.min(1439, startM + 60));

  taskLinkRenderDays();
  taskLinkRenderColors();
  taskLinkRenderEvents();
  $('taskLinkModal').classList.add('show');
}

export function closeTaskLinkModal() {
  $('taskLinkModal').classList.remove('show');
  taskLinkModalRef = null;
}

function taskLinkRenderDays() {
  const wrap = $('taskLinkDays');
  wrap.innerHTML = '';
  calDisplayDays().forEach(d => {
    const key = calDateKey(d);
    const btn = document.createElement('button');
    btn.className = 'tl-day-btn' + (key === taskLinkDay ? ' active' : '');
    btn.innerHTML = `<span class="tl-day-dow">${calFmtShort(d)}</span><span class="tl-day-num">${d.getDate()}</span>`;
    btn.title = calFmtFull(d);
    btn.onclick = () => {
      taskLinkDay = key;
      wrap.querySelectorAll('.tl-day-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      taskLinkRenderEvents();
    };
    wrap.appendChild(btn);
  });
}

function taskLinkRenderColors() {
  const el = $('taskLinkColors');
  el.innerHTML = '';
  CAL_COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'cal-color-dot' + (c.toLowerCase() === taskLinkColor.toLowerCase() ? ' selected' : '');
    dot.style.background = c;
    dot.onclick = () => {
      taskLinkColor = c;
      el.querySelectorAll('.cal-color-dot').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
    };
    el.appendChild(dot);
  });
}

function taskLinkRenderEvents() {
  const wrap = $('taskLinkEvents');
  wrap.innerHTML = '';
  const dateKey = taskLinkDay;
  calEnsureDay(dateKey);
  const rows = [];

  (calEvents[dateKey] || [])
    .filter(e => e.type !== 'divider')
    .sort((a, b) => calTimeToMins(a.start) - calTimeToMins(b.start))
    .forEach(ev => {
      const ref = taskLinkRefOfEvent(ev);
      const mine = taskLinkSameRef(ref, taskLinkModalRef);
      const other = ref && !mine ? taskLinkResolveTask(ref) : null;
      rows.push({
        title: taskLinkEventTitle(ev), color: ev.color, start: ev.start, end: ev.end,
        badge: mine ? 'Linked' : (other ? `Linked to “${other.task.text || 'Untitled'}”` : (ev.gcalId ? 'Synced' : '')),
        mine, disabled: !!other,
        onclick: () => taskLinkLinkTo(dateKey, ev.id),
      });
    });

  if (gcalIsConnected()) {
    const mirrored = new Set((calEvents[dateKey] || []).map(e => e.gcalId).filter(Boolean));
    (gcalEvents[dateKey] || [])
      .filter(g => !g.allDay && !mirrored.has(g.gcalId))
      .sort((a, b) => calTimeToMins(a.start) - calTimeToMins(b.start))
      .forEach(g => rows.push({
        title: g.title, color: g.color, start: g.start, end: g.end,
        badge: g.calName, mine: false, disabled: false,
        onclick: () => taskLinkLinkToGcal(dateKey, g),
      }));
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="tl-empty">No events on this day yet — create one below.</div>';
    return;
  }
  rows.forEach(r => {
    const row = document.createElement('button');
    row.className = 'tl-event' + (r.mine ? ' mine' : '') + (r.disabled ? ' disabled' : '');
    row.disabled = r.disabled;
    row.style.setProperty('--evc', r.color);
    row.innerHTML = `
      <span class="tl-event-dot"></span>
      <span class="tl-event-main">
        <span class="tl-event-title">${escAttr(r.title || '(no title)')}</span>
        <span class="tl-event-time">${calFmtTime(r.start)}–${calFmtTime(r.end)}</span>
      </span>
      ${r.badge ? `<span class="tl-event-badge">${escAttr(r.badge)}</span>` : ''}`;
    if (!r.disabled) row.onclick = r.onclick;
    wrap.appendChild(row);
  });
}

/* Link the task `res` (resolved from `ref`) to `ev` on `dateKey`: the event
 * takes the task's name and the task moves to the event's day. */
function taskLinkBind(ref, res, ev, dateKey) {
  taskLinkClearAll(ref, ev);          // a task links to one event only
  taskLinkSetOnEvent(ev, ref);
  ev.title = res.task.text;
  if (res.task.due !== dateKey) res.task.due = dateKey;   // undated list task → Day by Day
}

/* Core: attach `ref` (default: modal task) to an existing local event. */
async function taskLinkAttach(ref, dateKey, ev, { silent } = {}) {
  const res = taskLinkResolveTask(ref);
  if (!res || !ev) return false;
  taskLinkBind(ref, res, ev, dateKey);
  calSave();
  calRefresh();
  renderTodos();
  renderDbd();
  saveToLocal();
  if (!silent) showToast('Linked to calendar event ✓');
  if (ev.gcalId && gcalIsConnected()) {
    await gcalUpdateEvent(ev.gcalId, ev.gcalCalId, ev, dateKey);
    await gcalSyncAll();
  }
  return true;
}

async function taskLinkLinkTo(dateKey, evId) {
  const ref = taskLinkModalRef;
  const ev = (calEvents[dateKey] || []).find(e => e.id === evId);
  closeTaskLinkModal();
  await taskLinkAttach(ref, dateKey, ev);
}

/* Google-only event → mirror it locally (same as "Sync to app"), then link. */
async function taskLinkLinkToGcal(dateKey, g) {
  const ref = taskLinkModalRef;
  closeTaskLinkModal();
  calEnsureDay(dateKey);
  const ev = {
    id: nextCalEventId(),
    title: g.title, start: g.start, end: g.end,
    color: taskLinkColor, type: 'event', fromTemplate: false,
    gcalId: g.gcalId, gcalCalId: g.calId,
  };
  calEvents[dateKey].push(ev);
  await taskLinkAttach(ref, dateKey, ev);
}

/* Create a brand-new event named after the task and link it. */
export async function taskLinkCreate() {
  const ref = taskLinkModalRef;
  const res = taskLinkResolveTask(ref);
  if (!res) { closeTaskLinkModal(); return; }
  const dateKey = taskLinkDay;
  const start = $('taskLinkStart').value || '09:00';
  let end = $('taskLinkEnd').value || '';
  if (!end || calTimeToMins(end) <= calTimeToMins(start)) end = calMinsToStr(Math.min(1439, calTimeToMins(start) + 60));

  calEnsureDay(dateKey);
  const ev = {
    id: nextCalEventId(),
    title: res.task.text, start, end,
    color: taskLinkColor, type: 'event', fromTemplate: false,
  };
  calEvents[dateKey].push(ev);
  closeTaskLinkModal();
  await taskLinkAttach(ref, dateKey, ev, { silent: true });
  showToast('Event created & linked ✓');

  /* mirror saveCalEvent: new events go to the enabled Google Calendar */
  if (gcalIsConnected()) {
    const calId = gcalCalendars.find(c => c.enabled)?.id;
    if (calId) {
      const gcalId = await gcalPushEvent(ev, dateKey, calId);
      if (gcalId) { ev.gcalId = gcalId; ev.gcalCalId = calId; calSave(); saveToLocal(); }
      await gcalSyncAll();
    }
  }
}

/* ── event editor: "Link to task" picker ── */
function taskLinkOptionValue(ref) { return ref ? `${ref.kind}:${ref.id}` : ''; }
function taskLinkParseOption(v) {
  if (!v) return null;
  const [kind, id] = v.split(':');
  return (kind === 'list' || kind === 'dbd') ? { kind, id: parseInt(id, 10) } : null;
}

export function taskLinkRenderSelect(currentRef) {
  const sel = $('calLinkSelect');
  if (!sel) return;
  const cur = taskLinkOptionValue(currentRef);
  const opt = (ref, text) => {
    const v = taskLinkOptionValue(ref);
    const linkedElsewhere = !taskLinkSameRef(ref, currentRef) && !!taskLinkGet(ref);
    return `<option value="${v}"${v === cur ? ' selected' : ''}>${escAttr(text || 'Untitled')}${linkedElsewhere ? ' (linked)' : ''}</option>`;
  };
  const keep = (t, ref) => !t.done || taskLinkSameRef(ref, currentRef);
  let html = `<option value="">No task</option>`;
  const dbd = dbdTasks.filter(t => keep(t, taskLinkRef('dbd', t.id)));
  if (dbd.length) html += `<optgroup label="Day by Day">${dbd.map(t => opt(taskLinkRef('dbd', t.id), t.text)).join('')}</optgroup>`;
  todoLists.filter(l => !l.isDefault).forEach(l => {
    const ts = l.tasks.filter(t => keep(t, taskLinkRef('list', t.id)));
    if (ts.length) html += `<optgroup label="${escAttr(l.title || 'Untitled list')}">${ts.map(t => opt(taskLinkRef('list', t.id), t.text)).join('')}</optgroup>`;
  });
  sel.innerHTML = html;
  taskLinkApplySelectToTitle();
}

/* Picking a task locks the title to the task's name. */
export function taskLinkApplySelectToTitle() {
  const sel = $('calLinkSelect');
  const title = $('calEventTitle');
  if (!sel || !title) return;
  const res = taskLinkResolveTask(taskLinkParseOption(sel.value));
  if (res) {
    title.value = res.task.text;
    title.readOnly = true;
    title.classList.add('linked');
    title.placeholder = 'Title follows the linked task';
  } else {
    title.readOnly = false;
    title.classList.remove('linked');
    title.placeholder = 'Event title';
  }
}

/* Called from saveCalEvent once the event object exists. */
export function taskLinkApplyFromModal(ev, dateKey) {
  const sel = $('calLinkSelect');
  if (!sel) return;
  const ref = taskLinkParseOption(sel.value);
  const res = taskLinkResolveTask(ref);
  if (!res) { taskLinkSetOnEvent(ev, null); return; }
  taskLinkBind(ref, res, ev, dateKey);
  renderTodos();
  renderDbd();
}
