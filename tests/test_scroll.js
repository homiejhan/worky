/* Deleting a calendar event or a task leaves the page where it was.
 * jsdom has no layout, so each section gives the elements it needs a simple one:
 * the calendar grids get a height, and in the lists every card and task row sits
 * 40px below the one before it, so removing something higher up moves the rest.
 * Run: npm test (or node --experimental-vm-modules tests/test_scroll.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const settle = () => new Promise(r => setTimeout(r, 80));   // past any delayed scroll (the old reset waited 50ms)

const MORNING = 7 * 64 - 14;                      // the grid's first position: just before 7am
const shown = el => Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 600 });
const userScroll = (w, el, top) => { el.scrollTop = top; el.dispatchEvent(new w.Event('scroll')); };
const boot = mobile => loadApp({ storage: { 'focus-tour-done': '1' } }).then(app => {
  app.w.eval(`isMobileLayout = () => ${mobile}`);
  return app;
});
function addEvents(w, key, events) {
  w.eval(`calEnsureDay('${key}'); calEvents['${key}'].push(...${JSON.stringify(events)}); calSave();`);
}
const ev = (id, title, start, end) => ({ id, title, start, end, color: '#22C55E', type: 'event' });

/* Fake layout for the lists: rows and cards stack 40px apart inside their panel. */
function stackRows(w) {
  const panelOf = el => el.closest && el.closest('.right-panel, .swipe-panel');
  const stacked = el => el.matches && el.matches('.todo-card, .task-row');
  w.Element.prototype.getClientRects = function () { return panelOf(this) && stacked(this) ? [{}] : []; };
  w.Element.prototype.getBoundingClientRect = function () {
    const panel = panelOf(this);
    const i = panel && stacked(this) ? [...panel.querySelectorAll('.todo-card, .task-row')].indexOf(this) : -1;
    const top = i < 0 ? 0 : i * 40 - panel.scrollTop;
    return { top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top };
  };
}
const topOf = (d, sel) => d.querySelector(sel).getBoundingClientRect().top;

(async () => {
  console.log('\n── 1. The week (computer) keeps its place ──');
  {
    const { w, d } = await boot(false);
    const today = w.eval('calDateKey(calToday())');
    addEvents(w, today, [ev(9001, 'Campus cafe', '17:00', '21:00'), ev(9002, 'Library desk', '18:00', '20:00')]);
    const area = shown(d.getElementById('calScrollArea'));
    w.calToggleDesktop();
    await settle();
    eq(area.scrollTop, MORNING, 'it first opens just before 7am');
    userScroll(w, area, 900);
    w.openCalModal(today, 9001);
    await w.deleteCalEvent();
    await settle();
    ok(!w.eval(`calEvents['${today}'].some(e => e.id === 9001)`), 'the event is deleted');
    eq(area.scrollTop, 900, 'deleting an event leaves the week where it was');
    w.openCalModal(today, 9002);
    d.getElementById('calEventTitle').value = 'Library';
    await w.saveCalEvent();
    await settle();
    eq(area.scrollTop, 900, 'so does saving an event');
    w.calRefresh();
    await settle();
    eq(area.scrollTop, 900, 'and redrawing it, as a Google Calendar sync does');
    w.calToggleDesktop();
    area.scrollTop = 0;                            // a hidden panel can lose its scroll
    w.calToggleDesktop();
    await settle();
    eq(area.scrollTop, 900, 'closing and reopening the calendar comes back to the same place');
  }

  console.log('\n── 2. The day (phone) keeps its place ──');
  {
    const { w, d } = await boot(true);
    const today = w.eval('calDateKey(calToday())');
    const tomorrow = w.eval('calDateKey(new Date(calToday().getTime() + 36 * 3600e3))');
    addEvents(w, today, [ev(9101, 'Campus cafe', '17:00', '21:00')]);
    addEvents(w, tomorrow, [ev(9102, 'Library desk', '18:00', '20:00')]);
    const grid = shown(d.getElementById('calMobileGrid'));
    w.calRenderMobile();
    await settle();
    eq(grid.scrollTop, MORNING, 'it first opens just before 7am');
    userScroll(w, grid, 1000);
    w.openCalModal(today, 9101);
    await w.deleteCalEvent();
    await settle();
    eq(grid.scrollTop, 1000, 'deleting an event leaves the day where it was');
    w.calNavDay(1);
    await settle();
    eq(grid.scrollTop, 1000, 'moving to the next day keeps the same hours in view');
    w.openCalModal(tomorrow, 9102);
    await w.deleteCalEvent();
    await settle();
    eq(grid.scrollTop, 1000, 'and deleting there does too');
  }

  console.log('\n── 3. Deleting a task keeps the rows above it still (computer) ──');
  {
    const { w, d } = await boot(false);
    stackRows(w);
    const due = w.eval('calDateKey(new Date(calToday().getTime() + 3 * 86400e3))');
    w.eval(`todoLists.push({ id: 900, title: 'Test list', color: '#22C55E', isDefault: false, starred: false, activeDays: null, tasks: [
      { id: 901, text: 'First', done: false }, { id: 902, text: 'Dated', done: false, due: '${due}' }, { id: 903, text: 'Last', done: false }] });
      renderTodos(); renderDbd();`);
    const panel = d.getElementById('rightPanel');
    const inCard = id => `#todoContainer-d .task-row[data-task-id="${id}"]`;
    ok(!!d.querySelector(`#dbdContainer-d .task-row[data-task-id="902"]`), 'the dated task also shows in Day by Day, higher up');
    panel.scrollTop = 400;
    const firstBefore = topOf(d, inCard(901));
    d.querySelector(`${inCard(902)} .task-del`).click();
    ok(!d.querySelector(`[data-task-id="902"]`), 'the task is gone from its list and from Day by Day');
    eq(topOf(d, inCard(901)), firstBefore, 'the row above it has not moved, though its Day by Day copy went too');
    eq(panel.scrollTop, 360, 'the page scrolled up by exactly that copy\'s height to make up for it');

    const dbdId = w.eval(`(() => { const id = nextDbdId(); dbdTasks.push({ id, text: 'Buy stamps', due: dbdTodayKey(), done: false }); renderDbd(); return id; })()`);
    const firstDbd = d.querySelector('#dbdContainer-d .task-row');
    const firstKey = firstDbd.dataset.dbdId ? `[data-dbd-id="${firstDbd.dataset.dbdId}"]` : `[data-task-id="${firstDbd.dataset.taskId}"]`;
    const beforeTop = topOf(d, `#dbdContainer-d .task-row${firstKey}`);
    d.querySelector(`#dbdContainer-d .task-row[data-dbd-id="${dbdId}"] .task-del`).click();
    ok(!w.eval(`dbdTasks.some(t => t.id === ${dbdId})`), 'a Day by Day task deletes');
    eq(panel.scrollTop, 360, 'nothing above it changed, so the page did not scroll');
    eq(topOf(d, `#dbdContainer-d .task-row${firstKey}`), beforeTop, 'and the rows above it stayed put');

    w.removeTask(900, 903);
    ok(!d.querySelector(inCard(903)), 'a delete with no row to keep in place (called from code) still works');
  }

  console.log('\n── 4. The same on a phone ──');
  {
    const { w, d } = await boot(true);
    stackRows(w);
    const due = w.eval('calDateKey(new Date(calToday().getTime() + 3 * 86400e3))');
    w.eval(`todoLists.push({ id: 900, title: 'Test list', color: '#22C55E', isDefault: false, starred: false, activeDays: null, tasks: [
      { id: 901, text: 'First', done: false }, { id: 902, text: 'Dated', done: false, due: '${due}' }] });
      renderTodos(); renderDbd();`);
    const panel = d.querySelector('.swipe-panel[data-view="lists"]');
    const inCard = id => `#todoContainer-m .task-row[data-task-id="${id}"]`;
    panel.scrollTop = 400;
    const firstBefore = topOf(d, inCard(901));
    d.querySelector(`${inCard(902)} .task-del`).click();
    eq(topOf(d, inCard(901)), firstBefore, 'the row above it has not moved');
    eq(panel.scrollTop, 360, 'the lists tab made up for the Day by Day copy that went');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
