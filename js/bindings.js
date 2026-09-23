/* bindings.js — Wires the static controls in index.html to their handlers, once at
 * startup. */
import { $, closeModal } from './util.js';
import { toggleWakeup } from './timers.js';
import { addTodoList, saveSchedule, scheduleEveryDay } from './lists.js';
import { addFormatDaily, addFormatTimer, toggleFormatMode } from './formats.js';
import { openFormatTemplates } from './templates.js';
import { addDbdTask } from './dbd.js';
import { closeTaskLinkModal, taskLinkApplySelectToTitle, taskLinkCreate } from './tasklinks.js';
import {
  confirmClearStorage, exportCopy, exportDownload, importFromText, loadStateFile,
  openExportModal, openImportModal, resetAll,
} from './io.js';
import { homeToggleDesktop } from './home.js';
import { goTab, setSwipePanelWidths, showDesktopDaily, showDesktopLists } from './views.js';
import { openSettings, settingsBack, settingsShow, setViewEnabled } from './settings.js';
import {
  calNavDay, calSendToGcal, calToggleDesktop, calToggleWeekMode, closeCalModal, deleteCalEvent,
  saveCalEvent, setCalEventType,
} from './calendar.js';
import { gcalDeleteFromDetail, gcalDisconnect, gcalSyncAll, gcalSyncToApp } from './gcal.js';
import { budgetToggleDesktop } from './budget.js';
import { syncBtnClick, syncChooseExport, syncChooseImport } from './sync.js';
import { bindTheme } from './theme.js';
import { bindDigest } from './digest.js';
import { bindTour } from './onboarding.js';

/* ───────────────────────── STATIC BINDINGS ───────────────────────── */
export function bindStatic() {
  bindTheme();
  bindTour();
  bindDigest();
  /* wakeup */
  $('wakeupRow-d')?.addEventListener('click', toggleWakeup);
  $('wakeupRow-m')?.addEventListener('click', toggleWakeup);

  /* calendar nav */
  $('calDesktopNavTab')?.addEventListener('click', calToggleDesktop);
  $('homeDesktopNavTab')?.addEventListener('click', () => homeToggleDesktop(true));
  $('listsDesktopNavTab')?.addEventListener('click', showDesktopLists);
  $('dailyDesktopNavTab')?.addEventListener('click', showDesktopDaily);
  $('settingsBtn')?.addEventListener('click', openSettings);
  $('settingsNav')?.addEventListener('click', e => {
    const b = e.target.closest('[data-settings-nav]');
    if (b) settingsShow(b.dataset.settingsNav, 'detail');
  });
  $('settingsBackBtn')?.addEventListener('click', settingsBack);
  $('settingsViewList')?.addEventListener('change', e => {
    const key = e.target?.dataset?.viewtoggle;
    if (key) setViewEnabled(key, e.target.checked);
  });
  $('budgetDesktopNavTab')?.addEventListener('click', () => budgetToggleDesktop());
  $('calWeekModeBtn')?.addEventListener('click', e => { e.stopPropagation(); calToggleWeekMode(); });
  $('calNavPrev')?.addEventListener('click', () => calNavDay(-1));
  $('calNavNext')?.addEventListener('click', () => calNavDay(1));

  /* tabs */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => goTab(btn.dataset.view, true));
  });

  /* add buttons */
  $('addTimerBtn-d')?.addEventListener('click', addFormatTimer);
  $('addTimerBtn-m')?.addEventListener('click', addFormatTimer);
  $('addDailyBtn')?.addEventListener('click', addFormatDaily);
  $('addDailyBtn-m')?.addEventListener('click', addFormatDaily);
  $('dbdAddBtn-d')?.addEventListener('click', () => addDbdTask('d'));
  $('dbdAddBtn-m')?.addEventListener('click', () => addDbdTask('m'));
  $('addListBtn-d')?.addEventListener('click', addTodoList);
  $('addListBtn-m')?.addEventListener('click', addTodoList);

  /* data bar — on phones Export / Import / Reset live behind the ⋯ button */
  const dataBar = $('dataBar'), moreBtn = $('moreBtn');
  const setMore = open => {
    if (!dataBar) return;
    dataBar.classList.toggle('open', open);
    if (moreBtn) moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  moreBtn?.addEventListener('click', e => { e.stopPropagation(); setMore(!dataBar.classList.contains('open')); });
  document.addEventListener('click', e => {
    if (dataBar?.classList.contains('open') && !e.target.closest('#dataMore')) setMore(false);
  });
  $('dataMore')?.addEventListener('click', e => { if (e.target.closest('button')) setMore(false); });
  $('fmtBtn')?.addEventListener('click', toggleFormatMode);
  $('fmtTplBtn')?.addEventListener('click', openFormatTemplates);
  $('exportBtn')?.addEventListener('click', openExportModal);
  $('importBtn')?.addEventListener('click', openImportModal);
  $('resetAllBtn')?.addEventListener('click', () => $('confirmOverlay').classList.add('show'));
  $('clearStorageBtn')?.addEventListener('click', confirmClearStorage);
  $('syncConnectBtn')?.addEventListener('click', syncBtnClick);
  $('syncImportBtn')?.addEventListener('click', syncChooseImport);
  $('syncExportBtn')?.addEventListener('click', syncChooseExport);

  /* confirm */
  $('confirmCancelBtn')?.addEventListener('click', () => closeModal('confirmOverlay'));
  $('confirmResetBtn')?.addEventListener('click', resetAll);

  /* schedule */
  $('scheduleCancelBtn')?.addEventListener('click', () => closeModal('scheduleModal'));
  $('scheduleSaveBtn')?.addEventListener('click', saveSchedule);
  $('scheduleEveryDayBtn')?.addEventListener('click', scheduleEveryDay);

  /* export / import */
  $('exportCopyBtn')?.addEventListener('click', exportCopy);
  $('exportDownloadBtn')?.addEventListener('click', exportDownload);
  $('importTextBtn')?.addEventListener('click', importFromText);
  $('importFileBtn')?.addEventListener('click', () => $('fileInput').click());
  $('fileInput')?.addEventListener('change', e => loadStateFile(e.target));

  /* event modal */
  $('calModalCancel')?.addEventListener('click', closeCalModal);
  $('calEventSaveBtn')?.addEventListener('click', saveCalEvent);
  $('calEventDeleteBtn')?.addEventListener('click', deleteCalEvent);
  $('calSendToGcalBtn')?.addEventListener('click', calSendToGcal);
  $('calTypeEvent')?.addEventListener('click', () => setCalEventType('event'));
  $('calTypeDivider')?.addEventListener('click', () => setCalEventType('divider'));
  $('calLinkSelect')?.addEventListener('change', taskLinkApplySelectToTitle);

  /* task ↔ calendar link modal */
  $('taskLinkCancelBtn')?.addEventListener('click', closeTaskLinkModal);
  $('taskLinkCreateBtn')?.addEventListener('click', taskLinkCreate);

  /* gcal modals */
  $('gcalDisconnectBtn')?.addEventListener('click', gcalDisconnect);
  $('gcalSyncBtn')?.addEventListener('click', gcalSyncAll);
  $('gcalDetailDeleteBtn')?.addEventListener('click', gcalDeleteFromDetail);
  $('gcalSyncToAppBtn')?.addEventListener('click', gcalSyncToApp);

  /* modal-x close buttons */
  document.querySelectorAll('.modal-x[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  /* closing the event and link modals also drops their edit state */
  const closeOverlay = ov => {
    if (ov.id === 'calEventModal') closeCalModal();
    else if (ov.id === 'taskLinkModal') closeTaskLinkModal();
    else ov.classList.remove('show');
  };
  /* backdrop click closes any modal */
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) closeOverlay(ov); });
  });
  /* Escape closes the topmost open modal */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('.modal-overlay.show')).pop();
    if (open) closeOverlay(open);
  });

  /* resize */
  let _rt;
  window.addEventListener('resize', () => {
    clearTimeout(_rt);
    _rt = setTimeout(setSwipePanelWidths, 80);
  });
}
