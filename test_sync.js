/* Cloud sync — headless tests (node test_sync.js; needs `npm i jsdom`).
 * Two simulated devices share a fake Realtime Database node. Also simulates
 * an "older build" device that strips fields it does not know about — the
 * situation that made the digest revert and sync bounce forever. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const src = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* fake RTDB: one node, value listeners, async echo like the real thing */
const cloud = { val: null, listeners: [], writes: 0, hooks: [] };
function makeRef() {
  return {
    on(ev, cb) { cloud.listeners.push(cb); setTimeout(() => cb({ val: () => cloud.val }), 0); },
    off() {},
    set(payload) {
      cloud.val = payload; cloud.writes++;
      return new Promise(res => setTimeout(() => {
        res();
        cloud.hooks.forEach(h => h());                                  // "other" writers react first
        cloud.listeners.forEach(cb => setTimeout(() => cb({ val: () => cloud.val }), 0));
      }, 5));
    },
  };
}
function boot(name, storage = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/worky/' });
  const w = dom.window;
  Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  Object.defineProperty(w, 'confirm', { value: () => true, writable: true, configurable: true });
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  let authCb = null;
  w.firebase = { initializeApp() {}, auth: () => ({ onAuthStateChanged(cb) { authCb = cb; }, signOut() {} }), database: () => ({ ref: () => makeRef() }) };
  w.__stats = { applies: 0, pushes: 0 };
  const s = w.document.createElement('script');
  s.textContent = src
    .replace('function syncApplyRemote(remoteStr, remoteUpdatedAt) {', 'function syncApplyRemote(remoteStr, remoteUpdatedAt) { window.__stats.applies++;')
    .replace('  syncRef.set(payload)', '  window.__stats.pushes++;\n  syncRef.set(payload)');
  w.document.body.appendChild(s);
  w.document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
  w.__signIn = () => authCb({ uid: 'u1', email: 'me@example.com', getIdToken: async () => 't' });
  return { name, w, d: w.document };
}
const fpOf = w => w.eval('syncFingerprint(gatherState())');

(async () => {
  console.log('\n── 1. Fingerprint is stable across save/load and ignores key order ──');
  {
    const { w } = boot('solo');
    const rt = () => { w.localStorage.setItem('focus-app-state', JSON.stringify(w.gatherState())); w.loadFromLocal(); };
    w.digestLoadSample(); w.digestAddTask(1);
    const a = fpOf(w); rt(); const b = fpOf(w); rt(); const c = fpOf(w);
    ok(a === b && b === c, 'digest with tasks: identical fingerprint after two round trips');
    eq(w.eval("syncFingerprint({b:1,a:{d:[{y:1,x:2}],c:null}})"), w.eval("syncFingerprint({a:{c:null,d:[{x:2,y:1}]},b:1})"), 'key order does not change the fingerprint');
    ok(JSON.parse(JSON.stringify(w.gatherState())).build === w.eval('STATE_BUILD'), 'state carries its schema build');
    /* unknown fields pass through a load/save */
    const st = w.gatherState(); st.futureThing = { hello: 1 };
    w.localStorage.setItem('focus-app-state', JSON.stringify(st)); w.loadFromLocal();
    eq(JSON.stringify(w.gatherState().futureThing), '{"hello":1}', 'a field this build does not know survives load → gather');
  }

  console.log('\n── 2. Two devices on the same build converge without echo applies ──');
  const A = boot('A');
  A.w.localStorage.setItem('focus-sync-meta', JSON.stringify({ pushedAt: 1, knownHash: 'x' }));
  A.w.__signIn(); await sleep(60);
  ok(!!cloud.val, 'A seeded the cloud');
  const B = boot('B', { 'focus-app-state': cloud.val.state, 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: A.w.eval('syncHash(syncFingerprint(gatherState()))') }) });
  B.w.__signIn(); await sleep(120);
  eq(A.w.__stats.applies + B.w.__stats.applies, 0, 'identical devices: nothing applied on connect');

  A.w.digestGet().enabled = true; A.w.saveToLocal(); await sleep(2000);
  eq(B.w.digestGet().enabled, true, 'B received enabled');
  A.w.digestLoadSample(); await sleep(2500);
  ok(!!B.w.digestGet().last && B.w.digestGet().last.tasks.length === 4, 'B received the sample digest with 4 tasks');
  eq(A.w.__stats.applies, 0, 'A never had its own changes echoed back as a remote apply');
  eq(B.w.__stats.pushes, 0, 'B pushed nothing back after applying');
  A.w.digestAddTask(2); await sleep(2500);
  eq(B.w.eval('dbdTasks.length'), A.w.eval('dbdTasks.length'), 'added task reached B');
  ok(B.w.digestGet().last.tasks[1].added && B.w.dbdById(B.w.digestGet().last.tasks[1].added), 'B shows it as added');
  B.w.digestGet().enabled = false; B.w.saveToLocal(); await sleep(2500);
  eq(A.w.digestGet().enabled, false, 'B → A works too');
  const w1 = cloud.writes; await sleep(2500);
  eq(cloud.writes, w1, 'idle: no further cloud writes');

  console.log('\n── 3. An older build that strips unknown fields cannot erase them or loop forever ──');
  /* simulate an old device: after every write that contains a digest, it "applies"
   * (drops digest, build 1) and pushes back as a foreign client — exactly what a
   * pre-digest build does in syncApplyRemote → saveToLocal → push */
  let oldPushes = 0;
  const oldDevice = () => {
    const st = JSON.parse(cloud.val.state);
    if (!('digest' in st) || cloud.val.client === 'old-device') return;
    delete st.digest; delete st.build;
    oldPushes++;
    setTimeout(() => {
      cloud.val = { state: JSON.stringify(st), updatedAt: Date.now(), client: 'old-device' };
      cloud.writes++;
      cloud.listeners.forEach(cb => setTimeout(() => cb({ val: () => cloud.val }), 0));
    }, 5);
  };
  cloud.hooks.push(oldDevice);
  A.w.digestGet().enabled = true; A.w.saveToLocal(); await sleep(2500);
  eq(A.w.digestGet().enabled, true, 'A keeps digest enabled even though the old device stripped it');
  A.w.digestLoadSample(); await sleep(3000);
  ok(!!A.w.digestGet().last, 'A keeps the digest content');
  ok(!!B.w.digestGet().last, 'B (same build) keeps the digest content too');
  await sleep(4000);
  const pushesA = A.w.__stats.pushes, pushesB = B.w.__stats.pushes, oldP = oldPushes;
  await sleep(4000);
  ok(A.w.__stats.pushes === pushesA && B.w.__stats.pushes === pushesB && oldPushes === oldP, 'the loop stops: no more writes while idle');
  ok(A.w.eval('syncBouncing') || B.w.eval('syncBouncing'), 'a device flagged the bounce');
  const line = (A.w.eval('syncBouncing') ? A : B).d.getElementById('syncStatusLine') || (A.w.eval('syncBouncing') ? A : B).d.querySelector('[id*="yncStatus"]');
  ok(!line || /older version/.test(line.textContent), 'settings explains the other device is on an older version');
  ok(!!A.w.digestGet().last, 'A still has the digest after the loop stopped');
  cloud.hooks.length = 0;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
