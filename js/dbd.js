/* dbd.js — Day by Day: dated one-off tasks, list tags and the midnight rollover. */
import {
  $, calDateKey, calKeyToDate, calTimeToMins, calToday, CHECK_SVG, escAttr, keepRowsAbove,
} from './util.js';
import { saveToLocal } from './persistence.js';
import {
  CALICON_SVG, listById, nextTaskId, renderTodos, taskDateChipLabel, todoLists,
} from './lists.js';
import {
  taskLinkChipHtml, taskLinkClearAll, taskLinkGet, taskLinkOnTaskDueChanged,
  taskLinkOnTaskRenamed, taskLinkRef, taskLinkRepaint, taskLinkRepoint,
} from './tasklinks.js';
import { renderHome } from './home.js';
import { calRefresh, calSave } from './calendar.js';

/* day-by-day tasks (dated one-off tasks under My Lists) */
export let dbdTasks = [];        // { id, text, due:'YYYY-MM-DD', done }
export function setDbdTasks(v) { dbdTasks = v; }
export let dbdIdCounter = 1;
export function setDbdIdCounter(v) { dbdIdCounter = v; }
export function nextDbdId() { return dbdIdCounter++; }

/* ───────────────────────── DAY-BY-DAY TASKS ─────────────────────────
 * Flat, dated one-off tasks under the My Lists tab. Unchecked tasks with a
 * past due date surface in an "Overdue" section; checked past tasks collapse
 * into a dimmed "Completed" group. Groups re-flow automatically at midnight. */
export function dbdTodayKey() { return calDateKey(calToday()); }

export function dbdLabelFor(key) {
  const today = calToday();
  const date = calKeyToDate(key);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

export function dbdById(id) { return dbdTasks.find(t => t.id === id); }

export function addDbdTask(pfx) {
  const textEl = $(`dbdText-${pfx}`);
  const dateEl = $(`dbdDate-${pfx}`);
  const text = (textEl?.value || '').trim();
  if (!text) { textEl?.focus(); return; }
  const due = (dateEl?.value) || dbdTodayKey();
  dbdTasks.push({ id: dbdIdCounter++, text, due, done: false });
  if (textEl) textEl.value = '';
  renderDbd();
  saveToLocal();
  textEl?.focus();
}

export function toggleDbdTask(id) {
  const t = dbdById(id);
  if (!t) return;
  t.done = !t.done;
  if (t.done) t.doneOn = dbdTodayKey();   // lets today's progress count overdue tasks cleared today
  else delete t.doneOn;
  renderDbd();
  saveToLocal();
  taskLinkRepaint(taskLinkRef('dbd', id));
}

/* `fromEl`: the × that was pressed, so the page stays where it was. */
export function removeDbdTask(id, fromEl) {
  dbdTasks = dbdTasks.filter(t => t.id !== id);
  if (taskLinkClearAll(taskLinkRef('dbd', id))) { calSave(); calRefresh(); }
  keepRowsAbove(fromEl, renderDbd);
  saveToLocal();
}

export function setDbdText(id, value) {
  const t = dbdById(id);
  if (t) { t.text = value; taskLinkOnTaskRenamed(taskLinkRef('dbd', id), value); saveToLocal(); }
}

export function setDbdDue(id, value) {
  const t = dbdById(id);
  if (!t || !value) return;
  t.due = value;
  taskLinkOnTaskDueChanged(taskLinkRef('dbd', id), value);
  renderDbd();
  saveToLocal();
}

/* ── Tags: every custom list in the Lists section doubles as a tag.
 *    • Tagging a dbd task MOVES it into that list (it stays visible here,
 *      color-coded, because dated list tasks render in Day by Day).
 *    • "No tag" moves it back to a plain dbd task.
 *    One task object, one source of truth — no mirroring/sync needed. ── */
export function dbdAllEntries() {
  const out = dbdTasks.map(t => ({ kind: 'dbd', task: t, list: null }));
  todoLists.forEach(l => {
    if (l.isDefault) return;
    l.tasks.forEach(t => { if (t.due) out.push({ kind: 'list', task: t, list: l }); });
  });
  return out;
}

/* Start time (minutes from midnight) of the calendar event linked to an
 * entry, or null when it has no linked event. */
function dbdEntryStartMins(entry) {
  const hit = taskLinkGet(taskLinkRef(entry.kind, entry.task.id));
  return hit && hit.ev.start ? calTimeToMins(hit.ev.start) : null;
}

/* Order for Day by Day / Home: due date, then linked start time within the
 * day (timed tasks first, ascending; untimed ones after), then creation. */
export function dbdCompare(a, b) {
  if (a.task.due !== b.task.due) return a.task.due < b.task.due ? -1 : 1;
  const ta = dbdEntryStartMins(a), tb = dbdEntryStartMins(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  if (a.kind !== b.kind) return a.kind === 'dbd' ? -1 : 1;
  return a.task.id - b.task.id;
}

function dbdTagSelectHtml(entry) {
  const cur = entry.kind === 'list' ? String(entry.list.id) : '';
  const opts = [`<option value="">${cur ? 'No tag' : 'Tag'}</option>`]
    .concat(todoLists.filter(l => !l.isDefault).map(l =>
      `<option value="${l.id}"${String(l.id) === cur ? ' selected' : ''}>${escAttr(l.title || 'Untitled')}</option>`));
  const onchange = entry.kind === 'list'
    ? `retagListTask(${entry.list.id},${entry.task.id},this.value)`
    : `tagDbdTask(${entry.task.id},this.value)`;
  return `<select class="dbd-tag-select" onchange="${onchange}" title="Tag with a list">${opts.join('')}</select>`;
}

// dbd task → list task (keeps text/done/due/doneOn, gets a task-space id).
export function tagDbdTask(dbdId, val) {
  const t = dbdById(dbdId);
  const list = listById(parseInt(val, 10));
  if (!t || !val || !list || list.isDefault) { renderDbd(); return; }
  dbdTasks = dbdTasks.filter(x => x.id !== dbdId);
  const nt = { id: nextTaskId(), text: t.text, done: t.done, due: t.due || dbdTodayKey() };
  if (t.doneOn) nt.doneOn = t.doneOn;
  list.tasks.push(nt);
  taskLinkRepoint(taskLinkRef('dbd', dbdId), taskLinkRef('list', nt.id));
  renderTodos();
  renderDbd();
  saveToLocal();
}

// Tagged task → another list, or back to a plain dbd task ('' = No tag).
export function retagListTask(listId, taskId, val) {
  const list = listById(listId);
  if (!list) return;
  const idx = list.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  if (!val) {
    const [t] = list.tasks.splice(idx, 1);
    const nid = dbdIdCounter++;
    dbdTasks.push({ id: nid, text: t.text, due: t.due || dbdTodayKey(),
      done: t.done, ...(t.doneOn ? { doneOn: t.doneOn } : {}) });
    taskLinkRepoint(taskLinkRef('list', taskId), taskLinkRef('dbd', nid));
  } else {
    const dest = listById(parseInt(val, 10));
    if (!dest || dest.isDefault || dest === list) { renderDbd(); return; }
    const [t] = list.tasks.splice(idx, 1);
    dest.tasks.push(t);
  }
  renderTodos();
  renderDbd();
  saveToLocal();
}

// Set / clear a date on a list task (from either the list card or a dbd row).
// A date puts the task in Day by Day; clearing pulls it out (it stays listed).
export function setListTaskDue(listId, taskId, value) {
  const list = listById(listId);
  const task = list && list.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (value) {
    task.due = value;
  } else {
    delete task.due;
    delete task.doneOn;
  }
  taskLinkOnTaskDueChanged(taskLinkRef('list', taskId), value || '');
  renderTodos();
  renderDbd();
  saveToLocal();
}

/* Compact "change date" button for a Day by Day row. Rows under a dated
 * header (Today, Tomorrow, Fri…) show just the calendar icon — the header
 * already says which day. Overdue / Completed mix several days, so those
 * rows keep a short date label next to the icon. */
function dbdDateBtnHtml(due, onchange, showLabel) {
  const label = showLabel ? `<span>${taskDateChipLabel(due)}</span>` : '';
  return `<label class="task-date-chip dbd-date-btn${showLabel ? ' has-label' : ''}" title="${escAttr(dbdLabelFor(due))} — tap to change date">${CALICON_SVG}${label}<input type="date" value="${escAttr(due)}" onchange="${onchange}"></label>`;
}

function dbdRowHtml(entry, overdue, showDate) {
  const t = entry.task;
  const tagSel = dbdTagSelectHtml(entry);
  if (entry.kind === 'list') {
    const list = entry.list;
    const checkStyle = t.done ? `background:${list.color};border-color:${list.color}` : '';
    return `
    <div class="task-row dbd-row dbd-tagged ${overdue ? 'dbd-overdue-row' : ''}" style="--tagc:${list.color}"
         data-list-id="${list.id}" data-task-id="${t.id}">
      <div class="task-check dbd-check task-checks-${t.id} ${t.done ? 'done' : ''}" style="${checkStyle}"
        onclick="toggleTask(${list.id},${t.id})">
        ${CHECK_SVG}
      </div>
      <input class="task-text task-text-${t.id} ${t.done ? 'done' : ''}" value="${escAttr(t.text)}" placeholder="Task…"
        oninput="setTaskText(${list.id},${t.id},this.value)"
        onblur="taskLinkFlushRename('list',${t.id})">
      ${tagSel}
      ${dbdDateBtnHtml(t.due, `setListTaskDue(${list.id},${t.id},this.value)`, showDate)}
      ${taskLinkChipHtml('list', t.id)}
      <button class="task-del" onclick="removeTask(${list.id},${t.id},this)">×</button>
    </div>`;
  }
  return `
    <div class="task-row dbd-row ${overdue ? 'dbd-overdue-row' : ''}" data-dbd-id="${t.id}">
      <div class="task-check dbd-check ${t.done ? 'done' : ''}" onclick="toggleDbdTask(${t.id})">
        ${CHECK_SVG}
      </div>
      <input class="task-text ${t.done ? 'done' : ''}" value="${escAttr(t.text)}" placeholder="Task…"
        oninput="setDbdText(${t.id}, this.value)"
        onblur="taskLinkFlushRename('dbd',${t.id})">
      ${tagSel}
      ${dbdDateBtnHtml(t.due || dbdTodayKey(), `setDbdDue(${t.id}, this.value)`, showDate)}
      ${taskLinkChipHtml('dbd', t.id)}
      <button class="task-del" onclick="removeDbdTask(${t.id},this)">×</button>
    </div>`;
}

export function renderDbd() {
  const todayKey = dbdTodayKey();
  const all = dbdAllEntries();

  const overdue   = all.filter(e => !e.task.done && e.task.due < todayKey).sort(dbdCompare);
  const upcoming  = all.filter(e => e.task.due >= todayKey).sort(dbdCompare);
  const donePast  = all.filter(e => e.task.done && e.task.due < todayKey).sort(dbdCompare);

  // Group upcoming by due-date key, preserving ascending order.
  const groups = [];
  upcoming.forEach(e => {
    const g = groups[groups.length - 1];
    if (g && g.key === e.task.due) g.entries.push(e);
    else groups.push({ key: e.task.due, entries: [e] });
  });

  let html = '';
  if (overdue.length) {
    html += `
      <div class="dbd-group dbd-group-overdue">
        <div class="dbd-group-header dbd-header-overdue">Overdue
          <span class="dbd-count">${overdue.length}</span></div>
        ${overdue.map(e => dbdRowHtml(e, true, true)).join('')}
      </div>`;
  }
  groups.forEach(g => {
    html += `
      <div class="dbd-group">
        <div class="dbd-group-header">${dbdLabelFor(g.key)}</div>
        ${g.entries.map(e => dbdRowHtml(e, false, false)).join('')}
      </div>`;
  });
  if (donePast.length) {
    html += `
      <div class="dbd-group dbd-group-done">
        <div class="dbd-group-header dbd-header-done">Completed</div>
        ${donePast.map(e => dbdRowHtml(e, false, true)).join('')}
      </div>`;
  }
  if (!html) html = '<div class="empty-state dbd-empty">No day-by-day tasks yet.<br>Add one above with a due date.</div>';

  ['d','m'].forEach(pfx => {
    const el = $(`dbdContainer-${pfx}`);
    if (el) el.innerHTML = html;
  });
  renderHome();
}

/* Midnight rollover: re-flow groups (and default-date inputs) when the day changes. */
export let _dbdDayKey = null;
export function setDbdDayKey(v) { _dbdDayKey = v; }
export function dbdCheckRollover() {
  const k = dbdTodayKey();
  if (k === _dbdDayKey) return;
  _dbdDayKey = k;
  ['d','m'].forEach(pfx => { const el = $(`dbdDate-${pfx}`); if (el) el.value = k; });
  renderDbd();
  renderTodos();   // Daily lists' "active today" can change at midnight too
}
