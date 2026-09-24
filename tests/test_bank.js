/* Bank connections: the relay in backend/bank against a fake Plaid, in-process and
 * over HTTP, check.mjs from start to finish, and Settings → Bank accounts in the app.
 * Plaid itself is never called: tests/fake-plaid.js answers in its shapes.
 * Run: npm test -- bank (or node --experimental-vm-modules tests/test_bank.js) */
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { loadApp, ROOT } = require('./load-app');
const { createFakePlaid } = require('./fake-plaid');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  return fn();
}

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const ENV = { PLAID_CLIENT_ID: 'test-client', PLAID_SECRET: 'test-secret', PLAID_ENV: 'sandbox', RELAY_KEY: KEY,
  ALLOWED_ORIGINS: 'https://homiejhan.github.io, http://localhost:8080' };

(async () => {
  const { handle } = await import(pathToFileURL(path.join(ROOT, 'backend/bank/relay.mjs')).href);
  const plaid = createFakePlaid();
  const call = async (route, body, { env = ENV, origin, method } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    const req = new Request(`https://relay.example/${route}`, body === undefined && !method
      ? { method: 'GET', headers }
      : { method: method || 'POST', headers, body: method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify(body ?? {}) });
    const res = await handle(req, env, plaid.fetchImpl);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, headers: res.headers, data };
  };
  const lastCall = p => [...plaid.state.calls].reverse().find(c => c.path === p);

  console.log('\n── 1. Relay settings and who may call it ──');
  {
    let r = await call('health');
    ok(r.status === 200 && r.data.ok && r.data.env === 'sandbox' && r.data.redirect === false, 'health: set up, sandbox, no OAuth redirect');
    r = await call('health', undefined, { env: { PLAID_ENV: 'sandbox' } });
    ok(!r.data.ok && r.data.problems.length === 3, `health names what is missing: ${r.data.problems.join('; ')}`);
    ok(!JSON.stringify(await call('health')).includes('test-secret'), 'health never shows a secret');
    r = await call('link-token', { user: 'device-12345678' }, { env: { PLAID_ENV: 'sandbox' } });
    ok(r.status === 500 && r.data.error.code === 'RELAY_NOT_CONFIGURED', 'an unconfigured relay refuses work with a clear error');

    r = await call('health', undefined, { method: 'OPTIONS', origin: 'https://homiejhan.github.io' });
    ok(r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://homiejhan.github.io', 'preflight from an allowed origin passes');
    r = await call('accounts', { token: 'x' }, { origin: 'https://evil.example' });
    ok(r.status === 403 && r.data.error.code === 'ORIGIN_NOT_ALLOWED', 'a page from any other origin is refused');
    r = await call('health', undefined, { origin: 'https://relay.example' });
    eq(r.status, 200, 'the relay\'s own origin is always allowed');
    r = await call('health', undefined, { origin: 'http://localhost:8080' });
    eq(r.headers.get('access-control-allow-origin'), 'http://localhost:8080', 'every listed origin gets CORS headers');
    r = await call('nope', {});
    eq(r.status, 404, 'unknown endpoint → 404');
    r = await call('accounts', undefined, { method: 'GET' });
    eq(r.status, 405, 'wrong method → 405');
    r = await handle(new Request('https://relay.example/accounts', { method: 'POST', body: '[1,2]' }), ENV, plaid.fetchImpl);
    eq(r.status, 400, 'a body that is not a JSON object → 400');
  }

  console.log('\n── 2. Link token: what the relay asks Plaid for ──');
  {
    let r = await call('link-token', { user: 'device-12345678' });
    ok(r.status === 200 && /^link-sandbox-/.test(r.data.link_token), 'returns Plaid\'s link token');
    const sent = lastCall('/link/token/create').body;
    ok(sent.client_id === 'test-client' && sent.secret === 'test-secret', 'with the keys (added by the relay, never by the app)');
    eq(sent.products.join(), 'transactions', 'asks for transactions only');
    eq(sent.country_codes.join(), 'US', 'US banks');
    eq(sent.user.client_user_id, 'device-12345678', 'identifies the user by a random device id, nothing personal');
    eq(sent.transactions.days_requested, 30, 'and only 30 days of history');
    ok(!('redirect_uri' in sent), 'no redirect URI unless one is configured');
    await call('link-token', { user: 'device-12345678' }, { env: { ...ENV, PLAID_REDIRECT_URI: 'https://homiejhan.github.io/worky/' } });
    eq(lastCall('/link/token/create').body.redirect_uri, 'https://homiejhan.github.io/worky/', 'PLAID_REDIRECT_URI is passed on for OAuth banks');
    r = await call('link-token', { user: 'x' });
    eq(r.status, 400, 'a missing or odd device id → 400');
  }

  console.log('\n── 3. Exchange and the sealed token ──');
  let token;
  {
    const r = await call('exchange', { public_token: 'public-sandbox-1' });
    ok(r.status === 200 && r.data.item_id, 'exchange returns the item id');
    token = r.data.token;
    ok(/^v1\.[\w-]+\.[\w-]+$/.test(token), 'and a sealed token');
    const access = [...plaid.state.items.keys()].pop();
    ok(!token.includes(access) && !Buffer.from(token.split('.')[2], 'base64').toString('latin1').includes(access), 'the token does not contain Plaid\'s access token');
    let bad = await call('exchange', { public_token: 'garbage' });
    ok(bad.status === 400 && bad.data.error.code === 'INVALID_PUBLIC_TOKEN', 'Plaid\'s error code comes through');
    bad = await call('accounts', { token: token.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A') + token.slice(-1) });
    ok(bad.status === 401 && bad.data.error.code === 'TOKEN_INVALID', 'a tampered token is refused');
    bad = await call('accounts', { token }, { env: { ...ENV, RELAY_KEY: OTHER_KEY } });
    eq(bad.status, 401, 'a token from a relay with another RELAY_KEY is refused');
    bad = await call('accounts', { token }, { env: { ...ENV, PLAID_ENV: 'production' } });
    eq(bad.status, 401, 'a sandbox token is refused in production (the seal is bound to the environment)');
    bad = await call('accounts', {});
    eq(bad.status, 401, 'no token → 401');
  }

  console.log('\n── 4. Accounts, transactions, removal ──');
  {
    let r = await call('accounts', { token });
    eq(r.data.accounts.length, 3, 'three sandbox accounts');
    const chk = r.data.accounts[0];
    ok(chk.name === 'Plaid Checking' && chk.mask === '0000' && chk.current === 110 && chk.available === 100 && chk.currency === 'USD', 'names, masks, balances and currency');
    eq(r.data.institution_id, 'ins_109508', 'and the bank');
    eq(Object.keys(chk).sort().join(), 'available,currency,current,id,limit,mask,name,official_name,subtype,type', 'nothing else is passed on');

    r = await call('transactions', { token, cursor: '' });
    eq(r.data.added.length, 7, 'all pages in one answer (Plaid paged 4 + 3)');
    eq(plaid.state.calls.filter(c => c.path === '/transactions/sync').length, 2, 'two sync calls');
    const pay = r.data.added.find(t => t.id === 'tx-4');
    ok(pay.amount === -232.5 && pay.name === 'Campus Café payroll' && pay.category === 'INCOME', 'amounts keep Plaid\'s sign (negative = money in)');
    eq(r.data.next_cursor, 'cursor-7', 'returns the cursor for next time');
    eq(r.data.status, 'HISTORICAL_UPDATE_COMPLETE', 'and Plaid\'s update status');
    const cursor = r.data.next_cursor;
    r = await call('transactions', { token, cursor });
    eq(r.data.added.length, 0, 'nothing new since the cursor');

    plaid.state.mutateOnce = true;
    plaid.state.pageSize = 3;
    const t2 = (await call('exchange', { public_token: 'public-sandbox-2' })).data.token;
    r = await call('transactions', { token: t2, cursor: '' });
    ok(r.status === 200 && r.data.added.length === 7, 'data changing mid-paging: restarts once from the first cursor');

    plaid.state.failNext = { path: '/accounts/get', error_code: 'ITEM_LOGIN_REQUIRED', display_message: 'Log in to your bank again.' };
    r = await call('accounts', { token });
    ok(r.status === 400 && r.data.error.code === 'ITEM_LOGIN_REQUIRED' && r.data.error.message === 'Log in to your bank again.', 'a bank that needs a new login: code and Plaid\'s own message');
    plaid.state.failNext = { path: '/accounts/get', status: 500, error_code: 'INTERNAL_SERVER_ERROR', error_type: 'API_ERROR' };
    r = await call('accounts', { token });
    eq(r.status, 502, 'Plaid down → 502');

    r = await call('remove', { token });
    ok(r.status === 200 && r.data.removed, 'remove ends the connection at Plaid');
    r = await call('accounts', { token });
    ok(r.status === 400 && r.data.error.code === 'INVALID_ACCESS_TOKEN', 'after which the token is dead');
  }

  console.log('\n── 5. dev-server.mjs: the app and the relay on one local address ──');
  {
    const fake = createFakePlaid();
    const upstream = await fake.listen();
    const { createServer } = await import(pathToFileURL(path.join(ROOT, 'backend/bank/dev-server.mjs')).href);
    const server = createServer({ ...ENV, PLAID_API_BASE: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let res = await fetch(`${base}/`);
    ok(res.status === 200 && (await res.text()).includes('js/main.js'), 'serves the app');
    res = await fetch(`${base}/js/main.js`);
    ok(res.status === 200 && /javascript/.test(res.headers.get('content-type')), 'modules with a JavaScript type');
    for (const bad of ['/..%2Fpackage.json', '/backend/bank/.env.example', '/node_modules/jsdom/package.json']) {
      res = await fetch(base + bad);
      eq(res.status, 404, `nothing outside the app or hidden: ${bad}`);
    }
    const post = async (route, body) => (await fetch(`${base}/api/bank/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })).json();
    res = await fetch(`${base}/api/bank/health`);
    ok((await res.json()).ok, 'relay health over HTTP');
    const { token: t } = await post('exchange', { public_token: 'public-sandbox-9' });
    const acc = await post('accounts', { token: t });
    eq(acc.accounts.length, 3, 'exchange → accounts over HTTP, through the real relay code');
    const tx = await post('transactions', { token: t, cursor: '' });
    eq(tx.added.length, 7, 'transactions over HTTP');
    server.close(); upstream.close();
  }

  console.log('\n── 6. check.mjs, start to finish ──');
  {
    const fake = createFakePlaid();
    const upstream = await fake.listen();
    const out = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(ROOT, 'backend/bank/check.mjs')], {
        env: { ...process.env, ...ENV, PLAID_API_BASE: `http://127.0.0.1:${upstream.address().port}` },
      });
      let text = '';
      child.stdout.on('data', d => { text += d; });
      child.stderr.on('data', d => { text += d; });
      child.on('close', code => resolve({ code, text }));
    });
    upstream.close();
    ok(out.code === 0 && /End to end: OK/.test(out.text), 'exits 0 with "End to end: OK"');
    ok(/Accounts: 3/.test(out.text) && /Transactions: 7/.test(out.text) && /Removed the sandbox connection/.test(out.text), 'after accounts, transactions and removal');
    const production = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(ROOT, 'backend/bank/check.mjs')], { env: { ...process.env, ...ENV, PLAID_ENV: 'production' } });
      let text = '';
      child.stderr.on('data', d => { text += d; });
      child.on('close', code => resolve({ code, text }));
    });
    ok(production.code === 1 && /only runs in the sandbox/.test(production.text), 'and refuses to run against production');
  }


  /* The app, with its fetch wired to the real relay code in front of a fake Plaid,
   * and a stand-in for Plaid's window that "logs in" right away. */
  const RELAY = 'http://localhost:8787/api/bank';
  function bankWorld() {
    const plaid = createFakePlaid();
    const links = [];
    const relayFetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith(RELAY + '/')) throw new TypeError('Failed to fetch');
      return handle(new Request(u, { method: opts.method || 'GET', headers: opts.headers, body: opts.body }), ENV, plaid.fetchImpl);
    };
    const Link = {
      create(cfg) {
        links.push(cfg);
        return { open() { setTimeout(() => cfg.onSuccess(`public-sandbox-link${links.length}`, { institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' } }), 0); } };
      },
    };
    return { plaid, links, relayFetch, Link };
  }
  const saved = w => JSON.parse(w.localStorage.getItem('focus-bank') || 'null');
  const toast = d => d.getElementById('toast').textContent;

  console.log('\n── 7. Settings → Bank accounts, before anything is set up ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' } });
    w.openSettings('bank');
    const nav = [...d.querySelectorAll('[data-settings-nav]')].map(b => b.dataset.settingsNav);
    ok(nav.indexOf('bank') === nav.indexOf('gcal') + 1, 'Bank accounts sits right after Google Calendar in Settings');
    ok(d.querySelector('[data-settings-section="bank"]').classList.contains('active'), 'and opens');
    eq(d.getElementById('bankStatusLine').textContent, 'Not set up on this copy of Focus.', 'says it is not set up');
    ok(d.getElementById('bankRelayInput') && !d.querySelector('[data-bank="connect"]'), 'offers a relay address, no Connect button yet');
    ok(/How to set up bank connections/.test(d.getElementById('bankPanel').textContent), 'and links to the setup guide');
  }

  console.log('\n── 8. Connect a bank: relay address, Plaid\'s window, accounts, transactions ──');
  const world = bankWorld();
  const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' }, before: w => { w.fetch = world.relayFetch; } });
  {
    w.openSettings('bank');
    const save = v => { d.getElementById('bankRelayInput').value = v; d.querySelector('[data-bank="relay-save"]').click(); };
    save('ftp://localhost/api');
    ok(saved(w) === null && /https:\/\//.test(toast(d)), 'refuses an address that is not https (or local http)');
    save('http://example.com/api/bank');
    ok(saved(w) === null, 'plain http is only allowed for this computer');
    save('https://user:pw@relay.example');
    ok(saved(w) === null, 'and never with a password in it');
    save(RELAY + '/');
    eq(saved(w).relay, RELAY, 'a local relay is saved on this device');
    ok(!(w.localStorage.getItem('focus-app-state') || '').includes('localhost:8787'), 'not in the synced state');
    ok(await until(() => /Plaid sandbox/.test(d.getElementById('bankPanel').textContent)), 'the relay is checked: "Plaid sandbox"');
    ok(/user_good/.test(d.getElementById('bankPanel').textContent), 'with the sandbox login to use');
    eq(d.getElementById('bankStatusLine').textContent, 'No banks connected.', 'no banks yet');

    w.Plaid = world.Link;
    d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => d.querySelectorAll('#bankPanel .bank-item').length === 1 && d.querySelectorAll('#bankPanel .bank-tx').length > 0),
      'Connect → Plaid\'s window → back in Focus with the bank');
    ok(/^link-sandbox-/.test(world.links[0].token), 'Plaid\'s window got a link token from the relay');
    eq(world.plaid.state.calls.find(c => c.path === '/link/token/create').body.user.client_user_id, w.localStorage.getItem('focus-bank-user'),
      'Plaid knows this device only by a random id');
    eq(d.querySelector('.bank-inst').textContent, 'First Platypus Bank', 'shows the bank');
    const accts = [...d.querySelectorAll('.bank-acct')].map(a => a.textContent.replace(/\s+/g, ' ').trim());
    eq(accts.length, 3, 'its three accounts');
    ok(/Plaid Checking ••0000 checking \$110\.00 \$100\.00 available/.test(accts[0]), `checking with balance and available: "${accts[0]}"`);
    ok(/Plaid Credit Card ••3333 credit card \$410\.00 owed/.test(accts[2]), 'a credit card shows what is owed');
    const txs = [...d.querySelectorAll('.bank-tx')].map(t => t.textContent.replace(/\s+/g, ' ').trim());
    eq(txs.length, 6, 'the six newest transactions');
    ok(/Starbucks pending -\$4\.33$/.test(txs[0]), `newest first, pending marked: "${txs[0]}"`);
    const pay = [...d.querySelectorAll('.bank-tx')].find(t => /payroll/.test(t.textContent));
    ok(pay && /\+\$232\.50/.test(pay.textContent) && pay.querySelector('.bank-tx-amt.in'), 'money in shows as +, in the accent colour');
    eq(d.getElementById('bankStatusLine').textContent, '3 accounts at 1 bank, kept on this device only.', 'status line counts them');
    ok(/Connected to First Platypus Bank/.test(toast(d)), 'toast confirms');
    const item = saved(w).items[0];
    ok(/^v1\./.test(item.token) && item.transactions.length === 7 && item.cursor === 'cursor-7', 'saved on this device: sealed token, transactions, cursor');
    const synced = w.eval('JSON.stringify(gatherState())') + w.eval('JSON.stringify(compressState(gatherState()))');
    ok(!synced.includes('First Platypus') && !synced.includes(item.token) && !synced.includes('Starbucks'), 'nothing about the bank is in the synced state or Export');
  }

  console.log('\n── 9. Refresh, a bank that needs a new login, disconnect ──');
  {
    const access = [...world.plaid.state.items.keys()].pop();
    world.plaid.addTransactions(access, [{ transaction_id: 'tx-new', account_id: 'acc-checking', date: new Date().toISOString().slice(0, 10),
      name: 'Bookstore', merchant_name: 'Campus Bookstore', amount: 42.1, iso_currency_code: 'USD', pending: false, personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } }]);
    d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => /Campus Bookstore/.test(d.getElementById('bankPanel').textContent)), 'Refresh brings in the new transaction');
    eq(world.plaid.state.calls.filter(c => c.path === '/transactions/sync').pop().body.cursor, 'cursor-7', 'asking only for what changed since the saved cursor');
    eq(saved(w).items[0].transactions.length, 8, 'and keeps it');

    world.plaid.state.failNext = { path: '/accounts/get', error_code: 'ITEM_LOGIN_REQUIRED' };
    d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => d.querySelector('.bank-error')), 'a bank that needs a new login shows it');
    ok(/needs you to log in again/.test(d.querySelector('.bank-error').textContent), 'in plain words');

    let asked = '';
    w.confirm = m => { asked = m; return true; };
    d.querySelector('[data-bank="disconnect"]').click();
    ok(/^Disconnect First Platypus Bank\?/.test(asked), 'Disconnect asks first');
    ok(await until(() => !d.querySelector('.bank-item')), 'then the bank is gone from Focus');
    ok(world.plaid.state.calls.some(c => c.path === '/item/remove' && c.body.access_token === access), 'and the connection is ended at Plaid');
    eq(saved(w).items.length, 0, 'nothing of it left on the device');
    eq(d.getElementById('bankStatusLine').textContent, 'No banks connected.', 'back to no banks');
  }

  console.log('\n── 10. Plaid\'s window closed early, relay down, an OAuth bank sending the user back ──');
  {
    w.Plaid = { create: cfg => ({ open() { setTimeout(() => cfg.onExit({ error_code: 'USER_CANCELLED', display_message: null, error_message: 'user closed Link' }), 0); } }) };
    d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => /user closed Link/.test(toast(d))), 'closing Plaid\'s window with an error says so');
    ok(!d.querySelector('.bank-item') && !d.querySelector('[data-bank="connect"]').disabled, 'no bank added, and Connect works again');

    w.fetch = async () => { throw new TypeError('Failed to fetch'); };
    d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => /Could not reach the bank relay/.test(toast(d))), 'relay unreachable → clear message');
    w.fetch = world.relayFetch;

    const back = bankWorld();
    const url = 'https://localhost/worky/?oauth_state_id=a1b2c3';
    const app2 = await loadApp({ url, storage: { 'focus-tour-done': '1', 'focus-bank': JSON.stringify({ relay: RELAY, items: [] }) },
      before: w2 => { w2.fetch = back.relayFetch; w2.Plaid = back.Link; w2.sessionStorage.setItem('focus-bank-link', 'link-sandbox-77'); } });
    ok(await until(() => back.links.length === 1), 'returning from an OAuth bank reopens Plaid\'s window');
    ok(back.links[0].token === 'link-sandbox-77' && back.links[0].receivedRedirectUri === url, 'with the same link token and the address the bank sent back');
    eq(app2.w.location.search, '', 'and the address is cleaned up');
    app2.w.openSettings('bank');
    ok(await until(() => app2.d.querySelectorAll('#bankPanel .bank-item').length === 1), 'then the connection finishes as usual');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
