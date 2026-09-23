/* insights.js — The three insight cards on Home. Each rule is a pure function
 * of data only Focus holds (shifts, deadlines, cash, timer history). There is
 * no model and nothing leaves the device, so every card can be checked
 * against fixtures (tests/test_insights.js), and later against what students
 * say actually happened. home.js gathers the inputs and draws the cards. */

import { addDays } from './runway.js';

const DAY = 1440;
const dayNumber = key => { const [y, m, d] = String(key).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const clockMinutes = t => { const [h, m] = String(t || '').split(':').map(Number); return h * 60 + m; };

/* 1. A shift collides with a deadline.
 * A deadline is due at the end of its day (11:59pm, as most course sites set
 * it), so the 24 hours before it are its due date. Any shift that has not
 * ended and overlaps those hours clashes: that is time the work was meant to
 * get. `shifts` come from shiftsOnDays ({ date, start, minutes, title, pay });
 * `deadlines` are unfinished dated tasks ({ id, text, due }); `now` is
 * { date, minutes }. Clashes come back soonest first, each with the minutes of
 * overlap. */
export function deadlineClashes(shifts, deadlines, now) {
  const nowAt = dayNumber(now.date) * DAY + now.minutes;
  const out = [];
  for (const dl of deadlines) {
    if (!dl || !dl.due) continue;
    const dueAt = (dayNumber(dl.due) + 1) * DAY;          // midnight after the due date
    if (dueAt <= nowAt) continue;
    for (const sh of shifts) {
      const start = dayNumber(sh.date) * DAY + clockMinutes(sh.start);
      const end = start + (sh.minutes || 0);
      if (end <= nowAt || !Number.isFinite(start)) continue;
      const overlap = Math.min(end, dueAt) - Math.max(start, dueAt - DAY);
      if (overlap > 0) out.push({ shift: sh, deadline: dl, overlap, startsAt: start });
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt || (a.deadline.due < b.deadline.due ? -1 : 1))
    .map(({ startsAt, ...c }) => c);
}

/* 2. Cash runs out before payday. `r` is a runway result (budget.js
 * runwayResult → runway.js cashRunway); null when it isn't short. */
export function runwayWarning(r) {
  if (!r || !r.short) return null;
  return {
    runsOutOn: r.runsOutOn, runsOutWith: r.runsOutWith || [], shortBy: r.shortBy,
    daysToPayday: r.daysToPayday, payday: r.payday, shortfall: r.shortfall || 0,
  };
}

/* 3. A timer overrun three days running means the budget is wrong, not you.
 * `log` is the timer log ({ day: { key: { label, over, budget } } }). A streak
 * is consecutive days with an overrun, ending today, or yesterday while today
 * has not gone over yet. Streaks of `minDays` or more come back longest first,
 * with the average overrun and a suggested budget: the old one plus that
 * average, rounded up to a quarter hour. */
export function timerOverruns(log, today, minDays = 3) {
  const keys = new Set(Object.values(log || {}).flatMap(day => Object.keys(day || {})));
  const out = [];
  keys.forEach(key => {
    let day = log[today] && log[today][key] ? today : addDays(today, -1);
    let days = 0, total = 0, latest = null;
    while (log[day] && log[day][key]) {
      const e = log[day][key];
      latest = latest || e;
      days++; total += e.over || 0;
      day = addDays(day, -1);
    }
    if (days < minDays) return;
    const avgOver = Math.round(total / days);
    const budget = latest.budget || null;
    const suggested = budget ? Math.ceil((budget + avgOver) / 900) * 900 : null;
    out.push({ key, label: latest.label, days, avgOver, budget, suggested });
  });
  return out.sort((a, b) => b.days - a.days || a.label.localeCompare(b.label));
}
