/* Cloud sync over a Firebase that behaves like the network one
 * (tests/fake-firebase-net.js): a delay on every link, each device with its own
 * copy, transactions that run again on stale data, devices that sleep. First the
 * situations people run into, then randomized runs where several devices (and an
 * older version of Focus) edit at random times: every edit must survive, and
 * every device must end up with the cloud's copy.
 * Run: npm test -- sync_net (or node --experimental-vm-modules tests/test_sync_net.js) */
const { world, sleep, until, doneOf, done } = require('./sync-world');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

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
