/* A small IndexedDB for tests, enough for js/synccopies.js: open with an upgrade,
 * object stores with a keyPath, and get / getAll / put / delete in transactions.
 * Requests answer asynchronously and a transaction completes after its last
 * request, as in a browser. One instance is one browser's storage: give the same
 * one to a device that reloads, or to a second tab.
 *
 *   const idb = createFakeIndexedDB();   w.indexedDB = idb.indexedDB;   idb.dump('focus-copies', 'copies') */
function createFakeIndexedDB() {
  const dbs = new Map();                                       // name → { version, stores: Map(name → { keyPath, rows: Map }) }
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const later = fn => setTimeout(fn, 0);

  function transaction(db, names, mode) {
    const tx = { oncomplete: null, onerror: null, onabort: null, mode };
    const queue = [];
    let running = false, finished = false;
    function pump() {
      if (running) return;
      running = true;
      later(function step() {
        const job = queue.shift();
        if (job) { job(); later(step); return; }
        running = false;
        if (!finished) { finished = true; if (tx.oncomplete) tx.oncomplete({ target: tx }); }
      });
    }
    function request(run) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queue.push(() => {
        try { req.result = run(); if (req.onsuccess) req.onsuccess({ target: req }); }
        catch (e) { req.error = e; if (req.onerror) req.onerror({ target: req }); }
      });
      pump();
      return req;
    }
    tx.objectStore = name => {
      if (![].concat(names).includes(name) || !db.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
      const store = db.stores.get(name);
      const key = v => v[store.keyPath];
      const writable = () => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); };
      return {
        get: k => request(() => clone(store.rows.get(k))),
        getAll: () => request(() => [...store.rows.values()].map(clone)),
        put: v => { writable(); const c = clone(v); return request(() => { store.rows.set(key(c), c); return key(c); }); },
        delete: k => { writable(); return request(() => { store.rows.delete(k); }); },
      };
    };
    later(pump);                                               // an empty transaction completes too
    return tx;
  }

  function handle(db) {
    return {
      get objectStoreNames() { return { contains: n => db.stores.has(n), length: db.stores.size }; },
      createObjectStore(name, { keyPath } = {}) { db.stores.set(name, { keyPath, rows: new Map() }); },
      transaction: (names, mode = 'readonly') => transaction(db, names, mode),
      close() {},
    };
  }

  const indexedDB = {
    open(name, version = 1) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        let db = dbs.get(name);
        if (!db) { db = { version: 0, stores: new Map() }; dbs.set(name, db); }
        req.result = handle(db);
        if (db.version < version) {
          const oldVersion = db.version;
          db.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion, newVersion: version });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };

  return {
    indexedDB,
    dump: (name, store) => { const db = dbs.get(name); return db && db.stores.has(store) ? [...db.stores.get(store).rows.values()].map(clone) : []; },
  };
}

module.exports = { createFakeIndexedDB };
