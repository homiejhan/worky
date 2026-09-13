/* Email digest — headless tests (node test_digest.js; needs `npm i jsdom`). */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '')
  .replace(/<link[^>]*fonts\.googleapis[^>]*>/g, '');
const appJs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot({ storage, url, fetchImpl } = {}) {
  const dom = new JSDOM(html, { url: url || 'https://localhost/worky/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  if (storage) Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  Object.defineProperty(w, 'confirm', { value: () => true, writable: true, configurable: true });
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
  if (fetchImpl) w.fetch = fetchImpl;
  w.innerWidth = 1280;
  const s = w.document.createElement('script');
  s.textContent = appJs;
  w.document.body.appendChild(s);
  return { dom, w, d: w.document };
}
const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jsonRes = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
const dbd = w => w.eval('dbdTasks');
const savedDigest = w => JSON.parse(w.localStorage.getItem('focus-app-state')).digest;
const token = () => JSON.stringify({ access_token: 'tok', expires_at: Date.now() + 3600e3, email: 'me@example.com' });

console.log('\n── 0. Sample digest carries suggested tasks ──');
{
  const { w, d } = boot();
  w.digestLoadSample();
  const last = w.digestGet().last;
  eq(last.tasks.length, 4, 'sample has 4 suggested tasks');
  ok(last.tasks.every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.due)), 'sample relative dates resolved to real dates');
  eq(d.querySelectorAll('#homeContainer-d .dg-todo-add').length, 4, 'sample card shows 4 Add buttons');
  eq(w.digestNormalizeDue('2099-01-01'), '', 'far-future dates dropped');
  eq(w.digestNormalizeDue('tomorrow'), (() => { const x = new Date(); x.setDate(x.getDate()+1); return w.digestDateKey(x); })(), 'tomorrow resolves');
  eq(w.digestNormalizeDue('whenever'), '', 'unparseable → empty');
  eq(w.digestParseTasks('not json'), null, 'parse returns null on garbage');
  eq(w.digestParseTasks('{"tasks":"nope"}'), null, 'parse returns null when tasks is not an array');
}

console.log('\n── 1. Default boot: digest off, nothing on Home, state carries the record ──');
{
  const { w, d } = boot();
  eq(d.querySelector('.dg-section'), null, 'no digest card when disabled');
  w.saveToLocal();
  eq(savedDigest(w).enabled, false, 'saved state has digest.enabled=false');
  eq(savedDigest(w).last, null, 'saved state has digest.last=null');
  const c = w.compressState(w.gatherState());
  eq(JSON.stringify(c.dg), '{"en":0}', 'compressed form is tiny when empty');
}

console.log('\n── 2. Settings toggle shows the card; empty state offers Connect + sample ──');
{
  const { w, d } = boot();
  d.getElementById('settingsBtn').click();
  const tog = d.getElementById('digestEnabledToggle');
  eq(tog.checked, false, 'toggle starts off');
  eq(d.getElementById('digestFields').style.display, 'none', 'fields hidden while off');
  tog.checked = true; tog.dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(d.getElementById('digestFields').style.display, '', 'fields shown when on');
  ok(d.querySelector('#homeContainer-d .dg-section'), 'card renders on desktop Home');
  ok(d.querySelector('#homeContainer-m .dg-section'), 'card renders on mobile Home');
  ok(d.querySelector('.dg-empty-text').textContent.includes('Connect Gmail'), 'empty copy invites connecting Gmail');
  ok(d.querySelector('.dg-empty button[onclick="gmailConnect()"]'), 'Connect Gmail button present');
  ok(d.querySelector('.dg-empty button[onclick="digestLoadSample()"]'), 'sample button present');
  eq(savedDigest(w).enabled, true, 'enabled persisted');
}

console.log('\n── 3. Sample digest renders every section, tables, code, task list ──');
{
  const { w, d } = boot();
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
  const { w } = boot();
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
  const { w } = boot();
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
}

console.log('\n── 6. Reload persistence + a synced copy shows up on another device ──');
{
  const a = boot();
  a.w.digestLoadSample();
  const raw = a.w.localStorage.getItem('focus-app-state');
  const b = boot({ storage: { 'focus-app-state': raw } });
  ok(b.d.querySelector('#homeContainer-d .dg-md'), 'second device renders the digest from state alone');
  eq(b.w.gmailIsConnected(), false, 'gmail token is device-local (not carried by state)');
  ok(b.d.querySelector('.dg-btn[onclick="digestRunNow()"]'), 'Run button still offered (it explains what is missing)');
}

console.log('\n── 7. OAuth redirect with the gmail state tag is routed to Gmail, not Calendar ──');
{
  const { w, d } = boot({ url: 'https://localhost/worky/#access_token=abc&expires_in=3599&state=worky-gmail&token_type=Bearer' });
  eq(w.gmailIsConnected(), true, 'gmail token stored');
  eq(w.gcalIsConnected(), false, 'calendar did not grab the token');
  ok(JSON.parse(w.localStorage.getItem('focus-gmail-token')).access_token === 'abc', 'token persisted device-locally');
  eq(savedDigest(w).enabled, true, 'connecting turns the card on');
  eq(w.location.hash, '', 'hash cleaned');
  ok(d.querySelector('.dg-empty-text').textContent.includes('Pick the Ollama model'), 'next step is picking a model');
}

console.log('\n── 8. Full pipeline against a fake Gmail + fake Ollama ──');
{
  const calls = [];
  const emails = {
    m1: { id: 'm1', internalDate: String(Date.now() - 3600e3), payload: { mimeType: 'multipart/alternative', headers: [
      { name: 'From', value: 'TLDR <dan@tldrnewsletter.com>' }, { name: 'Subject', value: 'TLDR 2026-09-07' }],
      parts: [{ mimeType: 'text/html', body: { data: b64url('<html><body><h2>Big Story</h2><p>Postgres 18 ships.</p><a href="https://example.com/pg">Read more</a><style>.x{}</style></body></html>') } }] } },
    m2: { id: 'm2', internalDate: String(Date.now() - 7200e3), payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Northwind Recruiting <talent@northwind.example>' }, { name: 'Subject', value: 'Your application: next steps' }],
      body: { data: b64url('Please complete the assessment by Friday.') } } },
    m3: { id: 'm3', internalDate: String(Date.now() - 1800e3), payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Shop <deals@shop.example>' }, { name: 'Subject', value: '50% off everything — last chance' }],
      body: { data: b64url('Buy now.') } } },
    m4: { id: 'm4', internalDate: String(Date.now() - 900e3), payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Mom <mom@example.com>' }, { name: 'Subject', value: 'Dinner Sunday?' }],
      body: { data: b64url('Are you free Sunday at 6?') } } },
  };
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('/users/me/messages?')) { await sleep(8); return jsonRes({ messages: Object.keys(emails).map(id => ({ id })) }); }
    const mm = url.match(/\/users\/me\/messages\/(\w+)\?/);
    if (mm) return mm[1] === 'm3' ? jsonRes(emails.m3) : jsonRes(emails[mm[1]]);
    if (url.endsWith('/api/tags')) return jsonRes({ models: [{ name: 'qwen2.5:14b' }, { name: 'llama3.1:8b' }] });
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(opts.body);
      const sys = body.messages[0].content;
      const user = body.messages[1].content;
      if (sys.startsWith('Below is today')) return jsonRes({ message: { content: '## 🔝 Top of the inbox\nTwo things matter.\n\n## ✅ Action items\n- [ ] Finish the Northwind assessment by Friday' } });
      if (sys.startsWith('You turn a daily email digest')) {
        ok(body.format === 'json', 'tasks call asks Ollama for JSON');
        ok(/^Today is \d{4}-\d{2}-\d{2} \(\w+\)\./.test(user), 'tasks call is given today\'s date');
        ok(user.includes('- [ ] Finish the Northwind assessment by Friday'), 'tasks call sees the overview checklist');
        return jsonRes({ message: { content: '```json\n{"reasoning":"Northwind needs the assessment; Mom needs a reply.","tasks":[{"title":"Finish the Northwind assessment","why":"Due Friday.","due":"friday","section":"jobs"},{"title":"Reply to Mom about Sunday dinner","why":"Dinner Sunday at 6.","due":"1999-01-01","section":"misc"},{"title":"Finish the Northwind assessment","why":"dupe","due":"","section":"jobs"},{"title":"","why":"blank","due":"","section":"misc"}]}\n```' } });
      }
      if (sys.includes('Section: 📰')) { ok(user.includes('Read more (https://example.com/pg)') && !user.includes('.x{}'), 'html email became text with links kept, styles dropped'); return jsonRes({ message: { content: '- **Postgres 18 ships** — async I/O. [Read](https://example.com/pg)' } }); }
      if (sys.includes('Section: 💼')) return jsonRes({ message: { content: '⚠️ **Northwind** assessment due Friday\n\n| Company | Role | Status | Action needed | Deadline |\n|---|---|---|---|---|\n| **Northwind** | — | Assessment | Complete it | Friday |' } });
      if (sys.includes('Section: 📬')) return jsonRes({ message: { content: '- **Mom** — dinner Sunday at 6 — reply needed' } });
      return jsonRes({ message: { content: 'unexpected section' } });
    }
    return jsonRes({}, 404);
  };
  const { w, d } = boot({ storage: { 'focus-gmail-token': token() }, fetchImpl });
  w.digestGet().enabled = true; w.saveToLocal(); w.renderHome();
  d.getElementById('settingsBtn').click();
  await_(async () => {
    await w.digestTestEngine();
    const sel = d.getElementById('digestModelSelect');
    eq(sel.options.length, 2, 'Test lists the models Ollama has');
    eq(JSON.parse(w.localStorage.getItem('focus-digest-engine')).model, 'qwen2.5:14b', 'first model picked and saved device-locally');
    ok(d.getElementById('digestEngineStatus').textContent.includes('2 models'), 'status line reports the count');
    w.closeModal('settingsModal');

    const run = w.digestRunNow();
    await sleep(5);
    ok(d.querySelector('.dg-spinner'), 'spinner shows while running');
    await run;
    const chat = calls.filter(c => c.url.endsWith('/api/chat'));
    eq(chat.length, 5, 'three section calls (tldr, jobs, misc) + overview + tasks — promo skipped, empty sections skipped');
    ok(chat.every(c => JSON.parse(c.opts.body).model === 'qwen2.5:14b'), 'model passed to every call');
    ok(calls.some(c => c.url.includes('newer_than%3A24h')), 'gmail query uses the 24h window');
    ok(calls.filter(c => /messages\/\w+\?format=full/.test(c.url)).every(c => c.opts.headers.Authorization === 'Bearer tok'), 'bearer token sent');
    const last = savedDigest(w).last;
    ok(last && last.markdown.includes('## 📰 Tech News (TLDR)') && last.markdown.includes('## 🏗️ ByteByteGo\n_Nothing today_'), 'assembled digest keeps every section, empty ones say Nothing today');
    ok(last.markdown.startsWith('## 🔝 Top of the inbox'), 'overview first');
    ok(!last.markdown.includes('## ✅'), 'checklist no longer lives in the markdown (it became suggested tasks)');
    eq(last.tasks.length, 2, 'tasks parsed from fenced JSON, duplicate and blank dropped');
    eq(last.tasks[0].title, 'Finish the Northwind assessment', 'first task kept in model order');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(last.tasks[0].due) && new Date(last.tasks[0].due + 'T00:00:00').getDay() === 5, '"friday" resolved to the next Friday');
    eq(last.tasks[1].due, w.dbdTodayKey(), 'a past due date is clamped to today');
    eq(last.tasks[1].section, 'misc', 'section preserved');
    eq(d.querySelectorAll('#homeContainer-d .dg-todo').length, 2, 'card lists the suggested tasks');
    eq(d.querySelectorAll('#homeContainer-d .dg-todo-add').length, 2, 'each has its own Add button');
    ok(d.querySelector('#homeContainer-d .dg-todo-addall'), 'Add all offered when more than one remains');

    /* add one */
    const dbdBefore = dbd(w).length;
    d.querySelector('#homeContainer-d .dg-todo[data-dgt="1"] .dg-todo-add').click();
    eq(dbd(w).length, dbdBefore + 1, 'Add creates one Day by Day task');
    const made = dbd(w)[dbd(w).length - 1];
    eq(made.text, 'Finish the Northwind assessment', 'task text = suggestion title');
    eq(made.due, last.tasks[0].due, 'task due = suggestion due');
    eq(made.done, false, 'not done');
    eq(savedDigest(w).last.tasks[0].added, made.id, 'suggestion remembers which dbd task it became (synced)');
    eq(d.querySelectorAll('#homeContainer-d .dg-todo-add').length, 1, 'that Add button becomes Added ✓');
    ok(d.querySelector('#homeContainer-d .dg-todo[data-dgt="1"].added'), 'row marked added');
    eq(d.querySelector('#homeContainer-d .dg-todo-addall'), null, 'Add all hidden with one left');
    eq(w.digestAddTask(1), false, 'adding the same suggestion twice is a no-op');
    eq(dbd(w).length, dbdBefore + 1, 'still one task');

    /* delete the dbd task → suggestion is offerable again */
    w.removeDbdTask(made.id);
    w.renderHome();
    eq(d.querySelectorAll('#homeContainer-d .dg-todo-add').length, 2, 'removing the created task re-enables Add');

    /* add all */
    w.digestAddAllTasks();
    eq(dbd(w).length, dbdBefore + 2, 'Add all adds every remaining suggestion');
    eq(d.querySelectorAll('#homeContainer-d .dg-todo-add').length, 0, 'no Add buttons left');
    ok(d.querySelector('#homeContainer-d .dg-todos-count').textContent.includes('all added'), 'count reads all added');

    /* state round trip keeps tasks and their added links */
    const raw = w.localStorage.getItem('focus-app-state');
    const { w: w2, d: d2 } = boot({ storage: { 'focus-app-state': raw } });
    const t2 = w2.digestGet().last.tasks;
    eq(t2.length, 2, 'tasks survive reload');
    ok(t2.every(x => x.added && w2.dbdById(x.added)), 'added links survive reload and still resolve');
    eq(d2.querySelectorAll('#homeContainer-d .dg-todo.added').length, 2, 'reloaded card shows both as added');
    eq(last.count, 4, 'count = emails processed');
    eq(last.model, 'qwen2.5:14b', 'model recorded');
    eq(last.source, 'laptop', 'source recorded');
    ok(d.querySelector('#homeContainer-d .dg-md table'), 'card shows the rendered result');
    eq(d.querySelector('.dg-spinner'), null, 'spinner gone');

    /* tasks call breaks (garbage output) → checklist fallback, digest still succeeds */
    w.fetch = async (url, o = {}) => {
      if (url.endsWith('/api/chat') && JSON.parse(o.body).messages[0].content.startsWith('You turn a daily')) return jsonRes({ message: { content: 'sorry, no json here' } });
      return fetchImpl(url, o);
    };
    await w.digestRunNow();
    const fb = savedDigest(w).last.tasks;
    eq(fb.length, 1, 'fallback: tasks parsed from the overview checklist');
    eq(fb[0].title, 'Finish the Northwind assessment by Friday', 'fallback title = checklist line');
    eq(fb[0].due, '', 'fallback has no due date');
    w.fetch = fetchImpl;

    /* engine unreachable → readable error with a Settings shortcut */
    w.fetch = async (url) => { if (url.includes('/users/me/messages')) return fetchImpl(url, { headers: {} }); throw new TypeError('Failed to fetch'); };
    await w.digestRunNow();
    ok(d.querySelector('.dg-status.error') && d.querySelector('.dg-status.error').textContent.includes("Can't reach Ollama"), 'engine failure surfaces on the card');
    ok(d.querySelector('.dg-status.error button[onclick="openSettings()"]'), 'error offers Settings');
    ok(d.querySelector('#homeContainer-d .dg-md'), 'previous digest still shown under the error');
    w.digestDismissError();
    eq(d.querySelector('.dg-status.error'), null, 'error dismissed');

    /* expired Gmail session → token dropped, Connect offered */
    w.fetch = async (url) => url.includes('/users/me/messages') ? jsonRes({ error: 'x' }, 401) : jsonRes({});
    await w.digestRunNow();
    eq(w.gmailIsConnected(), false, '401 clears the token');
    ok(d.querySelector('.dg-status.error button[onclick="gmailConnect()"]'), 'error offers Connect Gmail');

    /* classify + clean helpers */
    eq(w.digestClassify({ from: 'x@bytebytego.com', subject: 'How Discord stores messages', text: '' }), 'bytebytego', 'bytebytego routed');
    eq(w.digestClassify({ from: 'news@substack.com', subject: 'Weekly', text: '' }), 'newsletter', 'newsletter routed');
    eq(w.digestClassify({ from: 'a@b.c', subject: 'Hello', listId: '<list.example>', text: '' }), 'newsletter', 'List-Id counts as newsletter');
    eq(w.digestClassify({ from: 'a@b.c', subject: 'Interview scheduling', text: '' }), 'jobs', 'jobs routed');
    eq(w.digestClassify({ from: 'a@b.c', subject: 'Flash sale', text: '' }), 'skip', 'promo skipped');
    eq(w.digestClassify({ from: 'a@b.c', subject: 'Receipt', text: 'thanks' }), 'misc', 'misc default');
    eq(w.digestChunk([{ text: 'a'.repeat(10000) }, { text: 'b'.repeat(10000) }, { text: 'c'.repeat(100) }], 14000).length, 2, 'chunking respects the per-call budget');

    /* collapse persists device-locally, digest still in state */
    w.digestLoadSample();
    d.querySelector('#homeContainer-d .dg-chev').click();
    eq(d.querySelector('#homeContainer-d .dg-md'), null, 'collapsed hides the body');
    ok(d.querySelector('#homeContainer-d .dg-chev.closed'), 'chevron rotated');
    eq(JSON.parse(w.localStorage.getItem('focus-digest-ui')).collapsed, true, 'collapse persisted');
    ok(savedDigest(w).last, 'digest still in state while collapsed');
    w.digestClearLast();
    eq(savedDigest(w).last, null, 'Clear digest removes it');
    ok(d.querySelector('.dg-empty'), 'empty state returns');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
}
function await_(fn) { fn().catch(e => { console.error(e); process.exit(1); }); }
