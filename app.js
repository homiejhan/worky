/* ─────────── STATE ─────────── */
// Mutable defaults — updated when Format mode is committed
let TIMER_DEFAULTS = [
  { label: 'Productivity Timer',   seconds: 6*3600, color: '#378ADD' },
  { label: 'Personal Development', seconds: 4*3600, color: '#EC3636' },
  { label: 'Time with God',        seconds: 2*3600, color: '#8B5CF6' },
  { label: 'Skill Development',    seconds: 1*3600, color: '#F97316' },
];

let formatMode = false;
let formatTimerIdCounter = 900; // high range to avoid clashing with regular timer ids

let wokenUp = false;

let timers = TIMER_DEFAULTS.map((t, i) => ({
  id: i, label: t.label, seconds: t.seconds, color: t.color,
  running: false, startedAt: null, secondsAtStart: null
}));

let todoIdCounter = 0;
let taskIdCounter = 0;

function makeTasks(texts) {
  return texts.map(text => ({ id: taskIdCounter++, text, done: false }));
}

let todoLists = [
  { id: todoIdCounter++, title: 'Physical Activities', color: '#22C55E', isDefault: true,
    tasks: makeTasks(['Morning Workout/Stretch', 'Gym/Recovery', 'Cardio']) },
  { id: todoIdCounter++, title: 'Social Interactions',  color: '#EAB308', isDefault: true,
    tasks: makeTasks(['1','2','3','4','5']) },
];

/* ─────────── MOBILE SWIPE ─────────── */
let currentTab = 0;
let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
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
    track.style.transition = animate === false ? 'none' : 'transform 0.32s cubic-bezier(0.4,0,0.2,1)';
    track.style.transform = `translateX(${-idx * w}px)`;
  }
  [0,1,2].forEach(i => {
    const btn = document.getElementById(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === idx);
  });
}

const swipeEl = document.getElementById('swipeContainer');
if (swipeEl) {
  swipeEl.addEventListener('touchstart', e => {
    const target = e.target;
    // Don't intercept touches on interactive elements
    if (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.tagName === 'SELECT' || target.closest('button') || target.closest('input')) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
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
      goTab(dx < 0 ? Math.min(currentTab + 1, 3) : Math.max(currentTab - 1, 0), true);
    }
    touchStartX = 0; isSwiping = false;
  }, { passive: true });
}

window.addEventListener('resize', setSwipePanelWidths);

/* ─────────── TIMER UTILS ─────────── */
function fmt(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}
function parseTime(str) {
  const p = str.split(':').map(Number);
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*3600 + p[1]*60;
  return NaN;
}
function getRemaining(t) {
  if (t.running) return Math.max(0, t.secondsAtStart - (Date.now() - t.startedAt) / 1000);
  return t.seconds;
}
function playIcon()  { return `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1.2L9 6L1 10.8V1.2Z" fill="currentColor"/></svg>`; }
function pauseIcon() { return `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="1" width="3" height="10" rx="1" fill="currentColor"/><rect x="6" y="1" width="3" height="10" rx="1" fill="currentColor"/></svg>`; }
function resetIcon() { return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5A4 4 0 1 0 2.9 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M1.5 2V5.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }

function tickAll() {
  timers.forEach(t => {
    if (!t.running) return;
    const rem = getRemaining(t);
    document.querySelectorAll(`.tdisp-${t.id}`).forEach(el => el.textContent = fmt(rem));
    if (rem <= 0) { t.seconds = 0; t.running = false; updateTimerUI(t.id); }
  });
  if (wokenUp) updateTimerSummary();
  requestAnimationFrame(tickAll);
}

/* ─────────── RENDER TIMERS ─────────── */
function timerCardHTML(t, pfx) {
  return `
    <div class="timer-header">
      <div class="color-swatch" style="background:${t.color}">
        <input type="color" value="${t.color}"
          oninput="changeTimerColor(${t.id},this.value); saveToLocal();">
      </div>
      <input class="timer-title-input" value="${t.label}" placeholder="Timer name"
        oninput="timers[${t.id}].label=this.value; if(formatMode){const idx=timers.findIndex(x=>x.id===${t.id});if(TIMER_DEFAULTS[idx])TIMER_DEFAULTS[idx].label=this.value;} saveToLocal();">
    </div>
    <div class="timer-body">
      <div class="timer-accent-bar tbar-${t.id}" style="background:${t.color}"></div>
      <div class="timer-display tdisp-${t.id}" onclick="startEditTimer(${t.id},'${pfx}')">${fmt(t.seconds)}</div>
      <input class="timer-time-edit tedit-${t.id}-${pfx}" type="text" placeholder="h:mm:ss"
        onblur="commitEditTimer(${t.id},'${pfx}')"
        onkeydown="if(event.key==='Enter')commitEditTimer(${t.id},'${pfx}')">
      <button class="play-btn playbtn-${t.id} ${t.running?'running':''}" onclick="toggleTimer(${t.id})">
        ${t.running ? pauseIcon() : playIcon()}
      </button>
      <button class="reset-btn" onclick="resetTimer(${t.id})" title="Reset">${resetIcon()}</button>
      <button class="fmt-remove-timer" onclick="removeFormatTimer(${t.id})" title="Remove timer">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="timer-sub tsub-${t.id}">${t.running?'running':'paused'} · click time to edit</div>
  `;
}

function renderTimers() {
  [['leftPanel','d'],['mobileTimerPanel','m']].forEach(([panelId, pfx]) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.querySelectorAll('.timer-card').forEach(e => e.remove());
    const summary = document.getElementById(`timerSummary-${pfx}`);
    timers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'timer-card';
      card.innerHTML = timerCardHTML(t, pfx);
      // Insert before the summary div so it always sits at the bottom
      if (summary) panel.insertBefore(card, summary);
      else panel.appendChild(card);
    });
  });
}

function changeTimerColor(id, color) {
  const t = timers.find(x => x.id === id);
  if (t) t.color = color;
  document.querySelectorAll(`.tbar-${id}`).forEach(el => el.style.background = color);
}
function toggleTimer(id) {
  const t = timers.find(x => x.id === id);
  if (t.running) {
    t.seconds = getRemaining(t); t.running = false;
  } else {
    if (t.seconds <= 0) return;
    t.startedAt = Date.now(); t.secondsAtStart = t.seconds; t.running = true;
  }
  updateTimerUI(id);
  saveToLocal();
}
function updateTimerUI(id) {
  const t = timers[id];
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
  if (t.running) return;
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => el.style.display = 'none');
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) { edit.style.display = 'block'; edit.value = fmt(t.seconds); edit.focus(); edit.select(); }
}
function commitEditTimer(id, pfx) {
  const t = timers.find(x => x.id === id);
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) {
    const parsed = parseTime(edit.value);
    if (!isNaN(parsed) && parsed >= 0) {
      t.seconds = parsed;
      if (t.running) { t.startedAt = Date.now(); t.secondsAtStart = parsed; }
    }
    edit.style.display = 'none';
  }
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => { el.style.display = 'block'; el.textContent = fmt(t.seconds); });
  saveToLocal();
}
function resetTimer(id) {
  const t = timers.find(x => x.id === id);
  const tIdx = timers.findIndex(x => x.id === id);
  t.running = false; t.seconds = (TIMER_DEFAULTS[tIdx] ?? TIMER_DEFAULTS[0]).seconds; t.startedAt = null; t.secondsAtStart = null;
  document.querySelectorAll(`.tedit-${id}-d, .tedit-${id}-m`).forEach(el => el.style.display = 'none');
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => { el.style.display = 'block'; el.textContent = fmt(t.seconds); });
  updateTimerUI(id);
  saveToLocal();
}

/* ─────────── WAKEUP ─────────── */
function toggleWakeup() {
  wokenUp = !wokenUp;
  ['d','m'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
  updateTimerSummary();
  saveToLocal();
}

function updateTimerSummary() {
  const totalSecs = timers.reduce((sum, t) => sum + Math.round(getRemaining(t)), 0);
  const finishTime = new Date(Date.now() + totalSecs * 1000);
  const hh = finishTime.getHours();
  const mm = String(finishTime.getMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 || 12;
  const finishStr = `${h12}:${mm} ${ampm}`;

  const html = wokenUp ? `
    <div class="timer-summary-row">
      <span class="timer-summary-label">Time remaining</span>
      <span class="timer-summary-value">${fmt(totalSecs)}</span>
    </div>
    <div class="timer-summary-row">
      <span class="timer-summary-label">Est. finish</span>
      <span class="timer-summary-value">${finishStr}</span>
    </div>
  ` : '';

  ['d','m'].forEach(p => {
    const el = document.getElementById(`timerSummary-${p}`);
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle('visible', wokenUp);
  });
}

/* ─────────── TODO LISTS ─────────── */
function addTodoList() {
  const id = todoIdCounter++;
  todoLists.push({ id, title: '', color: '#5DCAA5', tasks: [], isDefault: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => { const inp = document.getElementById(`todo-title-${id}-d`) || document.getElementById(`todo-title-${id}-m`); if (inp) inp.focus(); }, 10);
}
function removeTodoList(id) {
  todoLists = todoLists.filter(l => l.id !== id); renderTodos(); saveToLocal();
}
function changeTodoColor(id, color) {
  const list = todoLists.find(l => l.id === id); if (!list) return;
  list.color = color;
  document.querySelectorAll(`.todo-swatch-${id}`).forEach(s => s.style.background = color);
  document.querySelectorAll(`.todo-strip-${id}`).forEach(s => s.style.background = color);
  document.querySelectorAll(`.task-checks-${id}.done`).forEach(c => { c.style.background = color; c.style.borderColor = color; });
}
function addTask(listId) {
  const list = todoLists.find(l => l.id === listId); if (!list) return;
  if (list.isDefault && !formatMode) return;
  const tid = taskIdCounter++;
  list.tasks.push({ id: tid, text: '', done: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => { const inp = document.querySelector(`input.task-text-${tid}`); if (inp) inp.focus(); }, 10);
}
function removeTask(listId, taskId) {
  const list = todoLists.find(l => l.id === listId); if (!list) return;
  if (list.isDefault && !formatMode) return;
  list.tasks = list.tasks.filter(t => t.id !== taskId); renderTodos(); saveToLocal();
}
function toggleTask(listId, taskId) {
  const list = todoLists.find(l => l.id === listId); if (!list) return;
  const task = list.tasks.find(t => t.id === taskId); if (!task) return;
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
  card.innerHTML = `
    <div class="todo-accent-strip todo-strip-${list.id}" style="background:${list.color}"></div>
    <div class="todo-card-header">
      <div class="color-swatch todo-swatch-${list.id}" style="background:${list.color}">
        <input type="color" value="${list.color}"
          oninput="changeTodoColor(${list.id},this.value); saveToLocal();">
      </div>
      <input class="todo-title-input" id="todo-title-${list.id}-${pfx}" value="${list.title}" placeholder="List title"
        oninput="todoLists.find(l=>l.id===${list.id}).title=this.value; saveToLocal();">
      ${list.isDefault ? `<button class="fmt-remove-daily" onclick="removeFormatDaily(${list.id})">×</button>` : `<button class="todo-delete-btn" onclick="removeTodoList(${list.id})">×</button>`}
    </div>
    <div class="todo-tasks">
      ${list.tasks.map(task => `
        <div class="task-row" data-task-id="${task.id}" data-list-id="${list.id}" ${!list.isDefault ? 'draggable="true"' : ''}>
          ${!list.isDefault ? `<div class="drag-handle" title="Drag to reorder"><svg width="10" height="14" viewBox="0 0 10 14" fill="none"><circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="3" cy="11" r="1.2" fill="currentColor"/><circle cx="7" cy="11" r="1.2" fill="currentColor"/></svg></div>` : ''}
          <div class="task-check task-checks-${task.id} ${task.done?'done':''}"
            style="${task.done?`background:${list.color};border-color:${list.color}`:''}"
            onclick="toggleTask(${list.id},${task.id})">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <input class="task-text task-text-${task.id} ${task.done?'done':''}"
            value="${task.text}" placeholder="Task…"
            oninput="todoLists.find(l=>l.id===${list.id}).tasks.find(t=>t.id===${task.id}).text=this.value; saveToLocal();"
            onkeydown="if(event.key==='Enter'){event.preventDefault();addTask(${list.id});}">
          <button class="task-del" onclick="removeTask(${list.id},${task.id})">×</button>
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
  [['d'],['m']].forEach(([pfx]) => {
    const defEl  = document.getElementById(`defaultContainer-${pfx}`);
    const custEl = document.getElementById(`todoContainer-${pfx}`);
    const emptyEl= document.getElementById(`emptyState-${pfx}`);
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

/* ─────────── DRAG & DROP (My Lists only) ─────────── */
let dragTaskId = null;
let dragFromListId = null;

function initDragDrop() {
  // Desktop: HTML5 drag events
  document.querySelectorAll('.task-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragTaskId = parseInt(row.dataset.taskId);
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
      const toTaskId = parseInt(row.dataset.taskId);
      const toListId = parseInt(row.dataset.listId);
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
      const card = area.closest('.todo-card');
      if (!card) return;
      const toListId = parseInt(area.querySelector('.task-row')?.dataset.listId ?? card.querySelector('[data-list-id]')?.dataset.listId);
      if (isNaN(toListId)) return;
      moveTask(dragTaskId, dragFromListId, toListId, null);
    });
  });

  // Touch drag (mobile)
  let touchDragRow = null, touchClone = null, touchOffsetY = 0;

  document.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', e => {
      const row = handle.closest('.task-row');
      if (!row) return;
      dragTaskId = parseInt(row.dataset.taskId);
      dragFromListId = parseInt(row.dataset.listId);
      touchDragRow = row;
      touchOffsetY = e.touches[0].clientY - row.getBoundingClientRect().top;

      touchClone = row.cloneNode(true);
      touchClone.style.cssText = `position:fixed;left:0;right:0;z-index:500;opacity:0.85;pointer-events:none;background:var(--bg-elevated);border:1px solid var(--border-mid);border-radius:var(--radius-sm);`;
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

    // Find what we're hovering over
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

    const hoverRow = el?.closest('.task-row[draggable]');
    const hoverArea = el?.closest('.todo-tasks');
    const hoverCard = el?.closest('.todo-card');

    if (hoverRow) {
      const toTaskId = parseInt(hoverRow.dataset.taskId);
      const toListId = parseInt(hoverRow.dataset.listId);
      if (dragTaskId !== toTaskId) moveTask(dragTaskId, dragFromListId, toListId, toTaskId);
    } else if (hoverCard) {
      const anyRow = hoverCard.querySelector('.task-row[data-list-id]');
      if (anyRow) {
        const toListId = parseInt(anyRow.dataset.listId);
        moveTask(dragTaskId, dragFromListId, toListId, null);
      }
    }

    touchClone.remove(); touchClone = null;
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

/* ─────────── FORMAT MODE ─────────── */
function toggleFormatMode() {
  if (formatMode) {
    commitFormatMode();
  } else {
    enterFormatMode();
  }
}

// Stores the real remaining time before entering format mode
let preFormatTimerState = [];

function enterFormatMode() {
  // Snapshot real remaining times before we overwrite t.seconds
  preFormatTimerState = timers.map(t => ({
    id: t.id,
    seconds: Math.round(getRemaining(t)),
    running: t.running,
    startedAt: t.startedAt,
    secondsAtStart: t.secondsAtStart,
  }));

  // Pause all running timers
  timers.forEach(t => {
    if (t.running) {
      t.seconds = getRemaining(t);
      t.running = false;
      updateTimerUI(t.id);
    }
  });

  // Show each timer's DEFAULT time in the display
  timers.forEach((t, i) => {
    const def = TIMER_DEFAULTS[i];
    if (def) {
      // Only update display — don't overwrite t.seconds yet
      document.querySelectorAll(`.tdisp-${t.id}`).forEach(el => {
        el.style.display = 'block';
        el.textContent = fmt(def.seconds);
      });
      document.querySelectorAll(`.tedit-${t.id}-d, .tedit-${t.id}-m`).forEach(el => el.style.display = 'none');
    }
  });

  // Now set t.seconds to the default so edits in format mode work correctly
  timers.forEach((t, i) => {
    const def = TIMER_DEFAULTS[i];
    if (def) t.seconds = def.seconds;
  });

  formatMode = true;
  document.body.classList.add('format-mode');
  const btn = document.getElementById('fmtBtn');
  if (btn) { btn.textContent = '✓ Done'; btn.classList.add('active'); }
}

function commitFormatMode() {
  // Save the new defaults from whatever the timers show in format mode
  TIMER_DEFAULTS = timers.map(t => ({
    label: t.label,
    seconds: t.seconds,  // t.seconds is the format-mode value (default or edited)
    color: t.color,
  }));

  formatMode = false;
  document.body.classList.remove('format-mode');
  const btn = document.getElementById('fmtBtn');
  if (btn) { btn.textContent = 'Formats'; btn.classList.remove('active'); }

  // Restore live remaining times so user's progress is not lost
  timers.forEach(t => {
    const pre = preFormatTimerState.find(p => p.id === t.id);
    if (pre) {
      t.seconds = pre.seconds;
      t.running = pre.running;
      t.startedAt = pre.startedAt;
      t.secondsAtStart = pre.secondsAtStart;
    }
  });
  preFormatTimerState = [];

  // Re-render so displays show live remaining time again
  renderTimers();

  saveToLocal();
  showToast('Format saved ✓');
}

function addFormatTimer() {
  if (!formatMode) return;
  const id = formatTimerIdCounter++;
  const newT = { id, label: 'New Timer', seconds: 3600, color: '#5DCAA5', running: false, startedAt: null, secondsAtStart: null };
  timers.push(newT);
  // Also push a default entry to keep arrays in sync
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
    const inp = document.getElementById(`todo-title-${id}-d`) || document.getElementById(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

function removeFormatDaily(id) {
  if (!formatMode) return;
  todoLists = todoLists.filter(l => l.id !== id);
  renderTodos();
}

/* ─────────── SAVE / LOAD ─────────── */
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
      startedAt: t.running ? t.startedAt : null,
      secondsAtStart: t.running ? t.secondsAtStart : null,
    })),
    todoIdCounter,
    taskIdCounter,
    todoLists: todoLists.map(l => ({
      id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
    })),
    calendar: {
      calEvents,
      calTemplates,
      calEventIdCtr,
    },
  };
}

function applyState(state) {
  if (!state || state.version !== 1) { showToast('Invalid or unsupported file.'); return; }
  wokenUp = !!state.wokenUp;
  ['d','m'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
  timers = state.timers.map(t => ({
    id: t.id, label: t.label, color: t.color,
    seconds: t.seconds, running: t.running,
    startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
  }));
  if (state.timerDefaults) TIMER_DEFAULTS = state.timerDefaults;
  todoIdCounter = state.todoIdCounter ?? todoIdCounter;
  taskIdCounter = state.taskIdCounter ?? taskIdCounter;
  todoLists = state.todoLists.map(l => ({
    id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
    tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
  }));
  if (state.calendar) {
    calEvents      = state.calendar.calEvents      || {};
    calTemplates   = state.calendar.calTemplates   || [];
    calEventIdCtr  = state.calendar.calEventIdCtr  || 1;
    calSave();
    calPruneDays();
    calRefresh();
  }
  renderTimers();
  renderTodos();
  showToast('State restored ✓');
}

function openExportModal() {
  const json = JSON.stringify(gatherState(), null, 2);
  document.getElementById('exportTextarea').value = json;
  document.getElementById('exportModal').classList.add('show');
}
function openImportModal() {
  document.getElementById('importTextarea').value = '';
  document.getElementById('importModal').classList.add('show');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('show');
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `focus-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
  showToast('Downloaded ✓');
  closeModal('exportModal');
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
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      applyState(JSON.parse(e.target.result));
      closeModal('importModal');
    } catch { showToast('Could not parse file.'); }
  };
  reader.readAsText(file);
  input.value = '';
}
// Close modals on backdrop click
['exportModal','importModal'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) closeModal(id);
  });
});

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

/* ─────────── RESET ALL ─────────── */
function confirmResetAll() {
  document.getElementById('confirmOverlay').classList.add('show');
}
function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('show');
}
function resetAll() {
  closeConfirm();
  // Reset timers
  timers.forEach((t, i) => {
    t.running = false;
    t.seconds = TIMER_DEFAULTS[i].seconds;
    t.startedAt = null; t.secondsAtStart = null;
  });
  // Uncheck wakeup
  wokenUp = false;
  ['d','m'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.remove('done');
    if (box) box.classList.remove('checked');
  });
  // Uncheck all daily tasks
  todoLists.filter(l => l.isDefault).forEach(l => {
    l.tasks.forEach(t => t.done = false);
  });
  // Custom lists are left untouched
  renderTimers();
  renderTodos();
  saveToLocal();
  showToast('Reset ✓');
}

/* ─────────── LOCAL STORAGE AUTO-SAVE ─────────── */
const LS_KEY = 'focus-app-state';

function saveToLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(gatherState())); } catch(e) {}
}

function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state || state.version !== 1) return false;
    wokenUp = !!state.wokenUp;
    timers = state.timers.map(t => ({
      id: t.id, label: t.label, color: t.color,
      seconds: t.seconds, running: t.running,
      startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
    }));
    todoIdCounter = state.todoIdCounter ?? todoIdCounter;
    taskIdCounter = state.taskIdCounter ?? taskIdCounter;
    todoLists = state.todoLists.map(l => ({
      id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
    }));
    if (state.calendar) {
      calEvents     = state.calendar.calEvents     || {};
      calTemplates  = state.calendar.calTemplates  || [];
      calEventIdCtr = state.calendar.calEventIdCtr || 1;
    }
    return true;
  } catch(e) { return false; }
}

// Auto-save every 5 seconds and immediately on tab hide / page close
setInterval(saveToLocal, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveToLocal();
});
window.addEventListener('pagehide', saveToLocal);

/* ─────────── INIT ─────────── */
const restored = loadFromLocal();
renderTimers();
renderTodos();
if (restored) {
  ['d','m'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
}
setSwipePanelWidths();
updateTimerSummary();
tickAll();

/* ══════════════════════════════════════════════════════
   CALENDAR
   ══════════════════════════════════════════════════════ */

const CAL_HOUR_PX   = 64;
const CAL_DAY_COUNT = 7;
const CAL_COLORS    = ['#378ADD','#EC3636','#8B5CF6','#F97316','#22C55E','#EAB308','#5DCAA5','#D4537E'];
const CAL_LS_KEY    = 'focus-cal-state';

let calEvents       = {};   // { 'YYYY-MM-DD': [event,...] }
let calTemplates    = [];   // template events/dividers
let calEventIdCtr   = 1;
let calMobileDay    = 0;
let calDesktopOpen  = false;
let calEditId       = null;
let calEditDate     = null;
let calEditType     = 'event';
let calSelectedColor= CAL_COLORS[0];

/* ── Date helpers ── */
function calToday() { const d=new Date(); d.setHours(0,0,0,0); return d; }
function calDateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function calWeekDays() {
  const t=calToday();
  return Array.from({length:CAL_DAY_COUNT},(_,i)=>{ const d=new Date(t); d.setDate(t.getDate()+i); return d; });
}
function calFmtFull(d) { return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function calFmtShort(d) { return d.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase(); }
function calTimeToMins(s) { const [h,m]=s.split(':').map(Number); return h*60+m; }
function calMinsToStr(n) { return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
function calFmtTime(s) {
  const [h,m]=s.split(':').map(Number);
  const ap=h>=12?'pm':'am'; const h12=h%12||12;
  return m===0?`${h12}${ap}`:`${h12}:${String(m).padStart(2,'0')}${ap}`;
}
function calMinsToPx(n) { return (n/60)*CAL_HOUR_PX; }
function calPxToMins(px) { return Math.round((px/CAL_HOUR_PX)*60/15)*15; }
const CAL_TOTAL_PX = 24 * CAL_HOUR_PX;

/* ── Ensure day seeded from templates ── */
function calEnsureDay(key) {
  if (!calEvents[key]) {
    calEvents[key] = calTemplates.map(t => ({...t, id:calEventIdCtr++, fromTemplate:true, templateId:t.id}));
  }
}
function calPruneDays() {
  const keys = new Set(calWeekDays().map(calDateKey));
  Object.keys(calEvents).forEach(k => { if (!keys.has(k)) delete calEvents[k]; });
}

/* ── Time column ── */
function calBuildTimeCol(el) {
  el.style.height = CAL_TOTAL_PX + 'px';
  el.innerHTML = '';
  for (let h=1; h<24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'cal-time-label';
    lbl.style.top = (h*CAL_HOUR_PX)+'px';
    const ap=h>=12?'pm':'am'; lbl.textContent=`${h%12||12}${ap}`;
    el.appendChild(lbl);
  }
}

/* ── Grid lines ── */
function calBuildLines(col) {
  col.style.height = CAL_TOTAL_PX + 'px';
  for (let h=0; h<24; h++) {
    const line = document.createElement('div');
    line.className = 'cal-hour-line';
    line.style.top = (h*CAL_HOUR_PX)+'px';
    col.appendChild(line);
    const half = document.createElement('div');
    half.className = 'cal-half-line';
    half.style.top = (h*CAL_HOUR_PX + CAL_HOUR_PX/2)+'px';
    col.appendChild(half);
    [1,3].forEach(q => {
      const ql = document.createElement('div');
      ql.className = 'cal-quarter-line';
      ql.style.top = (h*CAL_HOUR_PX + q*(CAL_HOUR_PX/4))+'px';
      col.appendChild(ql);
    });
  }
}

/* ── Now line ── */
function calBuildNowLine(col) {
  const existing = col.querySelector('.cal-now-line');
  if (existing) existing.remove();
  const now = new Date();
  const mins = now.getHours()*60 + now.getMinutes();
  const wrap = document.createElement('div');
  wrap.className = 'cal-now-line';
  wrap.style.top = calMinsToPx(mins)+'px';
  const dot = document.createElement('div'); dot.className='cal-now-dot';
  wrap.appendChild(dot);
  col.appendChild(wrap);
}

/* ── Render event block ── */
function calMakeEventEl(ev, dateKey) {
  const el = document.createElement('div');
  if (ev.type === 'divider') {
    el.className = 'cal-divider';
    const mins = calTimeToMins(ev.start);
    el.style.top = calMinsToPx(mins)+'px';
    el.style.transform = 'translateY(-50%)';
    const line = document.createElement('div');
    line.className = 'cal-divider-line';
    line.style.background = ev.color;
    const lbl = document.createElement('div');
    lbl.className = 'cal-divider-label';
    lbl.style.color = ev.color;
    lbl.textContent = ev.title || 'Divider';
    el.appendChild(line); el.appendChild(lbl);
  } else {
    el.className = 'cal-event';
    const startM = calTimeToMins(ev.start);
    const endM   = calTimeToMins(ev.end);
    const durM   = Math.max(15, endM - startM);
    el.style.top    = calMinsToPx(startM)+'px';
    el.style.height = calMinsToPx(durM)+'px';
    el.style.background = ev.color + '33';
    el.style.borderLeft = `3px solid ${ev.color}`;
    el.style.color = ev.color;
    el.innerHTML = `<div style="font-weight:500;overflow:hidden;text-overflow:ellipsis">${ev.title||'(no title)'}</div>
      <div class="cal-event-time">${calFmtTime(ev.start)}–${calFmtTime(ev.end)}</div>`;
  }
  el.addEventListener('click', e => { e.stopPropagation(); openCalModal(dateKey, ev.id); });
  calAddDragToEvent(el, ev, dateKey);
  return el;
}

/* ── Render a single day column ── */
function calRenderDayCol(col, dateKey) {
  // Remove old events/dividers but keep lines
  col.querySelectorAll('.cal-event,.cal-divider,.cal-now-line').forEach(e=>e.remove());
  calEnsureDay(dateKey);
  (calEvents[dateKey]||[]).forEach(ev => col.appendChild(calMakeEventEl(ev, dateKey)));
  // Now line on today
  if (dateKey === calDateKey(calToday())) calBuildNowLine(col);
  // Click to add
  col.onclick = (e) => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    const mins = calPxToMins(e.clientY - rect.top);
    openCalModal(dateKey, null, calMinsToStr(mins));
  };
}

/* ── Desktop render ── */
function calRenderDesktop() {
  const days = calWeekDays();
  calPruneDays();

  const titleEl = document.getElementById('calDesktopTitle');
  if (titleEl) titleEl.textContent = calFmtFull(calToday());

  // Header days
  const daysEl = document.getElementById('calDesktopDays');
  const gridEl = document.getElementById('calDesktopGrid');
  const timeEl = document.getElementById('calTimeCol');
  if (!daysEl||!gridEl||!timeEl) return;

  daysEl.style.gridTemplateColumns = `repeat(${CAL_DAY_COUNT},1fr)`;
  daysEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(${CAL_DAY_COUNT},1fr)`;
  gridEl.innerHTML = '';

  calBuildTimeCol(timeEl);
  timeEl.style.height = CAL_TOTAL_PX + 'px';

  days.forEach((day, i) => {
    const key = calDateKey(day);
    const isToday = key === calDateKey(calToday());

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header' + (isToday?' today':'');
    hdr.innerHTML = `<div>${calFmtShort(day)}</div><div class="cal-day-header-date">${day.getDate()}</div>`;
    daysEl.appendChild(hdr);

    // Column
    const col = document.createElement('div');
    col.className = 'cal-day-col';
    col.dataset.dateKey = key;
    calBuildLines(col);
    calRenderDayCol(col, key);

    // Drag-over highlight
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault(); col.classList.remove('drag-over');
      calHandleDrop(key, e.clientY, col.getBoundingClientRect().top);
    });

    gridEl.appendChild(col);
  });

  // Set explicit heights so the scroll container knows total size
  gridEl.style.height = CAL_TOTAL_PX + 'px';

  // Scroll to 7am
  const scrollArea = document.getElementById('calScrollArea');
  setTimeout(() => { if (scrollArea) scrollArea.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── Mobile render ── */
function calRenderMobile() {
  const days = calWeekDays();
  calPruneDays();
  const day = days[calMobileDay];
  const key = calDateKey(day);

  const titleEl = document.getElementById('calDayTitle');
  if (titleEl) titleEl.textContent = calFmtFull(day);

  const gridEl = document.getElementById('calMobileGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const body = document.createElement('div');
  body.className = 'cal-mobile-body';
  body.style.width = '100%';

  const timeCol = document.createElement('div');
  timeCol.className = 'cal-mobile-time-col';
  calBuildTimeCol(timeCol);

  const dayCol = document.createElement('div');
  dayCol.className = 'cal-mobile-day-col';
  calBuildLines(dayCol);
  calRenderDayCol(dayCol, key);

  dayCol.addEventListener('dragover', e => { e.preventDefault(); });
  dayCol.addEventListener('drop', e => {
    e.preventDefault();
    calHandleDrop(key, e.clientY, dayCol.getBoundingClientRect().top);
  });

  body.appendChild(timeCol);
  body.appendChild(dayCol);
  gridEl.appendChild(body);

  setTimeout(() => { gridEl.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── Navigation ── */
function calNavDay(dir) {
  const days = calWeekDays();
  calMobileDay = Math.max(0, Math.min(CAL_DAY_COUNT-1, calMobileDay + dir));
  calRenderMobile();
}

/* ── Toggle desktop calendar ── */
function calToggleDesktop() {
  calDesktopOpen = !calDesktopOpen;
  const panel = document.getElementById('calDesktopPanel');
  const btn   = document.getElementById('calDesktopNavTab');
  const rp    = document.getElementById('rightPanel');
  if (panel) panel.classList.toggle('active', calDesktopOpen);
  if (btn)   btn.classList.toggle('active', calDesktopOpen);
  if (rp)    rp.style.display = calDesktopOpen ? 'none' : '';
  if (calDesktopOpen) calRenderDesktop();
}

/* ── Modal ── */
function openCalModal(dateKey, evId, defaultStart) {
  calEditDate = dateKey;
  calEditId   = (evId !== undefined && evId !== null) ? evId : null;

  // Build color swatches
  const swatchEl = document.getElementById('calColorSwatches');
  swatchEl.innerHTML = '';
  CAL_COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'cal-color-dot' + (c===calSelectedColor?' selected':'');
    dot.style.background = c;
    dot.onclick = () => { calSelectedColor=c; document.querySelectorAll('.cal-color-dot').forEach(d=>d.classList.remove('selected')); dot.classList.add('selected'); };
    swatchEl.appendChild(dot);
  });

  const deleteBtn = document.getElementById('calEventDeleteBtn');
  const titleEl   = document.getElementById('calEventModalTitle');

  if (evId) {
    // Edit existing
    const ev = (calEvents[dateKey]||[]).find(e=>e.id===evId)
            || calTemplates.find(e=>e.id===evId);
    if (!ev) return;
    document.getElementById('calEventTitle').value = ev.title || '';
    document.getElementById('calEventStart').value = ev.start || '09:00';
    document.getElementById('calEventEnd').value   = ev.end   || '10:00';
    calSelectedColor = ev.color || CAL_COLORS[0];
    setCalEventType(ev.type || 'event');
    // fromTemplate events should always save back through the template path
    document.getElementById('calEventTemplate').checked = !!(ev.isTemplate || ev.fromTemplate);
    titleEl.textContent = 'Edit event';
    deleteBtn.style.display = 'block';
    document.querySelectorAll('.cal-color-dot').forEach(d => d.classList.toggle('selected', d.style.background === calSelectedColor || d.style.backgroundColor === calSelectedColor));
  } else {
    // New
    document.getElementById('calEventTitle').value = '';
    document.getElementById('calEventStart').value = defaultStart || '09:00';
    document.getElementById('calEventEnd').value   = defaultStart ? calMinsToStr(Math.min(1440, calTimeToMins(defaultStart)+60)) : '10:00';
    calSelectedColor = CAL_COLORS[0];
    setCalEventType('event');
    document.getElementById('calEventTemplate').checked = formatMode;
    titleEl.textContent = 'Add event';
    deleteBtn.style.display = 'none';
  }

  document.getElementById('calTemplateRow').style.display = formatMode ? 'block' : 'none';
  document.getElementById('calEventModal').classList.add('show');
}

function closeCalModal() {
  document.getElementById('calEventModal').classList.remove('show');
  calEditId = null; calEditDate = null;
}

function setCalEventType(type) {
  calEditType = type;
  document.getElementById('calTypeEvent').classList.toggle('active', type==='event');
  document.getElementById('calTypeDivider').classList.toggle('active', type==='divider');
  const startField = document.querySelector('.cal-event-field');
  const endField   = document.querySelectorAll('.cal-event-field')[1];
  if (endField) endField.style.display = type==='divider' ? 'none' : '';
}

function saveCalEvent() {
  const title    = document.getElementById('calEventTitle').value.trim();
  const start    = document.getElementById('calEventStart').value;
  const end      = calEditType==='divider' ? start : document.getElementById('calEventEnd').value;
  const isTemplate = formatMode && document.getElementById('calEventTemplate').checked;

  // Resolve whether we're editing a template-seeded instance
  const editingDayInstance = (calEditId !== null && calEditId !== undefined)
    ? (calEvents[calEditDate]||[]).find(e => e.id === calEditId)
    : null;
  const editingTemplateId = editingDayInstance?.templateId ?? null;

  // Determine the canonical template ID for this edit
  // If editing a fromTemplate instance, use its templateId; otherwise use calEditId
  const templateMasterId = isTemplate
    ? (editingTemplateId ?? ((calEditId !== null && calEditId !== undefined) ? calEditId : null))
    : null;

  const ev = {
    id:        (calEditId !== null && calEditId !== undefined) ? calEditId : calEventIdCtr++,
    title, start, end,
    color:     calSelectedColor,
    type:      calEditType,
    isTemplate: isTemplate,
  };

  if (isTemplate) {
    // Determine which template to update
    const masterIdToUse = editingTemplateId ?? ev.id;
    const tIdx = calTemplates.findIndex(t => t.id === masterIdToUse);
    const templateEv = { ...ev, id: masterIdToUse, isTemplate: true };

    if (tIdx >= 0) {
      calTemplates[tIdx] = templateEv;
    } else {
      templateEv.id = masterIdToUse;
      calTemplates.push(templateEv);
    }

    // Update all days: replace existing instance, don't add new ones
    calWeekDays().forEach(day => {
      const key = calDateKey(day);
      calEnsureDay(key);
      const dIdx = calEvents[key].findIndex(e => e.templateId === masterIdToUse || e.id === calEditId);
      if (dIdx >= 0) {
        calEvents[key][dIdx] = {
          ...templateEv,
          id: calEvents[key][dIdx].id,
          fromTemplate: true,
          templateId: masterIdToUse,
        };
      } else {
        calEvents[key].push({
          ...templateEv,
          id: calEventIdCtr++,
          fromTemplate: true,
          templateId: masterIdToUse,
        });
      }
    });
  } else {
    const key = calEditDate;
    if (calEditId !== null && calEditId !== undefined) {
      // Editing existing — find and update in-place, never push
      if (!calEvents[key]) calEnsureDay(key);
      const idx = calEvents[key].findIndex(e => e.id === calEditId);
      if (idx >= 0) {
        // Preserve fromTemplate/templateId so it stays linked correctly
        calEvents[key][idx] = {
          ...ev,
          fromTemplate: editingDayInstance?.fromTemplate || false,
          templateId:   editingDayInstance?.templateId   || undefined,
        };
      }
      // If not found do nothing — avoids duplicates
    } else {
      // New event
      calEnsureDay(key);
      ev.id = calEventIdCtr++;
      calEvents[key].push(ev);
    }
  }

  closeCalModal();
  calRefresh();
  calSave();
}

function deleteCalEvent() {
  if (!calEditDate || !calEditId) return;
  const ev = (calEvents[calEditDate]||[]).find(e=>e.id===calEditId);

  if (ev && ev.fromTemplate && formatMode) {
    // In format mode: remove from templates entirely + all days
    calTemplates = calTemplates.filter(t => t.id !== ev.templateId);
    Object.keys(calEvents).forEach(k => {
      calEvents[k] = calEvents[k].filter(e => e.templateId !== ev.templateId);
    });
  } else if (ev && ev.fromTemplate && !formatMode) {
    // In user mode: remove only from this day (template persists for future days)
    calEvents[calEditDate] = calEvents[calEditDate].filter(e => e.id !== calEditId);
  } else {
    // Plain event
    calEvents[calEditDate] = (calEvents[calEditDate]||[]).filter(e => e.id !== calEditId);
    if (ev && ev.isTemplate) {
      calTemplates = calTemplates.filter(t => t.id !== ev.id);
    }
  }

  closeCalModal();
  calRefresh();
  calSave();
}

/* ── Drag & drop ── */
let calDragEv   = null;
let calDragDate = null;
let calDragOffY = 0;

function calAddDragToEvent(el, ev, dateKey) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', e => {
    calDragEv   = ev;
    calDragDate = dateKey;
    calDragOffY = e.offsetY;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}

function calHandleDrop(toDateKey, clientY, colTop) {
  if (!calDragEv) return;
  const mins     = calPxToMins(clientY - colTop - calDragOffY);
  const duration = calEditType === 'divider' ? 0
    : calTimeToMins(calDragEv.end) - calTimeToMins(calDragEv.start);
  const newStart = Math.max(0, Math.min(1425, mins));
  const newEnd   = Math.min(1440, newStart + Math.max(15, duration));

  // Remove from old day
  calEvents[calDragDate] = (calEvents[calDragDate]||[]).filter(e => e.id !== calDragEv.id);

  // Add to new day
  calEnsureDay(toDateKey);
  calEvents[toDateKey].push({
    ...calDragEv,
    start: calMinsToStr(newStart),
    end:   calMinsToStr(newEnd),
    fromTemplate: toDateKey !== calDragDate ? false : calDragEv.fromTemplate,
  });

  calDragEv = null;
  calRefresh();
  calSave();
}

/* ── Refresh both views ── */
function calRefresh() {
  if (calDesktopOpen) calRenderDesktop();
  const panels = document.querySelectorAll('.swipe-panel');
  if (panels.length >= 4) calRenderMobile();
}

/* ── Now-line tick ── */
function calTickNow() {
  if (calDesktopOpen) {
    document.querySelectorAll('.cal-day-col').forEach(col => {
      if (col.dataset.dateKey === calDateKey(calToday())) calBuildNowLine(col);
    });
  }
  const mobileDay = document.querySelector('.cal-mobile-day-col');
  if (mobileDay && calWeekDays()[calMobileDay] && calDateKey(calWeekDays()[calMobileDay]) === calDateKey(calToday())) {
    calBuildNowLine(mobileDay);
  }
  setTimeout(calTickNow, 60000);
}

/* ── Persist ── */
function calSave() {
  try { localStorage.setItem(CAL_LS_KEY, JSON.stringify({ calEvents, calTemplates, calEventIdCtr })); } catch(e) {}
}
function calLoad() {
  try {
    const raw = localStorage.getItem(CAL_LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.calEvents)    calEvents    = s.calEvents;
    if (s.calTemplates) calTemplates = s.calTemplates;
    if (s.calEventIdCtr) calEventIdCtr = s.calEventIdCtr;
  } catch(e) {}
}

/* ── Desktop Calendar nav tab in left panel ── */
function calInitDesktopTab() {
  const lp = document.getElementById('leftPanel');
  if (!lp) return;
  const tab = document.createElement('div');
  tab.className = 'cal-nav-tab';
  tab.id = 'calDesktopNavTab';
  tab.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
    <path d="M1 5h10" stroke="currentColor" stroke-width="1.2"/>
    <path d="M4 1v2M8 1v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg> Calendar`;
  tab.onclick = calToggleDesktop;
  // Insert after wakeup row (first child after the wakeup-row)
  const wakeup = lp.querySelector('.wakeup-row');
  if (wakeup) wakeup.after(tab);
  else lp.prepend(tab);
}

/* ── Swipe panel count update ── */
const _origSetSwipe = setSwipePanelWidths;
setSwipePanelWidths = function() {
  const w = window.innerWidth;
  const track = document.getElementById('swipeTrack');
  const panels = document.querySelectorAll('.swipe-panel');
  const count = panels.length;
  if (track) track.style.width = (w * count) + 'px';
  panels.forEach(p => p.style.width = w + 'px');
  const track2 = document.getElementById('swipeTrack');
  if (track2) {
    track2.style.transition = 'none';
    track2.style.transform = `translateX(${-currentTab * w}px)`;
  }
  [0,1,2,3].forEach(i => {
    const btn = document.getElementById(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === currentTab);
  });
};

/* ── goTab update for 4 tabs ── */
const _origGoTab = goTab;
goTab = function(idx, animate) {
  currentTab = idx;
  const w = window.innerWidth;
  const track = document.getElementById('swipeTrack');
  if (track) {
    track.style.transition = animate===false ? 'none' : 'transform 0.32s cubic-bezier(0.4,0,0.2,1)';
    track.style.transform = `translateX(${-idx * w}px)`;
  }
  [0,1,2,3].forEach(i => {
    const btn = document.getElementById(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === idx);
  });
  if (idx === 3) calRenderMobile();
};

// Close modal on backdrop click
document.getElementById('calEventModal').addEventListener('click', e => {
  if (e.target.id === 'calEventModal') closeCalModal();
});

/* ── Init ── */
calLoad();
calPruneDays();
calInitDesktopTab();
calRenderMobile();
calTickNow();
