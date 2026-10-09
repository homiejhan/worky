/* bankbudget.js — Budget following the bank. Pure functions over plain data, so
 * tests import this file directly and budget.js applies the result.
 *
 * The balance. Budget's total balance is the bank's own balance over the
 * accounts it follows (bankBalance): what's in the checking accounts, less what
 * is owed on the credit cards, as each card shows it. So it can't drift from
 * the bank's, and the day starts from what that balance was when the day began
 * (budget.js). With no checking account connected there is no such balance:
 * Budget keeps its own total, and what the cards spend comes off it.
 *
 * Checking accounts: the transactions say what the day's spending is. The
 * first time Budget sees a bank connection whose history Plaid has finished
 * gathering (the sync point), every transaction it can see then counts as
 * already in the balance. From then on each new one is logged on the day Budget
 * first sees it, as the balance moves, whatever day the bank dates it (banks
 * hand Plaid a day's charges hours or a day late, and the app may not have
 * looked since):
 *   • money out → a purchase today, marked as from the bank and, dated an
 *     earlier day, with that day (`on`). One typed by hand for the same amount
 *     is matched to it instead, so it isn't counted twice: typed today for a
 *     charge dated today, or typed within a day of the bank's date for one
 *     dated an earlier day (`typed`: what was typed lately and the bank hasn't
 *     shown);
 *   • money in → a line today (the bank's balance has it already; with no
 *     balance from the bank, it moves Budget's own: `balance` below).
 * A pending charge that posts is the same purchase: only a change in the amount
 * (a tip) is logged, as a purchase today if more went out. A pending charge the
 * bank dropped is given back. A payment to a credit card is neither (cardPayment).
 * What has been counted is remembered per transaction (`seen`) in the synced
 * state, next to the budget it changed, so a transaction is logged once however
 * many devices see it, and which accounts the sync point covers (`acc`): an
 * account Budget starts following later gets a sync point of its own the first
 * time it's seen. Amounts keep Plaid's sign: positive is money out.
 *
 * Credit cards: the card's balance says what was spent. Budget keeps the
 * balance it last saw on each card (`cards`). When it sees the card again,
 * whatever the balance went up by is spending, logged as one purchase today
 * (named after the card's new charges when they add up to it, and matched to
 * a purchase typed by hand first), and whatever a payment to the card took off
 * is added back to that, since paying the card isn't spending: a posted
 * payment at once, a pending one once the balance falls by it or it posts
 * (some cards' balances count pending payments, some don't). When the
 * balance went down by more than its payments (a refund, a charge the card
 * dropped), that comes off what the card spent today, and the rest is money
 * in. Card transactions are never counted one by one, so none is in `seen`: a
 * copy of Focus from before cards went by their balance, which follows
 * checking only, finds no card charge there that it could take for one the
 * bank dropped and give back. */
import { addDays } from './runway.js';

const HISTORY_DAYS = 3;          // new rows dated this long before the sync point are late history, not new money
const SPENDING = new Set(['checking', 'prepaid', 'cash management', 'paypal']);
const CARD_LINE = 'c:';          // a purchase from a card's balance: bank `c:<item>/<account>#<n>`, or `=<n>` for one typed by hand
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const canon = v => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);   // key order is not a change
const cardItemId = key => key.slice(0, key.indexOf('/'));

/* The accounts Budget follows: where day-to-day money comes and goes (cash:
 * checking and the like), and the credit cards it's spent with. */
export function bankCashAccount(a) { return !!a && a.type === 'depository' && SPENDING.has(a.subtype); }
export function bankCardAccount(a) { return !!a && a.type === 'credit'; }
export function bankSpendingAccount(a) { return bankCashAccount(a) || bankCardAccount(a); }
/* A purchase Budget logged from a card's balance, or typed by hand and matched to one. */
export function bankCardLine(p) { return !!p && typeof p.bank === 'string' && p.bank.startsWith(CARD_LINE); }

/* What's owed on a card: the balance the card shows (Plaid's current balance,
 * which Settings → Bank accounts shows and which goes up as you buy), or, where
 * the card gives none, its limit less the credit available. */
export function bankCardOwed(a) {
  if (!a) return null;
  if (Number.isFinite(a.current)) return round2(a.current);
  return Number.isFinite(a.limit) && Number.isFinite(a.available) ? round2(a.limit - a.available) : null;
}
/* The balance Budget's total follows: the bank's own, over the accounts it
 * follows. Each cash account's available balance (pending charges taken off, as
 * the bank counts what you can spend), or its current balance where the bank
 * gives no available one; less what's owed on each card. null while no
 * followed cash account has a balance: with cards alone Budget keeps its own
 * total, and what they spend comes off it. */
const accountBalance = a => (Number.isFinite(a.available) ? a.available : Number.isFinite(a.current) ? a.current : null);
export function bankBalance(items = []) {
  let sum = 0, any = false;
  for (const item of items) {
    for (const a of (item && item.accounts) || []) {
      if (bankCashAccount(a) && accountBalance(a) !== null) { sum += accountBalance(a); any = true; }
      else if (bankCardAccount(a) && bankCardOwed(a) !== null) sum -= bankCardOwed(a);
    }
  }
  return any ? round2(sum) : null;
}
/* Which accounts that balance is of, and how it is reckoned (`2:` cards at the
 * balance they show): when either changes (a bank connected or disconnected),
 * the start of the day is taken again. */
export function bankBalanceKey(items = []) {
  const keys = items.flatMap(item => ((item && item.accounts) || [])
    .filter(a => (bankCashAccount(a) && accountBalance(a) !== null) || (bankCardAccount(a) && bankCardOwed(a) !== null))
    .map(a => `${item.id}/${a.id}`)).sort();
  return keys.length ? `2:${keys.join(',')}` : '';
}

/* A payment to a credit card moves money between accounts Budget follows, or
 * pays the card from another bank: it isn't spending, and it isn't money in.
 * Plaid files it as LOAN_PAYMENTS (some cards say TRANSFER_IN for the payment
 * received); without a category, its name says so. On a checking account it
 * only counts as one with a card followed: otherwise paying the card is the
 * only sign of what was spent on it, and is spending. */
const PAYMENT_NAME = /\b(payment|pymt|pmt|autopay|auto pay|epay|e-payment)\b/i;
const CARD_NAME = /\b(card|crd|credit|visa|amex|american express|discover|mastercard|capital one|citi|chase)\b/i;
function cardPayment(t, account, cards) {
  const name = String(t.name || '');
  if (bankCardAccount(account)) return t.amount < 0 && (t.category ? ['LOAN_PAYMENTS', 'TRANSFER_IN'].includes(t.category) : PAYMENT_NAME.test(name));
  return cards && t.amount > 0 && (t.category ? t.category === 'LOAN_PAYMENTS' : PAYMENT_NAME.test(name) && CARD_NAME.test(name));
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
const byDate = (a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1);
/* What a purchase from a card is called: the charges that add up to it. */
function chargeNames(list) {
  const n = [...new Set(list.map(t => String(t.name || '').trim()).filter(Boolean))];
  return (n.length > 3 ? `${n.slice(0, 3).join(', ')} +${n.length - 3} more` : n.join(', ')).slice(0, 60);
}

/* One pass over the connections.
 *   tracked   { <item id>: { since, seen, acc, v } } from the last pass (the synced
 *             state): the checking accounts' sync point. v: 2 = counts checking only
 *   cards     { '<item id>/<account id>': { b, s, d, n, ids, u? } } from the last pass:
 *             the balance last seen on each card (b), what was owed at the start of
 *             day d (s), how many lines it has logged (n: their ids), the card's
 *             transactions in that copy of its list (ids: new ones name what was
 *             spent), and its pending payments (u: [{ i: id, a: amount, s }], s: 1
 *             once the balance fell by it, 'b' listed when Budget first looked)
 *   items     the account's connections: [{ id, accounts, transactions, updatedAt, status }]
 *   purchases today's purchases: [{ id, title, amount, bank?, pending?, on? }]
 *   typed     purchases typed by hand on the last few days that the bank hasn't
 *             shown yet: [{ d: the day typed, a: amount }] (budget.js keeps them at rollover)
 *   today     'YYYY-MM-DD';  nextId  the next purchase id
 * Returns the new tracked, cards, purchases and typed, `balance` (how much the
 * total balance moves outside today's purchases; + is more money), `log` (a
 * line for each of those moves: { d: its date, n, a, t: the day it was logged },
 * signed the same way), `nextId`,
 * `logged` (how many changes reached the budget) and `changed`. A connection
 * missing from `items` keeps what was tracked (a copy of the list can lag);
 * Disconnect drops it (budget.js → budgetForgetBank), and connected again it
 * starts anew. */
export function bankBudgetStep({ tracked = {}, cards = {}, items = [], purchases = [], typed = [], today, nextId = 1 }) {
  const res = { tracked: {}, cards: {}, purchases: purchases.map(p => ({ ...p })), typed: typed.map(e => ({ ...e })), balance: 0, log: [], nextId, logged: 0, changed: false };
  const entryFor = id => res.purchases.find(p => p.bank === id);
  const toBalance = (amount, date, name) => {
    res.balance = round2(res.balance - amount);
    res.log.push({ d: date, n: String(name || '').slice(0, 60), a: round2(-amount), t: today });
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
  Object.keys(cards).forEach(k => { if (!listed.has(cardItemId(k))) res.cards[k] = cards[k]; });
  const anyCard = items.some(i => i && (i.accounts || []).some(bankCardAccount));   // (a card at another bank is paid from this one's checking)

  for (const item of items) {
    if (!item || !item.id) continue;
    checkingPass(item);
    cardPass(item);
  }

  res.changed = res.balance !== 0 || res.nextId !== nextId
    || JSON.stringify(canon([tracked, cards, purchases, typed])) !== JSON.stringify(canon([res.tracked, res.cards, res.purchases, res.typed]));
  return res;

  /* ── checking: transaction by transaction ── */
  function checkingPass(item) {
    const accounts = new Map((item.accounts || []).filter(bankCashAccount).map(a => [a.id, a]));
    const onCards = new Set((item.accounts || []).filter(bankCardAccount).map(a => a.id));
    const all = item.transactions || [];
    const cardTx = new Set(all.filter(t => t && t.id && onCards.has(t.account)).flatMap(t => [t.id, t.pending_id].filter(Boolean)));
    const txs = all.filter(t => t && t.id && accounts.has(t.account) && !cardPayment(t, accounts.get(t.account), anyCard))
      .sort(byDate);                                                             // oldest first: log in order
    const before = tracked[item.id];
    if (!before || !before.since || !before.seen) {
      if (!bankItemReady(item)) return;                                          // wait for Plaid's history
      const seen = {};
      txs.forEach(t => { seen[t.id] = rec(t); });
      /* a purchase logged from this bank before (following turned off and on
       * again) follows its charge to the copy that posted meanwhile */
      txs.forEach(t => {
        const e = t.pending_id && entryFor(t.pending_id);
        if (e) { e.bank = t.id; if (t.pending) e.pending = true; else delete e.pending; }
      });
      res.tracked[item.id] = { since: today, seen, acc: [...accounts.keys()].sort(), v: 2 };
      return;
    }
    const seen = { ...before.seen };
    /* the first pass since card transactions were counted here as well (or since
     * a copy of Focus from before then wrote this): what went missing may have been
     * a card's, which its balance counts now, so nothing is given back this time */
    const migrating = before.v !== 2;
    /* accounts the sync point didn't cover: what they show the first time is
     * already in the balance, as for a new connection */
    const covered = new Set((Array.isArray(before.acc) ? before.acc : [...accounts.keys()]).filter(id => !onCards.has(id)));
    const fresh = new Set([...accounts.keys()].filter(id => !covered.has(id)));
    const present = new Set(txs.map(t => t.id));
    const superseded = new Set(txs.map(t => t.pending_id).filter(Boolean));     // pending charges whose posted copy is here

    for (const t of txs) {
      if (superseded.has(t.id)) continue;                                        // counted with its posted copy
      if (fresh.has(t.account) && !seen[t.id]) { seen[t.id] = rec(t); continue; }   // a newly followed account's history
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
     * stays counted, so it isn't counted again when it comes back. A card's,
     * counted here before cards went by their balance, just goes. */
    const full = all.length >= 50;
    const oldest = all.reduce((m, t) => (t && t.date && (!m || t.date < m) ? t.date : m), '');
    for (const [id, s] of Object.entries(seen)) {
      if (cardTx.has(id)) { delete seen[id]; continue; }
      if (present.has(id) && !superseded.has(id)) continue;
      const agedOut = full && !(s.d > oldest);
      if (!s.p && !superseded.has(id) && !agedOut) continue;
      delete seen[id];
      if (superseded.has(id) || !s.p || s.x || agedOut || migrating) continue;
      const e = entryFor(id);
      if (e) res.purchases = res.purchases.filter(p => p !== e);
      else toBalance(-s.a, s.d, s.n || 'A pending charge');
      res.logged++;
    }
    res.tracked[item.id] = { since: before.since, seen, acc: [...new Set([...covered, ...accounts.keys()])].sort(), v: 2 };   // (never shrinks: a copy can lag)
  }

  /* ── credit cards: by their balance ── */
  function cardPass(item) {
    if (!(item.accounts || []).length) {                                         // no accounts read (yet): keep what was tracked
      Object.keys(cards).forEach(k => { if (cardItemId(k) === item.id) res.cards[k] = cards[k]; });
      return;
    }
    const all = item.transactions || [];
    for (const a of (item.accounts || []).filter(x => bankCardAccount(x) && x.id)) {
      const key = `${item.id}/${a.id}`;
      const prev = cards[key];
      const owed = bankCardOwed(a);
      if (owed === null) { if (prev) res.cards[key] = prev; continue; }
      const list = all.filter(t => t && t.id && t.account === a.id);
      const ids = list.map(t => t.id).sort();
      const isPay = t => cardPayment(t, a, true);
      /* a pending payment listed when Budget first looks: whether the balance
       * has it already isn't known ('b': it is added back when it posts only if
       * the balance falls by it then) */
      const atStart = known => list.filter(t => t.pending && isPay(t) && (!known || known.has(t.id))).map(t => ({ i: t.id, a: round2(-t.amount), s: 'b' }));
      if (!prev || !Number.isFinite(prev.b)) {
        /* what's owed now is already in the balance. (Numbered on from its purchases
         * already today, if Budget followed it earlier today: their ids stay its own.) */
        const used = res.purchases.filter(p => typeof p.bank === 'string' && ['#', '='].some(c => p.bank.startsWith(`${CARD_LINE}${key}${c}`)))
          .map(p => Number(p.bank.slice(CARD_LINE.length + key.length + 1)) || 0);
        const u = atStart(null);
        if (bankItemReady(item)) res.cards[key] = { b: owed, s: owed, d: today, n: Math.max(0, ...used), ids, ...(u.length ? { u } : {}) };
        continue;
      }
      const cur = { b: owed, s: prev.d === today && Number.isFinite(prev.s) ? prev.s : prev.b, d: today, n: Number(prev.n) || 0, ids };
      res.cards[key] = cur;
      const known = new Set(Array.isArray(prev.ids) ? prev.ids : []);
      const fresh = list.filter(t => !known.has(t.id) && !(t.pending_id && known.has(t.pending_id))).sort(byDate);
      let x = round2(owed - prev.b);                                              // the rise in the balance
      /* Payments aren't spending: what one took off the balance is added back.
       * A posted one is in the balance (Plaid's balance is never older than its
       * transactions): added back now. A pending one is in it only on a card
       * whose balance counts pending ones, so it waits (`u`) until the balance
       * falls by it, or until it posts (then it's in the balance whatever the
       * card counts), and one that goes without posting after the balance fell
       * by it puts that back. */
      fresh.filter(t => isPay(t) && !t.pending).forEach(t => { x = round2(x - t.amount); });
      const listed = new Map(list.map(t => [t.id, t]));
      const postedAs = new Set(list.filter(t => t.pending_id && !t.pending).map(t => t.pending_id));
      const waiting = [];
      const atPosting = [];
      for (const e of [...(Array.isArray(prev.u) ? prev.u.map(e => ({ ...e })) : atStart(known)),   // (none kept: a copy from before payments waited)
        ...fresh.filter(t => isPay(t) && t.pending).map(t => ({ i: t.id, a: round2(-t.amount) }))]) {
        const now = listed.get(e.i);
        if (now && now.pending) waiting.push(e);                                 // still pending
        else if (now || postedAs.has(e.i)) {                                     // posted
          if (e.s === 'b') atPosting.push(e);
          else if (e.s !== 1) x = round2(x + e.a);
        } else if (e.s === 1) x = round2(x - e.a);                               // gone without posting
      }
      /* the balance fell by just that, beyond what its new charges and credits
       * moved it by: those pending ones too if the card counts them (g1), or
       * the posted ones and pending ones that posted if it counts posted only (g0) */
      const g1 = round2(fresh.filter(t => !isPay(t)).reduce((s, t) => s + t.amount, 0));
      const g0 = round2(fresh.filter(t => !isPay(t) && !t.pending).reduce((s, t) => s + t.amount, 0)
        + list.filter(t => !t.pending && !isPay(t) && t.pending_id && known.has(t.pending_id) && !known.has(t.id)).reduce((s, t) => s + t.amount, 0));
      const shows = amount => [g1, g0].some(g => Math.abs(round2(g - x) - amount) < 0.005);
      atPosting.forEach(e => { if (shows(e.a)) x = round2(x + e.a); });          // (otherwise it was in the balance before Budget looked)
      const open = waiting.filter(e => !e.s);
      const sum = round2(open.reduce((s, e) => s + e.a, 0));
      if (open.length > 1 && shows(sum)) { open.forEach(e => { e.s = 1; }); x = round2(x + sum); }
      else open.forEach(e => { if (shows(e.a)) { e.s = 1; x = round2(x + e.a); } });
      if (waiting.length) cur.u = waiting;
      if (!x) continue;
      const lines = `${CARD_LINE}${key}#`;
      const label = `${a.name || 'Credit card'}${a.mask ? ` ••${a.mask}` : ''}`;
      res.logged++;
      if (x > 0) {
        /* typed by hand: counted then. Today's for a charge dated today (or later),
         * one typed within a day of an earlier one's date (carried in `typed`) */
        const typedFor = (amount, date, t) => {
          if (date >= today) {
            const p = res.purchases.find(q => !q.bank && round2(q.amount) === amount);
            if (!p) return false;
            p.bank = `${CARD_LINE}${key}=${++cur.n}`;
            if (t && t.pending) p.pending = true;
            return true;
          }
          const k = res.typed.findIndex(e => round2(e.a) === amount && (!t || (e.d >= addDays(date, -1) && e.d <= addDays(date, 1))));
          if (k < 0) return false;
          res.typed.splice(k, 1);
          return true;
        };
        const left = [];
        for (const t of fresh.filter(t => t.amount > 0 && !isPay(t))) {
          const amount = round2(t.amount);
          if (amount <= x && typedFor(amount, t.date, t)) x = round2(x - amount);
          else left.push(t);
        }
        /* no new charge for it (one posted: a tip, or a card whose balance counts posted charges only): the amount alone */
        if (x > 0 && !left.length && (typedFor(x, today, null) || typedFor(x, '', null))) x = 0;
        if (x > 0) {
          const posted = list.filter(t => !t.pending && t.amount > 0 && t.pending_id && known.has(t.pending_id) && !known.has(t.id));
          const named = left.length ? (Math.abs(left.reduce((s, t) => s + t.amount, 0) - x) < 0.005 ? left : []) : posted;
          const days = [...new Set(named.map(t => t.date))];
          res.purchases.push({ id: res.nextId++, title: named.length ? chargeNames(named) : label, amount: x, bank: `${lines}${++cur.n}`,
            ...(named.length && named.every(t => t.pending) ? { pending: true } : {}),
            ...(days.length === 1 && days[0] < today ? { on: days[0] } : {}) });
        }
        continue;
      }
      /* down by more than its payments. The purchase of just that amount from it
       * today goes (a return, a hold dropped); a refund otherwise is money in; a
       * drop with no transaction behind it (a hold the card let go) comes off
       * what the card spent today first */
      let back = -x;
      const credits = fresh.filter(t => t.amount < 0 && !isPay(t));
      const mine = p => typeof p.bank === 'string' && p.bank.startsWith(lines);
      const same = res.purchases.filter(p => mine(p) && round2(p.amount) === back).pop();
      for (const p of same ? [same] : credits.length ? [] : [...res.purchases].reverse()) {
        if (!(back > 0)) break;
        if (!mine(p)) continue;
        const take = Math.min(back, p.amount);
        p.amount = round2(p.amount - take);
        back = round2(back - take);
      }
      res.purchases = res.purchases.filter(p => !(mine(p) && !(p.amount > 0)));
      if (back > 0) {
        const named = credits.length && Math.abs(credits.reduce((s, t) => s - t.amount, 0) - back) < 0.005 ? credits : [];
        toBalance(-back, today, named.length ? chargeNames(named) : `${label} credit`);
      }
    }
  }
}

/* What Budget does with each connection, for Budget to say so:
 *   { id, bank, accounts: [{ name, mask }], state, since }
 * state: 'following' (its checking accounts and cards are logged from `since`),
 * 'none' (it has neither, so nothing to log), 'waiting' (no sync point yet: Plaid
 * is still gathering its history) or 'error' (it needs attention in Settings →
 * Bank accounts; `error` says why). A connection with cards alone follows them
 * from when Budget first saw their balance. */
export function bankBudgetFollowing(tracked = {}, items = [], cards = {}) {
  return items.filter(i => i && i.id).map(item => {
    const t = tracked[item.id];
    const accounts = (item.accounts || []).filter(bankSpendingAccount).map(a => ({ name: a.name || (bankCardAccount(a) ? 'Credit card' : 'Checking'), mask: a.mask || null }));
    const carded = Object.keys(cards).some(k => cardItemId(k) === item.id);
    const since = t && t.since ? t.since : null;
    const state = item.error ? 'error' : !since && !carded ? 'waiting' : accounts.length ? 'following' : 'none';
    return { id: item.id, bank: (item.institution && item.institution.name) || 'Your bank', accounts, state,
      since, ...(item.error ? { error: item.error } : {}) };
  });
}

/* Each card Budget follows by its balance, for Budget to show what it tracks:
 *   [{ key, name, mask, owed (the balance last seen), start (what was owed when today began) }] */
export function bankCardsTracked(cards = {}, items = [], today) {
  return items.filter(i => i && i.id).flatMap(item => (item.accounts || []).filter(bankCardAccount).map(a => {
    const c = cards[`${item.id}/${a.id}`];
    if (!c || !Number.isFinite(c.b)) return null;
    return { key: `${item.id}/${a.id}`, name: a.name || 'Credit card', mask: a.mask || null, owed: c.b, start: c.d === today && Number.isFinite(c.s) ? c.s : c.b };
  }).filter(Boolean));
}

/* The user took a purchase from the bank out of Budget: never count that
 * transaction again (a posted copy of it included). A card's purchase has no
 * transaction behind it: its balance has moved on already. */
export function bankBudgetSkip(tracked, txId) {
  const out = {};
  for (const [itemId, entry] of Object.entries(tracked || {})) {
    const seen = entry.seen && entry.seen[txId] ? { ...entry.seen, [txId]: { ...entry.seen[txId], x: 1 } } : entry.seen;
    out[itemId] = { ...entry, seen };
  }
  return out;
}
