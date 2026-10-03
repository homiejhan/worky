/* A stand-in for Firebase's Realtime Database that behaves like the network one,
 * for sync tests that need its timing (tests/fake-firebase.js is the simple,
 * instant one). One "server" holds the data; each device that install()s it is a
 * client with its own copy, reached over a link with a delay:
 *
 *   • A device's own set() / update() / remove() shows in its copy at once and
 *     reaches the server one delay later; the server then sends its new data to
 *     every device listening (the writer too), then acknowledges the write.
 *   • transaction(fn): fn first gets the device's copy, as in the SDK (it can be
 *     out of date). The server applies the result only if its data still is what
 *     that copy was; otherwise it sends its data and says "datastale", and fn
 *     runs again on the new copy (25 tries). Returning undefined aborts. Its
 *     result shows in the device's copy only once the server has it (the app
 *     passes applyLocally = false). A set()/update() on the same node from that
 *     device meanwhile aborts it with Error('set'), as the SDK does.
 *   • Messages on a link keep their order. A device can sleep (sleep()/wake()):
 *     nothing reaches it or leaves it until it wakes, like a phone in the
 *     background.
 *
 *   const net = createNetFirebase({ uid, delay: () => ms });
 *   const dev = net.install(window);   dev.signIn(); dev.sleep(); dev.wake();
 *   net.at('users/u1')   the server's data;   net.idle()  resolves when nothing is in flight */

function createNetFirebase({ uid = 'u1', email = 'me@example.com', delay = () => 40 } = {}) {
  let server = null;
  const devices = [];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const split = p => String(p || '').split('/').filter(Boolean);
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]));
    return v;
  }
  function get(root, parts) {
    let n = root;
    for (const k of parts) { if (!n || typeof n !== 'object') return null; n = n[k]; }
    return n === undefined ? null : n;
  }
  /* what the database keeps: no nulls, no empty objects or arrays */
  function stored(v) {
    if (v === undefined) throw new Error('Firebase: first argument contains undefined');
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) { const a = v.map(stored); return a.some(x => x !== null) ? a : null; }
    const o = {};
    for (const [k, x] of Object.entries(v)) { const s = stored(x); if (s !== null) o[k] = s; }
    return Object.keys(o).length ? o : null;
  }
  function put(root, parts, v) {
    const value = stored(clone(v));
    if (!parts.length) return value;
    const out = root && typeof root === 'object' ? clone(root) : {};
    let n = out;
    for (const k of parts.slice(0, -1)) { if (!n[k] || typeof n[k] !== 'object') n[k] = {}; n = n[k]; }
    if (value === null) delete n[parts[parts.length - 1]]; else n[parts[parts.length - 1]] = value;
    return stored(out);
  }
  const overlaps = (a, b) => a.slice(0, b.length).join('/') === b.slice(0, a.length).join('/');
  let inFlight = 0;
  /* One direction of a link: each message arrives one delay after it was sent and
   * never ahead of one sent before it, each in its own turn of the event loop, as
   * over a socket. (A timer per message isn't enough: under load Node can fire a
   * later timer first.) */
  function lane() {
    const queue = [];
    let last = 0, timer = null;
    function arm() {
      if (timer || !queue.length) return;
      timer = setTimeout(() => {
        timer = null;
        try { if (queue[0].at <= Date.now()) { const m = queue.shift(); inFlight--; m.fn(); } } finally { arm(); }
      }, Math.max(0, queue[0].at - Date.now()));
    }
    return fn => {
      const at = Math.max(Date.now() + delay(), last + 1);
      last = at;
      inFlight++;
      queue.push({ at, fn });
      arm();
    };
  }

  /* the server */
  function serverReceive(dev, msg) {
    if (msg.kind === 'tx') {
      if (!same(get(server, msg.parts), msg.expected)) {
        dev.deliver({ kind: 'data', root: clone(server) });
        dev.deliver({ kind: 'ack', id: msg.id, status: 'datastale' });
        return;
      }
      server = put(server, msg.parts, msg.value);
    } else {
      for (const [parts, v] of msg.writes) server = put(server, parts, v);
    }
    devices.forEach(d => d.deliver({ kind: 'data', root: clone(server) }));
    dev.deliver({ kind: 'ack', id: msg.id, status: 'ok' });
  }

  function install(w) {
    const dev = { user: null, asleep: false, cache: null, has: false, pending: [], listeners: [], toServer: [], toDevice: [] };
    const up = lane(), down = lane();
    devices.push(dev);
    let authCb = null, writeId = 0;
    /* the device's view: the server data it has, with its own visible writes on top */
    const view = (skipId, hidden = false) => {
      let root = dev.cache;
      for (const p of dev.pending) {
        if (p.id === skipId || (!p.visible && !hidden) || p.aborted) continue;
        for (const [parts, v] of p.writes) root = put(root, parts, v);
      }
      return root;
    };
    const emit = () => dev.listeners.forEach(l => {
      if (!dev.has && !dev.pending.length) return;
      const v = get(view(), l.parts);
      if (l.heard && same(l.last, v)) return;
      l.heard = true; l.last = clone(v);
      l.cb({ val: () => clone(v) });
    });
    /* links: in order, one delay each way, held while asleep */
    dev.send = msg => {
      dev.toServer.push(msg);
      if (!dev.asleep) flushOut();
    };
    function flushOut() {
      while (dev.toServer.length) {
        const msg = dev.toServer.shift();
        up(() => serverReceive(dev, msg));
      }
    }
    dev.deliver = msg => down(() => { dev.toDevice.push(msg); if (!dev.asleep) flushIn(); });
    function flushIn() {
      while (dev.toDevice.length) receive(dev.toDevice.shift());
    }
    function receive(msg) {
      if (msg.kind === 'data') {
        dev.cache = msg.root; dev.has = true;
        dev.pending.filter(p => p.tx && p.waiting).forEach(p => { p.waiting = false; rerun(p); });   // the SDK reruns before it raises events
        emit();
      } else if (msg.kind === 'ack') {
        const p = dev.pending.find(x => x.id === msg.id);
        if (!p) return;
        if (msg.status === 'ok') {
          dev.pending.splice(dev.pending.indexOf(p), 1);
          emit();
          if (p.tx) p.resolve({ committed: true, snapshot: { val: () => clone(get(dev.cache, p.parts)) } });
          else p.resolve();
        } else if (p.needsAbort) {
          dev.pending.splice(dev.pending.indexOf(p), 1);
          p.reject(new Error('set'));
        } else {
          p.waiting = true;                                                   // run again once the data arrives
          if (dev.has) { p.waiting = false; rerun(p); }
        }
      }
    }
    function rerun(p) {
      if (++p.tries > 25) { dev.pending.splice(dev.pending.indexOf(p), 1); p.reject(new Error('maxretry')); return; }
      const next = p.fn(clone(get(view(p.id, true), p.parts)));
      if (next === undefined) {
        dev.pending.splice(dev.pending.indexOf(p), 1);
        p.resolve({ committed: false, snapshot: { val: () => clone(get(dev.cache, p.parts)) } });
        return;
      }
      p.writes = [[p.parts, next]];
      dev.send({ kind: 'tx', id: p.id, parts: p.parts, value: next, expected: clone(get(view(p.id, true), p.parts)) });
    }
    /* a set() or update() on a node with an unfinished transaction above or below it aborts that transaction */
    function abortTx(parts) {
      dev.pending.filter(p => p.tx && overlaps(p.parts, parts)).forEach(p => { p.needsAbort = true; });
    }
    function write(parts, writes) {
      abortTx(parts);
      return new Promise((resolve, reject) => {
        const p = { id: ++writeId, parts, writes, visible: true, resolve, reject };
        dev.pending.push(p);
        emit();
        dev.send({ kind: 'w', id: p.id, writes });
      });
    }
    const ref = parts => ({
      on(ev, cb) {
        dev.listeners.push({ parts, cb, heard: false });
        if (dev.has) setTimeout(emit, 0);
        else dev.deliver({ kind: 'data', root: clone(server) });              // the first answer to a listen
        return cb;
      },
      off() { dev.listeners = dev.listeners.filter(l => l.parts.join('/') !== parts.join('/')); },
      child: p => ref([...parts, ...split(p)]),
      set: v => { stored(clone(v)); return write(parts, [[parts, v]]); },
      remove: () => write(parts, [[parts, null]]),
      update: payload => {
        Object.values(payload).forEach(v => stored(clone(v)));
        return write(parts, Object.entries(payload).map(([k, v]) => [[...parts, ...split(k)], v]));
      },
      transaction(fn, onComplete, applyLocally = true) {
        return new Promise((resolve, reject) => {
          const p = { id: ++writeId, tx: true, parts, fn, tries: 0, visible: applyLocally !== false, resolve, reject, writes: [] };
          const first = fn(clone(get(view(undefined, true), parts)));
          if (first === undefined) { setTimeout(() => resolve({ committed: false, snapshot: { val: () => clone(get(dev.cache, parts)) } }), 0); return; }
          p.tries = 1;
          p.writes = [[parts, first]];
          dev.pending.push(p);
          if (p.visible) emit();
          dev.send({ kind: 'tx', id: p.id, parts, value: first, expected: clone(get(view(p.id, true), parts)) });
        }).then(r => { if (onComplete) onComplete(null, r.committed, r.snapshot); return r; },
          e => { if (onComplete) onComplete(e, false, null); throw e; });
      },
    });
    const auth = {
      onAuthStateChanged(cb) { authCb = cb; },
      signOut() { dev.user = null; setTimeout(() => authCb && authCb(null), 0); return Promise.resolve(); },
      get currentUser() { return dev.user || null; },
    };
    w.firebase = {
      initializeApp() {},
      auth: Object.assign(() => auth, { GoogleAuthProvider: { credential: () => ({}) } }),
      database: () => ({ ref: path => ref(split(path)) }),
    };
    return Object.assign(dev, {
      signIn(fields = {}) {
        dev.user = { uid, email, getIdToken: async () => 'fake-id-token', ...fields };
        if (authCb) authCb(dev.user);
        return dev.user;
      },
      /* in the background: nothing in or out until it wakes */
      sleep() { dev.asleep = true; },
      wake() { dev.asleep = false; flushOut(); flushIn(); },
    });
  }

  return {
    install,
    at: path => clone(get(server, split(path))),
    set: (path, v) => { server = put(server, split(path), v); devices.forEach(d => d.deliver({ kind: 'data', root: clone(server) })); },
    idle: async (quiet = 300) => {
      for (;;) {
        const before = inFlight;
        await new Promise(r => setTimeout(r, quiet));
        if (!inFlight && !before) return;
      }
    },
  };
}

module.exports = { createNetFirebase };
