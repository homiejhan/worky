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
console.log('\n── 1. Mobile: seven tabs, Daily has its own panel ──');
{
  const { w, d } = await boot();
  const tabs = [...d.querySelectorAll('.tab-btn')].map(b => b.dataset.view);
  eq(tabs.join(','), 'home,timers,lists,daily,calendar,budget,digest', 'tab bar order (Digest shows while the email digest is on)');
  const panels = [...d.querySelectorAll('.swipe-panel')].map(p => p.dataset.view);
  eq(panels.join(','), tabs.join(','), 'swipe panels match the tab bar');
  eq(get(w, 'VIEW_DEFS.map(v => v.key).join(",")'), tabs.join(','), 'VIEW_DEFS matches the DOM order');
  eq(new Set([...d.querySelectorAll('.tab-btn')].map(b => b.id)).size, 7, 'tab ids are unique');

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

console.log('\n── 5. Settings → Sections picks the bottom bar; every tab stays reachable ──');
{
  const { w, d } = await boot();
  d.getElementById('dailyDesktopNavTab').click();
  w.setViewEnabled('daily', false);
  ok(!shown(d.querySelector('.tab-btn[data-view="daily"]')), 'Daily off → its tab leaves the bottom bar');
  ok(!shown(d.querySelector('.swipe-panel[data-view="daily"]')), 'and its panel the swipe track');
  ok(d.querySelector('#sideMenuList [data-menu-view="daily"]'), 'it is still in the ☰ menu');
  ok(shown(d.getElementById('dailyDesktopNavTab')), 'and in the sidebar on a computer');
  eq(d.getElementById('rightPanel').dataset.page, 'daily', 'the desktop page stays on Daily');
  ok(shown(d.querySelector('.tab-btn[data-view="lists"]')), 'Lists tab unaffected');
  eq(get(w, 'trackViews().join(",")'), 'home,timers,lists,calendar,budget', 'swipe order skips Daily');

  w.setViewEnabled('lists', false);
  ok(shown(d.getElementById('listsDesktopNavTab')) && !get(w, 'homeDesktopOpen'), 'both off the bar: the computer keeps both pages, no jump to Home');
  eq([...d.querySelectorAll('.tab-btn')].filter(shown).map(b => b.dataset.view).join(','), 'home,timers,calendar,budget', 'the bar holds the rest');

  w.setViewEnabled('daily', true);
  ok(shown(d.querySelector('.tab-btn[data-view="daily"]')), 'Daily back on → its tab returns');

  w.goTab('daily', false);
  w.setViewEnabled('daily', false);
  eq(get(w, 'currentView'), 'daily', 'taking the tab you are on off the bar leaves you on it');
  ok(shown(d.querySelector('.swipe-panel[data-view="daily"]')), 'its panel stays while it is showing');
  ok(!d.querySelector('.tab-btn.active') || !shown(d.querySelector('.tab-btn.active')), 'no tab on the bar lights up for it');
  w.goTab('home', false);
  ok(!shown(d.querySelector('.swipe-panel[data-view="daily"]')), 'once you leave it, it leaves the track');

  w.goTab('timers', false);
  w.goTab('daily', true);
  eq(get(w, 'trackViews().join(",")'), 'home,timers,daily,calendar,budget', 'opened from the menu: in the track, in tab order, while it shows');
  eq(trackIdx(w, d), 2, 'and the track slides to it');
  ok(shown(d.querySelector('.swipe-panel[data-view="timers"]')), 'the tab it came from stays for the slide');
}

console.log('\n── 6. Persisted: a saved "daily off" keeps it off the bar after reload ──');
{
  const a = await boot();
  a.w.setViewEnabled('daily', false);
  const saved = a.w.localStorage.getItem('focus-app-state');
  const b = await boot({ 'focus-app-state': saved });
  ok(!shown(b.d.querySelector('.tab-btn[data-view="daily"]')), 'tab off the bar after reload');
  ok(shown(b.d.getElementById('dailyDesktopNavTab')), 'sidebar button still there');
  ok(b.d.querySelector('#sideMenuList [data-menu-view="daily"]'), 'and the ☰ menu entry');
}

console.log('\n── 6b. The ☰ menu, the logo and the toolbar ──');
{
  const { w, d } = await boot();
  const menu = d.getElementById('sideMenu');
  const btn = d.getElementById('menuBtn');
  ok(btn && !menu.classList.contains('open') && btn.getAttribute('aria-expanded') === 'false', 'a ☰ button, the menu closed');
  btn.click();
  ok(menu.classList.contains('open') && d.getElementById('sideMenuScrim').classList.contains('open'), '☰ opens the menu over a scrim');
  eq(btn.getAttribute('aria-expanded'), 'true', 'aria-expanded says so');
  eq([...menu.querySelectorAll('.side-menu-item')].map(b => b.dataset.menuView).join(','), 'home,timers,lists,daily,calendar,budget', 'every tab (no Digest while the digest is off)');
  ok(menu.querySelector('.side-menu-item.active').dataset.menuView === 'home', 'the one showing is marked');
  menu.querySelector('[data-menu-view="calendar"]').click();
  eq(get(w, 'currentView'), 'calendar', 'tapping one opens it');
  ok(!menu.classList.contains('open'), 'and closes the menu');
  btn.click();
  ok(menu.querySelector('.side-menu-item.active').dataset.menuView === 'calendar', 'now Calendar is marked');
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  ok(!menu.classList.contains('open'), 'Escape closes it');
  btn.click(); d.getElementById('sideMenuScrim').click();
  ok(!menu.classList.contains('open'), 'so does a tap beside it');
  btn.click(); btn.click();
  ok(!menu.classList.contains('open'), 'and ☰ again');
  w.digestSetEnabled(true);
  ok(menu.querySelector('[data-menu-view="digest"]'), 'with the digest on, Digest joins the menu');

  w.eval('isMobileLayout = () => true');
  w.goTab('budget', false);
  btn.click();
  d.getElementById('sideMenuBrand').click();
  ok(get(w, 'currentView') === 'home' && !menu.classList.contains('open'), 'the logo in the menu goes Home');
  w.goTab('calendar', false);
  d.getElementById('brandHomeBtn-m').click();
  eq(get(w, 'currentView'), 'home', 'phone: the logo in the top bar goes Home');
  w.eval('isMobileLayout = () => false');
  d.getElementById('budgetDesktopNavTab').click();
  d.getElementById('brandHomeBtn-d').click();
  ok(get(w, 'homeDesktopOpen') && !get(w, 'budgetDesktopOpen'), 'computer: the logo in the sidebar goes Home');

  eq(d.getElementById('moreBtn'), null, 'no ⋯ menu any more');
  ok(!d.getElementById('dataBar').querySelector('#exportBtn, #importBtn'), 'Export and Import are not in the toolbar');
  d.getElementById('resetAllBtn').click();
  ok(d.getElementById('confirmOverlay').classList.contains('show'), 'Reset the day is its own button, asking first');
  w.closeModal('confirmOverlay');

  d.getElementById('settingsBtn').click();
  d.querySelector('[data-settings-nav="data"]').click();
  const dataSec = d.querySelector('[data-settings-section="data"]');
  ok(dataSec.querySelector('#exportBtn') && dataSec.querySelector('#importBtn') && dataSec.querySelector('#clearStorageBtn'), 'Settings → Data has Export, Import and Clear storage');
  d.getElementById('exportBtn').click();
  ok(!d.getElementById('settingsModal').classList.contains('show') && d.getElementById('exportModal').classList.contains('show'), 'Export closes Settings and opens the export dialog');
  eq(w.decompressState(JSON.parse(d.getElementById('exportTextarea').value)).version, 1, 'with the data in it');
  w.closeModal('exportModal');
  d.getElementById('settingsBtn').click();
  d.getElementById('importBtn').click();
  ok(!d.getElementById('settingsModal').classList.contains('show') && d.getElementById('importModal').classList.contains('show'), 'Import opens the import dialog');
  ok(d.getElementById('importModal').contains(d.getElementById('fileInput')), 'its file picker sits with it');
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
