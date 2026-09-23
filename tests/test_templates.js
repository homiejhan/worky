/* The Working student template: first in the list, what a fresh device starts
 * from, and what applying it keeps, adds and switches on.
 * Run: npm test (or node --experimental-vm-modules tests/test_templates.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

(async () => {
  console.log('\n── 1. The template list: Student and Night Owl became Working student ──');
  {
    const { w } = await loadApp();
    const ids = w.eval('FORMAT_TEMPLATES.map(t => t.id).join(",")');
    eq(ids, 'working,classic,deepwork,fitness,creative,faith,minimal', 'Working student first; Student and Night Owl gone');
    eq(w.eval('DEFAULT_TEMPLATE'), 'working', 'and it is the default');
    const tp = w.eval('formatTemplateById("working")');
    eq(tp.timers.map(t => `${t.label} ${t.seconds / 3600}h`).join(', '), 'Study 3h, Work 4h, Sleep 8h', 'Study, Work, Sleep timers');
    eq(tp.lists.map(l => l.title).join(), 'Deadlines', 'brings a Deadlines list');
    eq(tp.views.join(), 'budget', 'and keeps the envelope (Budget) on');
    eq(tp.daily.map(d => d.title).join(' | '), 'Before class or shift | Wind down | Sunday planning', 'routines from both old templates');
    ok(tp.cal.every(c => !c.shift && !/shift|work|class/i.test(c.title)), 'no made-up classes or shifts on the calendar: real ones come from Google Calendar');
    ok(w.eval('FORMAT_TEMPLATES.every(t => themePreset(t.theme).id === t.theme)'), 'every template names an existing theme (no new ones)');
  }

  console.log('\n── 2. The template picker ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    d.getElementById('fmtBtn').click();
    w.openFormatTemplates();
    const cards = [...d.querySelectorAll('#fmtTemplateGrid .fmt-tpl-card')];
    eq(cards.length, 7, 'seven templates');
    eq(cards[0].dataset.tpl, 'working', 'Working student first');
    ok(cards[0].querySelector('.fmt-tpl-default')?.textContent === 'Default', 'with a Default badge');
    eq(cards.filter(c => c.querySelector('.fmt-tpl-default')).length, 1, 'and only it');
    ok([...cards[0].querySelectorAll('.fmt-tpl-chip')].some(c => c.textContent === 'Deadlines'), 'its chips include Deadlines');
    ok(cards[0].querySelector('.fmt-tpl-counts').textContent.includes('+ Deadlines'), 'and its counts line');
  }

  console.log('\n── 3. Applying Working student: replaces what Formats owns, adds Deadlines only if missing ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    // start from a different setup, without a Deadlines list and with Budget hidden
    let asked = '';
    w.confirm = m => { asked = m; return true; };
    d.getElementById('fmtBtn').click();
    w.applyFormatTemplate('minimal', false);
    w.eval('todoLists = todoLists.filter(l => l.title !== "Deadlines"); todoLists.push({ id: 777, title: "Groceries", color: "#EAB308", isDefault: false, starred: false, activeDays: null, tasks: [{ id: 7771, text: "Eggs", done: false }] })');
    w.setViewEnabled('budget', false);
    eq(w.eval('views.budget'), false, 'Budget hidden to begin with');
    ok(!/adds/.test(asked), 'Minimal adds no lists, and its confirm says nothing about it');
    w.applyFormatTemplate('working', false);
    ok(/it adds a Deadlines list\./.test(asked), 'the confirm says it adds a Deadlines list');
    eq(w.eval('timers.map(t => t.label).join()'), 'Study,Work,Sleep', 'timers replaced');
    eq(w.eval('todoLists.filter(l => l.isDefault).map(l => l.title).join(" | ")'), 'Before class or shift | Wind down | Sunday planning', 'Daily lists replaced');
    ok(w.eval('todoLists.some(l => l.title === "Groceries" && l.tasks[0].text === "Eggs")'), 'custom lists kept, tasks and all');
    const dl = w.eval('todoLists.filter(l => l.title === "Deadlines")');
    eq(dl.length, 1, 'Deadlines added once');
    ok(dl[0].starred && !dl[0].isDefault && dl[0].tasks.length === 0, 'starred, custom, empty');
    eq(w.eval('views.budget'), true, 'Budget switched back on');
    // again: an existing Deadlines list (any case) is not duplicated and keeps its tasks
    w.eval('todoLists.find(l => l.title === "Deadlines").title = "deadlines "; todoLists.find(l => l.title === "deadlines ").tasks.push({ id: 9901, text: "Essay", done: false, due: "2030-01-01" })');
    w.applyFormatTemplate('working', false);
    ok(!/adds/.test(asked), 'with a Deadlines list already there, nothing is added');
    eq(w.eval('todoLists.filter(l => /deadlines/i.test(l.title)).length'), 1, 'still one Deadlines list');
    eq(w.eval('todoLists.find(l => /deadlines/i.test(l.title)).tasks.map(t => t.text).join()'), 'Essay', 'with its tasks');
    d.getElementById('fmtBtn').click();   // Done
    const saved = JSON.parse(w.localStorage.getItem('focus-app-state'));
    eq(saved.timerDefaults.map(t => t.label).join(), 'Study,Work,Sleep', 'Done saves the new defaults');
    ok(saved.views.budget !== false, 'and Budget on');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
