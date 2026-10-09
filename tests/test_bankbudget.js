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
  function budgetWorld(purchases = [], typed = []) {
    const w = { tracked: {}, cards: {}, purchases, typed, balance: 0, log: [], nextId: 100 };
    w.pass = (items, today = TODAY) => {
      const r = B.bankBudgetStep({ tracked: w.tracked, cards: w.cards, items, purchases: w.purchases, typed: w.typed, today, nextId: w.nextId });
      Object.assign(w, { tracked: r.tracked, cards: r.cards, purchases: r.purchases, typed: r.typed, nextId: r.nextId,
        balance: Math.round((w.balance + r.balance) * 100) / 100, log: [...w.log, ...r.log], last: r });
      return r;
    };
    return w;
  }
  /* the card with a balance (Plaid's current: what's owed, as the card shows it) */
  const card = (owed, more = {}) => ({ id: 'cc', type: 'credit', subtype: 'credit card', name: 'Freedom', mask: '5678', current: owed, available: null, limit: 2000, ...more });
  const withCard = (transactions, owed, more = {}) => item(transactions, { accounts: [ACCOUNTS[0], ACCOUNTS[1], card(owed)], ...more });
  const history = [
    tx('h1', 4.33, '2026-09-28', 'Starbucks', { pending: true }),
    tx('h2', 6.33, '2026-09-27', 'Uber'),
    tx('h3', -232.5, '2026-09-25', 'Campus Café payroll'),
    tx('s1', -4.22, '2026-09-20', 'Interest', { account: 'sav' }),
    tx('c1', 89.4, '2026-09-26', 'SparkFun', { account: 'cc' }),
  ];

  console.log('\n── 1. Which accounts, and the sync point ──');
  {
    ok(B.bankSpendingAccount(ACCOUNTS[0]) && !B.bankSpendingAccount(ACCOUNTS[1]) && B.bankSpendingAccount(ACCOUNTS[2]),
      'Budget follows checking and credit cards, not savings');
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
    eq(Object.keys(w.tracked['item-1'].seen).sort().join(), 'h1,h2,h3', 'what the checking account shows now counts as already in the balance (a card goes by its balance)');
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
      tx('n6', 3.1, '2026-09-10', 'Late history'),
    ];
    const r = w.pass([item(more)]);
    eq(r.logged, 3, 'three new checking transactions are logged');
    const chip = w.purchases.find(p => p.bank === 'n1');
    ok(chip && chip.title === 'Chipotle' && chip.amount === 12.5 && chip.pending === true && !chip.on,
      'money out today → a purchase today, marked as from the bank, and pending');
    const target = w.purchases.find(p => p.bank === 'n2');
    ok(target && target.title === 'Target' && target.amount === 30 && target.on === '2026-09-28' && target.id === 100,
      'money out the bank dates yesterday, seen today → a purchase today too, with its day (logged oldest first)');
    eq(w.balance, 500, 'today\'s payroll (+500) goes to the total balance');
    eq(w.log.map(l => `${l.d} ${l.n} ${l.a} ${l.t}`).join(' | '), '2026-09-29 Payroll 500 2026-09-29', 'with a line of its own, logged today');
    ok(!w.purchases.some(p => p.bank === 'n4') && w.log.length === 1, 'savings is left out');
    ok(w.tracked['item-1'].seen.n6 && !w.log.some(l => l.n === 'Late history') && !w.purchases.some(p => p.bank === 'n6'),
      'a row dated well before the sync point is late history: counted, not logged');
    const again = w.pass([item(more)]);
    ok(!again.changed && w.purchases.length === 3, 'seen again (the next refresh, another device): not logged twice');
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
    const more = z.purchases.find(p => p.bank === 't4');
    ok(more && more.amount === 3 && more.title === 'Hotel (posted higher)' && z.balance === 0,
      'posted after the day ended for more (a tip): only the difference ($3) is spent today, as a purchase');
    z.pass([item([...history, tx('t4', 23, TODAY, 'Hotel', { pending_id: 'p4' })])], TODAY);
    ok(z.purchases.filter(p => p.bank === 't4').length === 1 && more && z.purchases.find(p => p.bank === 't4').amount === 5,
      'changed again the same day: that purchase follows');
    const v = budgetWorld();
    v.pass([item(history)], '2026-09-28');
    v.pass([item([...history, { ...hold, id: 'p6', amount: 100 }])], '2026-09-28');
    v.purchases = [];
    v.pass([item([...history, tx('t6', 45, TODAY, 'Gas', { pending_id: 'p6' })])], TODAY);
    ok(v.balance === 55 && v.log.at(-1).a === 55 && v.purchases.length === 0, 'posted for less (a hold released): the difference comes back to the balance, not today\'s spending');

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
    ok(w.purchases.find(p => p.id === 2).bank === undefined && w.purchases.some(p => p.bank === 'k3' && p.on === '2026-09-28') && w.balance === 0,
      'the same amount dated another day is not matched to one typed today: a purchase of its own, with its day');

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
    ok(w.purchases.some(p => p.bank === 'x1'), 'a new transaction dated yesterday is logged');
    w.pass([item(history)]);
    ok(w.purchases.some(p => p.bank === 'x1') && w.balance === 0 && w.tracked['item-1'].seen.x1, 'a copy of the list saved before it came: it stays counted');
    w.pass([item([...history, tx('x1', 30, '2026-09-28', 'Target')])]);
    ok(w.purchases.filter(p => p.bank === 'x1').length === 1 && w.last.logged === 0, 'and is not counted again when the newer copy comes back');

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

  console.log('\n── 6a. The day Budget sees a charge is the day it is spent ──');
  {
    /* the bank hands Plaid a day's charges late, or the app wasn't opened */
    const w = budgetWorld();
    w.pass([item(history)], '2026-09-27');
    w.purchases = [];
    const late = [tx('l1', 47.62, '2026-09-28', 'Kiin Di', { pending: true }), tx('l2', 7.61, '2026-09-28', 'Snack Milktea', { pending: true })];
    w.pass([item([...history, ...late])], TODAY);
    eq(w.purchases.map(p => `${p.title} ${p.amount} ${p.on || 'today'}${p.pending ? ' pending' : ''}`).join(' | '),
      'Kiin Di 47.62 2026-09-28 pending | Snack Milktea 7.61 2026-09-28 pending', 'yesterday\'s charges, first seen today, are today\'s purchases, with their day');
    ok(w.balance === 0 && w.log.length === 0, 'not lines under From your bank');
    w.pass([item([...history, tx('l1-posted', 55.62, '2026-09-28', 'KIIN DI', { pending_id: 'l1' }), late[1]])], TODAY);
    ok(w.purchases.length === 2 && w.purchases[0].bank === 'l1-posted' && w.purchases[0].amount === 55.62 && !w.purchases[0].pending,
      'posting the same day with a tip: the same purchase, with the tip');

    /* typed by hand on its day, the bank's copy a day later */
    const y = budgetWorld();
    y.pass([item(history)], '2026-09-27');
    y.purchases = [];
    const r = y.pass([item([...history, tx('m1', 12.5, '2026-09-28', 'CHIPOTLE', { pending: true })])], TODAY);
    ok(y.purchases.length === 1, '(nothing typed: counted today)');
    const t = budgetWorld();
    t.pass([item(history)], '2026-09-27');
    t.purchases = [];
    const typed = [{ d: '2026-09-28', a: 12.5 }, { d: '2026-09-28', a: 3 }];
    let s = B.bankBudgetStep({ tracked: t.tracked, items: [item([...history, tx('m1', 12.5, '2026-09-28', 'CHIPOTLE', { pending: true })])], purchases: [], typed, today: TODAY, nextId: 1 });
    ok(s.purchases.length === 0 && s.changed && s.logged === 0, 'typed yesterday for the same amount: counted then, not again today');
    eq(JSON.stringify(s.typed), '[{"d":"2026-09-28","a":3}]', 'and that one is used up');
    ok(s.tracked['item-1'].seen.m1, 'the charge is counted (seen) all the same');
    const s2 = B.bankBudgetStep({ tracked: s.tracked, items: [item([...history, tx('m1-posted', 14, '2026-09-28', 'CHIPOTLE', { pending_id: 'm1' })])], purchases: [], typed: s.typed, today: TODAY, nextId: 1 });
    ok(s2.purchases.length === 1 && s2.purchases[0].amount === 1.5 && /posted higher/.test(s2.purchases[0].title), 'it posts with a tip: the tip is spent today');
    s = B.bankBudgetStep({ tracked: t.tracked, items: [item([...history, tx('m2', 12.5, '2026-09-26', 'OLD', { pending: true })])], purchases: [], typed, today: TODAY, nextId: 1 });
    ok(s.purchases.length === 1 && s.typed.length === 2, 'typed two days after the bank\'s date: not the same purchase');
    s = B.bankBudgetStep({ tracked: t.tracked, items: [item([...history, tx('m4', 12.5, '2026-09-27', 'LATE NIGHT', { pending: true })])], purchases: [], typed, today: TODAY, nextId: 1 });
    ok(s.purchases.length === 0 && s.typed.length === 1, 'typed the day after it (a bank a time zone behind): the same purchase');
    s = B.bankBudgetStep({ tracked: t.tracked, items: [item([...history, tx('m3', 12.5, TODAY, 'TODAY', { pending: true })])], purchases: [], typed, today: TODAY, nextId: 1 });
    ok(s.purchases.length === 1 && s.typed.length === 2, 'a charge dated today is not matched to one typed on an earlier day');
  }

  console.log('\n── 6b. Credit cards: what is spent is how much the balance went up ──');
  {
    const w = budgetWorld();
    w.pass([withCard(history, 410)]);
    ok(w.cards['item-1/cc'] && w.cards['item-1/cc'].b === 410 && w.cards['item-1/cc'].s === 410 && w.purchases.length === 0 && w.log.length === 0,
      'the first time: what the card owes is already in the balance, and kept as the balance last seen');
    ok(!w.tracked['item-1'].seen.c1, 'its transactions are never counted one by one');
    const chip = tx('cc2', 18.25, TODAY, 'Chipotle', { account: 'cc', pending: true, category: 'FOOD_AND_DRINK' });
    let r = w.pass([withCard([...history, chip], 428.25)]);
    const line = w.purchases.find(p => p.title === 'Chipotle');
    ok(line && line.amount === 18.25 && line.pending && line.bank === 'c:item-1/cc#1' && B.bankCardLine(line) && !line.on,
      'the balance went up $18.25: spent today, named after the card\'s new charge');
    ok(w.cards['item-1/cc'].b === 428.25 && w.cards['item-1/cc'].s === 410 && r.logged === 1, 'the new balance is kept, and the one today began with');
    r = w.pass([withCard([...history, chip], 428.25)]);
    ok(!r.changed, 'the same balance again (the next refresh, another device): nothing more');

    const pay = [tx('cp1', 300, TODAY, 'CHASE CREDIT CRD AUTOPAY', { category: 'LOAN_PAYMENTS' }), tx('cp2', -300, TODAY, 'Payment Thank You', { account: 'cc', category: 'LOAN_PAYMENTS' })];
    const bus = tx('cc3', 2.5, TODAY, 'Capital Metro', { account: 'cc', pending: true });
    w.pass([withCard([...history, chip, ...pay, bus], 130.75)]);
    ok(w.purchases.some(p => p.title === 'Capital Metro' && p.amount === 2.5) && w.purchases.length === 2,
      'paid $300 and bought $2.50 between two checks: the balance fell $297.50, and $2.50 is spent');
    ok(!w.purchases.some(p => p.bank === 'cp1') && w.log.length === 0 && w.balance === 0, 'paying the card isn\'t spending on either side, nor money in');

    const refund = tx('cc4', -18.25, TODAY, 'Chipotle', { account: 'cc', category: 'FOOD_AND_DRINK' });
    w.pass([withCard([...history, chip, ...pay, bus, refund], 112.5)]);
    ok(!w.purchases.some(p => p.title === 'Chipotle') && w.purchases.some(p => p.title === 'Capital Metro') && w.log.length === 0,
      'a refund comes off what the card spent today: the purchase of just that amount goes');
    const ret = tx('cc5', -40, TODAY, 'Target return', { account: 'cc', category: 'GENERAL_MERCHANDISE' });
    w.pass([withCard([...history, chip, ...pay, bus, refund, ret], 72.5)]);
    ok(w.purchases.some(p => p.title === 'Capital Metro') && w.log.length === 1 && w.log[0].a === 40 && w.log[0].n === 'Target return' && w.balance === 40,
      'a refund for something else is money in, and today\'s purchases stay');
    w.pass([withCard([...history, chip, ...pay, bus, refund, ret], 71.5)]);
    ok(w.purchases.find(p => p.title === 'Capital Metro').amount === 1.5 && w.log.length === 1, 'down $1 with no transaction behind it (part of a hold let go): off what the card spent today');
    w.pass([withCard([...history, chip, ...pay, bus, refund, ret], 69)]);
    ok(!w.purchases.some(p => B.bankCardLine(p)) && w.log.length === 2 && w.log[1].a === 1 && w.log[1].n === 'Freedom ••5678 credit' && w.balance === 41,
      'down more than the card spent today: the rest is money in');

    const late = budgetWorld();
    late.pass([withCard(history, 410)]);
    late.pass([withCard([...history, tx('lt1', 47.62, '2026-09-28', 'Kiin Di', { account: 'cc', pending: true })], 457.62)]);
    ok(late.purchases.length === 1 && late.purchases[0].title === 'Kiin Di' && late.purchases[0].amount === 47.62 && late.purchases[0].on === '2026-09-28',
      'a charge the card dates yesterday comes off the day its balance shows it, with its date');
    late.pass([withCard([...history, tx('lt1', 47.62, '2026-09-28', 'Kiin Di', { account: 'cc', pending: true })], 457.62)], '2026-09-30');
    ok(late.cards['item-1/cc'].s === 457.62 && late.cards['item-1/cc'].d === '2026-09-30', 'a new day starts from the balance last seen');

    const tip = budgetWorld();
    tip.pass([withCard([...history, tx('tp1', 85.5, '2026-09-27', 'Soupleaf Hot Pot', { account: 'cc', pending: true })], 495.5)]);
    tip.pass([withCard([...history, tx('tp2', 100.89, '2026-09-28', 'Soupleaf Hot Pot', { account: 'cc', pending_id: 'tp1' })], 510.89)]);
    ok(tip.purchases.length === 1 && tip.purchases[0].amount === 15.39 && tip.purchases[0].title === 'Soupleaf Hot Pot',
      'a pending charge that posts higher: the tip is spent, named after the charge');
    const drop = budgetWorld();
    drop.pass([withCard(history, 410)]);
    drop.pass([withCard([...history, tx('dh1', 60, TODAY, 'Shell', { account: 'cc', pending: true })], 470)]);
    drop.pass([withCard(history, 410)]);
    ok(drop.purchases.length === 0 && drop.log.length === 0, 'a hold the card drops the same day: its purchase goes');

    const typedT = budgetWorld([{ id: 1, title: 'Lunch', amount: 12 }]);
    typedT.pass([withCard(history, 410)]);
    typedT.pass([withCard([...history, tx('tl1', 12, TODAY, 'Chipotle', { account: 'cc', pending: true })], 422)]);
    ok(typedT.purchases.length === 1 && typedT.purchases[0].title === 'Lunch' && B.bankCardLine(typedT.purchases[0]) && typedT.purchases[0].pending,
      'typed by hand today: the card\'s charge is matched to it, not counted twice');
    const posted = budgetWorld([{ id: 1, title: 'Gas', amount: 30 }]);
    posted.pass([withCard([...history, tx('pg1', 30, TODAY, 'Shell', { account: 'cc', pending: true })], 410)]);
    posted.pass([withCard([...history, tx('pg2', 30, TODAY, 'Shell', { account: 'cc', pending_id: 'pg1' })], 440)]);
    ok(posted.purchases.length === 1 && posted.purchases[0].title === 'Gas' && B.bankCardLine(posted.purchases[0]),
      'a card whose balance counts posted charges only: when it rises by what was typed, that is the one');
    const carried = budgetWorld([], [{ d: '2026-09-28', a: 9.5 }]);
    carried.cards = { 'item-1/cc': { b: 410, s: 410, d: '2026-09-28', n: 0, ids: [] } };
    carried.pass([withCard([tx('y1', 9.5, '2026-09-28', 'Coffee', { account: 'cc' })], 419.5)]);
    ok(carried.purchases.length === 0 && carried.typed.length === 0, 'typed yesterday, on the card today: counted then');

    const n = budgetWorld();
    n.pass([withCard(history, 410)]);
    n.pass([withCard([...history, tx('np1', 120, TODAY, 'DISCOVER E-PAYMENT 8124'), tx('np2', -120, TODAY, 'INTERNET PAYMENT - THANK YOU', { account: 'cc' })], 290)]);
    ok(n.purchases.length === 0 && n.log.length === 0, 'without a category, the names say it is paying a card');
    n.pass([withCard([...history, tx('np3', 40, TODAY, 'Rent payment portal')], 290)]);
    ok(n.purchases.some(p => p.bank === 'np3'), 'a payment from checking that doesn\'t name a card is spending');

    const chkOnly = ts => ({ ...item(ts), accounts: [ACCOUNTS[0], ACCOUNTS[1]] });
    const o = budgetWorld();
    o.pass([chkOnly(history)]);
    o.pass([chkOnly([...history, tx('op1', 250, TODAY, 'CITI CARD PAYMENT', { category: 'LOAN_PAYMENTS' })])]);
    ok(o.purchases.some(p => p.bank === 'op1'), 'with no card followed, paying one from checking is the only sign of what was spent on it: spending');

    const chk = ts => ({ ...item(ts), accounts: [ACCOUNTS[0]] });
    const other = (ts, owed) => ({ ...item(ts), id: 'item-2', accounts: [card(owed)] });
    const two = budgetWorld();
    two.pass([chk(history), other([], 75)]);
    two.pass([chk([...history, tx('tp1', 75, TODAY, 'AMEX EPAYMENT', { category: 'LOAN_PAYMENTS' })]),
      other([tx('tc0', -75, TODAY, 'PAYMENT RECEIVED', { account: 'cc', category: 'LOAN_PAYMENTS' }), tx('tc1', 9.5, TODAY, 'Bus', { account: 'cc' })], 9.5)]);
    ok(two.purchases.length === 1 && two.purchases[0].title === 'Bus' && two.purchases[0].bank === 'c:item-2/cc#1',
      'a card at another bank: what it spends counts, and paying it from this one\'s checking does not');

    const alone = budgetWorld();
    alone.pass([other([], 100)]);
    alone.pass([other([tx('ar1', -25, TODAY, 'Return', { account: 'cc', category: 'GENERAL_MERCHANDISE' })], 75)]);
    ok(alone.balance === 25 && alone.log[0].n === 'Return', 'a card alone: a refund is money in, for Budget\'s own total');
    alone.pass([other([tx('ar1', -25, TODAY, 'Return', { account: 'cc', category: 'GENERAL_MERCHANDISE' })], null, { current: null, available: null })]);
    ok(alone.cards['item-2/cc'].b === 75, 'a card that gives no balance this time keeps the one last seen');
    const again = budgetWorld([{ id: 5, title: 'Bus', amount: 9.5, bank: 'c:item-2/cc#1' }, { id: 6, title: 'Lunch', amount: 12, bank: 'c:item-2/cc=2' }]);
    again.pass([other([], 100)]);
    again.pass([other([tx('ag1', 4, TODAY, 'Coffee', { account: 'cc' })], 104)]);
    ok(again.purchases.length === 3 && again.purchases[2].bank === 'c:item-2/cc#3', 'followed again the same day: its new purchases are numbered on from today\'s, never one already used');
    const view = B.bankCardsTracked(alone.cards, [other([], 75)], TODAY);
    ok(view.length === 1 && view[0].name === 'Freedom' && view[0].owed === 75 && view[0].start === 100, 'what Budget shows for it: owed now, and when today began');
  }

  console.log('\n── 6c. From counting card transactions to the card\'s balance ──');
  {
    /* what the version before left: the card's transactions counted one by one, one no longer listed */
    const legacy = { 'item-1': { since: '2026-09-20', acc: ['cc', 'chk'], seen: {
      h1: { a: 4.33, d: '2026-09-28', p: 1 }, h2: { a: 6.33, d: '2026-09-27' }, h3: { a: -232.5, d: '2026-09-25' },
      c1: { a: 89.4, d: '2026-09-26' }, oc1: { a: 85.5, d: '2026-09-27', p: 1 }, gone: { a: 9.99, d: '2026-09-27', p: 1 } } } };
    const cardTx = [tx('oc1', 85.5, '2026-09-27', 'Soupleaf Hot Pot', { account: 'cc', pending: true })];
    const s = B.bankBudgetStep({ tracked: legacy, items: [withCard([...history, ...cardTx], 495.5)], purchases: [{ id: 7, title: 'Soupleaf Hot Pot', amount: 85.5, bank: 'oc1', pending: true }], today: TODAY, nextId: 8 });
    ok(s.purchases.length === 1 && s.balance === 0 && s.log.length === 0, 'nothing more comes off, and nothing is given back');
    ok(!s.tracked['item-1'].seen.c1 && !s.tracked['item-1'].seen.oc1 && !s.tracked['item-1'].seen.gone && s.tracked['item-1'].seen.h1,
      'the card\'s counted transactions go (the one no longer listed too); checking\'s stay');
    ok(s.tracked['item-1'].v === 2 && s.tracked['item-1'].acc.join() === 'chk' && s.cards['item-1/cc'].b === 495.5,
      'the sync point counts checking only, and the card is followed by its balance from here');
    ok(!Object.entries(s.tracked['item-1'].seen).some(([id, e]) => e.p && !history.some(t => t.id === id && t.account === 'chk')),
      'so a copy of Focus that follows checking only finds no pending card charge it could take for dropped and give back');
    const back = B.bankBudgetStep({ tracked: { 'item-1': { ...s.tracked['item-1'] } }, cards: s.cards, items: [withCard(history.filter(t => t.id !== 'h1'), 495.5)], purchases: [], today: TODAY, nextId: 8 });
    ok(back.log.length === 1 && back.log[0].a === 4.33, 'after that, a pending checking charge the bank drops is given back again');
    const older = B.bankBudgetStep({ tracked: { 'item-1': { since: s.tracked['item-1'].since, seen: s.tracked['item-1'].seen } }, cards: s.cards, items: [withCard(history.filter(t => t.id !== 'h1'), 495.5)], purchases: [], today: TODAY, nextId: 8 });
    ok(older.log.length === 0 && older.tracked['item-1'].v === 2, 'but not the first time after an older copy wrote the sync point (it may have been a card\'s)');
  }

  console.log('\n── 7. What Budget says it follows ──');
  {
    const tracked = { 'item-1': { since: TODAY, seen: {} }, 'item-2': { since: TODAY, seen: {} }, 'item-5': { since: TODAY, seen: {} } };
    const banks = B.bankBudgetFollowing(tracked, [
      item(history, { institution: { name: 'Chase' }, accounts: [{ id: 'chk', type: 'depository', subtype: 'checking', name: 'Total Checking', mask: '1234' }, ACCOUNTS[1], ACCOUNTS[2]] }),
      item([], { id: 'item-2', institution: { name: 'Ally' }, accounts: [ACCOUNTS[1]] }),
      item([], { id: 'item-3', institution: { name: 'UFCU' }, status: 'NOT_READY' }),
      item([], { id: 'item-4', institution: { name: 'Wells Fargo' }, error: { code: 'ITEM_LOGIN_REQUIRED', message: 'log in' } }),
      item([], { id: 'item-5', institution: { name: 'Discover' }, accounts: [{ ...ACCOUNTS[2], name: 'Discover it', mask: '7788' }] }),
    ]);
    eq(banks.map(b => b.state).join(), 'following,none,waiting,error,following', 'following checking and a card, a bank with savings only, one Plaid is still gathering, one needing a login, a card alone');
    ok(banks[0].accounts.length === 2 && banks[0].accounts[0].name === 'Total Checking' && banks[0].accounts[0].mask === '1234' && banks[0].accounts[1].name === 'Credit card' && banks[0].since === TODAY,
      'naming the checking account and the card (savings left out), and since when');
    ok(banks[4].accounts.length === 1 && banks[4].accounts[0].name === 'Discover it' && banks[4].accounts[0].mask === '7788', 'a card alone is followed too');
  }

  console.log('\n── 8. The balance Budget\'s total is ──');
  {
    const acct = (id, subtype, available, current, type = 'depository') => ({ id, type, subtype, available, current });
    const bank = (id, accounts) => ({ id, accounts, transactions: [], updatedAt: 1 });
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', 120.5, 130), acct('sav', 'savings', 900, 900), acct('cc', 'credit card', null, 410, 'credit')])]), -289.5,
      'the checking account\'s available balance, less what\'s owed on the card (its current balance, with no available credit given); savings left out');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', 1000, 1000), { ...acct('cc', 'credit card', 1560, 410, 'credit'), limit: 2000 }])]), 590,
      'what\'s owed is the card\'s balance as it shows it ($410), even with a limit and the credit available given');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', 1000, 1000), { ...acct('cc', 'credit card', 1560, null, 'credit'), limit: 2000 }])]), 560,
      'with no balance shown, its limit less the credit available ($2,000 − $1,560 = $440)');
    ok(B.bankCardOwed({ type: 'credit', current: null, available: null, limit: 2000 }) === null && B.bankCardOwed({ type: 'credit', current: -12.5 }) === -12.5,
      'nothing to go by: no balance; a card paid past zero owes less than nothing');
    eq(B.bankBalance([bank('b1', [{ ...acct('cc', 'credit card', 1560, 410, 'credit'), limit: 2000 }])]), null, 'a card alone gives no balance: Budget keeps its own');
    eq(B.bankBalanceKey([bank('b1', [acct('chk', 'checking', 1, 1), acct('cc', 'credit card', null, 410, 'credit')])]), '2:b1/cc,b1/chk', 'and the card is one of the accounts the day\'s start is taken over');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', null, 130)])]), 130, 'its current balance where the bank gives no available one');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', 0, 130)])]), 0, 'an available balance of $0 is a balance');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', 20.1, 0)]), bank('b2', [acct('chk', 'checking', 10.2, 0), acct('pp', 'paypal', 5, 5)])]), 35.3,
      'every followed account of every bank, added up (to the cent)');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', -42.5, -40)])]), -42.5, 'an overdrawn account counts below zero');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', null, null), acct('sav', 'savings', 900, 900)])]), null, 'no balance from a followed account: none (Budget keeps its own)');
    eq(B.bankBalance([]), null, 'no banks: none');
    eq(B.bankBalance([bank('b1', [acct('chk', 'checking', '120', 130)])]), 130, 'a balance that isn\'t a number isn\'t taken (the current one is)');
    eq(B.bankBalanceKey([bank('b2', [acct('chk', 'checking', 1, 1)]), bank('b1', [acct('x', 'checking', 1, 1), acct('sav', 'savings', 1, 1), acct('n', 'checking', null, null)])]),
      '2:b1/x,b2/chk', 'which accounts: the followed ones with a balance, in a fixed order');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
