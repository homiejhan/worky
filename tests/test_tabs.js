/* Lists / Daily tab split — mobile panels + desktop right-panel pages.
 * Run: npm test (or node --experimental-vm-modules tests/test_tabs.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

function boot(storageSeed) { return loadApp({ storage: storageSeed }); }
/* app state lives in top-level let/const, so read it through eval */
const get = (w, expr) => w.eval(expr);
const shown = el => el.style.display !== 'none';
/* which panel the swipe track is slid to, read off its transform */
const trackIdx = (w, d) => -parseFloat(d.getElementById('swipeTrack').style.transform.replace('translateX(', '')) / get(w, 'swipeFrameWidth()');

(async () => {   // the app boots asynchronously now (ES modules), so the checks run in here
console.log('\n── 1. Mobile: six tabs, Daily has its own panel ──');
{
  const { w, d } = await boot();
  const tabs = [...d.querySelectorAll('.tab-btn')].map(b => b.dataset.view);
  eq(tabs.join(','), 'home,timers,lists,daily,calendar,budget', 'tab bar order');
  const panels = [...d.querySelectorAll('.swipe-panel')].map(p => p.dataset.view);
  eq(panels.join(','), tabs.join(','), 'swipe panels match the tab bar');
  eq(get(w, 'VIEW_DEFS.map(v => v.key).join(",")'), tabs.join(','), 'VIEW_DEFS matches the DOM order');
  eq(new Set([...d.querySelectorAll('.tab-btn')].map(b => b.id)).size, 6, 'tab ids are unique');

  const listsPanel = d.querySelector('.swipe-panel[data-view="lists"]');
  const dailyPanel = d.querySelector('.swipe-panel[data-view="daily"]');
  ok(dailyPanel.contains(d.getElementById('dailySection-m')), 'Daily section lives in the Daily panel');
  ok(dailyPanel.contains(d.getElementById('defaultContainer-m')), 'Daily cards container lives in the Daily panel');
  ok(!listsPanel.contains(d.getElementById('dailySection-m')), 'Daily section is gone from the Lists panel');
  ok(listsPanel.contains(d.getElementById('dbdContainer-m')) && listsPanel.contains(d.getElementById('todoContainer-m')),
     'Lists panel keeps Day by Day + custom lists');
  eq(dailyPanel.querySelector('.page-title').textContent, 'Daily', 'Daily panel has its own title');
}

console.log('\n── 2. Mobile: navigation ──');
{
  const { w, d } = await boot();
  d.querySelector('.tab-btn[data-view="daily"]').click();
  eq(get(w, 'currentView'), 'daily', 'tapping Daily selects the daily panel');
  eq(trackIdx(w, d), 3, 'track slides to the 4th panel');
  ok(d.querySelector('.tab-btn[data-view="daily"]').classList.contains('active'), 'Daily tab is highlighted');
  ok(!d.querySelector('.tab-btn[data-view="lists"]').classList.contains('active'), 'Lists tab is not');
  w.goTab('lists', false);
  eq(get(w, 'currentView'), 'lists', 'goTab("lists") lands on Lists');
  eq(trackIdx(w, d), 2, 'track slides to the 3rd panel');
}

console.log('\n── 3. Mobile: daily cards render in the Daily panel ──');
{
  const { w, d } = await boot();
  w.eval(`todoLists.push({ id: todoIdCounter++, title: 'Test routine', color: '#22C55E', isDefault: true, activeDays: null, tasks: [] });
          todoLists.push({ id: todoIdCounter++, title: 'Test custom',  color: '#8B5CF6', isDefault: false, tasks: [] });
          renderTodos();`);
  const dailyTitles = [...d.querySelectorAll('#defaultContainer-m .todo-card input[id^="todo-title-"]')].map(i => i.value);
  const custTitles  = [...d.querySelectorAll('#todoContainer-m .todo-card input[id^="todo-title-"]')].map(i => i.value);
  ok(dailyTitles.includes('Test routine') && !dailyTitles.includes('Test custom'), 'daily list renders under Daily only');
  ok(custTitles.includes('Test custom') && !custTitles.includes('Test routine'), 'custom list renders under Lists only');
}

console.log('\n── 4. Desktop: sidebar Daily button + right-panel pages ──');
{
  const { w, d } = await boot();
  const rp = d.getElementById('rightPanel');
  const listsNav = d.getElementById('listsDesktopNavTab');
  const dailyNav = d.getElementById('dailyDesktopNavTab');
  ok(!!dailyNav, 'Daily button exists in the sidebar');
  ok(get(w, 'homeDesktopOpen'), 'desktop boots on Home');
  ok(!listsNav.classList.contains('active') && !dailyNav.classList.contains('active'), 'neither page is active while Home is open');

  dailyNav.click();
  eq(rp.dataset.page, 'daily', 'Daily click switches the right panel page');
  ok(!get(w, 'homeDesktopOpen'), 'Home overlay closed');
  ok(shown(rp), 'right panel is visible');
  ok(dailyNav.classList.contains('active') && !listsNav.classList.contains('active'), 'only Daily is highlighted');

  listsNav.click();
  eq(rp.dataset.page, 'lists', 'Lists click switches back');
  ok(listsNav.classList.contains('active') && !dailyNav.classList.contains('active'), 'only Lists is highlighted');

  d.getElementById('calDesktopNavTab').click();
  ok(get(w, 'calDesktopOpen'), 'calendar overlay opens');
  ok(!listsNav.classList.contains('active') && !dailyNav.classList.contains('active'), 'Lists/Daily both inactive under Calendar');
  dailyNav.click();
  ok(!get(w, 'calDesktopOpen'), 'Daily click closes the calendar overlay');
  eq(rp.dataset.page, 'daily', 'and shows the Daily page');

  d.getElementById('budgetDesktopNavTab').click();
  listsNav.click();
  ok(!get(w, 'budgetDesktopOpen') && rp.dataset.page === 'lists', 'Lists click closes the budget overlay');

  ok(rp.querySelector('#dailySection-d').classList.contains('page-daily'), 'daily section tagged page-daily');
  ok(rp.querySelector('#listsSection-d').classList.contains('page-lists'), 'lists section tagged page-lists');
  eq(rp.querySelectorAll('.page-head').length, 2, 'each page has its own heading');
}

console.log('\n── 5. Settings toggles ──');
{
  const { w, d } = await boot();
  d.getElementById('dailyDesktopNavTab').click();
  w.setViewEnabled('daily', false);
  ok(!shown(d.querySelector('.tab-btn[data-view="daily"]')), 'Daily off → mobile tab hidden');
  ok(!shown(d.querySelector('.swipe-panel[data-view="daily"]')), 'Daily off → mobile panel hidden');
  ok(!shown(d.getElementById('dailyDesktopNavTab')), 'Daily off → sidebar button hidden');
  ok(shown(d.querySelector('.tab-btn[data-view="lists"]')), 'Lists tab unaffected');
  ok(shown(d.getElementById('listsDesktopNavTab')), 'Lists sidebar button unaffected');
  eq(d.getElementById('rightPanel').dataset.page, 'lists', 'desktop falls over to the Lists page');
  eq(get(w, 'visibleViews().map(v => v.key).join(",")'), 'home,timers,lists,calendar,budget', 'swipe order skips Daily');

  w.setViewEnabled('lists', false);
  ok(!shown(d.getElementById('listsDesktopNavTab')), 'Lists off → sidebar button hidden');
  ok(get(w, 'homeDesktopOpen'), 'both off → desktop goes Home instead of a blank panel');

  w.setViewEnabled('daily', true);
  ok(shown(d.querySelector('.tab-btn[data-view="daily"]')), 'Daily back on → tab returns');
  eq(d.getElementById('rightPanel').dataset.page, 'daily', 'right panel now points at Daily (the only enabled page)');

  w.goTab('daily', false);
  w.setViewEnabled('daily', false);
  eq(get(w, 'currentView'), 'home', 'disabling the panel you are on sends mobile Home');
}

console.log('\n── 6. Persisted: a saved "daily off" still hides the tab after reload ──');
{
  const a = await boot();
  a.w.setViewEnabled('daily', false);
  const saved = a.w.localStorage.getItem('focus-app-state');
  const b = await boot({ 'focus-app-state': saved });
  ok(!shown(b.d.querySelector('.tab-btn[data-view="daily"]')), 'tab hidden after reload');
  ok(!shown(b.d.getElementById('dailyDesktopNavTab')), 'sidebar button hidden after reload');
}

console.log('\n── 7. Daily empty states ──');
{
  const { w, d } = await boot();
  w.eval('todoLists = todoLists.filter(l => !l.isDefault); renderTodos();');
  const hint = d.querySelector('#defaultContainer-m .daily-empty');
  ok(!!hint && /No daily lists yet/.test(hint.textContent), 'no daily lists → hint instead of a blank page');
  w.eval('renderTodos(); renderTodos();');
  eq(d.querySelectorAll('#defaultContainer-m .daily-empty').length, 1, 'hint is not duplicated on re-render');
  w.eval(`todoLists.push({ id: todoIdCounter++, title: 'Never', color: '#22C55E', isDefault: true, activeDays: [], tasks: [] }); renderTodos();`);
  const hint2 = d.querySelector('#defaultContainer-m .daily-empty');
  ok(!!hint2 && /No lists scheduled for today/.test(hint2.textContent), 'lists exist but none today → original hint kept');
  w.eval('formatMode = true; renderTodos();');
  eq(d.querySelectorAll('#defaultContainer-m .daily-empty').length, 0, 'Formats shows the lists themselves, no hint');
}

console.log('\n── 8. Tour opens the right desktop page ──');
{
  const { w, d } = await boot();
  w.eval('isMobileLayout = () => false');
  w.tourGoView('daily');
  eq(d.getElementById('rightPanel').dataset.page, 'daily', 'Daily step → Daily page');
  w.tourGoView('lists');
  eq(d.getElementById('rightPanel').dataset.page, 'lists', 'Day by Day / Lists step → Lists page');
  w.tourGoView('home');
  ok(get(w, 'homeDesktopOpen'), 'Home step still opens Home');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
