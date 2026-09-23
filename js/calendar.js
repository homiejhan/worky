/* calendar.js — Calendar state, the week and day grids, event drag, the color filter and
 * the event editor. */
import { CAL_COLORS, CAL_DOW, CAL_HOUR_PX, CAL_LS_KEY, CAL_TOTAL_PX } from './config.js';
import {
  $, calDateKey, calFmtFull, calFmtShort, calFmtTime, calKeyToDate, calMinsToPx, calMinsToStr,
  calPxToMins, calTimeToMins, calToday, isMobileLayout, showToast,
} from './util.js';
import { saveToLocal } from './persistence.js';
import { renderTodos } from './lists.js';
import { hitTestAt, makeDrag } from './drag.js';
import { formatMode } from './formats.js';
import { renderDbd } from './dbd.js';
import {
  LINK_SVG, taskLinkAfterEventMoved, taskLinkApplyFromModal, taskLinkApplySelectToTitle,
  taskLinkEventDone, taskLinkEventTitle, taskLinkRefOfEvent, taskLinkRenderSelect,
  taskLinkSetOnEvent, taskLinkSyncTitles,
} from './tasklinks.js';
import { homeDesktopOpen, homeToggleDesktop } from './home.js';
import { desktopNavSync } from './views.js';
import {
  gcalCalendars, gcalDeleteEvent, gcalEvents, gcalInjectEvents, gcalIsConnected, gcalPushEvent,
  gcalReconcileDay, gcalSyncAll, gcalUpdateEvent,
} from './gcal.js';
import { budgetDesktopOpen, budgetToggleDesktop } from './budget.js';

/* calendar state */
export let calEvents       = {};   // { 'YYYY-MM-DD': [ev,...] }
export function setCalEvents(v) { calEvents = v; }
export let calTemplates    = [];
export function setCalTemplates(v) { calTemplates = v; }
export let calEventIdCtr   = 1;
export function setCalEventIdCtr(v) { calEventIdCtr = v; }
export function nextCalEventId() { return calEventIdCtr++; }
let calMobileDay    = 0;
export let calFmtMobileDay = 0;
export function setCalFmtMobileDay(v) { calFmtMobileDay = v; }
export let calDesktopOpen  = false;
let calWeekMode     = 'rolling';   // 'rolling' | 'fixed'
let calEditId   = null;
let calEditDate = null;
let calEditDow  = null;
let calEditType = 'event';
let calSelectedColor = CAL_COLORS[0];

/* calendar color-group visibility (events only — never dividers) */
const CAL_HIDDEN_LS_KEY = 'focus-cal-hidden-colors';
let calHiddenColors = new Set();
export function calLoadHiddenColors() {
  try {
    const raw = localStorage.getItem(CAL_HIDDEN_LS_KEY);
    if (raw) calHiddenColors = new Set(JSON.parse(raw).map(c => String(c).toLowerCase()));
  } catch(e) {}
}
function calSaveHiddenColors() {
  try { localStorage.setItem(CAL_HIDDEN_LS_KEY, JSON.stringify([...calHiddenColors])); } catch(e) {}
}
export function calColorHidden(c) {
  return !!c && calHiddenColors.has(String(c).toLowerCase());
}
function calRollingDays() {
  const t = calToday();
  return Array.from({length:7}, (_,i) => { const d = new Date(t); d.setDate(t.getDate()+i); return d; });
}
function calFixedWeekDays() {
  const t = calToday(); const dow = t.getDay();
  return Array.from({length:7}, (_,i) => { const d = new Date(t); d.setDate(t.getDate()-dow+i); return d; });
}
export function calDisplayDays() { return calWeekMode === 'fixed' ? calFixedWeekDays() : calRollingDays(); }

export function calSave() {
  try { localStorage.setItem(CAL_LS_KEY, JSON.stringify({ calEvents, calTemplates, calEventIdCtr })); } catch(e) {}
}
export function calLoad() {
  try {
    const raw = localStorage.getItem(CAL_LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.calEvents)     calEvents     = s.calEvents;
    if (s.calTemplates)  calTemplates  = s.calTemplates;
    if (s.calEventIdCtr) calEventIdCtr = s.calEventIdCtr;
  } catch(e) {}
}

/* ───────────────────────── CALENDAR ───────────────────────── */
export function calEnsureDay(key) {
  if (!calEvents[key]) {
    const dow = calKeyToDate(key).getDay();
    calEvents[key] = calTemplates
      .filter(t => t.repeatDays && t.repeatDays.includes(dow))
      .map(t => ({ ...t, id: calEventIdCtr++, fromTemplate: true, templateId: t.id }));
  }
}

export function calPruneDays() {
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
/* Position an event block on the day grid (never shorter than 15 minutes). */
export function calPlaceEventEl(el, ev) {
  const startM = calTimeToMins(ev.start);
  el.style.top    = calMinsToPx(startM) + 'px';
  el.style.height = calMinsToPx(Math.max(15, calTimeToMins(ev.end) - startM)) + 'px';
}

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
    el.dataset.evId = ev.id;
    calPlaceEventEl(el, ev);
    el.style.background = ev.color + '33';
    el.style.borderLeft = `3px solid ${ev.color}`;
    el.style.color = ev.color;
    const linked = !isFmtMode && !!taskLinkRefOfEvent(ev);
    const t = document.createElement('div');
    t.className = 'cal-event-title';
    t.style.cssText = 'font-weight:500;overflow:hidden;text-overflow:ellipsis';
    t.textContent = (linked ? taskLinkEventTitle(ev) : ev.title) || '(no title)';
    const time = document.createElement('div');
    time.className = 'cal-event-time';
    time.textContent = `${calFmtTime(ev.start)}–${calFmtTime(ev.end)}`;
    el.appendChild(t);
    el.appendChild(time);
    if (linked) {
      el.classList.add('cal-linked');
      if (taskLinkEventDone(ev)) el.classList.add('cal-linked-done');
      const ico = document.createElement('span');
      ico.className = 'cal-event-link-ico';
      ico.title = 'Linked to a task';
      ico.innerHTML = LINK_SVG;
      el.appendChild(ico);
    }
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
      const colRect  = col.getBoundingClientRect();   // already reflects the scroll position
      const mins = calPxToMins(ghostTop - colRect.top);

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

/* Where an event or template dropped at `startMins` lands: same length (at
 * least 15 minutes; dividers have none), kept inside the day. */
function calSlotAt(item, startMins) {
  const dur = item.type === 'divider' ? 0 : Math.max(15, calTimeToMins(item.end) - calTimeToMins(item.start));
  const start = Math.max(0, Math.min(1440 - dur, startMins));
  return { start: calMinsToStr(start), end: calMinsToStr(start + dur) };
}

function calMoveEvent(evId, fromKey, toKey, newStartMins) {
  const list = calEvents[fromKey] || [];
  const ev = list.find(e => e.id === evId);
  if (!ev) return;
  calEvents[fromKey] = list.filter(e => e.id !== evId);
  calEnsureDay(toKey);
  const moved = {
    ...ev,
    ...calSlotAt(ev, newStartMins),
    fromTemplate: toKey !== fromKey ? false : ev.fromTemplate,
  };
  calEvents[toKey].push(moved);
  calRefresh();
  calSave();
  taskLinkAfterEventMoved(moved, fromKey, toKey);
}

function calMoveTemplate(tmplId, fromDow, toDow, newStartMins) {
  const tmpl = calTemplates.find(t => t.id === tmplId);
  if (!tmpl) return;
  if (fromDow !== null && fromDow !== toDow) {
    tmpl.repeatDays = (tmpl.repeatDays || []).filter(d => d !== fromDow);
    if (!tmpl.repeatDays.includes(toDow)) tmpl.repeatDays.push(toDow);
  }
  Object.assign(tmpl, calSlotAt(tmpl, newStartMins));
  reseedTemplate(tmpl);
  calRefresh();
  calSave();
}

export function reseedTemplate(tmpl) {
  calDisplayDays().forEach(day => {
    const key = calDateKey(day);
    const dow = day.getDay();
    if (!calEvents[key]) return;
    // A template instance that's linked to a task keeps its link: it moves
    // onto the reseeded instance, or survives as a detached event if the
    // template no longer repeats on this day.
    const linkedOld = calEvents[key].find(e => e.templateId === tmpl.id && taskLinkRefOfEvent(e));
    calEvents[key] = calEvents[key].filter(e => e.templateId !== tmpl.id);
    if (tmpl.repeatDays && tmpl.repeatDays.includes(dow)) {
      const inst = { ...tmpl, id: calEventIdCtr++, fromTemplate: true, templateId: tmpl.id };
      if (linkedOld) { taskLinkSetOnEvent(inst, taskLinkRefOfEvent(linkedOld)); inst.title = linkedOld.title; }
      calEvents[key].push(inst);
    } else if (linkedOld) {
      calEvents[key].push({ ...linkedOld, fromTemplate: false, templateId: undefined });
    }
  });
}

/* ── day column renders ── */
function calRenderDayCol(col, dateKey) {
  col.querySelectorAll('.cal-event,.cal-divider,.cal-now-line').forEach(e => e.remove());
  calEnsureDay(dateKey);
  (calEvents[dateKey] || [])
    .filter(ev => ev.type === 'divider' || !calColorHidden(ev.color))
    .forEach(ev => col.appendChild(calMakeEventEl(ev, dateKey, false)));
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

/* ── color-group filter bar (events only — dividers are exempt) ── */
function calVisibleColorSet() {
  const colors = new Set();
  calDisplayDays().forEach(day => {
    const key = calDateKey(day);
    calEnsureDay(key);
    (calEvents[key] || []).forEach(ev => {
      if (ev.type !== 'divider' && ev.color) colors.add(String(ev.color).toLowerCase());
    });
    if (gcalIsConnected()) {
      (gcalEvents[key] || []).forEach(ev => {
        if (!ev.allDay && ev.color) colors.add(String(ev.color).toLowerCase());
      });
    }
  });
  return colors;
}

function calRenderColorFilter(el) {
  if (!el) return;
  el.innerHTML = '';
  if (formatMode) { el.style.display = 'none'; return; }
  const colors = [...calVisibleColorSet()];
  if (colors.length === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  colors.forEach(c => {
    const hidden = calHiddenColors.has(c);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cal-color-filter-chip' + (hidden ? ' off' : '');
    chip.style.setProperty('--chip-color', c);
    chip.title = hidden ? 'Show these events' : 'Hide these events';
    chip.addEventListener('click', e => {
      e.stopPropagation();
      if (calHiddenColors.has(c)) calHiddenColors.delete(c);
      else calHiddenColors.add(c);
      calSaveHiddenColors();
      if (calDesktopOpen) calRenderDesktop();
      calRenderMobile();
    });
    el.appendChild(chip);
  });
}

/* An hour-lined day column: { dateKey } for a real day, { dow } for a template day. */
function calDayColEl(className, data) {
  const col = document.createElement('div');
  col.className = className;
  Object.assign(col.dataset, data);
  calBuildLines(col);
  return col;
}
/* Scroll a grid to just before 7am once it has laid out. */
function calScrollToMorning(el) {
  setTimeout(() => { if (el) el.scrollTop = 7 * CAL_HOUR_PX - 14; }, 50);
}

/* ── desktop render: the 7-day week, or the template week while Formats is open ── */
export function calRenderDesktop() {
  const titleEl  = $('calDesktopTitle');
  const filterEl = $('calColorFilter-d');
  if (formatMode) {
    if (titleEl) titleEl.textContent = 'Template week — Sun through Sat';
    if (filterEl) filterEl.style.display = 'none';
  } else {
    calPruneDays();
    if (titleEl) titleEl.textContent = calFmtFull(calToday());
    calRenderColorFilter(filterEl);
  }

  const daysEl = $('calDesktopDays');
  const gridEl = $('calDesktopGrid');
  const timeEl = $('calTimeCol');
  if (!daysEl || !gridEl || !timeEl) return;

  daysEl.style.gridTemplateColumns = 'repeat(7,1fr)';
  daysEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = 'repeat(7,1fr)';
  gridEl.innerHTML = '';
  calBuildTimeCol(timeEl);

  const addHeader = (name, date, isToday) => {
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header' + (isToday ? ' today' : '');
    const hName = document.createElement('div');
    hName.textContent = name;
    hdr.appendChild(hName);
    if (date) {
      const hDate = document.createElement('div');
      hDate.className = 'cal-day-header-date';
      hDate.textContent = date;
      hdr.appendChild(hDate);
    }
    daysEl.appendChild(hdr);
  };

  if (formatMode) {
    CAL_DOW.forEach((name, dow) => {
      addHeader(name);
      const col = calDayColEl('cal-day-col cal-fmt-col', { dow });
      calRenderFmtCol(col, dow);
      gridEl.appendChild(col);
    });
  } else {
    const todayKey = calDateKey(calToday());
    calDisplayDays().forEach(day => {
      const key = calDateKey(day);
      const isToday = key === todayKey;
      addHeader(calFmtShort(day), day.getDate(), isToday);
      const col = calDayColEl('cal-day-col' + (isToday ? ' today-col' : ''), { dateKey: key });
      calRenderDayCol(col, key);
      gridEl.appendChild(col);
    });
  }

  gridEl.style.height = CAL_TOTAL_PX + 'px';
  calScrollToMorning($('calScrollArea'));
}

/* ── mobile render: one day, or one template day while Formats is open ── */
export function calRenderMobile() {
  const titleEl  = $('calDayTitle');
  const filterEl = $('calColorFilter-m');
  const gridEl   = $('calMobileGrid');
  let dayCol;
  if (formatMode) {
    const dow = calFmtMobileDay;
    if (titleEl) titleEl.textContent = `Template: ${CAL_DOW[dow]}`;
    if (filterEl) filterEl.style.display = 'none';
    if (!gridEl) return;
    dayCol = calDayColEl('cal-mobile-day-col cal-fmt-col', { dow });
    calRenderFmtCol(dayCol, dow);
  } else {
    calPruneDays();
    const days = calDisplayDays();
    const day = days[Math.min(calMobileDay, days.length - 1)];
    const key = calDateKey(day);
    if (titleEl) titleEl.textContent = calFmtFull(day);
    calRenderColorFilter(filterEl);
    if (!gridEl) return;
    dayCol = calDayColEl('cal-mobile-day-col', { dateKey: key });
    calRenderDayCol(dayCol, key);
  }

  gridEl.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'cal-mobile-body';
  body.style.width = '100%';
  const timeCol = document.createElement('div');
  timeCol.className = 'cal-mobile-time-col';
  calBuildTimeCol(timeCol);
  body.appendChild(timeCol);
  body.appendChild(dayCol);
  gridEl.appendChild(body);
  calScrollToMorning(gridEl);
}

export function calNavDay(dir) {
  if (formatMode) calFmtMobileDay = Math.max(0, Math.min(6, calFmtMobileDay + dir));
  else            calMobileDay    = Math.max(0, Math.min(6, calMobileDay + dir));
  calRenderMobile();
}

export function calToggleDesktop() {
  if (!calDesktopOpen && homeDesktopOpen) homeToggleDesktop(false);
  if (!calDesktopOpen && budgetDesktopOpen) budgetToggleDesktop(false);
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
  desktopNavSync();
}

export function calToggleWeekMode() {
  calWeekMode = calWeekMode === 'rolling' ? 'fixed' : 'rolling';
  const btn = $('calWeekModeBtn');
  if (btn) btn.textContent = calWeekMode === 'fixed' ? 'Rolling week' : 'Sun – Sat';
  if (calDesktopOpen) calRenderDesktop();
}

export function calRefresh() {
  if (taskLinkSyncTitles()) calSave();
  if (calDesktopOpen) calRenderDesktop();
  if (isMobileLayout()) calRenderMobile();
}

export function calTickNow() {
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

export function setCalEventType(type) {
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

  // 4b. task link picker (user events only — templates repeat, tasks don't)
  const linkRow = $('calLinkRow');
  if (linkRow) {
    linkRow.classList.toggle('shown', !isFmt);
    if (!isFmt) taskLinkRenderSelect(existingEv ? taskLinkRefOfEvent(existingEv) : null);
    else { $('calLinkSelect').innerHTML = ''; taskLinkApplySelectToTitle(); }
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

export function openCalModal(dateKey, evId, defaultStart) {
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

export function closeCalModal() {
  $('calEventModal').classList.remove('show');
  calEditId = null;
  calEditDate = null;
  calEditDow = null;
}

/* ── save / delete (GCal hooks integrated) ── */
export async function saveCalEvent() {
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
          ...(old.linkTaskId != null ? { linkTaskId: old.linkTaskId } : {}),
          ...(old.linkDbdId  != null ? { linkDbdId:  old.linkDbdId  } : {}),
        };
      }
    } else {
      calEvents[key].push({
        id: calEventIdCtr++, title, start, end,
        color: calSelectedColor, type: calEditType,
      });
    }
    // Task link chosen in the picker (dividers can't be linked).
    const savedEv = wasNew
      ? calEvents[key][calEvents[key].length - 1]
      : calEvents[key].find(e => e.id === calEditId);
    if (savedEv) {
      if (calEditType === 'divider') taskLinkSetOnEvent(savedEv, null);
      else taskLinkApplyFromModal(savedEv, key);
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

export async function deleteCalEvent() {
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
  renderTodos();   // linked tasks lose their chip
  renderDbd();

  if (removedEv?.gcalId && removedEv?.gcalCalId && gcalIsConnected()) {
    await gcalDeleteEvent(removedEv.gcalId, removedEv.gcalCalId);
    await gcalSyncAll();
  }
}

export async function calSendToGcal() {
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
