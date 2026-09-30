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
 *     side's gets the next free one;
 *   • a plain value both sides changed goes to the newer edit (`preferLocal`),
 *     except an id counter, which takes the higher of the two;
 *   • any other list (a list's active days, …) is one value.
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

function mergeRecords(base, local, remote, opts) {
  const b = new Map((Array.isArray(base) ? base : []).map(x => [x.id, x]));
  const l = new Map(local.map(x => [x.id, x]));
  const r = new Map(remote.map(x => [x.id, x]));
  let top = [...b.keys(), ...l.keys(), ...r.keys()].reduce((m, id) => (typeof id === 'number' && id > m ? id : m), 0);
  const out = [], moved = [];
  for (const x of remote) {
    const y = l.get(x.id);
    if (y !== undefined) {
      if (!b.has(x.id) && typeof x.id === 'number' && !same(x, y)) { out.push(x); moved.push({ ...y, id: ++top }); }
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

/* The state with both devices' changes. base: the copy both last agreed on;
 * local: this device's; remote: the cloud's. preferLocal: this device's edit is
 * the newer one, for a value both changed. */
export function syncMerge(base, local, remote, { preferLocal = false } = {}) {
  return settle(merge(base, local, remote, { preferLocal }));
}
