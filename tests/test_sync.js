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
  ok(!!B.w.digestGet().last && B.w.digestGet().suggestions.length === 4, 'B received the sample digest with 4 suggestions');
  eq(A.w.__stats.applies, 0, 'A never had its own changes echoed back as a remote apply');
  eq(B.w.__stats.pushes, 0, 'B pushed nothing back after applying');
  A.w.digestAddTask(2); await sleep(2500);
  eq(B.w.eval('dbdTasks.length'), A.w.eval('dbdTasks.length'), 'added task reached B');
  ok(B.w.digestGet().suggestions[1].status === 'added' && B.w.dbdById(B.w.digestGet().suggestions[1].dbdId), 'B shows it as added');
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

  console.log('\n── 4. Backend delivers to digestInbox; both devices merge it; the next push clears it ──');
  {
    cloud.val = null; cloud.listeners.length = 0; cloud.hooks.length = 0;
    const L = boot('laptop', { 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: 'x' }) });
    L.w.digestGet().enabled = true; L.w.saveToLocal();
    L.w.__signIn(); await sleep(80);
    const P = boot('phone', { 'focus-app-state': cloud.val.state, 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: L.w.eval('syncHash(syncFingerprint(gatherState()))') }) });
    P.w.__signIn(); await sleep(120);
    eq(L.w.digestGet().last, null, 'laptop starts with no digest');
    eq(P.w.digestGet().last, null, 'phone starts with no digest');

    /* backend/digest.py: PUT users/<uid>/digestInbox — a sibling of `state`, never inside it */
    const at = Date.now();
    cloud.val = { ...cloud.val, digestInbox: { at, markdown: '## 🔝 Top of the inbox\nOne email.\n\n## 📬 Miscellaneous\n- **Mom** — dinner Sunday', count: 1, model: 'qwen3.5-4b', source: 'github',
      tasks: [{ title: 'Reply to Mom about Sunday dinner', why: 'Dinner at 6.', due: '', section: 'misc' }] } };
    cloud.listeners.forEach(cb => cb({ val: () => cloud.val }));
    await sleep(400);

    ok(!!L.w.digestGet().last && L.w.digestGet().last.at === at, 'laptop merged the delivered digest');
    ok(!!P.w.digestGet().last && P.w.digestGet().last.at === at, 'phone merged it too');
    eq(L.w.digestGet().last.source, 'github', 'source recorded as github');
    eq(L.w.digestGet().suggestions.length, 1, 'laptop pool has the suggestion');
    eq(P.w.digestGet().suggestions.length, 1, 'phone pool has the suggestion');
    ok(P.d.querySelector('#homeContainer-d .dg-todo-add'), 'phone shows Add on the card');
    eq(cloud.val.digestInbox, undefined, 'the next push rewrote the user node and cleared the inbox');
    ok(typeof cloud.val.state === 'string' && JSON.parse(cloud.val.state).digest.last.at === at, 'cloud state now carries the digest itself');
    ok(fpOf(L.w) === fpOf(P.w), 'both devices agree on the fingerprint (no ping-pong)');
    const pushesBefore = L.w.__stats.pushes + P.w.__stats.pushes;
    await sleep(600);
    eq(L.w.__stats.pushes + P.w.__stats.pushes, pushesBefore, 'and stop pushing');

    /* Add on the phone → the laptop sees it as added */
    P.w.digestAddTask(1); await sleep(2500);
    eq(L.w.digestGet().suggestions[0].status, 'added', 'laptop sees the phone added it');
    ok(!!L.w.dbdById(L.w.digestGet().suggestions[0].dbdId), 'the Day by Day task synced with it');

    /* A second delivery while the phone is asleep: only the newest is kept, nothing dupes */
    const at2 = at + 1000;
    cloud.val = { ...cloud.val, digestInbox: { at: at2, markdown: '## 🔝 Top of the inbox\nTwo emails.', count: 2, model: 'qwen3.5-4b', source: 'github',
      tasks: [{ title: 'Reply to Mom about Sunday dinner', why: '', due: '', section: 'misc' }, { title: 'Pay Austin Energy', why: 'due Friday', due: '', section: 'misc' }] } };
    cloud.listeners.forEach(cb => cb({ val: () => cloud.val }));
    await sleep(400);
    eq(L.w.digestGet().last.at, at2, 'second delivery replaced the first');
    eq(L.w.digestGet().suggestions.length, 2, 'repeated title skipped, new one added');
    eq(P.w.digestGet().suggestions.length, 2, 'phone converged');
    eq(cloud.val.digestInbox, undefined, 'inbox cleared again');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
