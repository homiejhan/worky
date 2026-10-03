/* Whole-state reverts: a copy of the state from before what the other devices
 * did must never take the place of their changes, on any device or in the
 * cloud. Each section is a way an older copy used to get there: a device that
 * slept through a day of edits, an older version of Focus, a device whose
 * storage is full, a second tab of Focus in the same browser, Formats left open.
 * Run: npm test -- sync_revert (or node --experimental-vm-modules tests/test_sync_revert.js) */
const { world, sleep, until, doneOf, done, stateOf } = require('./sync-world');

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
    await sleep(2500);
    ok(doneOf(W.cloud()) === '0:0 0:1 0:2 0:3' && cloudTexts(W).includes('added on the phone today'), 'a day of changes reaches the cloud');
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
    ok(after.length <= 140 && after.length > 60, `200 more copies: ${after.length} stay (the newest 40, then one an hour, then one a day)`);
    ok(L.w.copiesRecent().length <= 40 && L.w.copiesRecent().every(e => typeof e.state === 'string'), 'and only the newest stay in memory');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
