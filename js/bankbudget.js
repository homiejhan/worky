/* bankbudget.js — New bank transactions, logged in Budget. Pure functions over
 * plain data, so tests import this file directly and budget.js applies the result.
 *
 * The sync point. The first time Budget sees a bank connection whose history
 * Plaid has finished gathering, it takes Budget's balance to match the bank's
 * at that moment: every transaction it can see then counts as already in the
 * balance. From then on each new transaction on a spending (checking) account
 * is logged:
 *   • money out dated today → a purchase under Purchases today, marked as from
 *     the bank (or the purchase typed by hand today for the same amount, now
 *     matched to it, so it isn't counted twice);
 *   • money in, and money out dated an earlier day → the total balance, with a
 *     line under From your bank.
 * A pending charge that posts is the same purchase: only a change in the amount
 * (a tip) is logged. A pending charge the bank drops is given back.
 *
 * What has been counted is remembered per transaction (`seen`) in the synced
 * state, next to the budget it changed, so a transaction is logged once however
 * many devices see it. Amounts keep Plaid's sign: positive is money out. */
import { addDays } from './runway.js';

const HISTORY_DAYS = 3;          // new rows dated this long before the sync point are late history, not new money
const SPENDING = new Set(['checking', 'prepaid', 'cash management', 'paypal']);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* The accounts Budget follows: where day-to-day money comes and goes. */
export function bankSpendingAccount(a) { return !!a && a.type === 'depository' && SPENDING.has(a.subtype); }

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
 *   purchases today's purchases: [{ id, title, amount, bank?, pending? }]
 *   today     'YYYY-MM-DD';  nextId  the next purchase id
 * Returns the new tracked and purchases, `balance` (how much the total balance
 * moves outside today's purchases; + is more money), `log` (a line for each of
 * those moves: { d, n, a }, a signed the same way), `nextId`, `logged` (how many
 * transactions changed the budget) and `changed`. A connection that is gone
 * loses its sync point: connected again, it starts a new one. */
export function bankBudgetStep({ tracked = {}, items = [], purchases = [], today, nextId = 1 }) {
  const res = { tracked: {}, purchases: purchases.map(p => ({ ...p })), balance: 0, log: [], nextId, logged: 0, changed: false };
  const entryFor = id => res.purchases.find(p => p.bank === id);
  const toBalance = (amount, date, name) => {
    res.balance = round2(res.balance - amount);
    res.log.push({ d: date, n: String(name || '').slice(0, 60), a: round2(-amount) });
  };

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
        if (delta && !known.x) {
          const e = entryFor(t.id);
          if (e) e.amount = round2(e.amount + delta); else toBalance(delta, t.date, t.name);
          res.logged++;
        }
        seen[t.id] = rec(t, known);
        continue;
      }
      const pend = t.pending_id ? seen[t.pending_id] : null;
      if (pend) {                                                                // a pending charge posted
        const delta = round2(t.amount - pend.a);
        const e = entryFor(t.pending_id);
        if (e) {
          e.bank = t.id;
          if (t.pending) e.pending = true; else delete e.pending;
          if (delta) { e.amount = round2(e.amount + delta); res.logged++; }
        } else if (delta && !pend.x) { toBalance(delta, t.date, t.name); res.logged++; }
        seen[t.id] = rec(t, pend);
        delete seen[t.pending_id];
        continue;
      }
      if (t.date < addDays(before.since, -HISTORY_DAYS)) { seen[t.id] = rec(t); continue; }   // history Plaid sent late
      seen[t.id] = rec(t, null, true);
      res.logged++;
      if (t.amount > 0 && t.date === today) {
        const typed = res.purchases.find(p => !p.bank && round2(p.amount) === round2(t.amount));
        if (typed) { typed.bank = t.id; if (t.pending) typed.pending = true; }
        else {
          res.purchases.push({ id: res.nextId++, title: String(t.name || 'Purchase').slice(0, 60), amount: round2(t.amount),
            bank: t.id, ...(t.pending ? { pending: true } : {}) });
        }
      } else {
        toBalance(t.amount, t.date, t.name);
      }
    }

    /* Counted transactions no longer in the bank's list. The list keeps only the
     * newest rows, so an old one simply aged out; a pending charge dated inside
     * what the list still covers was dropped by the bank, and is given back. */
    const full = all.length >= 50;
    const oldest = all.reduce((m, t) => (t && t.date && (!m || t.date < m) ? t.date : m), '');
    for (const [id, s] of Object.entries(seen)) {
      if (present.has(id) && !superseded.has(id)) continue;
      delete seen[id];
      if (superseded.has(id) || !s.p || s.x || (full && !(s.d > oldest))) continue;
      const e = entryFor(id);
      if (e) res.purchases = res.purchases.filter(p => p !== e);
      else toBalance(-s.a, s.d, s.n || 'A pending charge');
      res.logged++;
    }
    res.tracked[item.id] = { since: before.since, seen };
  }

  res.changed = res.balance !== 0 || res.nextId !== nextId
    || JSON.stringify([tracked, purchases]) !== JSON.stringify([res.tracked, res.purchases]);
  return res;
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
