/* shifts.js — Which calendar events are paid shifts, how long they run and what
 * they pay. Pure functions: nothing here reads the DOM or app state, so tests
 * import this file directly and the calendar passes its events in. */

/* Scheduling apps whose schedules a student subscribes to in Google Calendar as
 * an iCal feed. A calendar named after one of them, or an event title that names
 * one, marks a shift. The optional prefixes also catch a feed still named after
 * its URL (getsling.com, joinhomebase.com). */
export const SHIFT_APPS = [
  ['When I Work', /\bwhen\s?i\s?work\b/i],
  ['Sling',       /\b(?:get)?sling\b/i],
  ['7shifts',     /\b7\s?shifts\b/i],
  ['Homebase',    /\b(?:join)?homebase\b/i],
];

/* The scheduling app `text` names, or null. */
export function shiftAppIn(text) {
  const s = String(text || '');
  const hit = SHIFT_APPS.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

/* Is `ev` a paid shift? `cal` describes the Google calendar it came from:
 * { name, shift, wage }. A choice the user made wins, first the event's own
 * (ev.shift true/false, Focus events only) and then the calendar-wide one. Without
 * a choice, an app name in the event title or the calendar name marks a shift.
 * Dividers and all-day events have no working hours, so they never count. */
export function isShift(ev, cal = {}) {
  if (!ev || ev.type === 'divider' || ev.allDay) return false;
  if (typeof ev.shift === 'boolean') return ev.shift;
  if (typeof cal.shift === 'boolean') return cal.shift;
  return !!(shiftAppIn(ev.title) || shiftAppIn(cal.name));
}

/* Why `ev` counts as a shift: 'event' (flagged on the event), 'calendar'
 * (the calendar setting), 'title' or 'calendar-name' (detected), or null. */
export function shiftReason(ev, cal = {}) {
  if (!isShift(ev, cal)) return null;
  if (typeof ev.shift === 'boolean') return 'event';
  if (typeof cal.shift === 'boolean') return 'calendar';
  return shiftAppIn(ev.title) ? 'title' : 'calendar-name';
}

/* How many minutes a shift runs. A Google event carries its real length (mins),
 * which also covers a shift past midnight. A Focus event only has clock times,
 * so an end before the start means the next morning (22:00–02:00 is 4 hours),
 * and an end equal to the start means no length at all. */
export function shiftMinutes(ev) {
  if (!ev) return 0;
  if (Number.isFinite(ev.mins) && ev.mins > 0) return ev.mins;
  const mins = t => { const [h, m] = String(t || '').split(':').map(Number); return h * 60 + m; };
  const s = mins(ev.start), e = mins(ev.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e === s) return 0;
  return e > s ? e - s : e + 1440 - s;
}

/* Dollars per hour, or null when not set: blank, zero, negative and non-numbers
 * all mean "no wage". Rounded to cents. */
export function normalizeWage(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/* The wage a shift pays: its own, else the one set for its calendar. */
export function shiftWage(ev, cal = {}) {
  return normalizeWage(ev && ev.wage) ?? normalizeWage(cal.wage);
}

/* What a shift pays in dollars, or null when no wage is known. */
export function shiftPay(ev, cal = {}) {
  const wage = shiftWage(ev, cal);
  return wage === null ? null : Math.round(wage * shiftMinutes(ev) / 60 * 100) / 100;
}

/* A day's weekly templates, for a day the calendar has not filled in yet. */
function templatesOn(key, templates) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return (templates || []).filter(t => Array.isArray(t.repeatDays) && t.repeatDays.includes(dow))
    .map(t => ({ ...t, fromTemplate: true, templateId: t.id }));
}

/* Every shift on the given days ('YYYY-MM-DD'), each real shift once.
 *   calEvents    { day: [Focus event] }; a day missing here gets its weekly templates
 *   calTemplates [weekly template]
 *   gcalEvents   { day: [Google event] } (leave out while not connected)
 *   calendars    { calId: { name, shift?, wage? } } for Google calendars
 * A Focus copy of a Google event (same gcalId) stands in for it. Result entries:
 * { date, title, start, end, minutes, wage, pay, source: 'focus' | 'google', calName }. */
export function shiftsOnDays(dayKeys, { calEvents = {}, calTemplates = [], gcalEvents = {}, calendars = {} } = {}) {
  const out = [];
  const add = (date, ev, cal, source) => out.push({
    date, title: ev.title || '', start: ev.start, end: ev.end,
    minutes: shiftMinutes(ev), wage: shiftWage(ev, cal), pay: shiftPay(ev, cal),
    source, calName: cal.name || null,
  });
  for (const date of dayKeys) {
    const local = calEvents[date] || templatesOn(date, calTemplates);
    const copied = new Set(local.map(e => e.gcalId).filter(Boolean));
    for (const ev of local) {
      const cal = (ev.gcalCalId && calendars[ev.gcalCalId]) || {};
      if (isShift(ev, cal)) add(date, ev, cal, 'focus');
    }
    for (const ev of gcalEvents[date] || []) {
      if (copied.has(ev.gcalId)) continue;
      const cal = { name: ev.calName, ...(calendars[ev.calId] || {}) };
      if (isShift(ev, cal)) add(date, ev, cal, 'google');
    }
  }
  return out;
}

/* Totals for a list from shiftsOnDays. `unpriced` counts shifts with no wage;
 * their hours are in `minutes` but nothing of theirs is in `pay`. */
export function sumShifts(shifts) {
  let minutes = 0, pay = 0, unpriced = 0;
  for (const s of shifts) {
    minutes += s.minutes;
    if (s.pay === null) unpriced++; else pay += s.pay;
  }
  return { count: shifts.length, minutes, pay: Math.round(pay * 100) / 100, unpriced };
}
