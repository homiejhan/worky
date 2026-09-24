/* relay.mjs — The bank relay: the one part of Focus's bank connection that runs on
 * a server.
 *
 * Focus reads bank accounts through Plaid. Plaid's keys must stay secret, so the
 * browser can't call Plaid itself; this relay makes those calls for the app. It
 * keeps nothing: there is no database. The key to a bank connection (Plaid's
 * access token) is sealed with AES-GCM under RELAY_KEY and handed back to the
 * device, which sends it with each request. Balances and transactions pass
 * through to the device and are not stored here.
 *
 *   GET  /health                           → { ok, env, redirect, problems }
 *   POST /link-token   { user }            → { link_token }         opens Plaid's window
 *   POST /exchange     { public_token }    → { token, item_id }     after the user logs in
 *   POST /accounts     { token }           → { accounts, institution_id }
 *   POST /transactions { token, cursor }   → { added, modified, removed, next_cursor, status }
 *   POST /remove       { token }           → { removed: true }      ends the connection at Plaid
 *
 * Only the last part of the path counts, so the relay works at the root of a
 * Cloudflare Worker and under /api/bank/ in dev-server.mjs alike.
 *
 * Settings, as environment variables (Cloudflare: vars and secrets):
 *   PLAID_CLIENT_ID, PLAID_SECRET  dashboard.plaid.com → Developers → Keys
 *   PLAID_ENV           sandbox (default) or production
 *   RELAY_KEY           32 random bytes, base64: seals the access tokens
 *   ALLOWED_ORIGINS     comma-separated web origins allowed to call the relay
 *   PLAID_REDIRECT_URI  optional; needed for OAuth banks, registered with Plaid
 *   PLAID_CLIENT_NAME   optional; the name Plaid's window shows (default Focus)
 *   PLAID_API_BASE      optional; replaces the Plaid host (tests point it at a fake)
 *
 * Runs on Cloudflare Workers (the default export) and on Node 20+ through
 * dev-server.mjs. It uses only fetch and Web Crypto. */

const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const DAYS_REQUESTED = 30;     // how far back Plaid fetches transactions: only what the app shows
const MAX_PAGES = 20;          // /transactions/sync pages per request (500 each)
const TOKEN_VERSION = 'v1';

export default { fetch: (request, env) => handle(request, env) };

/* One request in, one Response out. `fetchImpl` lets tests stand in for Plaid. */
export async function handle(request, env = {}, fetchImpl = fetch) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (cors === null) return json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This address is not allowed to use the relay. Add it to ALLOWED_ORIGINS.' } }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const route = url.pathname.replace(/\/+$/, '').split('/').pop();
  const routes = { health, 'link-token': linkToken, exchange, accounts, transactions, remove };
  const fn = Object.hasOwn(routes, route) ? routes[route] : null;
  if (!fn) return json({ error: { code: 'NOT_FOUND', message: 'No such relay endpoint.' } }, 404, cors);
  const method = fn === health ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${method}.` } }, 405, { ...cors, Allow: method });

  try {
    const body = method === 'POST' ? await readBody(request) : {};
    return json(await fn(body, env, fetchImpl), 200, cors);
  } catch (e) {
    if (e instanceof RelayError) return json({ error: e.error }, e.status, cors);
    return json({ error: { code: 'RELAY_ERROR', message: 'The relay hit an unexpected error.' } }, 500, cors);
  }
}

/* ── endpoints ── */

async function health(_body, env) {
  const problems = configProblems(env);
  return { ok: problems.length === 0, env: plaidEnv(env), redirect: !!env.PLAID_REDIRECT_URI, problems };
}

async function linkToken({ user }, env, fetchImpl) {
  requireConfig(env);
  if (typeof user !== 'string' || !/^[\w-]{8,64}$/.test(user)) throw new RelayError(400, 'BAD_REQUEST', 'A device id is required.');
  const request = {
    client_name: String(env.PLAID_CLIENT_NAME || 'Focus').slice(0, 30),
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: user },
    products: ['transactions'],
    transactions: { days_requested: DAYS_REQUESTED },
  };
  if (env.PLAID_REDIRECT_URI) request.redirect_uri = env.PLAID_REDIRECT_URI;
  const data = await plaid(env, '/link/token/create', request, fetchImpl);
  return { link_token: data.link_token, expiration: data.expiration };
}

async function exchange({ public_token }, env, fetchImpl) {
  requireConfig(env);
  if (typeof public_token !== 'string' || !public_token) throw new RelayError(400, 'BAD_REQUEST', 'public_token is required.');
  const data = await plaid(env, '/item/public_token/exchange', { public_token }, fetchImpl);
  return { token: await seal(env, { a: data.access_token, i: data.item_id }), item_id: data.item_id };
}

async function accounts({ token }, env, fetchImpl) {
  const { a } = await unseal(env, token);
  const data = await plaid(env, '/accounts/get', { access_token: a }, fetchImpl);
  return {
    accounts: (data.accounts || []).map(acc => ({
      id: acc.account_id,
      name: acc.name,
      official_name: acc.official_name ?? null,
      mask: acc.mask ?? null,
      type: acc.type,
      subtype: acc.subtype ?? null,
      current: acc.balances?.current ?? null,
      available: acc.balances?.available ?? null,
      limit: acc.balances?.limit ?? null,
      currency: acc.balances?.iso_currency_code || acc.balances?.unofficial_currency_code || null,
    })),
    institution_id: data.item?.institution_id ?? null,
  };
}

/* Everything new since `cursor`, all pages at once. Plaid asks for a restart from
 * the original cursor if the data changes while paging. */
async function transactions({ token, cursor = '' }, env, fetchImpl) {
  const { a } = await unseal(env, token);
  if (typeof cursor !== 'string' || cursor.length > 2000) throw new RelayError(400, 'BAD_REQUEST', 'Bad cursor.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false, status: null };
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await plaid(env, '/transactions/sync', { access_token: a, cursor: out.next_cursor || undefined, count: 500 }, fetchImpl);
        out.added.push(...(data.added || []).map(txn));
        out.modified.push(...(data.modified || []).map(txn));
        out.removed.push(...(data.removed || []).map(r => r.transaction_id));
        out.next_cursor = data.next_cursor;
        out.has_more = !!data.has_more;
        out.status = data.transactions_update_status ?? null;
        if (!data.has_more) break;
      }
      return out;
    } catch (e) {
      if (!(e instanceof RelayError) || e.error.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt) throw e;
    }
  }
}
function txn(t) {
  return {
    id: t.transaction_id,
    account: t.account_id,
    date: t.date,
    name: t.merchant_name || t.name || '',
    amount: t.amount,              // Plaid: positive = money out of the account
    currency: t.iso_currency_code || t.unofficial_currency_code || null,
    pending: !!t.pending,
    category: t.personal_finance_category?.primary ?? null,
  };
}

async function remove({ token }, env, fetchImpl) {
  const { a } = await unseal(env, token);
  await plaid(env, '/item/remove', { access_token: a }, fetchImpl);
  return { removed: true };
}

/* ── Plaid ── */

function plaidEnv(env) { return env.PLAID_ENV === 'production' ? 'production' : 'sandbox'; }

async function plaid(env, path, body, fetchImpl) {
  const base = (env.PLAID_API_BASE || PLAID_HOSTS[plaidEnv(env)]).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
    });
  } catch (e) {
    throw new RelayError(502, 'PLAID_UNREACHABLE', 'The relay could not reach Plaid.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RelayError(res.status >= 500 ? 502 : 400, data.error_code || 'PLAID_ERROR',
      data.display_message || data.error_message || 'Plaid refused the request.', data.error_type);
  }
  return data;
}

/* ── sealed tokens: AES-GCM under RELAY_KEY, bound to the Plaid environment ── */

async function relayKey(env) {
  let raw;
  try { raw = Uint8Array.from(atob(env.RELAY_KEY || ''), c => c.charCodeAt(0)); } catch (e) { raw = new Uint8Array(0); }
  if (raw.length !== 32) throw new RelayError(500, 'RELAY_NOT_CONFIGURED', 'RELAY_KEY must be 32 random bytes in base64.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const additionalData = env => new TextEncoder().encode(`focus-bank-${TOKEN_VERSION}:${plaidEnv(env)}`);

async function seal(env, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(env) }, await relayKey(env), data);
  return `${TOKEN_VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

async function unseal(env, token) {
  requireConfig(env);
  const parts = typeof token === 'string' && token.length < 4000 ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw badToken();
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(parts[1]), additionalData: additionalData(env) },
      await relayKey(env), fromB64url(parts[2]));
    const payload = JSON.parse(new TextDecoder().decode(plain));
    if (typeof payload.a !== 'string') throw new Error('no access token');
    return payload;
  } catch (e) {
    if (e instanceof RelayError && e.error.code === 'RELAY_NOT_CONFIGURED') throw e;
    throw badToken();
  }
}
const badToken = () => new RelayError(401, 'TOKEN_INVALID', 'This bank connection was made with a different relay setup. Disconnect it and connect again.');

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/* ── plumbing ── */

class RelayError extends Error {
  constructor(status, code, message, type) {
    super(message);
    this.status = status;
    this.error = { code, message, ...(type ? { type } : {}) };
  }
}

function configProblems(env) {
  const problems = [];
  if (!env.PLAID_CLIENT_ID) problems.push('PLAID_CLIENT_ID is not set');
  if (!env.PLAID_SECRET) problems.push('PLAID_SECRET is not set');
  let keyLen = 0;
  try { keyLen = atob(env.RELAY_KEY || '').length; } catch (e) { keyLen = 0; }
  if (keyLen !== 32) problems.push('RELAY_KEY must be 32 random bytes in base64');
  if (env.PLAID_ENV && !PLAID_HOSTS[env.PLAID_ENV]) problems.push('PLAID_ENV must be sandbox or production');
  return problems;
}
function requireConfig(env) {
  const problems = configProblems(env);
  if (problems.length) throw new RelayError(500, 'RELAY_NOT_CONFIGURED', `The relay is not set up: ${problems.join('; ')}.`);
}

/* Browsers may call from the relay's own address or from ALLOWED_ORIGINS. A
 * request from any other web page is refused (null); tools that send no Origin
 * (curl, check.mjs) are let through, since CORS only protects browsers. */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origin !== new URL(request.url).origin && !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 20000) throw new RelayError(413, 'TOO_LARGE', 'Request too large.');
  try {
    const body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch (e) {
    throw new RelayError(400, 'BAD_REQUEST', 'Send a JSON object.');
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
