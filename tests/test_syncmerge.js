/* Merging two devices' changes: the pure rules in js/syncmerge.js, on
 * fixtures. Sync itself (two devices open at once) is in test_sync.js.
 * Run: npm test -- syncmerge (or node --experimental-vm-modules tests/test_syncmerge.js) */
const path = require('path');
const { ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const clone = v => JSON.parse(JSON.stringify(v));

const BASE = {
  version: 1, build: 7, wokenUp: false,
  timers: [{ id: 0, label: 'Study', seconds: 3600, running: false, startedAt: null, secondsAtStart: null }],
  dbdTasks: [{ id: 1, text: 'Laundry', due: '2026-09-30', done: false }],
  dbdIdCounter: 2,
  todoLists: [{ id: 0, title: 'School', tasks: [{ id: 0, text: 'Essay', done: false }], activeDays: null }],
  todoIdCounter: 1, taskIdCounter: 1,
  budget: { initial: 500, daily: 20, todayAllowance: null, lastDate: '2026-09-30', purchases: [{ id: 1, title: 'Lunch', amount: 8 }] },
  purchaseIdCounter: 2,
  theme: { preset: 'midnight', accent: '#5dcaa5' },
  calendar: { calEvents: { '2026-09-30': [{ id: 1, title: 'Shift', start: '16:00', end: '20:00' }] }, calTemplates: [], calEventIdCtr: 2 },
  digest: { enabled: true, suggestions: [], sugIdCounter: 1 },
};

(async () => {
  const { syncMerge } = await import(path.join(ROOT, 'js', 'syncmerge.js'));
  const run = (edit, editRemote, opts) => {
    const local = clone(BASE), remote = clone(BASE);
    edit(local); editRemote(remote);
    return syncMerge(clone(BASE), local, remote, opts);
  };

  console.log('\n── 1. Each side changed something different ──');
  {
    const m = run(l => { l.dbdTasks.push({ id: 2, text: 'Call mom', due: '2026-09-30', done: false }); l.dbdIdCounter = 3; },
                  r => { r.budget.purchases.push({ id: 2, title: 'Coffee', amount: 4.5 }); r.purchaseIdCounter = 3; r.theme.accent = '#ff8800'; });
    ok(m.dbdTasks.some(t => t.text === 'Call mom') && m.budget.purchases.some(p => p.title === 'Coffee'), 'a task added here and a purchase added there: both kept');
    eq(m.theme.accent, '#ff8800', 'a setting changed there is taken');
    ok(m.dbdIdCounter === 3 && m.purchaseIdCounter === 3, 'counters follow');
    const n = run(l => { l.dbdTasks[0].done = true; }, r => { r.dbdTasks[0].text = 'Laundry (whites)'; });
    ok(n.dbdTasks.length === 1 && n.dbdTasks[0].done === true && n.dbdTasks[0].text === 'Laundry (whites)', 'the same task, ticked here and renamed there: one task with both');
  }

  console.log('\n── 2. Both added under the same id ──');
  {
    const m = run(l => { l.dbdTasks.push({ id: 2, text: 'typed on the laptop', done: false }); l.dbdIdCounter = 3; },
                  r => { r.dbdTasks.push({ id: 2, text: 'typed on the phone', done: false }); r.dbdIdCounter = 3; });
    eq(m.dbdTasks.map(t => `${t.id}:${t.text}`).join(', '), '1:Laundry, 2:typed on the phone, 3:typed on the laptop', "both kept: the cloud's keeps id 2, this device's moves to 3");
    eq(m.dbdIdCounter, 4, 'and the counter moves past both');
    const same = run(l => { l.dbdTasks.push({ id: 2, text: 'Same', done: false }); }, r => { r.dbdTasks.push({ id: 2, text: 'Same', done: false }); });
    eq(same.dbdTasks.length, 2, 'the very same record added on both: once');
    const lists = run(l => { l.todoLists[0].tasks.push({ id: 1, text: 'Read ch. 4', done: false }); l.taskIdCounter = 2; },
                      r => { r.todoLists[0].tasks.push({ id: 1, text: 'Lab report', done: false }); r.taskIdCounter = 2; r.todoLists[0].title = 'School (fall)'; });
    ok(lists.todoLists[0].title === 'School (fall)' && lists.todoLists[0].tasks.map(t => t.text).join() === 'Essay,Lab report,Read ch. 4' && lists.taskIdCounter === 3,
      'inside a list too: both new tasks, the new title, and the task counter past them');
    const cal = run(l => { l.calendar.calEvents['2026-10-01'] = [{ id: 2, title: 'Class' }]; l.calendar.calEventIdCtr = 3; },
                    r => { r.calendar.calEvents['2026-09-30'].push({ id: 2, title: 'Gym' }); r.calendar.calEventIdCtr = 3; });
    ok(cal.calendar.calEvents['2026-10-01'][0].title === 'Class' && cal.calendar.calEvents['2026-09-30'].length === 2 && cal.calendar.calEventIdCtr === 3,
      'calendar events on different days, each side\'s kept');
  }

  console.log('\n── 3. Deleted on one side ──');
  {
    let m = run(l => { l.dbdTasks = []; }, r => { r.theme.accent = '#000'; });
    eq(m.dbdTasks.length, 0, 'deleted here, untouched there: gone');
    m = run(l => { l.dbdTasks = []; }, r => { r.dbdTasks[0].done = true; });
    ok(m.dbdTasks.length === 1 && m.dbdTasks[0].done, 'deleted here, changed there: the change stays');
    m = run(l => { l.budget.purchases = []; l.dbdTasks.push({ id: 2, text: 'x', done: false }); }, r => { r.budget.purchases.push({ id: 2, title: 'Snack', amount: 2 }); });
    eq(m.budget.purchases.map(p => p.title).join(), 'Snack', 'a purchase removed here stays removed; one added there arrives');
    m = run(l => { delete l.theme.accent; }, r => { r.dbdTasks[0].done = true; });
    ok(!('accent' in m.theme) && m.dbdTasks[0].done, 'a key removed here, untouched there: removed');
  }

  console.log('\n── 4. Both changed the same value ──');
  {
    let m = run(l => { l.budget.daily = 25; }, r => { r.budget.daily = 30; }, { preferLocal: true });
    eq(m.budget.daily, 25, 'the newer edit wins: here');
    m = run(l => { l.budget.daily = 25; }, r => { r.budget.daily = 30; }, { preferLocal: false });
    eq(m.budget.daily, 30, 'or there');
    m = run(l => { l.purchaseIdCounter = 5; }, r => { r.purchaseIdCounter = 7; }, { preferLocal: true });
    eq(m.purchaseIdCounter, 7, 'an id counter takes the higher');
    m = run(l => { l.todoLists[0].activeDays = [1, 2]; }, r => { r.todoLists[0].activeDays = [3]; });
    eq(JSON.stringify(m.todoLists[0].activeDays), '[3]', 'a plain list is one value');
    m = run(l => { l.timers[0].running = true; l.timers[0].startedAt = 1000; l.timers[0].secondsAtStart = 3600; },
            r => { r.timers[0].label = 'Deep work'; });
    ok(m.timers[0].running && m.timers[0].startedAt === 1000 && m.timers[0].label === 'Deep work', 'a timer started here and renamed there: running, with the new name');
  }

  console.log('\n── 5. Bank purchases and unknown fields ──');
  {
    const m = run(l => { l.budget.purchases.push({ id: 2, title: 'Chipotle', amount: 12.5, bank: 'tx-9' }); l.purchaseIdCounter = 3; },
                  r => { r.budget.purchases.push({ id: 3, title: 'Chipotle', amount: 12.5, bank: 'tx-9' }); r.purchaseIdCounter = 4; });
    eq(m.budget.purchases.filter(p => p.bank === 'tx-9').length, 1, 'a transaction both devices logged from the bank: once');
    const x = run(l => { l.futureThing = { a: 1 }; }, r => { r.dbdTasks[0].done = true; });
    ok(x.futureThing && x.futureThing.a === 1 && x.dbdTasks[0].done, 'a field only one side knows is kept');
    const same = syncMerge(clone(BASE), clone(BASE), clone(BASE));
    ok(JSON.stringify(same) === JSON.stringify(BASE), 'nothing changed: nothing changes');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
