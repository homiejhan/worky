/* ================================================================
   app.js — Focus Productivity Dashboard
   Sections:
     1. State
     2. Mobile Swipe
     3. Timer Utilities & Rendering
     4. Timer Actions
     5. Wakeup
     6. Todo Lists & Tasks
     7. Drag & Drop
     8. Format Mode
     9. Save / Load (localStorage + Export / Import)
    10. Reset All
    11. Init
   ================================================================ */


/* ═══════════════════════════════════════════════════════════════
   1. STATE
   ═══════════════════════════════════════════════════════════════ */

// Mutable defaults — updated when Format mode is committed
let TIMER_DEFAULTS = [
  { label: 'Productivity Timer',   seconds: 6 * 3600, color: '#378ADD' },
  { label: 'Personal Development', seconds: 4 * 3600, color: '#EC3636' },
  { label: 'Time with God',        seconds: 2 * 3600, color: '#8B5CF6' },
  { label: 'Skill Development',    seconds: 1 * 3600, color: '#F97316' },
];

let formatMode = false;
let formatTimerIdCounter = 900; // high range avoids clashing with regular timer ids

let wokenUp = false;

let timers = TIMER_DEFAULTS.map((t, i) => ({
  id: i, label: t.label, seconds: t.seconds, color: t.color,
  running: false, startedAt: null, secondsAtStart: null,
}));

let todoIdCounter = 0;
let taskIdCounter = 0;

function makeTasks(texts) {
  return texts.map(text => ({ id: taskIdCounter++, text, done: false }));
}

let todoLists = [
  {
    id: todoIdCounter++, title: 'Physical Activities', color: '#22C55E',
    isDefault: true, tasks: makeTasks(['Morning Workout/Stretch', 'Gym/Recovery', 'Cardio']),
  },
  {
    id: todoIdCounter++, title: 'Social Interactions', color: '#EAB308',
    isDefault: true, tasks: makeTasks(['1', '2', '3', '4', '5']),
  },
];


/* ═══════════════════════════════════════════════════════════════
   2. MOBILE SWIPE
   ═══════════════════════════════════════════════════════════════ */

let currentTab = 0;
let touchStartX = 0;
let touchStartY = 0;
let isSwiping = false;

function setSwipePanelWidths() {
  const w = window.innerWidth;
  const track = document.getElementById('swipeTrack');
  const panels = document.querySelectorAll('.swipe-panel');
  if (track) track.style.width = (w * 3) + 'px';
  panels.forEach(p => p.style.width = w + 'px');
  goTab(currentTab, false);
}

function goTab(idx, animate) {
  currentTab = idx;
  const w = window.innerWidth;
  const track = document.getElementById('swipeTrack');
  if (track) {
    track.style.transition = animate === false
      ? 'none'
      : 'transform 0.32s cubic-bezier(0.4,0,0.2,1)';
    track.style.transform = `translateX(${-idx * w}px)`;
  }
  [0, 1, 2].forEach(i => {
    const btn = document.getElementById(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === idx);
  });
}

function initSwipe() {
  const swipeEl = document.getElementById('swipeContainer');
  if (!swipeEl) return;

  swipeEl.addEventListener('touchstart', e => {
    const target = e.target;
    if (
      target.tagName === 'INPUT' || target.tagName === 'BUTTON' ||
      target.tagName === 'SELECT' || target.closest('button') || target.closest('input')
    ) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isSwiping = false;
  }, { passive: true });

  swipeEl.addEventListener('touchmove', e => {
    if (!touchStartX) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (!isSwiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
      isSwiping = true;
    }
  }, { passive: true });

  swipeEl.addEventListener('touchend', e => {
    if (!isSwiping) { touchStartX = 0; return; }
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      goTab(dx < 0 ? Math.min(currentTab + 1, 2) : Math.max(currentTab - 1, 0), true);
    }
    touchStartX = 0;
    isSwiping = false;
  }, { passive: true });
}

window.addEventListener('resize', setSwipePanelWidths);


/* ═══════════════════════════════════════════════════════════════
   3. TIMER UTILITIES & RENDERING
   ═══════════════════════════════════════════════════════════════ */

function fmt(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;
}

function parseTime(str) {
  const p = str.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 3600 + p[1] * 60;
  return NaN;
}

function getRemaining(t) {
  if (t.running) return Math.max(0, t.secondsAtStart - (Date.now() - t.startedAt) / 1000);
  return t.seconds;
}

function playIcon() {
  return `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1.2L9 6L1 10.8V1.2Z" fill="currentColor"/></svg>`;
}
function pauseIcon() {
  return `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="1" width="3" height="10" rx="1" fill="currentColor"/><rect x="6" y="1" width="3" height="10" rx="1" fill="currentColor"/></svg>`;
}
function resetIcon() {
  return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5A4 4 0 1 0 2.9 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M1.5 2V5.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function tickAll() {
  timers.forEach(t => {
    if (!t.running) return;
    const rem = getRemaining(t);
    document.querySelectorAll(`.tdisp-${t.id}`).forEach(el => el.textContent = fmt(rem));
    if (rem <= 0) { t.seconds = 0; t.running = false; updateTimerUI(t.id); }
  });
  requestAnimationFrame(tickAll);
}

function timerCardHTML(t, pfx) {
  return `
    <div class="timer-header">
      <div class="color-swatch" style="background:${t.color}">
        <input type="color" value="${t.color}"
          oninput="changeTimerColor(${t.id}, this.value); saveToLocal();">
      </div>
      <input class="timer-title-input" value="${t.label}" placeholder="Timer name"
        oninput="timers.find(x=>x.id===${t.id}).label=this.value;
                 if(formatMode){const idx=timers.findIndex(x=>x.id===${t.id});if(TIMER_DEFAULTS[idx])TIMER_DEFAULTS[idx].label=this.value;}
                 saveToLocal();">
    </div>
    <div class="timer-body">
      <div class="timer-accent-bar tbar-${t.id}" style="background:${t.color}"></div>
      <div class="timer-display tdisp-${t.id}" onclick="startEditTimer(${t.id},'${pfx}')">${fmt(t.seconds)}</div>
      <input class="timer-time-edit tedit-${t.id}-${pfx}" type="text" placeholder="h:mm:ss"
        onblur="commitEditTimer(${t.id},'${pfx}')"
        onkeydown="if(event.key==='Enter') commitEditTimer(${t.id},'${pfx}')">
      <button class="play-btn playbtn-${t.id} ${t.running ? 'running' : ''}" onclick="toggleTimer(${t.id})">
        ${t.running ? pauseIcon() : playIcon()}
      </button>
      <button class="reset-btn" onclick="resetTimer(${t.id})" title="Reset">${resetIcon()}</button>
      <button class="fmt-remove-timer" onclick="removeFormatTimer(${t.id})" title="Remove timer">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="timer-sub tsub-${t.id}">${t.running ? 'running' : 'paused'} · click time to edit</div>
  `;
}

function renderTimers() {
  [['leftPanel', 'd'], ['mobileTimerPanel', 'm']].forEach(([panelId, pfx]) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.querySelectorAll('.timer-card').forEach(el => el.remove());
    timers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'timer-card';
      card.innerHTML = timerCardHTML(t, pfx);
      panel.appendChild(card);
    });
  });
}


/* ═══════════════════════════════════════════════════════════════
   4. TIMER ACTIONS
   ═══════════════════════════════════════════════════════════════ */

function changeTimerColor(id, color) {
  const t = timers.find(x => x.id === id);
  if (t) t.color = color;
  document.querySelectorAll(`.tbar-${id}`).forEach(el => el.style.background = color);
}

function toggleTimer(id) {
  const t = timers.find(x => x.id === id);
  if (!t) return;
  if (t.running) {
    t.seconds = getRemaining(t);
    t.running = false;
  } else {
    if (t.seconds <= 0) return;
    t.startedAt = Date.now();
    t.secondsAtStart = t.seconds;
    t.running = true;
  }
  updateTimerUI(id);
  saveToLocal();
}

function updateTimerUI(id) {
  const t = timers.find(x => x.id === id);
  if (!t) return;
  document.querySelectorAll(`.playbtn-${id}`).forEach(btn => {
    btn.innerHTML = t.running ? pauseIcon() : playIcon();
    btn.classList.toggle('running', t.running);
  });
  document.querySelectorAll(`.tsub-${id}`).forEach(el => {
    el.textContent = (t.running ? 'running' : 'paused') + ' · click time to edit';
  });
}

function startEditTimer(id, pfx) {
  const t = timers.find(x => x.id === id);
  if (!t || t.running) return;
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => el.style.display = 'none');
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) { edit.style.display = 'block'; edit.value = fmt(t.seconds); edit.focus(); edit.select(); }
}

function commitEditTimer(id, pfx) {
  const t = timers.find(x => x.id === id);
  if (!t) return;
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) {
    const parsed = parseTime(edit.value);
    if (!isNaN(parsed) && parsed >= 0) {
      t.seconds = parsed;
      if (t.running) { t.startedAt = Date.now(); t.secondsAtStart = parsed; }
    }
    edit.style.display = 'none';
  }
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => {
    el.style.display = 'block';
    el.textContent = fmt(t.seconds);
  });
  saveToLocal();
}

function resetTimer(id) {
  const t = timers.find(x => x.id === id);
  if (!t) return;
  const idx = timers.findIndex(x => x.id === id);
  t.running = false;
  t.seconds = (TIMER_DEFAULTS[idx] ?? TIMER_DEFAULTS[0]).seconds;
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


/* ═══════════════════════════════════════════════════════════════
   5. WAKEUP
   ═══════════════════════════════════════════════════════════════ */

function toggleWakeup() {
  wokenUp = !wokenUp;
  ['d', 'm'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
  saveToLocal();
}


/* ═══════════════════════════════════════════════════════════════
   6. TODO LISTS & TASKS
   ═══════════════════════════════════════════════════════════════ */

function addTodoList() {
  const id = todoIdCounter++;
  todoLists.push({ id, title: '', color: '#5DCAA5', tasks: [], isDefault: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = document.getElementById(`todo-title-${id}-d`) ||
                document.getElementById(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

function removeTodoList(id) {
  todoLists = todoLists.filter(l => l.id !== id);
  renderTodos();
  saveToLocal();
}

function changeTodoColor(id, color) {
  const list = todoLists.find(l => l.id === id);
  if (!list) return;
  list.color = color;
  document.querySelectorAll(`.todo-swatch-${id}`).forEach(s => s.style.background = color);
  document.querySelectorAll(`.todo-strip-${id}`).forEach(s => s.style.background = color);
  document.querySelectorAll(`.task-checks-${id}.done`).forEach(c => {
    c.style.background = color;
    c.style.borderColor = color;
  });
}

function addTask(listId) {
  const list = todoLists.find(l => l.id === listId);
  if (!list) return;
  const tid = taskIdCounter++;
  list.tasks.push({ id: tid, text: '', done: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = document.querySelector(`input.task-text-${tid}`);
    if (inp) inp.focus();
  }, 10);
}

function removeTask(listId, taskId) {
  const list = todoLists.find(l => l.id === listId);
  if (!list) return;
  list.tasks = list.tasks.filter(t => t.id !== taskId);
  renderTodos();
  saveToLocal();
}

function toggleTask(listId, taskId) {
  const list = todoLists.find(l => l.id === listId);
  if (!list) return;
  const task = list.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.done = !task.done;
  document.querySelectorAll(`.task-checks-${taskId}`).forEach(el => {
    el.classList.toggle('done', task.done);
    el.style.background = task.done ? list.color : '';
    el.style.borderColor = task.done ? list.color : '';
  });
  document.querySelectorAll(`.task-text-${taskId}`).forEach(el => el.classList.toggle('done', task.done));
  saveToLocal();
}

function buildCard(list, pfx) {
  const card = document.createElement('div');
  card.className = 'todo-card';
  card.setAttribute('data-listid', list.id);
  card.innerHTML = `
    <div class="todo-accent-strip todo-strip-${list.id}" style="background:${list.color}"></div>
    <div class="todo-card-header">
      <div class="color-swatch todo-swatch-${list.id}" style="background:${list.color}">
        <input type="color" value="${list.color}"
          oninput="changeTodoColor(${list.id}, this.value); saveToLocal();"
          onchange="changeTodoColor(${list.id}, this.value); saveToLocal();">
      </div>
      <input class="todo-title-input" id="todo-title-${list.id}-${pfx}"
        value="${list.title}" placeholder="List title"
        oninput="todoLists.find(l=>l.id===${list.id}).title=this.value; saveToLocal();">
      ${list.isDefault
        ? `<button class="fmt-remove-daily" onclick="removeFormatDaily(${list.id})">×</button>`
        : `<button class="todo-delete-btn" onclick="removeTodoList(${list.id})">×</button>`
      }
    </div>
    <div class="todo-tasks">
      ${list.tasks.map(task => `
        <div class="task-row" data-task-id="${task.id}" data-list-id="${list.id}"
          ${!list.isDefault ? 'draggable="true"' : ''}>
          ${!list.isDefault
            ? `<div class="drag-handle" title="Drag to reorder">
                <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                  <circle cx="3" cy="3"  r="1.2" fill="currentColor"/>
                  <circle cx="7" cy="3"  r="1.2" fill="currentColor"/>
                  <circle cx="3" cy="7"  r="1.2" fill="currentColor"/>
                  <circle cx="7" cy="7"  r="1.2" fill="currentColor"/>
                  <circle cx="3" cy="11" r="1.2" fill="currentColor"/>
                  <circle cx="7" cy="11" r="1.2" fill="currentColor"/>
                </svg>
              </div>`
            : ''
          }
          <div class="task-check task-checks-${task.id} ${task.done ? 'done' : ''}"
            style="${task.done ? `background:${list.color};border-color:${list.color}` : ''}"
            onclick="toggleTask(${list.id}, ${task.id})">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <input class="task-text task-text-${task.id} ${task.done ? 'done' : ''}"
            value="${task.text}" placeholder="Task…"
            oninput="todoLists.find(l=>l.id===${list.id}).tasks.find(t=>t.id===${task.id}).text=this.value; saveToLocal();"
            onkeydown="if(event.key==='Enter'){event.preventDefault(); addTask(${list.id});}">
          <button class="task-del" onclick="removeTask(${list.id}, ${task.id})">×</button>
        </div>
      `).join('')}
    </div>
    <div class="todo-add-task">
      <button class="add-task-btn" onclick="addTask(${list.id})">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M5.5 1V10M1 5.5H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Add task
      </button>
    </div>
  `;
  return card;
}

function renderTodos() {
  ['d', 'm'].forEach(pfx => {
    const defEl   = document.getElementById(`defaultContainer-${pfx}`);
    const custEl  = document.getElementById(`todoContainer-${pfx}`);
    const emptyEl = document.getElementById(`emptyState-${pfx}`);
    if (!defEl || !custEl) return;

    defEl.querySelectorAll('.todo-card').forEach(c => c.remove());
    custEl.querySelectorAll('.todo-card').forEach(c => c.remove());

    const customLists = todoLists.filter(l => !l.isDefault);
    if (emptyEl) emptyEl.style.display = customLists.length === 0 ? 'block' : 'none';

    todoLists.filter(l => l.isDefault).forEach(l => defEl.appendChild(buildCard(l, pfx)));
    customLists.forEach(l => custEl.appendChild(buildCard(l, pfx)));
  });

  initDragDrop();
}


/* ═══════════════════════════════════════════════════════════════
   7. DRAG & DROP  (My Lists only)
   ═══════════════════════════════════════════════════════════════ */

let dragTaskId   = null;
let dragFromListId = null;

function initDragDrop() {
  // ── Desktop HTML5 drag ──
  document.querySelectorAll('.task-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragTaskId     = parseInt(row.dataset.taskId);
      dragFromListId = parseInt(row.dataset.listId);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      document.querySelectorAll('.drag-over-empty').forEach(el => el.classList.remove('drag-over-empty'));
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      const toTaskId  = parseInt(row.dataset.taskId);
      const toListId  = parseInt(row.dataset.listId);
      if (dragTaskId === toTaskId) return;
      moveTask(dragTaskId, dragFromListId, toListId, toTaskId);
    });
  });

  // Drop onto empty task areas
  document.querySelectorAll('.todo-tasks').forEach(area => {
    area.addEventListener('dragover', e => {
      e.preventDefault();
      area.classList.add('drag-over-empty');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over-empty'));
    area.addEventListener('drop', e => {
      e.preventDefault();
      area.classList.remove('drag-over-empty');
      const anyRow = area.querySelector('.task-row[data-list-id]');
      if (!anyRow) return;
      const toListId = parseInt(anyRow.dataset.listId);
      if (!isNaN(toListId)) moveTask(dragTaskId, dragFromListId, toListId, null);
    });
  });

  // ── Touch drag (mobile) ──
  let touchDragRow = null;
  let touchClone   = null;
  let touchOffsetY = 0;

  document.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', e => {
      const row = handle.closest('.task-row');
      if (!row) return;
      dragTaskId     = parseInt(row.dataset.taskId);
      dragFromListId = parseInt(row.dataset.listId);
      touchDragRow   = row;
      touchOffsetY   = e.touches[0].clientY - row.getBoundingClientRect().top;

      touchClone = row.cloneNode(true);
      touchClone.style.cssText = `
        position:fixed; left:0; right:0; z-index:500;
        opacity:0.85; pointer-events:none;
        background:var(--bg-elevated);
        border:1px solid var(--border-mid);
        border-radius:var(--radius-sm);
      `;
      touchClone.style.top = (e.touches[0].clientY - touchOffsetY) + 'px';
      document.body.appendChild(touchClone);
      row.classList.add('dragging');
      e.preventDefault();
    }, { passive: false });
  });

  document.addEventListener('touchmove', e => {
    if (!touchClone) return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    touchClone.style.top = (y - touchOffsetY) + 'px';

    touchClone.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    touchClone.style.display = '';

    document.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
    const hoverRow = el?.closest('.task-row[draggable]');
    if (hoverRow) hoverRow.classList.add('drag-over');
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (!touchClone) return;
    const x = e.changedTouches[0].clientX;
    const y = e.changedTouches[0].clientY;

    touchClone.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    touchClone.style.display = '';

    const hoverRow  = el?.closest('.task-row[draggable]');
    const hoverCard = el?.closest('.todo-card');

    if (hoverRow) {
      const toTaskId = parseInt(hoverRow.dataset.taskId);
      const toListId = parseInt(hoverRow.dataset.listId);
      if (dragTaskId !== toTaskId) moveTask(dragTaskId, dragFromListId, toListId, toTaskId);
    } else if (hoverCard) {
      const anyRow = hoverCard.querySelector('.task-row[data-list-id]');
      if (anyRow) moveTask(dragTaskId, dragFromListId, parseInt(anyRow.dataset.listId), null);
    }

    touchClone.remove();
    touchClone = null;
    touchDragRow?.classList.remove('dragging');
    touchDragRow = null;
    document.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
  });
}

function moveTask(taskId, fromListId, toListId, beforeTaskId) {
  const fromList = todoLists.find(l => l.id === fromListId);
  const toList   = todoLists.find(l => l.id === toListId);
  if (!fromList || !toList) return;

  const taskIdx = fromList.tasks.findIndex(t => t.id === taskId);
  if (taskIdx === -1) return;
  const [task] = fromList.tasks.splice(taskIdx, 1);

  if (beforeTaskId != null) {
    const beforeIdx = toList.tasks.findIndex(t => t.id === beforeTaskId);
    toList.tasks.splice(beforeIdx, 0, task);
  } else {
    toList.tasks.push(task);
  }

  renderTodos();
  saveToLocal();
}


/* ═══════════════════════════════════════════════════════════════
   8. FORMAT MODE
   ═══════════════════════════════════════════════════════════════ */

function toggleFormatMode() {
  formatMode ? commitFormatMode() : enterFormatMode();
}

function enterFormatMode() {
  // Pause all running timers
  timers.forEach(t => {
    if (t.running) { t.seconds = getRemaining(t); t.running = false; updateTimerUI(t.id); }
  });
  formatMode = true;
  document.body.classList.add('format-mode');
  const btn = document.getElementById('fmtBtn');
  if (btn) { btn.textContent = '✓ Done'; btn.classList.add('active'); }
}

function commitFormatMode() {
  formatMode = false;
  document.body.classList.remove('format-mode');
  const btn = document.getElementById('fmtBtn');
  if (btn) { btn.textContent = 'Formats'; btn.classList.remove('active'); }

  // Snapshot current timer state as new defaults
  TIMER_DEFAULTS = timers.map(t => ({
    label: t.label,
    seconds: Math.round(getRemaining(t)),
    color: t.color,
  }));

  saveToLocal();
  showToast('Format saved ✓');
}

function addFormatTimer() {
  if (!formatMode) return;
  const id  = formatTimerIdCounter++;
  const newT = { id, label: 'New Timer', seconds: 3600, color: '#5DCAA5', running: false, startedAt: null, secondsAtStart: null };
  timers.push(newT);
  TIMER_DEFAULTS.push({ label: newT.label, seconds: newT.seconds, color: newT.color });
  renderTimers();
}

function removeFormatTimer(id) {
  if (!formatMode) return;
  if (timers.length <= 1) { showToast('Need at least one timer.'); return; }
  const idx = timers.findIndex(t => t.id === id);
  if (idx === -1) return;
  timers.splice(idx, 1);
  TIMER_DEFAULTS.splice(idx, 1);
  renderTimers();
}

function addFormatDaily() {
  if (!formatMode) return;
  const id = todoIdCounter++;
  todoLists.push({ id, title: 'New List', color: '#5DCAA5', isDefault: true, tasks: [] });
  renderTodos();
  setTimeout(() => {
    const inp = document.getElementById(`todo-title-${id}-d`) ||
                document.getElementById(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

function removeFormatDaily(id) {
  if (!formatMode) return;
  todoLists = todoLists.filter(l => l.id !== id);
  renderTodos();
}


/* ═══════════════════════════════════════════════════════════════
   9. SAVE / LOAD
   ═══════════════════════════════════════════════════════════════ */

const LS_KEY = 'focus-app-state';

function gatherState() {
  return {
    version: 1,
    savedAt: Date.now(),
    wokenUp,
    timerDefaults: TIMER_DEFAULTS,
    timers: timers.map(t => ({
      id: t.id, label: t.label, color: t.color,
      seconds: Math.round(getRemaining(t)),
      running: t.running,
      startedAt:      t.running ? t.startedAt      : null,
      secondsAtStart: t.running ? t.secondsAtStart  : null,
    })),
    todoIdCounter,
    taskIdCounter,
    todoLists: todoLists.map(l => ({
      id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done })),
    })),
  };
}

function applyState(state) {
  if (!state || state.version !== 1) { showToast('Invalid or unsupported file.'); return; }

  wokenUp = !!state.wokenUp;
  ['d', 'm'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });

  if (state.timerDefaults) TIMER_DEFAULTS = state.timerDefaults;
  timers = state.timers.map(t => ({
    id: t.id, label: t.label, color: t.color,
    seconds: t.seconds, running: t.running,
    startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
  }));

  todoIdCounter = state.todoIdCounter ?? todoIdCounter;
  taskIdCounter = state.taskIdCounter ?? taskIdCounter;
  todoLists = state.todoLists.map(l => ({
    id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
    tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done })),
  }));

  renderTimers();
  renderTodos();
  showToast('State restored ✓');
}

// ── localStorage ──
function saveToLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(gatherState())); } catch (e) {}
}

function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state || state.version !== 1) return false;

    wokenUp = !!state.wokenUp;
    if (state.timerDefaults) TIMER_DEFAULTS = state.timerDefaults;
    timers = state.timers.map(t => ({
      id: t.id, label: t.label, color: t.color,
      seconds: t.seconds, running: t.running,
      startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
    }));
    todoIdCounter = state.todoIdCounter ?? todoIdCounter;
    taskIdCounter = state.taskIdCounter ?? taskIdCounter;
    todoLists = state.todoLists.map(l => ({
      id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done })),
    }));
    return true;
  } catch (e) { return false; }
}

// Auto-save every 2 seconds and on page hide
setInterval(saveToLocal, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveToLocal();
});
window.addEventListener('pagehide', saveToLocal);

// ── Export ──
function openExportModal() {
  document.getElementById('exportTextarea').value = JSON.stringify(gatherState(), null, 2);
  document.getElementById('exportModal').classList.add('show');
}
function exportCopy() {
  const json = document.getElementById('exportTextarea').value;
  navigator.clipboard.writeText(json)
    .then(() => { showToast('Copied to clipboard ✓'); closeModal('exportModal'); })
    .catch(() => showToast('Copy failed — try Download instead'));
}
function exportDownload() {
  const json = document.getElementById('exportTextarea').value;
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `focus-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded ✓');
  closeModal('exportModal');
}

// ── Import ──
function openImportModal() {
  document.getElementById('importTextarea').value = '';
  document.getElementById('importModal').classList.add('show');
}
function importFromText() {
  const raw = document.getElementById('importTextarea').value.trim();
  if (!raw) { showToast('Nothing to import.'); return; }
  try {
    applyState(JSON.parse(raw));
    closeModal('importModal');
  } catch { showToast('Invalid data — check your text and try again.'); }
}
function loadStateFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try { applyState(JSON.parse(e.target.result)); closeModal('importModal'); }
    catch { showToast('Could not parse file.'); }
  };
  reader.readAsText(file);
  input.value = '';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}


/* ═══════════════════════════════════════════════════════════════
   10. RESET ALL
   ═══════════════════════════════════════════════════════════════ */

function confirmResetAll() {
  document.getElementById('confirmOverlay').classList.add('show');
}
function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('show');
}
function resetAll() {
  closeConfirm();

  timers.forEach((t, i) => {
    t.running = false;
    t.seconds = TIMER_DEFAULTS[i].seconds;
    t.startedAt = null;
    t.secondsAtStart = null;
  });

  wokenUp = false;
  ['d', 'm'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.remove('done');
    if (box) box.classList.remove('checked');
  });

  todoLists.filter(l => l.isDefault).forEach(l => {
    l.tasks.forEach(t => t.done = false);
  });
  // Custom lists are left untouched

  renderTimers();
  renderTodos();
  saveToLocal();
  showToast('Reset ✓');
}


/* ═══════════════════════════════════════════════════════════════
   11. INIT
   ═══════════════════════════════════════════════════════════════ */

(function init() {
  const restored = loadFromLocal();

  renderTimers();
  renderTodos();

  if (restored) {
    ['d', 'm'].forEach(p => {
      const row = document.getElementById(`wakeupRow-${p}`);
      const box = document.getElementById(`wakeupBox-${p}`);
      if (row) row.classList.toggle('done', wokenUp);
      if (box) box.classList.toggle('checked', wokenUp);
    });
  }

  initSwipe();
  setSwipePanelWidths();
  tickAll();

  // Close modals on backdrop click
  ['exportModal', 'importModal'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      if (e.target.id === id) closeModal(id);
    });
  });
})();
