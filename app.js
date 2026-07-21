/* ═══════════════════════════════════════════════════════
   FOCUS — app.js
   Sections: CONFIG · STATE · UTIL · PERSISTENCE · TIMERS ·
   WAKEUP · TODOS · DRAG ENGINE · FORMAT MODE · DATA ·
   TABS · CALENDAR · GOOGLE CALENDAR · BINDINGS · INIT
   ═══════════════════════════════════════════════════════ */

/* ───────────────────────── CONFIG ───────────────────────── */
const LS_KEY          = 'focus-app-state';
const CAL_LS_KEY      = 'focus-cal-state';
const GCAL_LS_KEY     = 'focus-gcal-token';
const GCAL_CAL_LS_KEY = 'focus-gcal-calendars';

const CAL_HOUR_PX  = 64;
const CAL_TOTAL_PX = 24 * CAL_HOUR_PX;
const CAL_DOW      = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CAL_COLORS   = ['#378ADD','#EC3636','#8B5CF6','#F97316','#22C55E','#EAB308','#5DCAA5','#D4537E','#505050'];

const GCAL_CLIENT_ID = '855884688171-80lpepboe9q7io8m8lpd3njllnrgvl0d.apps.googleusercontent.com';
const GCAL_SCOPES    = 'https://www.googleapis.com/auth/calendar';
const GCAL_REDIRECT  = 'https://homiejhan.github.io/worky/';

/* ───────────────────────── STATE ───────────────────────── */
let TIMER_DEFAULTS = [
  { label: 'Productivity Timer',   seconds: 5*3600, color: '#378ADD' },
  { label: 'Personal Development', seconds: 3*3600, color: '#EC3636' },
  { label: 'Time with God',        seconds: 2*3600, color: '#8B5CF6' },
  { label: 'Skill Development',    seconds: 1*3600, color: '#F97316' },
];

let formatMode = false;
let formatTimerIdCounter = 900;
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
  { id: todoIdCounter++, title: 'Social Interactions', color: '#EAB308', isDefault: true,
    tasks: makeTasks(['1','2','3','4','5']) },
];

/* day-by-day tasks (dated one-off tasks under My Lists) */
let dbdTasks = [];        // { id, text, due:'YYYY-MM-DD', done }
let dbdIdCounter = 1;

/* calendar state */
let calEvents       = {};   // { 'YYYY-MM-DD': [ev,...] }
let calTemplates    = [];
let calEventIdCtr   = 1;
let calMobileDay    = 0;
let calFmtMobileDay = 0;
let calDesktopOpen  = false;
let calWeekMode     = 'rolling';   // 'rolling' | 'fixed'
let calEditId   = null;
let calEditDate = null;
let calEditDow  = null;
let calEditType = 'event';
let calSelectedColor = CAL_COLORS[0];

/* gcal state */
let gcalToken     = null;
let gcalCalendars = [];
let gcalEvents    = {};
let gcalSyncing   = false;

/* misc */
let currentTab = 0;
let preFormatTimerState = [];

/* ───────────────────────── UTIL ───────────────────────── */
function $(id) { return document.getElementById(id); }

function fmt(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}
function parseTime(str) {
  const p = str.split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*3600 + p[1]*60;
  return NaN;
}
function getRemaining(t) {
  if (t.running) return Math.max(0, t.secondsAtStart - (Date.now() - t.startedAt) / 1000);
  return t.seconds;
}
function playIcon()  { return '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1.2L9 6L1 10.8V1.2Z" fill="currentColor"/></svg>'; }
function pauseIcon() { return '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="1" width="3" height="10" rx="1" fill="currentColor"/><rect x="6" y="1" width="3" height="10" rx="1" fill="currentColor"/></svg>'; }
function resetIcon() { return '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5A4 4 0 1 0 2.9 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M1.5 2V5.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
const GRIP_SVG = '<svg width="10" height="14" viewBox="0 0 10 14" fill="none"><circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="3" cy="11" r="1.2" fill="currentColor"/><circle cx="7" cy="11" r="1.2" fill="currentColor"/></svg>';
const DOTS_SVG = '<svg width="4" height="14" viewBox="0 0 4 14" fill="none"><circle cx="2" cy="2" r="1.5" fill="currentColor"/><circle cx="2" cy="7" r="1.5" fill="currentColor"/><circle cx="2" cy="12" r="1.5" fill="currentColor"/></svg>';
const SYNC_SVG  = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5.8 8.2a2.4 2.4 0 0 1 0-3.4l1.5-1.5a2.4 2.4 0 0 1 3.4 3.4l-.8.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8.2 5.8a2.4 2.4 0 0 1 0 3.4l-1.5 1.5a2.4 2.4 0 0 1-3.4-3.4l.8-.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
// Badge shown on a task that has a linked child list, and on the child list header.
const CHILD_SVG = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="1" y="1.5" width="12" height="3.5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="9" width="12" height="3.5" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M7 5v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
const STAR_SVG  = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1.3l1.75 3.55 3.92.57-2.84 2.77.67 3.9L7 10.25l-3.5 1.84.67-3.9L1.33 5.42l3.92-.57L7 1.3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none" class="star-path"/></svg>';

function escAttr(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let _toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* time helpers (calendar) */
function calToday() { const d = new Date(); d.setHours(0,0,0,0); return d; }
function calDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function calRollingDays() {
  const t = calToday();
  return Array.from({length:7}, (_,i) => { const d = new Date(t); d.setDate(t.getDate()+i); return d; });
}
function calFixedWeekDays() {
  const t = calToday(); const dow = t.getDay();
  return Array.from({length:7}, (_,i) => { const d = new Date(t); d.setDate(t.getDate()-dow+i); return d; });
}
function calDisplayDays() { return calWeekMode === 'fixed' ? calFixedWeekDays() : calRollingDays(); }
function calFmtFull(d)  { return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function calFmtShort(d) { return d.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase(); }
function calTimeToMins(s) { const [h,m] = s.split(':').map(Number); return h*60+m; }
function calMinsToStr(n)  { n = Math.max(0, Math.min(1439, n)); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
function calFmtTime(s) {
  const [h,m] = s.split(':').map(Number);
  const ap = h>=12?'pm':'am'; const h12 = h%12||12;
  return m===0?`${h12}${ap}`:`${h12}:${String(m).padStart(2,'0')}${ap}`;
}
function calMinsToPx(n)  { return (n/60)*CAL_HOUR_PX; }
function calPxToMins(px) { return Math.round((px/CAL_HOUR_PX)*60/15)*15; }

/* ───────────────────────── PERSISTENCE ───────────────────────── */
/*
 * v2 export uses short key aliases (≈70% smaller than v1).
 * Key map: version→v wokenUp→wu timerDefaults→td timers→tm
 *   todoIdCounter→tic taskIdCounter→tac todoLists→tl
 *   calendar→cal calEvents→ce calTemplates→ct calEventIdCtr→cec
 *   timer: id→i label→lb color→c seconds→s running→r startedAt→sa secondsAtStart→ss
 *   list:  id→i title→ti color→c isDefault→d starred→sr tasks→tk
 *   task:  id→i text→tx done→dn
 *   dbdTask: id→i text→tx due→du done→dn doneOn→dw
 *   calEvent: id→i title→ti start→s end→e color→c type→tp
 *     fromTemplate→ft templateId→tid repeatDays→rd gcalId→gi gcalCalId→gc
 */
function compressState(st) {
  const cTimer = t => {
    const o = { i:t.id, lb:t.label, c:t.color, s:t.seconds };
    if (t.running) { o.r=1; o.sa=t.startedAt; o.ss=t.secondsAtStart; }
    return o;
  };
  const cDef  = t => ({ lb:t.label, c:t.color, s:t.seconds });
  const cTask = t => { const o = { i:t.id, tx:t.text }; if (t.done) o.dn=1; return o; };
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
    cal: { ce: cEvents, ct: (st.calendar.calTemplates||[]).map(cCalEv), cec: st.calendar.calEventIdCtr },
  };
}

function decompressState(c) {
  if (c.version === 1) return c;          // v1 passthrough
  if (c.v !== 2) return null;
  const dTimer = t => ({ id:t.i, label:t.lb, color:t.c, seconds:t.s,
    running:!!t.r, startedAt:t.sa ?? null, secondsAtStart:t.ss ?? null });
  const dDef  = t => ({ label:t.lb, color:t.c, seconds:t.s });
  const dTask = t => ({ id:t.i, text:t.tx, done:!!t.dn });
  const dList = l => ({ id:l.i, title:l.ti, color:l.c, isDefault:!!l.d, starred:!!l.sr, activeDays: Array.isArray(l.ad) ? l.ad : null, tasks:(l.tk||[]).map(dTask) });
  const dCalEv = e => ({
    id:e.i, title:e.ti, start:e.s, end:e.e, color:e.c,
    type:e.tp || 'event', fromTemplate:!!e.ft,
    templateId:e.tid ?? null, repeatDays:e.rd || null,
    gcalId:e.gi ?? null, gcalCalId:e.gc ?? null,
  });
  const dDbd = t => ({ id:t.i, text:t.tx, due:t.du, done:!!t.dn, doneOn:t.dw });
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
    calendar: { calEvents: dEvents, calTemplates: (c.cal.ct||[]).map(dCalEv), calEventIdCtr: c.cal.cec || 1 },
  };
}

function gatherState() {
  return {
    version: 1,
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
      starred: !!l.starred,
      activeDays: Array.isArray(l.activeDays) ? l.activeDays : null,
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
    })),
    dbdTasks: dbdTasks.map(t => ({ id: t.id, text: t.text, due: t.due, done: t.done, doneOn: t.doneOn })),
    dbdIdCounter,
    calendar: { calEvents, calTemplates, calEventIdCtr },
  };
}

function applyState(state) {
  const st = decompressState(state);
  if (!st || st.version !== 1) { showToast('Invalid or unsupported file.'); return; }
  wokenUp = !!st.wokenUp;
  if (st.timerDefaults) TIMER_DEFAULTS = st.timerDefaults;
  timers = st.timers.map(t => ({
    id: t.id, label: t.label, color: t.color,
    seconds: t.seconds, running: t.running,
    startedAt: t.startedAt, secondsAtStart: t.secondsAtStart,
  }));
  todoIdCounter = st.todoIdCounter ?? todoIdCounter;
  taskIdCounter = st.taskIdCounter ?? taskIdCounter;
  todoLists = st.todoLists.map(l => ({
    id: l.id, title: l.title, color: l.color, isDefault: !!l.isDefault,
    starred: !!l.starred,
    activeDays: Array.isArray(l.activeDays) ? l.activeDays : null,
    tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
  }));
  dbdTasks = (st.dbdTasks || []).map(t => ({ id: t.id, text: t.text, due: t.due, done: !!t.done, doneOn: t.doneOn }));
  dbdIdCounter = st.dbdIdCounter ?? dbdIdCounter;
  if (st.calendar) {
    calEvents     = st.calendar.calEvents     || {};
    calTemplates  = st.calendar.calTemplates  || [];
    calEventIdCtr = st.calendar.calEventIdCtr || 1;
    calSave();
    calPruneDays();
  }
  syncWakeupUI();
  renderTimers();
  renderTodos();
  renderDbd();
  calRefresh();
  saveToLocal();
  showToast('State restored ✓');
}

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
      starred: !!l.starred,
      activeDays: Array.isArray(l.activeDays) ? l.activeDays : null,
      tasks: l.tasks.map(t => ({ id: t.id, text: t.text, done: t.done }))
    }));
    dbdTasks = (state.dbdTasks || []).map(t => ({ id: t.id, text: t.text, due: t.due, done: !!t.done, doneOn: t.doneOn }));
    dbdIdCounter = state.dbdIdCounter ?? dbdIdCounter;
    if (state.calendar) {
      calEvents     = state.calendar.calEvents     || {};
      calTemplates  = state.calendar.calTemplates  || [];
      calEventIdCtr = state.calendar.calEventIdCtr || 1;
    }
    return true;
  } catch(e) {
    try { localStorage.removeItem(LS_KEY); } catch(_) {}
    return false;
  }
}

function calSave() {
  try { localStorage.setItem(CAL_LS_KEY, JSON.stringify({ calEvents, calTemplates, calEventIdCtr })); } catch(e) {}
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

/* ───────────────────────── TIMERS ───────────────────────── */
function timerById(id) { return timers.find(x => x.id === id); }

function timerCardHTML(t, pfx) {
  return `
    <div class="timer-header">
      <div class="color-swatch" style="background:${t.color}">
        <input type="color" value="${t.color}" oninput="changeTimerColor(${t.id}, this.value)">
      </div>
      <input class="timer-title-input" value="${escAttr(t.label)}" placeholder="Timer name"
        oninput="setTimerLabel(${t.id}, this.value)">
    </div>
    <div class="timer-body">
      <div class="timer-accent-bar tbar-${t.id}" style="background:${t.color}"></div>
      <div class="timer-display tdisp-${t.id}" onclick="startEditTimer(${t.id}, '${pfx}')">${fmt(t.seconds)}</div>
      <input class="timer-time-edit tedit-${t.id}-${pfx}" type="text" placeholder="h:mm:ss"
        onblur="commitEditTimer(${t.id}, '${pfx}')"
        onkeydown="if(event.key==='Enter') commitEditTimer(${t.id}, '${pfx}')">
      <button class="play-btn playbtn-${t.id} ${t.running ? 'running' : ''}" onclick="toggleTimer(${t.id})" title="Start / pause">
        ${t.running ? pauseIcon() : playIcon()}
      </button>
      <button class="reset-btn" onclick="resetTimer(${t.id})" title="Reset">${resetIcon()}</button>
      <button class="fmt-remove-timer" onclick="removeFormatTimer(${t.id})" title="Remove timer">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="timer-sub tsub-${t.id}">${t.running ? 'running' : 'paused'} · click time to edit</div>`;
}

function renderTimers() {
  [['timerStack-d','d'],['timerStack-m','m']].forEach(([stackId, pfx]) => {
    const stack = $(stackId);
    if (!stack) return;
    stack.innerHTML = '';
    timers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'timer-card';
      card.innerHTML = timerCardHTML(t, pfx);
      stack.appendChild(card);
    });
  });
  renderHome();
}

function setTimerLabel(id, value) {
  const t = timerById(id);
  if (!t) return;
  t.label = value;
  if (formatMode) {
    const idx = timers.findIndex(x => x.id === id);
    if (TIMER_DEFAULTS[idx]) TIMER_DEFAULTS[idx].label = value;
  }
  saveToLocal();
}

function changeTimerColor(id, color) {
  const t = timerById(id);
  if (!t) return;
  t.color = color;
  if (formatMode) {
    const idx = timers.findIndex(x => x.id === id);
    if (TIMER_DEFAULTS[idx]) TIMER_DEFAULTS[idx].color = color;
  }
  document.querySelectorAll(`.tbar-${id}`).forEach(el => el.style.background = color);
  saveToLocal();
}

function toggleTimer(id) {
  const t = timerById(id);
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
  const t = timerById(id);
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
  const t = timerById(id);
  if (!t || t.running) return;
  document.querySelectorAll(`.tdisp-${id}`).forEach(el => el.style.display = 'none');
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) {
    edit.style.display = 'block';
    edit.value = fmt(formatMode ? t.seconds : t.seconds);
    edit.focus(); edit.select();
  }
}

function commitEditTimer(id, pfx) {
  const t = timerById(id);
  if (!t) return;
  const edit = document.querySelector(`.tedit-${id}-${pfx}`);
  if (edit) {
    const parsed = parseTime(edit.value);
    if (!isNaN(parsed) && parsed >= 0) {
      t.seconds = parsed;
      if (t.running) { t.startedAt = Date.now(); t.secondsAtStart = parsed; }
      if (formatMode) {
        const idx = timers.findIndex(x => x.id === id);
        if (TIMER_DEFAULTS[idx]) TIMER_DEFAULTS[idx].seconds = parsed;
      }
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
  const t = timerById(id);
  if (!t) return;
  const idx = timers.findIndex(x => x.id === id);
  const def = TIMER_DEFAULTS[idx];
  t.running = false;
  t.seconds = def ? def.seconds : t.seconds;
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

/* ───────────────────────── WAKEUP + SUMMARY ───────────────────────── */
function syncWakeupUI() {
  ['d','m'].forEach(p => {
    const row = $(`wakeupRow-${p}`);
    const box = $(`wakeupBox-${p}`);
    if (row) row.classList.toggle('done', wokenUp);
    if (box) box.classList.toggle('checked', wokenUp);
  });
}

function toggleWakeup() {
  wokenUp = !wokenUp;
  syncWakeupUI();
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

  const html = wokenUp ? `
    <div class="timer-summary-row">
      <span class="timer-summary-label">Time remaining</span>
      <span class="timer-summary-value">${fmt(totalSecs)}</span>
    </div>
    <div class="timer-summary-row">
      <span class="timer-summary-label">Est. finish</span>
      <span class="timer-summary-value">${h12}:${mm} ${ampm}</span>
    </div>` : '';

  ['d','m'].forEach(p => {
    const el = $(`timerSummary-${p}`);
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle('visible', wokenUp);
  });
}

/* ───────────────────────── TODO LISTS ───────────────────────── */
function listById(id) { return todoLists.find(l => l.id === id); }

function buildCard(list, pfx) {
  const listDraggable = !list.isDefault || formatMode;
  const card = document.createElement('div');
  card.className = 'todo-card' + (listDraggable ? ' list-reorderable' : '') + (list.starred ? ' starred' : '');
  card.dataset.listId = list.id;
  card.dataset.isDefault = list.isDefault ? '1' : '0';

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
    return `
      <div class="task-row" data-task-id="${task.id}" data-list-id="${list.id}">
        ${rowHandle}
        <div class="task-check task-checks-${task.id} ${task.done?'done':''}" style="${checkStyle}"
          onclick="toggleTask(${list.id},${task.id})">
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <input class="task-text task-text-${task.id} ${task.done?'done':''}"
          value="${escAttr(task.text)}" placeholder="Task…"
          oninput="setTaskText(${list.id},${task.id},this.value)"
          onblur="refreshSyncBadges()"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addTask(${list.id});}">
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

// Returns true when every task in the list is done (or the list has no tasks).
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

function renderTodos() {
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

    if (!formatMode && visibleDaily.length === 0 && dailyLists.length > 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-state daily-empty';
      hint.textContent = 'No lists scheduled for today.';
      defEl.appendChild(hint);
    }
    customLists.forEach(l => custEl.appendChild(buildCard(l, pfx)));
  });
  bindAllDrags();
  renderHome();
}

function setListTitle(id, value) {
  const l = listById(id);
  if (l) { l.title = value; saveToLocal(); }
}

function toggleStarList(id) {
  const l = listById(id);
  if (!l) return;
  l.starred = !l.starred;
  renderTodos();
  saveToLocal();
}

function addTodoList() {
  const id = todoIdCounter++;
  todoLists.push({ id, title: '', color: '#5DCAA5', tasks: [], isDefault: false });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = $(`todo-title-${id}-d`) || $(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

function removeTodoList(id) {
  todoLists = todoLists.filter(l => l.id !== id);
  renderTodos();
  saveToLocal();
}

function changeTodoColor(id, color) {
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
  saveToLocal();
}

function addTask(listId) {
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

function removeTask(listId, taskId) {
  const list = listById(listId);
  if (!list) return;
  if (list.isDefault && !formatMode) return;
  list.tasks = list.tasks.filter(t => t.id !== taskId);
  renderTodos();
  saveToLocal();
}

function setTaskText(listId, taskId, value) {
  const list = listById(listId);
  const task = list && list.tasks.find(t => t.id === taskId);
  if (task) { task.text = value; saveToLocal(); }
}

// Add/remove the link badge in place after a rename, without rebuilding inputs
// (a full re-render would steal focus mid-edit).
function refreshSyncBadges() {
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

function toggleTask(listId, taskId) {
  const list = listById(listId);
  if (!list) return;
  const task = list.tasks.find(t => t.id === taskId);
  if (!task) return;
  const newDone = !task.done;

  // Track every list whose task state changes during this toggle, so the
  // UP pass can re-evaluate ALL of them (not just the list that was clicked).
  const affectedLists = new Set([list]);

  // Apply to this task and every synced twin across Daily lists (Approach 1).
  const targets = syncedTaskTargets(list, task);
  targets.forEach(({ list: l, task: tk }) => {
    tk.done = newDone;
    paintTaskState(l, tk);
    affectedLists.add(l);

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

  saveToLocal();
  homeUpdateProgressDom();
}

function moveList(fromListId, toListId, placeAfter, isDefault) {
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

function moveTask(taskId, fromListId, toListId, beforeTaskId, placeAfter) {
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
  saveToLocal();
}

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

function hitTestAt(x, y, ghost) {
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
function makeDrag(handle, opts) {
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

function bindAllDrags() {
  document.querySelectorAll('.todo-card.list-reorderable').forEach(bindListDrag);
  document.querySelectorAll('.task-row').forEach(bindTaskDrag);
}

/* ───────────────────────── FORMAT MODE ───────────────────────── */
function toggleFormatMode() {
  if (formatMode) commitFormatMode();
  else enterFormatMode();
}

function enterFormatMode() {
  // snapshot live remaining times
  preFormatTimerState = timers.map(t => ({
    id: t.id,
    seconds: Math.round(getRemaining(t)),
    running: t.running,
    startedAt: t.startedAt,
    secondsAtStart: t.secondsAtStart,
  }));

  // pause everything
  timers.forEach(t => {
    if (t.running) {
      t.seconds = getRemaining(t);
      t.running = false;
      updateTimerUI(t.id);
    }
  });

  // show defaults in displays + set t.seconds to defaults for editing
  timers.forEach((t, i) => {
    const def = TIMER_DEFAULTS[i];
    if (def) t.seconds = def.seconds;
  });

  formatMode = true;
  document.body.classList.add('format-mode');
  const btn = $('fmtBtn');
  if (btn) { btn.textContent = '✓ Done'; btn.classList.add('active'); }

  renderTimers();
  renderTodos();
  calFmtMobileDay = 0;
  if (calDesktopOpen) calRenderDesktop();
  if (currentTab === 4) calRenderMobile();
}

function commitFormatMode() {
  // adopt format-mode values as the new defaults
  TIMER_DEFAULTS = timers.map(t => ({ label: t.label, seconds: t.seconds, color: t.color }));

  formatMode = false;
  document.body.classList.remove('format-mode');
  const btn = $('fmtBtn');
  if (btn) { btn.textContent = 'Formats'; btn.classList.remove('active'); }

  // restore live progress
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

  renderTimers();
  renderTodos();
  if (calDesktopOpen) calRenderDesktop();
  if (currentTab === 4) calRenderMobile();
  saveToLocal();
  showToast('Format saved ✓');
}

function addFormatTimer() {
  if (!formatMode) return;
  const id = formatTimerIdCounter++;
  const newT = { id, label: 'New Timer', seconds: 3600, color: '#5DCAA5', running: false, startedAt: null, secondsAtStart: null };
  timers.push(newT);
  TIMER_DEFAULTS.push({ label: newT.label, seconds: newT.seconds, color: newT.color });
  renderTimers();
  saveToLocal();
}

function removeFormatTimer(id) {
  if (!formatMode) return;
  if (timers.length <= 1) { showToast('Need at least one timer.'); return; }
  const idx = timers.findIndex(t => t.id === id);
  if (idx === -1) return;
  timers.splice(idx, 1);
  TIMER_DEFAULTS.splice(idx, 1);
  preFormatTimerState = preFormatTimerState.filter(p => p.id !== id);
  renderTimers();
  saveToLocal();
}

function addFormatDaily() {
  if (!formatMode) return;
  const id = todoIdCounter++;
  todoLists.push({ id, title: 'New List', color: '#5DCAA5', isDefault: true, activeDays: null, tasks: [] });
  renderTodos();
  saveToLocal();
  setTimeout(() => {
    const inp = $(`todo-title-${id}-d`) || $(`todo-title-${id}-m`);
    if (inp) inp.focus();
  }, 10);
}

function removeFormatDaily(id) {
  if (!formatMode) return;
  todoLists = todoLists.filter(l => l.id !== id);
  renderTodos();
  saveToLocal();
}

/* ───────────────────────── DAY-BY-DAY TASKS ─────────────────────────
 * Flat, dated one-off tasks under the My Lists tab. Unchecked tasks with a
 * past due date surface in an "Overdue" section; checked past tasks collapse
 * into a dimmed "Completed" group. Groups re-flow automatically at midnight. */
function dbdTodayKey() { return calDateKey(calToday()); }

function dbdLabelFor(key) {
  const today = calToday();
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

function dbdById(id) { return dbdTasks.find(t => t.id === id); }

function addDbdTask(pfx) {
  const textEl = $(`dbdText-${pfx}`);
  const dateEl = $(`dbdDate-${pfx}`);
  const text = (textEl?.value || '').trim();
  if (!text) { textEl?.focus(); return; }
  const due = (dateEl?.value) || dbdTodayKey();
  dbdTasks.push({ id: dbdIdCounter++, text, due, done: false });
  if (textEl) textEl.value = '';
  renderDbd();
  saveToLocal();
  textEl?.focus();
}

function toggleDbdTask(id) {
  const t = dbdById(id);
  if (!t) return;
  t.done = !t.done;
  if (t.done) t.doneOn = dbdTodayKey();   // lets today's progress count overdue tasks cleared today
  else delete t.doneOn;
  renderDbd();
  saveToLocal();
}

function removeDbdTask(id) {
  dbdTasks = dbdTasks.filter(t => t.id !== id);
  renderDbd();
  saveToLocal();
}

function setDbdText(id, value) {
  const t = dbdById(id);
  if (t) { t.text = value; saveToLocal(); }
}

function setDbdDue(id, value) {
  const t = dbdById(id);
  if (!t || !value) return;
  t.due = value;
  renderDbd();
  saveToLocal();
}

function dbdRowHtml(t, overdue) {
  const dueAttr = escAttr(t.due || dbdTodayKey());
  return `
    <div class="task-row dbd-row ${overdue ? 'dbd-overdue-row' : ''}" data-dbd-id="${t.id}">
      <div class="task-check dbd-check ${t.done ? 'done' : ''}" onclick="toggleDbdTask(${t.id})">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <input class="task-text ${t.done ? 'done' : ''}" value="${escAttr(t.text)}" placeholder="Task…"
        oninput="setDbdText(${t.id}, this.value)">
      <input type="date" class="dbd-date-input" value="${dueAttr}"
        onchange="setDbdDue(${t.id}, this.value)" title="Due date">
      <button class="task-del" onclick="removeDbdTask(${t.id})">×</button>
    </div>`;
}

function renderDbd() {
  const todayKey = dbdTodayKey();
  const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id);

  const overdue   = dbdTasks.filter(t => !t.done && t.due < todayKey).sort(byDue);
  const upcoming  = dbdTasks.filter(t => t.due >= todayKey).sort(byDue);
  const donePast  = dbdTasks.filter(t => t.done && t.due < todayKey).sort(byDue);

  // Group upcoming by due-date key, preserving ascending order.
  const groups = [];
  upcoming.forEach(t => {
    const g = groups[groups.length - 1];
    if (g && g.key === t.due) g.tasks.push(t);
    else groups.push({ key: t.due, tasks: [t] });
  });

  let html = '';
  if (overdue.length) {
    html += `
      <div class="dbd-group dbd-group-overdue">
        <div class="dbd-group-header dbd-header-overdue">Overdue
          <span class="dbd-count">${overdue.length}</span></div>
        ${overdue.map(t => dbdRowHtml(t, true)).join('')}
      </div>`;
  }
  groups.forEach(g => {
    html += `
      <div class="dbd-group">
        <div class="dbd-group-header">${dbdLabelFor(g.key)}</div>
        ${g.tasks.map(t => dbdRowHtml(t, false)).join('')}
      </div>`;
  });
  if (donePast.length) {
    html += `
      <div class="dbd-group dbd-group-done">
        <div class="dbd-group-header dbd-header-done">Completed</div>
        ${donePast.map(t => dbdRowHtml(t, false)).join('')}
      </div>`;
  }
  if (!html) html = '<div class="empty-state dbd-empty">No day-by-day tasks yet.<br>Add one above with a due date.</div>';

  ['d','m'].forEach(pfx => {
    const el = $(`dbdContainer-${pfx}`);
    if (el) el.innerHTML = html;
  });
  renderHome();
}

/* Midnight rollover: re-flow groups (and default-date inputs) when the day changes. */
let _dbdDayKey = null;
function dbdCheckRollover() {
  const k = dbdTodayKey();
  if (k === _dbdDayKey) return;
  _dbdDayKey = k;
  ['d','m'].forEach(pfx => { const el = $(`dbdDate-${pfx}`); if (el) el.value = k; });
  renderDbd();
  renderTodos();   // Daily lists' "active today" can change at midnight too
}

/* ── Daily-list day-of-week schedule ── */
let scheduleEditListId = null;

function openScheduleModal(listId) {
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

function scheduleEveryDay() {
  // Under the new semantics, zero selected = hidden — so "every day" must
  // SELECT all seven buttons (saveSchedule normalizes 7/7 back to null).
  document.querySelectorAll('#scheduleDowRow .cal-dow-btn').forEach(b => b.classList.add('active'));
  updateScheduleHint();
}

function saveSchedule() {
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

/* ───────────────────────── EXPORT / IMPORT / RESET ───────────────────────── */
function openExportModal() {
  $('exportTextarea').value = JSON.stringify(compressState(gatherState()));
  $('exportModal').classList.add('show');
}
function openImportModal() {
  $('importTextarea').value = '';
  $('importModal').classList.add('show');
}
function closeModal(id) { $(id).classList.remove('show'); }

function exportCopy() {
  navigator.clipboard.writeText($('exportTextarea').value)
    .then(() => { showToast('Copied to clipboard ✓'); closeModal('exportModal'); })
    .catch(() => showToast('Copy failed — try Download instead'));
}
function exportDownload() {
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
function importFromText() {
  const raw = $('importTextarea').value.trim();
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
    try {
      applyState(JSON.parse(e.target.result));
      closeModal('importModal');
    } catch { showToast('Could not parse file.'); }
  };
  reader.readAsText(file);
  input.value = '';
}

function resetAll() {
  closeModal('confirmOverlay');
  timers.forEach((t, i) => {
    const def = TIMER_DEFAULTS[i];
    t.running = false;
    t.seconds = def ? def.seconds : t.seconds;
    t.startedAt = null;
    t.secondsAtStart = null;
  });
  wokenUp = false;
  syncWakeupUI();
  todoLists.filter(l => l.isDefault).forEach(l => l.tasks.forEach(t => t.done = false));
  renderTimers();
  renderTodos();
  updateTimerSummary();
  saveToLocal();
  showToast('Reset ✓');
}

function confirmClearStorage() {
  if (confirm('Clear all saved data and reset to defaults? This cannot be undone.')) {
    localStorage.clear();
    showToast('Storage cleared — reloading…');
    setTimeout(() => location.reload(), 600);
  }
}

/* ───────────────────────── HOME PAGE ─────────────────────────
 * Read-mostly dashboard assembled from existing state. All interactions
 * delegate to existing functions (toggleDbdTask / toggleTask), and existing
 * live-update hooks keep it fresh: tickAll drives .tdisp-N timer text, and
 * paintTaskState drives .task-checks-N / .task-text-N on starred lists. */
let homeDesktopOpen = false;

const HOME_CHECK_SVG = `<svg width="9" height="9" viewBox="0 0 9 9" fill="none">
  <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function homeToggleDesktop(force) {
  const want = (typeof force === 'boolean') ? force : !homeDesktopOpen;
  if (want && calDesktopOpen) calToggleDesktop();   // close calendar overlay first
  homeDesktopOpen = want;
  const panel = $('homeDesktopPanel');
  const tab   = $('homeDesktopNavTab');
  const rp    = $('rightPanel');
  if (panel) panel.classList.toggle('active', homeDesktopOpen);
  if (tab)   tab.classList.toggle('active', homeDesktopOpen);
  if (rp)    rp.style.display = homeDesktopOpen ? 'none' : '';
  if (homeDesktopOpen) renderHome();
}

function renderHome() {
  const dc = $('homeContainer-d');
  const mc = $('homeContainer-m');
  if (!dc && !mc) return;
  const html =
    homeHeroHtml() +
    homeDbdHtml() +
    homeStarredListsHtml(true) +   // starred Daily lists
    homeTimersHtml() +
    homeCalHtml() +
    homeStarredListsHtml(false);   // starred custom Lists
  if (dc) dc.innerHTML = html;
  if (mc) mc.innerHTML = html;
}

/* ── daily progress: starred Daily tasks + dbd tasks due today / overdue.
 *    A done dbd task counts only if it's due today OR was checked off today
 *    (doneOn), so clearing an overdue task fills the bar instead of shrinking
 *    the denominator. */
function homeProgressData() {
  const todayKey = dbdTodayKey();
  let total = 0, done = 0;
  todoLists.forEach(l => {
    if (!l.isDefault || !l.starred) return;
    l.tasks.forEach(t => { total++; if (t.done) done++; });
  });
  dbdTasks.forEach(t => {
    const counted = t.done
      ? (t.due === todayKey || t.doneOn === todayKey)
      : (t.due <= todayKey);
    if (counted) { total++; if (t.done) done++; }
  });
  return { total, done, pct: total ? Math.round(done / total * 100) : 0 };
}

function homeProgressHtml() {
  const { total, done, pct } = homeProgressData();
  if (!total) return '';
  const complete = done === total;
  const label = complete ? 'All done for today' : `${done} of ${total} tasks done`;
  return `
    <div class="home-progress ${complete ? 'complete' : ''}">
      <div class="home-progress-meta">
        <span class="home-progress-label">${label}</span>
        <span class="home-progress-pct">${pct}%</span>
      </div>
      <div class="home-progress-track">
        <div class="home-progress-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

/* Patch the bar in place (no full re-render) — used by toggleTask, which
 * paints task state via classes instead of re-rendering the Home page. */
function homeUpdateProgressDom() {
  const bars = document.querySelectorAll('.home-progress');
  if (!bars.length) { renderHome(); return; }
  const { total, done, pct } = homeProgressData();
  const complete = total > 0 && done === total;
  const label = complete ? 'All done for today' : `${done} of ${total} tasks done`;
  bars.forEach(bar => {
    bar.classList.toggle('complete', complete);
    const fill = bar.querySelector('.home-progress-fill');
    const lab  = bar.querySelector('.home-progress-label');
    const pc   = bar.querySelector('.home-progress-pct');
    if (fill) fill.style.width = pct + '%';
    if (lab)  lab.textContent = label;
    if (pc)   pc.textContent = pct + '%';
  });
}

/* ── hero ── */
function homeHeroHtml() {
  const dateStr = new Date().toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });
  return `
    <div class="home-hero">
      <div class="home-welcome">Welcome</div>
      <div class="home-date">${dateStr}</div>
      ${homeProgressHtml()}
    </div>`;
}

/* ── day-by-day: overdue (red) + today (white) + next 3 upcoming (grey) ── */
function homeDbdRow(t, tone) {
  const dateChip = tone === 'today' ? '' :
    `<span class="home-dbd-date">${dbdLabelFor(t.due)}</span>`;
  return `
    <div class="task-row home-dbd-row home-tone-${tone}">
      <div class="task-check home-dbd-check ${t.done ? 'done' : ''}" onclick="toggleDbdTask(${t.id})">
        ${HOME_CHECK_SVG}
      </div>
      <span class="home-task-text ${t.done ? 'done' : ''}">${escAttr(t.text)}</span>
      ${dateChip}
    </div>`;
}

function homeDbdHtml() {
  const todayKey = dbdTodayKey();
  const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id);
  const overdue  = dbdTasks.filter(t => !t.done && t.due <  todayKey).sort(byDue);
  const today    = dbdTasks.filter(t =>             t.due === todayKey).sort(byDue);
  const upcoming = dbdTasks.filter(t => !t.done && t.due >  todayKey).sort(byDue).slice(0, 3);
  if (!overdue.length && !today.length && !upcoming.length) return '';
  const emptyToday = (!overdue.length && !today.length)
    ? '<div class="home-muted-note">Nothing due today.</div>' : '';
  return `
    <section class="home-section">
      <div class="home-section-title">Today\u2019s Tasks</div>
      <div class="home-card">
        ${overdue.map(t => homeDbdRow(t, 'overdue')).join('')}
        ${today.map(t => homeDbdRow(t, 'today')).join('')}
        ${emptyToday}
        ${upcoming.map(t => homeDbdRow(t, 'future')).join('')}
      </div>
    </section>`;
}

/* ── starred lists (daily=true → Daily lists; false → custom Lists) ── */
function homeListCard(list) {
  const rows = list.tasks.map(task => {
    const checkStyle = task.done ? `background:${list.color};border-color:${list.color}` : '';
    return `
      <div class="task-row home-list-row">
        <div class="task-check task-checks-${task.id} ${task.done ? 'done' : ''}" style="${checkStyle}"
          onclick="toggleTask(${list.id},${task.id})">
          ${HOME_CHECK_SVG}
        </div>
        <span class="home-task-text task-text-${task.id} ${task.done ? 'done' : ''}">${escAttr(task.text)}</span>
      </div>`;
  }).join('');
  return `
    <div class="home-list-card">
      <div class="home-list-strip" style="background:${list.color}"></div>
      <div class="home-list-title">
        <span class="home-list-star">${STAR_SVG}</span>
        ${escAttr(list.title || 'Untitled')}
      </div>
      <div class="home-list-tasks">${rows || '<div class="home-muted-note">No tasks</div>'}</div>
    </div>`;
}

function homeStarredListsHtml(daily) {
  const lists = todoLists.filter(l => !!l.isDefault === daily && l.starred);
  if (!lists.length) return '';
  const title = daily ? 'Starred Daily' : 'Starred Lists';
  return `
    <section class="home-section">
      <div class="home-section-title">${title}</div>
      <div class="home-lists-grid">${lists.map(homeListCard).join('')}</div>
    </section>`;
}

/* ── timers: compact remaining-time chips (tickAll keeps .tdisp-N live) ── */
function homeTimersHtml() {
  if (!timers.length) return '';
  const chips = timers.map(t => `
    <div class="home-timer-chip">
      <span class="home-timer-dot" style="background:${t.color}"></span>
      <span class="home-timer-label">${escAttr(t.label)}</span>
      <span class="home-timer-time tdisp-${t.id}">${fmt(getRemaining(t))}</span>
    </div>`).join('');
  return `
    <section class="home-section">
      <div class="home-section-title">Timers</div>
      <div class="home-timer-row">${chips}</div>
    </section>`;
}

/* ── calendar: agenda of events overlapping [now, now + 4h] ── */
function homeCalTime(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return calFmtTime(calMinsToStr(wrapped));
}

function homeCalHtml() {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const winEnd  = nowMins + 240;
  const todayKey = calDateKey(calToday());
  const tmr = new Date(calToday()); tmr.setDate(tmr.getDate() + 1);
  const tomorrowKey = calDateKey(tmr);

  const collect = (dateKey, offset) => {
    const local = (calEvents[dateKey] || []).filter(e => e.type !== 'divider');
    const goog  = (gcalIsConnected() ? (gcalEvents[dateKey] || []) : []).filter(e => !e.allDay);
    return [...local, ...goog].map(ev => {
      const s = calTimeToMins(ev.start) + offset;
      return { title: ev.title, color: ev.color || '#5dcaa5',
               s, e: Math.max(s + 1, calTimeToMins(ev.end) + offset) };
    });
  };
  let evs = collect(todayKey, 0);
  if (winEnd > 1440) evs = evs.concat(collect(tomorrowKey, 1440));
  evs = evs.filter(ev => ev.e > nowMins && ev.s < winEnd)
           .sort((a, b) => a.s - b.s || a.e - b.e);

  const items = evs.map(ev => {
    const ongoing  = ev.s <= nowMins;
    const startsIn = ev.s - nowMins;
    const inStr = startsIn >= 60
      ? `in ${Math.floor(startsIn / 60)}h${startsIn % 60 ? ' ' + (startsIn % 60) + 'm' : ''}`
      : `in ${startsIn}m`;
    const badge = ongoing
      ? '<span class="home-cal-badge now">Now</span>'
      : `<span class="home-cal-badge">${inStr}</span>`;
    const tmrTag = ev.s >= 1440 ? '<span class="home-cal-tmr">tomorrow</span>' : '';
    return `
      <div class="home-cal-event ${ongoing ? 'ongoing' : ''}"
        style="border-left-color:${ev.color};background:${ev.color}14">
        <div class="home-cal-event-main">
          <div class="home-cal-event-title" style="color:${ev.color}">${escAttr(ev.title || '(untitled)')}</div>
          <div class="home-cal-event-time">${homeCalTime(ev.s)} \u2013 ${homeCalTime(ev.e)} ${tmrTag}</div>
        </div>
        ${badge}
      </div>`;
  }).join('');

  const empty = `<div class="home-muted-note">Nothing on the calendar until ${homeCalTime(winEnd)}.</div>`;
  return `
    <section class="home-section">
      <div class="home-section-title">Next 4 Hours</div>
      <div class="home-card home-cal-card">${items || empty}</div>
    </section>`;
}

/* ───────────────────────── MOBILE TABS ───────────────────────── */
function setSwipePanelWidths() {
  const w = window.innerWidth;
  const track  = $('swipeTrack');
  const panels = document.querySelectorAll('.swipe-panel');
  if (track) track.style.width = (w * panels.length) + 'px';
  panels.forEach(p => p.style.width = w + 'px');
  if (track) {
    track.style.transition = 'none';
    track.style.transform = `translateX(${-currentTab * w}px)`;
  }
  [0,1,2,3,4].forEach(i => {
    const btn = $(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === currentTab);
  });
}

function goTab(idx, animate) {
  currentTab = idx;
  const w = window.innerWidth;
  const track = $('swipeTrack');
  if (track) {
    track.style.transition = animate === false ? 'none' : 'transform 0.32s cubic-bezier(0.3,0.7,0.4,1)';
    track.style.transform = `translateX(${-idx * w}px)`;
  }
  [0,1,2,3,4].forEach(i => {
    const btn = $(`tab-${i}`);
    if (btn) btn.classList.toggle('active', i === idx);
  });
  if (idx === 4) calRenderMobile();
  if (idx === 0) renderHome();
}

function initSwipe() {
  const swipeEl = $('swipeContainer');
  if (!swipeEl) return;
  let sx = 0, sy = 0, swiping = false;

  swipeEl.addEventListener('touchstart', e => {
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'SELECT'
      || t.closest('button') || t.closest('input')
      || t.closest('.drag-handle') || t.closest('.list-drag-handle')
      || t.closest('.cal-event') || t.closest('.cal-divider')) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });

  swipeEl.addEventListener('touchmove', e => {
    if (!sx) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) swiping = true;
  }, { passive: true });

  swipeEl.addEventListener('touchend', e => {
    if (!swiping) { sx = 0; return; }
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      goTab(dx < 0 ? Math.min(currentTab + 1, 4) : Math.max(currentTab - 1, 0), true);
    }
    sx = 0; swiping = false;
  }, { passive: true });
}

/* ───────────────────────── CALENDAR ───────────────────────── */
function calEnsureDay(key) {
  if (!calEvents[key]) {
    const dow = new Date(key + 'T00:00:00').getDay();
    calEvents[key] = calTemplates
      .filter(t => t.repeatDays && t.repeatDays.includes(dow))
      .map(t => ({ ...t, id: calEventIdCtr++, fromTemplate: true, templateId: t.id }));
  }
}

function calPruneDays() {
  const keys = new Set(calDisplayDays().map(calDateKey));
  Object.keys(calEvents).forEach(k => { if (!keys.has(k)) delete calEvents[k]; });
}

function calBuildTimeCol(el) {
  el.style.height = CAL_TOTAL_PX + 'px';
  el.innerHTML = '';
  for (let h = 1; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'cal-time-label';
    lbl.style.top = (h * CAL_HOUR_PX) + 'px';
    const ap = h >= 12 ? 'pm' : 'am';
    lbl.textContent = `${h % 12 || 12}${ap}`;
    el.appendChild(lbl);
  }
}

function calBuildLines(col) {
  col.style.height = CAL_TOTAL_PX + 'px';
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'cal-hour-line';
    line.style.top = (h * CAL_HOUR_PX) + 'px';
    col.appendChild(line);
    const half = document.createElement('div');
    half.className = 'cal-half-line';
    half.style.top = (h * CAL_HOUR_PX + CAL_HOUR_PX/2) + 'px';
    col.appendChild(half);
    [1,3].forEach(q => {
      const ql = document.createElement('div');
      ql.className = 'cal-quarter-line';
      ql.style.top = (h * CAL_HOUR_PX + q * (CAL_HOUR_PX/4)) + 'px';
      col.appendChild(ql);
    });
  }
}

function calBuildNowLine(col) {
  col.querySelector('.cal-now-line')?.remove();
  const now = new Date();
  const mins = now.getHours()*60 + now.getMinutes();
  const wrap = document.createElement('div');
  wrap.className = 'cal-now-line';
  wrap.style.top = calMinsToPx(mins) + 'px';
  const dot = document.createElement('div');
  dot.className = 'cal-now-dot';
  wrap.appendChild(dot);
  col.appendChild(wrap);
}

/* ── event element ── */
function calMakeEventEl(ev, dateKeyOrDow, isFmtMode) {
  const el = document.createElement('div');
  if (ev.type === 'divider') {
    el.className = 'cal-divider';
    el.style.top = calMinsToPx(calTimeToMins(ev.start)) + 'px';
    el.style.transform = 'translateY(-50%)';
    const line = document.createElement('div');
    line.className = 'cal-divider-line';
    line.style.background = ev.color;
    const lbl = document.createElement('div');
    lbl.className = 'cal-divider-label';
    lbl.style.color = ev.color;
    lbl.textContent = ev.title || 'Divider';
    el.appendChild(line);
    el.appendChild(lbl);
  } else {
    el.className = 'cal-event';
    const startM = calTimeToMins(ev.start);
    const endM   = calTimeToMins(ev.end);
    const durM   = Math.max(15, endM - startM);
    el.style.top    = calMinsToPx(startM) + 'px';
    el.style.height = calMinsToPx(durM) + 'px';
    el.style.background = ev.color + '33';
    el.style.borderLeft = `3px solid ${ev.color}`;
    el.style.color = ev.color;
    const t = document.createElement('div');
    t.style.cssText = 'font-weight:500;overflow:hidden;text-overflow:ellipsis';
    t.textContent = ev.title || '(no title)';
    const time = document.createElement('div');
    time.className = 'cal-event-time';
    time.textContent = `${calFmtTime(ev.start)}–${calFmtTime(ev.end)}`;
    el.appendChild(t);
    el.appendChild(time);
  }
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (isFmtMode) openCalModalFmt(typeof dateKeyOrDow === 'number' ? dateKeyOrDow : null, ev.id);
    else openCalModal(dateKeyOrDow, ev.id);
  });
  bindCalEventDrag(el, ev, dateKeyOrDow, isFmtMode);
  return el;
}

/* ── calendar event drag (unified engine) ── */
function calScrollContainer() {
  const desk = $('calScrollArea');
  if (desk && calDesktopOpen) return desk;
  return $('calMobileGrid');
}

function bindCalEventDrag(el, ev, dateKeyOrDow, isFmtMode) {
  makeDrag(el, {
    source: () => el,
    onMove: (x, y, ghost) => {
      // edge auto-scroll
      const sc = calScrollContainer();
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (y < r.top + 48)         sc.scrollTop -= 14;
        else if (y > r.bottom - 48) sc.scrollTop += 14;
      }
    },
    onDrop: (x, y, ghost) => {
      const hit = hitTestAt(x, y, ghost);
      if (!hit) return;
      const col = hit.closest('.cal-day-col, .cal-mobile-day-col');
      if (!col) return;

      // grab offset within the event so the drop lands where it visually sits
      const ghostTop = ghost ? parseFloat(ghost.style.top) : y;
      const colRect  = col.getBoundingClientRect();
      const localY   = ghostTop - colRect.top;
      const sc = col.closest('.cal-scroll-area, .cal-grid-wrap');
      const scrollAdj = 0; // colRect already reflects scroll position
      const mins = calPxToMins(localY + scrollAdj);

      if (isFmtMode || formatMode) {
        const toDow = parseInt(col.dataset.dow);
        if (isNaN(toDow)) return;
        calMoveTemplate(ev.id, typeof dateKeyOrDow === 'number' ? dateKeyOrDow : null, toDow, mins);
      } else {
        const toKey = col.dataset.dateKey;
        if (!toKey) return;
        calMoveEvent(ev.id, dateKeyOrDow, toKey, mins);
      }
    },
  });
}

function calMoveEvent(evId, fromKey, toKey, newStartMins) {
  const list = calEvents[fromKey] || [];
  const ev = list.find(e => e.id === evId);
  if (!ev) return;
  const dur = ev.type === 'divider' ? 0 : Math.max(15, calTimeToMins(ev.end) - calTimeToMins(ev.start));
  const start = Math.max(0, Math.min(1440 - dur, newStartMins));
  calEvents[fromKey] = list.filter(e => e.id !== evId);
  calEnsureDay(toKey);
  calEvents[toKey].push({
    ...ev,
    start: calMinsToStr(start),
    end:   calMinsToStr(start + dur),
    fromTemplate: toKey !== fromKey ? false : ev.fromTemplate,
  });
  calRefresh();
  calSave();
}

function calMoveTemplate(tmplId, fromDow, toDow, newStartMins) {
  const tmpl = calTemplates.find(t => t.id === tmplId);
  if (!tmpl) return;
  const dur = tmpl.type === 'divider' ? 0 : Math.max(15, calTimeToMins(tmpl.end) - calTimeToMins(tmpl.start));
  const start = Math.max(0, Math.min(1440 - dur, newStartMins));
  if (fromDow !== null && fromDow !== toDow) {
    tmpl.repeatDays = (tmpl.repeatDays || []).filter(d => d !== fromDow);
    if (!tmpl.repeatDays.includes(toDow)) tmpl.repeatDays.push(toDow);
  }
  tmpl.start = calMinsToStr(start);
  tmpl.end   = calMinsToStr(start + dur);
  reseedTemplate(tmpl);
  calRefresh();
  calSave();
}

function reseedTemplate(tmpl) {
  calDisplayDays().forEach(day => {
    const key = calDateKey(day);
    const dow = day.getDay();
    if (!calEvents[key]) return;
    calEvents[key] = calEvents[key].filter(e => e.templateId !== tmpl.id);
    if (tmpl.repeatDays && tmpl.repeatDays.includes(dow)) {
      calEvents[key].push({ ...tmpl, id: calEventIdCtr++, fromTemplate: true, templateId: tmpl.id });
    }
  });
}

/* ── day column renders ── */
function calRenderDayCol(col, dateKey) {
  col.querySelectorAll('.cal-event,.cal-divider,.cal-now-line').forEach(e => e.remove());
  calEnsureDay(dateKey);
  (calEvents[dateKey] || []).forEach(ev => col.appendChild(calMakeEventEl(ev, dateKey, false)));
  gcalInjectEvents(col, dateKey);
  if (dateKey === calDateKey(calToday())) calBuildNowLine(col);
  col.onclick = e => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    openCalModal(dateKey, null, calMinsToStr(calPxToMins(e.clientY - rect.top)));
  };
}

function calRenderFmtCol(col, dow) {
  col.querySelectorAll('.cal-event,.cal-divider').forEach(e => e.remove());
  calTemplates
    .filter(t => t.repeatDays && t.repeatDays.includes(dow))
    .forEach(t => col.appendChild(calMakeEventEl(t, dow, true)));
  col.onclick = e => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    openCalModalFmt(dow, null, calMinsToStr(calPxToMins(e.clientY - rect.top)));
  };
}

/* ── desktop render ── */
function calRenderDesktop() {
  if (formatMode) { calRenderDesktopFmt(); return; }
  const days = calDisplayDays();
  calPruneDays();

  const titleEl = $('calDesktopTitle');
  if (titleEl) titleEl.textContent = calFmtFull(calToday());

  const daysEl = $('calDesktopDays');
  const gridEl = $('calDesktopGrid');
  const timeEl = $('calTimeCol');
  if (!daysEl || !gridEl || !timeEl) return;

  daysEl.style.gridTemplateColumns = 'repeat(7,1fr)';
  daysEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = 'repeat(7,1fr)';
  gridEl.innerHTML = '';
  calBuildTimeCol(timeEl);

  days.forEach(day => {
    const key = calDateKey(day);
    const isToday = key === calDateKey(calToday());

    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header' + (isToday ? ' today' : '');
    const hName = document.createElement('div');
    hName.textContent = calFmtShort(day);
    const hDate = document.createElement('div');
    hDate.className = 'cal-day-header-date';
    hDate.textContent = day.getDate();
    hdr.appendChild(hName);
    hdr.appendChild(hDate);
    daysEl.appendChild(hdr);

    const col = document.createElement('div');
    col.className = 'cal-day-col' + (isToday ? ' today-col' : '');
    col.dataset.dateKey = key;
    calBuildLines(col);
    calRenderDayCol(col, key);
    gridEl.appendChild(col);
  });

  gridEl.style.height = CAL_TOTAL_PX + 'px';
  const sc = $('calScrollArea');
  setTimeout(() => { if (sc) sc.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

function calRenderDesktopFmt() {
  const titleEl = $('calDesktopTitle');
  if (titleEl) titleEl.textContent = 'Template week — Sun through Sat';

  const daysEl = $('calDesktopDays');
  const gridEl = $('calDesktopGrid');
  const timeEl = $('calTimeCol');
  if (!daysEl || !gridEl || !timeEl) return;

  daysEl.style.gridTemplateColumns = 'repeat(7,1fr)';
  daysEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = 'repeat(7,1fr)';
  gridEl.innerHTML = '';
  calBuildTimeCol(timeEl);

  CAL_DOW.forEach((name, dow) => {
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header';
    const hName = document.createElement('div');
    hName.textContent = name;
    hdr.appendChild(hName);
    daysEl.appendChild(hdr);

    const col = document.createElement('div');
    col.className = 'cal-day-col cal-fmt-col';
    col.dataset.dow = dow;
    calBuildLines(col);
    calRenderFmtCol(col, dow);
    gridEl.appendChild(col);
  });

  gridEl.style.height = CAL_TOTAL_PX + 'px';
  const sc = $('calScrollArea');
  setTimeout(() => { if (sc) sc.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

/* ── mobile render ── */
function calRenderMobile() {
  if (formatMode) { calRenderMobileFmt(); return; }
  calPruneDays();
  const days = calDisplayDays();
  const day = days[Math.min(calMobileDay, days.length - 1)];
  const key = calDateKey(day);

  const titleEl = $('calDayTitle');
  if (titleEl) titleEl.textContent = calFmtFull(day);

  const gridEl = $('calMobileGrid');
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
  dayCol.dataset.dateKey = key;
  calBuildLines(dayCol);
  calRenderDayCol(dayCol, key);

  body.appendChild(timeCol);
  body.appendChild(dayCol);
  gridEl.appendChild(body);
  setTimeout(() => { gridEl.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

function calRenderMobileFmt() {
  const dow = calFmtMobileDay;
  const titleEl = $('calDayTitle');
  if (titleEl) titleEl.textContent = `Template: ${CAL_DOW[dow]}`;

  const gridEl = $('calMobileGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const body = document.createElement('div');
  body.className = 'cal-mobile-body';
  body.style.width = '100%';

  const timeCol = document.createElement('div');
  timeCol.className = 'cal-mobile-time-col';
  calBuildTimeCol(timeCol);

  const dayCol = document.createElement('div');
  dayCol.className = 'cal-mobile-day-col cal-fmt-col';
  dayCol.dataset.dow = dow;
  calBuildLines(dayCol);
  calRenderFmtCol(dayCol, dow);

  body.appendChild(timeCol);
  body.appendChild(dayCol);
  gridEl.appendChild(body);
  setTimeout(() => { gridEl.scrollTop = 7 * CAL_HOUR_PX; }, 50);
}

function calNavDay(dir) {
  if (formatMode) {
    calFmtMobileDay = Math.max(0, Math.min(6, calFmtMobileDay + dir));
    calRenderMobileFmt();
  } else {
    calMobileDay = Math.max(0, Math.min(6, calMobileDay + dir));
    calRenderMobile();
  }
}

function calToggleDesktop() {
  if (!calDesktopOpen && homeDesktopOpen) homeToggleDesktop(false);
  calDesktopOpen = !calDesktopOpen;
  const panel   = $('calDesktopPanel');
  const tab     = $('calDesktopNavTab');
  const rp      = $('rightPanel');
  const weekBtn = $('calWeekModeBtn');
  if (panel)   panel.classList.toggle('active', calDesktopOpen);
  if (tab)     tab.classList.toggle('active', calDesktopOpen);
  if (rp)      rp.style.display = calDesktopOpen ? 'none' : '';
  if (weekBtn) weekBtn.classList.toggle('shown', calDesktopOpen);
  if (calDesktopOpen) calRenderDesktop();
}

function calToggleWeekMode() {
  calWeekMode = calWeekMode === 'rolling' ? 'fixed' : 'rolling';
  const btn = $('calWeekModeBtn');
  if (btn) btn.textContent = calWeekMode === 'fixed' ? 'Rolling week' : 'Sun – Sat';
  if (calDesktopOpen) calRenderDesktop();
}

function calRefresh() {
  if (calDesktopOpen) calRenderDesktop();
  if (document.querySelector('.mobile-app') && getComputedStyle($('mobileApp')).display !== 'none') {
    calRenderMobile();
  }
}

function calTickNow() {
  if (!formatMode) {
    document.querySelectorAll('.cal-day-col, .cal-mobile-day-col').forEach(col => {
      if (col.dataset.dateKey === calDateKey(calToday())) calBuildNowLine(col);
    });
  }
  setTimeout(calTickNow, 60000);
}

/* ── EVENT MODAL — state fully re-initialized on every open ── */
function renderColorSwatches() {
  const swatchEl = $('calColorSwatches');
  swatchEl.innerHTML = '';
  CAL_COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'cal-color-dot' + (c.toLowerCase() === calSelectedColor.toLowerCase() ? ' selected' : '');
    dot.style.background = c;
    dot.onclick = () => {
      calSelectedColor = c;
      document.querySelectorAll('.cal-color-dot').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
    };
    swatchEl.appendChild(dot);
  });
}

function setCalEventType(type) {
  calEditType = type;
  $('calTypeEvent').classList.toggle('active', type === 'event');
  $('calTypeDivider').classList.toggle('active', type === 'divider');
  $('calEventEndField').style.visibility = type === 'divider' ? 'hidden' : 'visible';
}

function _initCalModal({ isFmt, existingEv, defaultStart }) {
  // 1. type — always re-set
  setCalEventType(existingEv ? (existingEv.type || 'event') : 'event');

  // 2. fields — always re-set
  if (existingEv) {
    $('calEventTitle').value = existingEv.title || '';
    $('calEventStart').value = existingEv.start || '09:00';
    $('calEventEnd').value   = existingEv.end   || '10:00';
    calSelectedColor = existingEv.color || CAL_COLORS[0];
  } else {
    $('calEventTitle').value = '';
    $('calEventStart').value = defaultStart || '09:00';
    $('calEventEnd').value   = defaultStart
      ? calMinsToStr(Math.min(1439, calTimeToMins(defaultStart) + 60))
      : '10:00';
    calSelectedColor = CAL_COLORS[0];
  }

  // 3. swatches — rebuilt with current selection
  renderColorSwatches();

  // 4. dow repeat row (format mode only)
  const dowRow = $('calDowRow');
  dowRow.classList.toggle('shown', isFmt);
  dowRow.innerHTML = '';
  if (isFmt) {
    const lbl = document.createElement('span');
    lbl.className = 'cal-event-label';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Repeats';
    dowRow.appendChild(lbl);
    const repeats = (existingEv && existingEv.repeatDays) ? existingEv.repeatDays : [calEditDow ?? 0];
    CAL_DOW.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'cal-dow-btn' + (repeats.includes(i) ? ' active' : '');
      btn.textContent = name[0];
      btn.dataset.dow = i;
      btn.onclick = () => btn.classList.toggle('active');
      dowRow.appendChild(btn);
    });
  }

  // 5. title + buttons
  $('calEventModalTitle').textContent = existingEv
    ? (isFmt ? 'Edit template' : 'Edit event')
    : (isFmt ? 'Add template'  : 'Add event');
  $('calEventDeleteBtn').classList.toggle('shown', !!existingEv);

  const sendBtn = $('calSendToGcalBtn');
  const showSend = !!existingEv && gcalIsConnected() && !isFmt
    && (existingEv.type || 'event') !== 'divider' && !existingEv.gcalId;
  sendBtn.classList.toggle('shown', showSend);
  sendBtn.textContent = 'Send to Google Calendar';
  sendBtn.disabled = false;
  sendBtn.style.color = '';

  $('calEventModal').classList.add('show');
  setTimeout(() => $('calEventTitle').focus(), 60);
}

function openCalModal(dateKey, evId, defaultStart) {
  if (gcalIsConnected()) gcalReconcileDay(dateKey, Object.keys(gcalEvents).length > 0);
  calEditDate = dateKey;
  calEditDow  = null;
  calEditId   = (evId !== undefined && evId !== null) ? evId : null;
  const existingEv = (calEvents[dateKey] || []).find(e => e.id === evId) || null;
  _initCalModal({ isFmt: false, existingEv, defaultStart });
}

function openCalModalFmt(dow, evId, defaultStart) {
  calEditDow  = dow;
  calEditDate = null;
  calEditId   = (evId !== undefined && evId !== null) ? evId : null;
  const existingTmpl = (evId !== null && evId !== undefined)
    ? calTemplates.find(t => t.id === evId) || null
    : null;
  _initCalModal({ isFmt: true, existingEv: existingTmpl, defaultStart });
}

function closeCalModal() {
  $('calEventModal').classList.remove('show');
  calEditId = null;
  calEditDate = null;
  calEditDow = null;
}

/* ── save / delete (GCal hooks integrated) ── */
async function saveCalEvent() {
  const title = $('calEventTitle').value.trim();
  const start = $('calEventStart').value || '09:00';
  const end   = calEditType === 'divider' ? start : ($('calEventEnd').value || '10:00');

  const wasNew  = (calEditId === null || calEditId === undefined);
  const dateKey = calEditDate;
  const oldEvId = calEditId;
  const isFmt   = (calEditDow !== null) || (formatMode && calEditDate === null);

  if (isFmt) {
    /* template save */
    const dowBtns = document.querySelectorAll('#calDowRow .cal-dow-btn.active');
    const repeatDays = Array.from(dowBtns).map(b => parseInt(b.dataset.dow));
    const tmplId = wasNew ? calEventIdCtr++ : calEditId;
    const tmpl = {
      id: tmplId, title, start, end,
      color: calSelectedColor, type: calEditType,
      isTemplate: true, repeatDays,
    };
    const tIdx = calTemplates.findIndex(t => t.id === tmplId);
    if (tIdx >= 0) calTemplates[tIdx] = tmpl;
    else calTemplates.push(tmpl);
    reseedTemplate(tmpl);
  } else {
    /* user event save */
    const key = dateKey;
    calEnsureDay(key);
    if (!wasNew) {
      const idx = calEvents[key].findIndex(e => e.id === calEditId);
      if (idx >= 0) {
        const old = calEvents[key][idx];
        calEvents[key][idx] = {
          id: calEditId, title, start, end,
          color: calSelectedColor, type: calEditType,
          fromTemplate: old.fromTemplate || false,
          templateId:   old.templateId ?? undefined,
          gcalId:       old.gcalId ?? null,
          gcalCalId:    old.gcalCalId ?? null,
        };
      }
    } else {
      calEvents[key].push({
        id: calEventIdCtr++, title, start, end,
        color: calSelectedColor, type: calEditType,
      });
    }
  }

  closeCalModal();
  calRefresh();
  calSave();
  saveToLocal();

  /* GCal push (user mode, non-divider only) */
  if (!isFmt && gcalIsConnected() && dateKey) {
    const ev = wasNew
      ? calEvents[dateKey][calEvents[dateKey].length - 1]
      : (calEvents[dateKey] || []).find(e => e.id === oldEvId);
    if (ev && ev.type !== 'divider') {
      const calId = gcalCalendars.find(c => c.enabled)?.id;
      if (calId) {
        if (wasNew) {
          const gcalId = await gcalPushEvent(ev, dateKey, calId);
          if (gcalId) { ev.gcalId = gcalId; ev.gcalCalId = calId; }
        } else if (ev.gcalId) {
          await gcalUpdateEvent(ev.gcalId, ev.gcalCalId || calId, ev, dateKey);
        }
        await gcalSyncAll();
      }
    }
  }
}

async function deleteCalEvent() {
  let removedEv = null;
  if (calEditDow !== null) {
    calTemplates = calTemplates.filter(t => t.id !== calEditId);
    Object.keys(calEvents).forEach(k => {
      calEvents[k] = calEvents[k].filter(e => e.templateId !== calEditId);
    });
  } else if (calEditDate) {
    removedEv = (calEvents[calEditDate] || []).find(e => e.id === calEditId) || null;
    calEvents[calEditDate] = (calEvents[calEditDate] || []).filter(e => e.id !== calEditId);
  }
  closeCalModal();
  calRefresh();
  calSave();
  saveToLocal();

  if (removedEv?.gcalId && removedEv?.gcalCalId && gcalIsConnected()) {
    await gcalDeleteEvent(removedEv.gcalId, removedEv.gcalCalId);
    await gcalSyncAll();
  }
}

async function calSendToGcal() {
  if (!gcalIsConnected() || !calEditDate || calEditId === null) return;
  const ev = (calEvents[calEditDate] || []).find(e => e.id === calEditId);
  if (!ev || ev.type === 'divider' || ev.gcalId) return;
  const calId = gcalCalendars.find(c => c.enabled)?.id;
  if (!calId) { showToast('No Google Calendar enabled.'); return; }

  const btn = $('calSendToGcalBtn');
  btn.textContent = 'Sending…';
  btn.disabled = true;

  const gcalId = await gcalPushEvent(ev, calEditDate, calId);
  if (gcalId) {
    ev.gcalId = gcalId;
    ev.gcalCalId = calId;
    calSave();
    btn.textContent = '✓ Sent!';
    setTimeout(() => btn.classList.remove('shown'), 1200);
    await gcalSyncAll();
    showToast('Sent to Google Calendar ✓');
  } else {
    btn.textContent = 'Send to Google Calendar';
    btn.disabled = false;
  }
}

/* ───────────────────────── GOOGLE CALENDAR ───────────────────────── */
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

function gcalConnect() {
  const params = new URLSearchParams({
    client_id:     GCAL_CLIENT_ID,
    redirect_uri:  GCAL_REDIRECT,
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

function gcalHandleRedirect() {
  const hash = window.location.hash.slice(1);
  if (!hash.includes('access_token')) return;
  const params = new URLSearchParams(hash);
  const token = params.get('access_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600');
  if (!token) return;
  gcalSaveToken({ access_token: token, expires_at: Date.now() + expiresIn * 1000 });
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

async function gcalFetchCalendars() {
  if (!gcalIsConnected()) return;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${gcalToken.access_token}` }
    });
    const data = await res.json();
    if (!data.items) return;
    const saved = {};
    gcalCalendars.forEach(c => { saved[c.id] = c.enabled; });
    gcalCalendars = data.items.map(c => ({
      id: c.id,
      summary: c.summary,
      color: c.backgroundColor || '#378ADD',
      enabled: saved[c.id] !== undefined ? saved[c.id] : true,
    }));
    gcalSaveCals();
    gcalRenderCalList();
  } catch(e) { showToast('Could not fetch calendars.'); }
}

async function gcalSyncAll() {
  if (!gcalIsConnected() || gcalSyncing) return;
  gcalSyncing = true;
  gcalUpdateSyncBtn();

  const days = calDisplayDays();
  const timeMin = new Date(days[0]); timeMin.setHours(0,0,0,0);
  const timeMax = new Date(days[days.length-1]); timeMax.setHours(23,59,59,999);
  const enabledCals = gcalCalendars.filter(c => c.enabled);

  gcalEvents = {};

  try {
    await Promise.all(enabledCals.map(async cal => {
      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
        { headers: { Authorization: `Bearer ${gcalToken.access_token}` } }
      );
      const data = await res.json();
      if (!data.items) return;
      data.items.forEach(ev => {
        if (!ev.start) return;

        /* parse in LOCAL timezone (UTC slicing caused mismatches) */
        let localDateKey, startLocal, endLocal, allDay;
        if (ev.start.dateTime) {
          const sd = new Date(ev.start.dateTime);
          const ed = new Date(ev.end?.dateTime || ev.start.dateTime);
          localDateKey = `${sd.getFullYear()}-${String(sd.getMonth()+1).padStart(2,'0')}-${String(sd.getDate()).padStart(2,'0')}`;
          startLocal = `${String(sd.getHours()).padStart(2,'0')}:${String(sd.getMinutes()).padStart(2,'0')}`;
          endLocal   = `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}`;
          allDay = false;
        } else {
          localDateKey = (ev.start.date || '').slice(0, 10);
          startLocal = '00:00';
          endLocal   = '23:59';
          allDay = true;
        }
        if (!localDateKey) return;

        if (!gcalEvents[localDateKey]) gcalEvents[localDateKey] = [];
        gcalEvents[localDateKey].push({
          gcalId:   ev.id,
          calId:    cal.id,
          calName:  cal.summary,
          calColor: cal.color,
          title:    ev.summary || '(no title)',
          start:    startLocal,
          end:      endLocal,
          allDay,
          htmlLink: ev.htmlLink,
          color:    cal.color,
        });
      });
    }));
  } catch(e) { showToast('Sync error — check connection.'); }

  gcalSyncing = false;
  gcalUpdateSyncBtn();
  gcalReconcile();
  calRefresh();
  calSave();
}

/* ── reconcile: derive sync status purely from title+start+end matching ── */
function gcalReconcileDay(dateKey, canClear) {
  const localEvs = calEvents[dateKey] || [];
  const gcalEvs  = gcalEvents[dateKey] || [];
  const claimed = new Set();
  localEvs.forEach(localEv => {
    if (localEv.type === 'divider') return;
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
    } else if (canClear) {
      localEv.gcalId    = null;
      localEv.gcalCalId = null;
    }
  });
}

function gcalReconcile() {
  const canClear = Object.keys(gcalEvents).length > 0;
  calDisplayDays().map(calDateKey).forEach(k => gcalReconcileDay(k, canClear));
  calSave();
}

/* ── push / update / delete ── */
async function gcalPushEvent(ev, dateKey, calId) {
  if (!gcalIsConnected()) return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    summary: ev.title,
    start: { dateTime: `${dateKey}T${ev.start}:00`, timeZone: tz },
    end:   { dateTime: `${dateKey}T${ev.end}:00`,   timeZone: tz },
  };
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      { method: 'POST',
        headers: { Authorization: `Bearer ${gcalToken.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) }
    );
    const data = await res.json();
    return data.id || null;
  } catch(e) { showToast('Could not push event to GCal.'); return null; }
}

async function gcalUpdateEvent(gcalId, calId, ev, dateKey) {
  if (!gcalIsConnected() || !gcalId) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    summary: ev.title,
    start: { dateTime: `${dateKey}T${ev.start}:00`, timeZone: tz },
    end:   { dateTime: `${dateKey}T${ev.end}:00`,   timeZone: tz },
  };
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${gcalId}`,
      { method: 'PUT',
        headers: { Authorization: `Bearer ${gcalToken.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) }
    );
  } catch(e) { showToast('Could not update GCal event.'); }
}

async function gcalDeleteEvent(gcalId, calId) {
  if (!gcalIsConnected() || !gcalId) return false;
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${gcalId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${gcalToken.access_token}` } }
    );
    // 200/204 = deleted; 404/410 = already gone, also fine.
    return res.ok || res.status === 404 || res.status === 410;
  } catch(e) { return false; }
}

function gcalDisconnect() {
  gcalToken = null;
  gcalEvents = {};
  localStorage.removeItem(GCAL_LS_KEY);
  gcalUpdateBtn();
  closeModal('gcalModal');
  calRefresh();
  showToast('Disconnected from Google Calendar');
}

/* ── GCal events on the grid (read-only, right half of column) ── */
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
  el.style.touchAction = 'auto';   // not draggable

  const t = document.createElement('div');
  t.style.cssText = 'font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  t.textContent = ev.title;
  const badge = document.createElement('div');
  badge.className = 'cal-event-time gcal-badge';
  badge.style.color = ev.color;
  badge.textContent = ev.calName;
  el.appendChild(t);
  el.appendChild(badge);

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

/* ── GCal detail modal ── */
function gcalOpenEventDetail(ev) {
  const modal = $('gcalDetailModal');
  $('gcalDetailTitle').textContent = ev.title;
  $('gcalDetailCal').textContent   = ev.calName;
  $('gcalDetailCal').style.color   = ev.color;
  $('gcalDetailTime').textContent  = ev.allDay ? 'All day' : `${calFmtTime(ev.start)} – ${calFmtTime(ev.end)}`;
  $('gcalDetailLink').href         = ev.htmlLink || '#';
  modal.dataset.gcalId = ev.gcalId;
  modal.dataset.calId  = ev.calId;
  modal._gcalEv = ev;

  const syncBtn = $('gcalSyncToAppBtn');
  const alreadyLocal = !ev.allDay && calDisplayDays().some(day => {
    const key = calDateKey(day);
    return (calEvents[key] || []).some(e => e.gcalId === ev.gcalId);
  });
  syncBtn.classList.toggle('shown', !ev.allDay && !alreadyLocal);
  syncBtn.textContent = 'Sync to app';
  syncBtn.disabled = false;

  // Delete is available for any real GCal event while connected.
  const delBtn = $('gcalDetailDeleteBtn');
  delBtn.classList.toggle('shown', gcalIsConnected() && !!ev.gcalId);
  delBtn.textContent = 'Delete from Google Calendar';
  delBtn.disabled = false;

  modal.classList.add('show');
}

function gcalSyncToApp() {
  const modal = $('gcalDetailModal');
  const ev = modal._gcalEv;
  if (!ev || ev.allDay) return;

  let foundKey = null;
  Object.entries(gcalEvents).forEach(([k, evs]) => {
    if (evs.some(e => e.gcalId === ev.gcalId)) foundKey = k;
  });
  if (!foundKey) { showToast('Could not find event date.'); return; }

  calEnsureDay(foundKey);
  calEvents[foundKey].push({
    id: calEventIdCtr++,
    title: ev.title, start: ev.start, end: ev.end,
    color: CAL_COLORS[0], type: 'event', fromTemplate: false,
    gcalId: ev.gcalId, gcalCalId: ev.calId,
  });
  calSave();
  saveToLocal();
  calRefresh();

  const syncBtn = $('gcalSyncToAppBtn');
  syncBtn.textContent = '✓ Synced!';
  syncBtn.disabled = true;
  setTimeout(() => closeModal('gcalDetailModal'), 1000);
  showToast('Event added to app ✓');
}

async function gcalDeleteFromDetail() {
  const modal = $('gcalDetailModal');
  const gcalId = modal.dataset.gcalId;
  const calId  = modal.dataset.calId;
  if (!gcalId || !calId) return;

  const ev = modal._gcalEv;
  const title = ev?.title || 'this event';
  if (!confirm(`Delete "${title}" from Google Calendar? This can't be undone.`)) return;

  const delBtn = $('gcalDetailDeleteBtn');
  delBtn.textContent = 'Deleting…';
  delBtn.disabled = true;

  const ok = await gcalDeleteEvent(gcalId, calId);
  if (!ok) {
    delBtn.textContent = 'Delete from Google Calendar';
    delBtn.disabled = false;
    showToast('Could not delete — check connection and try again.');
    return;
  }

  // Remove any local copy linked to this GCal event so no orphan remains.
  Object.keys(calEvents).forEach(key => {
    calEvents[key] = (calEvents[key] || []).filter(e => e.gcalId !== gcalId);
  });
  calSave();
  saveToLocal();

  closeModal('gcalDetailModal');
  await gcalSyncAll();
  showToast('Event deleted from Google Calendar ✓');
}

/* ── GCal calendars modal ── */
function gcalOpenModal() {
  gcalRenderCalList();
  $('gcalModal').classList.add('show');
}
function gcalRenderCalList() {
  const list = $('gcalCalList');
  if (!list) return;
  list.innerHTML = '';
  if (!gcalCalendars.length) {
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--ink-3);font-size:12px';
    d.textContent = 'No calendars found.';
    list.appendChild(d);
    return;
  }
  gcalCalendars.forEach((cal, idx) => {
    const row = document.createElement('div');
    row.className = 'gcal-cal-row';
    row.innerHTML = `
      <div class="gcal-cal-dot" style="background:${cal.color}"></div>
      <span class="gcal-cal-name">${escAttr(cal.summary)}</span>
      <label class="gcal-toggle">
        <input type="checkbox" ${cal.enabled ? 'checked' : ''} onchange="gcalToggleCal(${idx}, this.checked)">
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

function gcalUpdateBtn() {
  const btn = $('gcalConnectBtn');
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
  const btn = $('gcalSyncBtn');
  if (!btn) return;
  btn.textContent = gcalSyncing ? 'Syncing…' : 'Sync now';
  btn.disabled = gcalSyncing;
}

/* ───────────────────────── STATIC BINDINGS ───────────────────────── */
function bindStatic() {
  /* wakeup */
  $('wakeupRow-d')?.addEventListener('click', toggleWakeup);
  $('wakeupRow-m')?.addEventListener('click', toggleWakeup);

  /* calendar nav */
  $('calDesktopNavTab')?.addEventListener('click', calToggleDesktop);
  $('homeDesktopNavTab')?.addEventListener('click', () => homeToggleDesktop());
  $('calWeekModeBtn')?.addEventListener('click', e => { e.stopPropagation(); calToggleWeekMode(); });
  $('calNavPrev')?.addEventListener('click', () => calNavDay(-1));
  $('calNavNext')?.addEventListener('click', () => calNavDay(1));

  /* tabs */
  [0,1,2,3,4].forEach(i => $(`tab-${i}`)?.addEventListener('click', () => goTab(i, true)));

  /* add buttons */
  $('addTimerBtn-d')?.addEventListener('click', addFormatTimer);
  $('addTimerBtn-m')?.addEventListener('click', addFormatTimer);
  $('addDailyBtn')?.addEventListener('click', addFormatDaily);
  $('addDailyBtn-m')?.addEventListener('click', addFormatDaily);
  $('dbdAddBtn-d')?.addEventListener('click', () => addDbdTask('d'));
  $('dbdAddBtn-m')?.addEventListener('click', () => addDbdTask('m'));
  $('addListBtn-d')?.addEventListener('click', addTodoList);
  $('addListBtn-m')?.addEventListener('click', addTodoList);

  /* data bar */
  $('fmtBtn')?.addEventListener('click', toggleFormatMode);
  $('exportBtn')?.addEventListener('click', openExportModal);
  $('importBtn')?.addEventListener('click', openImportModal);
  $('resetAllBtn')?.addEventListener('click', () => $('confirmOverlay').classList.add('show'));
  $('clearStorageBtn')?.addEventListener('click', confirmClearStorage);

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

  /* gcal modals */
  $('gcalDisconnectBtn')?.addEventListener('click', gcalDisconnect);
  $('gcalSyncBtn')?.addEventListener('click', gcalSyncAll);
  $('gcalDetailDeleteBtn')?.addEventListener('click', gcalDeleteFromDetail);
  $('gcalSyncToAppBtn')?.addEventListener('click', gcalSyncToApp);

  /* modal-x close buttons */
  document.querySelectorAll('.modal-x[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  /* backdrop click closes any modal */
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => {
      if (e.target !== ov) return;
      if (ov.id === 'calEventModal') closeCalModal();
      else ov.classList.remove('show');
    });
  });

  /* Escape closes the topmost open modal */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('.modal-overlay.show')).pop();
    if (!open) return;
    if (open.id === 'calEventModal') closeCalModal();
    else open.classList.remove('show');
  });

  /* resize */
  let _rt;
  window.addEventListener('resize', () => {
    clearTimeout(_rt);
    _rt = setTimeout(setSwipePanelWidths, 80);
  });
}

/* ───────────────────────── INIT ───────────────────────── */
(function init() {
  loadFromLocal();
  calLoad();
  calPruneDays();

  bindStatic();
  initSwipe();

  renderTimers();
  renderTodos();
  homeToggleDesktop(true);   // desktop lands on Home; toggle back via nav
  _dbdDayKey = dbdTodayKey();
  ['d','m'].forEach(pfx => { const el = $(`dbdDate-${pfx}`); if (el && !el.value) el.value = _dbdDayKey; });
  renderDbd();
  syncWakeupUI();
  setSwipePanelWidths();
  updateTimerSummary();
  tickAll();
  calRenderMobile();
  calTickNow();

  /* autosave */
  setInterval(saveToLocal, 2000);
  /* day-by-day midnight rollover (also fires after device sleep) */
  setInterval(dbdCheckRollover, 30 * 1000);
  /* home page: keep the 4-hour calendar window and date current */
  setInterval(renderHome, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') dbdCheckRollover();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveToLocal();
  });
  window.addEventListener('pagehide', saveToLocal);

  /* gcal */
  gcalLoadToken();
  gcalLoadCals();
  gcalHandleRedirect();
  gcalUpdateBtn();
  if (gcalIsConnected()) gcalSyncAll();
  setInterval(() => { if (gcalIsConnected()) gcalSyncAll(); }, 5 * 60 * 1000);
})();
