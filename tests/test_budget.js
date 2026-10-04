/* The Budget screen: today's balance and the total side by side, and Budget
 * settings (the three balances and the cash runway) folded away under them,
 * open or closed per device.
 * Run: npm test (or node --experimental-vm-modules tests/test_budget.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

const UI_KEY = 'focus-budget-ui';
const boot = (storage = {}) => loadApp({ storage: { 'focus-tour-done': '1', ...storage } });
const root = (d, pfx = 'd') => d.querySelector(`#budgetContainer-${pfx}`);
const text = (d, sel, pfx = 'd') => root(d, pfx).querySelector(sel)?.textContent.trim();
const todayFig = (d, pfx) => text(d, '.budget-figure-today .budget-figure-value', pfx);
const totalFig = (d, pfx) => text(d, '.budget-figure-total .budget-figure-value', pfx);
const summary = (d, pfx) => root(d, pfx).querySelector('.budget-settings-summary');
const toggle = (d, pfx = 'd') => root(d, pfx).querySelector('[data-budget="settings"]');
const isOpen = (d, pfx = 'd') => {
  const s = root(d, pfx).querySelector('.budget-settings'), body = s.querySelector('.budget-settings-body');
  const open = s.classList.contains('open');
  // the three ways of saying it agree, or the answer is neither
  return open === (toggle(d, pfx).getAttribute('aria-expanded') === 'true') && open === !body.hidden ? open : 'mixed';
};
const change = (w, el, value) => { el.value = value; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const set = (w, budget) => w.eval(`budget = normalizeBudget(${JSON.stringify({ lastDate: w.eval('dbdTodayKey()'), ...budget })}); renderBudget();`);
const PURCHASES = [{ id: 1, title: 'Coffee', amount: 4.75 }, { id: 2, title: 'Bus pass', amount: 8 }, { id: 3, title: 'Lunch', amount: 11.4 }];

(async () => {
  console.log('\n── 1. The figures: today\'s balance and the total, side by side ──');
  {
    const { w, d } = await boot();
    set(w, { initial: 842.6, daily: 25, purchases: PURCHASES });
    for (const pfx of ['d', 'm']) {
      eq(`${todayFig(d, pfx)} | ${totalFig(d, pfx)}`, '$0.85 | $818.45', `${pfx === 'd' ? 'desktop' : 'phone'}: $25 − $24.15 today, $842.60 − $24.15 in all`);
    }
    eq(text(d, '.budget-figure-today .budget-figure-note'), 'of $25.00 today', 'today\'s says what the day started with');
    eq(text(d, '.budget-figure-sub'), '$842.60 initial − $24.15 spent today', 'and the line under them says where the total comes from');
    ok(!root(d).querySelector('.budget-figures').classList.contains('long'), 'short amounts: full size');
    ok(!root(d).querySelector('.budget-figure.over, .budget-figure-cell.over'), 'nothing in red');

    set(w, { initial: 842.6, daily: 25, purchases: [...PURCHASES, { id: 4, title: 'Shoes', amount: 60 }] });
    ok(root(d).querySelector('.budget-figure-today').classList.contains('over')
      && !root(d).querySelector('.budget-figure-total').classList.contains('over')
      && !root(d).querySelector('.budget-figure').classList.contains('over'), 'over today\'s budget: today\'s in red, the total not');
    eq(todayFig(d), '-$59.15', 'below zero');

    set(w, { initial: 20, daily: 25, purchases: PURCHASES });
    ok(root(d).querySelector('.budget-figure-total').classList.contains('over')
      && root(d).querySelector('.budget-figure').classList.contains('over'), 'a total below zero turns the card red');

    set(w, { initial: 13604.32, daily: 25, purchases: [...PURCHASES, { id: 4, title: 'Laptop', amount: 1234.5 }] });
    eq(`${todayFig(d)} | ${totalFig(d)}`, '-$1233.65 | $12345.67', 'long amounts');
    ok(root(d).querySelector('.budget-figures').classList.contains('long'), 'make both figures smaller (to fit a phone, the same size)');

    set(w, { initial: 100, daily: 0, purchases: [] });
    eq(text(d, '.budget-figure-today .budget-figure-note'), 'No daily budget yet', 'no daily budget: it says so');
    change(w, root(d).querySelector('[data-bfield="today"]'), '0');
    eq(text(d, '.budget-figure-today .budget-figure-note'), 'of $0.00 today', 'today\'s balance set to $0 on purpose: of $0.00');
  }

  console.log('\n── 2. Budget settings: folded away until opened ──');
  {
    const { w, d } = await boot();
    set(w, { initial: 842.6, daily: 25, purchases: PURCHASES });
    for (const pfx of ['d', 'm']) eq(isOpen(d, pfx), false, `${pfx === 'd' ? 'desktop' : 'phone'}: closed at first`);
    const body = root(d).querySelector('.budget-settings-body');
    ok(['today', 'daily', 'initial'].every(k => body.querySelector(`[data-bfield="${k}"]`)), 'it holds today\'s balance, the daily budget and the initial balance');
    ok(body.querySelector('.runway'), 'and the cash runway');
    eq(root(d).querySelectorAll('[data-bfield], .runway').length, 4, 'which are nowhere else');
    ok(!body.querySelector('.budget-new-title, .budget-purchase-list'), 'purchases stay out, under it');
    eq(summary(d).textContent, '$25.00 a day', 'folded, it says the daily budget');
    eq(text(d, '.budget-settings-title'), 'Budget settings', 'under its name');
    ok(toggle(d).tagName === 'BUTTON', 'the row is a button (Tab, Enter and Space reach it)');
    set(w, { initial: 842.6, daily: 0, purchases: [] });
    eq(summary(d).textContent, 'No daily budget', 'or that there is none');
  }

  console.log('\n── 3. Opening it, on this device only ──');
  {
    const { w, d } = await boot();
    set(w, { initial: 842.6, daily: 25, purchases: PURCHASES });
    w.saveToLocal();
    const saved = w.localStorage.getItem('focus-app-state');
    toggle(d).click();
    eq(isOpen(d, 'd'), true, 'a tap opens it');
    eq(isOpen(d, 'm'), true, 'in the phone layout too (one setting)');
    eq(w.localStorage.getItem(UI_KEY), '{"open":true}', 'remembered on this device');
    ok(d.activeElement === toggle(d), 'focus stays on the row (drawn again)');
    w.saveToLocal();
    ok(w.localStorage.getItem('focus-app-state') === saved, 'not part of the synced state: another device keeps its own');

    const again = await boot({ 'focus-app-state': w.localStorage.getItem('focus-app-state'), [UI_KEY]: w.localStorage.getItem(UI_KEY) });
    eq(isOpen(again.d), true, 'open again after a reload');
    toggle(again.d, 'm').click();
    eq(`${isOpen(again.d, 'd')} ${isOpen(again.d, 'm')}`, 'false false', 'a second tap folds it (from the phone layout, both)');
    eq(again.w.localStorage.getItem(UI_KEY), '{"open":false}', 'and that is remembered');
    ok(again.d.activeElement === toggle(again.d, 'm'), 'focus stays on the row it was tapped in');

    const odd = await boot({ [UI_KEY]: 'not json' });
    eq(isOpen(odd.d), false, 'an unreadable setting: closed');
  }

  console.log('\n── 4. Changing the balances inside it ──');
  {
    const { w, d } = await boot({ [UI_KEY]: '{"open":true}' });
    set(w, { initial: 842.6, daily: 25, purchases: PURCHASES });
    change(w, root(d, 'm').querySelector('[data-bfield="daily"]'), '30');
    eq(w.eval('budget.daily'), 30, 'the daily budget is changed');
    eq(summary(d, 'm').textContent, '$30.00 a day', 'the row says so');
    eq(`${todayFig(d, 'm')} | ${isOpen(d, 'm')}`, '$5.85 | true', 'today\'s balance follows it, and the settings stay open');
    change(w, root(d, 'm').querySelector('[data-bfield="today"]'), '10');
    eq(`${w.eval('todayBalance()')} ${todayFig(d, 'm')} ${totalFig(d, 'm')}`, '10 $10.00 $818.45', 'today\'s balance on its own: the total doesn\'t move');
    change(w, root(d, 'm').querySelector('[data-bfield="initial"]'), '900');
    eq(`${totalFig(d, 'm')} ${todayFig(d, 'm')}`, '$875.85 $10.00', 'the initial balance on its own: today\'s doesn\'t move');
    eq(text(d, '.budget-figure-sub', 'm'), '$900.00 initial − $24.15 spent today', 'and the line under them follows');
  }

  console.log('\n── 5. Folded, it still says how long the cash lasts ──');
  {
    const { w, d } = await boot();
    const today = w.eval('dbdTodayKey()');
    w.eval(`runway = normalizeRunway({ payday: addDays('${today}', 9), repeat: 'biweekly', bills: [] })`);
    set(w, { initial: 842.6, daily: 25, purchases: PURCHASES });
    const days = text(d, '.runway-value');
    ok(/^\d+ days of cash$/.test(days), `the runway: ${days}`);
    eq(summary(d).textContent, `$25.00 a day · ${days}`, 'the row says the same');
    ok(!summary(d).classList.contains('short'), 'not in red');

    set(w, { initial: 120, daily: 25, purchases: PURCHASES });
    const r = w.eval('runwayResult()');
    ok(r.short && r.runsOutOn > today, 'with $120, the cash runs out before payday');
    const day = w.eval(`fmtDayKey('${r.runsOutOn}')`);
    eq(summary(d).textContent, `Cash runs out ${day}`, 'the row says when');
    ok(summary(d).classList.contains('short'), 'in red, so folding it away never hides it');
    ok(text(d, '.runway-status').startsWith(`Runs out ${day}`), 'the same day as the runway inside');

    set(w, { initial: 10, daily: 25, purchases: [] });
    eq(summary(d).textContent, 'Cash runs out today', 'out today: today');

    w.eval(`runway = normalizeRunway({ payday: addDays('${today}', -1), repeat: 'once', bills: [] })`);
    set(w, { initial: 842.6, daily: 25, purchases: [] });
    eq(summary(d).textContent, '$25.00 a day · set your next payday', 'the payday passed: asks for the next');
  }

  console.log('\n── 6. A device that can\'t save the setting ──');
  {
    const { w, d, errors } = await boot();
    const before = errors.length, setItem = w.Storage.prototype.setItem;
    w.Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
    toggle(d).click();
    w.Storage.prototype.setItem = setItem;
    ok(errors.length === before && isOpen(d) === true, 'storage full or blocked: it opens anyway, for now');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
