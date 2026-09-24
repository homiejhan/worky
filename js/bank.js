/* bank.js — Bank accounts (Settings → Bank accounts): connect a bank through Plaid,
 * then see its accounts, balances and recent transactions.
 *
 * Plaid's keys live on a small relay server (backend/bank/relay.mjs), never in the
 * app. For each connection the relay hands back a sealed token; it's kept here, on
 * this device only, next to the balances and transactions it fetched. None of it
 * is in the synced state or in Export. The connection is read-only. */
import { BANK_LS_KEY, BANK_RELAY_URL, PLAID_LINK_JS } from './config.js';
import { $, calKeyToDate, escAttr, showToast } from './util.js';
import { money } from './budget.js';

const BANK_USER_LS_KEY = 'focus-bank-user';   // random id Plaid knows this device by
const BANK_LINK_SS_KEY = 'focus-bank-link';   // link token, while an OAuth bank sends the user back
const BANK_TX_KEEP = 50;                        // newest transactions kept per bank
const BANK_TX_SHOW = 6;

/* { relay: address set on this device ('' = BANK_RELAY_URL),
 *   items: [{ id, token, institution: { id, name }, accounts, transactions, cursor,
 *             status, error, addedAt, updatedAt }] } */
let bank = { relay: '', items: [] };
let bankBusy = '';            // 'connect', or the id of the bank being refreshed / removed
let bankHealth = null;        // last /health answer this session: { url, state, env, problems }
let bankRelayForm = false;    // show the relay address form even though a relay is set
let bankRelayDraft = '';
let bankLinkPromise = null;

/* ── state (localStorage, this device only) ── */
function bankLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(BANK_LS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      bank = {
        relay: typeof raw.relay === 'string' ? raw.relay : '',
        items: Array.isArray(raw.items) ? raw.items.filter(i => i && typeof i.token === 'string' && i.id) : [],
      };
    }
  } catch (e) {}
}
function bankSave() {
  try { localStorage.setItem(BANK_LS_KEY, JSON.stringify(bank)); } catch (e) {}
}
export function bankConnectedCount() { return bank.items.length; }

function bankRelay() { return (bank.relay || BANK_RELAY_URL || '').trim().replace(/\/+$/, ''); }
/* https, or plain http on this computer for testing. No credentials in the address. */
function bankRelayValid(v) {
  try {
    const u = new URL(v);
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch (e) { return false; }
}
function bankUserId() {
  let id = null;
  try { id = localStorage.getItem(BANK_USER_LS_KEY); } catch (e) {}
  if (!id || !/^[\w-]{8,64}$/.test(id)) {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    id = 'focus-' + rand;
    try { localStorage.setItem(BANK_USER_LS_KEY, id); } catch (e) {}
  }
  return id;
}

/* ── talking to the relay ── */
function bankError(code, message) { const e = new Error(message); e.code = code; return e; }
async function bankCall(route, body) {
  const base = bankRelay();
  if (!base) throw bankError('NO_RELAY', 'Bank connections are not set up on this copy of Focus.');
  let res;
  try {
    res = await fetch(`${base}/${route}`, body === undefined ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw bankError('RELAY_UNREACHABLE', 'Could not reach the bank relay. Check its address and your connection.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw bankError((data.error && data.error.code) || 'RELAY_ERROR', (data.error && data.error.message) || `The bank relay answered ${res.status}.`);
  return data;
}
async function bankCheckRelay() {
  const url = bankRelay();
  bankHealth = { url, state: 'checking' };
  try {
    const h = await bankCall('health');
    bankHealth = { url, state: h.ok ? 'ok' : 'problem', env: h.env, problems: h.problems || [] };
  } catch (e) {
    bankHealth = { url, state: 'unreachable' };
  }
  if (bankRelay() === url) bankRenderSettings();
}

/* ── Plaid's window (Plaid Link, loaded from Plaid on first use) ── */
function bankLoadLink() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (!bankLinkPromise) {
    bankLinkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PLAID_LINK_JS;
      s.async = true;
      s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid missing')));
      s.onerror = () => { bankLinkPromise = null; s.remove(); reject(new Error('Plaid failed to load')); };
      document.head.appendChild(s);
    });
  }
  return bankLinkPromise;
}
function bankOpenLink(Plaid, token, receivedRedirectUri) {
  const handler = Plaid.create({
    token,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
    onSuccess: (publicToken, metadata) => { bankLinked(publicToken, metadata); },
    onExit: err => {
      try { sessionStorage.removeItem(BANK_LINK_SS_KEY); } catch (e) {}
      bankBusy = '';
      bankRenderSettings();
      if (err) showToast(err.display_message || err.error_message || 'The bank connection was not finished.');
    },
  });
  handler.open();
}

async function bankConnect() {
  if (bankBusy) return;
  bankBusy = 'connect';
  bankRenderSettings();
  try {
    const [{ link_token }, Plaid] = await Promise.all([
      bankCall('link-token', { user: bankUserId() }),
      bankLoadLink().catch(() => { throw bankError('LINK_UNAVAILABLE', 'Plaid\'s window could not load. Check your connection and try again.'); }),
    ]);
    try { sessionStorage.setItem(BANK_LINK_SS_KEY, link_token); } catch (e) {}
    bankOpenLink(Plaid, link_token);
  } catch (e) {
    bankBusy = '';
    bankRenderSettings();
    showToast(e.message);
  }
}

/* Plaid's window finished: trade its one-time token for a sealed one, then fetch. */
async function bankLinked(publicToken, metadata) {
  try { sessionStorage.removeItem(BANK_LINK_SS_KEY); } catch (e) {}
  bankBusy = 'connect';
  bankRenderSettings();
  try {
    const { token, item_id } = await bankCall('exchange', { public_token: publicToken });
    const inst = (metadata && metadata.institution) || {};
    const item = {
      id: item_id, token,
      institution: { id: inst.institution_id || null, name: inst.name || 'Your bank' },
      accounts: [], transactions: [], cursor: '', status: null, error: null,
      addedAt: Date.now(), updatedAt: 0,
    };
    bank.items = bank.items.filter(i => i.id !== item_id).concat(item);
    bankSave();
    await bankRefresh(item, true);
    showToast(`Connected to ${item.institution.name} ✓`);
  } catch (e) {
    showToast(e.message);
  }
  bankBusy = '';
  bankRenderSettings();
}

/* Balances, then whatever changed in transactions since the saved cursor. */
async function bankRefresh(item, quiet) {
  try {
    const acc = await bankCall('accounts', { token: item.token });
    item.accounts = Array.isArray(acc.accounts) ? acc.accounts : [];
    const tx = await bankCall('transactions', { token: item.token, cursor: item.cursor || '' });
    const byId = new Map(item.transactions.map(t => [t.id, t]));
    (tx.removed || []).forEach(id => byId.delete(id));
    [...(tx.added || []), ...(tx.modified || [])].forEach(t => byId.set(t.id, t));
    item.transactions = [...byId.values()]
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
      .slice(0, BANK_TX_KEEP);
    item.cursor = tx.next_cursor || item.cursor || '';
    item.status = tx.status || null;
    item.error = null;
    item.updatedAt = Date.now();
  } catch (e) {
    item.error = { code: e.code || 'ERROR', message: e.message };
    if (!quiet) showToast(e.message);
  }
  bankSave();
}
async function bankRefreshNow(item) {
  if (bankBusy) return;
  bankBusy = item.id;
  bankRenderSettings();
  await bankRefresh(item, false);
  bankBusy = '';
  bankRenderSettings();
}

async function bankDisconnect(item) {
  if (bankBusy) return;
  if (!confirm(`Disconnect ${item.institution.name}?\n\nFocus stops reading it, and its balances and transactions are deleted from this device.`)) return;
  bankBusy = item.id;
  bankRenderSettings();
  let ended = true;
  try { await bankCall('remove', { token: item.token }); }
  catch (e) { ended = e.code === 'INVALID_ACCESS_TOKEN' || e.code === 'ITEM_NOT_FOUND'; }
  bank.items = bank.items.filter(i => i !== item);
  bankSave();
  bankBusy = '';
  bankRenderSettings();
  showToast(ended ? `Disconnected ${item.institution.name}`
    : `Removed from this device. To end it at Plaid too, use my.plaid.com.`);
}

function bankSaveRelay(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (v && !bankRelayValid(v)) { showToast('Use an https:// address, or http://localhost when testing.'); return; }
  bank.relay = v;
  bankRelayForm = false;
  bankRelayDraft = '';
  bankHealth = null;
  bankSave();
  bankRenderSettings();
  showToast(v ? 'Relay saved on this device' : 'Relay address cleared');
}

/* Start-up: load the saved connections, and finish a connection an OAuth bank
 * (Chase, Bank of America, …) sent the user back from mid-way. */
export function bankInit() {
  bankLoad();
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
  if (!params.has('oauth_state_id')) return;
  let token = null;
  try { token = sessionStorage.getItem(BANK_LINK_SS_KEY); } catch (e) {}
  const received = window.location.href;
  history.replaceState(null, '', window.location.pathname + window.location.hash);
  if (!token) return;
  bankBusy = 'connect';
  bankLoadLink()
    .then(Plaid => bankOpenLink(Plaid, token, received))
    .catch(() => { bankBusy = ''; showToast('Plaid\'s window could not load to finish connecting your bank.'); });
}

/* ── Settings → Bank accounts ── */
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function bankAgo(ms) {
  if (!ms) return 'Not updated yet';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'Updated just now';
  if (m < 60) return `Updated ${m} min ago`;
  if (m < 24 * 60) return `Updated ${Math.round(m / 60)} h ago`;
  return 'Updated ' + new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function bankHost(url) { try { return new URL(url).host; } catch (e) { return url; } }

function bankAccountHtml(a) {
  const credit = a.type === 'credit' || a.type === 'loan';
  const main = a.current ?? a.available;
  const avail = !credit && a.available != null && a.current != null && a.available !== a.current
    ? `<span class="bank-acct-sub">${money(a.available)} available</span>` : '';
  return `
    <div class="bank-acct">
      <div class="bank-acct-main">
        <span class="bank-acct-name">${escAttr(a.name || 'Account')}${a.mask ? ` <span class="bank-mask">••${escAttr(a.mask)}</span>` : ''}</span>
        <span class="bank-acct-kind">${escAttr(a.subtype || a.type || '')}</span>
      </div>
      <div class="bank-acct-bal">
        <span class="bank-acct-value">${main == null ? '—' : money(main)}${credit && main != null ? ' <span class="bank-acct-sub">owed</span>' : ''}</span>
        ${avail}
      </div>
    </div>`;
}
function bankTxHtml(t) {
  const moneyIn = t.amount < 0;                 // Plaid: positive = money out
  const date = /^\d{4}-\d{2}-\d{2}$/.test(t.date || '')
    ? calKeyToDate(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return `
    <div class="bank-tx">
      <span class="bank-tx-date">${date}</span>
      <span class="bank-tx-name">${escAttr(t.name || 'Transaction')}${t.pending ? ' <span class="bank-pending">pending</span>' : ''}</span>
      <span class="bank-tx-amt${moneyIn ? ' in' : ''}">${moneyIn ? '+' : '-'}${money(Math.abs(t.amount || 0))}</span>
    </div>`;
}
function bankItemHtml(item) {
  const busy = bankBusy === item.id;
  const err = item.error
    ? `<div class="bank-error">${escAttr(item.error.code === 'ITEM_LOGIN_REQUIRED'
      ? `${item.institution.name} needs you to log in again. Disconnect it and connect again.` : item.error.message)}</div>` : '';
  const tx = item.transactions.slice(0, BANK_TX_SHOW);
  const txBlock = tx.length
    ? `<div class="bank-tx-title">Recent transactions</div><div class="bank-txs">${tx.map(bankTxHtml).join('')}</div>`
    : (item.updatedAt ? '<div class="bank-fine">No transactions yet. Plaid can take a minute to gather them for a new connection: press Refresh.</div>' : '');
  return `
    <div class="bank-item" data-item="${escAttr(item.id)}">
      <div class="bank-item-head">
        <span class="bank-inst">${escAttr(item.institution.name)}</span>
        <span class="bank-updated">${busy ? 'Working…' : bankAgo(item.updatedAt)}</span>
      </div>
      ${err}
      <div class="bank-accounts">${item.accounts.map(bankAccountHtml).join('') || '<div class="bank-fine">No accounts read yet.</div>'}</div>
      ${txBlock}
      <div class="bank-actions">
        <button class="modal-file-btn" data-bank="refresh" data-item="${escAttr(item.id)}"${bankBusy ? ' disabled' : ''}>${busy ? 'Refreshing…' : 'Refresh'}</button>
        <button class="modal-file-btn settings-danger-btn" data-bank="disconnect" data-item="${escAttr(item.id)}"${bankBusy ? ' disabled' : ''}>Disconnect</button>
      </div>
    </div>`;
}
function bankRelayFormHtml(intro) {
  const value = bankRelayDraft || bank.relay || '';
  return `
    ${intro}
    <div class="bank-relay-form">
      <label class="bank-label" for="bankRelayInput">Relay address, for trying it on this device</label>
      <div class="theme-inline">
        <input class="theme-text" id="bankRelayInput" type="url" value="${escAttr(value)}" placeholder="http://localhost:8787/api/bank" autocomplete="off" spellcheck="false">
        <button class="modal-primary" data-bank="relay-save">Save</button>
      </div>${bankRelay() ? '<button class="dg-prompt-link" data-bank="relay-cancel">Cancel</button>' : ''}
      <div class="bank-fine">Only use a relay you, or whoever runs your copy of Focus, set up.${bank.relay && BANK_RELAY_URL ? ' <button class="dg-prompt-link" data-bank="relay-reset">Use the default relay</button>' : ''}</div>
    </div>`;
}
function bankRelayLine() {
  const h = bankHealth && bankHealth.url === bankRelay() ? bankHealth : { state: 'checking' };
  const where = escAttr(bankHost(bankRelay()));
  const state = h.state === 'ok' ? `Plaid ${h.env === 'production' ? 'production' : 'sandbox'}`
    : h.state === 'problem' ? `not set up: ${escAttr(h.problems.join('; '))}`
    : h.state === 'unreachable' ? 'can\'t reach it' : 'checking…';
  const sandbox = h.state === 'ok' && h.env !== 'production'
    ? '<div class="bank-fine">Sandbox: Plaid\'s test banks, no real money. Pick First Platypus Bank and log in with <b>user_good</b> / <b>pass_good</b>.</div>' : '';
  return `${sandbox}<div class="bank-relay-line${h.state === 'problem' || h.state === 'unreachable' ? ' warn' : ''}">Relay: ${where} · ${state} <button class="dg-prompt-link" data-bank="relay-change">Change</button></div>`;
}

export function bankRenderSettings() {
  const line = $('bankStatusLine'), panel = $('bankPanel');
  if (!line || !panel) return;
  bankBind(panel);
  const relay = bankRelay();
  const accounts = bank.items.reduce((n, i) => n + i.accounts.length, 0);
  line.textContent = !relay ? 'Not set up on this copy of Focus.'
    : !bank.items.length ? 'No banks connected.'
    : `${plural(accounts, 'account')} at ${plural(bank.items.length, 'bank')}, kept on this device only.`;

  if (!relay) {
    panel.innerHTML = bankRelayFormHtml(`
      <div class="bank-intro">See balances and recent transactions from your bank accounts. Banks connect through Plaid and a small relay server that holds this copy of Focus's Plaid keys, and that relay hasn't been set up yet.</div>
      <a class="bank-link" href="help/#bank-setup" target="_blank" rel="noopener">How to set up bank connections</a>`);
    return;
  }
  const connecting = bankBusy === 'connect';
  panel.innerHTML = `
    ${bank.items.map(bankItemHtml).join('')}
    <button class="gcal-connect-btn bank-connect-btn" data-bank="connect"${bankBusy ? ' disabled' : ''}>${connecting ? 'Connecting…' : bank.items.length ? 'Connect another bank' : 'Connect a bank'}</button>
    <div class="bank-fine">You log in to your bank in Plaid's window; Focus never sees your password. The connection is read-only, and balances and transactions stay on this device.</div>
    <a class="settings-help-link" href="help/#bank" target="_blank" rel="noopener">How bank connections work</a>
    ${bankRelayForm ? bankRelayFormHtml('') : bankRelayLine()}`;
  if (!bankHealth || bankHealth.url !== relay) bankCheckRelay();
}

function bankBind(panel) {
  if (panel._bankBound) return;
  panel._bankBound = true;
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-bank]');
    if (!b || b.disabled) return;
    const act = b.dataset.bank;
    const item = bank.items.find(i => i.id === b.dataset.item);
    if (act === 'connect') bankConnect();
    else if (act === 'refresh' && item) bankRefreshNow(item);
    else if (act === 'disconnect' && item) bankDisconnect(item);
    else if (act === 'relay-save') bankSaveRelay($('bankRelayInput') && $('bankRelayInput').value);
    else if (act === 'relay-reset') bankSaveRelay('');
    else if (act === 'relay-change') { bankRelayForm = true; bankRenderSettings(); $('bankRelayInput')?.focus(); }
    else if (act === 'relay-cancel') { bankRelayForm = false; bankRelayDraft = ''; bankRenderSettings(); }
  });
  panel.addEventListener('input', e => { if (e.target.id === 'bankRelayInput') bankRelayDraft = e.target.value; });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'bankRelayInput') { e.preventDefault(); bankSaveRelay(e.target.value); }
  });
}
