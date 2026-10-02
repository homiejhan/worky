/* Cloud sync over a Firebase that behaves like the network one
 * (tests/fake-firebase-net.js): a delay on every link, each device with its own
 * copy, transactions that run again on stale data, devices that sleep. First the
 * situations people run into, then randomized runs where several devices (and an
 * older version of Focus) edit at random times: every edit must survive, and
 * every device must end up with the cloud's copy.
 * Run: npm test -- sync_net (or node --experimental-vm-modules tests/test_sync_net.js) */
const { loadApp } = require('./load-app');
const { createNetFirebase } = require('./fake-firebase-net');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}

/* One account, its devices. `delay` is each link's delay in ms (a function, for jitter). */
function world({ delay = () => 30 + Math.random() * 50 } = {}) {
  const net = createNetFirebase({ delay: () => delay() });
  const devices = [];
  async function boot(name, storage = {}) {
    let dev = null;
    const { w } = await loadApp({
      storage: { 'focus-tour-done': '1', ...storage },
      before: w => {
        w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        w.HTMLElement.prototype.scrollIntoView = function () {};
        dev = net.install(w);
        w.__applies = [];
        w.__toasts = [];
      },
      transform: src => src
        .replace('function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by) {',
          'function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by) { window.__applies.push(Date.now());')
        .replace('export function showToast(msg) {', 'export function showToast(msg) { window.__toasts.push(msg);'),
    });
    w.document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    const app = { name, w, d: w.document, dev };
    devices.push(app);
    return app;
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
   * carries fields it doesn't know (syncRev, syncBase) through untouched. */
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
    };
  }
  return { net, boot, devicesOnline, olderVersion, fp, cloud, devices };
}
const doneOf = st => st.todoLists.flatMap(l => l.tasks.filter(t => t.done).map(t => `${l.id}:${t.id}`)).sort().join(' ');
const done = app => doneOf(JSON.parse(app.w.eval('JSON.stringify(gatherState())')));

(async () => {
  console.log('\n── 1. Checking off tasks with another device open ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const applied = L.w.__applies.length;
    for (const tid of [0, 1, 2]) { L.w.toggleTask(0, tid); await sleep(400); }
    await sleep(2500);
    ok(done(L) === '0:0 0:1 0:2' && done(P) === '0:0 0:1 0:2' && doneOf(W.cloud()) === '0:0 0:1 0:2', 'three tasks checked on the laptop: on the phone and in the cloud');
    ok(P.w.__applies.length > 0, '(the phone took the laptop\'s copy in: these tests see each apply)');
    ok(L.w.__applies.length === applied, 'and nothing comes back to the laptop: it sent, it doesn\'t take a copy in');
    ok(!L.w.__toasts.some(t => /Synced from cloud/.test(t)), 'so no "Synced from cloud" there');
    for (const tid of [4, 5]) { P.w.toggleTask(1, tid); await sleep(300); }
    L.w.toggleTask(0, 3);
    await sleep(3000);
    ok(done(L) === '0:0 0:1 0:2 0:3 1:4 1:5' && W.fp(L) === W.fp(P), 'both check things off within a second: each keeps the other\'s');
  }

  console.log('\n── 2. An older version of Focus, offline, writes over the cloud late ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const O = W.olderVersion();
    await W.net.idle();
    O.dev.sleep();                                                         // the old phone goes into a pocket
    for (const tid of [0, 1, 2]) { L.w.toggleTask(0, tid); await sleep(400); }
    await sleep(2500);
    ok(doneOf(W.cloud()) === '0:0 0:1 0:2', 'the laptop checks off three tasks; the cloud has them');
    O.toggle(1, 6);                                                        // a change on the old phone, from its old copy
    O.dev.wake();                                                          // back online: its write lands
    await W.net.idle();
    await sleep(3000);
    ok(done(L) === '0:0 0:1 0:2 1:6', `the laptop keeps its three, and takes the old phone's change on top (${done(L)})`);
    ok(done(P) === done(L) && doneOf(W.cloud()) === done(L), 'so do the other phone and the cloud');
    ok(L.w.__toasts.some(t => /older Focus/.test(t)) && /older version of Focus/.test(L.d.getElementById('syncStatusLine').textContent),
      'and Focus says a device on an older version is syncing, in a toast and in Settings');
  }

  console.log('\n── 3. An edit while a push is on its way ──');
  {
    const W = world({ delay: () => 1500 });                                 // a slow connection: a push takes about 3 s there and back
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    L.w.toggleTask(0, 0);
    await sleep(1400);                                                     // its push is on its way
    L.w.toggleTask(0, 1);                                                  // and this one's push would start before it is back
    await until(() => doneOf(W.cloud()) === '0:0 0:1', 15000);
    ok(doneOf(W.cloud()) === '0:0 0:1', 'the second edit reaches the cloud after the first, without waiting for another edit');
    ok(await until(() => done(P) === '0:0 0:1', 8000), 'and the phone');
  }

  console.log('\n── 4. A phone that sleeps through edits on the laptop, then edits on waking ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    P.dev.sleep();
    for (const tid of [0, 1]) { L.w.toggleTask(0, tid); await sleep(500); }
    await sleep(2000);
    P.w.toggleTask(1, 4);                                                  // the phone saves before it has heard
    await sleep(1500);
    P.dev.wake();
    await W.net.idle();
    await sleep(3000);
    ok(done(L) === '0:0 0:1 1:4' && W.fp(L) === W.fp(P) && doneOf(W.cloud()) === '0:0 0:1 1:4', `both devices' checks are kept, everywhere (${done(L)})`);
  }

  console.log('\n── 5. Bank and digest deliveries landing during edits ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    for (let i = 0; i < 4; i++) {
      L.w.toggleTask(0, i);
      W.net.set('users/u1/bank/updatedAt', Date.now());
      await sleep(300);
      W.net.set('users/u1/digestInbox/at', Date.now());
    }
    await sleep(3500);
    ok(done(L) === '0:0 0:1 0:2 0:3' && done(P) === done(L) && doneOf(W.cloud()) === done(L), 'every check stays and arrives');
    ok(W.net.at('users/u1/bank/updatedAt') && W.net.at('users/u1/digestInbox/at'), 'and the pushes leave the bank and the digest inbox as they are');
  }

  console.log('\n── 6. Revision stamps ──');
  {
    const W = world();
    const [L] = await W.devicesOnline(['laptop']);
    const before = W.cloud().syncRev;
    L.w.toggleTask(0, 0);
    await until(() => W.cloud().syncRev !== before, 4000);
    const st = W.cloud();
    ok(typeof st.syncRev === 'string' && st.syncBase === before && typeof st.syncBaseHash === 'string',
      'a push names its revision, and the revision and fingerprint of the copy it was built on');
    ok(L.w.eval(`syncFingerprint(${JSON.stringify({ ...st, build: 1, syncRev: 'x', syncBase: 'y', syncBaseHash: 'z' })}) === syncFingerprint(${JSON.stringify(st)})`),
      'which build wrote a copy, and its stamps, are not content: the same copy has the same fingerprint');
  }

  console.log('\n── 7. Randomized: three devices and an older version, at random times ──');
  for (const seed of [3, 17, 29]) {
    let rnd = seed;
    const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
    const W = world({ delay: () => 20 + rand() * 120 });
    const apps = await W.devicesOnline(['laptop', 'phone', 'tablet']);
    const O = W.olderVersion();
    await W.net.idle();
    const lists = JSON.parse(apps[0].w.eval('JSON.stringify(todoLists.map(l => ({ id: l.id, tasks: l.tasks.map(t => t.id) })))'));
    /* each device checks its own list's tasks and adds its own Day by Day tasks: what each did must be there at the end */
    const who = [...apps, O].map((a, i) => ({ a, list: lists[i].id, tasks: lists[i].tasks, flips: {}, adds: [], asleep: false }));
    for (let step = 0; step < 30; step++) {
      const x = who[Math.floor(rand() * who.length)];
      const r = rand();
      if (r < 0.15) {
        x.asleep = !x.asleep;
        if (x.asleep) x.a.dev.sleep(); else x.a.dev.wake();
      } else if (r < 0.65) {
        const tid = x.tasks[Math.floor(rand() * x.tasks.length)];
        if (x.a === O) O.toggle(x.list, tid); else x.a.w.toggleTask(x.list, tid);
        x.flips[tid] = !x.flips[tid];
      } else if (r < 0.9) {
        const text = `${x.a.name} #${step}`;
        if (x.a === O) O.add(text, 5000 + step);
        else x.a.w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: ${JSON.stringify(text)}, due: dbdTodayKey(), done: false }); renderDbd(); saveToLocal();`);
        x.adds.push(text);
      } else {
        W.net.set('users/u1/bank/updatedAt', Date.now());
      }
      await sleep(Math.floor(rand() * (rand() < 0.25 ? 2500 : 700)));
    }
    who.forEach(x => { if (x.asleep) x.a.dev.wake(); });
    await W.net.idle();
    await sleep(4000);
    await W.net.idle();
    const st = W.cloud();
    const lost = [];
    for (const x of who) {
      const list = st.todoLists.find(l => l.id === x.list);
      Object.entries(x.flips).forEach(([tid, d]) => { const t = list.tasks.find(y => y.id === Number(tid)); if (!!(t && t.done) !== d) lost.push(`${x.a.name}'s check on task ${tid}`); });
      x.adds.forEach(text => { if (!st.dbdTasks.some(t => t.text === text)) lost.push(`${x.a.name}'s task "${text}"`); });
    }
    ok(!lost.length, `seed ${seed}: every check and every added task is in the cloud${lost.length ? ` — lost: ${lost.join(', ')}` : ''}`);
    const cloudFp = apps[0].w.eval(`syncHash(syncFingerprint(${JSON.stringify(st)}))`);
    ok(apps.every(a => W.fp(a) === cloudFp), `seed ${seed}: and every device has the cloud's copy`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
