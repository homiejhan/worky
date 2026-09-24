/* A stand-in for Plaid's API, for tests: the endpoints the bank relay calls plus
 * /sandbox/public_token/create, answering in Plaid's shapes with data like
 * Plaid's sandbox bank (First Platypus Bank, user_good / pass_good). Use its
 * fetchImpl in-process, or listen() to serve it over HTTP (PLAID_API_BASE). */
const http = require('http');

const DAY = 86400000;
const day = n => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function sandboxAccounts() {
  return [
    { account_id: 'acc-checking', name: 'Plaid Checking', official_name: 'Plaid Gold Standard 0% Interest Checking', mask: '0000',
      type: 'depository', subtype: 'checking', balances: { available: 100, current: 110, limit: null, iso_currency_code: 'USD' } },
    { account_id: 'acc-saving', name: 'Plaid Saving', official_name: 'Plaid Silver Standard 0.1% Interest Saving', mask: '1111',
      type: 'depository', subtype: 'savings', balances: { available: 200, current: 210, limit: null, iso_currency_code: 'USD' } },
    { account_id: 'acc-credit', name: 'Plaid Credit Card', official_name: 'Plaid Diamond 12.5% APR Interest Credit Card', mask: '3333',
      type: 'credit', subtype: 'credit card', balances: { available: null, current: 410, limit: 2000, iso_currency_code: 'USD' } },
  ];
}
function sandboxTransactions() {
  const t = (id, account, n, name, amount, category, pending = false) => ({
    transaction_id: id, account_id: account, date: day(n), authorized_date: day(n), name, merchant_name: name,
    amount, iso_currency_code: 'USD', pending, personal_finance_category: { primary: category, detailed: category },
  });
  return [
    t('tx-1', 'acc-checking', 1, 'Starbucks', 4.33, 'FOOD_AND_DRINK', true),
    t('tx-2', 'acc-checking', 2, 'Uber', 6.33, 'TRANSPORTATION'),
    t('tx-3', 'acc-credit', 3, 'SparkFun', 89.4, 'GENERAL_MERCHANDISE'),
    t('tx-4', 'acc-checking', 4, 'Campus Café payroll', -232.5, 'INCOME'),
    t('tx-5', 'acc-credit', 6, "McDonald's", 12, 'FOOD_AND_DRINK'),
    t('tx-6', 'acc-checking', 8, 'Touchstone Climbing', 78.5, 'ENTERTAINMENT'),
    t('tx-7', 'acc-saving', 9, 'Interest payment', -4.22, 'INCOME'),
  ];
}

function createFakePlaid({ clientId = 'test-client', secret = 'test-secret' } = {}) {
  const state = {
    calls: [],                 // { path, body } for every request
    items: new Map(),          // access_token → { item_id, transactions, removed }
    failNext: null,            // { path, status, error_code, error_type, error_message, display_message }
    mutateOnce: false,         // second sync page answers TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION once
    pageSize: 4,
    n: 0,
  };
  const error = (status, code, message, type = 'INVALID_INPUT', display = null) =>
    [status, { error_type: type, error_code: code, error_message: message, display_message: display, request_id: 'req-err' }];

  function answer(path, body) {
    if (body.client_id !== clientId || body.secret !== secret) return error(400, 'INVALID_API_KEYS', 'invalid client_id or secret provided');
    if (state.failNext && state.failNext.path === path) {
      const f = state.failNext; state.failNext = null;
      return [f.status || 400, { error_type: f.error_type || 'ITEM_ERROR', error_code: f.error_code, error_message: f.error_message || f.error_code, display_message: f.display_message ?? null }];
    }
    const item = body.access_token ? state.items.get(body.access_token) : null;
    if (body.access_token && (!item || item.removed)) return error(400, 'INVALID_ACCESS_TOKEN', 'provided access token is in an invalid format');
    switch (path) {
      case '/link/token/create':
        return [200, { link_token: `link-sandbox-${++state.n}`, expiration: new Date(Date.now() + 4 * 3600e3).toISOString(), request_id: 'r' }];
      case '/sandbox/public_token/create':
        return [200, { public_token: `public-sandbox-${++state.n}`, request_id: 'r' }];
      case '/item/public_token/exchange': {
        if (!/^public-sandbox-/.test(body.public_token || '')) return error(400, 'INVALID_PUBLIC_TOKEN', 'provided public token is in an invalid format');
        const id = ++state.n;
        const token = `access-sandbox-${id}`;
        state.items.set(token, { item_id: `item-${id}`, transactions: sandboxTransactions(), removed: false, delivered: 0 });
        return [200, { access_token: token, item_id: `item-${id}`, request_id: 'r' }];
      }
      case '/accounts/get':
        return [200, { accounts: sandboxAccounts(), item: { item_id: item.item_id, institution_id: 'ins_109508' }, request_id: 'r' }];
      case '/transactions/sync': {
        const start = body.cursor ? Number(String(body.cursor).split('-').pop()) : 0;
        if (state.mutateOnce && start > 0) { state.mutateOnce = false; return error(400, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'data changed while paging', 'TRANSACTIONS_ERROR'); }
        const added = item.transactions.slice(start, start + state.pageSize);
        const next = start + added.length;
        return [200, { added, modified: [], removed: [], next_cursor: `cursor-${next}`, has_more: next < item.transactions.length,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE', request_id: 'r' }];
      }
      case '/item/remove':
        item.removed = true;
        return [200, { request_id: 'r' }];
      default:
        return error(404, 'NOT_FOUND', 'unknown endpoint', 'INVALID_REQUEST');
    }
  }

  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch (e) {}
    state.calls.push({ path, body });
    const [status, data] = answer(path, body);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };

  function listen(port = 0) {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await fetchImpl(`http://fake${req.url}`, { body: Buffer.concat(chunks).toString() });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(await r.text());
    });
    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
  }

  /* Add transactions after the first sync, to test Refresh. */
  function addTransactions(accessToken, list) { state.items.get(accessToken).transactions.push(...list); }

  return { state, fetchImpl, listen, addTransactions };
}

module.exports = { createFakePlaid, sandboxAccounts, sandboxTransactions };
