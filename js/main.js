/* main.js — Entry point: exposes the inline-handler functions and starts the app. */
import { $ } from './util.js';
import { gatherState, loadFromLocal, saveToLocal } from './persistence.js';
import {
  changeTimerColor, commitEditTimer, renderTimers, resetTimer, setTimerLabel, startEditTimer,
  syncWakeupUI, tickAll, toggleTimer, updateTimerSummary,
} from './timers.js';
import {
  addTask, changeTodoColor, openScheduleModal, refreshSyncBadges, removeTask, removeTodoList,
  renderTodos, setListTitle, setTaskText, toggleStarList, toggleTask,
} from './lists.js';
import { removeFormatDaily, removeFormatTimer } from './formats.js';
import {
  _dbdDayKey, addDbdTask, dbdCheckRollover, dbdTodayKey, removeDbdTask, renderDbd,
  retagListTask, setDbdDayKey, setDbdDue, setDbdText, setListTaskDue, tagDbdTask, toggleDbdTask,
} from './dbd.js';
import { openTaskLinkModal, taskLinkFlushRename, taskLinkOpenEvent } from './tasklinks.js';
import { homeInsightGo, homeToggleDesktop, renderHome } from './home.js';
import {
  applyViewVisibility, initSwipe, initViewportGuard, openBudgetTab, setSwipePanelWidths,
} from './views.js';
import { openSettings } from './settings.js';
import {
  calLoad, calLoadHiddenColors, calPruneDays, calRenderMobile, calTickNow,
} from './calendar.js';
import {
  gcalHandleRedirect, gcalIsConnected, gcalLoadCals, gcalLoadToken, gcalSyncAll, gcalToggleCal,
  gcalUpdateBtn,
} from './gcal.js';
import { budgetRollover, budgetTickDay, renderBudget } from './budget.js';
import { bankInit } from './bank.js';
import {
  setSyncBooting, setSyncLastSeenFp, syncFingerprint, syncHandleRedirect, syncInit,
} from './sync.js';
import { applyTheme } from './theme.js';
import {
  digestAddAllTasks, digestAddTask, digestDismissTask, digestLoadSample, digestRunActive,
  digestRunDismiss, digestRunLoad, digestRunNow, digestRunPoll, digestToggleCollapsed,
  digestUiLoad,
} from './digest.js';
import { bindStatic } from './bindings.js';
import { applyStarterProfile, tourOffer } from './onboarding.js';

/* Functions called by inline on…="…" handlers, in index.html and in the HTML the
 * modules render. Module code is not global, so these are the only names put on
 * window; tests/test_smoke.js fails if a handler names one that is missing. */
Object.assign(window, {
  addDbdTask, addTask, changeTimerColor, changeTodoColor, commitEditTimer, digestAddAllTasks,
  digestAddTask, digestDismissTask, digestLoadSample, digestRunDismiss, digestRunNow,
  digestToggleCollapsed, gcalToggleCal, homeInsightGo, openBudgetTab, openScheduleModal,
  openSettings, openTaskLinkModal, refreshSyncBadges, removeDbdTask, removeFormatDaily,
  removeFormatTimer, removeTask, removeTodoList, resetTimer, retagListTask, setDbdDue,
  setDbdText, setListTaskDue, setListTitle, setTaskText, setTimerLabel, startEditTimer,
  tagDbdTask, taskLinkFlushRename, taskLinkOpenEvent, toggleDbdTask, toggleStarList, toggleTask,
  toggleTimer,
});

/* ───────────────────────── INIT ───────────────────────── */
(function init() {
  const firstRun = !loadFromLocal();
  if (firstRun) applyStarterProfile();   // seed a starter day on a fresh device
  applyTheme();
  calLoad();
  calLoadHiddenColors();
  calPruneDays();

  bindStatic();
  initSwipe();
  initViewportGuard();

  renderTimers();
  renderTodos();
  homeToggleDesktop(true);   // desktop lands on Home; toggle back via nav
  setDbdDayKey(dbdTodayKey());
  ['d','m'].forEach(pfx => { const el = $(`dbdDate-${pfx}`); if (el && !el.value) el.value = _dbdDayKey; });
  renderDbd();
  budgetRollover();          // catch up any days missed while closed
  renderBudget();
  renderHome();
  applyViewVisibility();
  syncWakeupUI();
  setSwipePanelWidths();
  updateTimerSummary();
  tickAll();
  calRenderMobile();
  calTickNow();
  budgetTickDay();

  /* Everything above was load + normalisation + rollovers, not user
   * edits: take it as the sync baseline so the first autosave (or a
   * rollover) can't masquerade as "fresh local edits" and win a
   * reconcile against a newer cloud copy. */
  setSyncLastSeenFp(syncFingerprint(gatherState()));
  setSyncBooting(false);

  /* autosave */
  setInterval(saveToLocal, 2000);
  /* day-by-day midnight rollover (also fires after device sleep) */
  setInterval(dbdCheckRollover, 30 * 1000);
  /* home page: keep the 4-hour calendar window and date current */
  setInterval(renderHome, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') dbdCheckRollover();
    if (document.visibilityState === 'hidden') saveToLocal();
  });
  window.addEventListener('pagehide', saveToLocal);

  /* cloud sync */
  syncInit();
  syncHandleRedirect();

  /* email digest — built on GitHub, delivered through Firebase; see digest.js */
  digestUiLoad();
  digestRunLoad();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && digestRunActive()) digestRunPoll(); });

  /* gcal */
  gcalLoadToken();
  gcalLoadCals();
  gcalHandleRedirect();
  gcalUpdateBtn();
  if (gcalIsConnected()) gcalSyncAll();
  setInterval(() => { if (gcalIsConnected()) gcalSyncAll(); }, 5 * 60 * 1000);

  /* bank accounts: saved connections, and a connection an OAuth bank sent back mid-way */
  bankInit();

  /* onboarding: welcome + guided tour on a fresh device */
  if (firstRun) tourOffer();
})();
