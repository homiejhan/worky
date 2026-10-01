/* Bank transactions logged in Budget: the pure rules in js/bankbudget.js, on
 * fixtures. The app side (Settings, the Budget screen, sync) is in test_bank.js.
 * Run: npm test -- bankbudget (or node --experimental-vm-modules tests/test_bankbudget.js) */
const path = require('path');
const { ROOT } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

const TODAY = '2026-09-29';
const ACCOUNTS = [
  { id: 'chk', type: 'depository', subtype: 'checking' },
  { id: 'sav', type: 'depository', subtype: 'savings' },
  { id: 'cc', type: 'credit', subtype: 'credit card' },
];
const tx = (id, amount, date, name, more = {}) => ({ id, account: 'chk', amount, date, name, pending: false, ...more });
const item = (transactions, more = {}) => ({ id: 'item-1', accounts: ACCOUNTS, transactions, updatedAt: 1, status: 'HISTORICAL_UPDATE_COMPLETE', ...more });

(async () => {
  const B = await import(path.join(ROOT, 'js', 'bankbudget.js'));
  /* A pass: run the rules like budget.js does, keeping state between passes. */
  function budgetWorld(purchases = []) {
    const w = { tracked: {}, purchases, balance: 0, log: [], nextId: 100 };
    w.pass = (items, today = TODAY) => {
      const r = B.bankBudgetStep({ tracked: w.tracked, items, purchases: w.purchases, today, nextId: w.nextId });
      Object.assign(w, { tracked: r.tracked, purchases: r.purchases, nextId: r.nextId, balance: w.balance + r.balance, log: [...w.log, ...r.log], last: r });
      return r;
    };
    return w;
  }
  const history = [
    tx('h1', 4.33, '2026-09-28', 'Starbucks', { pending: true }),
    tx('h2', 6.33, '2026-09-27', 'Uber'),
    tx('h3', -232.5, '2026-09-25', 'Campus Café payroll'),
    tx('s1', -4.22, '2026-09-20', 'Interest', { account: 'sav' }),
    tx('c1', 89.4, '2026-09-26', 'SparkFun', { account: 'cc' }),
  ];

  console.log('\n── 1. Which accounts, and the sync point ──');
  {
    ok(B.bankSpendingAccount(ACCOUNTS[0]) && !B.bankSpendingAccount(ACCOUNTS[1]) && !B.bankSpendingAccount(ACCOUNTS[2]),
      'Budget follows checking, not savings or a credit card');
    ok(B.bankSpendingAccount({ type: 'depository', subtype: 'cash management' }) && B.bankSpendingAccount({ type: 'depository', subtype: 'prepaid' }),
      'nor other spending accounts: cash management, prepaid');
    ok(!B.bankItemReady({ updatedAt: 0, transactions: [] }), 'a connection not refreshed yet is not ready');
    ok(!B.bankItemReady({ updatedAt: 5, status: 'NOT_READY', transactions: [] }), 'nor one whose history Plaid is still gathering');
    ok(B.bankItemReady({ updatedAt: 5, status: 'INITIAL_UPDATE_COMPLETE', transactions: [] }), 'ready once Plaid has the history');
    ok(B.bankItemReady({ updatedAt: 5, transactions: [{}] }) && !B.bankItemReady({ updatedAt: 5, transactions: [] }),
      'without a status (an older copy), having transactions will do');

    const w = budgetWorld([{ id: 1, title: 'Lunch', amount: 9 }]);
    let r = w.pass([item([], { updatedAt: 0, status: null })]);
    ok(!r.changed && !w.tracked['item-1'], 'nothing happens before the connection is ready');
    r = w.pass([item(history)]);
    ok(r.changed && w.tracked['item-1'].since === TODAY, 'ready: the sync point is today');
    eq(Object.keys(w.tracked['item-1'].seen).sort().join(), 'h1,h2,h3', 'what the checking account shows now counts as already in the balance');
    ok(w.balance === 0 && w.purchases.length === 1 && w.log.length === 0 && r.logged === 0, 'and nothing is logged: the balance is taken to match the bank');
    r = w.pass([item(history)]);
    ok(!r.changed, 'the same connection again: nothing changes');
  }

  console.log('\n── 2. New transactions ──');
  {
    const w = budgetWorld([{ id: 1, title: 'Lunch', amount: 9 }]);
    w.pass([item(history)]);
    const more = [...history,
      tx('n1', 12.5, TODAY, 'Chipotle', { pending: true }),
      tx('n2', 30, '2026-09-28', 'Target'),
      tx('n3', -500, TODAY, 'Payroll'),
      tx('n4', 20, TODAY, 'Transfer', { account: 'sav' }),
      tx('n5', 55, TODAY, 'Amazon', { account: 'cc' }),
      tx('n6', 3.1, '2026-09-10', 'Late history'),
    ];
    const r = w.pass([item(more)]);
    eq(r.logged, 3, 'three new checking transactions are logged');
    const chip = w.purchases.find(p => p.bank === 'n1');
    ok(chip && chip.title === 'Chipotle' && chip.amount === 12.5 && chip.pending === true && chip.id === 100,
      'money out today → a purchase today, marked as from the bank, and pending');
    eq(w.balance, 470, 'yesterday\'s Target (−30) and today\'s payroll (+500) go to the total balance');
    eq(w.log.map(l => `${l.d} ${l.n} ${l.a}`).join(' | '), '2026-09-28 Target -30 | 2026-09-29 Payroll 500', 'each with a line under From your bank');
    ok(!w.purchases.some(p => p.bank === 'n4' || p.bank === 'n5') && w.log.length === 2, 'savings and the credit card are left out');
    ok(w.tracked['item-1'].seen.n6 && !w.log.some(l => l.n === 'Late history'), 'a row dated well before the sync point is late history: counted, not logged');
    const again = w.pass([item(more)]);
    ok(!again.changed && w.purchases.length === 2, 'seen again (the next refresh, another device): not logged twice');
  }

  console.log('\n── 3. A pending charge posts, changes, or is dropped ──');
  {
    const w = budgetWorld();
    w.pass([item(history)]);
    const p1 = tx('p1', 20, TODAY, 'Pizza Place', { pending: true });
    w.pass([item([...history, p1])]);
    const entry = () => w.purchases.find(p => p.title === 'Pizza Place');
    ok(entry() && entry().amount === 20 && entry().pending, 'the pending charge is a purchase today');
    w.pass([item([...history, { ...p1, amount: 22 }])]);
    eq(entry().amount, 22, 'Plaid changes its amount while pending: the purchase follows');
    const posted = tx('t1', 25, TODAY, 'PIZZA PLACE #42', { pending_id: 'p1' });
    let r = w.pass([item([...history, posted])]);
    ok(entry() && entry().bank === 't1' && !entry().pending, 'it posts (a new id pointing at the pending one): the same purchase, no longer pending');
    ok(entry().amount === 25 && w.purchases.length === 1, 'with the final amount (a tip), not a second purchase');
    ok(!w.tracked['item-1'].seen.p1 && w.tracked['item-1'].seen.t1.a === 25, 'the posted copy is what is counted now');
    w.pass([item([...history, posted, { ...p1, amount: 22 }])]);
    ok(w.purchases.length === 1 && entry().amount === 25 && w.balance === 0 && !w.tracked['item-1'].seen.p1,
      'a pending copy still listed next to its posted one is not counted again');

    const p2 = tx('p2', 45, TODAY, 'Gas station hold', { pending: true });
    w.pass([item([...history, posted, p2])]);
    ok(w.purchases.some(p => p.bank === 'p2'), 'a hold shows as a purchase');
    r = w.pass([item([...history, posted])]);
    ok(!w.purchases.some(p => p.bank === 'p2') && r.logged === 1, 'the bank drops it: the purchase goes');

    /* the same across a new day: the purchase from yesterday is in the balance now */
    const y = budgetWorld();
    y.pass([item(history)], '2026-09-28');
    const hold = tx('p3', 60, '2026-09-28', 'Hotel hold', { pending: true });
    y.pass([item([...history, hold])], '2026-09-28');
    y.purchases = [];                                                  // new day: yesterday's purchases went into the balance
    y.pass([item(history)], TODAY);
    eq(y.balance, 60, 'dropped after the day ended: it is given back to the total balance');
    eq(y.log.at(-1).n + ' ' + y.log.at(-1).a, 'Hotel hold 60', 'and says what came back');
    const z = budgetWorld();
    z.pass([item(history)], '2026-09-28');
    z.pass([item([...history, { ...hold, id: 'p4', amount: 18 }])], '2026-09-28');
    z.purchases = [];
    z.pass([item([...history, tx('t4', 21, TODAY, 'Hotel', { pending_id: 'p4' })])], TODAY);
    ok(z.balance === -3 && z.log.at(-1).a === -3, 'posted after the day ended with another amount: only the difference (−3) moves the balance');

    /* a bank that doesn't link a posted charge to its pending one: dropped + new, which comes to the same */
    const u = budgetWorld();
    u.pass([item(history)]);
    u.pass([item([...history, tx('p5', 10, TODAY, 'Deli', { pending: true })])]);
    u.pass([item([...history, tx('t5', 12, TODAY, 'Deli')])]);
    eq(u.purchases.reduce((s, p) => s + p.amount, 0) - u.balance, 12, 'without the link: the pending one goes and the posted one comes, $12 in all');
  }

  console.log('\n── 4. Purchases typed by hand, and ones taken out ──');
  {
    const w = budgetWorld([{ id: 1, title: 'Coffee', amount: 4.75 }, { id: 2, title: 'Book', amount: 20 }]);
    w.pass([item(history)]);
    w.pass([item([...history, tx('k1', 4.75, TODAY, 'STARBUCKS 123', { pending: true })])]);
    eq(w.purchases.length, 2, 'the bank sees a purchase typed today for the same amount: no second copy');
    ok(w.purchases[0].title === 'Coffee' && w.purchases[0].bank === 'k1' && w.purchases[0].pending, 'the typed one is matched to it and keeps its name');
    w.pass([item([...history, tx('k2', 4.75, TODAY, 'STARBUCKS 123', { pending_id: 'k1' })])]);
    ok(w.purchases[0].bank === 'k2' && !w.purchases[0].pending && w.purchases.length === 2, 'and follows it when it posts');
    w.pass([item([...history, tx('k2', 4.75, TODAY, 'STARBUCKS 123', { pending_id: 'k1' }), tx('k3', 20, '2026-09-28', 'Books')])]);
    ok(w.purchases.find(p => p.id === 2).bank === undefined && w.balance === -20, 'the same amount dated another day is not a match: it goes to the balance');

    const x = budgetWorld();
    x.pass([item(history)]);
    const p = tx('q1', 15, TODAY, 'Movie tickets', { pending: true });
    x.pass([item([...history, p])]);
    x.purchases = x.purchases.filter(e => e.bank !== 'q1');                   // the user deletes it in Budget
    x.tracked = B.bankBudgetSkip(x.tracked, 'q1');
    eq(x.tracked['item-1'].seen.q1.x, 1, 'a purchase from the bank taken out of Budget is marked');
    x.pass([item([...history, tx('q2', 18, TODAY, 'Movie tickets', { pending_id: 'q1' })])]);
    ok(x.purchases.length === 0 && x.balance === 0 && x.tracked['item-1'].seen.q2.x === 1, 'and stays out when it posts, with another amount');
    x.pass([item(history)]);
    eq(x.balance, 0, 'or when the bank drops it');
  }

  console.log('\n── 5. Connections come and go, lists age out ──');
  {
    const w = budgetWorld();
    w.pass([item(history), { ...item([tx('b1', 5, TODAY, 'Other bank')]), id: 'item-2' }]);
    ok(w.tracked['item-1'] && w.tracked['item-2'], 'each connection has its own sync point');
    let r = w.pass([item(history)]);
    ok(!r.changed && w.tracked['item-2'], 'a bank missing from a pass keeps its sync point (a copy of the list can lag; Disconnect drops it in budget.js)');
    r = w.pass([]);
    ok(!r.changed && Object.keys(w.tracked).length === 2 && w.balance === 0, 'even with none listed: nothing is dropped and nothing moves');
    r = w.pass([item(history), { ...item([tx('b1', 5, TODAY, 'Other bank'), tx('b2', 3, TODAY, 'Snack')]), id: 'item-2' }]);
    ok(r.logged === 1 && w.purchases.some(p => p.bank === 'b2'), 'back again, what came meanwhile is logged, not taken into a new sync point');

    const full = Array.from({ length: 50 }, (_, i) => tx(`f${i}`, 1, `2026-09-${String(29 - Math.floor(i / 5)).padStart(2, '0')}`, 'x'));
    const old = tx('old', 7, '2026-09-20', 'Old pending', { pending: true });
    const v = budgetWorld();
    v.pass([item([...full.slice(0, 49), old])]);
    v.pass([item(full)]);
    ok(v.balance === 0 && !v.tracked['item-1'].seen.old, 'a pending row that aged out of a full list (newest 50) is not given back');
  }

  console.log('\n── 6. Copies that lag, merges, banks that post in place ──');
  {
    const w = budgetWorld();
    w.pass([item(history)]);
    w.pass([item([...history, tx('x1', 30, '2026-09-28', 'Target')])]);
    eq(w.balance, -30, 'a new transaction dated yesterday is logged');
    w.pass([item(history)]);
    ok(w.balance === -30 && w.tracked['item-1'].seen.x1, 'a copy of the list saved before it came: it stays counted');
    w.pass([item([...history, tx('x1', 30, '2026-09-28', 'Target')])]);
    ok(w.balance === -30 && w.last.logged === 0, 'and is not counted again when the newer copy comes back');

    const m = budgetWorld([{ id: 7, title: 'Chipotle', amount: 12.5, bank: 'p1', pending: true }]);
    m.pass([item(history)]);
    const r = m.pass([item([...history, tx('p1', 12.5, TODAY, 'Chipotle', { pending: true })])]);
    ok(r.logged === 0 && m.purchases.length === 1 && m.balance === 0 && m.tracked['item-1'].seen.p1,
      'a purchase another device already logged (its count lost a merge) is taken as counted, not logged twice');
    m.pass([item([...history, tx('p1', 12.5, TODAY, 'Chipotle')])]);
    ok(m.purchases.length === 1 && !m.purchases[0].pending, 'a bank that posts a charge under the same id: the purchase is no longer pending');

    const t = budgetWorld([{ id: 8, title: 'Chipotle', amount: 14, bank: 'q2' }]);
    t.pass([item(history)]);
    t.tracked['item-1'].seen.q1 = { a: 12.5, d: TODAY, p: 1, n: 'Chipotle' };    // counted here as pending; another device moved the purchase on
    t.pass([item([...history, tx('q2', 14, TODAY, 'Chipotle', { pending_id: 'q1' })])]);
    ok(t.purchases.length === 1 && t.purchases[0].amount === 14 && t.balance === 0 && t.last.logged === 0,
      'a posted charge another device already moved the purchase to (with its tip): the tip is not added again');

    const z = budgetWorld();
    z.pass([item(history)]);
    z.pass([item([...history, tx('z1', 6, '2026-09-30', 'Late-night tacos', { pending: true })])]);
    ok(z.purchases.some(p => p.bank === 'z1') && z.balance === 0, 'a bank a time zone ahead dates it tomorrow: still today\'s purchase');
  }

  console.log('\n── 7. What Budget says it follows ──');
  {
    const tracked = { 'item-1': { since: TODAY, seen: {} }, 'item-2': { since: TODAY, seen: {} } };
    const banks = B.bankBudgetFollowing(tracked, [
      item(history, { institution: { name: 'Chase' }, accounts: [{ id: 'chk', type: 'depository', subtype: 'checking', name: 'Total Checking', mask: '1234' }, ACCOUNTS[2]] }),
      item([], { id: 'item-2', institution: { name: 'Discover' }, accounts: [ACCOUNTS[2]] }),
      item([], { id: 'item-3', institution: { name: 'UFCU' }, status: 'NOT_READY' }),
      item([], { id: 'item-4', institution: { name: 'Wells Fargo' }, error: { code: 'ITEM_LOGIN_REQUIRED', message: 'log in' } }),
    ]);
    eq(banks.map(b => b.state).join(), 'following,none,waiting,error', 'following a checking account, a bank with none, one Plaid is still gathering, one needing a login');
    ok(banks[0].accounts.length === 1 && banks[0].accounts[0].name === 'Total Checking' && banks[0].accounts[0].mask === '1234' && banks[0].since === TODAY,
      'naming the checking account and since when');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
