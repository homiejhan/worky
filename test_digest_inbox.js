/* Backend-delivered digest (users/<uid>/digestInbox) — headless tests. */
const { JSDOM } = require('jsdom');
const fs = require('fs'); const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/g, '').replace(/<link[^>]*fonts\.googleapis[^>]*>/g, '');
const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);
function boot() {
  const dom = new JSDOM(html, { url: 'https://localhost/worky/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w, 'confirm', { value: () => true, writable: true, configurable: true });
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  w.innerWidth = 1280;
  const s = w.document.createElement('script'); s.textContent = appJs; w.document.body.appendChild(s);
  return { w, d: w.document };
}
const inbox = (at, n) => ({ at, markdown: `## 🔝 Top of the inbox\nrun ${n}\n\n## 📰 Tech News (TLDR)\n- a story`, count: 12, model: 'qwen3.5-4b', source: 'github',
  tasks: [{ title: `Reply to Acme recruiter ${n}`, why: 'asked for times', due: '2026-09-22', section: 'jobs' }, { title: 'Pay the water bill', why: '', due: 'garbage', section: 'nope' }] });

console.log('\n── 1. Inbox merges like a local run once reconciled ──');
{
  const { w, d } = boot();
  w.eval('syncReconciled = true');
  w.digestInboxSeen(inbox(1000, 1));
  const dg = w.digestGet();
  ok(dg.last && dg.last.source === 'github' && dg.last.count === 12, 'digest.last taken from the inbox');
  eq(dg.suggestions.length, 2, 'both tasks entered the pool');
  eq(dg.suggestions[0].due, '2026-09-22', 'valid due kept');
  eq(dg.suggestions[1].due, '', 'invalid due dropped');
  eq(dg.suggestions[1].section, 'misc', 'unknown section → misc');
  ok(d.querySelector('#homeContainer-d .dg-todo-add'), 'home card shows Add buttons');
  ok(JSON.parse(w.localStorage.getItem('focus-app-state')).digest, 'saved to local state');
  w.digestInboxSeen(inbox(1000, 1));
  eq(w.digestGet().suggestions.length, 2, 'same inbox again is ignored (same at)');
  w.digestInboxSeen(inbox(900, 0));
  eq(w.digestGet().last.at, 1000, 'older inbox ignored');
  w.digestInboxSeen(inbox(2000, 2));
  eq(w.digestGet().last.at, 2000, 'newer inbox applied');
  eq(w.digestGet().suggestions.length, 3, 'new title added, duplicate water bill skipped');
}
console.log('\n── 2. Held until the sync baseline is settled ──');
{
  const { w } = boot();
  w.eval('syncReconciled = false');
  w.digestInboxSeen(inbox(1000, 1));
  eq(w.digestGet().last, null, 'not applied before reconcile');
  w.eval('syncReconciled = true; syncPendingRemote = { state: "{}", updatedAt: 1 }');
  w.digestInboxFlush();
  eq(w.digestGet().last, null, 'not applied while the Import/Export modal is open');
  w.eval('syncPendingRemote = null');
  w.digestInboxFlush();
  ok(w.digestGet().last && w.digestGet().last.at === 1000, 'applied once the choice is made');
}
console.log('\n── 3. Garbage is ignored ──');
{
  const { w } = boot(); w.eval('syncReconciled = true');
  [null, 'x', {}, { at: 1, markdown: '' }, { at: 0, markdown: 'hi' }].forEach(v => w.digestInboxSeen(v));
  eq(w.digestGet().last, null, 'no digest from bad inboxes');
}
console.log('\n── 4. Listener hook fires from a value snapshot ──');
{
  const { w } = boot();
  w.eval('syncReconciled = true');
  w.eval('syncOnRemoteValue({ val: () => ({ state: JSON.stringify(gatherState()), updatedAt: 1, client: syncClientId, digestInbox: ' + JSON.stringify(inbox(3000, 3)) + ' }) })');
  ok(w.digestGet().last && w.digestGet().last.at === 3000, 'digestInbox on the user node is merged');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
