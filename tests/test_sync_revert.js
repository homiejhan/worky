/* Whole-state reverts: a copy of the state from before what the other devices
 * did must never take the place of their changes, on any device or in the
 * cloud. Each section is a way an older copy used to get there: a device that
 * slept through a day of edits, an older version of Focus, a device whose
 * storage is full, a second tab of Focus in the same browser, Formats left open.
 * Run: npm test -- sync_revert (or node --experimental-vm-modules tests/test_sync_revert.js) */
const { world, memoryStorage, sleep, until, doneOf, done, stateOf } = require('./sync-world');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const dbdTexts = app => stateOf(app).dbdTasks.map(t => t.text);
const cloudTexts = W => W.cloud().dbdTasks.map(t => t.text);
const addDbd = (app, text) => app.w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: ${JSON.stringify(text)}, due: dbdTodayKey(), done: false }); renderDbd(); saveToLocal();`);
const has = (texts, want) => want.every(t => texts.includes(t));
const used = w => { let n = 0; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); n += k.length + w.localStorage.getItem(k).length; } return n; };

(async () => {
  console.log('\n── 1. An older version of Focus, holding a copy from before revisions, writes it late ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const O = W.olderVersion();
    await W.net.idle();
    O.forget();                                                            // what it holds predates the stamps on the cloud's copy
    O.dev.sleep();                                                         // into a drawer
    for (const tid of [0, 1, 2, 3]) { L.w.toggleTask(0, tid); await sleep(400); }
    addDbd(P, 'added on the phone today');
    ok(await until(() => doneOf(W.cloud()) === '0:0 0:1 0:2 0:3' && cloudTexts(W).includes('added on the phone today'), 8000), 'a day of changes reaches the cloud');
    O.toggle(1, 6);                                                        // taken out again: a change to its old copy, written over the cloud's
    O.dev.wake();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    const want = d => /0:0 0:1 0:2 0:3/.test(done(d)) && dbdTexts(d).includes('added on the phone today');
    ok(want(L) && want(P), `the laptop and the phone keep the day's changes (laptop: ${done(L)})`);
    ok(/0:0 0:1 0:2 0:3/.test(doneOf(W.cloud())) && cloudTexts(W).includes('added on the phone today'), 'and so does the cloud');
    ok(L.w.__toasts.some(t => /older Focus/.test(t)), 'and Focus says a device on an older version is syncing');
    ok((await L.w.copiesList()).some(e => e.kind === 'older') || (await P.w.copiesList()).some(e => e.kind === 'older'),
      'the older copy is kept, under Earlier copies');
  }

  console.log('\n── 2. A device shut overnight, without the copy it last agreed on, wakes after a day of edits elsewhere ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    L.dev.sleep();                                                         // the laptop, shut
    const day = [];
    for (let i = 0; i < 10; i++) { day.push(`phone task ${i}`); addDbd(P, day[i]); await sleep(1400); }
    const P2 = await W.reload(P);                                          // the phone app restarts, as phones do
    await W.net.idle(); await sleep(500);
    ok(has(dbdTexts(P2), day) && has(cloudTexts(W), day), 'the phone and the cloud have the day\'s ten tasks');
    L.w.localStorage.removeItem('focus-sync-base');                        // the laptop lost its copy of the last agreed state (storage was full)
    L.w.eval('budget.daily = (budget.daily || 0) + 1; saveToLocal();');     // and changes something as it wakes
    L.dev.wake();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(has(dbdTexts(P2), day), `the phone keeps them (${dbdTexts(P2).filter(t => /phone task/.test(t)).length}/10)`);
    ok(has(dbdTexts(L), day) && has(cloudTexts(W), day), 'the laptop takes them in, and the cloud keeps them');
    ok(L.w.eval('budget.daily') === P2.w.eval('budget.daily') && W.fp(L) === W.fp(P2), 'with the laptop\'s change too: the two agree');
  }

  console.log('\n── 3. A device whose storage is full ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const S = P.w.localStorage.getItem('focus-app-state').length;
    /* an uploaded background takes most of the phone's storage */
    P.w.localStorage.setItem('focus-theme-bg', 'data:image/jpeg;base64,' + 'A'.repeat(5000000 - used(P.w) - 4 * S));
    for (const tid of [4, 5, 6]) { P.w.toggleTask(1, tid); await sleep(1400); }
    await sleep(3500);                                                     // (the device keeps what it agreed on)
    addDbd(P, 'a long note: ' + 'x'.repeat(2 * S));                        // the state grows (a long note, a digest arriving)
    await sleep(500);
    P.w.toggleTask(0, 0);
    await sleep(3000);
    const note = d => dbdTexts(d).some(t => t.startsWith('a long note'));
    ok(note(L) && /0:0/.test(done(L)) && /1:4 1:5 1:6/.test(done(L)), `what the phone does reaches the laptop (${done(L)})`);
    ok(!P.w.__toasts.some(t => /storage/i.test(t)), 'the copies Focus keeps don\'t fill the storage: what the phone does still saves there');
    P.w.localStorage.removeItem('focus-sync-base');
    P.w.localStorage.setItem('focus-theme-bg', P.w.localStorage.getItem('focus-theme-bg') + 'A'.repeat(5000000 - used(P.w) - 10));
    addDbd(P, 'saved with the storage full');
    await sleep(2500);
    ok(P.w.__toasts.some(t => /storage on this device is full/i.test(t)), 'filled up by something else: Focus says so');
    ok(dbdTexts(L).includes('saved with the storage full'), 'and the change still reaches the laptop');
    const P2 = await W.reload(P);
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(note(P2) && /0:0/.test(done(P2)), 'the phone, restarted, still has it');
    ok(note(L) && /0:0/.test(done(L)) && note({ w: { eval: () => JSON.stringify(W.cloud()) } }), 'and so do the laptop and the cloud');
  }

  console.log('\n── 4. Two tabs of Focus in one browser ──');
  {
    const W = world();
    const [T1, P] = await W.devicesOnline(['tab', 'phone']);
    const T2 = await W.boot('other tab', {}, { share: T1 });
    T2.dev.signIn();
    await W.net.idle(); await sleep(500);
    T2.dev.sleep();                                                        // the other tab lost its connection (a background tab)
    for (const tid of [0, 1, 2]) { T1.w.toggleTask(0, tid); await sleep(1400); }
    addDbd(P, 'from the phone');
    await sleep(2500);
    ok(doneOf(W.cloud()) === '0:0 0:1 0:2' && cloudTexts(W).includes('from the phone'), 'the tab and the phone save their changes');
    W.close(T1);                                                           // the tab with the day's work is closed
    await sleep(2500);                                                     // the other tab saves what it has, as it does every 2 s
    const T3 = await W.boot('tab again', {}, { share: T2 });               // and Focus is opened again
    T3.dev.signIn();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(done(T3) === '0:0 0:1 0:2' && dbdTexts(T3).includes('from the phone'), `the tab opened again has the changes (${done(T3)})`);
    ok(doneOf(W.cloud()) === '0:0 0:1 0:2' && cloudTexts(W).includes('from the phone') && done(P) === '0:0 0:1 0:2', 'so do the cloud and the phone');
  }

  console.log('\n── 5. Formats left open on one device while another edits ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    L.w.toggleFormatMode();                                                // Formats opened on the laptop, and left open
    for (const tid of [0, 1, 2]) { P.w.toggleTask(0, tid); await sleep(400); }
    addDbd(P, 'added while the laptop was in Formats');
    await sleep(2500);
    L.w.eval("timers[0].label = 'Deep work'");
    L.w.toggleFormatMode();                                                // Done
    await W.net.idle(); await sleep(3000); await W.net.idle();
    const want = d => done(d) === '0:0 0:1 0:2' && dbdTexts(d).includes('added while the laptop was in Formats');
    ok(want(P) && want(L), `the phone's changes stay, on both (${done(L)})`);
    ok([L, P].every(d => d.w.eval('TIMER_DEFAULTS[0].label') === 'Deep work') && W.cloud().timerDefaults[0].label === 'Deep work',
      'and the format saved on the laptop reaches everything');
  }

  console.log('\n── 6. Getting a day back: copies from the previous version, restored ──');
  {
    /* What the account looked like after the revert: the day's work was on the
     * devices' kept copies (the previous version kept its last 8 in localStorage),
     * and yesterday's copy was in the cloud and on every device. */
    const W = world();
    const [L, Q] = await W.devicesOnline(['laptop', 'tablet']);
    const yesterday = W.net.at('users/u1/state');
    for (const tid of [0, 1, 2, 3]) { L.w.toggleTask(0, tid); await sleep(300); }
    addDbd(L, 'the day\'s work');
    await sleep(2500);
    const today = W.net.at('users/u1/state');
    ok(/0:0 0:1 0:2 0:3/.test(doneOf(JSON.parse(today))) && today.includes('the day\'s work'), 'a day of changes in the cloud');
    const hash = str => L.w.eval(`syncHash(syncFingerprint(${str}))`);
    const legacy = [yesterday, today].map((st, i) => ({ rev: JSON.parse(st).syncRev, hash: hash(st), canon: true, by: 'c-old' + i, state: st }));
    W.close(L);
    const old8 = JSON.stringify({ ...JSON.parse(yesterday), build: 8, syncRev: Date.now().toString(36) + '-oldone' });
    W.net.set('users/u1', { state: old8, updatedAt: Date.now(), client: 'c-older' });    // the revert
    await W.net.idle(); await sleep(2500);
    W.close(Q);
    const P = await W.boot('phone', {
      'focus-app-state': old8,
      'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: hash(old8), knownRev: JSON.parse(old8).syncRev }),
      'focus-sync-base': JSON.stringify({ hash: hash(old8), state: old8 }),
      'focus-sync-history': JSON.stringify(legacy),
    });
    P.dev.signIn();
    await W.net.idle(); await sleep(800);
    ok(!/0:0/.test(done(P)) && !dbdTexts(P).includes('the day\'s work'), 'the phone opens on yesterday\'s copy, like the cloud');
    ok(P.w.localStorage.getItem('focus-sync-history') === null, 'the copies the previous version kept move out of localStorage');
    await P.w.syncCopiesOpen();
    const rows = [...P.d.querySelectorAll('#syncCopiesList .sync-copy-row')];
    const dayRow = rows.find(r => /\(4 done\)/.test(r.textContent));
    ok(P.d.getElementById('syncCopiesModal').classList.contains('show') && rows.length >= 2 && !!dayRow,
      `Settings → Cloud sync → Earlier copies lists them, the day's among them (${rows.map(r => r.querySelector('.sync-copy-what').textContent).join(' | ')})`);
    ok(/^Today, /.test(dayRow.querySelector('.sync-copy-when').textContent), `with when it was (${dayRow.querySelector('.sync-copy-when').textContent})`);
    const T = await W.boot('tablet again', { 'focus-app-state': old8, 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: hash(old8) }) });
    T.dev.signIn();
    await W.net.idle(); await sleep(500);
    dayRow.querySelector('.sync-copy-restore').click();
    await sleep(300);
    ok(/0:0 0:1 0:2 0:3/.test(done(P)) && dbdTexts(P).includes('the day\'s work'), 'Restore puts the day back on the phone');
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(/0:0 0:1 0:2 0:3/.test(doneOf(W.cloud())) && cloudTexts(W).includes('the day\'s work'), 'and in the cloud');
    ok(/0:0 0:1 0:2 0:3/.test(done(T)) && dbdTexts(T).includes('the day\'s work'), 'and on the other device');
    const P2 = await W.reload(P);
    await W.net.idle(); await sleep(800);
    const kept = await P2.w.copiesList();
    ok(kept.some(e => e.kind === 'restore') && kept.filter(e => e.kind === 'agreed').length >= 3,
      `after a restart the copies are still there, with the one from before the restore (${kept.map(e => e.kind).join(', ')})`);
    ok(/0:0 0:1 0:2 0:3/.test(done(P2)) && W.fp(P2) === W.fp(T), 'and the phone still has the day, like the tablet');
  }

  console.log('\n── 7. Kept copies: where they are, how many ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    for (let i = 0; i < 6; i++) { addDbd(L, `task ${i}`); await sleep(1400); }
    await sleep(2500);
    const rows = W.devices[0].idb.dump('focus-copies', 'copies');
    ok(rows.filter(r => r.kind === 'agreed').length >= 6, `each copy the laptop agreed on is kept in IndexedDB (${rows.length})`);
    ok(!Object.keys(L.w.localStorage).some(k => /history/.test(k)) && L.w.localStorage.length <= 12, 'not in localStorage');
    ok(P.w.copiesRecent().length >= 6, 'the phone keeps the copies it took in too');
    /* a long time of edits: the newest are kept in full, older ones thinned out */
    const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'agreed', rev: null, hash: 'h' + i, state: '{}', at: Date.now() - (200 - i) * 20 * 60e3 }));
    many.forEach(e => L.w.copiesKeep(e, { quiet: true }));
    L.w.copiesSave();
    await sleep(500);
    const after = W.devices[0].idb.dump('focus-copies', 'copies');
    ok(after.length <= 220 && after.length > 60, `200 more copies: ${after.length} stay (the newest 40, then the first and last of each hour, then of each day)`);
    ok(L.w.copiesRecent().length <= 40 && L.w.copiesRecent().every(e => typeof e.state === 'string'), 'and only the newest stay in memory');
  }

  console.log('\n── 8. A push that arrived without the device hearing back ──');
  for (const restart of [false, true]) {
    /* the laptop checks a task; its push reaches the cloud, but it goes offline before the answer comes back */
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    L.w.toggleTask(0, 0);
    await until(() => L.w.eval('syncPushing'), 3000);
    L.dev.sleep();
    ok(await until(() => doneOf(W.cloud()) === '0:0', 3000), `${restart ? 'restart' : 'same session'}: the check reached the cloud without the laptop hearing back`);
    await until(() => done(P) === '0:0', 3000);
    addDbd(P, 'the phone builds on it');                                   // the cloud moves on from the laptop's push
    await until(() => cloudTexts(W).includes('the phone builds on it'), 4000);
    L.w.toggleTask(0, 0);                                                  // offline, the laptop unchecks it again
    await sleep(300);
    const L2 = restart ? await W.reload(L) : L;
    if (!restart) L.dev.wake();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(done(L2) === '' && doneOf(W.cloud()) === '' && done(P) === '', `the uncheck made after it stays, everywhere (laptop ${done(L2) || 'none'}, cloud ${doneOf(W.cloud()) || 'none'})`);
    ok(dbdTexts(L2).includes('the phone builds on it') && W.fp(L2) === W.fp(P), 'with the phone\'s change, and the two agree');
  }

  console.log('\n── 9. Two tabs: one changes things offline, the other keeps saving ──');
  {
    const W = world();
    const [, P] = await W.devicesOnline(['first', 'phone']);
    const store = memoryStorage();
    const T1 = await W.boot('tab', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
    const T2 = await W.boot('other tab', {}, { store, idb: T1.idb });
    T1.dev.signIn(); T2.dev.signIn();
    await W.net.idle(); await sleep(500);
    ok(T1.w.eval('syncLeader') && !T2.w.eval('syncLeader') && /through the other tab/.test(T2.d.getElementById('syncStatusLine').textContent),
      'one tab syncs with the cloud, the other through it (and says so in Settings)');
    T1.dev.sleep();                                                        // the tab's connection drops
    T1.w.toggleTask(0, 1);
    addDbd(T1, 'added in the tab offline');
    await sleep(2500);                                                     // the other tab saves, as it does every 2 s
    ok(dbdTexts(T2).includes('added in the tab offline'), 'the other tab takes in what the tab saved, instead of saving over it');
    const T3 = await W.reload(T1);                                         // the tab is closed and opened again, online
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(/0:1/.test(done(T3)) && dbdTexts(T3).includes('added in the tab offline'), `the tab opened again has its offline changes (${done(T3)})`);
    ok(/0:1/.test(doneOf(W.cloud())) && cloudTexts(W).includes('added in the tab offline') && dbdTexts(P).includes('added in the tab offline'),
      'and so do the cloud and the phone');
    ok(T2.w.eval('syncLeader') && !T3.w.eval('syncLeader'), 'the other tab took over syncing when the first one closed');
  }

  console.log('\n── 10. An older copy whose starting point is only in this device\'s database ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const O = W.olderVersion();
    await until(() => O.heard(), 3000);
    O.dev.sleep();                                                         // the older phone, in a drawer, while the laptop gets a lot done
    const day = [];
    for (let i = 0; i < 45; i++) {
      day.push(`laptop task ${i}`);
      addDbd(L, day[i]);
      L.w.eval('syncPushNow()');
      await until(() => !L.w.eval('syncPushing'), 3000);
    }
    await sleep(2500);                                                     // (the copies are written to the database)
    const heardRev = O.heard().syncRev;
    ok(!L.w.copiesRecent().some(e => e.rev === heardRev) && L.w.copiesIndex().some(e => e.rev === heardRev),
      'the copy the older phone last took in is no longer in the laptop\'s memory, only in its database');
    O.toggle(1, 6);
    O.dev.wake();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(has(dbdTexts(L), day) && has(cloudTexts(W), day) && has(dbdTexts(P), day), 'the laptop\'s 45 changes stay, everywhere');
    ok(/1:6/.test(done(L)) && /1:6/.test(doneOf(W.cloud())), `and the older phone's change is taken in on top (${done(L)})`);
  }

  console.log('\n── 11. An older version checks a task, unchecks it (back to the cloud\'s copy), and checks it again ──');
  {
    const W = world();
    const [L] = await W.devicesOnline(['laptop']);
    const O = W.olderVersion();
    await until(() => O.heard(), 3000);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      O.toggle(1, 6);                                                      // each write carries the revision it took in, the same each time
      await W.net.idle(); await sleep(300);
      seen.push(/1:6/.test(done(L)) ? 'checked' : 'unchecked');
    }
    ok(seen.join() === 'checked,unchecked,checked', `the laptop follows each of its writes (${seen.join(', ')})`);
    await sleep(2500); await W.net.idle();
    ok(/1:6/.test(done(L)) && /1:6/.test(doneOf(W.cloud())), 'and it stays checked, on the laptop and in the cloud');
  }

  console.log('\n── 12. Two tabs: a task added in one gets a new id in the other\'s merge, and is deleted under its old id ──');
  for (const savedFirst of [false, true]) {
    const W = world();
    const [, P] = await W.devicesOnline(['first', 'phone']);
    const store = memoryStorage();
    const T1 = await W.boot('tab', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
    const T2 = await W.boot('other tab', {}, { store, idb: T1.idb });
    T1.dev.signIn(); T2.dev.signIn();
    await W.net.idle(); await sleep(500);
    T1.dev.sleep();                                                        // the tab that syncs is offline a moment
    addDbd(P, 'typed on the phone');                                       // the phone and the other tab each add a task: the same id
    P.w.eval('syncPushNow()');
    await until(() => cloudTexts(W).includes('typed on the phone'), 3000);
    addDbd(T2, 'typed in the other tab');
    T1.w.eval('saveToLocal()'); await sleep(50);                           // the tab that syncs takes it in
    const idOf = (app, text) => (stateOf(app).dbdTasks.find(t => t.text === text) || {}).id;
    const clash = idOf(T1, 'typed in the other tab') === idOf(P, 'typed on the phone');
    T2.w.eval("dbdTasks.splice(dbdTasks.findIndex(t => t.text === 'typed in the other tab'), 1); renderDbd();");   // a typo: deleted again
    if (savedFirst) T2.w.eval('saveToLocal()');
    T1.dev.wake();                                                         // back online: its merge moves the other tab's task to a new id
    T2.w.eval('saveToLocal()');
    const gone = texts => texts.includes('typed on the phone') && !texts.includes('typed in the other tab');
    const all = () => [dbdTexts(T1), dbdTexts(T2), dbdTexts(P), cloudTexts(W)];
    await W.net.idle(); await until(() => all().every(gone), 10000);
    ok(clash && all().every(gone),
      `${savedFirst ? 'the delete saved before the merge' : 'the merge saved before the delete'}: the task stays deleted, and the phone's stays, everywhere`
      + (clash ? '' : ' (the ids did not clash)') + ['tab', 'other tab', 'phone', 'cloud'].map((n, i) => (gone(all()[i]) ? '' : ` [${n}: ${all()[i].filter(t => /typed/.test(t)).join(' | ')}]`)).join(''));
  }

  console.log('\n── 13. Two tabs: the tab that syncs sends a change and closes; the other takes over ──');
  {
    const W = world();
    const [, P] = await W.devicesOnline(['first', 'phone']);
    const store = memoryStorage();
    const T1 = await W.boot('tab', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
    const T2 = await W.boot('other tab', {}, { store, idb: T1.idb });
    T1.dev.signIn(); T2.dev.signIn();
    await W.net.idle(); await sleep(500);
    addDbd(T1, 'added in the tab');
    T2.w.eval('saveToLocal()'); await sleep(50);                           // the other tab takes it in
    T1.w.eval("dbdTasks.find(t => t.text === 'added in the tab').text = 'added in the tab, renamed'; renderDbd(); saveToLocal(); syncPushNow();");
    const sent = T1.w.eval('syncPushing');
    W.close(T1);                                                           // closed as soon as it sent it
    await W.net.idle(); await sleep(2500); await W.net.idle();
    const ours = texts => texts.filter(t => /^added in the tab/.test(t)).join(' | ');
    ok(sent && ours(dbdTexts(T2)) === 'added in the tab, renamed' && ours(dbdTexts(P)) === 'added in the tab, renamed' && ours(cloudTexts(W)) === 'added in the tab, renamed',
      `the other tab takes over from what the tab saved last: the task once, renamed (${ours(dbdTexts(T2))})`);
  }

  console.log('\n── 14. Two tabs, both offline: the tab that syncs sent a task and never heard back; the other deletes it ──');
  {
    const W = world();
    const [, P] = await W.devicesOnline(['first', 'phone']);
    const store = memoryStorage();
    const T1 = await W.boot('tab', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
    const T2 = await W.boot('other tab', {}, { store, idb: T1.idb });
    T1.dev.signIn(); T2.dev.signIn();
    await W.net.idle(); await sleep(500);
    T2.dev.sleep();                                                        // the other tab's connection drops
    addDbd(T1, 'added in the tab');
    T1.w.eval('syncPushNow()');
    T1.dev.sleep();                                                        // and the tab's, just after it sent the task: it never hears back
    await until(() => cloudTexts(W).includes('added in the tab'), 3000);
    W.close(T1);                                                           // then it is closed: the other tab syncs now, offline
    await sleep(500);
    T2.w.eval("dbdTasks.splice(dbdTasks.findIndex(t => t.text === 'added in the tab'), 1); renderDbd(); saveToLocal();");
    T2.dev.wake();
    await W.net.idle(); await sleep(2500); await W.net.idle();
    const gone = texts => !texts.includes('added in the tab');
    ok(gone(dbdTexts(T2)) && gone(cloudTexts(W)) && gone(dbdTexts(P)), `the task stays deleted, everywhere (other tab: ${!gone(dbdTexts(T2)) ? 'back' : 'gone'}, cloud: ${!gone(cloudTexts(W)) ? 'back' : 'gone'})`);
  }

  console.log('\n── 15. Two tabs and an older version: the other tab takes over, built on the copy the tab agreed on last ──');
  {
    /* the rule: what another tab saved is built on the copy agreed on later, even under the same number
     * (a merged copy, or an older version's, keeps the number of the copy before it) */
    const S = await world().boot('a tab', {}, { store: memoryStorage() });
    const takeIn = async (mine, theirs) => {
      S.w.eval(`setStateMark(${JSON.stringify(mine)}); saveToLocal();`);
      S.w.localStorage.setItem('focus-app-state', JSON.stringify({ ...stateOf(S), syncLocal: theirs }));
      S.w.eval('saveToLocal()'); await sleep(50);
      return stateOf(S).syncLocal.hash;
    };
    ok(await takeIn({ rev: 'a', hash: 'earlier', seq: 2, at: 1000 }, { rev: 'b', hash: 'later', seq: 2, at: 2000 }) === 'later'
      && await takeIn({ rev: 'b', hash: 'later', seq: 2, at: 2000 }, { rev: 'a', hash: 'earlier', seq: 2, at: 1000 }) === 'later',
      'a tab takes in the copy agreed on later, under the same number, and keeps its own when that is the later one');
    const W = world();
    const [, P] = await W.devicesOnline(['first', 'phone']);
    const store = memoryStorage();
    const T1 = await W.boot('tab', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
    const T2 = await W.boot('other tab', {}, { store, idb: T1.idb });
    T1.dev.signIn(); T2.dev.signIn();
    const O = W.olderVersion();
    await W.net.idle(); await sleep(500);
    const settle = async () => { await W.net.idle(); await sleep(300); };
    O.toggle(1, 6); await settle();                                        // the older phone checks a task
    addDbd(T1, 'added in the tab'); T1.w.eval('syncPushNow()'); await settle();
    T2.w.eval('saveToLocal()'); await sleep(50);                           // the other tab takes in the tab's copy, built on that push
    O.toggle(1, 6); await settle();                                        // the older phone unchecks it: the tab takes that copy as agreed (its number unchanged)
    T2.w.eval('saveToLocal()'); await sleep(50);                           // the other tab takes in what the tab saved
    const markOf = app => (stateOf(app).syncLocal || {}).hash;
    ok(markOf(T2) && markOf(T2) === markOf(T1), 'the other tab takes in which copy the tab agreed on last, though its number is the same');
    T1.dev.sleep();                                                        // the tab's connection drops; the other tab only listens
    addDbd(P, 'added on the phone'); P.w.eval('syncPushNow()'); await settle();
    O.toggle(1, 6); await settle();                                        // the older phone checks it again, over the phone's copy
    addDbd(T2, 'added in the other tab');
    W.close(T1);                                                           // the other tab takes over, with the older phone's copy last heard
    await W.net.idle(); await sleep(2500); await W.net.idle();
    ok(/1:6/.test(done(T2)) && /1:6/.test(doneOf(W.cloud())) && has(cloudTexts(W), ['added in the tab', 'added on the phone', 'added in the other tab']),
      `the older phone's last check stays, with everything added (other tab: ${done(T2)})`);
  }

  console.log('\n── 16. An older version writes late, over a copy one device never had ──');
  {
    const W = world();
    const [L, , T] = await W.devicesOnline(['laptop', 'phone', 'tablet']);
    const O = W.olderVersion();
    await until(() => O.heard(), 3000);
    T.dev.sleep();                                                         // the tablet is shut (it keeps the copies it had)
    addDbd(L, 'added, then deleted'); L.w.eval('syncPushNow()');
    await until(() => O.heard().dbdTasks.some(t => t.text === 'added, then deleted'), 3000);
    O.dev.sleep();                                                         // the older phone goes offline with that copy
    await W.net.idle(); await sleep(300);
    L.w.eval("removeDbdTask(dbdTasks.find(t => t.text === 'added, then deleted').id); syncPushNow();");
    await W.net.idle(); await sleep(300);
    T.dev.wake();                                                          // the tablet never had the copy the older phone took in
    await W.net.idle(); await sleep(500);
    O.toggle(1, 6);                                                        // the older phone checks a task offline, and comes back
    O.dev.wake();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    const gone = texts => !texts.includes('added, then deleted');
    ok(gone(dbdTexts(T)) && gone(dbdTexts(L)) && gone(cloudTexts(W)), `the deleted task stays deleted (tablet: ${gone(dbdTexts(T)) ? 'gone' : 'back'}, cloud: ${gone(cloudTexts(W)) ? 'gone' : 'back'})`);
    ok(/1:6/.test(doneOf(W.cloud())) && /1:6/.test(done(T)), "and the older phone's check is taken in, from a device that had its copy");
  }

  console.log('\n── 17. A copy from an older version, the same as this device\'s by chance ──');
  {
    const W = world();
    const [L, P] = await W.devicesOnline(['laptop', 'phone']);
    const O = W.olderVersion();
    await until(() => O.heard(), 3000);
    P.w.toggleTask(1, 5); P.w.eval('syncPushNow()');                       // checked on the phone, and in the cloud
    await until(() => /1:5/.test(doneOf(O.heard())), 3000);
    O.dev.sleep();                                                         // the older phone goes offline with that copy
    P.w.toggleTask(1, 5); P.w.eval('syncPushNow()');                       // unchecked on the phone
    await until(() => !/1:5/.test(doneOf(W.cloud())), 3000); await W.net.idle(); await sleep(300);
    O.toggle(1, 6);                                                        // the older phone checks another task, offline
    P.dev.sleep();
    P.w.toggleTask(1, 5); P.w.toggleTask(1, 6);                            // the phone, offline, checks the first again, and the other too
    O.dev.wake();                                                          // the older phone's copy goes over the cloud's: the same as the phone's
    await until(() => /1:6/.test(doneOf(W.cloud())), 3000);
    P.dev.wake();
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok(/1:5/.test(doneOf(W.cloud())) && /1:5/.test(done(L)) && /1:5/.test(done(P)), `the phone's check is kept, everywhere (cloud: ${doneOf(W.cloud())})`);
  }

  console.log('\n── 18. A copy put on top of this device\'s: what it sends next is numbered after it ──');
  {
    const W = world();
    const [L] = await W.devicesOnline(['laptop']);
    for (let i = 0; i < 3; i++) { addDbd(L, `task ${i}`); L.w.eval('syncPushNow()'); await W.net.idle(); await sleep(200); }
    /* another device's copy, built on one of the laptop's earlier ones, numbered past the laptop's (it kept its own over one it couldn't merge) */
    const early = L.w.copiesRecent().filter(e => e.kind === 'agreed' && e.canon && e.seq === 2)[0];
    const st = JSON.parse(early.state);
    st.dbdTasks.push({ id: 900, text: 'added elsewhere', due: '2026-10-02', done: false });
    Object.assign(st, { syncRev: 'zzz-other', syncBase: early.rev, syncBaseHash: early.hash, syncSeq: 40, syncBaseSeq: 39, syncLog: [early.rev, 'zzz-other'] });
    W.net.set('users/u1', { ...W.net.at('users/u1'), state: JSON.stringify(st), updatedAt: Date.now(), client: 'another device' });
    await W.net.idle(); await sleep(2500); await W.net.idle();
    ok(dbdTexts(L).includes('added elsewhere') && has(dbdTexts(L), ['task 0', 'task 1', 'task 2']), 'its change is put on top of the laptop\'s');
    ok(W.cloud().syncSeq > 40, `and the laptop's copy goes back numbered after it (${W.cloud().syncSeq})`);
  }

  console.log('\n── 19. An older version\'s copy heard again, late ──');
  {
    const W = world();
    const [L] = await W.devicesOnline(['laptop']);
    const O = W.olderVersion();
    await until(() => O.heard(), 3000);
    O.toggle(1, 6); await W.net.idle(); await sleep(300);                  // the older phone checks a task
    const first = W.net.at('users/u1');
    O.toggle(1, 6); await W.net.idle(); await sleep(300);                  // and unchecks it
    ok(!/1:6/.test(done(L)), 'the laptop takes in both');
    W.net.set('users/u1', { ...W.net.at('users/u1'), state: first.state, updatedAt: first.updatedAt, client: first.client });   // the first arrives again, late
    await W.net.idle(); await sleep(2500); await W.net.idle();
    ok(!/1:6/.test(done(L)) && !/1:6/.test(doneOf(W.cloud())), `the check taken back stays taken back (laptop: ${done(L) || 'none'})`);
  }

  console.log('\n── 20. A device\'s copy numbered lower than another\'s, after an older version wrote over the cloud ──');
  {
    const W = world();
    const [L0, P] = await W.devicesOnline(['laptop', 'phone']);
    const O = W.olderVersion();
    addDbd(L0, 'first'); L0.w.eval('syncPushNow()'); await W.net.idle(); await sleep(200);
    await until(() => O.heard().dbdTasks.some(t => t.text === 'first'), 3000);
    O.dev.sleep();                                                         // the older phone goes offline with that copy
    addDbd(L0, 'second'); L0.w.eval('syncPushNow()'); await W.net.idle(); await sleep(200);
    L0.dev.sleep();                                                        // the laptop, with the one after it
    for (const t of ['on the phone', 'on the phone again']) { addDbd(P, t); P.w.eval('syncPushNow()'); await W.net.idle(); await sleep(200); }
    addDbd(L0, 'on the laptop, offline');
    P.dev.sleep();
    O.toggle(1, 6); O.dev.wake();                                          // the older phone writes over the cloud's copy
    await W.net.idle(); await sleep(300);
    const L = await W.reload(L0);                                          // the laptop opens again: it takes that copy in, and sends its own
    await W.net.idle(); await sleep(1500); await W.net.idle();
    P.dev.wake();                                                          // the phone, numbered past the laptop, hears both
    await W.net.idle(); await sleep(3000); await W.net.idle();
    const want = ['first', 'second', 'on the phone', 'on the phone again', 'on the laptop, offline'];
    ok(has(cloudTexts(W), want) && has(dbdTexts(L), want) && has(dbdTexts(P), want), `everything stays, everywhere (cloud: ${cloudTexts(W).filter(t => want.includes(t)).length}/5)`);
    ok(/1:6/.test(doneOf(W.cloud())), "with the older phone's check");
  }

  console.log('\n── 21. A device that stops just after the cloud confirms its change, with no time to save ──');
  {
    const W = world();
    const [L, P0] = await W.devicesOnline(['laptop', 'phone']);
    P0.w.toggleTask(1, 5); P0.w.eval('syncPushNow()'); await W.net.idle(); await sleep(300);   // checked, in the cloud
    P0.w.toggleTask(1, 5); P0.w.eval('syncPushNow()');                     // unchecked …
    await until(() => !/1:5/.test(doneOf(W.cloud())) && !P0.w.eval('syncPushing'), 3000);     // … and confirmed
    const P = await W.reload(P0, { crash: true });                         // the phone stops at once, and opens again
    P.w.toggleTask(1, 5);                                                  // checked again, before it has heard the cloud
    await W.net.idle(); await sleep(2500); await W.net.idle();
    ok(/1:5/.test(done(P)) && /1:5/.test(doneOf(W.cloud())) && /1:5/.test(done(L)), `the check made after it stays (cloud: ${doneOf(W.cloud()) || 'none'})`);
  }

  console.log('\n── 22. Two tabs: the tab that syncs is gone before it saves what it has, with the other tab\'s save not taken in yet ──');
  {
    const twoTabs = async W => {
      const [, P] = await W.devicesOnline(['first', 'phone']);
      const store = memoryStorage();
      const T1 = await W.boot('tab', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
      const T2 = await W.boot('other tab', {}, { store, idb: T1.idb });
      T1.dev.signIn(); T2.dev.signIn();
      await W.net.idle(); await sleep(500);
      return [T1, T2, P];
    };
    const discard = (W, app) => { app.hidden = true; W.close(app); };     // the browser drops the page: nothing more runs there
    {
      const W = world();
      const [T1, T2, P] = await twoTabs(W);
      const O = W.olderVersion();
      await until(() => O.heard(), 3000);
      T2.dev.sleep();                                                      // the other tab's connection drops (it only listens)
      T2.w.toggleTask(3, 13);                                              // a check in the other tab, saved; the tab takes it in at its next save …
      T1.w.eval('stateOtherTabTimer = -1');                                // … which waits (a page in the background: its timers wait)
      O.add('added on the older phone', 5000);                             // the tab takes in the older phone's copy …
      await until(() => dbdTexts(T1).includes('added on the older phone'), 3000);
      P.w.toggleTask(1, 5); P.w.eval('syncPushNow()');                     // … and the phone's, built on it
      await until(() => /1:5/.test(done(T1)), 3000); await W.net.idle();
      discard(W, T1);                                                      // then the tab is gone: the other tab takes over, offline
      await sleep(500);
      T2.dev.wake();
      await W.net.idle(); await sleep(3000); await W.net.idle();
      const all = [dbdTexts(T2), cloudTexts(W), dbdTexts(P)];
      ok(all.every(t => t.includes('added on the older phone')) && [done(T2), doneOf(W.cloud()), done(P)].every(d => /1:5/.test(d) && /3:13/.test(d)),
        `a copy from the cloud the tab took in last stays, with the other tab's check (cloud: ${cloudTexts(W).includes('added on the older phone') ? 'has the task' : 'lost the task'}, ${doneOf(W.cloud())})`);
    }
    {
      const W = world();
      const [T1, T2, P] = await twoTabs(W);
      T2.w.toggleTask(3, 13);                                              // a check in the other tab, saved
      T1.w.eval('stateOtherTabTimer = -1');                                // the tab takes it in at its next save, which waits
      addDbd(T1, 'added in the tab');                                      // a task added in the tab, and the tab closed at once
      W.close(T1);
      await W.net.idle(); await sleep(3000); await W.net.idle();
      ok([dbdTexts(T2), cloudTexts(W), dbdTexts(P)].every(t => t.includes('added in the tab')) && /3:13/.test(doneOf(W.cloud())),
        `a task added in the tab just before it closed stays (cloud: ${cloudTexts(W).includes('added in the tab') ? 'has it' : 'lost it'})`);
    }
  }

  console.log('\n── 23. A device whose storage is full, restarted: what it took in from the cloud since was never saved there ──');
  {
    const W = world();
    const [P] = await W.devicesOnline(['phone']);
    const store = memoryStorage();
    const L0 = await W.boot('laptop', { 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(P) }) }, { store });
    L0.dev.signIn();
    await W.net.idle(); await sleep(2500);                                 // (saved, built on the cloud's copy)
    const setItem = store.setItem;
    store.setItem = (k, v) => { if (k === 'focus-app-state') throw new Error('QuotaExceededError'); setItem(k, v); };   // the state no longer fits
    addDbd(P, 'added on the phone'); P.w.eval('syncPushNow()');
    await until(() => dbdTexts(L0).includes('added on the phone'), 3000); await W.net.idle(); await sleep(300);
    P.w.toggleTask(1, 5); P.w.eval('syncPushNow()');
    await until(() => /1:5/.test(done(L0)), 3000); await W.net.idle(); await sleep(300);
    const L = await W.reload(L0);                                          // it opens with the copy saved before
    await W.net.idle(); await sleep(3000); await W.net.idle();
    ok([dbdTexts(L), cloudTexts(W), dbdTexts(P)].every(t => t.includes('added on the phone')) && [done(L), doneOf(W.cloud())].every(d => /1:5/.test(d)),
      `what the phone did stays, on the laptop and in the cloud (cloud: ${cloudTexts(W).includes('added on the phone') ? 'has the task' : 'lost the task'}, laptop: ${dbdTexts(L).includes('added on the phone') ? 'has it' : 'lost it'})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
