/* Smoke test for the ES-module build. The page loads js/main.js as a module, the
 * service worker precaches every module, and the real modules (no test bridge)
 * boot in jsdom without an uncaught error. The main views render, and every
 * inline on…="…" handler in the rendered page names a function that is really
 * on window: module code is not global, so a handler that names a function main.js
 * forgot to expose would only fail when someone taps it.
 * Run: npm test (or node --experimental-vm-modules tests/test_smoke.js) */
const fs = require('fs');
const path = require('path');
const { loadApp, ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Names an inline handler calls: identifiers followed by "(", not after a dot. */
function handlerCalls(code) {
  return [...code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
    .filter(n => !['if', 'for', 'while', 'switch', 'return', 'function'].includes(n));
}
function inlineHandlers(d) {
  const found = new Map();   // name → an example "tag[onX]"
  d.querySelectorAll('*').forEach(el => {
    for (const a of el.attributes) {
      if (!/^on[a-z]+$/.test(a.name)) continue;
      handlerCalls(a.value).forEach(n => { if (!found.has(n)) found.set(n, `<${el.tagName.toLowerCase()} ${a.name}="${a.value}">`); });
    }
  });
  return found;
}

/* Only Google's two endpoints are faked: an empty calendar list and no events. */
const fakeFetch = async url => {
  const u = String(url);
  if (u.includes('/calendarList')) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'primary', summary: 'Me', backgroundColor: '#378ADD' }] }) };
  if (u.includes('/events')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

(async () => {
  console.log('\n── 1. index.html loads one module entry point ──');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const moduleTags = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]).filter(a => /type="module"/.test(a));
  eq(moduleTags.length, 1, 'exactly one module script');
  ok(/\bsrc="js\/main\.js"/.test(moduleTags[0] || ''), 'and it is js/main.js');
  ok(!/\bsrc="app\.js"/.test(html), 'the old app.js is not loaded');

  console.log('\n── 2. The service worker precaches exactly the modules on disk ──');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listed = [...sw.matchAll(/'\.\/(js\/[^']+\.js)'/g)].map(m => m[1]).sort();
  const onDisk = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f).sort();
  eq(listed.join(' '), onDisk.join(' '), 'SHELL_FILES lists every js/ module and nothing else');
  ok(!/'\.\/app\.js'/.test(sw), 'and no longer lists app.js');

  console.log('\n── 3. The real modules boot (fresh device → starter profile) ──');
  const token = JSON.stringify({ access_token: 'x', expires_at: Date.now() + 3600e3 });
  const cals = JSON.stringify([{ id: 'primary', summary: 'Me', color: '#378ADD', enabled: true }]);
  const { w, d, modules, errors } = await loadApp({
    bridge: false,
    storage: { 'focus-gcal-token': token, 'focus-gcal-calendars': cals },
    before: w => { w.fetch = fakeFetch; w.HTMLElement.prototype.scrollIntoView = function () {}; },
  });
  await sleep(20);
  const loaded = [...modules.keys()].map(f => 'js/' + path.basename(f)).sort();
  eq(loaded.join(' '), onDisk.join(' '), 'main.js reaches every module (none is dead)');
  eq(errors.length, 0, 'no uncaught error while booting' + (errors[0] ? ': ' + errors[0].message : ''));
  eq(typeof w.firebase, 'undefined', 'without the Firebase SDK the app still boots (sync off)');
  eq(typeof w.timers, 'undefined', 'module state is not leaking onto window');
  ok(d.querySelectorAll('#timerStack-d .timer-card').length > 0, 'timer cards rendered');
  ok(d.querySelectorAll('#defaultContainer-d .todo-card').length > 0, 'Daily lists rendered');
  ok(d.querySelectorAll('#todoContainer-d .todo-card').length > 0, 'custom lists rendered');
  ok(d.querySelector('#homeContainer-d .home-hero'), 'Home rendered');
  ok(d.querySelector('#budgetContainer-d .budget-wrap'), 'Budget rendered');
  ok(d.querySelector('#calMobileGrid .cal-mobile-day-col'), 'calendar day rendered');
  ok(d.getElementById('tourWelcomeModal').classList.contains('show'), 'first run offers the tour');
  d.getElementById('tourSkipWelcomeBtn').click();

  console.log('\n── 4. Walk the UI that renders inline handlers ──');
  const seen = new Map();
  const collect = () => inlineHandlers(d).forEach((v, k) => { if (!seen.has(k)) seen.set(k, v); });
  collect();
  d.getElementById('fmtBtn').click();                          // Formats: remove buttons, schedules
  ok(d.body.classList.contains('format-mode'), 'Formats opens');
  collect();
  d.getElementById('fmtBtn').click();
  ok(!d.body.classList.contains('format-mode'), 'Formats closes (Done)');
  d.getElementById('settingsBtn').click();                     // Settings → Email digest on
  const tog = d.getElementById('digestEnabledToggle');
  tog.checked = true; tog.dispatchEvent(new w.Event('change', { bubbles: true }));
  collect();                                                   // empty digest card
  d.getElementById('digestSampleBtn').click();                 // sample → suggested tasks
  collect();
  d.getElementById('gcalConnectBtn').click();                  // connected → calendars modal
  ok(d.getElementById('gcalModal').classList.contains('show'), 'Google Calendar modal opens with a saved token');
  collect();
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));

  console.log('\n── 5. Every inline handler names a function on window ──');
  const missing = [...seen].filter(([n]) => typeof w[n] !== 'function');
  missing.forEach(([n, where]) => console.log('     missing:', n, 'in', where));
  eq(missing.length, 0, `all ${seen.size} functions named by inline handlers exist on window`);
  ok(seen.size >= 30, `the walk reached most handlers (${seen.size})`);
  // handlers in HTML the walk can't reach (e.g. insight cards only show when a rule fires):
  // every name a module writes straight after on…=" must be on window too
  const written = new Set();
  fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).forEach(f => {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    for (const m of src.matchAll(/\bon[a-z]+="([A-Za-z_$][\w$]*)\(/g)) if (!['if', 'for', 'while', 'switch'].includes(m[1])) written.add(m[1]);
  });
  const unexposed = [...written].filter(n => typeof w[n] !== 'function');
  eq(unexposed.join(), '', `every handler named in module HTML (${written.size}) is on window`);

  console.log('\n── 6. Inline handlers run ──');
  const before = errors.length;
  const play = d.querySelector('#timerStack-d .play-btn');
  play.click();
  ok(play.classList.contains('running'), 'play button starts a timer (onclick="toggleTimer(…)")');
  play.click();
  const check = d.querySelector('#defaultContainer-d .task-check');
  const wasDone = check.classList.contains('done');
  check.click();
  ok(check.classList.contains('done') !== wasDone, 'task check toggles (onclick="toggleTask(…)")');
  const star = d.querySelector('#todoContainer-d [onclick^="toggleStarList"]');
  if (star) star.click();
  const rows = () => d.querySelectorAll('#todoContainer-d .task-row').length;
  const n0 = rows();
  d.querySelector('#todoContainer-d [onclick^="addTask"]').click();
  eq(rows(), n0 + 1, 'add button adds a task (onclick="addTask(…)")');
  const inputs = d.querySelectorAll('#todoContainer-d input.task-text');
  const fresh = inputs[inputs.length - 1];
  fresh.value = 'Smoke-test task';
  fresh.dispatchEvent(new w.Event('input', { bubbles: true }));   // oninput="setTaskText(…)"
  fresh.dispatchEvent(new w.Event('blur'));                        // onblur="refreshSyncBadges();…"
  eq(errors.length - before, 0, 'no uncaught error from the handlers');

  console.log('\n── 7. State survives a reload through the modules ──');
  w.dispatchEvent(new w.Event('pagehide'));
  const saved = w.localStorage.getItem('focus-app-state');
  ok(saved && JSON.parse(saved).todoLists.some(l => l.tasks.some(t => t.text === 'Smoke-test task')), 'saved to localStorage');
  const again = await loadApp({ bridge: false, storage: { 'focus-app-state': saved, 'focus-tour-done': '1' } });
  ok([...again.d.querySelectorAll('#todoContainer-d input')].some(i => i.value === 'Smoke-test task'), 'a second boot shows it');
  eq(again.errors.length, 0, 'second boot has no uncaught error');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
