/* Budget following the bank, in 100 cases: each a different mix of what a bank
 * and the person with it do over one to three days, run through the app itself
 * (jsdom), the bank relay's own code and a fake Plaid (tests/fake-plaid.js), with
 * one Firebase shared by the devices (tests/fake-firebase.js).
 *
 * The bank keeps its own books in each case: posted and pending charges, money
 * in, holds, tips, transfers, a credit card and its payment, accounts with and
 * without an available balance, one bank or two. After every step the app is
 * held to them:
 *   • the total balance is the bank's balance over the accounts Budget follows
 *     (checking: available, or current where there is none; less what is owed
 *     on the credit cards, as each card shows it), as last fetched, less what
 *     was typed today that the bank hasn't shown;
 *   • today's purchases are the money out Budget first saw at the bank today on
 *     checking, whatever day the bank dates it, since Budget started following
 *     it (one purchase however it posts, with its final amount, or only the tip
 *     when it posts after its day; a pending one the bank drops goes; one typed
 *     for the same amount is matched, not counted twice, also when the bank
 *     shows it a day late; one taken out with × stays out), what each card's
 *     balance went up by between two looks at it (its payments added back; a
 *     card whose balance counts pending charges, or one that counts posted
 *     ones only), and what was typed;
 *   • a new day starts from the bank's balance as last fetched, and within a
 *     day the start stays put, unless the banks followed change;
 *   • turned off, the total stays where it was and the bank no longer moves it;
 *   • what Budget shows says the same (today's balance and the total at the
 *     top, the line under them, Home's), and every device shows the same.
 * Not part of npm test (100 cases take a few minutes).
 * Run: npm run bank:cases -- [cases=100] [first seed=1] [processes=6]
 * One case, with what happened in it: BANK_SEED=17 npm run bank:cases */
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { loadApp, ROOT } = require('./load-app');
const { createFakePlaid } = require('./fake-plaid');
const { createFakeFirebaseKeys } = require('./fake-firebase-keys');
const { createFakeFirebase } = require('./fake-firebase');

const RELAY = 'http://localhost:8787/api/bank';
const PROJECT = 'worky-test';
const UID = 'user-c';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(15); }
  return fn();
}
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => (round2(n) < 0 ? '-$' : '$') + Math.abs(round2(n)).toFixed(2);
const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* The app as shipped, but: the relay at RELAY, the day set by the case
 * (window.__today), and a push 150 ms after a change instead of 1.2 s, with the
 * wait for another device's Budget changes still well past it (see world). */
const HOOKS = {
  'js/dbd.js': ['export function dbdTodayKey() { return calDateKey(calToday()); }',
    'export function dbdTodayKey() { return window.__today || calDateKey(calToday()); }'],
  'js/sync.js': ['syncPushTimer = setTimeout(syncPushNow, 1200);', 'syncPushTimer = setTimeout(syncPushNow, 150);'],
};
function transform(src, file) {
  if (file === 'js/config.js') return src.replace(/(export const BANK_RELAY_URL\s*=\s*)'[^']*'/, `$1'${RELAY}'`);
  const hook = HOOKS[file];
  if (!hook) return src;
  if (!src.includes(hook[0])) throw new Error(`${file} no longer has: ${hook[0]}`);
  return src.replace(hook[0], hook[1]);
}

/* ── the world: relay, fake Plaid, one Firebase, devices ── */
async function makeWorld(dayRef) {
  const { handle } = await import(pathToFileURL(path.join(ROOT, 'backend/bank/relay.mjs')).href);
  const keys = await createFakeFirebaseKeys({ projectId: PROJECT });
  const ENV = { PLAID_CLIENT_ID: 'test-client', PLAID_SECRET: 'test-secret', PLAID_ENV: 'sandbox',
    RELAY_KEY: Buffer.alloc(32, 7).toString('base64'), FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGINS: 'http://localhost:8080', FIREBASE_JWKS_URL: keys.url };
  const plaid = createFakePlaid();
  const upstream = (u, o) => (keys.handles(u) ? keys.fetchImpl(u, o) : plaid.fetchImpl(u, o));
  const relayFetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(RELAY + '/')) throw new TypeError('Failed to fetch');
    return handle(new Request(u, { method: opts.method || 'GET', headers: new Headers(opts.headers || {}), body: opts.body }), ENV, upstream);
  };
  const { cloud, install } = createFakeFirebase({ uid: UID, email: 'c@example.com' });
  let links = 0;
  const Link = { create(cfg) { return { open() { setTimeout(() => { links++; cfg.onSuccess(`public-sandbox-link${links}`, { institution: { name: `Bank ${links}`, institution_id: `ins_${links}` } }); }, 0); } }; } };
  const devices = [];
  async function boot(name, storage = {}) {
    let dev = null;
    const app = await loadApp({ transform, storage: { 'focus-tour-done': '1', ...storage },
      before: w => { w.__today = dayRef.today; w.fetch = relayFetch; w.Plaid = Link; dev = install(w); } });
    app.d.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    app.name = name;
    app.w.eval('BANK_BUDGET_WAIT_MS = 1000');
    app.signIn = () => dev.signIn({ uid: UID, email: 'c@example.com', getIdToken: async () => keys.signIdToken({ sub: UID }) });
    devices.push(app);
    return app;
  }
  const cloudState = () => { const s = cloud.at(`users/${UID}/state`); return s ? JSON.parse(s) : null; };
  return { plaid, cloud, boot, devices, cloudState };
}

/* ── one case ── */
async function runCase(seed) {
  const stream = start => { let x = start % 2147483647 || 1; return () => (x = (x * 16807) % 2147483647) / 2147483647; };
  const rand = stream(seed * 48271 + 11);
  const pick = a => a[Math.floor(rand() * a.length)];
  const chance = p => rand() < p;
  const cents = (lo, hi) => round2(lo + rand() * (hi - lo));

  const log = [];
  const note = m => log.push(m);
  const dayRef = { today: null };
  const W = await makeWorld(dayRef);
  const L = await W.boot('laptop');
  dayRef.today = L.w.eval('calDateKey(calToday())');
  L.w.__today = dayRef.today;
  const today = () => dayRef.today;

  /* what the case is made of */
  const two = chance(0.3);
  const withPhone = chance(0.45);
  const days = 1 + Math.floor(rand() * 3);
  const daily = chance(0.4) ? 0 : cents(15, 60);
  const followOffOn = chance(0.15);
  const disconnectOne = two && chance(0.25);
  const bankSpecs = [0, 1].slice(0, two ? 2 : 1).map(i => ({
    i, prefix: `b${i + 1}`,
    savings: chance(0.6), credit: chance(0.5), paypal: i === 0 && chance(0.15), noAvail: chance(0.15),
    connectLater: i === 1 && chance(0.5),
  }));
  const features = [];
  features.push(two ? '2 banks' : '1 bank');
  if (withPhone) features.push('phone');
  features.push(`${days} day${days > 1 ? 's' : ''}`);

  /* ── the bank's own books ── */
  let txn = 0;
  const banks = bankSpecs.map(spec => {
    const accts = [{ id: `${spec.prefix}-chk`, name: 'Checking', type: 'depository', subtype: 'checking', current: cents(80, 1500), pending: new Map(), noAvail: spec.noAvail }];
    if (spec.paypal) accts.push({ id: `${spec.prefix}-pp`, name: 'PayPal', type: 'depository', subtype: 'paypal', current: cents(0, 200), pending: new Map(), noAvail: false });
    if (spec.savings) accts.push({ id: `${spec.prefix}-sav`, name: 'Savings', type: 'depository', subtype: 'savings', current: cents(100, 3000), pending: new Map(), noAvail: false });
    if (spec.credit) accts.push({ id: `${spec.prefix}-cc`, name: 'Card', type: 'credit', subtype: 'credit card', current: cents(0, 600), pending: new Map(), noAvail: false, limit: 2000,
      pendingIn: chance(0.5) });                                            // its balance counts pending charges (some cards' do, some only count posted ones)
    return { spec, accts, txs: new Map(), lin: [], token: null, itemId: null, connected: false, fetched: null, since: null, card: null, cardRows: [] };
  });
  const followedAcct = a => (a.type === 'depository' && ['checking', 'paypal'].includes(a.subtype)) || a.type === 'credit';
  const pendingOf = a => [...a.pending.values()].reduce((s, x) => s + x, 0);
  const balanceOf = a => (a.type === 'credit'
    ? { available: round2(a.limit - a.current - pendingOf(a)), current: round2(a.current + (a.pendingIn ? pendingOf(a) : 0)) }
    : { available: a.noAvail ? null : round2(a.current - [...a.pending.values()].reduce((s, x) => s + x, 0)), current: a.current });
  const plaidAccounts = b => b.accts.map(a => ({ account_id: a.id, name: a.name, official_name: null, mask: a.id.slice(-4),
    type: a.type, subtype: a.subtype, balances: { ...balanceOf(a), limit: a.limit ?? null, iso_currency_code: 'USD' } }));
  const newTx = (b, a, amount, name, { pending = false, date = today(), of = null, category = null } = {}) => ({
    transaction_id: `${b.spec.prefix}-t${++txn}`, account_id: a.id, date, authorized_date: date, name, merchant_name: name,
    amount: round2(amount), iso_currency_code: 'USD', pending, pending_transaction_id: of,
    personal_finance_category: { primary: category || (amount < 0 ? 'INCOME' : 'GENERAL_MERCHANDISE') } });
  const publish = (b, { added = [], removed = [] }) => {
    removed.forEach(id => b.txs.delete(id));
    added.forEach(t => b.txs.set(t.transaction_id, t));
    if (b.token) {
      W.plaid.changeTransactions(b.token, { added, removed });
      W.plaid.setBalances(b.token, Object.fromEntries(b.accts.map(a => [a.id, balanceOf(a)])));
    }
  };
  /* a lineage: one charge or deposit, however many ids it has at the bank (pending, then posted) */
  const lineage = (b, a, t) => { const l = { b, a, cur: t.transaction_id, name: t.name }; b.lin.push(l); return l; };
  const curTx = l => l.b.txs.get(l.cur) || null;
  const bank = {
    pending(b, amount, name, date = today()) {
      const a = pick(b.accts.filter(followedAcct));
      const t = newTx(b, a, amount, name, { pending: true, date });
      a.pending.set(t.transaction_id, t.amount);
      publish(b, { added: [t] });
      return lineage(b, a, t);
    },
    post(l, tip = 0) {
      const p = curTx(l);
      const t = newTx(l.b, l.a, p.amount + tip, p.name.toUpperCase(), { of: p.transaction_id });
      l.a.pending.delete(p.transaction_id);
      l.a.current = round2(l.a.type === 'credit' ? l.a.current + t.amount : l.a.current - t.amount);
      l.cur = t.transaction_id;
      publish(l.b, { removed: [p.transaction_id], added: [t] });
    },
    drop(l) {
      const p = curTx(l);
      l.a.pending.delete(p.transaction_id);
      l.dropped = true;
      publish(l.b, { removed: [p.transaction_id] });
    },
    debit(b, a, amount, name, date, category = null) {
      const t = newTx(b, a, amount, name, { date, category });
      a.current = round2(a.type === 'credit' ? a.current + amount : a.current - amount);
      publish(b, { added: [t] });
      return lineage(b, a, t);
    },
    credit(b, a, amount, name, category = null) {
      const t = newTx(b, a, -amount, name, { category });
      a.current = round2(a.type === 'credit' ? a.current - amount : a.current + amount);
      publish(b, { added: [t] });
      return lineage(b, a, t);
    },
  };
  /* what each bank had before it was connected: Budget takes all of it as spent already */
  for (const b of banks) {
    const n = Math.floor(rand() * 5);
    for (let k = 0; k < n; k++) {
      const a = pick(b.accts);
      const date = addDays(today(), -1 - Math.floor(rand() * 9));
      const t = newTx(b, a, chance(0.25) ? -cents(50, 400) : cents(2, 90), pick(['Grocer', 'Diner', 'Bookshop', 'Payroll', 'Pharmacy']), { date, pending: chance(0.2) && a.type !== 'credit' });
      if (t.pending) a.pending.set(t.transaction_id, t.amount);
      b.txs.set(t.transaction_id, t);
      lineage(b, a, t).history = true;
    }
  }

  /* ── what Budget should show: the rules, from the bank's books ── */
  const M = {
    following: true,
    typed: [],              // { title, amount, day, lin: lineage|null, removed }
    initial: null,          // the start of the day it should show (null: not pinned down this step)
    offInitial: null,       // turned off: Budget's own initial balance
    anchorFromLog: false,   // the start was just taken again: check it against the app's own log of money in today
  };
  const expectedBalance = () => {
    let sum = 0, any = false;
    for (const b of banks.filter(x => x.connected && x.fetched)) {
      for (const a of b.fetched.accounts) {
        if (!followedAcct(a)) continue;
        if (a.type === 'credit') {                                          // what's owed, as the card shows it
          const owed = owedOf(a);
          if (owed !== null) sum -= owed;
          continue;
        }
        const v = Number.isFinite(a.balances.available) ? a.balances.available : Number.isFinite(a.balances.current) ? a.balances.current : null;
        if (v !== null) { sum += v; any = true; }
      }
    }
    return any ? round2(sum) : null;
  };
  const owedOf = a => (Number.isFinite(a.balances.current) ? round2(a.balances.current)
    : Number.isFinite(a.balances.limit) && Number.isFinite(a.balances.available) ? round2(a.balances.limit - a.balances.available) : null);
  const typedToday = () => M.typed.filter(p => p.day === today() && !p.removed);
  /* today's purchases from the bank: a lineage's purchase (`row`, the day it was
   * first seen), or what more it came to when it posted after that day (`extra`) */
  const rowsToday = () => [
    ...banks.flatMap(b => b.lin).filter(l => !l.removed).flatMap(l => [
      ...(l.row && l.rowDay === today() ? [{ l, row: l.row, bank: l.appCur }] : []),
      ...(l.extra && l.extra.day === today() ? [{ l, row: l.extra, bank: l.extra.bank }] : []),
    ]),
    ...banks.flatMap(b => b.cardRows).filter(r => r.day === today() && !r.removed).map(r => ({ l: null, card: r, row: r, bank: r.bank })),
  ];
  const expectedPurchases = () => [
    ...typedToday().map(p => ({ title: p.title, amount: p.lin ? p.lin.row.amount : p.amount, bank: p.lin ? p.lin.appCur : null })),
    ...rowsToday().filter(x => !x.row.typed).map(x => ({ title: null, amount: x.row.amount, bank: x.bank })),
  ];
  const spentExpected = () => round2(expectedPurchases().reduce((s, p) => s + p.amount, 0));
  const totalExpected = () => {
    if (!M.following) return round2(M.offInitial - spentExpected());
    const bal = expectedBalance();
    return round2(bal - typedToday().filter(p => !p.lin).reduce((s, p) => s + p.amount, 0));
  };

  /* Budget's pass over a bank's list as just fetched (bankbudget.js, from the
   * books' side): the first time it sees a charge, money out is a purchase today
   * whatever its date (or the one typed for the same amount: today, or within a
   * day of an earlier date); after that a new amount moves that purchase (after
   * its day: more out is spent today), and a pending one dropped takes it away. */
  const pass = (b, syncPoint) => {
    if (!M.following) return;
    for (const l of b.lin) {
      const t = b.fetched.txs.get(l.cur) || null;
      if (!followedAcct(l.a) || l.payment) continue;                       // paying a card: neither spending nor money in
      if (l.a.type === 'credit') continue;                                 // a card goes by its balance (cardPass)
      if (l.seen === undefined) {
        if (!t) continue;
        l.seenAmount = t.amount;
        l.appCur = l.cur;
        if (syncPoint || t.date < addDays(b.since, -3)) { l.seen = 'history'; continue; }
        l.seen = 'new';
        if (t.amount > 0 && t.date >= today()) {
          const typed = typedToday().find(p => !p.lin && round2(p.amount) === round2(t.amount));
          if (typed) { typed.lin = l; l.row = { amount: typed.amount, typed }; } else l.row = { amount: t.amount };
          l.rowDay = today();
        } else if (t.amount > 0) {                                          // dated an earlier day: spent today, unless typed then
          const carried = M.typed.find(p => p.carried && !p.lin && !p.removed && p.day < today() && p.day >= addDays(today(), -3)
            && p.day >= addDays(t.date, -1) && p.day <= addDays(t.date, 1) && round2(p.amount) === round2(t.amount));
          if (carried) carried.lin = l;
          else { l.row = { amount: t.amount }; l.rowDay = today(); }
        }
        continue;
      }
      if (!t) {                                                             // dropped by the bank
        if (l.row && l.rowDay === today()) { if (l.row.typed) l.row.typed.removed = true; l.row = null; }
        l.seen = 'gone';
        continue;
      }
      l.appCur = l.cur;
      if (l.seen === 'gone') continue;
      const delta = round2(t.amount - l.seenAmount);
      if (delta && !l.removed) {
        if (l.row && l.rowDay === today()) l.row.amount = round2(l.row.amount + delta);
        else if (l.extra && l.extra.day === today()) l.extra.amount = round2(l.extra.amount + delta);
        else if (delta > 0) l.extra = { amount: delta, day: today(), bank: l.cur };   // more out after its day: spent today
      }
      l.seenAmount = t.amount;
    }
    cardPass(b, syncPoint);
  };
  /* A card, by its balance: what it went up by since the last look (its payments
   * added back) is a purchase today, once what was typed for its new charges is
   * taken off; down by more than its payments, the purchase of just that amount
   * today goes, or a refund is money in, or a drop with nothing behind it comes
   * off what the card spent today. */
  const typedFor = (b, key, amount, date, t) => {
    if (date >= today()) {
      const p = typedToday().find(q => !q.lin && round2(q.amount) === amount);
      if (!p) return false;
      p.lin = { row: { amount: p.amount }, appCur: `c:${key}=${++b.card.n}`, card: true };
      return true;
    }
    const p = M.typed.find(q => q.carried && !q.lin && !q.removed && q.day < today() && q.day >= addDays(today(), -3)
      && (!t || (q.day >= addDays(date, -1) && q.day <= addDays(date, 1))) && round2(q.amount) === amount);
    if (!p) return false;
    p.lin = { carried: true };
    return true;
  };
  const cardPass = (b, syncPoint) => {
    for (const a of b.fetched.accounts.filter(x => x.type === 'credit')) {
      const key = `${b.itemId}/${a.account_id}`;
      const owed = owedOf(a);
      if (owed === null) continue;
      const list = [...b.fetched.txs.values()].filter(t => t.account_id === a.account_id);
      const ids = new Set(list.map(t => t.transaction_id));
      const prev = b.card;
      if (syncPoint || !prev) {
        const mine = id => ['#', '='].some(c => id.startsWith(`c:${key}${c}`));
        const used = rowsToday().filter(x => x.bank && mine(x.bank)).map(x => Number(x.bank.slice(key.length + 3)) || 0);
        const linked = M.typed.filter(p => p.lin && p.lin.card && mine(p.lin.appCur)).map(p => Number(p.lin.appCur.slice(key.length + 3)) || 0);
        b.card = { b: owed, n: Math.max(0, ...used, ...linked), ids };
        continue;
      }
      const fresh = list.filter(t => !prev.ids.has(t.transaction_id) && !(t.pending_transaction_id && prev.ids.has(t.pending_transaction_id)))
        .sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? -1 : 1));
      const isPay = t => t.amount < 0 && ['LOAN_PAYMENTS', 'TRANSFER_IN'].includes(t.personal_finance_category.primary);
      let x = round2(owed - prev.b - fresh.filter(isPay).reduce((s, t) => s + t.amount, 0));
      b.card = { b: owed, n: prev.n, ids };
      if (!x) continue;
      if (x > 0) {
        const left = [];
        for (const t of fresh.filter(t => t.amount > 0 && !isPay(t))) {
          const amount = round2(t.amount);
          if (amount <= x && typedFor(b, key, amount, t.date, t)) x = round2(x - amount); else left.push(t);
        }
        if (x > 0 && !left.length && (typedFor(b, key, x, today(), null) || typedFor(b, key, x, '', null))) x = 0;
        if (x > 0) b.cardRows.push({ amount: x, day: today(), bank: `c:${key}#${++b.card.n}` });
        continue;
      }
      let back = -x;
      const credits = fresh.filter(t => t.amount < 0 && !isPay(t));
      const rows = b.cardRows.filter(r => r.day === today() && !r.removed);
      const same = rows.filter(r => round2(r.amount) === back).pop();
      for (const r of same ? [same] : credits.length ? [] : [...rows].reverse()) {
        if (!(back > 0)) break;
        const take = Math.min(back, r.amount);
        r.amount = round2(r.amount - take);
        back = round2(back - take);
      }
      b.cardRows = b.cardRows.filter(r => !(r.day === today() && !r.removed && !(r.amount > 0)));
    }
  };
  const fetched = b => {
    b.fetched = { accounts: plaidAccounts(b), txs: new Map([...b.txs].map(([id, t]) => [id, { ...t }])) };
    for (const l of b.lin) l.fetchedCur = b.txs.has(l.cur) ? l.cur : null;
  };

  /* ── the app side ── */
  const live = () => W.devices.filter(d => !d.closed);
  const bud = app => app.d.getElementById('budgetContainer-d');
  const purchasesOf = app => JSON.parse(app.w.eval('JSON.stringify(budget.purchases)'));
  async function settle() {
    const apps = live();
    const quiet = a => !a.w.eval('syncPushTimer') && !a.w.eval('syncPushing') && !a.w.eval('bankBudgetTimer') && !a.w.eval('bankBusy');
    const fp = a => a.w.eval('syncHash(syncFingerprint(gatherState()))');
    const cloudFp = () => { const st = W.cloudState(); return st ? apps[0].w.eval(`syncHash(syncFingerprint(${JSON.stringify(st)}))`) : null; };
    const calm = () => apps.every(quiet) && apps.every(a => fp(a) === cloudFp());
    const deadline = Date.now() + 12000;
    await sleep(30);
    while (Date.now() < deadline) {                                       // calm, and still calm a moment later (the echo of the
      if (!await until(calm, deadline - Date.now())) break;               // last save can come just after and wake the bank's wait)
      await sleep(250);
      if (calm()) return true;
    }
    note(`   (not settled: ${apps.map(a => `${a.name} ${['syncPushTimer', 'syncPushing', 'bankBudgetTimer', 'bankBusy'].filter(k => a.w.eval(k)).join('+') || 'quiet'}, ${fp(a) === cloudFp() ? 'same as the cloud' : 'not the cloud\'s'}`).join('; ')})`);
    return false;
  }
  async function refresh(app, b) {
    const err = await app.w.eval(`bankRefresh(syncUser.uid, bankItems().find(i => i.id === ${JSON.stringify(b.itemId)}))`);
    if (err) throw new Error(`refresh of ${b.spec.prefix} on the ${app.name} failed: ${err.message || err}`);
    fetched(b);
    pass(b, false);
  }
  async function connect(app, b) {
    W.plaid.state.nextItem = { accounts: plaidAccounts(b), transactions: [...b.txs.values()] };
    app.w.openSettings('bank');
    await until(() => { const btn = app.d.querySelector('#bankPanel [data-bank="connect"]'); return btn && !btn.disabled; }, 6000);
    const before = app.w.eval('bank.items.length');
    app.d.querySelector('#bankPanel [data-bank="connect"]').click();
    if (!await until(() => app.w.eval('bank.items.length') === before + 1 && app.w.eval('bank.items.every(i => i.updatedAt > 0)'), 8000)) throw new Error(`connecting ${b.spec.prefix} didn't finish`);
    b.token = [...W.plaid.state.items.keys()].pop();
    b.itemId = W.plaid.state.items.get(b.token).item_id;
    b.connected = true;
    b.since = today();
    fetched(b);
    pass(b, true);                                                        // its first list is the sync point
  }
  async function type(app, title, amount) {
    const root = bud(app);
    root.querySelector('.budget-new-title').value = title;
    root.querySelector('.budget-new-amount').value = amount.toFixed(2);
    root.querySelector('[data-pact="add"]').click();
    M.typed.push({ title, amount: round2(amount), day: today(), lin: null, removed: false });
  }
  const rowEl = (app, pred) => {
    const p = purchasesOf(app).find(pred);
    return p ? bud(app).querySelector(`.budget-purchase-row[data-purchase-id="${p.id}"]`) : null;
  };

  /* ── checks ── */
  const problems = [];
  function check(step) {
    for (const app of live()) {
      const where = `step ${step}, ${app.name}`;
      const total = app.w.eval('totalBalance()');
      const want = totalExpected();
      if (round2(total) !== want) problems.push(`${where}: total balance ${money(total)}, the bank's books say ${money(want)}`);
      const have = purchasesOf(app).map(p => ({ title: p.title, amount: round2(p.amount), bank: p.bank || null }));
      const exp = expectedPurchases();
      const key = p => `${p.bank || 'typed:' + p.title}=${money(p.amount)}`;
      const a = have.map(key).sort().join(' '), e = exp.map(key).sort().join(' ');
      if (a !== e) problems.push(`${where}: purchases today [${a}], should be [${e}]`);
      const spent = round2(have.reduce((s, p) => s + p.amount, 0));
      const tb = app.w.eval('todayBalance()');
      if (round2(tb) !== round2(daily - spent)) problems.push(`${where}: today's balance ${money(tb)}, should be ${money(daily - spent)}`);
      const initial = app.w.eval('budget.initial');
      if (M.following && M.initial !== null && round2(initial) !== M.initial) problems.push(`${where}: the day starts from ${money(initial)}, should be ${money(M.initial)}`);
      if (M.following && M.anchorFromLog) {
        const inToday = app.w.eval(`bankBudget.log.reduce((s, l) => s + (l.d === ${JSON.stringify(today())} ? l.a : 0), 0)`);
        const want0 = round2(expectedBalance() + rowsToday().reduce((s, x) => s + x.row.amount, 0) - inToday);
        if (round2(initial) !== want0) problems.push(`${where}: taken again, the day starts from ${money(initial)}, should be ${money(want0)}`);
      }
      if (!M.following && round2(initial) !== M.offInitial) problems.push(`${where}: turned off, the initial balance is ${money(initial)}, should stay ${money(M.offInitial)}`);
      const sub = bud(app).querySelector('.budget-figure-sub').textContent;
      const other = round2(total - (initial - spent));
      const wantSub = M.following && expectedBalance() !== null
        ? `${money(initial)} at the start of today − ${money(spent)} spent today` + (other ? ` ${other > 0 ? '+' : '−'} ${money(Math.abs(other))} ${other > 0 ? 'in at your bank' : 'more out at your bank'}` : '')
        : `${money(initial)} initial − ${money(spent)} spent today`;
      if (sub !== wantSub) problems.push(`${where}: under the total "${sub}", should be "${wantSub}"`);
      const figure = bud(app).querySelector('.budget-figure-total .budget-figure-value').textContent;
      if (figure !== money(total)) problems.push(`${where}: Budget shows ${figure}, its total is ${money(total)}`);
      const todayFigure = bud(app).querySelector('.budget-figure-today .budget-figure-value').textContent;
      if (todayFigure !== money(tb)) problems.push(`${where}: Budget shows ${todayFigure} for today, today's balance is ${money(tb)}`);
      const home = app.d.querySelector('.home-balance-total');
      if (home && home.textContent !== `${money(total)} total`) problems.push(`${where}: Home shows "${home.textContent}", the total is ${money(total)}`);
      const ro = bud(app).querySelector('[data-bfield="initial"]').readOnly;
      if (ro !== (M.following && expectedBalance() !== null)) problems.push(`${where}: the initial balance is ${ro ? '' : 'not '}read-only`);
    }
    if (live().length > 1) {
      const fig = live().map(a => `${a.w.eval('totalBalance()')}|${a.w.eval('budget.initial')}|${a.w.eval('JSON.stringify(budget.purchases.map(p => [p.bank, p.amount]).sort())')}`);
      if (new Set(fig).size > 1) problems.push(`step ${step}: the devices don't agree: ${live().map((a, i) => `${a.name} ${fig[i]}`).join(' / ')}`);
    }
  }

  /* ── start: the laptop, its own budget, then the first bank ── */
  L.w.eval(`budget.initial = ${cents(100, 900)}; budget.daily = ${daily}; budget.purchases = []; budget.lastDate = '${today()}'; saveToLocal();`);
  L.signIn();
  await until(() => W.cloudState(), 4000);
  for (const b of banks.filter(x => !x.spec.connectLater)) { await connect(L, b); note(`connect ${b.spec.prefix} (${b.accts.map(a => a.subtype + (a.noAvail ? ' (no available)' : '')).join(', ')})`); }
  M.initial = expectedBalance();
  let P = null;
  let step = 0;
  if (!await settle()) problems.push('the start never settled');
  check(step);
  if (withPhone) {
    P = await W.boot('phone', { 'focus-app-state': W.cloud.at(`users/${UID}/state`),
      'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: L.w.eval('syncHash(syncFingerprint(gatherState()))') }) });
    P.signIn();
    await until(() => P.w.eval('bank.items.length') === banks.filter(b => b.connected).length, 6000);
    if (!await settle()) problems.push('the phone never settled');
    check(step);
  }
  const devices = () => [L, ...(P ? [P] : [])];

  /* ── the days ── */
  const counts = {};
  const did = k => { counts[k] = (counts[k] || 0) + 1; };
  const NAMES = ['Coffee', 'Lunch', 'Groceries', 'Bus fare', 'Books', 'Snacks', 'Pharmacy', 'Takeout', 'Parking', 'Movie'];
  let laterBank = banks.find(b => b.spec.connectLater);
  for (let day = 0; day < days && !problems.length; day++) {
    if (day > 0) {
      const offTotal = M.following ? null : totalExpected();
      for (const p of M.typed) if (p.day === today() && !p.lin && !p.removed) p.carried = M.following;   // kept for the bank's late copy
      dayRef.today = addDays(today(), 1);
      for (const app of devices()) { app.w.__today = today(); app.w.eval('budgetTickDay()'); }
      if (M.following) M.initial = expectedBalance();
      else M.offInitial = round2(offTotal + daily);                       // Budget's own again: the daily budget is added
      M.anchorFromLog = false;
      note(`── a new day: ${today()}`);
      did('new day');
      if (!await settle()) problems.push(`step ${step}: the new day never settled`);
      check(++step);
    }
    const steps = 6 + Math.floor(rand() * 8);
    for (let s = 0; s < steps && !problems.length; s++) {
      const r = rand();
      const connected = banks.filter(b => b.connected);
      const b = pick(connected);
      const pend = () => b.lin.filter(l => curTx(l) && curTx(l).pending && !l.dropped && !l.history && followedAcct(l.a));
      const appNow = P && chance(0.4) ? P : L;
      M.anchorFromLog = false;
      let what = '';
      if (laterBank && !laterBank.connected && chance(0.12)) {
        await connect(appNow, laterBank);
        what = `${appNow.name} connects ${laterBank.spec.prefix}`;
        M.initial = null; M.anchorFromLog = M.following; did('second bank connected later');
        laterBank = null;
      } else if (disconnectOne && connected.length === 2 && day === days - 1 && chance(0.1)) {
        const gone = connected[1];
        appNow.w.openSettings('bank');
        await until(() => appNow.d.querySelector(`#bankPanel [data-bank="disconnect"][data-item="${gone.itemId}"]`), 3000);
        appNow.d.querySelector(`#bankPanel [data-bank="disconnect"][data-item="${gone.itemId}"]`).click();
        await until(() => appNow.w.eval('bank.items.length') === 1, 5000);
        gone.connected = false;
        gone.card = null;
        what = `${appNow.name} disconnects ${gone.spec.prefix}`;
        M.initial = null; M.anchorFromLog = M.following; did('bank disconnected');
      } else if (followOffOn && chance(0.08)) {
        appNow.w.openSettings('bank');
        await until(() => appNow.d.querySelector('#bankPanel [data-bank="budget"]'), 3000);
        if (M.following) {
          M.offInitial = round2(totalExpected() + spentExpected());
          appNow.d.querySelector('#bankPanel [data-bank="budget"]').click();
          M.following = false;
          M.typed.forEach(p => { p.carried = false; });                   // (turned off, Budget forgets what it kept)
          what = `${appNow.name} turns following off`;
          did('turned off');
        } else {
          appNow.d.querySelector('#bankPanel [data-bank="budget"]').click();
          M.following = true;
          M.typed.forEach(p => { p.carried = false; });
          for (const x of banks.filter(y => y.connected && y.fetched)) {      // the sync point: the lists as last fetched
            x.since = today();
            for (const l of x.lin.filter(y => followedAcct(y.a) && y.seen !== 'gone')) {
              if (l.fetchedCur) { l.seen = 'history'; l.seenAmount = x.fetched.txs.get(l.fetchedCur).amount; l.appCur = l.fetchedCur; }
              else l.seen = undefined;
            }
            x.card = null;
            cardPass(x, true);                                                // and each card starts from its balance as last fetched
          }
          M.initial = null; M.anchorFromLog = true;
          what = `${appNow.name} turns following on again`;
          did('turned on again');
        }
      } else if (r < 0.2) {
        const name = pick(NAMES);
        const amount = cents(1, 60);
        const l = bank.pending(b, amount, name);
        what = `${b.spec.prefix}: ${name} ${money(amount)} pending (${l.a.subtype})`;
        did('pending charge');
      } else if (r < 0.32 && pend().length) {
        const l = pick(pend());
        const tip = chance(0.3) ? cents(0.5, 6) : 0;
        bank.post(l, tip);
        what = `${b.spec.prefix}: ${l.name} posts${tip ? ` with a ${money(tip)} tip` : ''}`;
        did(tip ? 'posted with a tip' : 'posted');
      } else if (r < 0.37 && pend().length) {
        const l = pick(pend());
        bank.drop(l);
        what = `${b.spec.prefix}: the bank drops ${l.name} (a hold released)`;
        did('pending dropped');
      } else if (r < 0.44) {
        const a = pick(b.accts.filter(followedAcct));
        const amount = cents(1, 120);
        bank.debit(b, a, amount, pick(['Card', 'Online', 'Bill pay', 'ATM']) + ' ' + pick(NAMES), today());
        what = `${b.spec.prefix}: ${money(amount)} out, posted at once`;
        did('posted charge');
      } else if (r < 0.49) {
        const amount = chance(0.5) ? cents(200, 900) : cents(3, 40);
        const a = pick(b.accts.filter(x => followedAcct(x) && (amount <= 100 || x.type !== 'credit')));   // (a paycheck goes to checking)
        bank.credit(b, a, amount, amount > 100 ? 'Payroll' : 'Refund');
        what = `${b.spec.prefix}: ${money(amount)} in (${amount > 100 ? 'paycheck' : 'refund'})`;
        did(amount > 100 ? 'paycheck' : 'refund');
      } else if (r < 0.52) {
        const a = pick(b.accts.filter(followedAcct));
        const amount = cents(5, 60);
        bank.debit(b, a, amount, 'Late ' + pick(NAMES), addDays(today(), -1));
        what = `${b.spec.prefix}: ${money(amount)} from yesterday shows up only now`;
        did('charge dated yesterday');
      } else if (r < 0.55 && b.accts.some(a => a.subtype === 'savings')) {
        const amount = cents(10, 200);
        const l = bank.debit(b, b.accts[0], amount, 'Transfer to savings', today());
        bank.credit(b, b.accts.find(a => a.subtype === 'savings'), amount, 'Transfer from checking');
        l.transfer = true;
        what = `${b.spec.prefix}: ${money(amount)} moved to savings`;
        did('transfer to savings');
      } else if (r < 0.58 && b.accts.some(a => a.type === 'credit')) {
        const cc = b.accts.find(a => a.type === 'credit');
        if (chance(0.5)) { bank.debit(b, cc, cents(5, 80), 'Card ' + pick(NAMES), today()); what = `${b.spec.prefix}: a credit card purchase`; did('credit card purchase'); }
        else {
          const amount = round2(Math.min(cc.current, cents(20, 300)) || 10);
          bank.debit(b, b.accts[0], amount, 'Card payment', today(), 'LOAN_PAYMENTS').payment = true;
          bank.credit(b, cc, amount, 'Payment received', 'LOAN_PAYMENTS').payment = true;
          what = `${b.spec.prefix}: ${money(amount)} paid to the credit card`;
          did('credit card paid');
        }
      } else if (r < 0.66) {
        const name = pick(NAMES) + ' (typed)';
        let amount = cents(1, 40);
        if (chance(0.5)) {                                              // a card purchase the bank shows soon
          while (typedToday().some(p => !p.lin && p.amount === amount)) amount = round2(amount + 0.01);
          await type(appNow, name, amount);
          const l = bank.pending(b, amount, name.replace(' (typed)', ' at the till'));
          what = `${appNow.name} types ${name} ${money(amount)}; the bank has it pending`;
          did('typed, then at the bank');
        } else {
          await type(appNow, name, amount);
          what = `${appNow.name} types ${name} ${money(amount)} (cash)`;
          did('typed (cash)');
        }
      } else if (r < 0.70 && rowsToday().length) {
        const x = pick(rowsToday());
        const el = rowEl(appNow, p => p.bank === x.bank);
        if (el) {
          el.querySelector('[data-pact="del"]').click();
          if (x.card) {
            x.card.removed = true;
            what = `${appNow.name} takes a card purchase out of Budget (×)`;
          } else {
            x.l.removed = true;
            if (x.row.typed) x.row.typed.removed = true;
            x.l.row = null; x.l.extra = null;
            what = `${appNow.name} takes ${x.l.name}${x.row === x.l.extra ? ' (posted higher)' : ''} out of Budget (×)`;
          }
          did('taken out with ×');
        }
      } else if (r < 0.73 && rowsToday().length) {
        const x = pick(rowsToday());
        const el = rowEl(appNow, p => p.bank === x.bank);
        if (el) {
          const amount = cents(1, 30);
          const input = el.querySelector('[data-pact="amount"]');
          input.value = amount.toFixed(2);
          input.dispatchEvent(new appNow.w.Event('change', { bubbles: true }));
          x.row.amount = amount;
          if (x.row.typed) x.row.typed.amount = amount;
          what = `${appNow.name} changes ${x.l ? x.l.name : 'a card purchase'} to ${money(amount)}`;
          did('amount changed');
        }
      } else if (r < 0.79) {                                           // a bank that hands Plaid yesterday's charges only today
        const yesterday = addDays(today(), -1);
        const typedYesterday = M.typed.find(p => p.carried && !p.lin && !p.removed && p.day === yesterday);
        if (typedYesterday && chance(0.6)) {
          bank.pending(b, typedYesterday.amount, typedYesterday.title.replace(' (typed)', ' at the till'), yesterday);
          what = `${b.spec.prefix}: ${typedYesterday.title} ${money(typedYesterday.amount)}, typed yesterday, reaches Plaid only today`;
          did('typed yesterday, at the bank today');
        } else {
          const amount = cents(2, 70);
          const l = bank.pending(b, amount, 'Late ' + pick(NAMES), yesterday);
          what = `${b.spec.prefix}: yesterday's ${l.name} ${money(amount)} reaches Plaid only today`;
          did('pending from yesterday, seen today');
        }
      }
      if (!what || chance(0.55)) {                                     // a refresh: a device fetches the bank
        const bb = pick(banks.filter(x => x.connected));
        await refresh(appNow, bb);
        what = what ? `${what}; ${appNow.name} refreshes ${bb.spec.prefix}` : `${appNow.name} refreshes ${bb.spec.prefix}`;
      }
      note(`${String(++step).padStart(2)}. ${what}`);
      if (!await settle()) { problems.push(`step ${step}: never settled`); break; }
      check(step);
      if (M.anchorFromLog && M.following) { M.initial = round2(L.w.eval('budget.initial')); M.anchorFromLog = false; }
    }
    if (!problems.length) {                                              // the day ends with every bank fetched
      for (const x of banks.filter(y => y.connected)) await refresh(L, x);
      note(`${String(++step).padStart(2)}. ${L.name} refreshes every bank at the end of the day`);
      if (!await settle()) problems.push(`step ${step}: never settled`);
      check(step);
    }
  }
  features.push(...Object.entries(counts).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)));
  if (bankSpecs.some(s => s.noAvail)) features.push('an account with no available balance');
  if (bankSpecs.some(s => s.paypal)) features.push('PayPal followed too');
  return { seed, ok: !problems.length, problems: problems.slice(0, 3), features, log, ms: 0 };
}

/* ── one case per process, several at a time ── */
if (process.env.BANK_SEED) {
  const seed = Number(process.env.BANK_SEED);
  const t0 = Date.now();
  runCase(seed).then(res => {
    res.ms = Date.now() - t0;
    if (process.env.BANK_LOG) console.log(res.log.join('\n'));
    console.log('RESULT ' + JSON.stringify(res));
    process.exit(0);
  }, e => {
    console.log('RESULT ' + JSON.stringify({ seed, ok: false, problems: [`crashed: ${e && e.stack}`], features: [], log: [] }));
    process.exit(1);
  });
} else {
  const [cases = 100, first = 1, procs = 6] = process.argv.slice(2).map(Number);
  const seeds = Array.from({ length: cases }, (_, i) => first + i);
  const results = [];
  const started = Date.now();
  const runOne = seed => new Promise(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, __filename], { env: { ...process.env, BANK_SEED: String(seed) }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find(l => l.startsWith('RESULT '));
      const res = line ? JSON.parse(line.slice(7)) : { seed, ok: false, problems: ['timed out or died without a result'], features: [], log: [] };
      results.push(res);
      console.log(`${res.ok ? '✓' : '✗'} case ${String(results.length).padStart(3)}/${cases}  seed ${seed}: ${res.features.join(', ')}${res.ok ? '' : ` — ${res.problems.join('; ')}`}`);
      resolve();
    });
  });
  (async () => {
    const queue = [...seeds];
    await Promise.all(Array.from({ length: procs }, async () => { while (queue.length) await runOne(queue.shift()); }));
    const failed = results.filter(r => !r.ok).sort((a, b) => a.seed - b.seed);
    const all = results.flatMap(r => r.features.map(f => f.replace(/ ×\d+$/, '')));
    const tally = [...new Set(all)].map(f => `${f}: ${all.filter(x => x === f).length}`).join(', ');
    console.log(`\n${results.length - failed.length}/${results.length} cases passed in ${Math.round((Date.now() - started) / 1000)} s`);
    console.log(`  cases with: ${tally}`);
    failed.forEach(r => console.log(`\n── seed ${r.seed} ──\n${r.problems.join('\n')}\n${(r.log || []).join('\n')}`));
    process.exit(failed.length ? 1 : 0);
  })();
}
