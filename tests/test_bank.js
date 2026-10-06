/* Bank connections: the relay in backend/bank against a fake Plaid, in-process and
 * over HTTP, check.mjs from start to finish, and Settings → Bank accounts in the app.
 * Plaid itself is never called: tests/fake-plaid.js answers in its shapes.
 * Run: npm test -- bank (or node --experimental-vm-modules tests/test_bank.js) */
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { loadApp, ROOT } = require('./load-app');
const { createFakePlaid } = require('./fake-plaid');
const { createFakeFirebaseKeys } = require('./fake-firebase-keys');
const { createFakeFirebase } = require('./fake-firebase');

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
const PROJECT = 'worky-test';
const ENV = { PLAID_CLIENT_ID: 'test-client', PLAID_SECRET: 'test-secret', PLAID_ENV: 'sandbox', RELAY_KEY: KEY,
  FIREBASE_PROJECT_ID: PROJECT, ALLOWED_ORIGINS: 'https://homiejhan.github.io, http://localhost:8080' };

/* A token sealed the way the v1 relay did: no owner in it. */
async function sealV1(payload) {
  const { subtle } = globalThis.crypto;
  const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await subtle.importKey('raw', Buffer.from(KEY, 'base64'), 'AES-GCM', false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('focus-bank-v1:sandbox') }, key, Buffer.from(JSON.stringify(payload)));
  return `v1.${b64u(iv)}.${b64u(new Uint8Array(ct))}`;
}

(async () => {
  const { handle } = await import(pathToFileURL(path.join(ROOT, 'backend/bank/relay.mjs')).href);
  const keys = await createFakeFirebaseKeys({ projectId: PROJECT });
  ENV.FIREBASE_JWKS_URL = keys.url;
  const TOKEN_A = await keys.signIdToken({ sub: 'user-a' });
  const TOKEN_B = await keys.signIdToken({ sub: 'user-b' });
  /* the relay's own outgoing calls: Google's sign-in keys, else Plaid */
  const upstream = plaidImpl => (u, o) => (keys.handles(u) ? keys.fetchImpl(u, o) : plaidImpl(u, o));
  const plaid = createFakePlaid();
  const call = async (route, body, { env = ENV, origin, method, auth = TOKEN_A, header } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    if (header !== undefined) headers.Authorization = header;
    else if (auth) headers.Authorization = `Bearer ${auth}`;
    const req = new Request(`https://relay.example/${route}`, body === undefined && !method
      ? { method: 'GET', headers }
      : { method: method || 'POST', headers, body: method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify(body ?? {}) });
    const res = await handle(req, env, upstream(plaid.fetchImpl));
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, headers: res.headers, data };
  };
  const lastCall = p => [...plaid.state.calls].reverse().find(c => c.path === p);

  console.log('\n── 1. Relay settings and who may call it ──');
  {
    let r = await call('health', undefined, { auth: null });
    ok(r.status === 200 && r.data.ok && r.data.env === 'sandbox' && r.data.redirect === false, 'health: set up, sandbox, no OAuth redirect');
    eq(r.data.auth, true, 'and checks sign-ins (FIREBASE_PROJECT_ID is set)');
    eq(r.data.version, 3, 'and says which version it is, so the app can tell an older relay to be redeployed');
    ok(r.status === 200, 'health needs no sign-in');
    r = await call('health', undefined, { env: { PLAID_ENV: 'sandbox' }, auth: null });
    ok(!r.data.ok && r.data.problems.length === 4 && r.data.auth === false, `health names what is missing: ${r.data.problems.join('; ')}`);
    ok(r.data.problems.includes('FIREBASE_PROJECT_ID is not set'), 'FIREBASE_PROJECT_ID among them');
    ok(!JSON.stringify(await call('health')).includes('test-secret'), 'health never shows a secret');
    r = await call('link-token', {}, { env: { PLAID_ENV: 'sandbox' } });
    ok(r.status === 500 && r.data.error.code === 'RELAY_NOT_CONFIGURED', 'an unconfigured relay refuses work with a clear error');

    r = await call('health', undefined, { method: 'OPTIONS', origin: 'https://homiejhan.github.io' });
    ok(r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://homiejhan.github.io', 'preflight from an allowed origin passes');
    ok(/\bAuthorization\b/.test(r.headers.get('access-control-allow-headers')), 'and lets the app send its sign-in (Authorization)');
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
    r = await handle(new Request('https://relay.example/accounts', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` }, body: '[1,2]' }), ENV, upstream(plaid.fetchImpl));
    eq(r.status, 400, 'a body that is not a JSON object → 400');
  }

  console.log('\n── 1a. Who is calling: the Firebase ID token ──');
  {
    const code = r => `${r.status} ${r.data && r.data.error && r.data.error.code}`;
    const now = Math.floor(Date.now() / 1000);
    eq(code(await call('link-token', {}, { auth: null })), '401 AUTH_REQUIRED', 'no Authorization header → AUTH_REQUIRED');
    eq(code(await call('accounts', { token: 'x' }, { auth: null })), '401 AUTH_REQUIRED', 'on every endpoint but health');
    eq(code(await call('link-token', {}, { header: `Basic ${TOKEN_A}` })), '401 AUTH_INVALID', 'not a Bearer token → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: 'not.a.jwt' })), '401 AUTH_INVALID', 'garbage → AUTH_INVALID');
    const stranger = await keys.strangerKey();
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({}, { pair: stranger }) })), '401 AUTH_INVALID', 'signed with a key Google did not publish → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({ aud: 'another-project' }) })), '401 AUTH_INVALID', 'another project\'s sign-in (aud) → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({ iss: 'https://securetoken.google.com/another-project' }) })), '401 AUTH_INVALID', 'another issuer → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({ exp: now - 120 }) })), '401 AUTH_INVALID', 'expired two minutes ago → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({ exp: now - 30 }) })), '200 undefined', 'expired 30 s ago still passes (60 s for clock differences)');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({ auth_time: now + 600 }) })), '401 AUTH_INVALID', 'signed in in the future → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({ sub: '' }) })), '401 AUTH_INVALID', 'no user (empty sub) → AUTH_INVALID');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({}, { alg: 'HS256' }) })), '401 AUTH_INVALID', 'a header that claims another algorithm → AUTH_INVALID');
    const [h, pl] = TOKEN_A.split('.');
    eq(code(await call('link-token', {}, { auth: `${h}.${pl}.` })), '401 AUTH_INVALID', 'no signature → AUTH_INVALID');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl, 'base64url').toString()), sub: 'user-b' })).toString('base64url');
    eq(code(await call('link-token', {}, { auth: `${h}.${forged}.${TOKEN_A.split('.')[2]}` })), '401 AUTH_INVALID', 'a changed user id breaks the signature → AUTH_INVALID');
    eq(code(await call('link-token', {})), '200 undefined', 'a valid sign-in works');

    const before = keys.state.fetches;
    await call('link-token', {}); await call('link-token', {});
    eq(keys.state.fetches, before, 'Google\'s keys are cached, not fetched per request');
    await keys.addKey('fake-key-2');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({}, { kid: 'fake-key-2' }) })), '200 undefined', 'a key Google just started using works');
    eq(keys.state.fetches, before + 1, 'after one refetch of the keys');
    eq(code(await call('link-token', {}, { auth: await keys.signIdToken({}, { kid: 'made-up', pair: stranger }) })), '401 AUTH_INVALID', 'an unknown key id → AUTH_INVALID');
    eq(keys.state.fetches, before + 1, 'without another refetch so soon (made-up key ids can\'t make the relay hammer Google)');

    const brief = await createFakeFirebaseKeys({ projectId: PROJECT, url: 'https://keys.fake/brief', maxAge: 1 });
    const briefEnv = { ...ENV, FIREBASE_JWKS_URL: brief.url };
    const briefCall = async () => (await handle(new Request('https://relay.example/link-token', { method: 'POST', headers: { Authorization: `Bearer ${await brief.signIdToken()}` }, body: '{}' }),
      briefEnv, (u, o) => (brief.handles(u) ? brief.fetchImpl(u, o) : plaid.fetchImpl(u, o)))).status;
    ok(await briefCall() === 200 && await briefCall() === 200 && brief.state.fetches === 1, 'the cache lasts as long as Google\'s max-age says…');
    await sleep(1100);
    ok(await briefCall() === 200 && brief.state.fetches === 2, '…and no longer');
  }

  console.log('\n── 2. Link token: what the relay asks Plaid for ──');
  {
    let r = await call('link-token', { user: 'device-12345678' });
    ok(r.status === 200 && /^link-sandbox-/.test(r.data.link_token), 'returns Plaid\'s link token');
    const sent = lastCall('/link/token/create').body;
    ok(sent.client_id === 'test-client' && sent.secret === 'test-secret', 'with the keys (added by the relay, never by the app)');
    eq(sent.products.join(), 'transactions', 'asks for transactions only');
    eq(sent.country_codes.join(), 'US', 'US banks');
    eq(sent.user.client_user_id, 'user-a', 'Plaid knows the user by the signed-in account id, whatever the app sends');
    eq(sent.transactions.days_requested, 30, 'and only 30 days of history');
    ok(!('redirect_uri' in sent), 'no redirect URI unless one is configured');
    await call('link-token', {}, { env: { ...ENV, PLAID_REDIRECT_URI: 'https://homiejhan.github.io/worky/' } });
    eq(lastCall('/link/token/create').body.redirect_uri, 'https://homiejhan.github.io/worky/', 'PLAID_REDIRECT_URI is passed on for OAuth banks');
    await call('link-token', {}, { auth: TOKEN_B });
    eq(lastCall('/link/token/create').body.user.client_user_id, 'user-b', 'another account, another Plaid user');
  }

  console.log('\n── 3. Exchange and the sealed token ──');
  let token;
  {
    const r = await call('exchange', { public_token: 'public-sandbox-1' });
    ok(r.status === 200 && r.data.item_id, 'exchange returns the item id');
    token = r.data.token;
    ok(/^v2\.[\w-]+\.[\w-]+$/.test(token), 'and a sealed token (v2)');
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
    bad = await call('accounts', { token }, { auth: TOKEN_B });
    ok(bad.status === 401 && bad.data.error.code === 'TOKEN_INVALID' && /different relay setup/.test(bad.data.error.message),
      'user-a\'s token is refused for user-b: a copied token is useless without that sign-in');
    bad = await call('transactions', { token, cursor: '' }, { auth: TOKEN_B });
    eq(bad.status, 401, 'for transactions too');
    bad = await call('remove', { token }, { auth: TOKEN_B });
    eq(bad.status, 401, 'and for removing it');
    bad = await call('accounts', { token: await sealV1({ a: access, i: 'item-1' }) });
    ok(bad.status === 401 && bad.data.error.code === 'TOKEN_INVALID', 'a v1 token (sealed before connections had an owner) is refused cleanly');
  }

  console.log('\n── 4. Accounts, transactions, removal ──');
  {
    let r = await call('accounts', { token });
    eq(r.data.accounts.length, 3, 'three sandbox accounts');
    const chk = r.data.accounts[0];
    ok(chk.name === 'Plaid Checking' && chk.mask === '0000' && chk.current === 110 && chk.available === 100 && chk.currency === 'USD', 'names, masks, balances and currency');
    eq(r.data.institution_id, 'ins_109508', 'and the bank');
    eq(Object.keys(chk).sort().join(), 'available,currency,current,id,limit,mask,name,official_name,subtype,type', 'nothing else is passed on');
    eq(r.data.checked_at, '2026-09-30T06:12:00Z', 'and when Plaid last got transactions from the bank (/item/get)');
    plaid.state.failNext = { path: '/item/get', status: 500, error_code: 'INTERNAL_SERVER_ERROR', error_type: 'API_ERROR' };
    r = await call('accounts', { token });
    ok(r.status === 200 && r.data.accounts.length === 3 && r.data.checked_at === null, 'if Plaid can\'t say, the accounts still come back, without it');

    r = await call('transactions', { token, cursor: '' });
    eq(r.data.added.length, 7, 'all pages in one answer (Plaid paged 4 + 3)');
    eq(plaid.state.calls.filter(c => c.path === '/transactions/sync').length, 2, 'two sync calls');
    const pay = r.data.added.find(t => t.id === 'tx-4');
    ok(pay.amount === -232.5 && pay.name === 'Campus Café payroll' && pay.category === 'INCOME', 'amounts keep Plaid\'s sign (negative = money in)');
    eq(r.data.next_cursor, 'cursor-7', 'returns the cursor for next time');
    eq(r.data.status, 'HISTORICAL_UPDATE_COMPLETE', 'and Plaid\'s update status');
    ok(r.data.added.every(t => 'pending_id' in t) && r.data.added.every(t => t.pending_id === null), 'each transaction says which pending one it replaces (none yet)');
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
    const plaidSrv = await fake.listen();
    const httpKeys = await createFakeFirebaseKeys({ projectId: PROJECT });
    const keySrv = await httpKeys.listen();
    const { createServer } = await import(pathToFileURL(path.join(ROOT, 'backend/bank/dev-server.mjs')).href);
    const server = createServer({ ...ENV, PLAID_API_BASE: `http://127.0.0.1:${plaidSrv.address().port}`, FIREBASE_JWKS_URL: httpKeys.url });
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
    const idToken = await httpKeys.signIdToken({ sub: 'user-a' });
    const post = async (route, body, auth = idToken) => fetch(`${base}/api/bank/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    res = await fetch(`${base}/api/bank/health`);
    ok((await res.json()).ok, 'relay health over HTTP, no sign-in needed');
    eq((await post('exchange', { public_token: 'public-sandbox-9' }, null)).status, 401, 'the rest needs a sign-in over HTTP too');
    const { token: t } = await (await post('exchange', { public_token: 'public-sandbox-9' })).json();
    const acc = await (await post('accounts', { token: t })).json();
    eq(acc.accounts.length, 3, 'exchange → accounts over HTTP, through the real relay code, checking the sign-in against the keys over HTTP');
    const tx = await (await post('transactions', { token: t, cursor: '' })).json();
    eq(tx.added.length, 7, 'transactions over HTTP');
    server.close(); plaidSrv.close(); keySrv.close();
  }

  console.log('\n── 6. check.mjs, start to finish ──');
  {
    const runCheck = extra => new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(ROOT, 'backend/bank/check.mjs')], { env: { ...process.env, ...ENV, ...extra } });
      let text = '';
      child.stdout.on('data', d => { text += d; });
      child.stderr.on('data', d => { text += d; });
      child.on('close', code => resolve({ code, text }));
    });
    const fake = createFakePlaid();
    const plaidSrv = await fake.listen();
    const out = await runCheck({ PLAID_API_BASE: `http://127.0.0.1:${plaidSrv.address().port}`, FIREBASE_JWKS_URL: 'http://127.0.0.1:0/jwks' });
    ok(out.code === 0 && /End to end: OK/.test(out.text), 'exits 0 with "End to end: OK"');
    ok(/test sign-in/.test(out.text), 'signing its own test sign-in with a key server it starts');
    ok(/Accounts: 3/.test(out.text) && /Transactions: 7/.test(out.text) && /Removed the sandbox connection/.test(out.text), 'after accounts, transactions and removal');
    ok(fake.state.calls.some(c => c.path === '/item/public_token/exchange'), 'through the relay to (fake) Plaid');
    const noKeys = await runCheck({ PLAID_API_BASE: `http://127.0.0.1:${plaidSrv.address().port}`, FIREBASE_JWKS_URL: '' });
    ok(noKeys.code === 1 && /real ID token/.test(noKeys.text) && /FIREBASE_JWKS_URL/.test(noKeys.text), 'without FIREBASE_JWKS_URL it explains that a real ID token is needed, and exits 1');
    plaidSrv.close();
    const production = await runCheck({ PLAID_ENV: 'production', FIREBASE_JWKS_URL: 'http://127.0.0.1:0/jwks' });
    ok(production.code === 1 && /only runs in the sandbox/.test(production.text), 'and refuses to run against production');
  }


  /* The app, with its fetch wired to the real relay code in front of a fake Plaid,
   * a stand-in for Plaid's window that "logs in" right away, and one fake Firebase
   * (tests/fake-firebase.js) shared by every device. Devices sign in with ID tokens
   * from the fake key server, so the relay checks them for real. */
  const RELAY = 'http://localhost:8787/api/bank';
  const { cloud, install } = createFakeFirebase({ uid: 'user-a', email: 'me@example.com' });
  function bankWorld() {
    const plaid = createFakePlaid();
    const links = [];
    const requests = [];                      // { route, auth }: what the app sent the relay
    const relayFetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith(RELAY + '/')) throw new TypeError('Failed to fetch');
      const headers = new Headers(opts.headers || {});
      requests.push({ route: u.slice(RELAY.length + 1), auth: headers.get('Authorization') });
      return handle(new Request(u, { method: opts.method || 'GET', headers, body: opts.body }), ENV, upstream(plaid.fetchImpl));
    };
    const Link = {
      create(cfg) {
        links.push(cfg);
        return { open() { setTimeout(() => cfg.onSuccess(`public-sandbox-link${links.length}`, { institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' } }), 0); } };
      },
    };
    return { plaid, links, requests, relayFetch, Link };
  }
  /* Every ID token the app asked for, and how the next ones come out: 'good', 'stale'
   * (the cached one has expired, a fresh one is fine) or 'bad' (both turned down). */
  const tokenAsks = [];
  let tokens = 'good';
  const signInFields = uid => ({
    uid, email: uid === 'user-a' ? 'me@example.com' : `${uid}@example.com`,
    getIdToken: async fresh => {
      tokenAsks.push({ uid, fresh: !!fresh });
      const expired = tokens === 'bad' || (tokens === 'stale' && !fresh);
      return keys.signIdToken({ sub: uid, ...(expired ? { iat: 1, exp: 2 } : {}) });
    },
  });
  async function device(world, { storage = {}, url, transform = noRelay, before } = {}) {
    let dev = null;
    const app = await loadApp({ url, transform, storage: { 'focus-tour-done': '1', ...storage },
      before: w => { w.fetch = world.relayFetch; w.Plaid = world.Link; dev = install(w); if (before) before(w); } });
    app.d.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    app.signIn = (uid = 'user-a') => dev.signIn(signInFields(uid));
    app.signOut = () => dev.signOut();
    return app;
  }
  const saved = w => JSON.parse(w.localStorage.getItem('focus-bank') || 'null');
  const toast = d => d.getElementById('toast').textContent;
  const status = d => d.getElementById('bankStatusLine').textContent;
  const cloudItems = (uid = 'user-a') => cloud.at(`users/${uid}/bank/items`) || {};
  /* The app as if its js/config.js named `relay` as BANK_RELAY_URL ('' = none), whatever
   * this copy ships with: the flows below are about a device's own relay address. */
  const withRelay = relay => (src, file) =>
    (file === 'js/config.js' ? src.replace(/(export const BANK_RELAY_URL\s*=\s*)'[^']*'/, `$1'${relay}'`) : src);
  const noRelay = withRelay('');

  console.log('\n── 7. Settings → Bank accounts, before anything is set up ──');
  {
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' }, transform: noRelay });
    eq(w.eval('BANK_RELAY_URL'), '', 'config without a relay');
    w.openSettings('bank');
    const nav = [...d.querySelectorAll('[data-settings-nav]')].map(b => b.dataset.settingsNav);
    ok(nav.indexOf('bank') === nav.indexOf('gcal') + 1, 'Bank accounts sits right after Google Calendar in Settings');
    ok(d.querySelector('[data-settings-section="bank"]').classList.contains('active'), 'and opens');
    eq(status(d), 'Not set up on this copy of Focus.', 'says it is not set up');
    ok(d.getElementById('bankRelayInput') && !d.querySelector('[data-bank="connect"]'), 'offers a relay address, no Connect button yet');
    ok(/How to set up bank connections/.test(d.getElementById('bankPanel').textContent), 'and links to the setup guide');
  }

  console.log('\n── 7a. A copy whose config names a relay: Cloud sync first ──');
  {
    const checked = [];
    const relayUp = async (url, opts = {}) => {
      checked.push({ url: String(url), auth: new Headers(opts.headers || {}).get('Authorization') });
      return { ok: true, status: 200, json: async () => ({ ok: true, env: 'sandbox', auth: true, problems: [] }) };
    };
    let dev = null;
    const { w, d } = await loadApp({ storage: { 'focus-tour-done': '1' }, before: w => { w.fetch = relayUp; dev = install(w); },
      transform: (src, file) => withRelay('https://relay.example.workers.dev')(src, file)
        .replace('window.location.href = `https://accounts.google.com', 'window.__wentTo = `https://accounts.google.com') });
    w.openSettings('bank');
    eq(status(d), 'Sign in to Cloud sync to connect a bank.', 'signed out: asks for Cloud sync first');
    ok(d.querySelector('[data-bank="sign-in"]') && !d.querySelector('[data-bank="connect"]'), 'with a sign-in button, and no Connect');
    d.querySelector('[data-bank="sign-in"]').click();
    ok(/^https:\/\/accounts\.google\.com\/.*state=worky-sync/.test(w.__wentTo || ''), 'the button starts the Cloud sync sign-in');
    ok(await until(() => /Plaid sandbox/.test(d.getElementById('bankPanel').textContent)), 'the relay is checked');
    ok(checked[0].url === 'https://relay.example.workers.dev/health' && !checked[0].auth, 'at its /health, which needs no sign-in');
    dev.signIn(signInFields('user-z'));
    eq(status(d), 'Loading the banks saved to your account…', 'signed in: first the account is read');
    ok(!d.querySelector('[data-bank="connect"]'), 'no Connect until then: a second connection to the same bank costs another Plaid Item');
    ok(await until(() => status(d) === 'No banks connected.'), 'then: no banks yet');
    ok(d.querySelector('[data-bank="connect"]') && !d.getElementById('bankRelayInput'), 'and Connect a bank, no address to type');
    ok(/every device signed in as user-z@example\.com shows it/.test(d.getElementById('bankPanel').textContent), 'saying the account keeps it');

    const oldRelay = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, env: 'production', redirect: true, problems: [] }) });
    const o = await loadApp({ storage: { 'focus-tour-done': '1' }, before: w => { w.fetch = oldRelay; install(w); }, transform: withRelay('https://relay.example.workers.dev') });
    o.w.openSettings('bank');
    ok(await until(() => /out of date: it doesn't check sign-ins yet/.test(o.d.getElementById('bankPanel').textContent)),
      'a relay from before sign-ins were checked (no `auth` in /health) is called out of date');
    ok(o.d.querySelector('.bank-relay-line.warn'), 'as a warning');
    const v2Relay = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, env: 'production', redirect: true, auth: true, problems: [] }) });
    const o2 = await loadApp({ storage: { 'focus-tour-done': '1' }, before: w => { w.fetch = v2Relay; install(w); }, transform: withRelay('https://relay.example.workers.dev') });
    o2.w.openSettings('bank');
    ok(await until(() => /Plaid production, out of date: deploy the current backend\/bank/.test(o2.d.getElementById('bankPanel').textContent)),
      'one that checks sign-ins but is older than version 3 works, and is asked to be redeployed');
    ok(o2.d.querySelector('.bank-relay-line.warn'), 'as a warning too');
  }

  console.log('\n── 8. Connect a bank: relay address, sign-in, Plaid\'s window, saved to the account ──');
  const world = bankWorld();
  const A = await device(world, { storage: { 'focus-bank-user': 'focus-3f1c0b3e-device-id' } });
  const { w, d } = A;
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
    eq(status(d), 'Sign in to Cloud sync to connect a bank.', 'signed out: no Connect yet');
    eq(w.localStorage.getItem('focus-bank-user'), null, 'the device id an older build gave Plaid is gone');

    A.signIn();
    ok(await until(() => status(d) === 'No banks connected.'), 'signed in: no banks yet');
    d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => d.querySelectorAll('#bankPanel .bank-item').length === 1 && d.querySelectorAll('#bankPanel .bank-tx').length > 0),
      'Connect → Plaid\'s window → back in Focus with the bank');
    ok(/^link-sandbox-/.test(world.links[0].token), 'Plaid\'s window got a link token from the relay');
    eq(world.plaid.state.calls.find(c => c.path === '/link/token/create').body.user.client_user_id, 'user-a',
      'Plaid knows the account by its uid, not by a device');
    const sent = world.requests.filter(r => r.route !== 'health');
    ok(sent.length >= 4 && sent.every(r => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(r.auth || '')), `every call but /health carries the sign-in (${sent.map(r => r.route).join(', ')})`);
    ok(world.requests.filter(r => r.route === 'health').every(r => !r.auth), '/health goes without it');
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
    eq(status(d), '3 accounts at 1 bank, saved to your account.', 'status line counts them');
    ok(/Connected to First Platypus Bank/.test(toast(d)), 'toast confirms');

    ok(await until(() => Object.keys(cloudItems()).length === 1), 'saved to the account');
    const [id] = Object.keys(cloudItems());
    const item = cloudItems()[id];
    ok(/^v2\./.test(item.token) && item.transactions.length === 7 && item.cursor === 'cursor-7' && item.accounts.length === 3,
      `at users/user-a/bank/items/${id}: sealed token (v2), accounts, transactions, cursor`);
    eq(typeof cloud.at('users/user-a/bank/updatedAt'), 'number', 'with bank/updatedAt');
    const copy = saved(w);
    ok(copy.uid === 'user-a' && copy.relay === RELAY && copy.items.length === 1 && copy.items[0].token === item.token,
      'this device keeps a copy for offline, marked with the account');
    const synced = w.eval('JSON.stringify(gatherState())') + w.eval('JSON.stringify(compressState(gatherState()))') + (cloud.val.state || '');
    ok(!synced.includes('First Platypus') && !synced.includes(item.token) && !synced.includes('Starbucks'), 'nothing about the bank is in the synced state or Export');
    w.eval("dbdTasks.push({ id: 5150, text: 'pay rent', date: '2026-09-21', done: false }); saveToLocal();");
    ok(await until(() => /pay rent/.test(cloud.val.state || ''), 2500), 'a state push after that …');
    ok(Object.keys(cloudItems()).length === 1, '… leaves the bank node alone (update(), not set())');
  }

  console.log('\n── 8a. The same account on another device; another account ──');
  const P = await device(world, { transform: withRelay(RELAY) });
  {
    const mark = world.requests.length;
    P.w.openSettings('bank');
    eq(status(P.d), 'Sign in to Cloud sync to connect a bank.', 'the phone, signed out: nothing');
    P.signIn();
    ok(await until(() => P.d.querySelectorAll('#bankPanel .bank-item').length === 1), 'signed in to the same account: the bank is there');
    eq(status(P.d), '3 accounts at 1 bank, saved to your account.', 'with its accounts');
    eq(P.d.querySelectorAll('.bank-tx').length, 6, 'and transactions');
    ok(!world.requests.slice(mark).some(r => r.route === 'link-token' || r.route === 'exchange'), 'without connecting anything');
    P.d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => world.requests.slice(mark).some(r => r.route === 'transactions')) && await until(() => !P.d.querySelector('.bank-item [disabled]')),
      'Refresh works from the phone: the sealed token opens for the same account');
    ok(!P.d.querySelector('.bank-error'), 'without an error');

    const C = await device(world, { transform: withRelay(RELAY) });
    C.w.openSettings('bank');
    C.signIn('user-b');
    ok(await until(() => status(C.d) === 'No banks connected.'), 'another account sees none of it');
    ok(!C.d.querySelector('.bank-item') && saved(C.w).uid === 'user-b' && saved(C.w).items.length === 0, 'not even in its copy');
  }

  console.log('\n── 9. Refresh, a bank that needs a new login, a stale sign-in, sign-out, disconnect ──');
  {
    const access = [...world.plaid.state.items.keys()].pop();
    world.plaid.addTransactions(access, [{ transaction_id: 'tx-new', account_id: 'acc-checking', date: new Date().toISOString().slice(0, 10),
      name: 'Bookstore', merchant_name: 'Campus Bookstore', amount: 42.1, iso_currency_code: 'USD', pending: false, personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } }]);
    d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => /Campus Bookstore/.test(d.getElementById('bankPanel').textContent)), 'Refresh brings in the new transaction');
    eq(world.plaid.state.calls.filter(c => c.path === '/transactions/sync').pop().body.cursor, 'cursor-7', 'asking only for what changed since the saved cursor');
    ok(await until(() => Object.values(cloudItems())[0].transactions.length === 8), 'the account keeps it');
    ok(await until(() => /Campus Bookstore/.test(P.d.getElementById('bankPanel').textContent)), 'and the phone shows it without a refresh of its own');

    world.plaid.state.failNext = { path: '/accounts/get', error_code: 'ITEM_LOGIN_REQUIRED' };
    d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => d.querySelector('.bank-error')), 'a bank that needs a new login shows it');
    ok(/needs you to log in again/.test(d.querySelector('.bank-error').textContent), 'in plain words');
    ok(await until(() => P.d.querySelector('.bank-error')), 'on the phone too: it is about the connection, so the account keeps it');

    tokens = 'stale';
    const asked = tokenAsks.length;
    d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => !d.querySelector('.bank-error') && !d.querySelector('.bank-item [disabled]')), 'a sign-in the relay turns down (expired) …');
    ok(tokenAsks.slice(asked).some(t => t.fresh), '… is asked for again, fresh, and the refresh goes through');
    ok(await until(() => !P.d.querySelector('.bank-error')), 'which clears the error on the phone too');

    tokens = 'bad';
    d.querySelector('[data-bank="refresh"]').click();
    ok(await until(() => /Sign in to Cloud sync again/.test(toast(d))), `a sign-in the relay keeps turning down says so: "${toast(d)}"`);
    ok(!d.querySelector('.bank-error') && !P.d.querySelector('.bank-error'), 'without marking the connection: it is about this device');
    tokens = 'good';

    let message = '';
    w.confirm = m => { message = m; return false; };
    w.confirmClearStorage();
    ok(/Clear all saved data/.test(message) && !/bank/i.test(message), 'Clear storage has nothing to warn about banks: they are in the account');

    P.signOut();
    ok(await until(() => status(P.d) === 'Sign in to Cloud sync to connect a bank.'), 'signing out of the phone …');
    ok(!P.d.querySelector('.bank-item'), '… takes the bank off it');
    const pc = saved(P.w);
    ok(pc.uid === null && pc.items.length === 0, '… and its copy');
    eq(Object.keys(cloudItems()).length, 1, 'while the account keeps it');
    P.signIn();
    ok(await until(() => P.d.querySelectorAll('#bankPanel .bank-item').length === 1), 'signing back in brings it back');

    w.confirm = m => { message = m; return true; };
    d.querySelector('[data-bank="disconnect"]').click();
    ok(/^Disconnect First Platypus Bank\?/.test(message) && /deleted from your account, on every device/.test(message), 'Disconnect asks first, saying what goes');
    ok(await until(() => !d.querySelector('.bank-item')), 'then the bank is gone from Focus');
    ok(world.plaid.state.calls.some(c => c.path === '/item/remove' && c.body.access_token === access), 'the connection is ended at Plaid');
    ok(await until(() => cloud.at('users/user-a/bank/items') === null), 'and removed from the account');
    eq(saved(w).items.length, 0, 'and from this device\'s copy');
    eq(status(d), 'No banks connected.', 'back to no banks');
    ok(await until(() => !P.d.querySelector('.bank-item') && status(P.d) === 'No banks connected.'), 'on the phone too');
  }

  console.log('\n── 10. An older build\'s connection, Plaid\'s window closed early, relay down, an OAuth bank sending the user back ──');
  {
    const old = await device(world, { storage: { 'focus-bank': JSON.stringify({ relay: RELAY, items: [
      { id: 'item-old', token: 'v1.aaaa.bbbb', institution: { id: null, name: 'Old Bank' }, accounts: [], transactions: [], cursor: '' }] }) } });
    eq(toast(old.d), 'Bank connections now live in your account. Connect your bank again.', 'a connection an older build kept on the device: one toast');
    const oc = saved(old.w);
    ok(oc.items.length === 0 && oc.relay === RELAY, 'it is dropped, the relay address stays');
    old.signIn();
    old.w.openSettings('bank');
    ok(await until(() => status(old.d) === 'No banks connected.') && !/Old Bank/.test(old.d.getElementById('bankPanel').textContent), 'and it is not shown once signed in');
    const reopened = await device(world, { storage: { 'focus-bank': old.w.localStorage.getItem('focus-bank') } });
    ok(!/now live in your account/.test(toast(reopened.d)), 'the toast is once: reopening the app does not bring it back');

    w.Plaid = { create: cfg => ({ open() { setTimeout(() => cfg.onExit({ error_code: 'USER_CANCELLED', display_message: null, error_message: 'user closed Link' }), 0); } }) };
    d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => /user closed Link/.test(toast(d))), 'closing Plaid\'s window with an error says so');
    ok(!d.querySelector('.bank-item') && !d.querySelector('[data-bank="connect"]').disabled, 'no bank added, and Connect works again');
    eq(w.sessionStorage.getItem('focus-bank-link'), null, 'nothing left waiting for an OAuth bank');

    w.fetch = async () => { throw new TypeError('Failed to fetch'); };
    d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => /Could not reach the bank relay/.test(toast(d))), 'relay unreachable → clear message');
    w.fetch = world.relayFetch;
    w.Plaid = world.Link;

    const url = 'https://localhost/worky/?oauth_state_id=a1b2c3';
    const back = bankWorld();
    const link = JSON.stringify({ uid: 'user-a', token: 'link-sandbox-77' });
    const R = await device(back, { url, transform: withRelay(RELAY), before: w2 => w2.sessionStorage.setItem('focus-bank-link', link) });
    eq(R.w.location.search, '', 'back from an OAuth bank: the address is cleaned up');
    await sleep(50);
    eq(back.links.length, 0, 'Plaid\'s window waits for the account to sign in');
    R.signIn();
    ok(await until(() => back.links.length === 1), 'then reopens');
    ok(back.links[0].token === 'link-sandbox-77' && back.links[0].receivedRedirectUri === url, 'with the same link token and the address the bank sent back');
    R.w.openSettings('bank');
    ok(await until(() => R.d.querySelectorAll('#bankPanel .bank-item').length === 1), 'then the connection finishes as usual');
    ok(await until(() => Object.keys(cloudItems()).length === 1), 'into the account');

    const other = bankWorld();
    const X = await device(other, { url, transform: withRelay(RELAY), before: w2 => w2.sessionStorage.setItem('focus-bank-link', link) });
    X.signIn('user-b');
    ok(await until(() => /started by another account/.test(toast(X.d))), 'signed in as another account: it does not finish, and says why');
    await sleep(50);
    ok(other.links.length === 0 && X.w.sessionStorage.getItem('focus-bank-link') === null, 'Plaid\'s window stays closed and the link token is dropped');

    const Y = await device(other, { url, transform: withRelay(RELAY), before: w2 => w2.sessionStorage.setItem('focus-bank-link', 'link-sandbox-78') });
    Y.signIn();
    await sleep(100);
    eq(other.links.length, 0, 'a link token an older build left (not tied to an account) is not used');
  }

  console.log('\n── 11. New transactions are logged in Budget ──');
  {
    const W = bankWorld();
    const tx = W.plaid.transaction;
    const L = await device(W, { transform: withRelay(RELAY) });
    const today = L.w.eval('dbdTodayKey()'), yesterday = L.w.eval('addDays(dbdTodayKey(), -1)');
    const bud = app => app.d.getElementById('budgetContainer-d');
    const purchases = app => JSON.parse(app.w.eval('JSON.stringify(budget.purchases)'));
    const refresh = async app => {
      const before = W.plaid.state.calls.filter(c => c.path === '/transactions/sync').length;
      app.w.openSettings('bank');
      app.d.querySelector('[data-bank="refresh"]').click();
      await until(() => W.plaid.state.calls.filter(c => c.path === '/transactions/sync').length > before && !app.d.querySelector('.bank-item [disabled]'), 3000);
    };
    L.w.eval(`budget.initial = 500; budget.daily = 20; budget.purchases = []; budget.lastDate = '${today}'; saveToLocal();`);   // no sample purchase
    L.signIn('user-c');
    L.w.openSettings('bank');
    ok(await until(() => status(L.d) === 'No banks connected.'), 'a new account, no banks yet');
    L.d.querySelector('[data-bank="connect"]').click();
    ok(await until(() => L.d.querySelectorAll('#bankPanel .bank-tx').length > 0), 'connect a bank');
    ok(await until(() => Object.keys(L.w.eval('bankBudget.items')).length === 1), 'its first refresh is the sync point');
    const itemId = Object.keys(L.w.eval('bankBudget.items'))[0];
    const tracked = () => L.w.eval('bankBudget.items')[itemId];
    eq(tracked().since, today, 'dated today');
    eq(Object.keys(tracked().seen).sort().join(), 'tx-1,tx-2,tx-4,tx-6', 'counting what the checking account shows as already in the balance');
    ok(L.w.eval('totalBalance()') === 100 && L.w.eval('budget.initial') === 100 && purchases(L).length === 0,
      'the total balance becomes the bank\'s ($100 available in checking, not the $500 typed), and the day starts from it');
    ok(L.w.eval('budgetFollowsBank()') && !/Logged/.test(toast(L.d)), 'it follows the bank from now on, with nothing logged');
    const toggle = () => L.d.querySelector('#bankPanel [data-bank="budget"]');
    ok(toggle() && toggle().checked && /Budget follows your bank/.test(toggle().closest('.settings-view-row').textContent), 'Settings → Bank accounts: "Budget follows your bank" is on');
    ok(!L.w.eval('JSON.stringify(gatherState())').includes('Starbucks'), 'the sync point keeps ids, amounts and dates, not names');

    const access = [...W.plaid.state.items.keys()].pop();
    W.plaid.changeTransactions(access, { added: [
      tx('n-chipotle', 12.5, today, 'Chipotle', { pending: true }),
      tx('n-target', 30, yesterday, 'Target'),
      tx('n-pay', -500, today, 'Campus Café payroll'),
      tx('n-save', 20, today, 'Transfer to savings', { account_id: 'acc-saving' }),
      tx('n-card', 55, today, 'Amazon', { account_id: 'acc-credit' }),
    ] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 557.5, current: 580 }, 'acc-saving': { available: 180, current: 190 }, 'acc-credit': { current: 465 } });
    await refresh(L);
    ok(await until(() => purchases(L).length === 2), 'Refresh brings new transactions into Budget');
    const chip = purchases(L).find(p => p.bank === 'n-chipotle');
    ok(chip && chip.title === 'Chipotle' && chip.amount === 12.5 && chip.pending === true && !chip.on, "today's spending is a purchase today, still pending");
    const target = purchases(L).find(p => p.bank === 'n-target');
    ok(target && target.title === 'Target' && target.amount === 30 && target.on === yesterday, "yesterday's Target, first seen today, is spent today too, with its day");
    eq(L.w.eval('totalBalance()'), 557.5, "the total balance is the bank's new one: today's payroll (+500) in, yesterday's Target (−30) and the pending Chipotle out");
    ok(L.w.eval('budget.initial') === 100 && L.w.eval('todayBalance()') === -22.5, 'the day still starts from $100, and today\'s envelope is $20 − $12.50 − $30');
    const sub = () => bud(L).querySelector('.budget-figure-sub').textContent;
    ok(/^\$100\.00 at the start of today − \$42\.50 spent today \+ \$500\.00 in at your bank$/.test(sub()), `under it, how the day got there: "${sub()}"`);
    ok(/Logged 3 bank transactions in Budget/.test(toast(L.d)), `a toast says so: "${toast(L.d)}"`);
    ok(!purchases(L).some(p => /savings|Amazon/.test(p.title)) && L.w.eval('totalBalance()') === 557.5, 'savings and the credit card are left out, of the purchases and of the balance');
    const tagOf = p => bud(L).querySelector(`.budget-purchase-row.from-bank[data-purchase-id="${p.id}"] .budget-bank-tag`);
    ok(tagOf(chip) && tagOf(chip).textContent === 'pending', 'on the Budget screen it is marked as from the bank, pending');
    const day = L.w.eval(`calKeyToDate('${yesterday}').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })`);
    ok(tagOf(target) && tagOf(target).textContent === `bank · ${day}` && /dated .*reached your bank's list today/.test(tagOf(target).title), `and the Target with its day: "${tagOf(target) && tagOf(target).textContent}"`);
    const lines = [...bud(L).querySelectorAll('.budget-bank-list .bank-tx')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
    ok(lines.length === 1 && /Campus Café payroll \+\$500\.00$/.test(lines[0]), `From your bank lists the money in: ${lines.join(' | ')}`);
    ok(/What you let yourself spend a day/.test(bud(L).textContent) && /Your bank balance when today began/.test(bud(L).textContent)
      && bud(L).querySelector('[data-bfield="initial"]').readOnly, 'the daily budget is spending, and the initial balance follows the bank (it can\'t be typed over)');
    L.w.eval('setBudgetField("initial", "9999")');
    ok(L.w.eval('budget.initial') === 100 && L.w.eval('totalBalance()') === 557.5, 'nothing typed there changes it');

    await sleep(1500);                                                       // the laptop's state reaches the account
    const P = await device(W, { transform: withRelay(RELAY), storage: { 'focus-app-state': cloud.at('users/user-c/state'),
      'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: L.w.eval('syncHash(syncFingerprint(gatherState()))') }) } });
    P.w.eval('BANK_BUDGET_WAIT_MS = 2500');                                // shorter than 10 s, still past the laptop's 1.2 s push
    P.signIn('user-c');
    ok(await until(() => P.d.querySelectorAll('#bankPanel .bank-item').length === 1 || P.w.eval('bank.items.length') === 1), 'the phone signs in to the same account');
    await sleep(200);
    ok(purchases(P).length === 2 && P.w.eval('totalBalance()') === 557.5 && P.w.eval('budget.initial') === 100, 'and has the same budget: nothing logged twice');

    W.plaid.changeTransactions(access, { removed: ['n-chipotle'],
      added: [tx('n-chipotle-posted', 14, today, 'CHIPOTLE 1234', { pending_transaction_id: 'n-chipotle' })] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 556, current: 566 } });
    await refresh(P);
    const chipOf = app => purchases(app).find(p => p.title === 'Chipotle');
    ok(await until(() => chipOf(P) && chipOf(P).amount === 14), 'the charge posts with a tip: Refresh on the phone updates the purchase');
    ok(purchases(P).length === 2 && !chipOf(P).pending && chipOf(P).bank === 'n-chipotle-posted', 'the same purchase, posted, not a second one');
    ok(await until(() => P.w.eval('totalBalance()') === 556 && L.w.eval('totalBalance()') === 556, 3000), 'and the total follows the bank, the tip taken off, on both devices');
    ok(await until(() => chipOf(L) && chipOf(L).amount === 14, 4000), 'the laptop has it too');
    await sleep(1500);
    ok(purchases(L).length === 2 && purchases(P).length === 2, 'and neither logs it again');

    W.plaid.changeTransactions(access, { added: [tx('n-hold', 45, today, 'Shell gas hold', { pending: true })] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 511 } });
    await refresh(L);
    ok(await until(() => purchases(L).some(p => p.bank === 'n-hold')) && L.w.eval('totalBalance()') === 511, 'a pending hold shows as a purchase, and comes off the total as at the bank');
    W.plaid.changeTransactions(access, { removed: ['n-hold'] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 556 } });
    await refresh(L);
    ok(await until(() => !purchases(L).some(p => p.bank === 'n-hold')) && L.w.eval('totalBalance()') === 556, 'the bank drops it: it leaves Budget, and the total is back');

    const add = (title, amount) => {
      bud(L).querySelector('.budget-new-title').value = title;
      bud(L).querySelector('.budget-new-amount').value = amount;
      bud(L).querySelector('[data-pact="add"]').click();
    };
    const newTitle = () => bud(L).querySelector('.budget-new-title');
    add('Coffee', '4.75');
    newTitle().focus();                                                    // "+ Add" puts the cursor back for the next one
    eq(L.w.eval('totalBalance()'), 551.25, 'a purchase typed here comes off the total before the bank shows it');
    W.plaid.changeTransactions(access, { added: [tx('n-coffee', 4.75, today, 'STARBUCKS 800', { pending: true })] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 551.25 } });
    await refresh(L);
    ok(await until(() => purchases(L).some(p => p.title === 'Coffee' && p.bank === 'n-coffee'), 1000),
      'a cursor left in "What did you buy?" holds nothing up: the bank\'s copy is matched to the purchase typed by hand');
    eq(purchases(L).filter(p => p.amount === 4.75).length, 1, 'not counted twice');
    eq(L.w.eval('totalBalance()'), 551.25, 'nor off the total twice: it is the bank\'s now');
    ok(L.d.activeElement === newTitle(), 'and the cursor is still in the field');

    /* someone typing: logging waits for a pause, then keeps what was typed */
    L.w.eval('TYPING_PAUSE_MS = 1000; BANK_BUDGET_WAIT_MS = 1500');
    newTitle().focus();
    newTitle().value = 'Ban';
    newTitle().dispatchEvent(new L.w.Event('input', { bubbles: true }));
    W.plaid.changeTransactions(access, { added: [tx('n-vend', 1.25, today, 'Vending machine')] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 550, current: 564.75 } });
    const syncs = W.plaid.state.calls.filter(c => c.path === '/transactions/sync').length;
    L.w.eval('bankRefreshNow(bankItems()[0])');                               // Refresh without leaving the field
    await until(() => W.plaid.state.calls.filter(c => c.path === '/transactions/sync').length > syncs, 3000);
    await sleep(100);
    ok(!purchases(L).some(p => p.bank === 'n-vend'), 'while something is being typed, a new bank transaction waits: logging redraws Budget');
    ok(await until(() => purchases(L).some(p => p.bank === 'n-vend'), 4000), 'a pause in the typing lets it in');
    ok(newTitle().value === 'Ban' && L.d.activeElement === newTitle(), 'with what was typed still in the field, and the cursor');
    newTitle().value = '';
    L.w.eval('TYPING_PAUSE_MS = 4000; BANK_BUDGET_WAIT_MS = 10000');
    const coffee = purchases(L).find(p => p.title === 'Coffee');
    bud(L).querySelector(`.budget-purchase-row[data-purchase-id="${coffee.id}"] [data-pact="del"]`).click();
    ok(!purchases(L).some(p => p.title === 'Coffee'), 'taken out of Budget with ×');
    const kept = L.w.eval('budget.initial'), lines0 = L.w.eval('bankBudget.log.length');
    eq(L.w.eval('totalBalance()'), 550, 'the total is still the bank\'s: the money did leave');
    W.plaid.changeTransactions(access, { removed: ['n-coffee'], added: [tx('n-coffee-posted', 5.25, today, 'STARBUCKS 800', { pending_transaction_id: 'n-coffee' })] });
    W.plaid.setBalances(access, { 'acc-checking': { available: 549.5, current: 559.5 } });
    await refresh(L);
    ok(!purchases(L).some(p => /STARBUCKS|Coffee/.test(p.title)) && L.w.eval('budget.initial') === kept && L.w.eval('bankBudget.log.length') === lines0,
      'and it stays out when the bank posts it, with another amount');
    eq(L.w.eval('totalBalance()'), 549.5, 'while the total follows the bank');

    const exported = L.w.eval('JSON.stringify(compressState(gatherState()))');
    ok(/"bb":\{"o":1,"i":\{/.test(exported) && /"b":"n-chipotle-posted"/.test(exported), 'Export keeps the sync point and which purchases came from the bank');
    const I = await loadApp({ storage: { 'focus-tour-done': '1' }, transform: noRelay });
    I.w.applyState(JSON.parse(exported));
    ok(I.w.eval('bankBudget.items')[itemId] && purchases(I).some(p => p.bank === 'n-chipotle-posted'), 'and Import brings them back');

    const total = L.w.eval('totalBalance()');
    L.w.eval(`budget.lastDate = '${yesterday}'`);
    L.w.eval('budgetRollover()');
    ok(L.w.eval('budget.initial') === total && total === 549.5 && purchases(L).length === 0, 'a new day starts from the bank\'s balance: no daily budget added, the bank moves it');

    await sleep(1500);                                                       // the rollover reaches the phone
    L.w.openSettings('bank');
    toggle().click();
    ok(!L.w.eval('bankBudget.on') && !L.w.eval('budgetFollowsBank()'), 'turned off: Budget stops following the bank');
    ok(L.w.eval('totalBalance()') === 549.5 && !bud(L).querySelector('[data-bfield="initial"]').readOnly, 'the total stays where it was, Budget\'s own again: the initial balance can be typed');
    ok(!bud(L).querySelector('.budget-bank-note'), 'and From your bank goes away');
    ok(await until(() => !P.w.eval('bankBudget.on'), 3000), 'on the phone too, through sync');
    W.plaid.changeTransactions(access, { added: [tx('n-off', 9, today, 'Lunch while off')] });
    await refresh(L);
    ok(!purchases(L).some(p => p.bank === 'n-off'), 'nothing is logged while it is off');
    await sleep(300);
    ok(!purchases(P).some(p => p.bank === 'n-off'), 'nor on the phone');
    toggle().click();
    ok(L.w.eval('bankBudget.on') && L.w.eval('bankBudget.items')[itemId].since === today && L.w.eval('bankBudget.items')[itemId].seen['n-off'],
      'turned on again: a new sync point, counting what the bank shows now');
    ok(!purchases(L).some(p => p.bank === 'n-off'), 'so the lunch from while it was off is taken as already in the balance');
    ok(L.w.eval('totalBalance()') === 549.5 && L.w.eval('budget.initial') === 549.5, 'the total is the bank\'s again, and the day starts from it');
    L.w.eval('budget.initial = 1');                                           // another copy merged in with an older start of the day
    await refresh(L);
    ok(L.w.eval('budget.initial') === 549.5 && L.w.eval('totalBalance()') === 549.5, 'the next refresh takes the start of the day again');

    /* a refresh on a device that closed before its Budget changes reached the account */
    await sleep(1500);
    await until(() => !P.w.eval('bankBudgetTimer'), 5000);                  // (a wait started on an earlier change is over: this one starts its own)
    const snack = { id: 'n-snack', account: 'acc-checking', date: today, name: 'Vending machine', amount: 2.5, pending: false };
    cloud.at(`users/user-c/bank/items/${itemId}`).transactions.unshift(snack);
    cloud.emit();
    await sleep(50);
    ok(!purchases(P).some(p => p.bank === 'n-snack'), 'a transaction another device fetched is not logged here at once: that device logs it');
    ok(await until(() => purchases(P).some(p => p.bank === 'n-snack'), 4000), 'but if its Budget changes never arrive, this device logs it after a short wait');
    await sleep(1800);
    ok([L, P].every(app => purchases(app).filter(p => p.bank === 'n-snack').length === 1), 'once, on every device');

    await sleep(1500);
    const node = cloud.at(`users/user-c/bank/items/${itemId}`);
    node.updatedAt = Date.now() - 2 * 3600e3;                                // the bank hasn't been refreshed for two hours
    cloud.emit();
    W.plaid.changeTransactions(access, { added: [tx('n-bus', 8, today, 'Bus pass')] });
    const Q = await device(W, { transform: withRelay(RELAY), storage: { 'focus-app-state': cloud.at('users/user-c/state'),
      'focus-sync-meta': JSON.stringify({ pushedAt: 1, knownHash: L.w.eval('syncHash(syncFingerprint(gatherState()))') }) } });
    Q.signIn('user-c');
    ok(await until(() => purchases(Q).some(p => p.bank === 'n-bus'), 3000), 'a device that opens with the bank two hours old refreshes it on its own and logs what is new');
    await sleep(2500);
    ok([L, P, Q].every(app => purchases(app).filter(p => p.bank === 'n-bus').length === 1), 'every device ends up with it once');

    /* what From your bank says */
    await refresh(L);
    const note = () => [...bud(L).querySelectorAll('.budget-bank-note')].map(n => n.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    ok(/Following Plaid Checking ••0000 at First Platypus Bank since today\./.test(note()), `From your bank says which account it follows, since when: "${note()}"`);
    ok(/Checked at \d{1,2}:\d\d [AP]M; Plaid last heard from First Platypus Bank (at|on) [^.]*\d:\d\d [AP]M\./.test(note()), 'when Focus last checked, and when Plaid last heard from the bank');
    ok(/a purchase can take a few hours to show up/.test(note()), 'and that a purchase can take hours to reach Plaid');
    eq(L.w.eval('bankItems()[0].checkedAt'), Date.parse('2026-09-30T06:12:00Z'), 'the relay\'s checked_at is kept with the connection');

    /* a slow refresh finishing after a faster one */
    const realFetch = L.w.fetch;
    let release = null;
    const gate = new Promise(r => { release = r; });
    L.w.fetch = async (u, o) => { const res = await realFetch(u, o); if (String(u).endsWith('/transactions')) await gate; return res; };
    const slow = L.w.eval('bankRefresh(syncUser.uid, bankItems()[0])');   // fetched now, written later
    await sleep(100);
    L.w.fetch = realFetch;
    W.plaid.changeTransactions(access, { added: [tx('n-late', 3, today, 'Parking')] });
    await refresh(P);                                                      // the phone refreshes meanwhile, and logs it
    ok(await until(() => (cloudItems('user-c')[itemId].transactions || []).some(t => t.id === 'n-late') && L.w.eval('bankItems()[0].transactions.some(t => t.id === "n-late")'), 3000),
      'meanwhile another device\'s refresh brings a new transaction');
    release();
    await slow;
    await sleep(100);
    ok((cloudItems('user-c')[itemId].transactions || []).some(t => t.id === 'n-late'), 'the slower refresh, written last, keeps it: it is written onto the latest copy');
    await sleep(2500);
    ok([L, P].every(app => purchases(app).filter(p => p.bank === 'n-late').length === 1), 'and it is counted once');

    /* a slow refresh that ends in a bank error */
    W.plaid.state.failNext = { path: '/transactions/sync', status: 400, error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR' };
    let release2 = null;
    const gate2 = new Promise(r => { release2 = r; });
    L.w.fetch = async (u, o) => { const res = await realFetch(u, o); if (String(u).endsWith('/transactions')) await gate2; return res; };
    const failing = L.w.eval('bankRefresh(syncUser.uid, bankItems()[0])');
    await sleep(100);
    L.w.fetch = realFetch;
    W.plaid.changeTransactions(access, { added: [tx('n-late2', 4, today, 'Bus')] });
    await refresh(P);
    ok(await until(() => L.w.eval('bankItems()[0].transactions.some(t => t.id === "n-late2")'), 3000), 'meanwhile another device\'s refresh brings another');
    release2();
    await failing;
    await sleep(100);
    const errored = cloudItems('user-c')[itemId];
    ok(errored.error && errored.error.code === 'ITEM_LOGIN_REQUIRED', 'the slow refresh fails with a bank error: saved with the connection');
    ok(errored.transactions.some(t => t.id === 'n-late2'), 'onto the latest copy: its transactions stay');
    ok(/First Platypus Bank needs attention: log in to it again/.test(note()), `and From your bank says so: "${note()}"`);
    await refresh(L);
    ok(!cloudItems('user-c')[itemId].error, 'a refresh that works clears it');

    /* a pending charge crowded out by other accounts' rows, then posting */
    const twoDaysAgo = L.w.eval('addDays(dbdTodayKey(), -2)');
    W.plaid.changeTransactions(access, { added: [tx('n-hotel', 80, twoDaysAgo, 'Hotel hold', { pending: true })] });
    await refresh(L);
    ok(await until(() => purchases(L).some(p => p.bank === 'n-hotel' && p.on === twoDaysAgo && p.pending)), 'a pending hold dated two days ago, first seen today, is spent today');
    const held = L.w.eval('budget.initial');
    W.plaid.changeTransactions(access, { added: Array.from({ length: 55 }, (_, i) => tx(`n-card-${i}`, 2, yesterday, `Card ${i}`, { account_id: 'acc-credit' })) });
    await refresh(L);
    ok(L.w.eval('bankItems()[0].transactions.some(t => t.id === "n-hotel")'), 'fifty-five newer credit card rows: the pending hold stays in the list (every pending one does)');
    W.plaid.changeTransactions(access, { removed: ['n-hotel'], added: [tx('n-hotel-posted', 80, today, 'Hotel', { pending_transaction_id: 'n-hotel' })] });
    await refresh(L);
    await sleep(100);
    ok(L.w.eval('budget.initial') === held && purchases(L).filter(p => /Hotel/.test(p.title)).length === 1 && purchases(L).some(p => p.bank === 'n-hotel-posted' && !p.pending),
      'so when it posts it is the same purchase, not counted again');

    /* a connection whose first refresh never finished */
    const node0 = cloud.at(`users/user-c/bank/items/${itemId}`);
    node0.updatedAt = 0;
    node0.addedAt = Date.now() - 10 * 60000;
    cloud.emit();
    await sleep(50);
    const syncs0 = W.plaid.state.calls.filter(c => c.path === '/transactions/sync').length;
    L.w.eval('bankAutoAt = 0; bankAutoRefresh()');
    ok(await until(() => W.plaid.state.calls.filter(c => c.path === '/transactions/sync').length > syncs0 && L.w.eval('bankItems()[0].updatedAt') > 0, 3000),
      'a connection never refreshed (its first refresh failed) is refreshed on its own once it is five minutes old');

    /* Disconnect */
    await sleep(1500);
    L.w.openSettings('bank');
    L.d.querySelector(`[data-bank="disconnect"][data-item="${itemId}"]`).click();
    ok(await until(() => !L.w.eval('bankBudget.items')[itemId], 3000), 'Disconnect drops the bank\'s sync point');
    ok(await until(() => !P.w.eval('bankBudget.items')[itemId], 4000), 'on every device');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
