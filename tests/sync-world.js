/* One account and its devices, for the sync tests that run over the network-like
 * fake (tests/fake-firebase-net.js): devices boot the real app in jsdom, sleep and
 * wake, reload, or share one browser's storage like two tabs. */
const { loadApp } = require('./load-app');
const { createNetFirebase } = require('./fake-firebase-net');
const { createFakeIndexedDB } = require('./fake-indexeddb');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOOKS = { 'js/sync.js': 'function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by, agreedStr) {', 'js/util.js': 'export function showToast(msg) {' };
/* the lines the tests hook into must still be there, or the tests would see nothing */
function hooked(src, file) {
  if (HOOKS[file] && !src.includes(HOOKS[file])) throw new Error(`${file} no longer has: ${HOOKS[file]}`);
  return src;
}
async function until(fn, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}

/* One browser's localStorage, kept outside any page: tabs of Focus share it,
 * and it outlives a page that is closed and opened again. */
function memoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/* One browser's lock manager (navigator.locks): a lock goes to the first tab that
 * asks, and to the next one when that tab closes. */
function createLocks() {
  const queues = new Map(), held = new Map();
  function grant(name) {
    if (held.has(name)) return;
    const q = queues.get(name) || [];
    const next = q.shift();
    if (!next) return;
    held.set(name, next.w);
    Promise.resolve().then(() => next.cb({ name, mode: 'exclusive' }));
  }
  return {
    for: w => ({
      request(name, a, b) {
        const cb = typeof a === 'function' ? a : b;
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push({ w, cb });
        grant(name);
        return new Promise(() => {});
      },
    }),
    release(w) {
      queues.forEach(q => { for (let i = q.length - 1; i >= 0; i--) if (q[i].w === w) q.splice(i, 1); });
      [...held].forEach(([name, holder]) => { if (holder === w) { held.delete(name); grant(name); } });
    },
  };
}

/* `delay` is each link's delay in ms (a function, for jitter). `transform`
 * instruments the app's modules further (source, file) → source, to debug a run. */
function world({ delay = () => 30 + Math.random() * 50, transform = src => src } = {}) {
  const net = createNetFirebase({ delay: () => delay() });
  const devices = [];
  const browserLocks = new Map();       // a browser's storage → its lock manager
  /* storage: localStorage to start with. share: another device whose browser
   * this one is a second tab of (the same localStorage and IndexedDB). idb: the
   * browser's IndexedDB (a device that reloads keeps its own). store: the
   * browser's localStorage as a memoryStorage(), for tabs that come and go. */
  async function boot(name, storage = {}, { share, idb = share ? share.idb : createFakeIndexedDB(), store = null,
    locks = share ? share.locks : store ? (browserLocks.get(store) || browserLocks.set(store, createLocks()).get(store)) : null } = {}) {
    let dev = null;
    const { w } = await loadApp({
      storage: share || store ? undefined : { 'focus-tour-done': '1', ...storage },
      before: w => {
        if (store) {
          Object.entries({ 'focus-tour-done': '1', ...storage }).forEach(([k, v]) => store.setItem(k, v));
          Object.defineProperty(w, 'localStorage', { value: store, configurable: true });
        } else if (share) Object.defineProperty(w, 'localStorage', { value: share.w.localStorage, configurable: true });
        w.indexedDB = idb.indexedDB;
        if (locks) Object.defineProperty(w.navigator, 'locks', { value: locks.for(w), configurable: true });
        w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        w.HTMLElement.prototype.scrollIntoView = function () {};
        dev = net.install(w);
        w.__applies = [];
        w.__toasts = [];
      },
      transform: (src, file) => hooked(transform(src, file), file)
        .replace('function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by, agreedStr) {',
          'function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by, agreedStr) { window.__applies.push(Date.now());')
        .replace('export function showToast(msg) {', 'export function showToast(msg) { window.__toasts.push(msg);'),
    });
    w.document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    const app = { name, w, d: w.document, dev, idb, store, locks };
    devices.push(app);
    return app;
  }
  /* the app is closed (swiped away, the tab shut): hidden, then the page goes, as
   * a browser tells it (it saves then); after that nothing runs there any more */
  function hide(app) {
    if (app.hidden) return;
    app.hidden = true;
    try {
      Object.defineProperty(app.w.document, 'visibilityState', { value: 'hidden', configurable: true });
      app.w.document.dispatchEvent(new app.w.Event('visibilitychange'));
      app.w.dispatchEvent(new app.w.Event('pagehide'));
    } catch (e) {}
  }
  function close(app) {
    hide(app);
    app.dev.sleep();
    if (app.locks) app.locks.release(app.w);
    app.w.close();
    app.closed = true;
  }
  /* closed and opened again, with what it had saved on the device; `crash`: it
   * stopped without being told (no last save) */
  async function reload(app, { signIn = true, crash = false } = {}) {
    if (!crash) hide(app);                     // (what it saves as it goes is what it opens with)
    else app.hidden = true;
    const storage = {};
    if (!app.store) for (let i = 0; i < app.w.localStorage.length; i++) { const k = app.w.localStorage.key(i); storage[k] = app.w.localStorage.getItem(k); }
    close(app);
    const next = await boot(app.name, storage, { idb: app.idb, store: app.store });
    if (signIn) next.dev.signIn();
    return next;
  }
  const fp = app => app.w.eval('syncHash(syncFingerprint(gatherState()))');
  const cloud = () => { const s = net.at('users/u1/state'); return s ? JSON.parse(s) : null; };
  /* the first device starts the account; the others open it with a copy, like devices that synced before */
  async function devicesOnline(names) {
    const first = await boot(names[0], { 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: 'x' }) });
    first.dev.signIn();
    await until(() => cloud(), 3000);
    const rest = [];
    for (const name of names.slice(1)) {
      const d = await boot(name, { 'focus-app-state': net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: fp(first) }) });
      d.dev.signIn();
      rest.push(d);
    }
    await net.idle();
    await sleep(300);
    return [first, ...rest];
  }
  /* What an older version of Focus does (before these devices stamped revisions):
   * it takes in every copy it hears, and on an edit changes its copy and writes it
   * with update(), without looking at the cloud first. It writes its own build and
   * carries fields it doesn't know (syncRev, syncBase) through untouched.
   * forget(): its copy is from before the cloud carried any of those stamps. */
  function olderVersion(name = 'older-phone') {
    const w = {};
    const dev = net.install(w);
    dev.signIn();
    const ref = w.firebase.database().ref('users/u1');
    let heard = null;
    ref.on('value', snap => { const v = snap.val(); if (v && typeof v.state === 'string') heard = v.state; });
    const mine = { done: {}, adds: [] };          // what it changed: it keeps those in memory, so every copy it writes has them
    function write() {
      const st = JSON.parse(heard);
      Object.entries(mine.done).forEach(([key, d]) => {
        const [lid, tid] = key.split(':').map(Number);
        const t = st.todoLists.find(l => l.id === lid).tasks.find(x => x.id === tid);
        if (t) t.done = d;
      });
      mine.adds.forEach(a => { if (!st.dbdTasks.some(t => t.text === a.text)) st.dbdTasks.push({ ...a }); });
      st.dbdIdCounter = Math.max(st.dbdIdCounter || 1, ...st.dbdTasks.map(t => t.id + 1));
      st.build = 7;
      heard = JSON.stringify(st);
      return ref.update({ state: heard, updatedAt: Date.now(), client: name });
    }
    return {
      name, dev,
      toggle(listId, taskId) {
        const key = `${listId}:${taskId}`;
        const now = JSON.parse(heard).todoLists.find(l => l.id === listId).tasks.find(x => x.id === taskId);
        mine.done[key] = key in mine.done ? !mine.done[key] : !(now && now.done);
        return write();
      },
      add(text, id) { mine.adds.push({ id, text, due: '2026-10-02', done: false }); return write(); },
      forget() {
        const st = JSON.parse(heard);
        Object.keys(st).filter(k => /^sync/.test(k)).forEach(k => delete st[k]);
        heard = JSON.stringify(st);
      },
      heard: () => JSON.parse(heard),
    };
  }
  return { net, boot, close, reload, devicesOnline, olderVersion, fp, cloud, devices };
}
const doneOf = st => st.todoLists.flatMap(l => l.tasks.filter(t => t.done).map(t => `${l.id}:${t.id}`)).sort().join(' ');
const stateOf = app => JSON.parse(app.w.eval('JSON.stringify(gatherState())'));
const done = app => doneOf(stateOf(app));

module.exports = { world, memoryStorage, sleep, until, doneOf, done, stateOf };
