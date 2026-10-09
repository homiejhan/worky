/* syncmerge.js — Merging what two devices changed in the synced state. Pure
 * functions over plain JSON, so tests import this file directly and sync.js
 * applies the result.
 *
 * When both devices changed the state since the last copy they agreed on (the
 * base), neither copy is simply the newer one: the phone added a task while the
 * laptop logged a purchase. Both are kept by merging them against the base:
 *   • whatever only one side changed takes that side's value;
 *   • objects merge key by key;
 *   • lists of records with ids (tasks, lists, purchases, events, timers, …)
 *     merge record by record: added on either side is kept, deleted on one side
 *     and untouched on the other goes, changed on one side and deleted on the
 *     other stays;
 *   • a record both sides added under the same id (each device numbers new
 *     records on its own) is two records: the other side's keeps the id, this
 *     side's gets the next free one; where one side moved a record like that,
 *     a change the other side made to it meanwhile goes with it (see movesBy),
 *     and where both did, its old id is free on both (see movedBoth);
 *   • a plain value both sides changed goes to the newer edit (`preferLocal`),
 *     except an id counter, which takes the higher of the two;
 *   • any other list (a list's active days, …) is one value.
 * Budget's balance and the bank transactions it counted go together: when both
 * sides changed the balance, the counted transactions come from the same side
 * as the balance (see keepBankWithBalance).
 * Afterwards every id counter is moved past the ids in use, and a purchase that
 * both devices logged from the bank is kept once. */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCounter = key => /(Counter|Ctr)$/.test(String(key || ''));
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (isObj(v)) {
    const o = {};
    Object.keys(v).sort().forEach(k => { if (v[k] !== undefined) o[k] = sorted(v[k]); });
    return o;
  }
  return v;
}
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const isRecord = x => isObj(x) && (typeof x.id === 'number' || typeof x.id === 'string');
/* Lists of records: every item on every side has an id, and there is at least one. */
function recordLists(...lists) {
  const all = lists.filter(Array.isArray);
  return all.length === lists.filter(l => l !== undefined).length && all.some(l => l.length) && all.every(l => l.every(isRecord));
}

const content = x => JSON.stringify(sorted({ ...x, id: null }));   // a record, whatever its id
/* A record one side moved to a new id (it merged two records added under one
 * id, see mergeRecords) is there as an exact copy of the base's record under an
 * id the base doesn't have, with a different record in its old place. On the
 * other side it may still be under its old id: a tab of Focus that hasn't taken
 * in the other tab's merge yet, or a device that hadn't heard the other device's.
 * What was done to it there meanwhile (deleted, checked off, renamed) goes to its
 * new id, not to the record now in its old place: movesBy finds the moves `side`
 * made, and the base and the other side then use the new ids. Not when the other
 * side moved the same record too. A record of the other side's own under the new
 * id (added there since, so no one else has it) moves out of the way first, to
 * an id no one uses (`fresh`). */
function movesBy(base, side, other, fresh) {
  const moves = new Map(), aside = new Map();          // old id → new id; the other side's own record in the way → a free id
  if (!base.length) return { moves, aside };
  const b = new Map(base.map(x => [x.id, x]));
  const added = side.filter(x => typeof x.id === 'number' && !b.has(x.id));
  if (!added.length) return { moves, aside };
  const s = new Map(side.map(x => [x.id, x]));
  const replaced = new Map();                          // a base record's content → its id, where `side` has another record now
  base.forEach(z => {
    if (typeof z.id !== 'number' || !s.has(z.id) || same(s.get(z.id), z)) return;
    const c = content(z);
    if (!replaced.has(c)) replaced.set(c, z.id);
  });
  if (!replaced.size) return { moves, aside };
  const o = new Set(other.map(y => y.id));
  const otherNew = new Set(other.filter(y => !b.has(y.id)).map(content));
  added.forEach(x => {
    const c = content(x), from = replaced.get(c);
    if (from === undefined || moves.has(from) || otherNew.has(c)) return;
    if (o.has(x.id)) aside.set(x.id, fresh());          // (not in the base: a record only the other side has)
    moves.set(from, x.id);
  });
  return { moves, aside };
}
const renumber = (list, moves) => (moves.size ? list.map(x => (moves.has(x.id) ? { ...x, id: moves.get(x.id) } : x)) : list);
/* A record both sides moved to a new id. The copy both started from can be one
 * worked out without the records only one side has yet (sync.js → syncOnTop),
 * and so give a moved record an id each side has given to a new record of its
 * own. Both sides moved it on from there: that id is free on both, and what each
 * has under it is a record of its own, not the same one changed. So the base
 * gives the record the other side's new id (and this side's copy of it takes
 * that id too, when it is free here). */
function movedBoth(base, local, remote) {
  const moves = new Map(), localMoves = new Map();     // base: old id → new id; this side: its new id → the other's
  if (!base.length) return { moves, localMoves };
  const b = new Map(base.map(x => [x.id, x]));
  const newIn = side => {
    const m = new Map();                               // a record's content → its id, among ids the base doesn't have
    side.forEach(x => { if (typeof x.id === 'number' && !b.has(x.id)) { const c = content(x); if (!m.has(c)) m.set(c, x.id); } });
    return m;
  };
  const ln = newIn(local), rn = newIn(remote);
  if (!ln.size || !rn.size) return { moves, localMoves };
  const l = new Map(local.map(x => [x.id, x])), r = new Map(remote.map(x => [x.id, x]));
  base.forEach(z => {
    if (typeof z.id !== 'number') return;
    const c = content(z), jl = ln.get(c), jr = rn.get(c);
    if (jl === undefined || jr === undefined) return;
    if ((l.has(z.id) && same(l.get(z.id), z)) || (r.has(z.id) && same(r.get(z.id), z))) return;
    moves.set(z.id, jr);
    if (jl !== jr && !l.has(jr)) localMoves.set(jl, jr);
  });
  return { moves, localMoves };
}

function mergeRecords(base0, local0, remote0, opts) {
  let base = Array.isArray(base0) ? base0 : [], local = local0, remote = remote0;
  let free = [...base, ...local, ...remote].reduce((m, x) => (typeof x.id === 'number' && x.id > m ? x.id : m), 0);
  const fresh = () => ++free;
  const both = movedBoth(base, local, remote);         // a record both sides moved: its old id is free on both
  base = renumber(base, both.moves); local = renumber(local, both.localMoves);
  const there = movesBy(base, remote, local, fresh);   // what the other side moved, this side's changes follow …
  local = renumber(local, there.aside);
  base = renumber(base, there.moves); local = renumber(local, there.moves);
  const here = movesBy(base, local, remote, fresh);    // … and the other way round
  remote = renumber(remote, here.aside);
  base = renumber(base, here.moves); remote = renumber(remote, here.moves);
  const b = new Map(base.map(x => [x.id, x]));
  const l = new Map(local.map(x => [x.id, x]));
  const r = new Map(remote.map(x => [x.id, x]));
  let top = [...b.keys(), ...l.keys(), ...r.keys()].reduce((m, id) => (typeof id === 'number' && id > m ? id : m), 0);
  const out = [], moved = [];
  for (const x of remote) {
    const y = l.get(x.id);
    if (y !== undefined) {
      if (!b.has(x.id) && typeof x.id === 'number' && !same(x, y)) {
        /* two records added under one id: this side's moves, unless only it is in the cloud already (opts.settled) */
        if (opts.settled && opts.settled(y) && !opts.settled(x)) { out.push(y); moved.push({ ...x, id: ++top }); }
        else { out.push(x); moved.push({ ...y, id: ++top }); }
      }
      else out.push(merge(b.get(x.id), y, x, opts));
    } else if (!(b.has(x.id) && same(b.get(x.id), x))) {
      out.push(x);                                     // added there, or changed there while deleted here
    }
  }
  for (const y of local) {
    if (r.has(y.id)) continue;
    if (!(b.has(y.id) && same(b.get(y.id), y))) out.push(y);   // added here, or changed here while deleted there
  }
  return [...out, ...moved];
}

function merge(base, local, remote, opts, key) {
  if (same(local, remote)) return local;
  if (base !== undefined && same(local, base)) return remote;
  if (base !== undefined && same(remote, base)) return local;
  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(b)])) {
      const inL = k in local, inR = k in remote, inB = k in b;
      if (inL && inR) out[k] = merge(inB ? b[k] : undefined, local[k], remote[k], opts, k);
      else if (inR) { if (!(inB && same(b[k], remote[k]))) out[k] = remote[k]; }
      else if (inL) { if (!(inB && same(b[k], local[k]))) out[k] = local[k]; }
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(remote) && recordLists(base, local, remote)) return mergeRecords(base, local, remote, opts);
  if (isCounter(key) && Number.isFinite(local) && Number.isFinite(remote)) return Math.max(local, remote);
  return opts.preferLocal ? local : remote;
}

/* Each id counter hands out the next id: keep it past every id already in use. */
function settle(st) {
  const past = (counter, list) => {
    const top = list.reduce((m, x) => (x && Number.isFinite(x.id) && x.id > m ? x.id : m), -Infinity);
    return Number.isFinite(top) && !(counter > top) ? top + 1 : counter;
  };
  if (Array.isArray(st.dbdTasks)) st.dbdIdCounter = past(st.dbdIdCounter, st.dbdTasks);
  if (Array.isArray(st.todoLists)) {
    st.todoIdCounter = past(st.todoIdCounter, st.todoLists);
    st.taskIdCounter = past(st.taskIdCounter, st.todoLists.flatMap(t => (Array.isArray(t.tasks) ? t.tasks : [])));
  }
  if (isObj(st.budget) && Array.isArray(st.budget.purchases)) {
    const logged = new Set();
    st.budget.purchases = st.budget.purchases.filter(p => !p.bank || (!logged.has(p.bank) && logged.add(p.bank)));
    st.purchaseIdCounter = past(st.purchaseIdCounter, st.budget.purchases);
  }
  if (isObj(st.calendar)) {
    const events = [...Object.values(isObj(st.calendar.calEvents) ? st.calendar.calEvents : {}).flat(),
      ...(Array.isArray(st.calendar.calTemplates) ? st.calendar.calTemplates : [])];
    st.calendar.calEventIdCtr = past(st.calendar.calEventIdCtr, events);
  }
  if (isObj(st.digest) && Array.isArray(st.digest.suggestions)) st.digest.sugIdCounter = past(st.digest.sugIdCounter, st.digest.suggestions);
  return st;
}

/* When both sides changed Budget's balance (a new day rolled over on the phone
 * while the laptop logged a paycheck, say), the merged balance is one side's.
 * The bank transactions counted in it (bankBudget.items), the bank's lines
 * (bankBudget.log) and the card balances it was taken at (bankCards) must be
 * that side's too: merged key by key, the other side's paycheck would be
 * marked as counted without being in the balance, and never logged again. This
 * way whatever only the other side counted is logged on the next pass
 * (bankbudget.js), and a purchase it logged is taken as is. */
function keepBankWithBalance(out, base, local, remote, preferLocal) {
  const initial = st => (isObj(st) && isObj(st.budget) ? st.budget.initial : undefined);
  const [b, l, r] = [initial(base), initial(local), initial(remote)];
  if (same(l, r) || same(l, b) || same(r, b)) return out;
  const side = preferLocal ? local : remote;
  if (isObj(out.bankBudget) && isObj(side.bankBudget)) {
    out.bankBudget = { ...out.bankBudget, items: side.bankBudget.items, log: side.bankBudget.log };
    if ('typed' in side.bankBudget) out.bankBudget.typed = side.bankBudget.typed; else delete out.bankBudget.typed;
  }
  if (isObj(side) && 'bankCards' in side) out.bankCards = side.bankCards; else delete out.bankCards;
  return out;
}

/* The state with both devices' changes. base: the copy both last agreed on;
 * local: this device's; remote: the cloud's. preferLocal: this device's edit is
 * the newer one, for a value both changed. settled(record): whether the cloud
 * has that record already (syncRecordsIn), so that of two records added under
 * one id, the one other devices know keeps it (two tabs of Focus merging their
 * saves; between devices, the remote side is the cloud's). */
export function syncMerge(base, local, remote, { preferLocal = false, settled = null } = {}) {
  return settle(keepBankWithBalance(merge(base, local, remote, { preferLocal, settled }), base, local, remote, preferLocal));
}
/* Whether a record (an object with an id, anywhere in it) is in a state as it is. */
export function syncRecordsIn(state) {
  const set = new Set();
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) { if (isRecord(v)) set.add(JSON.stringify(sorted(v))); Object.values(v).forEach(walk); }
  };
  walk(state);
  return rec => set.has(JSON.stringify(sorted(rec)));
}
