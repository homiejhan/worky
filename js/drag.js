/* drag.js — One pointer-events drag engine for list cards, task rows, timer cards and calendar events. */
import { moveList, moveTask } from './lists.js';
import { moveTimer } from './timers.js';

/* ───────────────────────── UNIFIED DRAG ENGINE ─────────────────────────
 * One pointer-events implementation for mouse, touch, and pen.
 * Used by list cards, task rows, and calendar events.
 * ─────────────────────────────────────────────────────────────────────── */
let _suppressClicksUntil = 0;
document.addEventListener('click', e => {
  if (Date.now() < _suppressClicksUntil) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

function clearDropIndicators() {
  document.querySelectorAll('.drop-before').forEach(el => el.classList.remove('drop-before'));
  document.querySelectorAll('.drop-after').forEach(el => el.classList.remove('drop-after'));
  document.querySelectorAll('.drop-into').forEach(el => el.classList.remove('drop-into'));
}

export function hitTestAt(x, y, ghost) {
  if (ghost) ghost.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (ghost) ghost.style.display = '';
  return el;
}

/**
 * makeDrag(handle, opts)
 * opts.source()       → element being dragged (cloned for the ghost)
 * opts.onActivate()   → called once when drag actually starts
 * opts.onMove(x, y, ghost)  → highlight drop targets
 * opts.onDrop(x, y, ghost)  → commit the move
 * opts.onEnd()        → always called for cleanup
 */
export function makeDrag(handle, opts) {
  handle.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    let ghost = null, active = false, offX = 0, offY = 0;
    const src = opts.source();
    if (!src) return;

    const onMove = ev => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        active = true;
        const rect = src.getBoundingClientRect();
        offX = startX - rect.left;
        offY = startY - rect.top;
        ghost = src.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.classList.remove('drag-src');
        ghost.style.width  = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        document.documentElement.appendChild(ghost);   // escapes body's fixed/overflow trap
        src.classList.add('drag-src');
        if (opts.onActivate) opts.onActivate();
      }
      ghost.style.left = (ev.clientX - offX) + 'px';
      ghost.style.top  = (ev.clientY - offY) + 'px';
      opts.onMove(ev.clientX, ev.clientY, ghost);
      ev.preventDefault();
    };

    // Listeners live on window (not the handle) so cleanup still fires even
    // when onDrop rebuilds the DOM and removes the handle mid-gesture.
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    const finish = () => {
      cleanup();
      if (active) {
        _suppressClicksUntil = Date.now() + 250;
        src.classList.remove('drag-src');
        clearDropIndicators();
      }
      if (ghost) { ghost.remove(); ghost = null; }
      if (opts.onEnd) opts.onEnd();
    };

    const onUp = ev => {
      if (active) {
        const g = ghost;
        if (ghost) ghost.style.display = 'none';
        opts.onDrop(ev.clientX, ev.clientY, g);
      }
      finish();
    };
    const onCancel = () => finish();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });
}

/* ── list-card reordering ── */
function bindListDrag(card) {
  const handle = card.querySelector('.list-drag-handle');
  if (!handle || handle._dragBound) return;
  handle._dragBound = true;
  const isDefault = card.dataset.isDefault === '1';

  makeDrag(handle, {
    source: () => card,
    onMove: (x, y, ghost) => {
      clearDropIndicators();
      const el = hitTestAt(x, y, ghost);
      const target = el && el.closest('.todo-card');
      if (!target || target === card) return;
      if (target.dataset.isDefault !== card.dataset.isDefault) return;  // same group only
      const r = target.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      target.classList.add(after ? 'drop-after' : 'drop-before');
    },
    onDrop: (x, y, ghost) => {
      const el = hitTestAt(x, y, ghost);
      const target = el && el.closest('.todo-card');
      if (!target || target === card) return;
      if (target.dataset.isDefault !== card.dataset.isDefault) return;
      const r = target.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      moveList(parseInt(card.dataset.listId), parseInt(target.dataset.listId), after, isDefault);
    },
  });
}

/* ── task-row reordering / cross-list moves ── */
function bindTaskDrag(row) {
  const handle = row.querySelector('.drag-handle');
  if (!handle || handle._dragBound) return;
  handle._dragBound = true;

  makeDrag(handle, {
    source: () => row,
    onMove: (x, y, ghost) => {
      clearDropIndicators();
      const el = hitTestAt(x, y, ghost);
      const targetRow = el && el.closest('.task-row');
      if (targetRow && targetRow !== row) {
        // only custom-list rows accept drops (they have handles)
        if (!targetRow.querySelector('.drag-handle')) return;
        const r = targetRow.getBoundingClientRect();
        targetRow.classList.add(y > r.top + r.height/2 ? 'drop-after' : 'drop-before');
        return;
      }
      const area = el && el.closest('.todo-tasks');
      if (area) {
        const areaCard = area.closest('.todo-card');
        if (areaCard && areaCard.dataset.isDefault === '0') area.classList.add('drop-into');
      }
    },
    onDrop: (x, y, ghost) => {
      const el = hitTestAt(x, y, ghost);
      const taskId = parseInt(row.dataset.taskId);
      const fromListId = parseInt(row.dataset.listId);
      const targetRow = el && el.closest('.task-row');
      if (targetRow && targetRow !== row && targetRow.querySelector('.drag-handle')) {
        const r = targetRow.getBoundingClientRect();
        const after = y > r.top + r.height/2;
        moveTask(taskId, fromListId, parseInt(targetRow.dataset.listId), parseInt(targetRow.dataset.taskId), after);
        return;
      }
      const area = el && el.closest('.todo-tasks');
      if (area) {
        const areaCard = area.closest('.todo-card');
        if (areaCard && areaCard.dataset.isDefault === '0') {
          moveTask(taskId, fromListId, parseInt(area.dataset.listId), null, false);
        }
      }
    },
  });
}

/* ── timer-card reordering: by the grip, within the stack it is in ── */
function clearTimerDrop() {
  document.querySelectorAll('.timer-drop-before, .timer-drop-after').forEach(el => el.classList.remove('timer-drop-before', 'timer-drop-after'));
}
function timerDropAt(card, x, y, ghost) {
  const el = hitTestAt(x, y, ghost);
  const target = el && el.closest('.timer-card');
  if (!target || target === card || target.parentElement !== card.parentElement) return null;
  const r = target.getBoundingClientRect();
  return { target, after: y > r.top + r.height / 2 };
}
function bindTimerDrag(card) {
  const handle = card.querySelector('.timer-drag-handle');
  if (!handle || handle._dragBound) return;
  handle._dragBound = true;
  makeDrag(handle, {
    source: () => card,
    onMove: (x, y, ghost) => {
      clearTimerDrop();
      const at = timerDropAt(card, x, y, ghost);
      if (at) at.target.classList.add(at.after ? 'timer-drop-after' : 'timer-drop-before');
    },
    onDrop: (x, y, ghost) => {
      const at = timerDropAt(card, x, y, ghost);
      if (at) moveTimer(Number(card.dataset.timerId), Number(at.target.dataset.timerId), at.after);
    },
    onEnd: clearTimerDrop,
  });
}
export function bindTimerDrags() {
  document.querySelectorAll('.timer-card').forEach(bindTimerDrag);
}

export function bindAllDrags() {
  document.querySelectorAll('.todo-card.list-reorderable').forEach(bindListDrag);
  document.querySelectorAll('.task-row').forEach(bindTaskDrag);
}
