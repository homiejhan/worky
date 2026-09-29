/* check.mjs — Proves the relay and your Plaid keys work end to end, without a
 * browser:
 *
 *   FIREBASE_JWKS_URL=http://127.0.0.1:0/jwks npm run bank:check
 *
 * Sandbox only. It makes a sandbox login at First Platypus Bank, then runs the
 * same relay code the app uses: exchange the login for a sealed token, read the
 * accounts and transactions, and remove the connection again. Settings come from
 * backend/bank/.env, like dev-server.mjs.
 *
 * Every relay endpoint but /health needs a Firebase ID token from the app's
 * cloud-sync sign-in, and only Google can sign a real one. So this check signs
 * its own: with FIREBASE_JWKS_URL set it serves test sign-in keys at that address
 * (port 0 picks a free one; the fake key server from tests/fake-firebase-keys.js)
 * and points the relay at them. Without it, it explains and stops. */
import { createRequire } from 'node:module';
import { handle } from './relay.mjs';
import { relayEnv } from './dev-server.mjs';

const require = createRequire(import.meta.url);
const env = relayEnv();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(...a);
let idToken = '';
let keyServer = null;

async function relay(route, body) {
  const headers = { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) };
  const request = new Request(`http://relay.local/${route}`, body === undefined
    ? { method: 'GET', headers }
    : { method: 'POST', headers, body: JSON.stringify(body) });
  const res = await handle(request, env);
  const data = await res.json();
  if (!res.ok) throw new Error(`${route}: ${data.error?.code} — ${data.error?.message}`);
  return data;
}

/* A test sign-in: serve test keys at FIREBASE_JWKS_URL and sign an ID token with them. */
async function signInForTest() {
  if (!env.FIREBASE_JWKS_URL) {
    throw new Error('The relay only answers a signed-in Focus account: every endpoint but /health needs a Firebase ID token,\n'
      + 'and a real ID token can only come from the app\'s cloud-sync sign-in (Google signs it).\n'
      + 'To run this check on your computer, let it sign a test one: set FIREBASE_JWKS_URL=http://127.0.0.1:0/jwks\n'
      + '(in backend/bank/.env or the environment). To try the deployed relay, use the app.');
  }
  const { createFakeFirebaseKeys } = require('../../tests/fake-firebase-keys.js');
  const where = new URL(env.FIREBASE_JWKS_URL);
  const keys = await createFakeFirebaseKeys({ projectId: env.FIREBASE_PROJECT_ID || 'check-mjs' });
  keyServer = await keys.listen(Number(where.port) || 0, where.hostname, where.pathname);
  env.FIREBASE_JWKS_URL = keys.url;                       // the address actually listening
  return keys.signIdToken({ sub: 'check-mjs-user' });
}

async function main() {
  if (env.PLAID_ENV === 'production') throw new Error('check.mjs only runs in the sandbox (PLAID_ENV=sandbox). Use the app to try a real bank.');
  idToken = await signInForTest();

  const h = await relay('health');
  say(`1. Relay settings: ${h.ok ? 'OK' : 'NOT OK'} (Plaid ${h.env}${h.auth ? ', checks sign-ins' : ''})`);
  if (!h.ok) throw new Error(`${h.problems.join('; ')}\nPut your sandbox keys in backend/bank/.env (copy backend/bank/.env.example).`);
  say(`2. Signed in: a test sign-in for project ${env.FIREBASE_PROJECT_ID}, signed with test keys at ${env.FIREBASE_JWKS_URL}`);

  // What Plaid's window hands back after a login; the sandbox can make one directly.
  const base = (env.PLAID_API_BASE || 'https://sandbox.plaid.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/sandbox/public_token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET,
      institution_id: env.PLAID_SANDBOX_INSTITUTION || 'ins_109508',   // First Platypus Bank
      initial_products: ['transactions'],
    }),
  });
  const made = await res.json();
  if (!res.ok) throw new Error(`Plaid refused the sandbox login: ${made.error_code} — ${made.error_message}`);
  say('3. Sandbox login at First Platypus Bank: OK');

  const { token, item_id } = await relay('exchange', { public_token: made.public_token });
  say(`4. Exchanged through the relay: OK (item ${item_id}; the app would keep a ${token.length}-character sealed token in the account)`);

  const { accounts } = await relay('accounts', { token });
  say(`5. Accounts: ${accounts.length}`);
  accounts.forEach(a => say(`     ${a.name} ••${a.mask ?? '??'}  ${a.type}/${a.subtype}  balance ${a.current ?? '—'}${a.available != null ? `, available ${a.available}` : ''}`));

  let tx = { added: [] }, cursor = '';
  for (let i = 0; i < 15 && !tx.added.length; i++) {       // a new login's history takes a few seconds
    tx = await relay('transactions', { token, cursor });
    cursor = tx.next_cursor || cursor;
    if (!tx.added.length) await sleep(3000);
  }
  say(`6. Transactions: ${tx.added.length}${tx.added.length ? '' : ' (Plaid was still gathering them; the app retries on Refresh)'}`);
  tx.added.slice(0, 5).forEach(t => say(`     ${t.date}  ${t.name.slice(0, 28).padEnd(28)} ${(-t.amount).toFixed(2).padStart(10)}${t.pending ? '  pending' : ''}`));

  await relay('remove', { token });
  say('7. Removed the sandbox connection: OK');
  say('\nEnd to end: OK. The app uses exactly these steps, with Plaid\'s window in place of step 3 and a real sign-in in place of step 2.');
}

main()
  .then(() => { if (keyServer) keyServer.close(); })
  .catch(e => { console.error(`\nEnd to end: FAILED\n${e.message}`); process.exit(1); });
