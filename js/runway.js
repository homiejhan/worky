/* runway.js — Cash runway: how many days the money lasts, measured against
 * the next payday. Pure functions over 'YYYY-MM-DD' keys, so tests import this
 * file directly and the budget passes its numbers in.
 *
 * The model walks forward one day at a time from today. Each day costs the
 * daily budget (today costs only what is left of today's envelope). A bill
 * comes out on its day of the month, and the pay for shifts worked before
 * payday lands on payday. Days of cash is how many days, today included, are
 * paid for before the money runs out. Shift pay counts on payday, not when the
 * shift is worked, because that is when the money arrives. A student who is
 * short three days before a paycheck is still short. */

const DAY_MS = 86400000;
const keyParts = key => String(key).split('-').map(Number);
const keyOf = ms => new Date(ms).toISOString().slice(0, 10);
const utc = key => { const [y, m, d] = keyParts(key); return Date.UTC(y, m - 1, d); };

/* Calendar arithmetic on date keys, in UTC so a DST change can't skip a day. */
export function addDays(key, n) { return keyOf(utc(key) + n * DAY_MS); }
export function daysBetween(fromKey, toKey) { return Math.round((utc(toKey) - utc(fromKey)) / DAY_MS); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export const PAY_REPEATS = ['biweekly', 'weekly', 'monthly', 'once'];

/* The next payday on or after `today`, from the one the user entered and how
 * often it repeats. Monthly paydays keep the day of the month, moving to the
 * last day in shorter months (the 31st pays on Feb 28). A one-off payday that
 * has passed gives null. */
export function nextPayday(anchor, repeat, today) {
  if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null;
  if (anchor >= today) return anchor;
  if (repeat === 'weekly' || repeat === 'biweekly') {
    const step = repeat === 'weekly' ? 7 : 14;
    return addDays(anchor, Math.ceil(daysBetween(anchor, today) / step) * step);
  }
  if (repeat === 'monthly') {
    const day = keyParts(anchor)[2];
    let [y, m] = keyParts(today);
    for (let i = 0; i < 2; i++) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, '0')}`;
      if (key >= today) return key;
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return null;
}

/* What bills fall due on a date. A bill is { name, amount, day } and repeats
 * monthly on `day`, or on the month's last day when the month is shorter. */
export function billsDueOn(bills, key) {
  const [y, m, d] = keyParts(key);
  const last = daysInMonth(y, m);
  return (bills || []).filter(b => Math.min(Math.max(1, Math.round(b.day) || 1), last) === d && b.amount > 0);
}

/* Bills due after `fromKey` up to and including `toKey`, oldest first
 * (what the morning rollover takes out after a gap of several days). */
export function billsDueBetween(bills, fromKey, toKey) {
  const out = [];
  const n = Math.min(daysBetween(fromKey, toKey), 366);
  for (let i = 1; i <= n; i++) {
    const key = addDays(fromKey, i);
    billsDueOn(bills, key).forEach(b => out.push({ ...b, date: key }));
  }
  return out;
}

/* The runway. Inputs (money in dollars, dates as 'YYYY-MM-DD'):
 *   today        the first day counted
 *   payday       next payday, or null when none is set
 *   balance      the envelope's total balance right now
 *   todaySpend   what is still to be spent today (the rest of today's envelope)
 *   dailySpend   the daily budget: what each later day costs
 *   shifts       [{ date, pay }]; pay null = no wage, so it can't be counted
 *   bills        [{ name, amount, day }], monthly
 *   horizon      how far to look (days)
 * Result:
 *   daysToPayday      null without a payday; 0 on payday
 *   daysOfCash        days paid for, today included; null = lasts past the horizon
 *   runsOutOn         the first day not paid for, or null
 *   runsOutWith       names of the bills due that day (often the reason), else []
 *   paycheck          projected pay landing on payday (shifts from today until then)
 *   unpricedShifts    shifts before payday with no wage (not in paycheck)
 *   billsBeforePayday bills due after today and before payday
 *   short, shortBy    the money runs out before payday, and by how many days */
export function cashRunway({ today, payday = null, balance = 0, todaySpend = 0, dailySpend = 0,
  shifts = [], bills = [], horizon = 60 }) {
  const daysToPayday = payday ? Math.max(0, daysBetween(today, payday)) : null;
  const before = shifts.filter(s => payday && s.date >= today && s.date < payday);
  const paycheck = Math.round(before.reduce((t, s) => t + (s.pay || 0), 0) * 100) / 100;
  const unpricedShifts = before.filter(s => s.pay === null || s.pay === undefined).length;
  const sum = list => list.reduce((t, b) => t + b.amount, 0);
  let billsBeforePayday = 0;
  for (let d = 1; d < (daysToPayday ?? 0); d++) billsBeforePayday += sum(billsDueOn(bills, addDays(today, d)));
  let cash = balance, daysOfCash = null, runsOutOn = null, runsOutWith = [];
  for (let d = 0; d < horizon; d++) {
    const date = addDays(today, d);
    const dueToday = d > 0 ? billsDueOn(bills, date) : [];   // today's bills came out this morning
    if (d > 0 && d === daysToPayday) cash += paycheck;
    cash -= sum(dueToday);
    cash -= d === 0 ? Math.max(0, todaySpend) : Math.max(0, dailySpend);
    if (cash < -0.005) { daysOfCash = d; runsOutOn = date; runsOutWith = dueToday.map(b => b.name); break; }
  }
  const short = daysOfCash !== null && daysToPayday !== null && daysOfCash < daysToPayday;
  return {
    daysToPayday, daysOfCash, runsOutOn, runsOutWith, paycheck, unpricedShifts,
    billsBeforePayday: Math.round(billsBeforePayday * 100) / 100,
    short, shortBy: short ? daysToPayday - daysOfCash : 0,
  };
}
