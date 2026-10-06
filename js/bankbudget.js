/* bankbudget.js — Budget following the bank. Pure functions over plain data, so
 * tests import this file directly and budget.js applies the result.
 *
 * The balance. Budget's total balance is the bank's own balance over the
 * accounts it follows (bankBalance), so it can't drift from the bank's, and the
 * day starts from what that balance was when the day began (budget.js).
 *
 * The transactions say what the day's spending is. The first time Budget sees a
 * bank connection whose history Plaid has finished gathering (the sync point),
 * every transaction it can see then counts as already in the balance. From then
 * on each new transaction on a spending (checking) account is logged on the day
 * Budget first sees it, as the balance moves, whatever day the bank dates it
 * (banks hand Plaid a day's charges hours or a day late, and the app may not
 * have looked since):
 *   • money out → a purchase under Purchases today, marked as from the bank and,
 *     dated an earlier day, with that day (`on`). One typed by hand for the same
 *     amount is matched to it instead, so it isn't counted twice: typed today
 *     for a charge dated today, or typed within a day of the bank's date for
 *     one dated an earlier day (`typed`: what was typed lately and the bank
 *     hasn't shown);
 *   • money in → a line under From your bank (the bank's balance has it
 *     already; with no balance from the bank, it moves Budget's own: `balance`
 *     below).
 * A pending charge that posts is the same purchase: only a change in the amount
 * (a tip) is logged, as a purchase today if more went out. A pending charge the
 * bank dropped is given back.
 *
 * What has been counted is remembered per transaction (`seen`) in the synced
 * state, next to the budget it changed, so a transaction is logged once however
 * many devices see it. Amounts keep Plaid's sign: positive is money out. */
import { addDays } from './runway.js';

const HISTORY_DAYS = 3;          // new rows dated this long before the sync point are late history, not new money
const SPENDING = new Set(['checking', 'prepaid', 'cash management', 'paypal']);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const canon = v => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);   // key order is not a change

/* The accounts Budget follows: where day-to-day money comes and goes. */
export function bankSpendingAccount(a) { return !!a && a.type === 'depository' && SPENDING.has(a.subtype); }

/* The balance Budget's total follows: the bank's own, over the accounts it
 * follows, each one's available balance (pending charges taken off, as the bank
 * counts what you can spend), or its current balance where the bank gives no
 * available one. null while no followed account has a balance. */
const accountBalance = a => (Number.isFinite(a.available) ? a.available : Number.isFinite(a.current) ? a.current : null);
export function bankBalance(items = []) {
  let sum = 0, any = false;
  for (const item of items) {
    for (const a of (item && item.accounts) || []) {
      if (!bankSpendingAccount(a) || accountBalance(a) === null) continue;
      sum += accountBalance(a);
      any = true;
    }
  }
  return any ? round2(sum) : null;
}
/* Which accounts that balance is of: when they change (a bank connected or
 * disconnected), the start of the day is taken again. */
export function bankBalanceKey(items = []) {
  return items.flatMap(item => ((item && item.accounts) || [])
    .filter(a => bankSpendingAccount(a) && accountBalance(a) !== null).map(a => `${item.id}/${a.id}`)).sort().join(',');
}

/* Plaid has gathered the history the sync point should hold. */
export function bankItemReady(item) {
  if (!item || !(item.updatedAt > 0)) return false;
  return item.status ? item.status !== 'NOT_READY' : (item.transactions || []).length > 0;
}

/* What `seen` keeps for a transaction: the amount counted, its date, whether it
 * is pending, and for a pending one Budget logged, its name (to say what came
 * back if the bank drops it; the sync point itself keeps no names). `x` marks
 * one the user took out of Budget: it is never counted again. */
function rec(t, prev, logged) {
  const named = t.pending && (logged || (prev && prev.n));
  return {
    a: round2(t.amount), d: t.date,
    ...(t.pending ? { p: 1 } : {}),
    ...(named ? { n: String(t.name || '').slice(0, 60) } : {}),
    ...(prev && prev.x ? { x: 1 } : {}),
  };
}

/* One pass over the connections.
 *   tracked   { <item id>: { since, seen } } from the last pass (the synced state)
 *   items     the account's connections: [{ id, accounts, transactions, updatedAt, status }]
 *   purchases today's purchases: [{ id, title, amount, bank?, pending?, on? }]
 *   typed     purchases typed by hand on the last few days that the bank hasn't
 *             shown yet: [{ d: the day typed, a: amount }] (budget.js keeps them at rollover)
 *   today     'YYYY-MM-DD';  nextId  the next purchase id
 * Returns the new tracked, purchases and typed, `balance` (how much the total
 * balance moves outside today's purchases; + is more money), `log` (a line for
 * each of those moves: { d, n, a }, signed the same way), `nextId`, `logged` (how
 * many transactions changed the budget) and `changed`. A connection missing from
 * `items` keeps its sync point (a copy of the list can lag); Disconnect drops it
 * (budget.js → budgetForgetBank), and connected again it starts a new one. */
export function bankBudgetStep({ tracked = {}, items = [], purchases = [], typed = [], today, nextId = 1 }) {
  const res = { tracked: {}, purchases: purchases.map(p => ({ ...p })), typed: typed.map(e => ({ ...e })), balance: 0, log: [], nextId, logged: 0, changed: false };
  const entryFor = id => res.purchases.find(p => p.bank === id);
  const toBalance = (amount, date, name) => {
    res.balance = round2(res.balance - amount);
    res.log.push({ d: date, n: String(name || '').slice(0, 60), a: round2(-amount) });
  };
  /* money out: a purchase today (dated an earlier day: with its day) */
  const toPurchase = (t, amount, title) => {
    res.purchases.push({ id: res.nextId++, title: String(title || 'Purchase').slice(0, 60), amount: round2(amount),
      bank: t.id, ...(t.pending ? { pending: true } : {}), ...(t.date < today ? { on: t.date } : {}) });
  };
  /* a change in a charge already counted (a tip when it posts): more out is
   * spent today, less out comes back to the balance */
  const toChange = (t, delta) => {
    if (delta > 0) toPurchase(t, delta, `${t.name || 'Purchase'} (posted higher)`);
    else toBalance(delta, t.date, t.name);
  };
  const listed = new Set(items.filter(i => i && i.id).map(i => i.id));
  Object.keys(tracked).forEach(id => { if (!listed.has(id)) res.tracked[id] = tracked[id]; });

  for (const item of items) {
    if (!item || !item.id) continue;
    const accounts = new Set((item.accounts || []).filter(bankSpendingAccount).map(a => a.id));
    const all = item.transactions || [];
    const txs = all.filter(t => t && t.id && accounts.has(t.account))
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));     // oldest first: log in order
    const before = tracked[item.id];
    if (!before || !before.since || !before.seen) {
      if (!bankItemReady(item)) continue;                                        // wait for Plaid's history
      const seen = {};
      txs.forEach(t => { seen[t.id] = rec(t); });
      /* a purchase logged from this bank before (following turned off and on
       * again) follows its charge to the copy that posted meanwhile */
      txs.forEach(t => {
        const e = t.pending_id && entryFor(t.pending_id);
        if (e) { e.bank = t.id; if (t.pending) e.pending = true; else delete e.pending; }
      });
      res.tracked[item.id] = { since: today, seen };
      continue;
    }
    const seen = { ...before.seen };
    const present = new Set(txs.map(t => t.id));
    const superseded = new Set(txs.map(t => t.pending_id).filter(Boolean));     // pending charges whose posted copy is here

    for (const t of txs) {
      if (superseded.has(t.id)) continue;                                        // counted with its posted copy
      const known = seen[t.id];
      if (known) {                                                               // Plaid changed a transaction we counted
        const delta = round2(t.amount - known.a);
        const e = entryFor(t.id);
        if (delta && !known.x) {
          if (e) e.amount = round2(e.amount + delta); else toChange(t, delta);
          res.logged++;
        }
        if (e) { if (t.pending) e.pending = true; else delete e.pending; }       // some banks post a charge under the same id
        seen[t.id] = rec(t, known);
        continue;
      }
      const pend = t.pending_id ? seen[t.pending_id] : null;
      if (pend) {                                                                // a pending charge posted
        const delta = round2(t.amount - pend.a);
        const e = entryFor(t.pending_id) || entryFor(t.id);
        if (e) {
          if (e.bank !== t.id) {                                                 // (another device's copy may have moved it already)
            e.bank = t.id;
            if (delta) { e.amount = round2(e.amount + delta); res.logged++; }
          }
          if (t.pending) e.pending = true; else delete e.pending;
        } else if (delta && !pend.x) { toChange(t, delta); res.logged++; }
        seen[t.id] = rec(t, pend);
        delete seen[t.pending_id];
        continue;
      }
      if (t.date < addDays(before.since, -HISTORY_DAYS)) { seen[t.id] = rec(t); continue; }   // history Plaid sent late
      seen[t.id] = rec(t, null, true);
      if (entryFor(t.id)) continue;                                              // already a purchase: another device logged it, and this pass's count lost a merge to it
      if (t.amount > 0 && t.date < today) {                                      // money out the bank dates an earlier day
        const k = res.typed.findIndex(e => round2(e.a) === round2(t.amount) && e.d >= addDays(t.date, -1) && e.d <= addDays(t.date, 1));
        if (k >= 0) { res.typed.splice(k, 1); continue; }                        // typed by hand on its day: counted then
        res.logged++;
        toPurchase(t, t.amount, t.name);
      } else if (t.amount > 0) {                                                 // (a bank a time zone ahead can date it tomorrow)
        res.logged++;
        const typedToday = res.purchases.find(p => !p.bank && round2(p.amount) === round2(t.amount));
        if (typedToday) { typedToday.bank = t.id; if (t.pending) typedToday.pending = true; }
        else toPurchase(t, t.amount, t.name);
      } else {
        res.logged++;
        toBalance(t.amount, t.date, t.name);
      }
    }

    /* Counted transactions no longer in the bank's list. The list keeps only the
     * newest rows (and every pending one), so an old one simply aged out; a
     * pending charge dated inside what the list still covers was dropped by the
     * bank, and is given back. A posted one that should still be listed is
     * missing only from this copy of the list (one saved before it came): it
     * stays counted, so it isn't counted again when it comes back. */
    const full = all.length >= 50;
    const oldest = all.reduce((m, t) => (t && t.date && (!m || t.date < m) ? t.date : m), '');
    for (const [id, s] of Object.entries(seen)) {
      if (present.has(id) && !superseded.has(id)) continue;
      const agedOut = full && !(s.d > oldest);
      if (!s.p && !superseded.has(id) && !agedOut) continue;
      delete seen[id];
      if (superseded.has(id) || !s.p || s.x || agedOut) continue;
      const e = entryFor(id);
      if (e) res.purchases = res.purchases.filter(p => p !== e);
      else toBalance(-s.a, s.d, s.n || 'A pending charge');
      res.logged++;
    }
    res.tracked[item.id] = { since: before.since, seen };
  }

  res.changed = res.balance !== 0 || res.nextId !== nextId
    || JSON.stringify(canon([tracked, purchases, typed])) !== JSON.stringify(canon([res.tracked, res.purchases, res.typed]));
  return res;
}

/* What Budget does with each connection, for Budget to say so:
 *   { id, bank, accounts: [{ name, mask }], state, since }
 * state: 'following' (its checking accounts are logged from `since`), 'none'
 * (it has no checking account, so nothing to log), 'waiting' (no sync point
 * yet: Plaid is still gathering its history) or 'error' (it needs attention in
 * Settings → Bank accounts; `error` says why). */
export function bankBudgetFollowing(tracked = {}, items = []) {
  return items.filter(i => i && i.id).map(item => {
    const t = tracked[item.id];
    const accounts = (item.accounts || []).filter(bankSpendingAccount).map(a => ({ name: a.name || 'Checking', mask: a.mask || null }));
    const state = item.error ? 'error' : !(t && t.since) ? 'waiting' : accounts.length ? 'following' : 'none';
    return { id: item.id, bank: (item.institution && item.institution.name) || 'Your bank', accounts, state,
      since: t && t.since ? t.since : null, ...(item.error ? { error: item.error } : {}) };
  });
}

/* The user took a purchase from the bank out of Budget: never count that
 * transaction again (a posted copy of it included). */
export function bankBudgetSkip(tracked, txId) {
  const out = {};
  for (const [itemId, entry] of Object.entries(tracked || {})) {
    const seen = entry.seen && entry.seen[txId] ? { ...entry.seen, [txId]: { ...entry.seen[txId], x: 1 } } : entry.seen;
    out[itemId] = { ...entry, seen };
  }
  return out;
}
