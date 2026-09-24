/* Bank connections: the relay in backend/bank against a fake Plaid, in-process and
 * over HTTP, and check.mjs from start to finish.
 * Plaid itself is never called: tests/fake-plaid.js answers in its shapes.
 * Run: npm test -- bank (or node --experimental-vm-modules tests/test_bank.js) */
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT } = require('./load-app');
const { createFakePlaid } = require('./fake-plaid');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

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


  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
