/* Deleting a calendar event or a task leaves the page where it was.
 * jsdom has no layout, so each section gives the elements it needs a simple one:
 * the calendar grids get a height.
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
