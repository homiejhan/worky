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

  console.log('\n── 4. Phone asks, laptop runs, result syncs back ──');
  {
    cloud.val = null; cloud.listeners.length = 0; cloud.hooks.length = 0;
    /* laptop: runner with Ollama + Gmail (fake fetch) */
    const emails = { m1: { id: 'm1', internalDate: String(Date.now()), snippet: 'hi', payload: { headers: [{ name: 'From', value: 'Mom <mom@example.com>' }, { name: 'Subject', value: 'Dinner Sunday?' }], mimeType: 'text/plain', body: { data: Buffer.from('Dinner Sunday at 6 — reply!').toString('base64') } } } };
    const jsonRes = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
    let chatCalls = 0;
    const laptopFetch = async (url, o = {}) => {
      if (url.includes('/users/me/messages?')) return jsonRes({ messages: [{ id: 'm1' }] });
      if (/\/users\/me\/messages\/m1/.test(url)) return jsonRes(emails.m1);
      if (url.endsWith('/api/chat')) {
        chatCalls++; await sleep(1500);
        const sys = JSON.parse(o.body).messages[0].content;
        if (sys.startsWith('You turn a daily')) return jsonRes({ message: { content: '{"reasoning":"reply to mom","tasks":[{"title":"Reply to Mom about Sunday dinner","why":"Dinner at 6.","due":"","section":"misc"}]}' } });
        if (sys.startsWith('Below is today')) return jsonRes({ message: { content: '## 🔝 Top of the inbox\nOne email.\n\n## ✅ Action items\n- [ ] Reply to Mom' } });
        return jsonRes({ message: { content: '- **Mom** — dinner Sunday' } });
      }
      return jsonRes({}, 404);
    };
    const L = boot('laptop', {
      'focus-gmail-token': JSON.stringify({ access_token: 'tok', expires_at: Date.now() + 3600e3, email: 'me@example.com' }),
      'focus-digest-engine': JSON.stringify({ url: 'http://localhost:11434', model: 'qwen', autorun: true, deviceName: 'MacBook' }),
      'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: 'x' }),
    });
    L.w.fetch = laptopFetch;
    L.w.digestGet().enabled = true; L.w.saveToLocal();
    L.w.__signIn(); await sleep(80);
    /* phone: same state, no Ollama */
    const P = boot('phone', { 'focus-app-state': cloud.val.state, 'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: L.w.eval('syncHash(syncFingerprint(gatherState()))') }), 'focus-digest-engine': JSON.stringify({ deviceName: 'iPhone' }) });
    P.w.__signIn(); await sleep(120);
    P.w.renderHome();
    const btn = P.d.querySelector('#homeContainer-d .dg-actions .dg-btn');
    ok(btn && btn.textContent === 'Run on another device', 'phone offers Run on another device');
    ok(/can.t write the summary itself/.test(P.d.querySelector('#homeContainer-d .dg-empty-text')?.textContent || ''), 'phone explains why');
    btn.click();
    const req = P.w.digestGet().request;
    ok(req && req.status === 'pending' && req.by === 'iPhone', 'request created as pending by iPhone');
    ok(P.d.querySelector('#homeContainer-d .dg-spinner') && /Sent to your other device/.test(P.d.querySelector('#homeContainer-d .dg-status-text').textContent), 'phone shows the request as sent');
    await sleep(1900);   // debounce push + claim
    const lr = L.w.digestGet().request;
    ok(lr && (lr.status === 'running') && lr.runner === 'MacBook', 'laptop claimed the request and is running it');
    await sleep(1700);
    P.w.renderHome();
    console.log('    phone request:', JSON.stringify(P.w.digestGet().request), '| status text:', P.d.querySelector('#homeContainer-d .dg-status-text')?.textContent);
    ok(/MacBook is running it/.test(P.d.querySelector('#homeContainer-d .dg-status-text')?.textContent || ''), 'phone shows MacBook running with relayed progress');
    await sleep(4000);
    ok(!L.w.digestGet().request, 'laptop finished: request cleared');
    ok(L.w.digestGet().last && L.w.digestGet().last.source === 'remote', 'laptop result marked as run for another device');
    await sleep(2500);
    ok(!P.w.digestGet().request, 'phone: request cleared');
    ok(P.w.digestGet().last && /Mom/.test(P.w.digestGet().last.markdown), 'phone received the digest');
    eq(P.w.digestGet().suggestions.length, 1, 'phone received the suggested task');
    ok(P.d.querySelector('#homeContainer-d .dg-todo-add'), 'phone can Add it');
    ok(/from another device/.test(P.d.querySelector('#homeContainer-d .dg-meta').textContent), 'meta line says where it came from');
    ok(chatCalls >= 3, 'laptop did the model work');
    /* cancel path */
    P.w.digestRunNow();
    ok(P.w.digestGet().request && P.w.digestGet().request.status === 'pending', 'second request');
    P.w.digestRequestCancel();
    ok(!P.w.digestGet().request, 'cancelled before pickup');
    /* stale runner */
    P.w.digestGet().request = P.w.digestNormalizeRequest({ id: 5, at: Date.now() - 20 * 60000, by: 'iPhone', status: 'running', runner: 'MacBook', startedAt: Date.now() - 20 * 60000, updatedAt: Date.now() - 15 * 60000, phase: 'fetching' });
    P.w.renderHome();
    ok(/stopped responding/.test(P.d.querySelector('#homeContainer-d .dg-status-text')?.textContent || ''), 'a silent runner is reported after 10 minutes');
    P.w.digestRequestCancel();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
