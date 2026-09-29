/* bank.js — Bank accounts (Settings → Bank accounts): connect a bank through Plaid,
 * then see its accounts, balances and recent transactions.
 *
 * Plaid's keys live on a small relay server (backend/bank/relay.mjs), never in the
 * app. A connection belongs to the signed-in account (Cloud sync), not to a
 * device: every call to the relay carries the account's Firebase ID token, and the
 * sealed token the relay hands back for a connection only opens for that account.
 * The app saves each connection to the account, at users/<uid>/bank/items/<id>
 * (the sealed token, balances and recent transactions), so every device signed in
 * to it shows the bank, and Disconnect removes it from all of them. This device
 * keeps a copy for when it's offline, dropped on sign-out. None of it is in the
 * synced state or in Export. The connection is read-only. */
import { BANK_LS_KEY, BANK_RELAY_URL, PLAID_LINK_JS } from './config.js';
import { $, calKeyToDate, escAttr, showToast } from './util.js';
import { money } from './budget.js';
import { syncBtnClick, syncConfigured, syncRef, syncUser } from './sync.js';

const BANK_LINK_SS_KEY = 'focus-bank-link';   // { uid, token }: the link token, while an OAuth bank sends the user back
const BANK_TOKEN = /^v2\./;                    // sealed to an account; an older build's v1 tokens belonged to a device
const BANK_ID = /^[\w-]{1,128}$/;              // a Plaid item id, used as a database key
const BANK_TX_KEEP = 50;                        // newest transactions kept per bank
const BANK_TX_SHOW = 6;

/* This device's copy, for the account `uid` (null = signed out):
 * { uid, relay: address set on this device ('' = BANK_RELAY_URL),
 *   items: [{ id, token, institution: { id, name }, accounts, transactions, cursor,
 *             error, addedAt, updatedAt }] }
 * The account's copy, users/<uid>/bank = { updatedAt, items: { <id>: item } }, is
 * the one that counts: whenever it changes, this one follows. */
let bank = { uid: null, relay: '', items: [] };
let bankCloudKnown = false;   // the account's bank node has been seen since it signed in
let bankBusy = '';            // 'connect', or the id of the bank being refreshed / removed
let bankHealth = null;        // last /health answer this session: { url, state, env, problems }
let bankRelayForm = false;    // show the relay address form even though a relay is set
let bankRelayDraft = '';
let bankLinkPromise = null;
let bankResume = null;        // { uid, token, received }: an OAuth bank sent the user back mid-way

/* ── this device's copy (localStorage) ── */
function bankLoad() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(BANK_LS_KEY) || 'null'); } catch (e) {}
  if (!raw || typeof raw !== 'object') return;
  const uid = typeof raw.uid === 'string' && raw.uid ? raw.uid : null;
  const saved = Array.isArray(raw.items) ? raw.items : [];
  bank = {
    uid,
    relay: typeof raw.relay === 'string' ? raw.relay : '',
    items: uid ? saved.map(i => bankItem(i, i && i.id)).filter(Boolean) : [],
  };
  /* An older build kept each connection on its device, sealed to no one; the relay refuses those now. */
  if (saved.some(i => i && typeof i.token === 'string' && !BANK_TOKEN.test(i.token))) {
    bankSave();
    showToast('Bank connections now live in your account. Connect your bank again.');
  }
}
function bankSave() {
  try { localStorage.setItem(BANK_LS_KEY, JSON.stringify({ uid: bank.uid, relay: bank.relay, items: bank.uid ? bank.items : [] })); } catch (e) {}
}
/* A connection as stored (in the account or here), or null if it can't be used.
 * The database keeps no nulls or empty lists, so those can come back missing. */
function bankItem(raw, id) {
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || !BANK_TOKEN.test(raw.token)) return null;
  id = String(id || '');
  if (!BANK_ID.test(id)) return null;
  const list = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);
  const inst = raw.institution && typeof raw.institution === 'object' ? raw.institution : {};
  const err = raw.error && typeof raw.error === 'object' ? raw.error : null;
  return {
    id, token: raw.token,
    institution: { id: typeof inst.id === 'string' ? inst.id : null, name: typeof inst.name === 'string' && inst.name ? inst.name : 'Your bank' },
    accounts: list(raw.accounts),
    transactions: list(raw.transactions),
    cursor: typeof raw.cursor === 'string' ? raw.cursor : '',
    error: err ? { code: String(err.code || 'ERROR'), message: String(err.message || '') } : null,
    addedAt: Number(raw.addedAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}
/* The signed-in account's connections, as this device last saw them. */
function bankItems() { return syncUser && bank.uid === syncUser.uid ? bank.items : []; }

/* ── the account's copy: users/<uid>/bank ──
 * Each connection is written on its own (items/<id>, set() or remove()) along with
 * bank/updatedAt, never the whole node: two devices changing different banks don't
 * overwrite each other, and for the same bank the last write wins. State pushes
 * use update(), which leaves the node alone. `uid` is the account a change was
 * made for; if another account has signed in since, the change is dropped. */
function bankWrite(uid, id, item) {
  if (!uid || !syncUser || syncUser.uid !== uid || bank.uid !== uid || !syncRef) return Promise.resolve(false);
  bank.items = item
    ? (bank.items.some(x => x.id === id) ? bank.items.map(x => (x.id === id ? item : x)) : [...bank.items, item])
    : bank.items.filter(x => x.id !== id);
  bankSave();                                            // here at once; the account's copy confirms it
  const node = syncRef.child('bank');
  const saved = item ? node.child('items/' + id).set(JSON.parse(JSON.stringify(item))) : node.child('items/' + id).remove();
  return Promise.all([saved, node.child('updatedAt').set(Date.now())])
    .then(() => true)
    .catch(err => {
      const perm = /permission/i.test(String((err && (err.message || err.code)) || ''));
      showToast(perm ? 'Could not save: your database rules block users/<uid>/bank'
                     : 'Could not save the bank to your account. Try again when you are online.');
      return false;
    });
}
/* sync.js hands over users/<uid>/bank (or nothing) whenever the account's node changes. */
export function bankCloudSeen(node) {
  if (!syncUser) return;
  const raw = node && typeof node === 'object' && node.items && typeof node.items === 'object' ? node.items : {};
  const items = Object.keys(raw).map(id => bankItem(raw[id], id)).filter(Boolean)
    .sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1));
  const before = JSON.stringify([bank.uid, bank.items, bankCloudKnown]);
  bank.uid = syncUser.uid;
  bank.items = items;
  bankCloudKnown = true;
  if (JSON.stringify([bank.uid, bank.items, bankCloudKnown]) !== before) { bankSave(); bankRender(); }
  bankResumeLink();
}
/* sync.js calls this whenever the signed-in account changes (sign-in, sign-out, the
 * session coming back at start-up), before it listens again. Connections belong to
 * the account: another account, or nobody, doesn't get this device's copy. */
export function bankCloudForget() {
  bankCloudKnown = false;
  const uid = syncUser ? syncUser.uid : null;
  if (bank.uid !== uid) { bank.uid = uid; bank.items = []; bankSave(); }
  if (!syncUser && bankResume) {
    bankResume = null;
    bankBusy = '';
    try { sessionStorage.removeItem(BANK_LINK_SS_KEY); } catch (e) {}
    showToast('Sign in to Cloud sync, then connect your bank again.');
  }
  bankRender();
}

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

/* ── talking to the relay ── */
function bankError(code, message, more) { const e = new Error(message); e.code = code; return Object.assign(e, more); }
async function bankFetch(route, body, idToken) {
  const base = bankRelay();
  if (!base) throw bankError('NO_RELAY', 'Bank connections are not set up on this copy of Focus.');
  let res;
  try {
    res = await fetch(`${base}/${route}`, body === undefined ? { method: 'GET' } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw bankError('RELAY_UNREACHABLE', 'Could not reach the bank relay. Check its address and your connection.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = data.error || {};
    throw bankError(err.code || 'RELAY_ERROR', err.message || `The bank relay answered ${res.status}.`, { status: res.status, type: err.type || null });
  }
  return data;
}
/* Every call but /health goes as the signed-in account, with its Firebase ID
 * token. If the relay turns the sign-in down (401 AUTH_…), once more with a fresh one. */
async function bankCall(route, body) {
  if (body === undefined) return bankFetch(route);
  const user = syncUser;
  if (!user) throw bankError('AUTH_REQUIRED', 'Sign in to Cloud sync to use bank connections.');
  const idToken = async fresh => {
    try { return await user.getIdToken(fresh); }
    catch (e) { throw bankError('AUTH_UNAVAILABLE', 'Could not check your sign-in. Check your connection and try again.'); }
  };
  try {
    return await bankFetch(route, body, await idToken(false));
  } catch (e) {
    if (e.status !== 401 || !/^AUTH_/.test(e.code)) throw e;
    return bankFetch(route, body, await idToken(true));
  }
}
/* A problem with the connection itself, the same whichever device asks: Plaid's
 * item errors (the bank wants a new login, …) or a connection Plaid no longer has.
 * It's saved with the connection; anything else (offline, sign-in, this device's
 * relay) stays on this device. */
function bankItemError(e) { return e.type === 'ITEM_ERROR' || e.code === 'INVALID_ACCESS_TOKEN'; }
async function bankCheckRelay() {
  const url = bankRelay();
  bankHealth = { url, state: 'checking' };
  try {
    const h = await bankCall('health');
    /* a relay from before sign-ins were checked has no `auth`, and its CORS turns the sign-in header away */
    bankHealth = { url, state: !h.ok ? 'problem' : h.auth === true ? 'ok' : 'outdated', env: h.env, problems: h.problems || [] };
  } catch (e) {
    bankHealth = { url, state: 'unreachable' };
  }
  if (bankRelay() === url) bankRender();
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
  if (bankBusy || !syncUser) return;
  const uid = syncUser.uid;
  bankBusy = 'connect';
  bankRenderSettings();
  try {
    const [{ link_token }, Plaid] = await Promise.all([
      bankCall('link-token', {}),
      bankLoadLink().catch(() => { throw bankError('LINK_UNAVAILABLE', 'Plaid\'s window could not load. Check your connection and try again.'); }),
    ]);
    try { sessionStorage.setItem(BANK_LINK_SS_KEY, JSON.stringify({ uid, token: link_token })); } catch (e) {}
    bankOpenLink(Plaid, link_token);
  } catch (e) {
    bankBusy = '';
    bankRenderSettings();
    showToast(e.message);
  }
}

/* Plaid's window finished: trade its one-time token for a sealed one, save the
 * connection to the account, then fetch its balances and transactions. */
async function bankLinked(publicToken, metadata) {
  try { sessionStorage.removeItem(BANK_LINK_SS_KEY); } catch (e) {}
  const uid = syncUser && syncUser.uid;
  bankBusy = 'connect';
  bankRenderSettings();
  try {
    const { token, item_id } = await bankCall('exchange', { public_token: publicToken });
    const inst = (metadata && metadata.institution) || {};
    const item = bankItem({
      token, institution: { id: inst.institution_id || null, name: inst.name || 'Your bank' }, addedAt: Date.now(),
    }, item_id);
    if (!item) throw bankError('RELAY_ERROR', 'The bank relay sent back a connection this version of Focus can\'t use. Update the relay, then connect again.');
    bankWrite(uid, item.id, item);                       // the connection exists at Plaid now: keep it first
    const err = await bankRefresh(uid, item);
    showToast(err ? `Connected to ${item.institution.name}, but: ${err.message}` : `Connected to ${item.institution.name} ✓`);
  } catch (e) {
    showToast(e.message);
  }
  bankBusy = '';
  bankRenderSettings();
}

/* Balances, then whatever changed in transactions since the saved cursor, saved to
 * the account. Returns the error, if any (see bankItemError for which are saved). */
async function bankRefresh(uid, item) {
  const next = { ...item };
  let failed = null;
  try {
    const acc = await bankCall('accounts', { token: item.token });
    next.accounts = Array.isArray(acc.accounts) ? acc.accounts : [];
    const tx = await bankCall('transactions', { token: item.token, cursor: item.cursor || '' });
    const byId = new Map(item.transactions.map(t => [t.id, t]));
    (tx.removed || []).forEach(id => byId.delete(id));
    [...(tx.added || []), ...(tx.modified || [])].forEach(t => byId.set(t.id, t));
    next.transactions = [...byId.values()]
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
      .slice(0, BANK_TX_KEEP);
    next.cursor = tx.next_cursor || item.cursor || '';
    next.error = null;
    next.updatedAt = Date.now();
  } catch (e) {
    failed = e;
    if (!bankItemError(e)) return e;
    next.error = { code: e.code || 'ERROR', message: e.message };
  }
  bankWrite(uid, next.id, next);
  return failed;
}
async function bankRefreshNow(item) {
  if (bankBusy || !syncUser) return;
  bankBusy = item.id;
  bankRenderSettings();
  const err = await bankRefresh(syncUser.uid, item);
  bankBusy = '';
  bankRenderSettings();
  if (err) showToast(err.message);
}

async function bankDisconnect(item) {
  if (bankBusy || !syncUser) return;
  if (!confirm(`Disconnect ${item.institution.name}?\n\nFocus stops reading it, and its balances and transactions are deleted from your account, on every device.`)) return;
  const uid = syncUser.uid;
  bankBusy = item.id;
  bankRenderSettings();
  let ended = true;
  try { await bankCall('remove', { token: item.token }); }
  catch (e) { ended = e.code === 'INVALID_ACCESS_TOKEN' || e.code === 'ITEM_NOT_FOUND'; }
  bankWrite(uid, item.id, null);
  bankBusy = '';
  bankRenderSettings();
  showToast(ended ? `Disconnected ${item.institution.name}`
    : 'Removed from your account. To end it at Plaid too, use my.plaid.com.');
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

/* Start-up: this device's copy of the account's connections, and a connection an
 * OAuth bank (Chase, Bank of America, …) sent the user back from mid-way. That one
 * finishes once the account is signed in (bankResumeLink). */
export function bankInit() {
  bankLoad();
  try { localStorage.removeItem('focus-bank-user'); } catch (e) {}   // the device id an older build gave Plaid
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
  if (!params.has('oauth_state_id')) return;
  let link = null;
  try { link = JSON.parse(sessionStorage.getItem(BANK_LINK_SS_KEY) || 'null'); } catch (e) {}
  const received = window.location.href;
  history.replaceState(null, '', window.location.pathname + window.location.hash);
  if (!link || typeof link.uid !== 'string' || typeof link.token !== 'string') return;
  bankResume = { uid: link.uid, token: link.token, received };
  bankBusy = 'connect';
  bankLoadLink().catch(() => {});                        // fetch Plaid's window while the account signs in
}
/* Only the account that started the connection may finish it. */
function bankResumeLink() {
  if (!bankResume || !syncUser) return;
  const { uid, token, received } = bankResume;
  bankResume = null;
  if (uid !== syncUser.uid) {
    try { sessionStorage.removeItem(BANK_LINK_SS_KEY); } catch (e) {}
    bankBusy = '';
    bankRender();
    showToast('That bank connection was started by another account. Connect your bank again.');
    return;
  }
  bankLoadLink()
    .then(Plaid => bankOpenLink(Plaid, token, received))
    .catch(() => { bankBusy = ''; bankRender(); showToast('Plaid\'s window could not load to finish connecting your bank.'); });
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
    : h.state === 'outdated' ? 'out of date: it doesn\'t check sign-ins yet, so deploy the current backend/bank'
    : h.state === 'unreachable' ? 'can\'t reach it' : 'checking…';
  const sandbox = h.state === 'ok' && h.env !== 'production'
    ? '<div class="bank-fine">Sandbox: Plaid\'s test banks, no real money. Pick First Platypus Bank and log in with <b>user_good</b> / <b>pass_good</b>.</div>' : '';
  return `${sandbox}<div class="bank-relay-line${['problem', 'outdated', 'unreachable'].includes(h.state) ? ' warn' : ''}">Relay: ${where} · ${state} <button class="dg-prompt-link" data-bank="relay-change">Change</button></div>`;
}

/* Settings → Bank accounts, and the relay's health once per relay address. */
export function bankRenderSettings() {
  bankRender();
  const relay = bankRelay();
  if (relay && (!bankHealth || bankHealth.url !== relay)) bankCheckRelay();
}
function bankRender() {
  const line = $('bankStatusLine'), panel = $('bankPanel');
  if (!line || !panel) return;
  bankBind(panel);
  const relay = bankRelay();
  const items = bankItems();
  const loading = !!syncUser && !bankCloudKnown && !items.length;
  const accounts = items.reduce((n, i) => n + i.accounts.length, 0);
  line.textContent = !relay ? 'Not set up on this copy of Focus.'
    : !syncUser ? 'Sign in to Cloud sync to connect a bank.'
    : loading ? 'Loading the banks saved to your account…'
    : !items.length ? 'No banks connected.'
    : `${plural(accounts, 'account')} at ${plural(items.length, 'bank')}, saved to your account.`;

  if (!relay) {
    panel.innerHTML = bankRelayFormHtml(`
      <div class="bank-intro">See balances and recent transactions from your bank accounts. Banks connect through Plaid and a small relay server that holds this copy of Focus's Plaid keys, and that relay hasn't been set up yet.</div>
      <a class="bank-link" href="help/#bank-setup" target="_blank" rel="noopener">How to set up bank connections</a>`);
    return;
  }
  const help = '<a class="settings-help-link" href="help/#bank" target="_blank" rel="noopener">How bank connections work</a>';
  const relayBlock = bankRelayForm ? bankRelayFormHtml('') : bankRelayLine();
  if (!syncUser) {
    panel.innerHTML = `
      <div class="bank-intro">See balances and recent transactions from your bank accounts. A bank connection belongs to your account, so it needs Cloud sync: sign in, connect a bank once, and every device you sign in on shows it.</div>
      ${syncConfigured() ? '<button class="gcal-connect-btn bank-connect-btn" data-bank="sign-in">Sign in to Cloud sync</button>'
        : '<div class="bank-fine">Cloud sync is not set up on this copy of Focus.</div>'}
      ${help}
      ${relayBlock}`;
    return;
  }
  if (loading) { panel.innerHTML = `${help}${relayBlock}`; return; }
  const connecting = bankBusy === 'connect';
  const who = syncUser.email ? `every device signed in as ${escAttr(syncUser.email)}` : 'every device signed in to it';
  panel.innerHTML = `
    ${items.map(bankItemHtml).join('')}
    <button class="gcal-connect-btn bank-connect-btn" data-bank="connect"${bankBusy ? ' disabled' : ''}>${connecting ? 'Connecting…' : items.length ? 'Connect another bank' : 'Connect a bank'}</button>
    <div class="bank-fine">You log in to your bank in Plaid's window; Focus never sees your password. The connection is read-only, and it's saved to your account: ${who} shows it.</div>
    ${help}
    ${relayBlock}`;
}

function bankBind(panel) {
  if (panel._bankBound) return;
  panel._bankBound = true;
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-bank]');
    if (!b || b.disabled) return;
    const act = b.dataset.bank;
    const item = bankItems().find(i => i.id === b.dataset.item);
    if (act === 'sign-in') { if (!syncUser) syncBtnClick(); }
    else if (act === 'connect') bankConnect();
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
