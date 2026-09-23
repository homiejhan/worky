/* Email digest — headless tests. Run: npm test (or node --experimental-vm-modules tests/test_digest.js).
 * The digest is built on GitHub and delivered through Firebase; these tests
 * cover the app side: state, the suggestion pool, rendering, delivery merge,
 * and the GitHub "Run now" trigger against a fake GitHub API. */
const { loadApp } = require('./load-app');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');   // repo root (tests live in tests/)

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot({ storage, url, fetchImpl } = {}) {
  return loadApp({ storage, url, before: w => {
    if (!w.TextDecoder) w.TextDecoder = TextDecoder;
    if (fetchImpl) w.fetch = fetchImpl;
    w.innerWidth = 1280;
  } });
}
const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jsonRes = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
const dbd = w => w.eval('dbdTasks');
const savedDigest = w => JSON.parse(w.localStorage.getItem('focus-app-state')).digest;


(async () => {   // the app boots asynchronously now (ES modules), so the checks run in here
console.log('\n── 0. Sample digest carries suggested tasks ──');
{
  const { w, d } = await boot();
  w.digestLoadSample();
  const sug = w.digestGet().suggestions;
  eq(sug.length, 4, 'sample adds 4 suggestions to the pool');
  ok(sug.every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.due)), 'sample relative dates resolved to real dates');
  eq(d.querySelectorAll('#homeContainer-d .dg-todo-add').length, 4, 'sample card shows 4 Add buttons');
  eq(d.querySelectorAll('#homeContainer-d .dg-todo-dismiss').length, 4, 'and 4 Dismiss buttons');
  w.digestLoadSample();
  eq(w.digestGet().suggestions.length, 4, 'loading the sample twice does not duplicate suggestions');
  ok(w.digestDismissTask(2), 'dismiss works');
  eq(d.querySelectorAll('#homeContainer-d .dg-todo').length, 3, 'dismissed row gone from the card');
  eq(w.digestGet().suggestions.find(x => x.id === 2).status, 'dismissed', 'kept in the pool as dismissed');
  w.digestLoadSample();
  eq(w.digestGet().suggestions.length, 4, 'a later run does not resurrect a dismissed title');
  eq(d.querySelectorAll('#homeContainer-d .dg-todo').length, 3, 'still hidden');
  eq(w.digestSugKey('Confirm Fabrikam recruiter screen!'), w.digestSugKey('  confirm fabrikam   recruiter screen'), 'title key ignores case/punctuation/spacing');
  eq(w.digestNormalizeDue('2099-01-01'), '', 'far-future dates dropped');
  eq(w.digestNormalizeDue('tomorrow'), (() => { const x = new Date(); x.setDate(x.getDate()+1); return w.calDateKey(x); })(), 'tomorrow resolves');
  eq(w.digestNormalizeDue('whenever'), '', 'unparseable → empty');
}

console.log('\n── 1. Default boot: digest off, nothing on Home, state carries the record ──');
{
  const { w, d } = await boot();
  eq(d.querySelector('.dg-section'), null, 'no digest card when disabled');
  w.saveToLocal();
  eq(savedDigest(w).enabled, false, 'saved state has digest.enabled=false');
  eq(savedDigest(w).last, null, 'saved state has digest.last=null');
  const c = w.compressState(w.gatherState());
  eq(JSON.stringify(c.dg), '{"en":0}', 'compressed form is tiny when empty');
}

console.log('\n── 2. Settings toggle shows the card; empty state explains GitHub + offers sample ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  const tog = d.getElementById('digestEnabledToggle');
  eq(tog.checked, false, 'toggle starts off');
  eq(d.getElementById('digestFields').style.display, 'none', 'fields hidden while off');
  tog.checked = true; tog.dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(d.getElementById('digestFields').style.display, '', 'fields shown when on');
  ok(d.querySelector('#homeContainer-d .dg-section'), 'card renders on desktop Home');
  ok(d.querySelector('#homeContainer-m .dg-section'), 'card renders on mobile Home');
  ok(d.querySelector('.dg-empty-text').textContent.includes('GitHub'), 'empty copy explains GitHub builds it');
  ok(d.querySelector('.dg-empty button[onclick^="openSettings("]'), 'Open Settings button present (no token yet)');
  ok(d.querySelector('.dg-btn[onclick="digestRunNow()"]'), 'Run now button offered');
  ok(d.querySelector('.dg-empty button[onclick="digestLoadSample()"]'), 'sample button present');
  eq(savedDigest(w).enabled, true, 'enabled persisted');
}

console.log('\n── 3. Sample digest renders every section, tables, code, task list ──');
{
  const { w, d } = await boot();
  w.digestLoadSample();
  const md = d.querySelector('#homeContainer-d .dg-md');
  ok(md, 'markdown body rendered');
  eq(md.querySelectorAll('h2').length, 6, 'six h2 headings (overview + 5 sections; actions became suggested tasks)');
  ok(md.querySelector('table'), 'job table rendered');
  eq(md.querySelectorAll('table tbody tr').length, 3, 'three job rows');
  ok(md.querySelector('pre code'), 'ASCII diagram in code block');
  eq(md.querySelectorAll('li.dg-task').length, 0, 'no checklist items in the markdown any more');
  eq(d.querySelectorAll('#homeContainer-d .dg-todo').length, 4, 'four suggested-task rows instead');
  ok(md.querySelector('a[href="https://example.com/pg18-async"]'), 'markdown link rendered');
  eq(md.querySelector('a').getAttribute('target'), '_blank', 'links open in a new tab');
  ok(d.querySelector('.dg-meta').textContent.includes('sample data'), 'meta line says sample data');
  ok(d.querySelector('.dg-meta').textContent.includes('23 emails'), 'meta line shows count');
  eq(savedDigest(w).last.source, 'sample', 'sample persisted to state');
  d.getElementById('settingsBtn').click();
  eq(d.getElementById('digestClearBtn').style.display, '', 'Clear digest button visible once a digest exists');
}

console.log('\n── 4. Renderer is safe: raw HTML and javascript: links are neutralised ──');
{
  const { w } = await boot();
  const out = w.digestRenderMd('# Hi <script>alert(1)</script>\n\n- [click](javascript:alert(1))\n- <img src=x onerror=alert(1)> **bold**\n\n| a | b |\n|---|---|\n| <b>x</b> | y |');
  ok(!out.includes('<script'), 'script tag escaped');
  ok(!out.includes('<img'), 'img tag escaped');
  ok(!out.includes('href="javascript'), 'javascript: link not turned into an anchor');
  ok(out.includes('<strong>bold</strong>'), 'bold still works');
  ok(out.includes('&lt;b&gt;x&lt;/b&gt;'), 'table cell HTML escaped');
  ok(out.startsWith('<h2>'), 'h1 in the digest renders as h2 inside the card');
}

console.log('\n── 5. Compress/decompress round trip keeps the digest ──');
{
  const { w } = await boot();
  w.digestLoadSample();
  const st = w.gatherState();
  const back = w.decompressState(w.compressState(st));
  eq(back.digest.enabled, true, 'enabled survives');
  eq(back.digest.last.markdown, st.digest.last.markdown, 'markdown survives');
  eq(back.digest.last.count, 23, 'count survives');
  eq(back.digest.last.model, 'sample', 'model survives');
  eq(back.digest.last.source, 'sample', 'source survives');
  const n = w.normalizeDigest({ enabled: 'yes', last: { markdown: '   ' } });
  eq(n.last, null, 'blank markdown normalises to no digest');
  eq(w.normalizeDigest(null).enabled, false, 'null normalises to disabled');
  const old = w.normalizeDigest({ enabled: true, schedule: { enabled: true, times: ['07:00'] }, lastScheduled: '2026-01-01 07:00', request: { id: 3 } });
  eq(old.schedule, undefined, 'legacy schedule field dropped');
  eq(old.request, undefined, 'legacy request field dropped');
  eq(JSON.stringify(w.compressDigest({ enabled: true, schedule: { enabled: true, times: ['07:00'] } })), '{"en":1}', 'legacy fields do not survive compression');
}

console.log('\n── 6. Reload persistence + a synced copy shows up on another device ──');
{
  const a = await boot();
  a.w.digestLoadSample();
  const raw = a.w.localStorage.getItem('focus-app-state');
  const b = await boot({ storage: { 'focus-app-state': raw } });
  ok(b.d.querySelector('#homeContainer-d .dg-md'), 'second device renders the digest from state alone');
  eq(b.w.digestGithubGet().token, '', 'GitHub token is device-local (not carried by state)');
  ok(b.d.querySelector('.dg-btn[onclick="digestRunNow()"]'), 'Run now still offered');
}

console.log('\n── 7. Delivered digest (users/<uid>/digestInbox) merges like a run ──');
{
  const { w, d } = await boot();
  const inbox = (at, n) => ({ at, markdown: `## 🔝 Top of the inbox\nrun ${n}\n\n## 📰 Tech News (TLDR)\n- a story`, count: 12, model: 'qwen3.5-4b', source: 'github',
    tasks: [{ title: `Reply to Acme recruiter ${n}`, why: 'asked for times', due: '2026-09-22', section: 'jobs' }, { title: 'Pay the water bill', why: '', due: 'garbage', section: 'nope' }] });
  w.eval('syncReconciled = false');
  w.digestInboxSeen(inbox(1000, 1));
  eq(w.digestGet().last, null, 'held until the sync baseline is settled');
  w.eval('syncReconciled = true; syncPendingRemote = { state: "{}", updatedAt: 1 }');
  w.digestInboxFlush();
  eq(w.digestGet().last, null, 'held while the Import/Export modal is open');
  w.eval('syncPendingRemote = null'); w.digestInboxFlush();
  const dg = w.digestGet();
  ok(dg.enabled && dg.last && dg.last.source === 'github' && dg.last.count === 12, 'digest.last taken from the inbox and the card enabled');
  eq(dg.suggestions.length, 2, 'both tasks entered the pool');
  eq(dg.suggestions[0].due, '2026-09-22', 'valid due kept');
  eq(dg.suggestions[1].due, '', 'invalid due dropped');
  eq(dg.suggestions[1].section, 'nope', 'section ids are kept as delivered (the backend validates them against its section list)');
  ok(d.querySelector('#homeContainer-d .dg-todo-add'), 'home card shows Add buttons');
  ok(d.querySelector('#homeContainer-d .dg-meta').textContent.includes('GitHub'), 'meta line says GitHub');
  w.digestInboxSeen(inbox(1000, 1));
  eq(w.digestGet().suggestions.length, 2, 'same inbox again is ignored');
  w.digestInboxSeen(inbox(900, 0));
  eq(w.digestGet().last.at, 1000, 'older inbox ignored');
  w.digestInboxSeen(inbox(2000, 2));
  eq(w.digestGet().last.at, 2000, 'newer inbox applied');
  eq(w.digestGet().suggestions.length, 3, 'new title added, duplicate skipped');
  [null, 'x', {}, { at: 1, markdown: '' }, { at: 0, markdown: 'hi' }].forEach(v => w.digestInboxSeen(v));
  eq(w.digestGet().last.at, 2000, 'garbage inboxes ignored');
  w.eval('syncOnRemoteValue({ val: () => ({ state: JSON.stringify(gatherState()), updatedAt: 1, client: syncClientId, digestInbox: ' + JSON.stringify(inbox(3000, 3)) + ' }) })');
  eq(w.digestGet().last.at, 3000, 'listener hook merges digestInbox from the user node');
  d.getElementById('settingsBtn').click();
  ok(d.getElementById('digestStatusLine').textContent.startsWith('Last digest:'), 'settings status line shows the last digest');

  /* the inbox now stays in the cloud, so Clear has to remember how far it cleared */
  ok(!('clearedAt' in w.gatherState().digest), 'no clearedAt until something is cleared (older states keep their fingerprint)');
  w.digestClearLast();
  eq(w.digestGet().last, null, 'Clear digest empties the card');
  eq(w.digestGet().clearedAt, 3000, 'and records how far it cleared');
  w.digestInboxSeen(inbox(3000, 3));
  eq(w.digestGet().last, null, 'the same delivery does not come back');
  const rt = w.decompressState(JSON.parse(JSON.stringify(w.compressState(w.gatherState())))).digest;
  eq(rt.clearedAt, 3000, 'clearedAt survives compress → decompress');
  eq(savedDigest(w).clearedAt, 3000, 'and is saved with the state');
  w.digestInboxSeen(inbox(4000, 4));
  eq(w.digestGet().last.at, 4000, 'a newer delivery still lands');

  /* Settings says which account digests arrive through */
  const hint = d.getElementById('digestSyncHint');
  ok(hint && /not signed in/i.test(hint.textContent) && hint.classList.contains('warn'), 'signed out: the hint says digests cannot reach this device');
  w.eval("syncUser = { uid: 'u1', email: 'me@example.com' }; digestRenderSettings();");
  ok(/me@example\.com/.test(hint.textContent) && !hint.classList.contains('warn'), 'signed in: the hint names the sync account');
  w.eval('syncUser = null');
}

console.log('\n── 8. Add / Dismiss / Add all against the pool ──');
{
  const { w, d } = await boot();
  w.digestLoadSample();
  const first = w.digestGet().suggestions[0];
  const before = w.eval('dbdTasks.length');
  ok(w.digestAddTask(first.id), 'Add returns true');
  eq(w.eval('dbdTasks.length'), before + 1, 'a Day by Day task was created');
  eq(w.digestGet().suggestions[0].status, 'added', 'suggestion marked added');
  ok(d.querySelector('#homeContainer-d .dg-todo.added .dg-todo-added'), 'row shows Added ✓');
  eq(w.digestAddTask(first.id), false, 'adding twice is a no-op');
  w.digestAddAllTasks();
  eq(w.digestVisibleSuggestions().filter(t => !w.digestTaskIsAdded(t)).length, 0, 'Add all clears the remaining ones');
  w.eval('dbdTasks = dbdTasks.filter(t => t.id !== ' + first.id + ' + 0 * ' + w.digestGet().suggestions[0].dbdId + ')');
  w.eval('dbdTasks = dbdTasks.filter(t => t.id !== ' + w.digestGet().suggestions[0].dbdId + ')');
  w.renderHome();
  ok(d.querySelector(`#homeContainer-d .dg-todo[data-dgt="${first.id}"] .dg-todo-add`), 'deleting the task re-offers the suggestion');
}

console.log('\n── 8a. Redundancy: how two titles are scored ──');
{
  const { w } = await boot();
  const sc = (a, b) => w.digestDupScore(a, b);
  const FLAG = w.eval('DIGEST_DUP_FLAG');
  [ ['Finish the Northwind Labs online assessment', 'Northwind OA'],
    ['Pay the water bill', 'water bill'],
    ['Confirm Fabrikam recruiter screen', 'Fabrikam interview'],
    ['Submit ECE 460 homework 3', 'ECE 460 HW 3'],
    ['Respond to the Saturday study group invite', 'RSVP study group'],
    ['Renew Autodesk ambassador agreement', 'Autodesk ambassador renewal'],
    ['Email Acme', 'Acme'],
  ].forEach(([a, b]) => ok(sc(a, b) >= FLAG, `same task: "${a}" ↔ "${b}" (${sc(a, b).toFixed(2)})`));
  [ ['Submit ECE 460 homework 3', 'ECE 460 HW 4'],
    ['Reply to Acme recruiter 1', 'Reply to Acme recruiter 2'],
    ['Renew gym membership', 'Gym'],
    ['Pay the water bill', 'Pay the electric bill'],
    ['Complete Northwind Labs assessment', 'Complete Fabrikam Labs assessment'],
    ['Schedule Northwind interview', 'Confirm Northwind interview time'],
    ['Accept the Contoso offer', 'Decline the Contoso offer'],
    ['Confirm Fabrikam recruiter screen', 'Fabrikam interview prep'],
    ['Reply to Acme recruiter', 'Morning Workout/Stretch'],
  ].forEach(([a, b]) => ok(sc(a, b) < FLAG, `different task: "${a}" ↔ "${b}" (${sc(a, b).toFixed(2)})`));
  eq(sc('Pay the water bill!', '  pay the   WATER bill'), 1, 'same words → 1');
  ok(sc('Finish the assessment by Sep 24 at 5pm', 'Finish the assessment by 9/30 at 11:59 PM') > 0.99, 'dates and times inside a title are ignored');
  const c = w.digestDupCompare('Complete Northwind assessment', 'Complete Northwind assessment round 2');
  ok(c.score >= FLAG && c.both < w.eval('DIGEST_DUP_POOL'), 'a longer title that contains a shorter one: flaggable, but never merged silently');
}

console.log('\n── 8b. Redundancy: a suggestion that repeats an existing task is flagged, not added ──');
{
  const { w, d } = await boot();
  const day = n => { const x = new Date(); x.setDate(x.getDate() + n); return w.calDateKey(x); };
  w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: 'Northwind OA', due: '${day(1)}', done: false })`);
  w.eval(`todoLists.push({ id: todoIdCounter++, title: 'Bills', color: '#378ADD', isDefault: false, tasks: [{ id: taskIdCounter++, text: 'water bill', done: false }] })`);
  w.eval('syncReconciled = true');
  w.digestInboxSeen({ at: 5000, markdown: '## 🔝 Top of the inbox\nhi', count: 9, model: 'qwen3.5-4b', source: 'github', tasks: [
    { title: 'Finish the Northwind Labs online assessment', why: 'Closes tomorrow at 5pm.', due: day(1), section: 'jobs' },
    { title: 'Pay the water bill', why: 'Due Friday.', due: '', section: 'misc' },
    { title: 'Confirm Fabrikam recruiter screen', why: 'Thursday 10am.', due: '', section: 'jobs' },
    { title: 'Reply to Dr. Patel', why: 'Appointment confirmation.', due: '', section: 'misc' },
  ] });
  const sug = w.digestGet().suggestions;
  eq(sug.length, 4, 'all four still enter the pool — nothing is hidden');
  ok(d.getElementById('toast').textContent.includes('2 already on your lists'), 'delivery toast says how many already exist');
  const H = '#homeContainer-d ';
  eq(d.querySelectorAll(H + '.dg-todo.dup').length, 2, 'two rows flagged');
  const rows = [...d.querySelectorAll(H + '.dg-todo')];
  ok(!rows[0].classList.contains('dup') && !rows[1].classList.contains('dup') && rows[2].classList.contains('dup') && rows[3].classList.contains('dup'), 'flagged rows sink below the new ones');
  const nw = d.querySelector(H + `.dg-todo[data-dgt="${sug[0].id}"]`);
  ok(nw.querySelector('.dg-todo-dup').textContent.includes('\u201cNorthwind OA\u201d'), 'flag names the existing task');
  ok(nw.querySelector('.dg-todo-dup').textContent.includes('Day by Day') && nw.querySelector('.dg-todo-dup').textContent.includes('Tomorrow'), 'and where / when it is');
  eq(nw.querySelector('.dg-todo-add').textContent, 'Add anyway', 'its button reads Add anyway');
  const wb = d.querySelector(H + `.dg-todo[data-dgt="${sug[1].id}"] .dg-todo-dup`).textContent;
  ok(wb.startsWith('Already on your list:') && wb.includes('Bills'), 'near-identical title in a custom list → "Already on your list" + the list name');
  eq(d.querySelector(H + '.dg-todos-count').textContent, '2', 'count badge only counts the new ones');
  ok(d.querySelector(H + '.dg-todo-addall').textContent.includes('(2)'), 'Add all (2)');
  const before = dbd(w).length;
  w.digestAddAllTasks();
  eq(dbd(w).length, before + 2, 'Add all adds only the two new ones');
  eq(dbd(w).filter(t => /northwind/i.test(t.text)).length, 1, 'no second Northwind task');
  ok(d.getElementById('toast').textContent.includes('skipped 2'), 'toast says what was skipped');
  eq(d.querySelector(H + '.dg-todos-count').textContent, 'nothing new', 'badge: nothing new');
  eq(d.querySelector(H + '.dg-todo-addall'), null, 'Add all gone');
  w.digestAddAllTasks();
  eq(dbd(w).length, before + 2, 'Add all again still adds nothing');

  ok(w.digestAddTask(sug[0].id), 'Add anyway still works');
  eq(dbd(w).filter(t => /northwind/i.test(t.text)).length, 2, 'it created the task the user asked for');
  ok(d.querySelector(H + `.dg-todo[data-dgt="${sug[0].id}"].added`), 'and the row is Added ✓');

  w.eval(`todoLists.find(l => l.title === 'Bills').tasks = []`);
  w.renderHome();
  eq(d.querySelector(H + `.dg-todo[data-dgt="${sug[1].id}"].dup`), null, 'deleting the existing task clears the flag (nothing is stored)');
  eq(d.querySelector(H + `.dg-todo[data-dgt="${sug[1].id}"] .dg-todo-add`).textContent, 'Add', 'button back to Add');
  eq(savedDigest(w).suggestions.every(x => !('dup' in x) && !('match' in x)), true, 'no match data in synced state');
}

console.log('\n── 8c. Redundancy: finished tasks only count while they are recent ──');
{
  const { w, d } = await boot();
  const day = n => { const x = new Date(); x.setDate(x.getDate() + n); return w.calDateKey(x); };
  w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: 'Pay the water bill', due: '${day(-31)}', done: true, doneOn: '${day(-30)}' })`);
  w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: 'Fabrikam phone screen', due: '${day(-1)}', done: true, doneOn: '${day(-1)}' })`);
  w.eval('syncReconciled = true');
  w.digestInboxSeen({ at: 6000, markdown: '## 🔝 Top of the inbox\nhi', count: 2, model: 'm', source: 'github', tasks: [
    { title: 'Pay the water bill', why: '', due: '', section: 'misc' },
    { title: 'Confirm Fabrikam recruiter screen', why: '', due: '', section: 'jobs' } ] });
  const sug = w.digestGet().suggestions;
  eq(d.querySelector(`#homeContainer-d .dg-todo[data-dgt="${sug[0].id}"].dup`), null, "last month's finished bill does not block this month's");
  const f = d.querySelector(`#homeContainer-d .dg-todo[data-dgt="${sug[1].id}"] .dg-todo-dup`);
  ok(f && f.textContent.startsWith('Looks like') && f.textContent.includes('done \u2713'), "yesterday's finished task does — a loose match only says \"Looks like … done ✓\"");
  w.eval(`dbdTasks.push({ id: dbdIdCounter++, text: 'pay the water bill', due: '${day(0)}', done: true, doneOn: '${day(0)}' })`);
  w.renderHome();
  const g = d.querySelector(`#homeContainer-d .dg-todo[data-dgt="${sug[0].id}"] .dg-todo-dup`);
  ok(g && g.textContent.startsWith('Already done:'), 'the same title ticked off today → "Already done"');
}

console.log('\n── 8d. Redundancy: the same suggestion in other words does not enter the pool twice ──');
{
  const { w } = await boot();
  w.eval('syncReconciled = true');
  const send = (at, tasks) => w.digestInboxSeen({ at, markdown: '## 🔝 Top of the inbox\nrun ' + at, count: 5, model: 'm', source: 'github', tasks });
  send(1000, [{ title: 'Finish the Northwind Labs online assessment', why: '', due: '', section: 'jobs' }]);
  send(2000, [{ title: 'Complete Northwind Labs HackerRank assessment', why: 'Closes Friday.', due: '2026-09-25', section: 'jobs' }]);
  let pool = w.digestGet().suggestions;
  eq(pool.length, 1, 'reworded repeat skipped while the first is pending');
  eq(pool[0].title, 'Finish the Northwind Labs online assessment', 'the original wording stays');
  eq(pool[0].due, '2026-09-25', 'but it picks up the due date the repeat knew');
  eq(pool[0].why, 'Closes Friday.', 'and the reason');
  w.digestDismissTask(pool[0].id);
  send(3000, [{ title: 'Complete the Northwind Labs online assessment', why: '', due: '', section: 'jobs' }]);
  eq(w.digestGet().suggestions.length, 1, 'a dismissed suggestion does not come back reworded');
  send(4000, [{ title: 'Schedule Northwind Labs interview', why: '', due: '', section: 'jobs' },
              { title: 'Complete Northwind Labs assessment round 2', why: '', due: '', section: 'jobs' }]);
  eq(w.digestGet().suggestions.length, 3, 'a different step with the same company, and a "round 2", are both new');
  send(5000, [{ title: 'Pay the water bill', why: '', due: '', section: 'misc' }, { title: 'Pay water bill to City of Austin', why: '', due: '', section: 'misc' }]);
  eq(w.digestGet().suggestions.filter(x => /water/i.test(x.title)).length, 2, 'only near-identical wording merges silently; the rest stays visible');
}

console.log('\n── 8e. Redundancy: tagging an added task into a list keeps it Added ✓ ──');
{
  const { w, d } = await boot();
  w.digestLoadSample();
  const first = w.digestGet().suggestions[0];
  w.digestAddTask(first.id);
  w.eval(`todoLists.push({ id: todoIdCounter++, title: 'Job hunt', color: '#378ADD', isDefault: false, tasks: [] })`);
  w.tagDbdTask(first.dbdId, String(w.eval('todoLists[todoLists.length - 1].id')));
  eq(w.eval('dbdById(' + first.dbdId + ')'), undefined, 'tagging moved the task out of dbdTasks');
  ok(w.digestTaskIsAdded(first), 'still counts as added');
  eq(d.querySelector(`#homeContainer-d .dg-todo[data-dgt="${first.id}"] .dg-todo-add`), null, 'no Add button offered for it');
  w.eval(`todoLists[todoLists.length - 1].tasks = []`);
  w.renderHome();
  ok(d.querySelector(`#homeContainer-d .dg-todo[data-dgt="${first.id}"] .dg-todo-add`), 'deleting the moved task re-offers it, as before');
}

/* ── 10. Prompt editor (Settings → Email Digest → Prompts) ── */
async function promptTests() {
  console.log('\n── 10. Prompt editor: originals from backend/prompts.json, edits to users/<uid>/digestPrompts ──');
  const defaults = JSON.parse(fs.readFileSync(path.join(DIR, 'backend', 'prompts.json'), 'utf8'));
  let fetches = [];
  const fakeFetch = async url => {
    fetches.push(String(url));
    if (/backend\/prompts\.json$/.test(url)) return jsonRes(defaults);
    return jsonRes({}, 404);
  };
  const { w, d } = await boot({ fetchImpl: fakeFetch });
  const $ = id => d.getElementById(id);
  eq(JSON.stringify(Object.keys(defaults)), '["rules","overview","tasks","sections"]', 'prompts.json has the three prompts and the section list');
  eq(defaults.sections.map(s => s.id).join(','), 'tldr,bytebytego,newsletter,jobs,misc', 'five original sections in digest order');
  const py = fs.readFileSync(path.join(DIR, 'backend', 'digest.py'), 'utf8');
  ok(/PROMPT_KEYS = \["rules", "overview", "tasks"\]/.test(py), 'digest.py knows the same three prompt keys');
  ok(/def classify\(e, sections\)/.test(py), 'digest.py routes with the section list');

  eq(fetches.length, 0, 'nothing fetched at boot');
  w.openSettings('digest');
  ok($('digestPromptEditor').hidden, 'editor starts collapsed');
  eq(fetches.length, 0, 'opening Settings alone fetches nothing');
  $('digestPromptToggleBtn').click();
  ok(!$('digestPromptEditor').hidden, 'Edit prompts expands it');
  ok(fetches.some(u => /backend\/prompts\.json$/.test(u)), 'originals fetched on first expand');
  await sleep(10);
  const optionText = () => Array.from($('digestPromptSelect').options).map(o => o.textContent);
  eq($('digestPromptSelect').options.length, 8, 'rules + five sections + overview + tasks');
  eq(optionText()[1], '📰 Tech News (TLDR)', 'sections listed by title, after the shared rules');
  eq($('digestPromptText').value, defaults.rules, 'shows the original shared rules');
  ok($('digestPromptSectionFields').hidden, 'no section fields for a plain prompt');
  ok($('digestPromptText').readOnly && $('digestPromptSaveBtn').disabled, 'read-only while signed out');
  ok($('digestPromptStatus').textContent.startsWith('Sign in to cloud sync'), 'says why');
  ok(!$('digestPromptExportBtn').disabled, 'Export works signed out (it only reads)');

  /* sign in with a fake ref */
  const writes = []; let reject = null;
  w.__fakeRef = {
    child: k => ({ set: v => { writes.push([k, v === null ? null : JSON.parse(JSON.stringify(v))]); return reject ? Promise.reject(reject) : Promise.resolve(); } }),
    update: () => Promise.resolve(), off() {},
  };
  w.eval(`syncUser = { uid: 'u1', email: 'me@example.com' }; syncRef = window.__fakeRef;`);
  w.digestRenderSettings();
  ok($('digestPromptStatus').textContent.startsWith('Loading your saved prompts'), 'waits for the listener before allowing saves');
  w.digestPromptsSeen(null);
  eq($('digestPromptStatus').textContent, 'Original prompt.', 'no edits → Original prompt');
  ok(!$('digestPromptText').readOnly, 'editable once signed in');
  ok($('digestPromptSaveBtn').disabled && $('digestPromptResetBtn').disabled, 'Save and Reset idle until something changes');

  const pick = key => { const sel = $('digestPromptSelect'); sel.value = key; sel.dispatchEvent(new w.Event('change')); };
  const type = (id, text) => { const el = $(id); el.value = text; el.dispatchEvent(new w.Event('input')); };
  const tick = (id, on) => { const el = $(id); el.checked = on; el.dispatchEvent(new w.Event('change')); };
  const last = () => writes[writes.length - 1][1];

  /* a plain prompt */
  pick('tasks');
  eq($('digestPromptText').value, defaults.tasks, 'switching shows that prompt');
  ok(defaults.tasks.includes('{sections}'), 'tasks prompt carries the {sections} placeholder');
  type('digestPromptText', 'Only urgent replies.');
  eq($('digestPromptStatus').textContent, 'Unsaved changes.', 'typing marks it unsaved');
  w.confirm = () => false;
  pick('rules');
  eq($('digestPromptSelect').value, 'tasks', 'declining the discard keeps you on the edited prompt');
  w.confirm = () => true;
  $('digestPromptSaveBtn').click(); await sleep(5);
  eq(writes.length, 1, 'one write');
  eq(writes[0][0], 'digestPrompts', 'to users/<uid>/digestPrompts');
  eq(JSON.stringify(Object.keys(last())), '["tasks","updatedAt"]', 'only the edited prompt is stored, flat, with updatedAt');
  eq(last().tasks, 'Only urgent replies.', 'with the text');
  ok($('digestPromptStatus').textContent.startsWith('Edited, saved'), 'status says edited');
  eq($('toast').textContent, 'Prompt saved. The next digest run uses it.', 'toast confirms');

  /* a section: rename, keywords, flags */
  pick('section:jobs');
  ok(!$('digestPromptSectionFields').hidden, 'section fields appear');
  eq($('digestPromptTitle').value, '💼 Job Application Updates', 'title filled');
  ok($('digestPromptKeywords').value.startsWith('application, applied'), 'keywords filled');
  ok($('digestPromptBody').checked && !$('digestPromptLists').checked, 'flags filled');
  ok($('digestPromptHint').textContent.startsWith('Section 4 of 5'), 'position shown');
  eq($('digestPromptSaveBtn').textContent, 'Save section', 'button names the thing');
  type('digestPromptTitle', '💼 Recruiting');
  type('digestPromptKeywords', 'recruiter, interview, offer*');
  tick('digestPromptBody', false);
  eq($('digestPromptStatus').textContent, 'Unsaved changes.', 'field edits count as changes');
  $('digestPromptSaveBtn').click(); await sleep(5);
  const node = last();
  eq(node.sections.length, 5, 'the whole section list is stored once a section changes');
  eq(node.sections[3].title, '💼 Recruiting', 'renamed');
  eq(JSON.stringify(node.sections[3].keywords), '["recruiter","interview","offer*"]', 'keywords split and trimmed');
  eq(node.sections[3].body, false, 'flag saved');
  eq(node.sections[3].id, 'jobs', 'id stays put on rename');
  eq(node.sections[3].budget, 5000, 'budget carried over');
  eq(node.sections[0].title, '📰 Tech News (TLDR)', 'untouched sections stored as the originals');
  eq(node.tasks, 'Only urgent replies.', 'the earlier prompt edit is kept alongside');
  eq(optionText()[4], '💼 Recruiting (edited)', 'picker shows the new title, marked edited');
  eq($('toast').textContent, 'Section saved. The next digest run uses it.', 'toast confirms');

  /* reorder, add, delete */
  $('digestPromptUpBtn').click(); await sleep(5);
  eq(last().sections.map(s => s.id).join(','), 'tldr,bytebytego,jobs,newsletter,misc', 'Move up swaps with the one above');
  eq($('digestPromptSelect').value, 'section:jobs', 'selection follows the section');
  ok($('digestPromptHint').textContent.startsWith('Section 3 of 5'), 'position updates');
  $('digestPromptNewBtn').click(); await sleep(5);
  eq(last().sections.length, 6, 'New section appends one');
  eq(last().sections[5].id, 'section-1', 'with a fresh id');
  eq($('digestPromptSelect').value, 'section:section-1', 'and selects it');
  eq($('digestPromptTitle').value, 'New section', 'placeholder title');
  eq(optionText()[6], 'New section (new)', 'marked new in the picker');
  eq($('digestPromptResetBtn').textContent, 'Discard changes', 'no original to reset a new section to');
  type('digestPromptTitle', '🏃 Fitness'); type('digestPromptKeywords', 'strava, garmin'); type('digestPromptText', 'Summarize training mail.');
  $('digestPromptSaveBtn').click(); await sleep(5);
  eq(last().sections[5].title, '🏃 Fitness', 'new section saved');
  ok($('digestPromptStatus').textContent.startsWith('Your section, saved'), 'status for an added section');
  $('digestPromptDownBtn').disabled || $('digestPromptDownBtn').click();
  ok($('digestPromptDownBtn').disabled, 'cannot move the last section down');
  $('digestPromptUpBtn').click(); await sleep(5);
  eq(last().sections.map(s => s.id).join(','), 'tldr,bytebytego,jobs,newsletter,section-1,misc', 'moved above the catch-all');
  pick('section:bytebytego');
  $('digestPromptDeleteBtn').click(); await sleep(5);
  eq(last().sections.map(s => s.id).join(','), 'tldr,jobs,newsletter,section-1,misc', 'Delete removes it');
  eq($('digestPromptSelect').value, 'section:jobs', 'selection moves to the next section');

  /* reset one section, then the empty and back-to-original cases */
  pick('section:jobs');
  $('digestPromptResetBtn').click(); await sleep(5);
  eq(last().sections[1].title, '💼 Job Application Updates', 'Reset restores the original section in place');
  eq(last().sections[1].body, true, 'including its flags');
  eq($('digestPromptKeywords').value.split(', ').length, defaults.sections[3].keywords.length, 'keywords back');
  type('digestPromptText', '   ');
  $('digestPromptSaveBtn').click();
  ok($('toast').textContent.includes('needs a prompt'), 'an empty section prompt is refused');
  type('digestPromptText', defaults.sections[3].prompt);
  pick('tasks');
  type('digestPromptText', defaults.tasks + '\n');
  $('digestPromptSaveBtn').click(); await sleep(5);
  eq(last().tasks, undefined, 'saving the original text drops that edit instead of storing a copy');
  ok(Array.isArray(last().sections), 'while the section list stays');

  /* export → import round trip */
  const md = w.digestPromptsExportText();
  ok(md.startsWith('# Worky digest prompts'), 'export has a title');
  eq((md.match(/^## Section: /gm) || []).length, 5, 'one block per section');
  ok(md.includes('## Section: 🏃 Fitness\nid: section-1\nkeywords: strava, garmin\nsearch body: no\nmailing lists: no\nbudget: 8000\n\n```text\nSummarize training mail.\n```'), 'section block carries id, keywords, flags, budget and prompt');
  ok(md.includes('## Suggested tasks\nkey: tasks\n\n```text\n' + defaults.tasks + '\n```'), 'prompt blocks carry their key');
  const parsed = w.digestPromptsParseMd(md);
  ok(!parsed.error, 'export parses back');
  eq(JSON.stringify(parsed.flat.sections), JSON.stringify(w.digestPromptSections()), 'sections survive the round trip exactly');
  eq(parsed.flat.rules, defaults.rules, 'and the prompts');
  eq(w.digestPromptsParseMd('# nothing here').error, 'No "## Section:" blocks found. Export a copy first to see the format.', 'a file with no sections is refused');
  ok(/has no prompt/.test(w.digestPromptsParseMd('## Section: Empty\nid: e\n\n```text\n\n```').error), 'a section without a prompt is refused');
  const custom = '## Shared rules\nkey: rules\n\n```text\nBe brief.\n```\n\n## Section: Everything\n\n```text\nOne line per email.\n```\n\n## Section: Work\nkeywords: jira, github\nsearch body: yes\n\n```text\nWork mail.\n```\n';
  await w.digestPromptImportText(custom, 'mine.md');
  eq(last().rules, 'Be brief.', 'import stores the prompt from the file');
  eq(last().tasks, undefined, 'a prompt the file leaves out goes back to the original');
  eq(last().sections.map(s => s.id).join(','), 'everything,work', 'sections from the file, ids slugged from titles when missing');
  eq(last().sections[1].body, true, 'yes/no flags read');
  eq($('toast').textContent, 'Imported mine.md. The next digest run uses it.', 'toast confirms');
  eq($('digestPromptSelect').options.length, 5, 'picker now lists the two imported sections');

  /* a remote update, the real listener path, and rollback */
  pick('section:work');
  type('digestPromptText', 'Draft in progress');
  w.digestPromptsSeen({ sections: [{ id: 'work', title: 'Work', prompt: 'Work mail.' }, { id: 'rest', title: 'Rest', prompt: 'r', keywords: [] }], updatedAt: 9 });
  eq($('digestPromptText').value, 'Draft in progress', 'a remote update never overwrites unsaved typing');
  w.digestPromptsSeen({ sections: [{ id: 'rest', title: 'Rest', prompt: 'r' }], bogus: 'x', updatedAt: 10 });
  eq($('digestPromptSelect').value, 'rules', 'when the shown section is deleted elsewhere the editor falls back to the rules');
  w.eval('syncReconciled = true');
  w.syncOnRemoteValue({ val: () => ({ digestPrompts: { overview: 'Overview via listener', updatedAt: 3 } }) });
  pick('overview');
  eq($('digestPromptText').value, 'Overview via listener', 'syncOnRemoteValue feeds the editor');
  eq($('digestPromptSelect').options.length, 8, 'no stored sections → the originals are back');
  reject = { code: 'PERMISSION_DENIED', message: 'permission_denied' };
  type('digestPromptText', 'Will fail');
  $('digestPromptSaveBtn').click(); await sleep(5);
  eq(w.digestPromptText('overview'), 'Overview via listener', 'failed write rolled back');
  eq($('digestPromptText').value, 'Will fail', 'the typed text is kept after a failed save');
  ok($('toast').textContent.includes('database rules'), 'permission error explained');
  reject = null;
  type('digestPromptText', 'Overview via listener');

  /* restore all, then sign out */
  $('digestPromptRestoreAllBtn').click(); await sleep(5);
  eq(last(), null, 'Restore all removes the node');
  w.syncStop();
  w.eval('syncUser = null');
  w.digestRenderSettings();
  eq(w.eval('digestPromptsSaved'), undefined, 'sign-out forgets the account\'s prompts');
  ok($('digestPromptStatus').textContent.startsWith('Sign in to cloud sync'), 'and asks to sign in again');

  /* originals unavailable */
  const b2 = await boot({ fetchImpl: async () => { throw new Error('offline'); } });
  b2.w.openSettings('digest');
  b2.d.getElementById('digestPromptToggleBtn').click();
  await sleep(10);
  ok(b2.d.getElementById('digestPromptStatus').textContent.startsWith('Could not load the original prompts'), 'offline → clear error');
  ok(b2.d.getElementById('digestPromptSaveBtn').disabled, 'and nothing can be saved over a missing original');

  /* tasks keep whatever section id the backend used */
  eq(w.digestNormalizeTasks([{ title: 'A', section: 'fitness' }, { title: 'B', section: 'Nope!' }], false).map(t => t.section).join(','), 'fitness,misc', 'custom section ids on tasks are kept, junk falls back to misc');
}

console.log('\n── 9. Run now: token gate, dispatch, watch the run, delivery ends it ──');
{
  const calls = [];
  let runsResponse = { workflow_runs: [] };
  const fakeFetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', auth: opts && opts.headers && opts.headers.Authorization });
    if (/dispatches$/.test(url)) return { status: 204, ok: true, json: async () => ({}) };
    if (/\/runs\?/.test(url)) return { status: 200, ok: true, json: async () => runsResponse };
    return { status: 404, ok: false, json: async () => ({}) };
  };
  const { w, d } = await boot({ fetchImpl: fakeFetch });
  w.eval('DIGEST_RUN_POLL_MS = 5');
  w.digestGet().enabled = true; w.renderHome();
  w.digestRunNow();
  eq(calls.length, 0, 'no token → nothing dispatched');
  ok(d.getElementById('settingsModal').classList.contains('show'), 'no token → Settings opened');
  ok(d.getElementById('digestRunSettingsBtn').disabled, 'Run button disabled in Settings without a token');
  const inp = d.getElementById('digestGithubToken');
  inp.value = 'github_pat_TEST'; d.getElementById('digestGithubSaveBtn').click();
  eq(JSON.parse(w.localStorage.getItem('focus-digest-github')).token, 'github_pat_TEST', 'token saved device-locally');
  eq(inp.value, '••••••••••••', 'field shows a mask, not the token');
  ok(!d.getElementById('digestRunSettingsBtn').disabled, 'Run button enabled with a token');
  w.closeModal('settingsModal');
  const t0 = Date.now();
  const run = w.digestRunNow();
  run.then(async () => {
    const disp = calls.find(c => /dispatches$/.test(c.url));
    ok(disp && disp.method === 'POST', 'workflow_dispatch POSTed');
    ok(disp && disp.url.includes('/repos/homiejhan/worky/actions/workflows/digest.yml/dispatches'), 'to the right workflow');
    eq(disp && disp.auth, 'Bearer github_pat_TEST', 'with the token');
    ok(d.querySelector('#homeContainer-d .dg-run'), 'run status line shown on the card');
    eq(d.querySelector('#homeContainer-d .dg-btn[onclick="digestRunNow()"]'), null, 'Run now hidden while busy');
    runsResponse = { workflow_runs: [{ status: 'in_progress', conclusion: null, html_url: 'https://github.com/homiejhan/worky/actions/runs/1', created_at: new Date(t0).toISOString(), run_started_at: new Date(t0).toISOString() }] };
    await sleep(60);
    ok(d.querySelector('#homeContainer-d .dg-run').textContent.includes('Running on GitHub'), 'status reflects in_progress');
    ok(d.querySelector('#homeContainer-d .dg-run a[href="https://github.com/homiejhan/worky/actions/runs/1"]'), 'link to the run');
    ok(JSON.parse(w.localStorage.getItem('focus-digest-run')).status === 'in_progress', 'watched run persisted for reloads');
    runsResponse = { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'https://github.com/homiejhan/worky/actions/runs/1', created_at: new Date(t0).toISOString(), run_started_at: new Date(t0).toISOString() }] };
    await sleep(40);
    ok(d.querySelector('#homeContainer-d .dg-run').textContent.includes('arriving'), 'success → waiting for delivery');
    w.eval('syncReconciled = true');
    w.digestInboxSeen({ at: Date.now(), markdown: '## 🔝 Top of the inbox\nhi', count: 3, model: 'qwen3.5-4b', source: 'github', tasks: [] });
    eq(d.querySelector('#homeContainer-d .dg-run'), null, 'delivery clears the run status');
    eq(w.localStorage.getItem('focus-digest-run'), null, 'and the persisted run');
    ok(d.querySelector('#homeContainer-d .dg-btn[onclick="digestRunNow()"]'), 'Run now back');

    /* failure path */
    runsResponse = { workflow_runs: [] };
    await w.digestRunNow();
    runsResponse = { workflow_runs: [{ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/homiejhan/worky/actions/runs/2', created_at: new Date().toISOString(), run_started_at: new Date().toISOString() }] };
    await sleep(60);
    ok(d.querySelector('#homeContainer-d .dg-run.err'), 'failed run shows an error line');
    ok(d.querySelector('#homeContainer-d .dg-run .dg-run-x'), 'with a dismiss button');
    w.digestRunDismiss();
    eq(d.querySelector('#homeContainer-d .dg-run'), null, 'dismiss clears it');

    /* rejected token */
    w.fetch = async (url, opts) => (/dispatches$/.test(url) ? { status: 401, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ workflow_runs: [] }) });
    await w.digestRunNow();
    ok(d.querySelector('#homeContainer-d .dg-run.err').textContent.includes('rejected the token'), '401 explains the token problem');
    w.digestRunDismiss();

    /* remove token */
    d.getElementById('settingsBtn').click();
    d.getElementById('digestGithubSaveBtn').click();
    eq(w.localStorage.getItem('focus-digest-github'), null, 'Remove clears the token');

    await promptTests();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }).catch(e => { console.error(e); process.exit(1); });
}
})().catch(e => { console.error(e); process.exit(1); });
