/* persistence.js — Saving and loading: the state record, its compressed Export form,
 * localStorage. */
import { LS_KEY } from './config.js';
import { cloneTask, getRemaining, showToast } from './util.js';
import {
  normalizeTimerLog, renderTimers, setTimerDefaults, setTimerLog, setTimers, setWokenUp,
  syncWakeupUI, TIMER_DEFAULTS, timerLog, timers, updateTimerSummary, wokenUp,
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
  budget, budgetRollover, normalizeBudget, normalizeRunway, purchaseIdCounter, renderBudget,
  runway, setBudget, setPurchaseIdCounter, setRunway,
} from './budget.js';
import { syncOnLocalSave } from './sync.js';
import {
  applyTheme, compressTheme, decompressTheme, normalizeTheme, renderThemeUI, setTheme, themeGet,
} from './theme.js';
import {
  compressDigest, decompressDigest, digestRecord, normalizeDigest, setDigest,
} from './digest.js';
import { normalizeShiftCals, setShiftCals, shiftCals } from './gcal.js';

/* ───────────────────────── PERSISTENCE ───────────────────────── */
/*
 * v2 export uses short key aliases (≈70% smaller than v1).
 * Key map: version→v wokenUp→wu timerDefaults→td timers→tm
 *   todoIdCounter→tic taskIdCounter→tac todoLists→tl theme→th
 *   calendar→cal calEvents→ce calTemplates→ct calEventIdCtr→cec
 *   timer: id→i label→lb color→c seconds→s running→r startedAt→sa secondsAtStart→ss
 *     over→ov   (seconds past zero, see timers.js)
 *   list:  id→i title→ti color→c isDefault→d starred→sr tasks→tk
 *   task:  id→i text→tx done→dn due→du doneOn→dw
 *   dbdTask: id→i text→tx due→du done→dn doneOn→dw
 *   calEvent: id→i title→ti start→s end→e color→c type→tp
 *     fromTemplate→ft templateId→tid repeatDays→rd gcalId→gi gcalCalId→gc
 *     linkTaskId→tk linkDbdId→dk   (task ↔ event link, see tasklinks.js)
 *     shift→sh wage→wg             (paid shift and its hourly wage, see shifts.js)
 *   shiftCals→sc  { calId: { shift, wage } } per Google calendar (see gcal.js)
 *   runway→rw {p: payday, r: repeat, b: bills [{i: id, n: name, a: amount, d: day}]} (see budget.js)
 *   timerLog→tg { day: { key: [label, over, budget] } } (see timers.js)
 *   digest: enabled→en last→l {at, md, n, m, s} clearedAt→ca   (see digest.js)
 */
export function compressState(st) {
  const cTimer = t => {
    const o = { i:t.id, lb:t.label, c:t.color, s:t.seconds };
    if (t.running) { o.r=1; o.sa=t.startedAt; o.ss=t.secondsAtStart; }
    if (t.over) o.ov = t.over;
    return o;
  };
  const cDef  = t => ({ lb:t.label, c:t.color, s:t.seconds });
  const cTask = t => { const o = { i:t.id, tx:t.text }; if (t.done) o.dn=1; if (t.due) o.du=t.due; if (t.doneOn) o.dw=t.doneOn; return o; };
  const cBudget = b => {
    const o = { ib: b.initial || 0, dy: b.daily || 0 };
    if (b.todayAllowance !== null && b.todayAllowance !== undefined) o.ta = b.todayAllowance;
    if (b.lastDate) o.ld = b.lastDate;
    if (b.purchases && b.purchases.length) {
      o.p = b.purchases.map(p => ({ i: p.id, t: p.title, a: p.amount }));
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
    ...(st.timerLog && Object.keys(st.timerLog).length
      ? { tg: Object.fromEntries(Object.entries(st.timerLog).map(([day, e]) =>
          [day, Object.fromEntries(Object.entries(e).map(([k, r]) => [k, [r.label, r.over, r.budget]]))])) }
      : {}),
    cal: { ce: cEvents, ct: (st.calendar.calTemplates||[]).map(cCalEv), cec: st.calendar.calEventIdCtr },
  };
}

function decompressState(c) {
  if (c.version === 1) return c;          // v1 passthrough
  if (c.v !== 2) return null;
  const dTimer = t => ({ id:t.i, label:t.lb, color:t.c, seconds:t.s,
    running:!!t.r, startedAt:t.sa ?? null, secondsAtStart:t.ss ?? null, ...(t.ov ? { over: t.ov } : {}) });
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
    purchases: (b?.p || []).map(p => ({ id: p.i, title: p.t, amount: p.a })),
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
    timerLog: normalizeTimerLog(c.tg ? Object.fromEntries(Object.entries(c.tg).map(([day, e]) =>
      [day, Object.fromEntries(Object.entries(e).map(([k, r]) => [k, { label: r[0], over: r[1], budget: r[2] }]))])) : null),
    runway: normalizeRunway(c.rw ? { payday: c.rw.p, repeat: c.rw.r, bills: (c.rw.b || []).map(b => ({ id: b.i, name: b.n, amount: b.a, day: b.d })) } : null),
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
    ...(src.over > 0 ? { over: Math.round(src.over) } : {}),   // past zero before this run
  };
}

/* Build number of the state schema. Bumped whenever gatherState() learns a
 * new top-level key (digest was build 2, digest tasks build 3, shiftCals
 * build 4, runway build 5, timerLog build 6). Lets a newer device recognise
 * a cloud copy written by an older build, which cannot have carried the
 * newer fields. */
export const STATE_BUILD = 6;
const STATE_KNOWN_KEYS = new Set(['version', 'build', 'wokenUp', 'timerDefaults', 'timers', 'todoIdCounter',
  'taskIdCounter', 'todoLists', 'dbdTasks', 'dbdIdCounter', 'budget', 'purchaseIdCounter', 'views', 'theme',
  'digest', 'shiftCals', 'runway', 'timerLog', 'calendar']);
/* Top-level keys this build does not understand, carried through untouched so
 * an older device never strips what a newer one wrote (see syncApplyRemote). */
let stateExtra = {};
function stateCaptureExtra(state) {
  stateExtra = {};
  if (!state || typeof state !== 'object') return;
  Object.keys(state).forEach(k => { if (!STATE_KNOWN_KEYS.has(k)) stateExtra[k] = state[k]; });
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
      purchases: budget.purchases.map(p => ({ id: p.id, title: p.title, amount: p.amount })),
    },
    purchaseIdCounter,
    views: { ...views },
    theme: { ...themeGet() },
    digest: digestRecord(),
    shiftCals: normalizeShiftCals(shiftCals),
    runway: normalizeRunway(runway),
    timerLog: normalizeTimerLog(timerLog),
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
    ...(t.over > 0 ? { over: t.over } : {}),
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
  setShiftCals(normalizeShiftCals(st.shiftCals));
  setRunway(normalizeRunway(st.runway));
  setTimerLog(normalizeTimerLog(st.timerLog));
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

export function saveToLocal() {
  try {
    const state = gatherState();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    syncOnLocalSave(state);
  } catch(e) {}
}
export function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state || state.version !== 1) return false;
    hydrateState(state);
    return true;
  } catch(e) {
    try { localStorage.removeItem(LS_KEY); } catch(_) {}
    return false;
  }
}
