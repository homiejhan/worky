/* synccopies.js — Copies of the whole state kept on this device, to put things back.
 *
 * A copy from another device replaces the whole state, so this device keeps:
 *   • 'agreed'  every copy it and the cloud agreed on (sync.js looks back through
 *               these to fit in a device that wrote over a copy it never saw);
 *   • 'local'   its own copy, whenever one came in that it could not merge into it;
 *   • 'older'   another device's copy that was older than what this one had, and
 *               so was not taken;
 *   • 'restore' what it had before Settings → Cloud sync → Earlier copies put an
 *               earlier one back.
 * Earlier copies lists them all. They live in IndexedDB: localStorage holds a few
 * megabytes, and the state itself needs that room (a full localStorage made saves
 * fail). The previous version kept its last 8 agreed copies in localStorage
 * (focus-sync-history); they move here on the first start, and that room is freed.
 *
 * Entry: { id, at, kind, rev, seq, hash, by, canon, summary, state }. The newest
 * ones are kept in memory with their state (copiesRecent); older ones are read
 * back when one is restored (copiesState). */
import { SYNC_HISTORY_LS_KEY } from './config.js';

const DB_NAME = 'focus-copies';
const STORE = 'copies';
const MEMORY_MAX = 40;          // newest copies kept in memory, with their state
const KEEP_RECENT = 40;         // newest copies always kept
const KEEP_MAX = 140;           // and never more than this many in all
const HOUR = 3600e3, DAY = 24 * HOUR;

let memory = [];                // newest last; older ones have state === null (it is in the database)
let index = new Map();          // id → entry, every copy kept (memory and database)
let db = null;
let started = null;
const pending = new Set();      // ids to write
let saveTimer = null;

/* When a revision was stamped (its first part is the time, base 36). */
export function revTime(rev) {
  const t = typeof rev === 'string' ? parseInt(rev.split('-')[0], 36) : NaN;
  return t > 1.5e12 && t < 4.1e12 ? t : 0;
}

/* What a copy holds, in a line: enough to tell copies apart. */
export function copySummary(stateStr) {
  try {
    const st = JSON.parse(stateStr);
    const tasks = [...(st.todoLists || []).flatMap(l => l.tasks || []), ...(st.dbdTasks || [])];
    const events = Object.values((st.calendar && st.calendar.calEvents) || {}).reduce((n, d) => n + (Array.isArray(d) ? d.length : 0), 0);
    return {
      tasks: tasks.length, done: tasks.filter(t => t && t.done).length, lists: (st.todoLists || []).length,
      purchases: ((st.budget && st.budget.purchases) || []).length, balance: st.budget ? Number(st.budget.initial) || 0 : 0,
      events,
    };
  } catch (e) { return null; }
}

function open() {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), 3000);                      // a database that never answers: memory only
    try {
      const idb = window.indexedDB;
      if (!idb) { finish(null); return; }
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch (e) { finish(null); }
  });
}
function readAll(d) {
  return new Promise(resolve => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

/* Load what was kept, and move the previous version's copies out of localStorage.
 * Resolves once copiesRecent() has them (at once where there is no database). */
export function copiesStart() {
  if (started) return started;
  started = (async () => {
    db = await open();
    const kept = db ? await readAll(db) : [];
    kept.filter(e => e && typeof e.id === 'string' && typeof e.hash === 'string')
      .sort((a, b) => a.at - b.at)
      .forEach(e => index.set(e.id, e));
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(SYNC_HISTORY_LS_KEY)) || []; } catch (e) {}
    legacy = Array.isArray(legacy) ? legacy.filter(e => e && typeof e.hash === 'string' && typeof e.state === 'string') : [];
    const now = Date.now();
    legacy.forEach((e, i) => copiesKeep({ kind: 'agreed', rev: e.rev || null, hash: e.hash, by: e.by || null, canon: !!e.canon,
      state: e.state, at: revTime(e.rev) || now - (legacy.length - i) * 1000 }, { quiet: true }));
    trimMemory();
    if (legacy.length && db && await write()) { try { localStorage.removeItem(SYNC_HISTORY_LS_KEY); } catch (e) {} }
  })();
  return started;
}

/* The newest copies, oldest first, each with its state. */
export function copiesRecent() { return memory; }

/* memory: the newest copies. The others' states are in the database (once written). */
function trimMemory() {
  const byAt = [...index.values()].sort((a, b) => a.at - b.at);
  memory = byAt.slice(-MEMORY_MAX);
  const recent = new Set(memory.map(e => e.id));
  if (db) byAt.forEach(e => { if (!recent.has(e.id) && !pending.has(e.id)) e.state = null; });
  else index = new Map(memory.map(e => [e.id, e]));       // nowhere else to keep them
}

/* Keep a copy. The same copy kept again (same kind, content and revision) moves
 * to the end; an agreed copy this version stamped itself (canon) keeps its writer. */
export function copiesKeep(e, { quiet = false } = {}) {
  const entry = { at: Date.now(), kind: 'agreed', rev: null, seq: 0, hash: '', by: null, canon: false, ...e };
  entry.id = `${entry.kind}:${entry.hash}:${entry.rev || ''}`;
  const was = index.get(entry.id);
  if (was && was.canon && !entry.canon) { entry.canon = true; entry.by = was.by; }
  if (was && was.at > entry.at) entry.at = was.at;
  if (!entry.summary) entry.summary = (was && was.summary) || copySummary(entry.state);
  index.delete(entry.id);
  index.set(entry.id, entry);
  pending.add(entry.id);
  if (!quiet) {
    trimMemory();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(copiesSave, 2000);
  }
  return entry;
}

/* Which copies stay: the newest ones, then fewer as they get older (one an hour
 * for three days, one a day for a month); the ones kept for a reason ('local',
 * 'older', 'restore') for two weeks. */
function survivors(all, now = Date.now()) {
  const byNewest = [...all].sort((a, b) => b.at - a.at);
  const keep = new Set(byNewest.slice(0, KEEP_RECENT).map(e => e.id));
  const buckets = new Set();
  for (const e of byNewest.slice(KEEP_RECENT)) {
    const age = now - e.at;
    if (e.kind !== 'agreed') { if (age < 14 * DAY) keep.add(e.id); continue; }
    const bucket = age < 3 * DAY ? 'h' + Math.floor(e.at / HOUR) : age < 30 * DAY ? 'd' + Math.floor(e.at / DAY) : null;
    if (bucket && !buckets.has(bucket)) { buckets.add(bucket); keep.add(e.id); }
  }
  return new Set(byNewest.filter(e => keep.has(e.id)).slice(0, KEEP_MAX).map(e => e.id));
}

/* Write what changed, and let go of what no longer stays. Resolves to whether it was written. */
function write() {
  if (!db) return Promise.resolve(false);
  const stay = survivors([...index.values()]);
  const gone = [...index.keys()].filter(id => !stay.has(id));
  const put = [...pending].filter(id => stay.has(id) && index.get(id) && index.get(id).state !== null);
  gone.forEach(id => { index.delete(id); pending.delete(id); });
  const rows = put.map(id => index.get(id));
  if (!rows.length && !gone.length) { trimMemory(); return Promise.resolve(true); }
  return new Promise(resolve => {
    const done = ok => {
      if (ok) rows.forEach(e => { if (index.get(e.id) === e) pending.delete(e.id); });   // (kept again meanwhile: that one is written next time)
      trimMemory();
      resolve(ok);
    };
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      rows.forEach(e => store.put(e));
      gone.forEach(id => store.delete(id));
      tx.oncomplete = () => done(true);
      tx.onerror = () => done(false);
      tx.onabort = () => done(false);
    } catch (e) { done(false); }
  });
}
export function copiesSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (started) started.then(write);
}

/* Every copy kept, newest first, without their state (for the list). */
export async function copiesList() {
  if (started) await started;
  return [...index.values()].sort((a, b) => b.at - a.at).map(({ state, ...e }) => e);
}
/* A kept copy's state, from memory or the database. */
export async function copiesState(id) {
  const e = index.get(id);
  if (!e) return null;
  if (typeof e.state === 'string') return e.state;
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result && typeof req.result.state === 'string' ? req.result.state : null);
      req.onerror = () => resolve(null);
    } catch (err) { resolve(null); }
  });
}
