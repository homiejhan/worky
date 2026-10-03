/* Randomized cloud sync: devices change things between syncs, at random times,
 * and every change has to survive. One case is one seed:
 *   • three devices (laptop, phone, tablet); in some cases a second tab of Focus
 *     sharing the laptop's browser storage, and in some an older version of
 *     Focus that writes over the cloud without looking;
 *   • 40 actions at random times, most of them before the last change has
 *     finished syncing: check or uncheck a task, add a task, rename one, tick
 *     one off, delete one, log a purchase, go offline and come back, restart the
 *     app, a bank or digest delivery landing in the account;
 *   • each device changes only its own things, so the end state is known: every
 *     check, task, rename, deletion and purchase in the cloud, each task once,
 *     and every device with the cloud's copy.
 * Not part of npm test (100 cases take several minutes).
 * Run: npm run fuzz:sync -- [cases=100] [first seed=1] [processes=6]
 * One case, with what happened in it: FUZZ_SEED=17 npm run fuzz:sync */
const path = require('path');
const { spawn } = require('child_process');
const { world, memoryStorage, sleep, until, stateOf } = require('./sync-world');

const STEPS = 40;

/* FUZZ_TRACE=1: what each device's sync decided, and its saves, in the log of a case */
/* FUZZ_WATCH=regex: also show the tasks and purchases whose names match it, with their ids */
const done0 = "JSON.stringify(st.todoLists.flatMap(l => l.tasks.filter(t => t.done).map(t => l.id + ':' + t.id)))"
  + (process.env.FUZZ_WATCH ? ` + ' ' + JSON.stringify([...(st.dbdTasks || []), ...((st.budget && st.budget.purchases) || [])].filter(x => new RegExp(${JSON.stringify(process.env.FUZZ_WATCH)}).test(x.text || x.title)).map(x => x.id + '=' + (x.text || x.title)))` : '');
function traced(src, file) {
  const t = "(window.__trace = window.__trace || []).push(Date.now() + ' ' + ";
  if (file === 'js/sync.js') {
    return src
      .replace('function syncReconcileRemote(v, { doneWins = false } = {}) {', `function syncReconcileRemote(v, { doneWins = false } = {}) { { const st = v && typeof v.state === 'string' ? JSON.parse(v.state) : null; ${t}'hear ' + (v && v.client === syncClientId ? 'own' : 'other') + ' ' + (st ? ${done0} + ' seq=' + st.syncSeq + ' base=' + st.syncBaseSeq : '-') + ' top=' + syncTopSeq); }`)
      .replace('  syncWrite(payload, priority)\n', `  { const st = JSON.parse(payload.state); ${t}'push seq=' + st.syncSeq + ' base=' + st.syncBaseSeq + ' ' + ${done0}); }\n  syncWrite(payload, priority)\n`)
      .replace('function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by, agreedStr) {', `function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by, agreedStr) { { const st = JSON.parse(mergedStr || remoteStr); ${t}'apply ' + (mergedStr ? 'merged ' : '') + ${done0} + (agreedStr ? ' (agreed fixed)' : '')); }`)
      .replace('function syncKeepOurs(v) {', `function syncKeepOurs(v) { ${t}'KEEP OURS');`)
      .replace('    const base = syncBuiltOn(remote, knownHash, v.client);\n', `    const base = syncBuiltOn(remote, knownHash, v.client);
    { const under = copiesIndex().filter(e => e.kind === 'agreed' && e.rev === remote.syncRev); ${t}'  built on: ' + (base ? (base.hash === knownHash ? 'the known copy' : (base.canon ? 'canon' : 'by ' + (base.by === v.client ? 'writer' : 'other')) + ' seq=' + base.seq + ' age=' + (Date.now() - base.at)) : 'none') + ' (under its rev: ' + under.map(e => (e.canon ? 'canon' : e.by === v.client ? 'writer' : 'other') + '@' + (Date.now() - e.at)).join(' ') + ')'); }
`)
      .replace('  const preferLocal = doneWins || (meta.editAt || 0) > (v.updatedAt || 0);', `  const preferLocal = doneWins || (meta.editAt || 0) > (v.updatedAt || 0);
  { const st = local; ${t}'  local ' + ${done0} + ' mark=' + (mark ? mark.seq : 'none') + ' knownFrom=' + (syncKnownFp !== null ? 'memory' : mark ? 'mark' : 'meta') + ' localDirty=' + localDirty + ' remoteDirty=' + remoteDirty); }`)
      .replace('function syncTakeSent(remote, local) {', `function syncTakeSent(remote, local) { if (syncSent || syncKnownFp === null) ${t}'check sent ' + !!syncSent);`);
  }
  if (file === 'js/persistence.js') {
    return src.replace('function stateTakeInOtherTab() {', `function stateTakeInOtherTab() { { let st = null; try { st = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) {} ${t}'take in other tab ' + (st ? ${done0} : '-')); }`);
  }
  return src;
}

async function runCase(seed) {
  const stream = start => { let x = start % 2147483647 || 1; return () => (x = (x * 16807) % 2147483647) / 2147483647; };
  const rand = stream(seed * 48271);                 // what happens, and when: the same for a seed every run
  const jitter = stream(seed * 69621 + 7);           // network delays (they depend on how many messages there are)
  const pick = a => a[Math.floor(rand() * a.length)];
  const W = world({ delay: () => 20 + jitter() * 120, transform: process.env.FUZZ_TRACE ? traced : undefined });
  const twoTabs = rand() < 0.3, withOlder = rand() < 0.5;
  const t0 = Date.now();
  const log = [];
  const note = m => log.push(`${String(Date.now() - t0).padStart(6)}ms ${m}`);

  /* the account, and devices that had synced it before */
  const store = twoTabs ? memoryStorage() : null;
  const laptop = await W.boot('laptop', { 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: 'x' }) }, store ? { store } : {});
  laptop.dev.signIn();
  await until(() => W.cloud(), 3000);
  const synced = () => ({ 'focus-app-state': W.net.at('users/u1/state'), 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: W.fp(laptop) }) });
  const phone = await W.boot('phone', synced());
  const tablet = await W.boot('tablet', synced());
  phone.dev.signIn();
  tablet.dev.signIn();
  let tab2 = null;
  if (twoTabs) { tab2 = await W.boot('tab2', {}, { store, idb: laptop.idb }); tab2.dev.signIn(); }
  await W.net.idle();
  await sleep(400);

  /* each device owns one Daily list, and what it adds */
  const lists = stateOf(laptop).todoLists;
  const own = (list, extra) => ({ list: list.id, tasks: list.tasks.map(t => t.id), done: Object.fromEntries(list.tasks.map(t => [t.id, !!t.done])),
    adds: [], purchases: [], asleep: false, ...extra });
  const owners = [laptop, phone, tablet, ...(tab2 ? [tab2] : [])].map((app, i) => own(lists[i], { name: app.name, app }));
  let O = null;
  if (withOlder) {
    O = W.olderVersion('older');
    owners.push(own(lists[owners.length], { name: 'older', older: true }));
    await until(() => O.heard(), 3000);                                    // it has the account's copy, like a device that was open
  }
  note(`devices: ${owners.map(o => o.name).join(', ')}`);

  const idOf = (o, item) => {
    const t = stateOf(o.app).dbdTasks.find(x => x.text === item.text);
    return t ? t.id : null;
  };
  for (let step = 0; step < STEPS; step++) {
    const o = pick(owners);
    const r = rand();
    if (o.older) {
      if (r < 0.2) { o.asleep = !o.asleep; if (o.asleep) O.dev.sleep(); else O.dev.wake(); note(`older ${o.asleep ? 'goes offline' : 'comes back'}`); }
      else if (r < 0.7) { const tid = pick(o.tasks); O.toggle(o.list, tid); o.done[tid] = !o.done[tid]; note(`older checks ${o.list}:${tid} → ${o.done[tid]}`); }
      else { const text = `older #${step}`; O.add(text, 5000 + step); o.adds.push({ text, done: false, deleted: false, was: [] }); note(`older adds "${text}"`); }
    } else {
      const w = o.app.w;
      const live = o.adds.filter(a => !a.deleted);
      if (r < 0.28) {
        const tid = pick(o.tasks);
        w.toggleTask(o.list, tid);
        o.done[tid] = !o.done[tid];
        note(`${o.name} checks ${o.list}:${tid} → ${o.done[tid]}`);
      } else if (r < 0.43) {
        const text = `${o.name} #${step}`;
        w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: ${JSON.stringify(text)}, due: dbdTodayKey(), done: false }); renderDbd(); saveToLocal();`);
        o.adds.push({ text, done: false, deleted: false, was: [] });
        note(`${o.name} adds "${text}"`);
      } else if (r < 0.62 && live.length) {
        const item = pick(live), id = idOf(o, item);
        if (id === null) { note(`${o.name} can't find its "${item.text}"`); continue; }
        if (r < 0.50) {
          const text = `${item.text} (renamed ${step})`;
          w.setDbdText(id, text);
          item.was.push(item.text);
          item.text = text;
          note(`${o.name} renames it "${text}"`);
        } else if (r < 0.56) {
          w.removeDbdTask(id);
          item.deleted = true;
          note(`${o.name} deletes "${item.text}"`);
        } else {
          w.toggleDbdTask(id);
          item.done = !item.done;
          note(`${o.name} ticks "${item.text}" → ${item.done}`);
        }
      } else if (r < 0.70) {
        const title = `${o.name} buy #${step}`;
        w.eval(`budget.purchases.push({ id: purchaseIdCounter++, title: ${JSON.stringify(title)}, amount: ${1 + step} }); renderBudget(); saveToLocal();`);
        o.purchases.push(title);
        note(`${o.name} logs "${title}"`);
      } else if (r < 0.82) {
        o.asleep = !o.asleep;
        if (o.asleep) o.app.dev.sleep(); else o.app.dev.wake();
        note(`${o.name} ${o.asleep ? 'goes offline' : 'comes back'}`);
      } else if (r < 0.88) {
        o.app = await W.reload(o.app);
        o.asleep = false;
        note(`${o.name} restarts`);
      } else if (r < 0.94) {
        W.net.set('users/u1/bank/updatedAt', Date.now());
        note('a bank refresh lands');
      } else {
        W.net.set('users/u1/digestInbox/at', Date.now());
        note('a digest lands');
      }
    }
    await sleep(Math.floor(rand() * (rand() < 0.25 ? 2500 : 700)));
  }

  /* everyone back online; then every device must come to the cloud's copy */
  owners.forEach(o => { if (o.asleep) { if (o.older) O.dev.wake(); else o.app.dev.wake(); o.asleep = false; } });
  note('all online');
  const apps = () => owners.filter(o => !o.older).map(o => o.app);
  const cloudFp = () => laptop.closed ? apps()[0].w.eval(`syncHash(syncFingerprint(${JSON.stringify(W.cloud())}))`)
    : laptop.w.eval(`syncHash(syncFingerprint(${JSON.stringify(W.cloud())}))`);
  const quiet = a => !a.w.eval('syncPushTimer') && !a.w.eval('syncPushing');
  let converged = false;
  for (let i = 0; i < 20 && !converged; i++) {
    await W.net.idle();
    await sleep(1000);
    const fp = cloudFp();
    converged = apps().every(a => quiet(a) && W.fp(a) === fp);
  }

  const problems = [];
  const cloud = W.cloud();
  if (!converged) problems.push(`devices don't all have the cloud's copy: ${apps().map(a => `${a.name} ${W.fp(a) === cloudFp() ? 'same' : 'DIFFERENT'}`).join(', ')}`);
  for (const o of owners) {
    const list = cloud.todoLists.find(l => l.id === o.list);
    Object.entries(o.done).forEach(([tid, want]) => {
      const t = list.tasks.find(x => x.id === Number(tid));
      if (!!(t && t.done) !== want) problems.push(`${o.name}'s check on task ${o.list}:${tid} is lost (should be ${want ? 'done' : 'not done'})`);
    });
    o.adds.forEach(item => {
      const found = cloud.dbdTasks.filter(t => t.text === item.text);
      if (item.deleted) { if (found.length) problems.push(`${o.name} deleted "${item.text}", but it is back`); return; }
      if (found.length !== 1) { problems.push(`${o.name}'s task "${item.text}" is there ${found.length} times`); return; }
      if (!!found[0].done !== item.done) problems.push(`${o.name}'s tick on "${item.text}" is lost`);
      item.was.forEach(old => { if (cloud.dbdTasks.some(t => t.text === old)) problems.push(`${o.name} renamed "${old}", but the old name is back`); });
    });
    o.purchases.forEach(title => {
      const n = cloud.budget.purchases.filter(p => p.title === title).length;
      if (n !== 1) problems.push(`${o.name}'s purchase "${title}" is there ${n} times`);
    });
  }
  if (process.env.FUZZ_TRACE) W.devices.forEach(d => (d.w.__trace || []).forEach(line => {
    const [at, ...rest] = line.split(' ');
    log.push(`${String(Number(at) - t0).padStart(6)}ms   [${d.name}${d.closed ? ' (closed)' : ''}] ${rest.join(' ')}`);
  }));
  log.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const changes = owners.reduce((n, o) => n + Object.keys(o.done).length + o.adds.length + o.purchases.length, 0);
  return { seed, ok: !problems.length, problems, twoTabs, withOlder, ms: Date.now() - t0, changes, log };
}

if (process.env.FUZZ_SEED) {
  const seed = Number(process.env.FUZZ_SEED);
  runCase(seed).then(res => {
    if (process.env.FUZZ_LOG) console.log(res.log.join('\n'));
    console.log('RESULT ' + JSON.stringify(res));
    process.exit(0);
  }, e => {
    console.log('RESULT ' + JSON.stringify({ seed, ok: false, problems: [`crashed: ${e && e.stack}`], log: [] }));
    process.exit(1);
  });
} else {
  const [cases = 100, first = 1, procs = 6] = process.argv.slice(2).map(Number);
  const seeds = Array.from({ length: cases }, (_, i) => first + i);
  const results = [];
  const started = Date.now();
  const runOne = seed => new Promise(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, __filename], { env: { ...process.env, FUZZ_SEED: String(seed) }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find(l => l.startsWith('RESULT '));
      const res = line ? JSON.parse(line.slice(7)) : { seed, ok: false, problems: ['timed out or died without a result'], log: [] };
      results.push(res);
      const kind = `${res.twoTabs ? ' +tab' : ''}${res.withOlder ? ' +older' : ''}`;
      console.log(`${res.ok ? '✓' : '✗'} case ${String(results.length).padStart(3)}/${cases}  seed ${seed}${kind}${res.ok ? '' : ` — ${res.problems.join('; ')}`}`);
      resolve();
    });
  });
  (async () => {
    const queue = [...seeds];
    await Promise.all(Array.from({ length: procs }, async () => { while (queue.length) await runOne(queue.shift()); }));
    const failed = results.filter(r => !r.ok).sort((a, b) => a.seed - b.seed);
    const changes = results.reduce((n, r) => n + (r.changes || 0), 0);
    console.log(`\n${results.length - failed.length}/${results.length} cases passed (${changes} changes checked) in ${Math.round((Date.now() - started) / 1000)} s`);
    console.log(`  with a second tab: ${results.filter(r => r.twoTabs).length}, with an older version: ${results.filter(r => r.withOlder).length}`);
    failed.forEach(r => console.log(`\n── seed ${r.seed} ──\n${r.problems.join('\n')}\n${(r.log || []).join('\n')}`));
    process.exit(failed.length ? 1 : 0);
  })();
}
