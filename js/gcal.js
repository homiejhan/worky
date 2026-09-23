/* gcal.js — Google Calendar: connect, fetch, reconcile, push/update/delete, and its
 * modals. */
import {
  CAL_COLORS, GCAL_CAL_LS_KEY, GCAL_CLIENT_ID, GCAL_LS_KEY, GCAL_REDIRECT, GCAL_SCOPES,
  SYNC_STATE_TAG,
} from './config.js';
import { $, calDateKey, calFmtTime, calMinsToStr, closeModal, escAttr, showToast } from './util.js';
import { saveToLocal } from './persistence.js';
import { renderTodos } from './lists.js';
import { renderDbd } from './dbd.js';
import {
  calColorHidden, calDisplayDays, calEnsureDay, calEvents, calPlaceEventEl, calRefresh, calSave,
  nextCalEventId,
} from './calendar.js';
import { normalizeWage } from './shifts.js';

/* gcal state */
let gcalToken     = null;
export let gcalCalendars = [];
export let gcalEvents    = {};
let gcalSyncing   = false;

/* Shift settings per Google calendar, synced with the rest of the state:
 * { calId: { shift?: true | false, wage?: dollars an hour } }. A calendar with
 * no entry is judged by its name (see shifts.js). */
export let shiftCals = {};
export function setShiftCals(v) { shiftCals = v; }
export function normalizeShiftCals(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  Object.entries(v).forEach(([id, c]) => {
    if (!id || !c || typeof c !== 'object') return;
    const e = {};
    if (typeof c.shift === 'boolean') e.shift = c.shift;
    const w = normalizeWage(c.wage);
    if (w !== null) e.wage = w;
    if (Object.keys(e).length) out[id] = e;
  });
  return out;
}
/* Google calendars the way shifts.js reads them: { calId: { name, shift?, wage? } }.
 * A setting outlives a hidden or disconnected calendar, so a Focus copy of one
 * of its events still finds its wage. */
export function gcalShiftCalendars() {
  const out = {};
  Object.entries(shiftCals).forEach(([id, c]) => { out[id] = { ...c }; });
  gcalCalendars.forEach(c => { out[c.id] = { ...(out[c.id] || {}), name: c.summary }; });
  return out;
}
/* ───────────────────────── GOOGLE CALENDAR ───────────────────────── */
function gcalSaveToken(t) {
  gcalToken = t;
  try { localStorage.setItem(GCAL_LS_KEY, JSON.stringify(t)); } catch(e) {}
}
export function gcalLoadToken() {
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
export function gcalLoadCals() {
  try {
    const raw = localStorage.getItem(GCAL_CAL_LS_KEY);
    if (raw) gcalCalendars = JSON.parse(raw);
  } catch(e) {}
}
export function gcalIsConnected() { return !!(gcalToken && Date.now() < gcalToken.expires_at); }

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

export function gcalHandleRedirect() {
  const hash = window.location.hash.slice(1);
  if (!hash.includes('access_token')) return;
  const params = new URLSearchParams(hash);
  if (params.get('state') === SYNC_STATE_TAG) return;   // handled by syncHandleRedirect
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

export async function gcalSyncAll() {
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
          localDateKey = calDateKey(sd);
          startLocal = calMinsToStr(sd.getHours() * 60 + sd.getMinutes());
          endLocal   = calMinsToStr(ed.getHours() * 60 + ed.getMinutes());
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
export function gcalReconcileDay(dateKey, canClear) {
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
/* Request body for creating or updating `ev` on `dateKey`, in this device's time zone. */
function gcalEventBody(ev, dateKey) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return JSON.stringify({
    summary: ev.title,
    start: { dateTime: `${dateKey}T${ev.start}:00`, timeZone },
    end:   { dateTime: `${dateKey}T${ev.end}:00`,   timeZone },
  });
}

export async function gcalPushEvent(ev, dateKey, calId) {
  if (!gcalIsConnected()) return null;
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      { method: 'POST',
        headers: { Authorization: `Bearer ${gcalToken.access_token}`, 'Content-Type': 'application/json' },
        body: gcalEventBody(ev, dateKey) }
    );
    const data = await res.json();
    return data.id || null;
  } catch(e) { showToast('Could not push event to GCal.'); return null; }
}

export async function gcalUpdateEvent(gcalId, calId, ev, dateKey) {
  if (!gcalIsConnected() || !gcalId) return;
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${gcalId}`,
      { method: 'PUT',
        headers: { Authorization: `Bearer ${gcalToken.access_token}`, 'Content-Type': 'application/json' },
        body: gcalEventBody(ev, dateKey) }
    );
  } catch(e) { showToast('Could not update GCal event.'); }
}

export async function gcalDeleteEvent(gcalId, calId) {
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

export function gcalDisconnect() {
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
  calPlaceEventEl(el, ev);
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

export function gcalInjectEvents(col, dateKey) {
  col.querySelectorAll('.gcal-event').forEach(e => e.remove());
  if (!gcalIsConnected()) return;
  (gcalEvents[dateKey] || []).forEach(ev => {
    if (!ev.allDay && !calColorHidden(ev.color)) col.appendChild(gcalMakeEventEl(ev));
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

export function gcalSyncToApp() {
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
    id: nextCalEventId(),
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

export async function gcalDeleteFromDetail() {
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
  renderTodos();
  renderDbd();

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
export function gcalToggleCal(idx, enabled) {
  gcalCalendars[idx].enabled = enabled;
  gcalSaveCals();
  gcalSyncAll();
}

export function gcalUpdateBtn() {
  const btn = $('gcalConnectBtn');
  if (!btn) return;
  if (gcalIsConnected()) {
    btn.textContent = 'Manage Google Calendars';
    btn.classList.add('connected');
    btn.onclick = gcalOpenModal;
  } else {
    btn.textContent = 'Connect Google Calendar';
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
