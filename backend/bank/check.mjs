/* check.mjs — Proves the relay and your Plaid keys work end to end, without a
 * browser:
 *
 *   npm run bank:check    (or: node backend/bank/check.mjs)
 *
 * Sandbox only. It makes a sandbox login at First Platypus Bank, then runs the
 * same relay code the app uses: exchange the login for a sealed token, read the
 * accounts and transactions, and remove the connection again. Settings come from
 * backend/bank/.env, like dev-server.mjs. */
import { handle } from './relay.mjs';
import { relayEnv } from './dev-server.mjs';

const env = relayEnv();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(...a);

async function relay(route, body) {
  const request = new Request(`http://relay.local/${route}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res = await handle(request, env);
  const data = await res.json();
  if (!res.ok) throw new Error(`${route}: ${data.error?.code} — ${data.error?.message}`);
  return data;
}

async function main() {
  if (env.PLAID_ENV === 'production') throw new Error('check.mjs only runs in the sandbox (PLAID_ENV=sandbox). Use the app to try a real bank.');

  const h = await relay('health');
  say(`1. Relay settings: ${h.ok ? 'OK' : 'NOT OK'} (Plaid ${h.env})`);
  if (!h.ok) throw new Error(`${h.problems.join('; ')}\nPut your sandbox keys in backend/bank/.env (copy backend/bank/.env.example).`);

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
  say('2. Sandbox login at First Platypus Bank: OK');

  const { token, item_id } = await relay('exchange', { public_token: made.public_token });
  say(`3. Exchanged through the relay: OK (item ${item_id}; the device would keep a ${token.length}-character sealed token)`);

  const { accounts } = await relay('accounts', { token });
  say(`4. Accounts: ${accounts.length}`);
  accounts.forEach(a => say(`     ${a.name} ••${a.mask ?? '??'}  ${a.type}/${a.subtype}  balance ${a.current ?? '—'}${a.available != null ? `, available ${a.available}` : ''}`));

  let tx = { added: [] }, cursor = '';
  for (let i = 0; i < 15 && !tx.added.length; i++) {       // a new login's history takes a few seconds
    tx = await relay('transactions', { token, cursor });
    cursor = tx.next_cursor || cursor;
    if (!tx.added.length) await sleep(3000);
  }
  say(`5. Transactions: ${tx.added.length}${tx.added.length ? '' : ' (Plaid was still gathering them; the app retries on Refresh)'}`);
  tx.added.slice(0, 5).forEach(t => say(`     ${t.date}  ${t.name.slice(0, 28).padEnd(28)} ${(-t.amount).toFixed(2).padStart(10)}${t.pending ? '  pending' : ''}`));

  await relay('remove', { token });
  say('6. Removed the sandbox connection: OK');
  say('\nEnd to end: OK. The app uses exactly these steps, with Plaid\'s window in place of step 2.');
}

main().catch(e => { console.error(`\nEnd to end: FAILED\n${e.message}`); process.exit(1); });
