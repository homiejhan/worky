/* A stand-in for the Firebase the app loads (the compat SDK's firebase.auth() and
 * firebase.database()), for tests. One Realtime Database is shared by every
 * simulated device that install()s it, like one Firebase project: a write from
 * one device reaches the other devices' listeners, asynchronously like the real
 * thing (the writer's own copy changes at once).
 *
 *   const { cloud, install } = createFakeFirebase();
 *   const dev = install(w);      // in loadApp's `before`: sets w.firebase
 *   dev.signIn();                // as { uid: 'u1', email: 'me@example.com' }; dev.signIn({ uid, getIdToken })
 *   cloud.val                    // users/u1, the account's node (assignable)
 *   cloud.at('users/u1/bank')    // any node
 *
 * Writes keep what the database keeps: set() replaces a node (null deletes it),
 * update() replaces only the children it names (a name may be a path),
 * remove() deletes, nulls and empty objects or arrays are not stored (an empty
 * array comes back missing), and undefined is refused like the SDK refuses it. */

function createFakeFirebase({ uid = 'u1', email = 'me@example.com' } = {}) {
  let root = null;
  const split = path => String(path || '').split('/').filter(Boolean);
  const get = parts => {
    let n = root;
    for (const k of parts) { if (!n || typeof n !== 'object') return null; n = n[k]; }
    return n === undefined ? null : n;
  };
  const snapshot = parts => ({ val: () => { const v = get(parts); return v === null ? null : JSON.parse(JSON.stringify(v)); } });
  const overlaps = (a, b) => a.slice(0, b.length).join('/') === b.slice(0, a.length).join('/');

  function stored(v, where) {
    if (v === undefined) throw new Error(`Firebase: first argument contains undefined in property '${where}'`);
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      const a = v.map((x, i) => stored(x, `${where}.${i}`));
      return a.some(x => x !== null) ? a : null;
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) { const s = stored(x, `${where}.${k}`); if (s !== null) o[k] = s; }
    return Object.keys(o).length ? o : null;
  }
  function put(parts, v) {
    const value = stored(v, parts.join('/'));
    if (!parts.length) { root = value; return; }
    if (value === null) {
      const trail = [];
      let n = root;
      for (const k of parts.slice(0, -1)) { if (!n || typeof n !== 'object') return; trail.push([n, k]); n = n[k]; }
      if (!n || typeof n !== 'object') return;
      delete n[parts[parts.length - 1]];
      for (let i = trail.length - 1; i >= 0 && !Object.keys(n).length; i--) { const [p, k] = trail[i]; delete p[k]; n = p; }
      if (root && !Object.keys(root).length) root = null;
      return;
    }
    if (!root || typeof root !== 'object') root = {};
    let n = root;
    for (const k of parts.slice(0, -1)) { if (!n[k] || typeof n[k] !== 'object') n[k] = {}; n = n[k]; }
    n[parts[parts.length - 1]] = value;
  }

  const cloud = {
    listeners: [],     // { device, path, cb }: every device's 'value' listeners
    writes: 0,
    hooks: [],         // fn() run when an update() lands, before listeners hear of it ("other" writers react first)
    get val() { return get(['users', uid]); },
    set val(v) { put(['users', uid], v); },
    at: path => get(split(path)),
    /* Every listener hears the current value: now, or each on its own turn (later). */
    emit(later) {
      cloud.listeners.slice().forEach(l => {
        const hear = () => { if (cloud.listeners.includes(l)) l.cb(snapshot(l.path)); };
        if (later) setTimeout(hear, 0); else hear();
      });
    },
    reset() { root = null; cloud.listeners.length = 0; cloud.hooks.length = 0; },
  };

  /* A write lands on the "server" 5 ms later; then listeners on overlapping paths hear of it. */
  function write(parts, apply, isUpdate) {
    apply();
    cloud.writes++;
    return new Promise(res => setTimeout(() => {
      res();
      if (isUpdate) cloud.hooks.forEach(h => h());
      cloud.listeners.filter(l => overlaps(l.path, parts)).forEach(l =>
        setTimeout(() => { if (cloud.listeners.includes(l)) l.cb(snapshot(l.path)); }, 0));
    }, 5));
  }

  function install(w) {
    const device = {};
    let authCb = null;
    const ref = parts => ({
      on(ev, cb) {
        const l = { device, path: parts, cb };
        cloud.listeners.push(l);
        setTimeout(() => { if (cloud.listeners.includes(l)) cb(snapshot(parts)); }, 0);
        return cb;
      },
      off() {
        for (let i = cloud.listeners.length - 1; i >= 0; i--) {
          const l = cloud.listeners[i];
          if (l.device === device && l.path.join('/') === parts.join('/')) cloud.listeners.splice(i, 1);
        }
      },
      child: p => ref([...parts, ...split(p)]),
      set: v => write(parts, () => put(parts, v)),
      remove: () => write(parts, () => put(parts, null)),
      update: payload => write(parts, () => {
        Object.keys(payload).forEach(k => stored(payload[k], k));   // refuse the whole update, like the SDK
        Object.entries(payload).forEach(([k, v]) => put([...parts, ...split(k)], v));
      }, true),
    });
    const auth = {
      onAuthStateChanged(cb) { authCb = cb; },
      signOut() { device.user = null; setTimeout(() => authCb && authCb(null), 0); return Promise.resolve(); },
      get currentUser() { return device.user || null; },
    };
    w.firebase = {
      initializeApp() {},
      auth: Object.assign(() => auth, { GoogleAuthProvider: { credential: () => ({}) } }),
      database: () => ({ ref: path => ref(split(path)) }),
    };
    return Object.assign(device, {
      user: null,
      /* The sign-in the app would restore or make: fields override the default account. */
      signIn(fields = {}) {
        device.user = { uid, email, getIdToken: async () => 'fake-id-token', ...fields };
        if (authCb) authCb(device.user);
        return device.user;
      },
      signOut() { device.user = null; if (authCb) authCb(null); },
    });
  }

  return { cloud, install };
}

module.exports = { createFakeFirebase };
