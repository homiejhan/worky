/* Paid shifts: which events count, how long they run and what they pay.
 * Sections 1–4 check the pure rules in js/shifts.js against fixtures; the rest
 * check the same rules working inside the app.
 * Run: npm test (or node --experimental-vm-modules tests/test_shifts.js) */
const path = require('path');
const { loadApp, ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const S = await import(path.join(ROOT, 'js', 'shifts.js'));

  console.log('\n── 1. The four scheduling apps, by name or feed URL ──');
  const named = {
    'When I Work': 'When I Work', 'WhenIWork schedule': 'When I Work', 'https://app.wheniwork.com/ical/abc123': 'When I Work',
    'Sling': 'Sling', 'Sling: Campus Cafe': 'Sling', 'calendar.getsling.com/feed': 'Sling',
    '7shifts': '7shifts', '7 Shifts – Downtown': '7shifts', 'app.7shifts.com/ical': '7shifts',
    'Homebase Schedule': 'Homebase', 'joinhomebase.com': 'Homebase',
  };
  Object.entries(named).forEach(([text, app]) => eq(S.shiftAppIn(text), app, `"${text}" → ${app}`));
  ['Slingshot practice', 'Home base', 'Work', 'CHEM 101 lab', '', null].forEach(t => eq(S.shiftAppIn(t), null, `"${t}" names no app`));

  console.log('\n── 2. What makes an event a shift, in order of precedence ──');
  const wiw = { name: 'When I Work' };
  ok(S.isShift({ title: 'Barista', start: '17:00', end: '22:00' }, wiw), 'calendar name detects it');
  ok(S.isShift({ title: '7shifts: Server', start: '17:00', end: '22:00' }), 'title detects it');
  ok(!S.isShift({ title: 'Study group', start: '17:00', end: '22:00' }), 'anything else is not a shift');
  ok(!S.isShift({ title: 'Barista', start: '17:00', end: '22:00' }, { ...wiw, shift: false }), 'calendar set to "not shifts" beats its name');
  ok(S.isShift({ title: 'Tutoring', start: '17:00', end: '18:00' }, { name: 'Me', shift: true }), 'calendar set to "shifts" counts every event');
  ok(!S.isShift({ title: '7shifts: Server', shift: false, start: '17:00', end: '22:00' }, { shift: true }), 'the event\'s own "no" beats everything');
  ok(S.isShift({ title: 'Tutoring', shift: true, start: '17:00', end: '18:00' }, { shift: false }), 'the event\'s own "yes" beats everything');
  ok(!S.isShift({ title: 'When I Work', type: 'divider', shift: true, start: '09:00', end: '09:00' }), 'a divider never is');
  ok(!S.isShift({ title: 'Homebase', allDay: true, start: '00:00', end: '23:59' }), 'an all-day event never is');
  eq(S.shiftReason({ title: 'x', shift: true }), 'event', 'reason: flagged on the event');
  eq(S.shiftReason({ title: 'x' }, { shift: true }), 'calendar', 'reason: calendar setting');
  eq(S.shiftReason({ title: 'Sling shift' }), 'title', 'reason: title');
  eq(S.shiftReason({ title: 'x' }, wiw), 'calendar-name', 'reason: calendar name');
  eq(S.shiftReason({ title: 'x' }), null, 'reason: not a shift');

  console.log('\n── 3. Hours, wages and pay ──');
  eq(S.shiftMinutes({ start: '09:00', end: '17:00' }), 480, '9–5 is 8 hours');
  eq(S.shiftMinutes({ start: '22:00', end: '02:00' }), 240, '10pm–2am runs past midnight: 4 hours');
  eq(S.shiftMinutes({ start: '09:00', end: '09:00' }), 0, 'no end time, no hours');
  eq(S.shiftMinutes({ start: '22:00', end: '06:00', mins: 480 }), 480, 'a Google event\'s real length wins');
  eq(S.shiftMinutes({ start: 'x', end: '10:00' }), 0, 'unreadable times count nothing');
  eq(S.normalizeWage('13.5'), 13.5, 'wage "13.5"');
  eq(S.normalizeWage('$15.25/hr'), 15.25, 'wage "$15.25/hr"');
  eq(S.normalizeWage(12.346), 12.35, 'wage rounds to cents');
  [0, -3, '', 'abc', null, undefined].forEach(v => eq(S.normalizeWage(v), null, `wage ${JSON.stringify(v)} means not set`));
  eq(S.shiftWage({ wage: 16 }, { wage: 14 }), 16, 'the event\'s wage beats its calendar\'s');
  eq(S.shiftWage({}, { wage: 14 }), 14, 'else the calendar\'s');
  eq(S.shiftWage({}, {}), null, 'else none');
  eq(S.shiftPay({ start: '09:00', end: '17:00', wage: 13.5 }), 108, '8 h × $13.50 = $108');
  eq(S.shiftPay({ start: '22:00', end: '02:00' }, { wage: 15 }), 60, 'overnight 4 h × $15 = $60');
  eq(S.shiftPay({ start: '09:00', end: '17:00' }), null, 'no wage, no pay');

  console.log('\n── 4. A week of shifts from every source, each counted once ──');
  // 2026-09-21 is a Monday, 09-22 a Tuesday.
  const sources = {
    calEvents: {
      '2026-09-21': [
        { id: 1, title: 'Cafe', start: '07:00', end: '11:00', shift: true, wage: 15 },
        { id: 2, title: 'Lecture', start: '12:00', end: '13:00' },
        { id: 3, title: 'When I Work', type: 'divider', start: '14:00', end: '14:00' },
        { id: 4, title: 'Barista', start: '17:00', end: '21:00', gcalId: 'g-copy', gcalCalId: 'wiw' },   // Focus copy of a Google shift
      ],
    },
    calTemplates: [{ id: 50, title: 'Library desk', start: '18:00', end: '22:00', shift: true, isTemplate: true, repeatDays: [2] }],
    gcalEvents: {
      '2026-09-21': [
        { gcalId: 'g-copy', calId: 'wiw', calName: 'When I Work', title: 'Barista', start: '17:00', end: '21:00', mins: 240 },
        { gcalId: 'g-own', calId: 'me', calName: 'Me', title: 'Dentist', start: '09:00', end: '10:00', mins: 60 },
      ],
      '2026-09-22': [
        { gcalId: 'g-night', calId: 'wiw', calName: 'When I Work', title: 'Close', start: '22:00', end: '06:00', mins: 480 },
        { gcalId: 'g-off', calId: 'seven', calName: '7shifts', title: 'Server', start: '11:00', end: '15:00', mins: 240 },
      ],
    },
    calendars: { wiw: { name: 'When I Work', wage: 14 }, me: { name: 'Me' }, seven: { name: '7shifts', shift: false } },
  };
  const found = S.shiftsOnDays(['2026-09-21', '2026-09-22'], sources);
  eq(found.map(f => `${f.date} ${f.title} ${f.source}`).join(' | '),
    '2026-09-21 Cafe focus | 2026-09-21 Barista focus | 2026-09-22 Library desk focus | 2026-09-22 Close google',
    'Focus shift, Focus copy of a Google shift, a template day, a Google overnight shift; not the lecture, divider, dentist or a "not shifts" calendar');
  eq(found.map(f => f.pay).join(','), '60,56,,112', 'pays: own wage, calendar wage via the copy, none, calendar wage × real 8 h');
  const sum = S.sumShifts(found);
  eq(JSON.stringify(sum), JSON.stringify({ count: 4, minutes: 1200, pay: 228, unpriced: 1 }), 'totals: 4 shifts, 20 h, $228, 1 without a wage');
  eq(S.shiftsOnDays(['2026-09-23'], sources).length, 0, 'a day with nothing on it has no shifts');

  console.log('\n── 5. Export and reload keep shifts and wages ──');
  {
    const { w } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    const today = w.eval('calDateKey(calToday())');
    w.eval(`calEnsureDay('${today}'); calEvents['${today}'].push({ id: 9001, title: 'Shift', start: '10:00', end: '14:00', color: '#378ADD', type: 'event', shift: true, wage: 16 }, { id: 9002, title: 'Nope', start: '15:00', end: '16:00', color: '#378ADD', type: 'event', shift: false })`);
    w.eval(`shiftCals = { 'wiw@import.calendar.google.com': { shift: true, wage: 14 } }`);
    const st = w.gatherState();
    eq(st.build, 4, 'state build 4 (shiftCals is new)');
    const c = w.compressState(st);
    const shiftEv = c.cal.ce[today].find(e => e.i === 9001), noEv = c.cal.ce[today].find(e => e.i === 9002);
    ok(shiftEv.sh === 1 && shiftEv.wg === 16 && noEv.sh === 0 && !('wg' in noEv), 'Export writes sh/wg');
    eq(JSON.stringify(c.sc), JSON.stringify({ 'wiw@import.calendar.google.com': { shift: true, wage: 14 } }), 'Export writes the calendar settings as sc');
    const back = w.decompressState(JSON.parse(JSON.stringify(c)));
    const b1 = back.calendar.calEvents[today].find(e => e.id === 9001), b2 = back.calendar.calEvents[today].find(e => e.id === 9002);
    ok(b1.shift === true && b1.wage === 16 && b2.shift === false && !('wage' in b2), 'Import reads them back');
    eq(JSON.stringify(back.shiftCals), JSON.stringify(st.shiftCals), 'and the calendar settings');
    const again = await loadApp({ storage: { 'focus-tour-done': '1', 'focus-app-state': JSON.stringify(st) } });
    eq(JSON.stringify(again.w.eval('shiftCals')), JSON.stringify(st.shiftCals), 'a reload restores the calendar settings');
    eq(again.w.eval(`calEvents['${today}'].find(e => e.id === 9001).wage`), 16, 'and event wages');
    // an older build's cloud copy has no shiftCals: keep ours rather than wipe it
    const old = { ...st, build: 3 }; delete old.shiftCals;
    again.w.syncApplyRemote(JSON.stringify(old), Date.now());
    eq(JSON.stringify(again.w.eval('shiftCals')), JSON.stringify(st.shiftCals), 'a build-3 cloud copy does not erase shift settings');
    eq(again.w.eval('normalizeShiftCals({ a: { shift: "yes", wage: -1 }, b: { wage: "13" }, c: {} })').b.wage, 13, 'settings are normalized');
    eq(Object.keys(again.w.eval('normalizeShiftCals({ a: { shift: "yes", wage: -1 }, b: { wage: "13" }, c: {} })')).join(), 'b', 'empty or junk entries are dropped');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
