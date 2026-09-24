/* io.js — Export, Import, Reset and Clear storage. */
import { $, closeModal, showToast } from './util.js';
import { applyState, compressState, gatherState, saveToLocal } from './persistence.js';
import {
  renderTimers, setWokenUp, syncWakeupUI, TIMER_DEFAULTS, timerLogOver, timers,
  updateTimerSummary,
} from './timers.js';
import { renderTodos, todoLists } from './lists.js';
import { renderHome } from './home.js';
import { budgetResetDay, renderBudget } from './budget.js';
import { bankConnectedCount } from './bank.js';

/* ───────────────────────── EXPORT / IMPORT / RESET ───────────────────────── */
export function openExportModal() {
  $('exportTextarea').value = JSON.stringify(compressState(gatherState()));
  $('exportModal').classList.add('show');
}
export function openImportModal() {
  $('importTextarea').value = '';
  $('importModal').classList.add('show');
}

export function exportCopy() {
  navigator.clipboard.writeText($('exportTextarea').value)
    .then(() => { showToast('Copied to clipboard ✓'); closeModal('exportModal'); })
    .catch(() => showToast('Copy failed — try Download instead'));
}
export function exportDownload() {
  const blob = new Blob([$('exportTextarea').value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `focus-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded ✓');
  closeModal('exportModal');
}
export function importFromText() {
  const raw = $('importTextarea').value.trim();
  if (!raw) { showToast('Nothing to import.'); return; }
  try {
    applyState(JSON.parse(raw));
    closeModal('importModal');
  } catch { showToast('Invalid data — check your text and try again.'); }
}
export function loadStateFile(input) {
  const file = input.files[0];
  if (!file) return;
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

export function resetAll() {
  closeModal('confirmOverlay');
  timers.forEach((t, i) => {
    const def = TIMER_DEFAULTS[i];
    timerLogOver(t);            // an overrun still counts for today
    t.running = false;
    t.seconds = def ? def.seconds : t.seconds;
    t.startedAt = null;
    t.secondsAtStart = null;
    t.over = 0;
    t._overNoted = false;
  });
  setWokenUp(false);
  syncWakeupUI();
  todoLists.filter(l => l.isDefault).forEach(l => l.tasks.forEach(t => t.done = false));
  budgetResetDay();
  renderTimers();
  renderTodos();
  renderBudget();
  renderHome();
  updateTimerSummary();
  saveToLocal();
  showToast('Reset ✓');
}

export function confirmClearStorage() {
  const banks = bankConnectedCount();
  const warnBanks = banks
    ? `\n\nYou have ${banks === 1 ? 'a bank' : `${banks} banks`} connected. Disconnect ${banks === 1 ? 'it' : 'them'} first in Settings → Bank accounts: once storage is cleared, Focus can't end ${banks === 1 ? 'that connection' : 'those connections'} at Plaid.`
    : '';
  if (confirm('Clear all saved data and reset to defaults? This cannot be undone.' + warnBanks)) {
    localStorage.clear();
    showToast('Storage cleared — reloading…');
    setTimeout(() => location.reload(), 600);
  }
}
