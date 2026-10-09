/* persistence.js — Saving and loading: the state record, its compressed Export form,
 * localStorage. */
import { LS_KEY, SYNC_BASE_LS_KEY } from './config.js';
import { cloneTask, getRemaining, keepField, showToast } from './util.js';
import {
  renderTimers, setTimerDefaults, setTimers, setWokenUp, syncWakeupUI, TIMER_DEFAULTS, timers,
  updateTimerSummary, wokenUp,
} from './timers.js';
import {
  renderTodos, setTaskIdCounter, setTodoIdCounter, setTodoLists, taskIdCounter, todoIdCounter,
  todoLists,
} from './lists.js';
import { formatMode, preFormatTimerState } from './formats.js';
import { dbdIdCounter, dbdTasks, renderDbd, setDbdIdCounter, setDbdTasks } from './dbd.js';
import { renderHome } from './home.js';
import { applyViewVisibility, normalizeViews, setViews, views, viewsOffList } from './views.js';
import {
  calEventIdCtr, calEvents, calPruneDays, calRefresh, calSave, calTemplates, setCalEventIdCtr,
  setCalEvents, setCalTemplates,
} from './calendar.js';
import {
  bankBudget, bankCards, budget, budgetRollover, normalizeBankBudget, normalizeBankCards, normalizeBudget, normalizeRunway,
  purchaseIdCounter, purchaseRecord, renderBudget, runway, setBankBudget, setBankCards, setBudget, setPurchaseIdCounter, setRunway,
} from './budget.js';
import { syncFingerprint, syncOnLocalSave } from './sync.js';
import { syncMerge, syncRecordsIn } from './syncmerge.js';
import {
  applyTheme, compressTheme, decompressTheme, normalizeTheme, renderThemeUI, setTheme, themeGet,
} from './theme.js';
import {
  compressDigest, decompressDigest, digestFromOldSwitch, digestRecord, normalizeDigest, renderDigest, setDigest,
} from './digest.js';
import { normalizeShiftCals, setShiftCals, shiftCals } from './gcal.js';

/* ───────────────────────── PERSISTENCE ───────────────────────── */
/*
 * v2 export uses short key aliases (≈70% smaller than v1).
 * Key map: version→v wokenUp→wu timerDefaults→td timers→tm
 *   todoIdCounter→tic taskIdCounter→tac todoLists→tl theme→th
 *   calendar→cal calEvents→ce calTemplates→ct calEventIdCtr→cec
 *   timer: id→i label→lb color→c seconds→s running→r startedAt→sa secondsAtStart→ss
 *   list:  id→i title→ti color→c isDefault→d starred→sr tasks→tk
 *   task:  id→i text→tx done→dn due→du doneOn→dw
 *   dbdTask: id→i text→tx due→du done→dn doneOn→dw
 *   calEvent: id→i title→ti start→s end→e color→c type→tp
 *     fromTemplate→ft templateId→tid repeatDays→rd gcalId→gi gcalCalId→gc
 *     linkTaskId→tk linkDbdId→dk   (task ↔ event link, see tasklinks.js)
 *     shift→sh wage→wg             (paid shift and its hourly wage, see shifts.js)
 *   shiftCals→sc  { calId: { shift, wage } } per Google calendar (see gcal.js)
 *   runway→rw {p: payday, r: repeat, b: bills [{i: id, n: name, a: amount, d: day}]} (see budget.js)
 *   purchase: id→i title→t amount→a bank→b pending→pd on→o   (a purchase logged from the bank)
 *   bankBudget→bb {o: on (0 = off), i: items, l: log, a: anchor {d: day, k: key, s: start}, t: typed}    (Budget following the bank, see budget.js)
 *   bankCards→bk  (each credit card's balance as Budget last saw it, see budget.js)
 *   digest: enabled→en last→l {at, md, n, m, s} clearedAt→ca   (see digest.js)
 */
export function compressState(st) {
  const cTimer = t => {
    const o = { i:t.id, lb:t.label, c:t.color, s:t.seconds };
    if (t.running) { o.r=1; o.sa=t.startedAt; o.ss=t.secondsAtStart; }
    return o;
  };
  const cDef  = t => ({ lb:t.label, c:t.color, s:t.seconds });
  const cTask = t => { const o = { i:t.id, tx:t.text }; if (t.done) o.dn=1; if (t.due) o.du=t.due; if (t.doneOn) o.dw=t.doneOn; return o; };
  const cBudget = b => {
    const o = { ib: b.initial || 0, dy: b.daily || 0 };
    if (b.todayAllowance !== null && b.todayAllowance !== undefined) o.ta = b.todayAllowance;
    if (b.lastDate) o.ld = b.lastDate;
    if (b.purchases && b.purchases.length) {
      o.p = b.purchases.map(p => ({ i: p.id, t: p.title, a: p.amount, ...(p.bank ? { b: p.bank } : {}), ...(p.pending ? { pd: 1 } : {}), ...(p.on ? { o: p.on } : {}) }));
    }
    return o;
  };
  const cList = l => {
    const o = { i:l.id, ti:l.title, c:l.color, d:l.isDefault?1:0, tk:l.tasks.map(cTask) };
    if (Array.isArray(l.activeDays)) o.ad = l.activeDays;   // [] (hidden) must survive
    if (l.starred) o.sr = 1;
    return o;
  };
  const cCalEv = e => {
    const o = { i:e.id, ti:e.title, s:e.start, e:e.end, c:e.color };
    if (e.type && e.type !== 'event') o.tp = e.type;
    if (e.fromTemplate) o.ft = 1;
    if (e.templateId != null) o.tid = e.templateId;
    if (e.repeatDays) o.rd = e.repeatDays;
    if (e.gcalId)    o.gi = e.gcalId;
    if (e.gcalCalId) o.gc = e.gcalCalId;
    if (e.linkTaskId != null) o.tk = e.linkTaskId;
    if (e.linkDbdId  != null) o.dk = e.linkDbdId;
    if (typeof e.shift === 'boolean') o.sh = e.shift ? 1 : 0;
    if (e.wage != null) o.wg = e.wage;
    return o;
  };
  const cDbd = t => { const o = { i:t.id, tx:t.text, du:t.due }; if (t.done) o.dn=1; if (t.doneOn) o.dw=t.doneOn; return o; };
  const cEvents = {};
  Object.entries(st.calendar.calEvents || {}).forEach(([k, evs]) => { cEvents[k] = evs.map(cCalEv); });
  return {
    v: 2,
    wu: st.wokenUp ? 1 : 0,
    td: st.timerDefaults.map(cDef),
    tm: st.timers.map(cTimer),
    tic: st.todoIdCounter,
    tac: st.taskIdCounter,
    tl: st.todoLists.map(cList),
    db: (st.dbdTasks||[]).map(cDbd),
    dbc: st.dbdIdCounter || 1,
    bg: cBudget(st.budget),
    bgc: st.purchaseIdCounter || 1,
    vw: viewsOffList(st.views),
    th: compressTheme(st.theme),
    dg: compressDigest(st.digest),
    ...(st.shiftCals && Object.keys(st.shiftCals).length ? { sc: st.shiftCals } : {}),
    ...(st.runway && (st.runway.payday || st.runway.bills.length)
      ? { rw: { p: st.runway.payday, r: st.runway.repeat, b: st.runway.bills.map(b => ({ i: b.id, n: b.name, a: b.amount, d: b.day })) } }
      : {}),
    ...(st.bankBudget && (!st.bankBudget.on || Object.keys(st.bankBudget.items).length || st.bankBudget.log.length || st.bankBudget.anchor)
      ? { bb: { o: st.bankBudget.on ? 1 : 0, i: st.bankBudget.items, l: st.bankBudget.log,
        ...(st.bankBudget.anchor ? { a: { d: st.bankBudget.anchor.day, k: st.bankBudget.anchor.key, s: st.bankBudget.anchor.start } } : {}),
        ...(st.bankBudget.typed && st.bankBudget.typed.length ? { t: st.bankBudget.typed } : {}) } }
      : {}),
    ...(st.bankCards && Object.keys(st.bankCards).length ? { bk: st.bankCards } : {}),
    cal: { ce: cEvents, ct: (st.calendar.calTemplates||[]).map(cCalEv), cec: st.calendar.calEventIdCtr },
  };
}

function decompressState(c) {
  if (c.version === 1) return c;          // v1 passthrough
  if (c.v !== 2) return null;
  const dTimer = t => ({ id:t.i, label:t.lb, color:t.c, seconds:t.s,
    running:!!t.r, startedAt:t.sa ?? null, secondsAtStart:t.ss ?? null });
  const dDef  = t => ({ label:t.lb, color:t.c, seconds:t.s });
  const dTask = t => { const o = { id:t.i, text:t.tx, done:!!t.dn }; if (t.du) o.due = t.du; if (t.dw) o.doneOn = t.dw; return o; };
  const dList = l => ({ id:l.i, title:l.ti, color:l.c, isDefault:!!l.d, starred:!!l.sr, activeDays: Array.isArray(l.ad) ? l.ad : null, tasks:(l.tk||[]).map(dTask) });
  const dCalEv = e => ({
    id:e.i, title:e.ti, start:e.s, end:e.e, color:e.c,
    type:e.tp || 'event', fromTemplate:!!e.ft,
    templateId:e.tid ?? null, repeatDays:e.rd || null,
    gcalId:e.gi ?? null, gcalCalId:e.gc ?? null,
    ...(e.tk != null ? { linkTaskId: e.tk } : {}),
    ...(e.dk != null ? { linkDbdId: e.dk } : {}),
    ...(e.sh != null ? { shift: !!e.sh } : {}),
    ...(e.wg != null ? { wage: e.wg } : {}),
  });
  const dDbd = t => ({ id:t.i, text:t.tx, due:t.du, done:!!t.dn, doneOn:t.dw });
  // Missing bg (data saved before the Budget feature) loads as a clean zero budget.
  const dBudget = b => ({
    initial: b?.ib || 0,
    daily:   b?.dy || 0,
    todayAllowance: (b && b.ta !== undefined) ? b.ta : null,
    purchases: (b?.p || []).map(p => ({ id: p.i, title: p.t, amount: p.a, ...(p.b ? { bank: p.b } : {}), ...(p.pd ? { pending: true } : {}), ...(p.o ? { on: p.o } : {}) })),
    lastDate: b?.ld || null,
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
    dbdTasks: (c.db||[]).map(dDbd),
    dbdIdCounter: c.dbc || 1,
    budget: dBudget(c.bg),
    purchaseIdCounter: c.bgc || 1,
    views: normalizeViews(c.vw),
    theme: decompressTheme(c.th),
    digest: decompressDigest(c.dg),
    shiftCals: normalizeShiftCals(c.sc),
    runway: normalizeRunway(c.rw ? { payday: c.rw.p, repeat: c.rw.r, bills: (c.rw.b || []).map(b => ({ id: b.i, name: b.n, amount: b.a, day: b.d })) } : null),
    bankBudget: normalizeBankBudget(c.bb ? { on: c.bb.o !== 0, items: c.bb.i, log: c.bb.l, anchor: c.bb.a ? { day: c.bb.a.d, key: c.bb.a.k, start: c.bb.a.s } : null, typed: c.bb.t } : null),
    bankCards: normalizeBankCards(c.bk),
    calendar: { calEvents: dEvents, calTemplates: (c.cal.ct||[]).map(dCalEv), calEventIdCtr: c.cal.cec || 1 },
  };
}

/* Serializable live record of a timer. While Formats is open the timer
 * slots temporarily display the TEMPLATE seconds (so they can be edited
 * in place) and the real progress lives in preFormatTimerState — read
 * from there so the template values never leak into saved/synced state
 * as if they were live times. Timers added during Formats have no
 * snapshot and simply serialize as-is (paused at their default). */
function liveTimerRecord(t) {
  const pre = formatMode ? preFormatTimerState.find(p => p.id === t.id) : null;
  const src = pre || t;
  return {
    id: t.id, label: t.label, color: t.color,
    seconds: Math.round(getRemaining(src)),
    running: !!src.running,
    startedAt: src.running ? src.startedAt : null,
    secondsAtStart: src.running ? src.secondsAtStart : null,
  };
}

/* Build number of the state schema. Bumped whenever gatherState() learns a
 * new top-level key (digest was build 2, digest tasks build 3, shiftCals
 * build 4, runway build 5, timerLog build 6, bankBudget build 7), or a new
 * build writes the cloud differently (build 8 stamps revisions, syncRev and
 * syncBase, see sync.js). Lets a newer device recognise a cloud copy written
 * by an older build, which cannot have carried the newer fields; build 9
 * numbers the revisions (syncSeq) and saves where this device's copy stands
 * (syncLocal). timerLog (days a timer ran past zero) went away again when
 * timers went back to stopping at zero; a copy from a build-6 device is not
 * in the known keys below, so it passes through untouched instead of being
 * stripped and written back. Build 10 follows credit cards by their balance
 * (bankCards); a device on an older build counts card charges differently, so
 * a copy from one makes the others say so (sync.js → syncOlderDevice). Build 11
 * keeps each card's pending payments until its balance shows them (bankCards
 * → u), which a build-10 copy drops. */
export const STATE_BUILD = 11;
const STATE_KNOWN_KEYS = new Set(['version', 'build', 'wokenUp', 'timerDefaults', 'timers', 'todoIdCounter',
  'taskIdCounter', 'todoLists', 'dbdTasks', 'dbdIdCounter', 'budget', 'purchaseIdCounter', 'views', 'theme',
  'digest', 'shiftCals', 'runway', 'bankBudget', 'bankCards', 'calendar']);
/* Top-level keys this build does not understand, carried through untouched so
 * an older device never strips what a newer one wrote (see syncApplyRemote). */
let stateExtra = {};
function stateCaptureExtra(state) {
  stateExtra = {};
  if (!state || typeof state !== 'object') return;
  Object.keys(state).forEach(k => { if (!STATE_KNOWN_KEYS.has(k)) stateExtra[k] = state[k]; });
}
/* Which copy agreed with the cloud this device's copy is built on (sync.js),
 * saved with it: { rev, hash, seq, at (when it was agreed on) }, and the revisions that copy comes after
 * (syncLog). */
export function setStateMark(mark, log) {
  stateExtra.syncLocal = mark;
  if (Array.isArray(log)) stateExtra.syncLog = log;
}

export function gatherState() {
  return {
    ...stateExtra,
    version: 1,
    build: STATE_BUILD,
    wokenUp,
    timerDefaults: TIMER_DEFAULTS,
    timers: timers.map(liveTimerRecord),
    todoIdCounter,
    taskIdCounter,
    todoLists: todoLists.map(l => ({
      id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
      starred: !!l.starred,
      activeDays: Array.isArray(l.activeDays) ? l.activeDays : null,
      tasks: l.tasks.map(cloneTask)
    })),
    dbdTasks: dbdTasks.map(t => ({ id: t.id, text: t.text, due: t.due, done: t.done, doneOn: t.doneOn })),
    dbdIdCounter,
    budget: {
      initial: budget.initial,
      daily: budget.daily,
      todayAllowance: budget.todayAllowance,
      lastDate: budget.lastDate,
      purchases: budget.purchases.map(purchaseRecord),
    },
    purchaseIdCounter,
    views: { ...views },
    theme: { ...themeGet() },
    digest: digestRecord(),
    shiftCals: normalizeShiftCals(shiftCals),
    runway: normalizeRunway(runway),
    bankBudget: { on: bankBudget.on, items: bankBudget.items, log: bankBudget.log, ...(bankBudget.anchor ? { anchor: bankBudget.anchor } : {}),
      ...(bankBudget.typed.length ? { typed: bankBudget.typed } : {}) },
    ...(Object.keys(bankCards).length ? { bankCards } : {}),
    calendar: { calEvents, calTemplates, calEventIdCtr },
  };
}

/* Copy a v1 state record into the live variables. No rendering: shared by
 * the localStorage load (which every cloud apply goes through) and Import. */
function hydrateState(st) {
  stateCaptureExtra(st);
  setWokenUp(!!st.wokenUp);
  if (st.timerDefaults) setTimerDefaults(st.timerDefaults);
  setTimers(st.timers.map(t => ({
    id: t.id, label: t.label, color: t.color,
    seconds: t.seconds, running: t.running,
    startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
  })));
  setTodoIdCounter(st.todoIdCounter ?? todoIdCounter);
  setTaskIdCounter(st.taskIdCounter ?? taskIdCounter);
  setTodoLists(st.todoLists.map(l => ({
    id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
    starred: !!l.starred,
    activeDays: Array.isArray(l.activeDays) ? l.activeDays : null,
    tasks: l.tasks.map(cloneTask)
  })));
  setDbdTasks((st.dbdTasks || []).map(t => ({ id: t.id, text: t.text, due: t.due, done: !!t.done, doneOn: t.doneOn })));
  setDbdIdCounter(st.dbdIdCounter ?? dbdIdCounter);
  setBudget(normalizeBudget(st.budget));
  setPurchaseIdCounter(st.purchaseIdCounter ?? purchaseIdCounter);
  setViews(normalizeViews(st.views));
  setTheme(normalizeTheme(st.theme));
  setDigest(normalizeDigest(st.digest));
  digestFromOldSwitch();                          // a copy from before Sections only picked the bar
  setShiftCals(normalizeShiftCals(st.shiftCals));
  setRunway(normalizeRunway(st.runway));
  setBankBudget(normalizeBankBudget(st.bankBudget));
  setBankCards(normalizeBankCards(st.bankCards));
  if (st.calendar) {
    setCalEvents(st.calendar.calEvents     || {});
    setCalTemplates(st.calendar.calTemplates  || []);
    setCalEventIdCtr(st.calendar.calEventIdCtr || 1);
  }
}

/* After a whole state was swapped in (Import, or a copy from the cloud):
 * settle it for today (calendar window, budget day) and redraw everything. */
export function renderLoadedState() {
  calSave();
  calPruneDays();
  budgetRollover();
  syncWakeupUI();
  renderTimers();
  renderTodos();
  renderDbd();
  renderBudget();
  renderDigest();
  applyViewVisibility();
  applyTheme();
  renderThemeUI();
  calRefresh();
  renderHome();
  updateTimerSummary();
}

export function applyState(state) {
  const st = decompressState(state);
  if (!st || st.version !== 1) { showToast('Invalid or unsupported file.'); return; }
  hydrateState(st);
  renderLoadedState();
  saveToLocal();
  showToast('State restored ✓');
}

/* Put an earlier copy back (Settings → Cloud sync → Earlier copies), as an edit
 * on top of what this device has: it keeps saying which agreed copy it is built
 * on, so sync sends it to the other devices like any change. */
export function restoreState(st) {
  if (!st || st.version !== 1) return false;
  const mark = stateExtra.syncLocal;
  hydrateState(st);
  if (mark) stateExtra.syncLocal = mark; else delete stateExtra.syncLocal;
  renderLoadedState();
  saveToLocal();
  return true;
}

/* Save the state, and hand it to sync. When the device's storage is full, the
 * copy the last merge started from goes (sync keeps it among its copies too) to
 * make room; if it still doesn't fit, the change goes to the cloud all the same,
 * and Focus says so once.
 * Another tab of Focus in the same browser saves to the same place. When it has
 * saved since this page did, this page takes its changes in first (just after:
 * stateTakeInOtherTab), instead of writing over them: a change made in one tab
 * while offline isn't lost to the other's saving. */
let saveFullSaid = false;
let stateStored = null;         // the state as this page last wrote or read it
let stateOtherTabTimer = null;
export function saveToLocal() {
  let state;
  try { state = gatherState(); } catch(e) { return; }
  const str = JSON.stringify(state);
  let saved = false, other = false;
  try { other = localStorage.getItem(LS_KEY) !== stateStored; } catch(e) {}
  if (other) {
    if (!stateOtherTabTimer) stateOtherTabTimer = setTimeout(stateTakeInOtherTab, 0);
  } else {
    try { localStorage.setItem(LS_KEY, str); saved = true; } catch(e) {
      try { localStorage.removeItem(SYNC_BASE_LS_KEY); localStorage.setItem(LS_KEY, str); saved = true; } catch(e2) {}
    }
    if (saved) stateStored = str;
  }
  if (!saved && !other && !saveFullSaid) {
    saveFullSaid = true;
    console.warn('[save] storage on this device is full');
    showToast('Storage on this device is full: changes still sync to the cloud. An uploaded background (Settings → Theme) takes the most room.');
  }
  try { syncOnLocalSave(state); } catch(e) {}
}
/* A state record (JSON) into the live variables, without localStorage: a copy
 * from the cloud still loads when this device's storage is full. */
export function loadStateString(str) {
  try {
    const state = JSON.parse(str);
    if (!state || state.version !== 1) return false;
    hydrateState(state);
    return true;
  } catch(e) { return false; }
}
/* What another tab saved, merged into this page's state against what this page
 * last saved (both changed from there), then saved with both. */
function stateTakeInOtherTab() {
  stateOtherTabTimer = null;
  let cur = null;
  try { cur = localStorage.getItem(LS_KEY); } catch(e) { return; }
  if (cur === stateStored) return;
  if (cur === null) { stateStored = null; saveToLocal(); return; }   // (cleared: this page's goes back)
  try {
    const base = stateStored === null ? null : JSON.parse(stateStored), theirs = JSON.parse(cur);
    if (theirs && theirs.version === 1) {
      const local = gatherState();
      /* built on the newer of the two copies agreed with the cloud (what the tab syncing says), even with nothing else new:
       * the one agreed on later (a merged copy keeps the number of the one before it, so the number can be the same) */
      const markOf = st => { const m = st && st.syncLocal; return m ? [Number(m.at) || 0, Number(m.seq) || 0] : [0, 0]; };
      const [ta, ts] = markOf(theirs), [la, ls] = markOf(local);
      const newer = ta > la || (ta === la && ts > ls) ? theirs : local;
      if (!base || syncFingerprint(theirs) !== syncFingerprint(base)) {
        /* (a page that hadn't saved yet takes the other tab's as it is). Of two
         * records the tabs added under one id, the one the cloud has keeps it. */
        let settled = null;
        try { const agreed = JSON.parse(localStorage.getItem(SYNC_BASE_LS_KEY)); if (agreed && typeof agreed.state === 'string') settled = syncRecordsIn(JSON.parse(agreed.state)); } catch(e) {}
        const merged = base ? syncMerge(base, local, theirs, { preferLocal: true, settled }) : theirs;
        hydrateState({ ...merged, syncLocal: newer.syncLocal, syncLog: newer.syncLog });
        keepField(renderLoadedState);
      } else if (newer === theirs) setStateMark(theirs.syncLocal, theirs.syncLog);
    }
  } catch(e) {}
  stateStored = cur;
  saveToLocal();
}
/* Take in now what another tab saved since this page last saved or read it (a
 * tab taking over syncing does, before the cloud's copy: sync.js → syncLead). */
export function takeInOtherTab() {
  let cur = null;
  try { cur = localStorage.getItem(LS_KEY); } catch(e) { return; }
  if (cur === stateStored) return;
  clearTimeout(stateOtherTabTimer);
  stateTakeInOtherTab();
}
/* Save now, with what another tab saved since taken in first, not just after:
 * for a page being hidden or closed (there may be no after: a page closing, or
 * one the browser freezes in the background, runs no more timers), and for a
 * copy from the cloud sync has just agreed on (the copies and records sync
 * keeps are the browser's, so the tab that syncs next goes by them: the state
 * saved has to be built on that copy too). */
export function saveToLocalNow() {
  let cur;
  try { cur = localStorage.getItem(LS_KEY); } catch(e) { saveToLocal(); return; }
  if (cur === stateStored) { saveToLocal(); return; }
  clearTimeout(stateOtherTabTimer);
  stateTakeInOtherTab();                     // (and saves, with both)
}
/* In a browser, another tab's save comes as a storage event: taken in now, not at this page's next save. */
export function watchOtherTabs() {
  window.addEventListener('storage', e => {
    if (e.key === LS_KEY && e.newValue !== null && e.newValue !== stateStored && !stateOtherTabTimer) {
      stateOtherTabTimer = setTimeout(stateTakeInOtherTab, 0);
    }
  });
}

export let bootStateStr = null;   // the copy saved on this device, as Focus opened (sync.js → syncKeepBootCopy)
export function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state || state.version !== 1) return false;
    hydrateState(state);
    bootStateStr = raw;
    stateStored = raw;
    return true;
  } catch(e) {
    try { localStorage.removeItem(LS_KEY); } catch(_) {}
    return false;
  }
}
