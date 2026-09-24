/* lists.js — Daily and custom lists: state, cards, same-name task sync, list↔task linking,
 * day-of-week schedules. */
import { CAL_DOW } from './config.js';
import {
  $, calKeyToDate, calToday, CHECK_SVG, CHILD_SVG, closeModal, DOTS_SVG, escAttr, GRIP_SVG,
  keepScroll, showToast, STAR_SVG, SYNC_SVG,
} from './util.js';
import { saveToLocal } from './persistence.js';
import { bindAllDrags } from './drag.js';
import { formatMode } from './formats.js';
import { dbdTodayKey, renderDbd } from './dbd.js';
import {
  taskLinkChipHtml, taskLinkClearAll, taskLinkOnTaskRenamed, taskLinkRef, taskLinkRepaint,
} from './tasklinks.js';
import { homeUpdateProgressDom, renderHome } from './home.js';
import { calRefresh, calSave } from './calendar.js';

export let todoIdCounter = 0;
export function setTodoIdCounter(v) { todoIdCounter = v; }
export function nextTodoId() { return todoIdCounter++; }
export let taskIdCounter = 0;
export function setTaskIdCounter(v) { taskIdCounter = v; }
export function nextTaskId() { return taskIdCounter++; }
export function makeTasks(texts) {
  return texts.map(text => ({ id: taskIdCounter++, text, done: false }));
}
export let todoLists = [
  { id: todoIdCounter++, title: 'Physical Activities', color: '#22C55E', isDefault: true,
    tasks: makeTasks(['Morning Workout/Stretch', 'Gym/Recovery', 'Cardio']) },
  { id: todoIdCounter++, title: 'Social Interactions', color: '#EAB308', isDefault: true,
    tasks: makeTasks(['1','2','3','4','5']) },
];
export function setTodoLists(v) { todoLists = v; }

/* ───────────────────────── TODO LISTS ───────────────────────── */
export function listById(id) { return todoLists.find(l => l.id === id); }

function buildCard(list, pfx) {
  const listDraggable = !list.isDefault || formatMode;
  const card = document.createElement('div');
  card.className = 'todo-card' + (listDraggable ? ' list-reorderable' : '') + (list.starred ? ' starred' : '');
  card.dataset.listId = list.id;
  card.dataset.isDefault = list.isDefault ? '1' : '0';
  card.style.setProperty('--lc', list.color);

  const handleHtml = listDraggable
    ? '<div class="list-drag-handle" title="Drag to reorder">' + GRIP_SVG + '</div>'
    : '';
  const removeBtn = list.isDefault
    ? `<button class="fmt-remove-daily" onclick="removeFormatDaily(${list.id})" title="Remove list">×</button>`
    : `<button class="todo-delete-btn" onclick="removeTodoList(${list.id})" title="Delete list">×</button>`;
  const starBtn =
    `<button class="list-star-btn ${list.starred ? 'starred' : ''}" onclick="toggleStarList(${list.id})"
       title="${list.starred ? 'Unstar list' : 'Star list as more important'}">${STAR_SVG}</button>`;
  const scheduleBtn = list.isDefault
    ? `<button class="list-sched-btn" onclick="openScheduleModal(${list.id})" title="Set active days">${DOTS_SVG}</button>`
    : '';
  const schedSummary = list.isDefault ? fmtDays(list.activeDays) : '';
  // Child-list badge: shown on the list header when this list is linked to a parent task.
  const childListParents = parentTasksForList(list);
  const childListBadge = childListParents.length
    ? `<span class="list-child-badge" title="This list is linked to the &quot;${escAttr(list.title)}&quot; task — complete all tasks here to auto-check it">${CHILD_SVG}</span>`
    : '';
  const isHidden = list.isDefault && Array.isArray(list.activeDays) && list.activeDays.length === 0;
  const schedRow = list.isDefault
    ? `<div class="list-sched-row">${
        isHidden
          ? `<span class="list-sched-pill muted">Hidden — no days selected</span>`
          : schedSummary
            ? `<span class="list-sched-pill">${schedSummary}</span>`
            : `<span class="list-sched-pill muted">Every day</span>`
      }</div>`
    : '';

  const taskRows = list.tasks.map(task => {
    const rowHandle = !list.isDefault
      ? '<div class="drag-handle" title="Drag to reorder">' + GRIP_SVG + '</div>'
      : '';
    const checkStyle = task.done ? `background:${list.color};border-color:${list.color}` : '';
    const syncBadge = isTaskSynced(list, task)
      ? `<span class="task-sync-badge" title="Synced with matching daily tasks — checking one checks them all">${SYNC_SVG}</span>`
      : '';
    const parentBadge = (list.isDefault && childListsForTask(task).length)
      ? `<span class="task-sync-badge task-parent-badge" title="Linked to the &quot;${escAttr(task.text)}&quot; list — all subtasks complete = this task checks off">${CHILD_SVG}</span>`
      : '';
    const dateCtl = !list.isDefault ? taskDateCtlHtml(list, task) : '';
    const calCtl  = !list.isDefault ? taskLinkChipHtml('list', task.id) : '';
    return `
      <div class="task-row" data-task-id="${task.id}" data-list-id="${list.id}">
        ${rowHandle}
        <div class="task-check task-checks-${task.id} ${task.done?'done':''}" style="${checkStyle}"
          onclick="toggleTask(${list.id},${task.id})">
          ${CHECK_SVG}
        </div>
        <input class="task-text task-text-${task.id} ${task.done?'done':''}"
          value="${escAttr(task.text)}" placeholder="Task…"
          oninput="setTaskText(${list.id},${task.id},this.value)"
          onblur="refreshSyncBadges();taskLinkFlushRename('list',${task.id})"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addTask(${list.id});}">
        ${dateCtl}
        ${calCtl}
        ${syncBadge}
        ${parentBadge}
        <button class="task-del" onclick="removeTask(${list.id},${task.id})">×</button>
      </div>`;
  }).join('');

  card.innerHTML = `
    <div class="todo-accent-strip todo-strip-${list.id}" style="background:${list.color}"></div>
    <div class="todo-card-header">
      ${handleHtml}
      <div class="color-swatch todo-swatch-${list.id}" style="background:${list.color}">
        <input type="color" value="${list.color}" oninput="changeTodoColor(${list.id}, this.value)">
      </div>
      <input class="todo-title-input" id="todo-title-${list.id}-${pfx}" value="${escAttr(list.title)}" placeholder="List title"
        oninput="setListTitle(${list.id}, this.value)"
        onblur="refreshSyncBadges()">
      ${childListBadge}
      ${starBtn}
      ${scheduleBtn}
      ${removeBtn}
    </div>
    ${schedRow}
    <div class="todo-tasks" data-list-id="${list.id}">${taskRows}</div>
    <div class="todo-add-task">
      <button class="add-task-btn" onclick="addTask(${list.id})">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M5.5 1V10M1 5.5H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Add task
      </button>
    </div>`;
  return card;
}

/* ── Task date control (custom lists only): a chip that opens the native
 *    date picker through an invisible <input type=date> overlay. Setting a
 *    date surfaces the task in the Day by Day section; the × clears it. ── */
export const CALICON_SVG = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 4.8h10" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 1v2M8.5 1v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

export function taskDateChipLabel(due) {
  const today = calToday();
  const date = calKeyToDate(due);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tmrw';
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== today.getFullYear()) opts.year = '2-digit';
  return date.toLocaleDateString(undefined, opts);
}

function taskDateCtlHtml(list, task) {
  if (task.due) {
    const overdue = !task.done && task.due < dbdTodayKey();
    return `<label class="task-date-chip has-date ${overdue ? 'overdue' : ''}"${overdue ? '' : ` style="color:${list.color}"`} title="In Day by Day — tap to change date">${CALICON_SVG}<span>${taskDateChipLabel(task.due)}</span><input type="date" value="${escAttr(task.due)}" onchange="setListTaskDue(${list.id},${task.id},this.value)"></label><button class="task-date-clear" onclick="setListTaskDue(${list.id},${task.id},'')" title="Remove from Day by Day">×</button>`;
  }
  return `<label class="task-date-chip" title="Add to Day by Day">${CALICON_SVG}<input type="date" onchange="setListTaskDue(${list.id},${task.id},this.value)"></label>`;
}

function isListActiveToday(list) {
  if (!list.activeDays) return true;                  // null → shows every day
  if (list.activeDays.length === 0) return false;     // [] → no days selected → hidden
  return list.activeDays.includes(new Date().getDay());
}

function fmtDays(days) {
  if (!days || !days.length || days.length === 7) return '';
  return days.slice().sort((a,b) => a-b).map(d => CAL_DOW[d]).join(', ');
}

/* ── Daily task auto-sync (Approach 1): tasks with the same name across Daily
 *    lists stay in lockstep. Match is trimmed + case-insensitive; blank names
 *    never sync. Derived purely from names, so nothing extra is persisted.    */
function normTaskName(s) { return (s || '').trim().toLowerCase(); }

// Recomputed each render: name-keys that appear on 2+ Daily tasks (→ show link badge).
let _syncedNameKeys = new Set();
function computeSyncedKeys() {
  const counts = {};
  todoLists.forEach(l => {
    if (!l.isDefault) return;
    l.tasks.forEach(tk => {
      const k = normTaskName(tk.text);
      if (k) counts[k] = (counts[k] || 0) + 1;
    });
  });
  _syncedNameKeys = new Set(Object.keys(counts).filter(k => counts[k] >= 2));
}
function isTaskSynced(list, task) {
  return !!(list.isDefault && _syncedNameKeys.has(normTaskName(task.text)));
}

// All Daily tasks (incl. the source) that share the source task's name.
function syncedTaskTargets(srcList, srcTask) {
  const out = [{ list: srcList, task: srcTask }];
  if (!srcList.isDefault) return out;       // only Daily lists sync
  const key = normTaskName(srcTask.text);
  if (!key) return out;                     // blank names never sync
  todoLists.forEach(l => {
    if (!l.isDefault) return;
    l.tasks.forEach(tk => {
      if (l === srcList && tk === srcTask) return;
      if (normTaskName(tk.text) === key) out.push({ list: l, task: tk });
    });
  });
  return out;
}

/* ── List↔Task linking (Approach 2): a Daily list whose title matches a Daily
 *    task name acts as a "child" of that task.
 *    • Checking all tasks in the child list → auto-checks the parent task(s)
 *      (and all their cross-list synced twins via the existing Approach 1 logic).
 *    • Unchecking the parent task → unchecks every task in the child list.
 *    Match is trimmed + case-insensitive; blank titles never link.             */

// Find all Daily lists whose title matches the given task name key.
function childListsForTask(task) {
  const key = normTaskName(task.text);
  if (!key) return [];
  return todoLists.filter(l => l.isDefault && normTaskName(l.title) === key);
}

// Find all {list, task} pairs (across all Daily lists) whose task text matches
// the given list's title — i.e. the "parent" tasks of a child list.
function parentTasksForList(list) {
  if (!list.isDefault) return [];
  const key = normTaskName(list.title);
  if (!key) return [];
  const out = [];
  todoLists.forEach(l => {
    if (!l.isDefault) return;
    l.tasks.forEach(tk => {
      if (normTaskName(tk.text) === key) out.push({ list: l, task: tk });
    });
  });
  return out;
}

// True when the list has tasks and every one of them is done (an empty list never is).
function isListComplete(list) {
  return list.tasks.length > 0 && list.tasks.every(t => t.done);
}

// After any task state change: walk up the parent chain and keep parent tasks
// in sync with their child-list completion state.
// `visitedListIds` guards against hypothetical circular references.
function propagateUpFromList(list, visitedListIds = new Set()) {
  if (visitedListIds.has(list.id)) return;
  visitedListIds.add(list.id);
  const parents = parentTasksForList(list);
  if (!parents.length) return;
  const complete = isListComplete(list);
  parents.forEach(({ list: pList, task: pTask }) => {
    if (pTask.done === complete) return;          // already correct, skip
    // Use syncedTaskTargets so Approach 1 cross-list sync still fires.
    // Collect every list a twin lives in — any of them may have just become
    // complete/incomplete, so each must be re-evaluated upward (not just pList).
    const twinLists = new Set();
    syncedTaskTargets(pList, pTask).forEach(({ list: l, task: tk }) => {
      tk.done = complete;
      paintTaskState(l, tk);
      twinLists.add(l);
    });
    // Recurse: each of these lists may itself be a child of something else.
    twinLists.forEach(l => propagateUpFromList(l, visitedListIds));
  });
}

function paintTaskState(list, task) {
  document.querySelectorAll(`.task-checks-${task.id}`).forEach(el => {
    el.classList.toggle('done', task.done);
    el.style.background  = task.done ? list.color : '';
    el.style.borderColor = task.done ? list.color : '';
  });
  document.querySelectorAll(`.task-text-${task.id}`).forEach(el => el.classList.toggle('done', task.done));
}

export function renderTodos() {
  computeSyncedKeys();
  ['d','m'].forEach(pfx => {
    const defEl   = $(`defaultContainer-${pfx}`);
    const custEl  = $(`todoContainer-${pfx}`);
    const emptyEl = $(`emptyState-${pfx}`);
    if (!defEl || !custEl) return;
    defEl.querySelectorAll('.todo-card, .daily-empty').forEach(c => c.remove());
    custEl.querySelectorAll('.todo-card').forEach(c => c.remove());

    const dailyLists  = todoLists.filter(l => l.isDefault);
    const customLists = todoLists.filter(l => !l.isDefault);
    // Format mode shows every daily list (for editing); user mode only today's.
    const visibleDaily = formatMode ? dailyLists : dailyLists.filter(isListActiveToday);

    if (emptyEl) emptyEl.style.display = customLists.length === 0 ? 'block' : 'none';
    visibleDaily.forEach(l => defEl.appendChild(buildCard(l, pfx)));

    if (!formatMode && visibleDaily.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-state daily-empty';
      if (dailyLists.length > 0) hint.textContent = 'No lists scheduled for today.';
      else hint.innerHTML = 'No daily lists yet.<br>Open Formats to add one.';
      defEl.appendChild(hint);
    }
    customLists.forEach(l => custEl.appendChild(buildCard(l, pfx)));
  });
  bindAllDrags();
  renderHome();
}

export function setListTitle(id, value) {
  const l = listById(id);
  if (l) { l.title = value; saveToLocal(); }
}

export function toggleStarList(id) {
  const l = listById(id);
  if (!l) return;
  l.starred = !l.starred;
  renderTodos();
  saveToLocal();
}

export function addTodoList() {
  const id = todoIdCounter++;
  todoLists.push({ id, title: '', color: '#5DCAA5', tasks: [], isDefault: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = $(`todo-title-${id}-d`) || $(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

export function removeTodoList(id) {
  todoLists = todoLists.filter(l => l.id !== id);
  keepScroll(() => {
    renderTodos();
    renderDbd();   // any dated tasks the list held leave Day by Day too
  });
  saveToLocal();
}

export function changeTodoColor(id, color) {
  document.querySelectorAll(`.todo-card[data-list-id="${id}"]`).forEach(el => el.style.setProperty('--lc', color));
  const list = listById(id);
  if (!list) return;
  list.color = color;
  document.querySelectorAll(`.todo-swatch-${id}`).forEach(s => s.style.background = color);
  document.querySelectorAll(`.todo-strip-${id}`).forEach(s => s.style.background = color);
  list.tasks.forEach(t => {
    if (!t.done) return;
    document.querySelectorAll(`.task-checks-${t.id}`).forEach(c => {
      c.style.background = color; c.style.borderColor = color;
    });
  });
  // Tagged rows in Day by Day carry the list color (accent bar, select tint).
  if (!list.isDefault && list.tasks.some(t => t.due)) renderDbd();
  saveToLocal();
}

export function addTask(listId) {
  const list = listById(listId);
  if (!list) return;
  if (list.isDefault && !formatMode) return;
  const tid = taskIdCounter++;
  list.tasks.push({ id: tid, text: '', done: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = document.querySelector(`input.task-text-${tid}`);
    if (inp) inp.focus();
  }, 10);
}

export function removeTask(listId, taskId) {
  const list = listById(listId);
  if (!list) return;
  if (list.isDefault && !formatMode) return;
  list.tasks = list.tasks.filter(t => t.id !== taskId);
  keepScroll(() => {
    if (taskLinkClearAll(taskLinkRef('list', taskId))) { calSave(); calRefresh(); }
    renderTodos();
    renderDbd();
  });
  saveToLocal();
}

export function setTaskText(listId, taskId, value) {
  const list = listById(listId);
  const task = list && list.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.text = value;
  // A dated task renders both in its list card and in Day by Day — keep the
  // copy the user is NOT typing in up to date without a focus-stealing render.
  document.querySelectorAll(`input.task-text-${taskId}`).forEach(el => {
    if (el !== document.activeElement) el.value = value;
  });
  if (!list.isDefault) taskLinkOnTaskRenamed(taskLinkRef('list', taskId), value);
  saveToLocal();
}

// Add/remove the link badge in place after a rename, without rebuilding inputs
// (a full re-render would steal focus mid-edit).
export function refreshSyncBadges() {
  computeSyncedKeys();

  // ── Task-row badges (Approach 1 sync + Approach 2 parent badge) ──────────
  document.querySelectorAll('.task-row').forEach(row => {
    const listId = parseInt(row.dataset.listId);
    const taskId = parseInt(row.dataset.taskId);
    const list = listById(listId);
    const task = list && list.tasks.find(t => t.id === taskId);
    if (!list || !task) return;
    const delBtn = row.querySelector('.task-del');

    // Approach 1: cross-list sync badge
    const existingSync = row.querySelector('.task-sync-badge:not(.task-parent-badge)');
    const shouldSync = isTaskSynced(list, task);
    if (shouldSync && !existingSync) {
      const span = document.createElement('span');
      span.className = 'task-sync-badge';
      span.title = 'Synced with matching daily tasks — checking one checks them all';
      span.innerHTML = SYNC_SVG;
      row.insertBefore(span, delBtn);
    } else if (!shouldSync && existingSync) {
      existingSync.remove();
    }

    // Approach 2: parent-task badge (task has a linked child list)
    const existingParent = row.querySelector('.task-parent-badge');
    const shouldParent = list.isDefault && childListsForTask(task).length > 0;
    if (shouldParent && !existingParent) {
      const span = document.createElement('span');
      span.className = 'task-sync-badge task-parent-badge';
      span.title = 'Linked to the "' + task.text + '" list — all subtasks complete = this task checks off';
      span.innerHTML = CHILD_SVG;
      row.insertBefore(span, delBtn);
    } else if (!shouldParent && existingParent) {
      existingParent.remove();
    }
  });

  // ── List-header child badge (Approach 2: this list is a child of a parent task) ──
  document.querySelectorAll('.todo-card').forEach(card => {
    const listId = parseInt(card.dataset.listId);
    const list = listById(listId);
    if (!list) return;
    const header = card.querySelector('.todo-card-header');
    if (!header) return;
    const existingChildBadge = header.querySelector('.list-child-badge');
    const parents = parentTasksForList(list);
    if (parents.length && !existingChildBadge) {
      const span = document.createElement('span');
      span.className = 'list-child-badge';
      span.title = 'This list is linked to the "' + list.title + '" task — complete all tasks here to auto-check it';
      span.innerHTML = CHILD_SVG;
      // Insert before the sched button (or remove button if no sched button).
      const schedBtn = header.querySelector('.list-sched-btn');
      const anchor = schedBtn || header.querySelector('.fmt-remove-daily') || header.querySelector('.todo-delete-btn');
      header.insertBefore(span, anchor || null);
    } else if (!parents.length && existingChildBadge) {
      existingChildBadge.remove();
    }
  });
}

// After a parent task's done-state changes: push that state onto every task
// in its linked child list(s) — both directions (check AND uncheck).
// Recurses in case a child-list task is itself a parent of another list.
// `visitedListIds` guards against hypothetical circular references.
function propagateDownFromTask(task, done, visitedListIds = new Set(), affectedLists = null) {
  childListsForTask(task).forEach(childList => {
    if (visitedListIds.has(childList.id)) return;
    visitedListIds.add(childList.id);
    if (affectedLists) affectedLists.add(childList);
    childList.tasks.forEach(ct => {
      if (ct.done === done) return;               // already correct, skip
      // Use syncedTaskTargets so Approach 1 cross-list sync still fires.
      syncedTaskTargets(childList, ct).forEach(({ list: l, task: tk }) => {
        tk.done = done;
        paintTaskState(l, tk);
        // A twin in ANOTHER list changed too → that list may now be
        // complete/incomplete, so it must be re-checked in the UP pass.
        if (affectedLists) affectedLists.add(l);
      });
      propagateDownFromTask(ct, done, visitedListIds, affectedLists);
    });
  });
}

export function toggleTask(listId, taskId) {
  const list = listById(listId);
  if (!list) return;
  const task = list.tasks.find(t => t.id === taskId);
  if (!task) return;
  const newDone = !task.done;

  // Track every list whose task state changes during this toggle, so the
  // UP pass can re-evaluate ALL of them (not just the list that was clicked).
  const affectedLists = new Set([list]);

  // Apply to this task and every synced twin across Daily lists (Approach 1).
  let touchedDated = false;
  const targets = syncedTaskTargets(list, task);
  targets.forEach(({ list: l, task: tk }) => {
    tk.done = newDone;
    paintTaskState(l, tk);
    affectedLists.add(l);

    // Dated tasks mirror dbd semantics: doneOn lets today's progress count an
    // overdue task cleared today, and the Day by Day groups must re-flow.
    if (tk.due) {
      touchedDated = true;
      if (newDone) tk.doneOn = dbdTodayKey(); else delete tk.doneOn;
    }

    // ── Approach 2 ──────────────────────────────────────────────────────────
    // DOWN: checking OR unchecking a task pushes that same state onto every
    // task in its linked child list(s).
    propagateDownFromTask(tk, newDone, new Set(), affectedLists);
  });

  // UP: re-evaluate completion for every list that changed. Previously this
  // only ran on the clicked list, so checking a synced twin from another list
  // (e.g. "Subtask 1" via "Morning") completed the "Task 1" list but never
  // checked its parent task. Now each affected list is walked upward.
  affectedLists.forEach(l => {
    if (l && l.isDefault) propagateUpFromList(l);
  });

  if (touchedDated) renderDbd();   // re-group (overdue/today/completed) + repaint tags
  saveToLocal();
  homeUpdateProgressDom();
  if (!list.isDefault) taskLinkRepaint(taskLinkRef('list', taskId));
}

export function moveList(fromListId, toListId, placeAfter, isDefault) {
  const group = todoLists.filter(l => l.isDefault === isDefault);
  const fromIdx = group.findIndex(l => l.id === fromListId);
  let   toIdx   = group.findIndex(l => l.id === toListId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = group.splice(fromIdx, 1);
  toIdx = group.findIndex(l => l.id === toListId);   // re-find after removal
  const insertAt = toIdx + (placeAfter ? 1 : 0);
  group.splice(insertAt, 0, moved);
  const other = todoLists.filter(l => l.isDefault !== isDefault);
  todoLists = isDefault ? [...group, ...other] : [...other, ...group];
  renderTodos();
  saveToLocal();
}

export function moveTask(taskId, fromListId, toListId, beforeTaskId, placeAfter) {
  const fromList = listById(fromListId);
  const toList   = listById(toListId);
  if (!fromList || !toList) return;
  const taskIdx = fromList.tasks.findIndex(t => t.id === taskId);
  if (taskIdx === -1) return;
  const [task] = fromList.tasks.splice(taskIdx, 1);
  if (beforeTaskId != null) {
    let idx = toList.tasks.findIndex(t => t.id === beforeTaskId);
    if (idx === -1) idx = toList.tasks.length;
    else if (placeAfter) idx += 1;
    toList.tasks.splice(idx, 0, task);
  } else {
    toList.tasks.push(task);
  }
  renderTodos();
  renderDbd();
  saveToLocal();
}

/* ── Daily-list day-of-week schedule ── */
let scheduleEditListId = null;

export function openScheduleModal(listId) {
  const list = listById(listId);
  if (!list) return;
  scheduleEditListId = listId;
  $('scheduleSub').textContent =
    `Choose which days "${list.title || 'this list'}" appears in Daily.`;
  const row = $('scheduleDowRow');
  row.innerHTML = '';
  // null = "every day" → pre-select all 7 buttons (otherwise an untouched
  // Save would read as 0 selected and wrongly hide the list).
  const active = list.activeDays === null || list.activeDays === undefined
    ? [0,1,2,3,4,5,6]
    : list.activeDays;
  CAL_DOW.forEach((name, i) => {
    const btn = document.createElement('button');
    btn.className = 'cal-dow-btn' + (active.includes(i) ? ' active' : '');
    btn.textContent = name[0];
    btn.title = name;
    btn.dataset.dow = i;
    btn.onclick = () => { btn.classList.toggle('active'); updateScheduleHint(); };
    row.appendChild(btn);
  });
  updateScheduleHint();
  $('scheduleModal').classList.add('show');
}

function scheduleSelectedDays() {
  return Array.from(document.querySelectorAll('#scheduleDowRow .cal-dow-btn.active'))
    .map(b => parseInt(b.dataset.dow));
}

function updateScheduleHint() {
  const active = scheduleSelectedDays();
  const hint = $('scheduleHint');
  if (active.length === 0) hint.textContent = 'Hidden — this list won\u2019t appear on any day.';
  else if (active.length === 7) hint.textContent = 'Shows every day.';
  else hint.textContent = 'Shows on: ' + active.sort((a,b)=>a-b).map(d => CAL_DOW[d]).join(', ');
}

export function scheduleEveryDay() {
  // Under the new semantics, zero selected = hidden — so "every day" must
  // SELECT all seven buttons (saveSchedule normalizes 7/7 back to null).
  document.querySelectorAll('#scheduleDowRow .cal-dow-btn').forEach(b => b.classList.add('active'));
  updateScheduleHint();
}

export function saveSchedule() {
  const list = listById(scheduleEditListId);
  if (!list) { closeModal('scheduleModal'); return; }
  const active = scheduleSelectedDays();
  // All 7 selected = "every day" → store null to keep data clean.
  // 0 selected = "hidden" → store [] so the list never appears in Daily.
  list.activeDays = active.length === 7 ? null
                  : active.length === 0 ? []
                  : active.sort((a,b)=>a-b);
  closeModal('scheduleModal');
  scheduleEditListId = null;
  renderTodos();
  saveToLocal();
  showToast('Schedule saved ✓');
}
