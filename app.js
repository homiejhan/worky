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

let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(setSwipePanelWidths, 80);
});

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

const LIST_DRAG_HANDLE_HTML = '<div class="list-drag-handle" title="Drag to reorder"><svg width="10" height="14" viewBox="0 0 10 14" fill="none"><circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="3" cy="11" r="1.2" fill="currentColor"/><circle cx="7" cy="11" r="1.2" fill="currentColor"/></svg></div>';

function buildCard(list, pfx) {
  const listDraggable = !list.isDefault || formatMode;
  const card = document.createElement('div');
  card.className = 'todo-card' + (listDraggable ? ' list-reorderable' : '');
  card.dataset.listId = list.id;
  card.innerHTML = `
    <div class="todo-accent-strip todo-strip-${list.id}" style="background:${list.color}"></div>
    <div class="todo-card-header">
      ${listDraggable ? LIST_DRAG_HANDLE_HTML : ''}
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

/* ─────────── DRAG & DROP ─────────── */
let dragTaskId = null;
let dragFromListId = null;
let dragListId = null;
let _listDragAllowed = false;

function initDragDrop() {
  initListDragDrop();
  initTaskDragDrop();
}

function initListDragDrop() {
  const specs = [
    { id: 'defaultContainer-d', isDefault: true },
    { id: 'defaultContainer-m', isDefault: true },
    { id: 'todoContainer-d',    isDefault: false },
    { id: 'todoContainer-m',    isDefault: false },
  ];
  specs.forEach(({ id: containerId, isDefault }) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.todo-card.list-reorderable').forEach(card => {
      const handle = card.querySelector('.list-drag-handle');
      if (!handle) return;

      // ── Mouse drag (desktop) ──
      handle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        let clone = null, moved = false;
        const srcListId = parseInt(card.dataset.listId);
        const rect0 = card.getBoundingClientRect();
        const offX = e.clientX - rect0.left;
        const offY = e.clientY - rect0.top;

        const onMove = e => {
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!moved && Math.sqrt(dx*dx + dy*dy) < 4) return;
          if (!moved) {
            moved = true;
            clone = card.cloneNode(true);
            clone.style.cssText = 'position:fixed;z-index:9999;opacity:0.85;pointer-events:none;background:var(--bg-elevated);border:1px solid var(--border-mid);border-radius:var(--radius-md);box-shadow:0 4px 20px rgba(0,0,0,0.4);';
            clone.style.width = card.offsetWidth + 'px';
            clone.style.left  = (e.clientX - offX) + 'px';
            clone.style.top   = (e.clientY - offY) + 'px';
            document.documentElement.appendChild(clone);
            card.classList.add('list-dragging');
            dragListId = srcListId;
          }
          clone.style.left = (e.clientX - offX) + 'px';
          clone.style.top  = (e.clientY - offY) + 'px';
          document.querySelectorAll('.list-drag-over').forEach(c => c.classList.remove('list-drag-over'));
          clone.style.display = 'none';
          const el = document.elementFromPoint(e.clientX, e.clientY);
          clone.style.display = '';
          const hc = el && el.closest('.todo-card');
          if (hc && hc !== card) hc.classList.add('list-drag-over');
        };

        const onUp = e => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (!moved) return;
          clone && clone.remove();
          card.classList.remove('list-dragging');
          document.querySelectorAll('.list-drag-over').forEach(c => c.classList.remove('list-drag-over'));
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const hc = el && el.closest('.todo-card');
          if (hc && hc !== card) {
            const toListId = parseInt(hc.dataset.listId);
            if (srcListId !== toListId) moveList(srcListId, toListId, isDefault);
          }
          dragListId = null;
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // ── Touch drag (mobile) ──
      let clone = null, offY = 0, srcCard = null;
      handle.addEventListener('touchstart', e => {
        srcCard = card;
        dragListId = parseInt(card.dataset.listId);
        offY = e.touches[0].clientY - card.getBoundingClientRect().top;
        clone = card.cloneNode(true);
        clone.style.cssText = 'position:fixed;left:0;right:0;z-index:600;opacity:0.85;pointer-events:none;background:var(--bg-elevated);border:1px solid var(--border-mid);border-radius:var(--radius-md);';
        clone.style.top = (e.touches[0].clientY - offY) + 'px';
        document.body.appendChild(clone);
        card.classList.add('list-dragging');
        e.preventDefault();
      }, { passive: false });
      handle.addEventListener('touchmove', e => {
        if (!clone) return;
        clone.style.top = (e.touches[0].clientY - offY) + 'px';
        clone.style.display = 'none';
        const el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
        clone.style.display = '';
        document.querySelectorAll('.list-drag-over').forEach(c => c.classList.remove('list-drag-over'));
        const hc = el && el.closest('.todo-card');
        if (hc && hc !== srcCard) hc.classList.add('list-drag-over');
        e.preventDefault();
      }, { passive: false });
      handle.addEventListener('touchend', e => {
        if (!clone) return;
        clone.style.display = 'none';
        const el = document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        clone.style.display = '';
        const hc = el && el.closest('.todo-card');
        if (hc && hc !== srcCard) {
          const toListId = parseInt(hc.dataset.listId);
          if (dragListId !== toListId) moveList(dragListId, toListId, isDefault);
        }
        clone.remove(); clone = null;
        srcCard.classList.remove('list-dragging');
        document.querySelectorAll('.list-drag-over').forEach(c => c.classList.remove('list-drag-over'));
        dragListId = null;
      });
    });
  });
}

function moveList(fromListId, toListId, isDefault) {
  const group = todoLists.filter(l => l.isDefault === isDefault);
  const fromIdx = group.findIndex(l => l.id === fromListId);
  const toIdx   = group.findIndex(l => l.id === toListId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = group.splice(fromIdx, 1);
  group.splice(toIdx, 0, moved);
  const other = todoLists.filter(l => l.isDefault !== isDefault);
  todoLists = isDefault ? [...group, ...other] : [...other, ...group];
  renderTodos();
  saveToLocal();
}

function initTaskDragDrop() {
  document.querySelectorAll('.task-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      if (dragListId !== null) { e.preventDefault(); return; }
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
  renderTodos();
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
  renderTodos();

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
/*
 * Version 2 export format uses short key aliases to shrink file size.
 * Version 1 files (old format) are still accepted on import.
 *
 * Key map (long → short):
 *   version→v, wokenUp→wu, timerDefaults→td, timers→tm,
 *   todoIdCounter→tic, taskIdCounter→tac, todoLists→tl,
 *   calendar→cal, calEvents→ce, calTemplates→ct, calEventIdCtr→cec,
 *   -- per timer: id→i, label→lb, color→c, seconds→s,
 *                 running→r, startedAt→sa, secondsAtStart→ss
 *   -- per list:  id→i, title→ti, color→c, isDefault→d, tasks→tk
 *   -- per task:  id→i, text→tx, done→dn
 *   -- per calEvent: id→i, title→ti, start→s, end→e, color→c,
 *                    type→tp, fromTemplate→ft, templateId→tid,
 *                    repeatDays→rd
 */
function compressState(st) {
  const cTimer = t => {
    const o = { i:t.id, lb:t.label, c:t.color, s:t.seconds };
    if (t.running)   { o.r=1; o.sa=t.startedAt; o.ss=t.secondsAtStart; }
    return o;
  };
  const cDef   = t => ({ lb:t.label, c:t.color, s:t.seconds });
  const cTask  = t => { const o = { i:t.id, tx:t.text }; if (t.done) o.dn=1; return o; };
  const cList  = l => ({ i:l.id, ti:l.title, c:l.color, d:l.isDefault?1:0, tk:l.tasks.map(cTask) });
  const cCalEv = e => {
    const o = { i:e.id, ti:e.title, s:e.start, e:e.end, c:e.color };
    if (e.type && e.type !== 'event') o.tp = e.type;
    if (e.fromTemplate) o.ft = 1;
    if (e.templateId != null) o.tid = e.templateId;
    if (e.repeatDays)  o.rd = e.repeatDays;
    return o;
  };
  const cEvents = {};
  Object.entries(st.calendar.calEvents || {}).forEach(([k, evs]) => {
    cEvents[k] = evs.map(cCalEv);
  });
  return {
    v: 2,
    wu: st.wokenUp ? 1 : 0,
    td: st.timerDefaults.map(cDef),
    tm: st.timers.map(cTimer),
    tic: st.todoIdCounter,
    tac: st.taskIdCounter,
    tl: st.todoLists.map(cList),
    cal: { ce: cEvents, ct: (st.calendar.calTemplates||[]).map(cCalEv), cec: st.calendar.calEventIdCtr },
  };
}

function decompressState(c) {
  // Already v1 (old format) — pass through as-is
  if (c.version === 1) return c;
  if (c.v !== 2) return null;
  const dTimer = t => ({ id:t.i, label:t.lb, color:t.c, seconds:t.s,
    running:!!t.r, startedAt:t.sa??null, secondsAtStart:t.ss??null });
  const dDef   = t => ({ label:t.lb, color:t.c, seconds:t.s });
  const dTask  = t => ({ id:t.i, text:t.tx, done:!!t.dn });
  const dList  = l => ({ id:l.i, title:l.ti, color:l.c, isDefault:!!l.d, tasks:(l.tk||[]).map(dTask) });
  const dCalEv = e => ({
    id:e.i, title:e.ti, start:e.s, end:e.e, color:e.c,
    type:e.tp||'event', fromTemplate:!!e.ft,
    templateId:e.tid??null, repeatDays:e.rd||null,
  });
  const dEvents = {};
  Object.entries(c.cal.ce || {}).forEach(([k, evs]) => { dEvents[k] = evs.map(dCalEv); });
  return {
    version: 1,
    wokenUp: !!c.wu,
    timerDefaults: (c.td||[]).map(dDef),
    timers: (c.tm||[]).map(dTimer),
    todoIdCounter: c.tic,
    taskIdCounter: c.tac,
    todoLists: (c.tl||[]).map(dList),
    calendar: { calEvents: dEvents, calTemplates: (c.cal.ct||[]).map(dCalEv), calEventIdCtr: c.cal.cec||1 },
  };
}

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
  const st = decompressState(state);
  if (!st || st.version !== 1) { showToast('Invalid or unsupported file.'); return; }
  wokenUp = !!st.wokenUp;
  ['d','m'].forEach(p => {
    const row = document.getElementById(`wakeupRow-${p}`);
    const box = document.getElementById(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
  timers = st.timers.map(t => ({
    id: t.id, label: t.label, color: t.color,
    seconds: t.seconds, running: t.running,
    startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
  }));
  if (st.timerDefaults) TIMER_DEFAULTS = st.timerDefaults;
  todoIdCounter = st.todoIdCounter ?? todoIdCounter;
  taskIdCounter = st.taskIdCounter ?? taskIdCounter;
  todoLists = st.todoLists.map(l => ({
    id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
    tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
  }));
  if (st.calendar) {
    calEvents      = st.calendar.calEvents      || {};
    calTemplates   = st.calendar.calTemplates   || [];
    calEventIdCtr  = st.calendar.calEventIdCtr  || 1;
    calSave();
    calPruneDays();
    calRefresh();
  }
  renderTimers();
  renderTodos();
  showToast('State restored ✓');
}

function openExportModal() {
  const json = JSON.stringify(compressState(gatherState()));
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
function confirmClearStorage() {
  if (confirm('Clear all saved data and reset to defaults? This cannot be undone.')) {
    localStorage.clear();
    showToast('Storage cleared ✓');
  }
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
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
    }));
    if (state.calendar) {
      calEvents     = state.calendar.calEvents     || {};
      calTemplates  = state.calendar.calTemplates  || [];
      calEventIdCtr = state.calendar.calEventIdCtr || 1;
    }
    return true;
  } catch(e) {
    // Corrupted data — wipe it and continue with defaults (no reload needed)
    try { localStorage.removeItem(LS_KEY); } catch(_) {}
    return false;
  }
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
const CAL_DOW       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CAL_TOTAL_PX  = 24 * CAL_HOUR_PX;

// calEvents: { 'YYYY-MM-DD': [ {id, title, start, end, color, type, fromTemplate, templateId}, ... ] }
// calTemplates: [ {id, title, start, end, color, type, repeatDays:[0-6], isTemplate:true}, ... ]
let calEvents      = {};
let calTemplates   = [];
let calEventIdCtr  = 1;
let calMobileDay   = 0;         // index 0-6 in rolling week
let calFmtMobileDay= 0;         // index 0-6 in Sun-Sat week (format mode mobile)
let calDesktopOpen = false;
let calWeekMode    = 'rolling'; // 'rolling' | 'fixed' (Sun-Sat)
let calEditId      = null;
let calEditDate    = null;      // 'YYYY-MM-DD' for user events, null for templates in fmt mode
let calEditDow     = null;      // 0-6 for template edits in format mode
let calEditType    = 'event';
let calSelectedColor = CAL_COLORS[0];
let calDragEv      = null;
let calDragDate    = null;
let calDragDow     = null;
let calDragOffY    = 0;

/* ── Date helpers ── */
function calToday() { const d=new Date(); d.setHours(0,0,0,0); return d; }
function calDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function calRollingDays() {
  const t = calToday();
  return Array.from({length:7}, (_,i) => { const d=new Date(t); d.setDate(t.getDate()+i); return d; });
}
function calFixedWeekDays() {
  // Returns Sun-Sat of the current calendar week
  const t = calToday();
  const dow = t.getDay(); // 0=Sun
  return Array.from({length:7}, (_,i) => { const d=new Date(t); d.setDate(t.getDate()-dow+i); return d; });
}
function calDisplayDays() {
  return calWeekMode === 'fixed' ? calFixedWeekDays() : calRollingDays();
}
function calFmtFull(d) {
  return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
}
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

/* ── Seeding: ensure a day exists with templates for its weekday ── */
function calEnsureDay(key) {
  if (!calEvents[key]) {
    const dow = new Date(key + 'T00:00:00').getDay();
    calEvents[key] = calTemplates
      .filter(t => t.repeatDays && t.repeatDays.includes(dow))
      .map(t => ({...t, id:calEventIdCtr++, fromTemplate:true, templateId:t.id}));
  }
}

function calPruneDays() {
  const keys = new Set(calDisplayDays().map(calDateKey));
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
    line.className = 'cal-hour-line'; line.style.top = (h*CAL_HOUR_PX)+'px';
    col.appendChild(line);
    const half = document.createElement('div');
    half.className = 'cal-half-line'; half.style.top = (h*CAL_HOUR_PX + CAL_HOUR_PX/2)+'px';
    col.appendChild(half);
    [1,3].forEach(q => {
      const ql = document.createElement('div');
      ql.className = 'cal-quarter-line'; ql.style.top = (h*CAL_HOUR_PX + q*(CAL_HOUR_PX/4))+'px';
      col.appendChild(ql);
    });
  }
}

/* ── Now line ── */
function calBuildNowLine(col) {
  col.querySelector('.cal-now-line')?.remove();
  const now = new Date();
  const mins = now.getHours()*60 + now.getMinutes();
  const wrap = document.createElement('div');
  wrap.className = 'cal-now-line'; wrap.style.top = calMinsToPx(mins)+'px';
  const dot = document.createElement('div'); dot.className='cal-now-dot';
  wrap.appendChild(dot); col.appendChild(wrap);
}

/* ── Render event block ── */
function calMakeEventEl(ev, dateKeyOrDow, isFmtMode) {
  const el = document.createElement('div');
  if (ev.type === 'divider') {
    el.className = 'cal-divider';
    el.style.top = calMinsToPx(calTimeToMins(ev.start))+'px';
    el.style.transform = 'translateY(-50%)';
    const line = document.createElement('div');
    line.className = 'cal-divider-line'; line.style.background = ev.color;
    const lbl = document.createElement('div');
    lbl.className = 'cal-divider-label'; lbl.style.color = ev.color;
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
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (isFmtMode) openCalModalFmt(typeof dateKeyOrDow === 'number' ? dateKeyOrDow : null, ev.id);
    else openCalModal(dateKeyOrDow, ev.id);
  });
  calAddDragToEvent(el, ev, dateKeyOrDow, isFmtMode);
  return el;
}

/* ── Render user day column ── */
function calRenderDayCol(col, dateKey) {
  col.querySelectorAll('.cal-event,.cal-divider,.cal-now-line').forEach(e=>e.remove());
  calEnsureDay(dateKey);
  // Show all events; template-seeded ones appear alongside user events
  (calEvents[dateKey]||[]).forEach(ev => col.appendChild(calMakeEventEl(ev, dateKey, false)));
  if (dateKey === calDateKey(calToday())) calBuildNowLine(col);
  col.onclick = (e) => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    openCalModal(dateKey, null, calMinsToStr(calPxToMins(e.clientY - rect.top)));
  };
}

/* ── Render format mode DOW column (shows only templates for that DOW) ── */
function calRenderFmtCol(col, dow) {
  col.querySelectorAll('.cal-event,.cal-divider').forEach(e=>e.remove());
  const tmplsForDow = calTemplates.filter(t => t.repeatDays && t.repeatDays.includes(dow));
  tmplsForDow.forEach(t => col.appendChild(calMakeEventEl(t, dow, true)));
  col.onclick = (e) => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    openCalModalFmt(dow, null, calMinsToStr(calPxToMins(e.clientY - rect.top)));
  };
}

/* ── Desktop render (user mode) ── */
function calRenderDesktop() {
  if (formatMode) { calRenderDesktopFmt(); return; }
  const days = calDisplayDays();
  calPruneDays();

  const titleEl = document.getElementById('calDesktopTitle');
  if (titleEl) titleEl.textContent = calFmtFull(calToday());

  const daysEl = document.getElementById('calDesktopDays');
  const gridEl = document.getElementById('calDesktopGrid');
  const timeEl = document.getElementById('calTimeCol');
  if (!daysEl||!gridEl||!timeEl) return;

  daysEl.style.gridTemplateColumns = `repeat(7,1fr)`;
  daysEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(7,1fr)`;
  gridEl.innerHTML = '';

  calBuildTimeCol(timeEl);
  timeEl.style.height = CAL_TOTAL_PX + 'px';

  days.forEach(day => {
    const key = calDateKey(day);
    const isToday = key === calDateKey(calToday());
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header'+(isToday?' today':'');
    hdr.innerHTML = `<div>${calFmtShort(day)}</div><div class="cal-day-header-date">${day.getDate()}</div>`;
    daysEl.appendChild(hdr);

    const col = document.createElement('div');
    col.className = 'cal-day-col'; col.dataset.dateKey = key;
    calBuildLines(col);
    calRenderDayCol(col, key);
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault(); col.classList.remove('drag-over');
      calHandleDrop(key, e.clientY, col.getBoundingClientRect().top, false);
    });
    gridEl.appendChild(col);
  });

  gridEl.style.height = CAL_TOTAL_PX + 'px';
  const scrollArea = document.getElementById('calScrollArea');
  setTimeout(() => { if (scrollArea) scrollArea.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── Desktop render (format mode — shows Sun-Sat template columns) ── */
function calRenderDesktopFmt() {
  const titleEl = document.getElementById('calDesktopTitle');
  if (titleEl) titleEl.textContent = 'Template week — Sun through Sat';

  const daysEl = document.getElementById('calDesktopDays');
  const gridEl = document.getElementById('calDesktopGrid');
  const timeEl = document.getElementById('calTimeCol');
  if (!daysEl||!gridEl||!timeEl) return;

  daysEl.style.gridTemplateColumns = `repeat(7,1fr)`;
  daysEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(7,1fr)`;
  gridEl.innerHTML = '';

  calBuildTimeCol(timeEl);
  timeEl.style.height = CAL_TOTAL_PX + 'px';

  CAL_DOW.forEach((name, dow) => {
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header cal-fmt-col-header';
    hdr.innerHTML = `<div>${name}</div>`;
    daysEl.appendChild(hdr);

    const col = document.createElement('div');
    col.className = 'cal-day-col cal-fmt-col'; col.dataset.dow = dow;
    calBuildLines(col);
    calRenderFmtCol(col, dow);
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault(); col.classList.remove('drag-over');
      calHandleDropFmt(dow, e.clientY, col.getBoundingClientRect().top);
    });
    gridEl.appendChild(col);
  });

  gridEl.style.height = CAL_TOTAL_PX + 'px';
  const scrollArea = document.getElementById('calScrollArea');
  setTimeout(() => { if (scrollArea) scrollArea.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── Mobile render (user mode) ── */
function calRenderMobile() {
  if (formatMode) { calRenderMobileFmt(); return; }
  calPruneDays();
  const days = calDisplayDays();
  const day = days[Math.min(calMobileDay, days.length-1)];
  const key = calDateKey(day);

  const titleEl = document.getElementById('calDayTitle');
  if (titleEl) titleEl.textContent = calFmtFull(day);

  const gridEl = document.getElementById('calMobileGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const body = document.createElement('div');
  body.className = 'cal-mobile-body'; body.style.width = '100%';

  const timeCol = document.createElement('div');
  timeCol.className = 'cal-mobile-time-col'; calBuildTimeCol(timeCol);

  const dayCol = document.createElement('div');
  dayCol.className = 'cal-mobile-day-col';
  calBuildLines(dayCol);
  calRenderDayCol(dayCol, key);
  dayCol.addEventListener('dragover', e => e.preventDefault());
  dayCol.addEventListener('drop', e => {
    e.preventDefault();
    calHandleDrop(key, e.clientY, dayCol.getBoundingClientRect().top, false);
  });

  body.appendChild(timeCol); body.appendChild(dayCol); gridEl.appendChild(body);
  setTimeout(() => { gridEl.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── Mobile render (format mode — Sun-Sat) ── */
function calRenderMobileFmt() {
  const dow = calFmtMobileDay; // 0=Sun … 6=Sat
  const titleEl = document.getElementById('calDayTitle');
  if (titleEl) titleEl.textContent = `Template: ${CAL_DOW[dow]}`;

  const gridEl = document.getElementById('calMobileGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const body = document.createElement('div');
  body.className = 'cal-mobile-body'; body.style.width = '100%';

  const timeCol = document.createElement('div');
  timeCol.className = 'cal-mobile-time-col'; calBuildTimeCol(timeCol);

  const dayCol = document.createElement('div');
  dayCol.className = 'cal-mobile-day-col cal-fmt-col';
  calBuildLines(dayCol);
  calRenderFmtCol(dayCol, dow);
  dayCol.addEventListener('dragover', e => e.preventDefault());
  dayCol.addEventListener('drop', e => {
    e.preventDefault();
    calHandleDropFmt(dow, e.clientY, dayCol.getBoundingClientRect().top);
  });

  body.appendChild(timeCol); body.appendChild(dayCol); gridEl.appendChild(body);
  setTimeout(() => { gridEl.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── Navigation ── */
function calNavDay(dir) {
  if (formatMode) {
    calFmtMobileDay = Math.max(0, Math.min(6, calFmtMobileDay + dir));
    calRenderMobileFmt();
  } else {
    calMobileDay = Math.max(0, Math.min(6, calMobileDay + dir));
    calRenderMobile();
  }
}

/* ── Toggle desktop calendar ── */
function calToggleDesktop() {
  calDesktopOpen = !calDesktopOpen;
  const panel   = document.getElementById('calDesktopPanel');
  const btn     = document.getElementById('calDesktopNavTab');
  const rp      = document.getElementById('rightPanel');
  const weekBtn = document.getElementById('calWeekModeBtn');
  if (panel)   panel.classList.toggle('active', calDesktopOpen);
  if (btn)     btn.classList.toggle('active', calDesktopOpen);
  if (rp)      rp.style.display = calDesktopOpen ? 'none' : '';
  if (weekBtn) weekBtn.style.display = calDesktopOpen ? 'block' : 'none';
  if (calDesktopOpen) calRenderDesktop();
}

/* ── Week mode toggle (desktop) ── */
function calToggleWeekMode() {
  calWeekMode = calWeekMode === 'rolling' ? 'fixed' : 'rolling';
  const btn = document.getElementById('calWeekModeBtn');
  if (btn) btn.textContent = calWeekMode === 'fixed' ? 'Rolling week' : 'Sun – Sat';
  if (calDesktopOpen) calRenderDesktop();
}

/* ── User mode modal ── */
function openCalModal(dateKey, evId, defaultStart) {
  if (gcalIsConnected()) gcalReconcile(); // refresh link state before showing modal
  calEditDate = dateKey;
  calEditDow  = null;
  calEditId   = (evId !== undefined && evId !== null) ? evId : null;

  _buildCalModal(evId, defaultStart, false,
    (calEvents[dateKey]||[]).find(e=>e.id===evId) || null);
}

/* ── Format mode modal (template editing) ── */
function openCalModalFmt(dow, evId, defaultStart) {
  calEditDow  = dow;
  calEditDate = null;
  calEditId   = (evId !== undefined && evId !== null) ? evId : null;

  const existingTmpl = evId !== null ? calTemplates.find(t=>t.id===evId) : null;
  _buildCalModal(evId, defaultStart, true, existingTmpl);
}

function _buildCalModal(evId, defaultStart, isFmt, existingEv) {
  const swatchEl = document.getElementById('calColorSwatches');
  swatchEl.innerHTML = '';
  CAL_COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'cal-color-dot'+(c===calSelectedColor?' selected':'');
    dot.style.background = c;
    dot.onclick = () => {
      calSelectedColor=c;
      document.querySelectorAll('.cal-color-dot').forEach(d=>d.classList.remove('selected'));
      dot.classList.add('selected');
    };
    swatchEl.appendChild(dot);
  });

  const deleteBtn    = document.getElementById('calEventDeleteBtn');
  const sendGcalBtn  = document.getElementById('calSendToGcalBtn');
  const titleEl   = document.getElementById('calEventModalTitle');
  const tmplRow   = document.getElementById('calTemplateRow');

  // Day-of-week repeat picker (only in format mode)
  let dowRow = document.getElementById('calDowRow');
  if (!dowRow) {
    dowRow = document.createElement('div');
    dowRow.id = 'calDowRow';
    dowRow.className = 'cal-dow-row';
    tmplRow.after(dowRow);
  }

  if (isFmt) {
    // Format mode: show DOW picker, hide template checkbox
    tmplRow.style.display = 'none';
    dowRow.style.display = 'flex';
    const repeats = existingEv?.repeatDays ?? [calEditDow ?? 0];
    dowRow.innerHTML = '<span class="cal-event-label" style="margin-right:6px">Repeats</span>';
    CAL_DOW.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'cal-dow-btn' + (repeats.includes(i) ? ' active' : '');
      btn.textContent = name[0];
      btn.dataset.dow = i;
      btn.onclick = () => btn.classList.toggle('active');
      dowRow.appendChild(btn);
    });
  } else {
    tmplRow.style.display = 'none'; // hide template checkbox in user mode
    dowRow.style.display = 'none';
  }

  if (existingEv) {
    document.getElementById('calEventTitle').value = existingEv.title || '';
    document.getElementById('calEventStart').value = existingEv.start || '09:00';
    document.getElementById('calEventEnd').value   = existingEv.end   || '10:00';
    calSelectedColor = existingEv.color || CAL_COLORS[0];
    setCalEventType(existingEv.type || 'event');
    titleEl.textContent = isFmt ? 'Edit template' : 'Edit event';
    deleteBtn.style.display = 'block';
    // Show "Send to GCal" only if: connected, user mode, not a divider, not already synced
    if (sendGcalBtn) {
      const alreadySynced = !!(existingEv.gcalId);
      const showSend = gcalIsConnected() && !isFmt && (existingEv.type || 'event') !== 'divider' && !alreadySynced;
      sendGcalBtn.style.display = showSend ? 'block' : 'none';
      sendGcalBtn.textContent = 'Send to Google Calendar';
      sendGcalBtn.disabled = false;
    }
    document.querySelectorAll('.cal-color-dot').forEach(d =>
      d.classList.toggle('selected', d.style.background === calSelectedColor || d.style.backgroundColor === calSelectedColor)
    );
  } else {
    document.getElementById('calEventTitle').value = '';
    document.getElementById('calEventStart').value = defaultStart || '09:00';
    document.getElementById('calEventEnd').value   = defaultStart ? calMinsToStr(Math.min(1440, calTimeToMins(defaultStart)+60)) : '10:00';
    calSelectedColor = CAL_COLORS[0];
    setCalEventType('event');
    titleEl.textContent = isFmt ? 'Add template' : 'Add event';
    deleteBtn.style.display = 'none';
    if (sendGcalBtn) sendGcalBtn.style.display = 'none';
  }

  document.getElementById('calEventModal').classList.add('show');
}

function closeCalModal() {
  document.getElementById('calEventModal').classList.remove('show');
  calEditId = null; calEditDate = null; calEditDow = null;
}

async function calSendToGcal() {
  if (!gcalIsConnected() || !calEditDate || calEditId === null) return;
  const ev = (calEvents[calEditDate] || []).find(e => e.id === calEditId);
  if (!ev || ev.type === 'divider' || ev.gcalId) return;

  // Pick calendar — prefer first enabled, else prompt user via existing topic select if visible
  const select = document.getElementById('calTopicSelect');
  const calId  = (select && select.value) ? select.value
               : gcalCalendars.find(c => c.enabled)?.id;
  if (!calId) { showToast('No Google Calendar selected.'); return; }

  const btn = document.getElementById('calSendToGcalBtn');
  btn.textContent = 'Sending…';
  btn.disabled = true;

  const gcalId = await gcalPushEvent(ev, calEditDate, calId);
  if (gcalId) {
    ev.gcalId    = gcalId;
    ev.gcalCalId = calId;
    calSave();
    btn.textContent = '✓ Sent!';
    btn.style.color = '#4285f4';
    setTimeout(() => {
      btn.style.display = 'none'; // hide — it's now synced
    }, 1500);
    await gcalSyncAll();
    showToast('Sent to Google Calendar ✓');
  } else {
    btn.textContent = 'Send to Google Calendar';
    btn.disabled = false;
  }
}

function setCalEventType(type) {
  calEditType = type;
  document.getElementById('calTypeEvent').classList.toggle('active', type==='event');
  document.getElementById('calTypeDivider').classList.toggle('active', type==='divider');
  const endField = document.querySelectorAll('.cal-event-field')[1];
  if (endField) endField.style.display = type==='divider' ? 'none' : '';
}

/* ── Save event ── */
function saveCalEvent() {
  const title = document.getElementById('calEventTitle').value.trim();
  const start = document.getElementById('calEventStart').value;
  const end   = calEditType==='divider' ? start : document.getElementById('calEventEnd').value;

  if (calEditDow !== null || (formatMode && calEditDate === null)) {
    // ── Format mode: save/update template ──
    const dowBtns = document.querySelectorAll('#calDowRow .cal-dow-btn.active');
    const repeatDays = Array.from(dowBtns).map(b => parseInt(b.dataset.dow));

    const tmplId = (calEditId !== null && calEditId !== undefined) ? calEditId : calEventIdCtr++;
    const tmpl = {
      id: tmplId, title, start, end,
      color: calSelectedColor, type: calEditType,
      isTemplate: true, repeatDays,
    };

    const tIdx = calTemplates.findIndex(t => t.id === tmplId);
    if (tIdx >= 0) calTemplates[tIdx] = tmpl; else calTemplates.push(tmpl);

    // Re-seed all affected days (remove old instances, add updated)
    calDisplayDays().forEach(day => {
      const key = calDateKey(day);
      const dow  = day.getDay();
      if (!calEvents[key]) return; // unvisited days don't need updating
      // Remove old instances of this template
      calEvents[key] = calEvents[key].filter(e => e.templateId !== tmplId);
      // Re-add if this DOW is selected
      if (repeatDays.includes(dow)) {
        calEvents[key].push({...tmpl, id:calEventIdCtr++, fromTemplate:true, templateId:tmplId});
      }
    });

  } else {
    // ── User mode: save/update day event ──
    const key = calEditDate;
    if (calEditId !== null && calEditId !== undefined) {
      if (!calEvents[key]) calEnsureDay(key);
      const idx = calEvents[key].findIndex(e => e.id === calEditId);
      if (idx >= 0) {
        const old = calEvents[key][idx];
        calEvents[key][idx] = {
          id: calEditId, title, start, end,
          color: calSelectedColor, type: calEditType,
          fromTemplate: old.fromTemplate || false,
          templateId:   old.templateId   || undefined,
        };
      }
    } else {
      calEnsureDay(key);
      calEvents[key].push({
        id: calEventIdCtr++, title, start, end,
        color: calSelectedColor, type: calEditType,
      });
    }
  }

  closeCalModal();
  calRefresh();
  calSave();
}

/* ── Delete event ── */
function deleteCalEvent() {
  if (calEditDow !== null) {
    // Format mode: remove template entirely + all seeded instances
    calTemplates = calTemplates.filter(t => t.id !== calEditId);
    Object.keys(calEvents).forEach(k => {
      calEvents[k] = calEvents[k].filter(e => e.templateId !== calEditId);
    });
  } else if (calEditDate) {
    const ev = (calEvents[calEditDate]||[]).find(e=>e.id===calEditId);
    if (ev && ev.fromTemplate) {
      // User mode: delete only from this day; template survives for future days
      calEvents[calEditDate] = calEvents[calEditDate].filter(e=>e.id!==calEditId);
    } else {
      calEvents[calEditDate] = (calEvents[calEditDate]||[]).filter(e=>e.id!==calEditId);
    }
  }
  closeCalModal();
  calRefresh();
  calSave();
}

/* ── Drag & drop (user mode) ── */
function calAddDragToEvent(el, ev, dateKeyOrDow, isFmtMode) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', e => {
    calDragEv   = ev;
    calDragDate = isFmtMode ? null : dateKeyOrDow;
    calDragDow  = isFmtMode ? dateKeyOrDow : null;
    calDragOffY = e.offsetY;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}

function calHandleDrop(toDateKey, clientY, colTop) {
  if (!calDragEv) return;
  const mins = calPxToMins(clientY - colTop - calDragOffY);
  const dur  = calDragEv.type === 'divider' ? 0
    : calTimeToMins(calDragEv.end) - calTimeToMins(calDragEv.start);
  const newStart = Math.max(0, Math.min(1425, mins));
  const newEnd   = Math.min(1440, newStart + Math.max(15, dur));

  calEvents[calDragDate] = (calEvents[calDragDate]||[]).filter(e=>e.id!==calDragEv.id);
  calEnsureDay(toDateKey);
  calEvents[toDateKey].push({
    ...calDragEv,
    start: calMinsToStr(newStart), end: calMinsToStr(newEnd),
    fromTemplate: toDateKey !== calDragDate ? false : calDragEv.fromTemplate,
  });

  calDragEv = null;
  calRefresh();
  calSave();
}

function calHandleDropFmt(toDow, clientY, colTop) {
  if (!calDragEv) return;
  const mins = calPxToMins(clientY - colTop - calDragOffY);
  const dur  = calDragEv.type === 'divider' ? 0
    : calTimeToMins(calDragEv.end) - calTimeToMins(calDragEv.start);
  const newStart = Math.max(0, Math.min(1425, mins));
  const newEnd   = Math.min(1440, newStart + Math.max(15, dur));

  // Update template
  const tmpl = calTemplates.find(t=>t.id===calDragEv.id);
  if (tmpl) {
    // Remove old DOW, add new
    tmpl.repeatDays = tmpl.repeatDays.filter(d=>d!==calDragDow);
    if (!tmpl.repeatDays.includes(toDow)) tmpl.repeatDays.push(toDow);
    tmpl.start = calMinsToStr(newStart); tmpl.end = calMinsToStr(newEnd);
    // Re-seed affected days
    calDisplayDays().forEach(day => {
      const key = calDateKey(day); const dow = day.getDay();
      if (!calEvents[key]) return;
      calEvents[key] = calEvents[key].filter(e=>e.templateId!==tmpl.id);
      if (tmpl.repeatDays.includes(dow)) {
        calEvents[key].push({...tmpl, id:calEventIdCtr++, fromTemplate:true, templateId:tmpl.id});
      }
    });
  }
  calDragEv = null;
  calRefresh();
  calSave();
}

/* ── Refresh ── */
function calRefresh() {
  if (calDesktopOpen) calRenderDesktop();
  const panels = document.querySelectorAll('.swipe-panel');
  if (panels.length >= 4) calRenderMobile();
}

/* ── Now-line tick ── */
function calTickNow() {
  if (calDesktopOpen && !formatMode) {
    document.querySelectorAll('.cal-day-col').forEach(col => {
      if (col.dataset.dateKey === calDateKey(calToday())) calBuildNowLine(col);
    });
  }
  const mobileDay = document.querySelector('.cal-mobile-day-col');
  if (mobileDay && !formatMode) {
    const days = calDisplayDays();
    const idx  = Math.min(calMobileDay, days.length-1);
    if (calDateKey(days[idx]) === calDateKey(calToday())) calBuildNowLine(mobileDay);
  }
  setTimeout(calTickNow, 60000);
}

/* ── Persist ── */
function calSave() {
  try { localStorage.setItem(CAL_LS_KEY, JSON.stringify({calEvents, calTemplates, calEventIdCtr})); } catch(e) {}
}
function calLoad() {
  try {
    const raw = localStorage.getItem(CAL_LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.calEvents)     calEvents     = s.calEvents;
    if (s.calTemplates)  calTemplates  = s.calTemplates;
    if (s.calEventIdCtr) calEventIdCtr = s.calEventIdCtr;
  } catch(e) {}
}

/* ── Desktop Calendar nav tab in left panel ── */
function calInitDesktopTab() {
  const lp = document.getElementById('leftPanel');
  if (!lp) return;

  const tab = document.createElement('div');
  tab.className = 'cal-nav-tab'; tab.id = 'calDesktopNavTab';
  tab.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
    <path d="M1 5h10" stroke="currentColor" stroke-width="1.2"/>
    <path d="M4 1v2M8 1v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg> Calendar`;
  tab.onclick = calToggleDesktop;

  // Week mode toggle button (shown when calendar is open)
  const weekBtn = document.createElement('button');
  weekBtn.id = 'calWeekModeBtn';
  weekBtn.className = 'cal-week-mode-btn';
  weekBtn.textContent = 'Sun – Sat';
  weekBtn.onclick = (e) => { e.stopPropagation(); calToggleWeekMode(); };

  const wakeup = lp.querySelector('.wakeup-row');
  if (wakeup) { wakeup.after(weekBtn); wakeup.after(tab); }
  else { lp.prepend(weekBtn); lp.prepend(tab); }
}

/* ── goTab / setSwipePanelWidths: already handle 4 tabs ── */
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

const _origSetSwipe = setSwipePanelWidths;
setSwipePanelWidths = function() {
  const w = window.innerWidth;
  const track = document.getElementById('swipeTrack');
  const panels = document.querySelectorAll('.swipe-panel');
  const count = panels.length || 4;
  if (track) track.style.width = (w * count) + 'px';
  panels.forEach(p => p.style.width = w + 'px');
  if (track) {
    track.style.transition = 'none';
    track.style.transform = `translateX(${-currentTab * w}px)`;
  }
  [0,1,2,3].forEach(i => {
    const btn = document.getElementById(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === currentTab);
  });
};

// Modal backdrop click
document.getElementById('calEventModal').addEventListener('click', e => {
  if (e.target.id === 'calEventModal') closeCalModal();
});

/* ── Hook format mode enter/exit to refresh calendar ── */
const _origEnterFmt = enterFormatMode;
enterFormatMode = function() {
  _origEnterFmt();
  calFmtMobileDay = 0;
  if (calDesktopOpen) calRenderDesktop();
  if (currentTab === 3) calRenderMobile();
};

const _origCommitFmt = commitFormatMode;
commitFormatMode = function() {
  _origCommitFmt();
  if (calDesktopOpen) calRenderDesktop();
  if (currentTab === 3) calRenderMobile();
};

/* ── Init ── */
calLoad();
calPruneDays();
calInitDesktopTab();
calRenderMobile();
calTickNow();

/* ══════════════════════════════════════════════════════
   GOOGLE CALENDAR INTEGRATION
   ══════════════════════════════════════════════════════ */

const GCAL_CLIENT_ID  = '855884688171-80lpepboe9q7io8m8lpd3njllnrgvl0d.apps.googleusercontent.com';
const GCAL_SCOPES     = 'https://www.googleapis.com/auth/calendar';
const GCAL_LS_KEY     = 'focus-gcal-token';
const GCAL_CAL_LS_KEY = 'focus-gcal-calendars';

let gcalToken       = null;   // { access_token, expires_at }
let gcalCalendars   = [];     // [{ id, summary, color, enabled }]
let gcalEvents      = {};     // { 'YYYY-MM-DD': [ gcal event objects ] }
let gcalSyncing     = false;

/* ── Token helpers ── */
function gcalSaveToken(t) {
  gcalToken = t;
  try { localStorage.setItem(GCAL_LS_KEY, JSON.stringify(t)); } catch(e) {}
}
function gcalLoadToken() {
  try {
    const raw = localStorage.getItem(GCAL_LS_KEY);
    if (!raw) return;
    const t = JSON.parse(raw);
    if (t && t.expires_at && Date.now() < t.expires_at) gcalToken = t;
    else localStorage.removeItem(GCAL_LS_KEY);
  } catch(e) {}
}
function gcalSaveCals() {
  try { localStorage.setItem(GCAL_CAL_LS_KEY, JSON.stringify(gcalCalendars)); } catch(e) {}
}
function gcalLoadCals() {
  try {
    const raw = localStorage.getItem(GCAL_CAL_LS_KEY);
    if (raw) gcalCalendars = JSON.parse(raw);
  } catch(e) {}
}
function gcalIsConnected() { return !!(gcalToken && Date.now() < gcalToken.expires_at); }

/* ── OAuth via popup ── */
function gcalConnect() {
  const params = new URLSearchParams({
    client_id:     GCAL_CLIENT_ID,
    redirect_uri:  'https://homiejhan.github.io/worky/',
    response_type: 'token',
    scope:         GCAL_SCOPES,
    prompt:        'select_account',
  });
  const w = 500, h = 600;
  const left = Math.max(0, (screen.width  - w) / 2);
  const top  = Math.max(0, (screen.height - h) / 2);
  window.open(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    'gcal-auth',
    `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`
  );
}

/* ── Handle OAuth redirect (token in hash) ── */
function gcalHandleRedirect() {
  const hash = window.location.hash.slice(1);
  if (!hash.includes('access_token')) return;
  const params = new URLSearchParams(hash);
  const token  = params.get('access_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600');
  if (!token) return;
  gcalSaveToken({ access_token: token, expires_at: Date.now() + expiresIn * 1000 });
  // Clean the URL
  history.replaceState(null, '', window.location.pathname);
  gcalAfterConnect();
}

async function gcalAfterConnect() {
  gcalUpdateBtn();
  showToast('Google Calendar connected ✓');
  await gcalFetchCalendars();
  gcalOpenModal();
  await gcalSyncAll();
}

/* ── Fetch calendar list ── */
async function gcalFetchCalendars() {
  if (!gcalIsConnected()) return;
  try {
    const res  = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${gcalToken.access_token}` }
    });
    const data = await res.json();
    if (!data.items) return;
    // Merge with saved enabled states
    const saved = {};
    gcalCalendars.forEach(c => { saved[c.id] = c.enabled; });
    gcalCalendars = data.items.map(c => ({
      id:      c.id,
      summary: c.summary,
      color:   c.backgroundColor || '#378ADD',
      enabled: saved[c.id] !== undefined ? saved[c.id] : true,
    }));
    gcalSaveCals();
    gcalRenderCalList();
  } catch(e) { showToast('Could not fetch calendars.'); }
}

/* ── Fetch events for the current week ── */
async function gcalSyncAll() {
  if (!gcalIsConnected() || gcalSyncing) return;
  gcalSyncing = true;
  gcalUpdateSyncBtn();

  const days     = calDisplayDays();
  const timeMin  = new Date(days[0]);  timeMin.setHours(0,0,0,0);
  const timeMax  = new Date(days[days.length-1]); timeMax.setHours(23,59,59,999);
  const enabledCals = gcalCalendars.filter(c => c.enabled);

  gcalEvents = {};

  try {
    await Promise.all(enabledCals.map(async cal => {
      const params = new URLSearchParams({
        timeMin:      timeMin.toISOString(),
        timeMax:      timeMax.toISOString(),
        singleEvents: 'true',
        orderBy:      'startTime',
        maxResults:   '250',
      });
      const res  = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
        { headers: { Authorization: `Bearer ${gcalToken.access_token}` } }
      );
      const data = await res.json();
      if (!data.items) return;
      data.items.forEach(ev => {
        if (!ev.start) return;
        const startStr = ev.start.dateTime || ev.start.date;
        const endStr   = ev.end?.dateTime  || ev.end?.date;
        const dateKey  = startStr.slice(0, 10);
        if (!gcalEvents[dateKey]) gcalEvents[dateKey] = [];

        // Parse times in local timezone (not UTC slice)
        let startLocal = '00:00', endLocal = '23:59';
        if (ev.start.dateTime) {
          const sd = new Date(ev.start.dateTime);
          startLocal = `${String(sd.getHours()).padStart(2,'0')}:${String(sd.getMinutes()).padStart(2,'0')}`;
        }
        if (ev.end?.dateTime) {
          const ed = new Date(ev.end.dateTime);
          endLocal = `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}`;
        }
        // Use local date key too (event might cross midnight in UTC)
        const localDateKey = ev.start.dateTime
          ? (() => { const d = new Date(ev.start.dateTime); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()
          : dateKey;

        if (!gcalEvents[localDateKey]) gcalEvents[localDateKey] = [];
        gcalEvents[localDateKey].push({
          gcalId:   ev.id,
          calId:    cal.id,
          calName:  cal.summary,
          calColor: cal.color,
          title:    ev.summary || '(no title)',
          start:    startLocal,
          end:      endLocal,
          allDay:   !ev.start.dateTime,
          htmlLink: ev.htmlLink,
          color:    cal.color,
        });
      });
    }));
  } catch(e) { showToast('Sync error — check connection.'); }

  gcalSyncing = false;
  gcalUpdateSyncBtn();
  gcalReconcile(); // validate + auto-link before rendering
  calRefresh();
  calSave();
}

/* ── Reconcile local events against fetched GCal events ──
 *  For every local event on every visible day:
 *  - Find a GCal event with identical title, start, and end
 *  - If found → set gcalId/gcalCalId to that event (sync confirmed)
 *  - If not found → clear gcalId/gcalCalId (unsynced)
 *  This runs from scratch every time — we never trust stale gcalId values.
 */
function gcalReconcile() {
  const validKeys = calDisplayDays().map(calDateKey);

  validKeys.forEach(dateKey => {
    const localEvs = calEvents[dateKey] || [];
    const gcalEvs  = gcalEvents[dateKey] || [];

    // Track which GCal event IDs have been claimed so we don't double-link
    const claimed = new Set();

    localEvs.forEach(localEv => {
      if (localEv.type === 'divider' || localEv.fromTemplate) return;

      const match = gcalEvs.find(g =>
        !g.allDay &&
        !claimed.has(g.gcalId) &&
        g.title.trim() === (localEv.title || '').trim() &&
        g.start === localEv.start &&
        g.end   === localEv.end
      );

      if (match) {
        localEv.gcalId    = match.gcalId;
        localEv.gcalCalId = match.calId;
        claimed.add(match.gcalId);
      } else {
        localEv.gcalId    = null;
        localEv.gcalCalId = null;
      }
    });
  });

  calSave();
}

/* ── Push a local event to GCal ── */
async function gcalPushEvent(ev, dateKey, calId) {
  if (!gcalIsConnected()) return null;
  const date    = dateKey; // 'YYYY-MM-DD'
  const body    = {
    summary: ev.title,
    start:   { dateTime: `${date}T${ev.start}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end:     { dateTime: `${date}T${ev.end}:00`,   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };
  try {
    const res  = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      { method: 'POST', headers: { Authorization: `Bearer ${gcalToken.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();
    return data.id || null;
  } catch(e) { showToast('Could not push event to GCal.'); return null; }
}

/* ── Update an existing GCal event ── */
async function gcalUpdateEvent(gcalId, calId, ev, dateKey) {
  if (!gcalIsConnected() || !gcalId) return;
  const date = dateKey;
  const body = {
    summary: ev.title,
    start:   { dateTime: `${date}T${ev.start}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end:     { dateTime: `${date}T${ev.end}:00`,   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${gcalId}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${gcalToken.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
  } catch(e) { showToast('Could not update GCal event.'); }
}

/* ── Delete a GCal event ── */
async function gcalDeleteEvent(gcalId, calId) {
  if (!gcalIsConnected() || !gcalId) return;
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${gcalId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${gcalToken.access_token}` } }
    );
  } catch(e) {}
}

/* ── Disconnect ── */
function gcalDisconnect() {
  gcalToken     = null;
  gcalEvents    = {};
  localStorage.removeItem(GCAL_LS_KEY);
  gcalUpdateBtn();
  gcalCloseModal();
  calRefresh();
  showToast('Disconnected from Google Calendar');
}

/* ── Render GCal events on top of local calendar ── */
function gcalMakeEventEl(ev) {
  const el = document.createElement('div');
  el.className = 'cal-event gcal-event';
  const startM = calTimeToMins(ev.start);
  const endM   = calTimeToMins(ev.end);
  const durM   = Math.max(15, endM - startM);
  el.style.top        = calMinsToPx(startM) + 'px';
  el.style.height     = calMinsToPx(durM) + 'px';
  el.style.background = ev.color + '22';
  el.style.borderLeft = `3px solid ${ev.color}`;
  el.style.color      = ev.color;
  el.style.left       = '50%';   // right half of column to avoid overlap with local
  el.style.right      = '2px';
  el.innerHTML = `
    <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ev.title}</div>
    <div class="cal-event-time gcal-badge" style="color:${ev.color}">${ev.calName}</div>`;
  el.addEventListener('click', e => { e.stopPropagation(); gcalOpenEventDetail(ev); });
  return el;
}

function gcalInjectEvents(col, dateKey) {
  col.querySelectorAll('.gcal-event').forEach(e => e.remove());
  if (!gcalIsConnected()) return;
  (gcalEvents[dateKey] || []).forEach(ev => {
    if (!ev.allDay) col.appendChild(gcalMakeEventEl(ev));
  });
}

/* ── Hook into calRenderDayCol ── */
const _origCalRenderDayCol = calRenderDayCol;
calRenderDayCol = function(col, dateKey) {
  _origCalRenderDayCol(col, dateKey);
  gcalInjectEvents(col, dateKey);
};

/* ── GCal event detail popup ── */
function gcalOpenEventDetail(ev) {
  const modal = document.getElementById('gcalDetailModal');
  document.getElementById('gcalDetailTitle').textContent  = ev.title;
  document.getElementById('gcalDetailCal').textContent    = ev.calName;
  document.getElementById('gcalDetailCal').style.color    = ev.color;
  document.getElementById('gcalDetailTime').textContent   = ev.allDay ? 'All day' : `${calFmtTime(ev.start)} – ${calFmtTime(ev.end)}`;
  document.getElementById('gcalDetailLink').href          = ev.htmlLink || '#';
  modal.dataset.gcalId = ev.gcalId;
  modal.dataset.calId  = ev.calId;
  // Store full event for sync
  modal._gcalEv = ev;

  // Show Sync button only for non-all-day events not already in app
  const syncBtn = document.getElementById('gcalSyncToAppBtn');
  if (syncBtn) {
    const alreadyLocal = !ev.allDay && calDisplayDays().some(day => {
      const key = calDateKey(day);
      return (calEvents[key] || []).some(e => e.gcalId === ev.gcalId);
    });
    syncBtn.style.display = (!ev.allDay && !alreadyLocal) ? 'block' : 'none';
    syncBtn.textContent = 'Sync to app';
    syncBtn.disabled = false;
  }

  modal.classList.add('show');
}
function gcalCloseDetail() {
  document.getElementById('gcalDetailModal').classList.remove('show');
}

function gcalSyncToApp() {
  const modal = document.getElementById('gcalDetailModal');
  const ev    = modal._gcalEv;
  if (!ev || ev.allDay) return;

  const dateKey = ev.start.length > 5 ? ev.start.slice(0, 10)
    : calDateKey(calDisplayDays().find(d => calDateKey(d) === modal.dataset.dateKey) || calToday());

  // Find the correct date key from gcalEvents
  let foundKey = null;
  Object.entries(gcalEvents).forEach(([k, evs]) => {
    if (evs.some(e => e.gcalId === ev.gcalId)) foundKey = k;
  });
  if (!foundKey) { showToast('Could not find event date.'); return; }

  calEnsureDay(foundKey);

  // Create local event linked to this GCal event (so it won't be re-pushed)
  const localEv = {
    id:           calEventIdCtr++,
    title:        ev.title,
    start:        ev.start,
    end:          ev.end,
    color:        CAL_COLORS[0],
    type:         'event',
    fromTemplate: false,
    gcalId:       ev.gcalId,
    gcalCalId:    ev.calId,
  };
  calEvents[foundKey].push(localEv);
  calSave();
  calRefresh();

  // Hide button — it's now synced
  const syncBtn = document.getElementById('gcalSyncToAppBtn');
  if (syncBtn) { syncBtn.textContent = '✓ Synced!'; syncBtn.disabled = true; }
  setTimeout(() => gcalCloseDetail(), 1000);
  showToast('Event added to app ✓');
}
async function gcalDeleteFromDetail() {
  const modal  = document.getElementById('gcalDetailModal');
  const gcalId = modal.dataset.gcalId;
  const calId  = modal.dataset.calId;
  if (!gcalId || !calId) return;
  await gcalDeleteEvent(gcalId, calId);
  gcalCloseDetail();
  await gcalSyncAll();
  showToast('Event deleted from Google Calendar');
}

/* ── Calendar list modal ── */
function gcalOpenModal() {
  gcalRenderCalList();
  document.getElementById('gcalModal').classList.add('show');
}
function gcalCloseModal() {
  document.getElementById('gcalModal').classList.remove('show');
}
function gcalRenderCalList() {
  const list = document.getElementById('gcalCalList');
  if (!list) return;
  list.innerHTML = '';
  if (!gcalCalendars.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No calendars found.</div>';
    return;
  }
  gcalCalendars.forEach((cal, idx) => {
    const row = document.createElement('div');
    row.className = 'gcal-cal-row';
    row.innerHTML = `
      <div class="gcal-cal-dot" style="background:${cal.color}"></div>
      <span class="gcal-cal-name">${cal.summary}</span>
      <label class="gcal-toggle">
        <input type="checkbox" ${cal.enabled ? 'checked' : ''} onchange="gcalToggleCal(${idx},this.checked)">
        <span class="gcal-toggle-track"></span>
      </label>`;
    list.appendChild(row);
  });
}
function gcalToggleCal(idx, enabled) {
  gcalCalendars[idx].enabled = enabled;
  gcalSaveCals();
  gcalSyncAll();
}

/* ── Connect button in left panel ── */
function gcalUpdateBtn() {
  const btn = document.getElementById('gcalConnectBtn');
  if (!btn) return;
  if (gcalIsConnected()) {
    btn.textContent = '⚡ Google Cal';
    btn.classList.add('connected');
    btn.onclick = gcalOpenModal;
  } else {
    btn.textContent = '+ Google Cal';
    btn.classList.remove('connected');
    btn.onclick = gcalConnect;
  }
}

function gcalUpdateSyncBtn() {
  const btn = document.getElementById('gcalSyncBtn');
  if (!btn) return;
  btn.textContent  = gcalSyncing ? 'Syncing…' : 'Sync now';
  btn.disabled     = gcalSyncing;
}

/* ── Patch saveCalEvent to optionally push to GCal ── */
const _origSaveCalEvent = saveCalEvent;
saveCalEvent = async function() {
  // Capture before state
  const wasNew  = (calEditId === null || calEditId === undefined);
  const dateKey = calEditDate;
  const oldEvId = calEditId;

  _origSaveCalEvent();   // runs synchronously, updates calEvents

  if (!gcalIsConnected() || !dateKey || formatMode) return;

  // Find the event we just saved
  const ev = wasNew
    ? calEvents[dateKey]?.[calEvents[dateKey].length - 1]
    : (calEvents[dateKey] || []).find(e => e.id === oldEvId);

  if (!ev || ev.type === 'divider') return;

  const calId = gcalCalendars.find(c => c.enabled)?.id;
  if (!calId) return;

  if (wasNew) {
    const gcalId = await gcalPushEvent(ev, dateKey, calId);
    if (gcalId) ev.gcalId = gcalId; ev.gcalCalId = calId;
  } else if (ev.gcalId) {
    await gcalUpdateEvent(ev.gcalId, ev.gcalCalId || calId, ev, dateKey);
  }
  await gcalSyncAll();
};

/* ── Patch deleteCalEvent to also delete from GCal ── */
const _origDeleteCalEvent = deleteCalEvent;
deleteCalEvent = async function() {
  const ev = calEditDate ? (calEvents[calEditDate] || []).find(e => e.id === calEditId) : null;
  _origDeleteCalEvent();
  if (ev?.gcalId && ev?.gcalCalId && gcalIsConnected()) {
    await gcalDeleteEvent(ev.gcalId, ev.gcalCalId);
    await gcalSyncAll();
  }
};

/* ── Auto-sync every 5 minutes ── */
setInterval(() => { if (gcalIsConnected()) gcalSyncAll(); }, 5 * 60 * 1000);

/* ── Init ── */
gcalLoadToken();
gcalLoadCals();
gcalHandleRedirect();   // handles OAuth return
gcalUpdateBtn();
if (gcalIsConnected()) gcalSyncAll();

// Inject connect button into left panel after calendar tab
(function() {
  const lp = document.getElementById('leftPanel');
  if (!lp) return;
  const btn = document.createElement('button');
  btn.id = 'gcalConnectBtn';
  btn.className = 'gcal-connect-btn';
  lp.appendChild(btn);
  gcalUpdateBtn();
})();
