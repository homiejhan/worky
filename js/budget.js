/* budget.js — The daily-envelope budget. */
import { $, calDateKey, calKeyToDate, escAttr, keepField, showToast, userTyping } from './util.js';
import { BUDGET_UI_LS_KEY } from './config.js';
import { saveToLocal } from './persistence.js';
import { dbdTodayKey } from './dbd.js';
import { homeDesktopOpen, homeToggleDesktop, renderHome } from './home.js';
import { desktopNavSync } from './views.js';
import { calDesktopOpen, calShiftSources, calToggleDesktop } from './calendar.js';
import { shiftsOnDays } from './shifts.js';
import { addDays, billsDueBetween, cashRunway, daysBetween, nextPayday, PAY_REPEATS } from './runway.js';
import { bankBalance, bankBalanceKey, bankBudgetFollowing, bankBudgetSkip, bankBudgetStep } from './bankbudget.js';

/* budget state
 *   initial        — balance allocated at the start of today
 *   daily          — amount added to the balance each new day
 *   todayAllowance — null = use `daily`; set when the user edits Today's balance
 *   purchases      — today's purchases only; cleared on rollover / reset all.
 *                    One logged from the bank has `bank` (its transaction id)
 *                    and `pending` while the bank hasn't posted it.
 *   lastDate       — date key of the last rollover, drives new-day detection */
export let budget = {
  initial: 0,
  daily: 0,
  todayAllowance: null,
  purchases: [],
  lastDate: null,
};
export function setBudget(v) { budget = v; }
export let purchaseIdCounter = 1;
export function setPurchaseIdCounter(v) { purchaseIdCounter = v; }
export function nextPurchaseId() { return purchaseIdCounter++; }

/* cash runway settings (the math is in runway.js), synced with the state
 *   payday — the payday the user entered ('YYYY-MM-DD'); null = no runway
 *   repeat — how it repeats: 'biweekly' | 'weekly' | 'monthly' | 'once'
 *   bills  — [{ id, name, amount, day }] monthly costs, due on `day`
 * With a payday set the envelope runs paycheck to paycheck (budgetRollover). */
export let runway = { payday: null, repeat: 'biweekly', bills: [] };
export function setRunway(v) { runway = v; }

/* Budget following the bank (the rules are in bankbudget.js), synced with the state
 *   on     — follow the account's banks (Settings → Bank accounts): the total
 *            balance is the bank's, and new transactions are logged
 *   items  — per bank connection: { since: the sync point, seen: what has been counted }
 *   log    — the latest moves of the balance from the bank outside today's
 *            purchases, newest first: [{ d: date, n: name, a: amount (+ = money in) }].
 *            Every device that logs a transaction writes the same thing, so they never disagree.
 *   anchor — { day, key, start }: the day the start of the day (budget.initial)
 *            was taken from the bank's balance, over which accounts (bankBalanceKey),
 *            and what it came to (another copy merged in with an older one makes
 *            it be taken again) */
export let bankBudget = { on: true, items: {}, log: [], anchor: null };
export function setBankBudget(v) { bankBudget = v; }
const BANK_LOG_DAYS = 14, BANK_LOG_MAX = 20;
/* The account's bank connections as bank.js last handed them over (budgetSeeBank):
 * From your bank says which accounts it follows, and how fresh they are. */
let bankSeen = [];

/* ───────────────────────── BUDGET ─────────────────────────
 * Minimal daily-envelope budgeting.
 *   Today's balance = (today's allowance) − today's purchases
 *   Total balance   = initial balance     − today's purchases
 * The two are deliberately independent: Today's balance tracks the daily
 * envelope, Total balance tracks real money. On each new day the total is
 * banked into the initial balance, the daily budget is added, and purchases
 * and the allowance reset. */
export let budgetDesktopOpen = false;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parseMoney(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? round2(n) : 0;
}

export function money(n) {
  const v = round2(n);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}

export function normalizeBudget(b) {
  return {
    initial: round2(b?.initial),
    daily:   round2(b?.daily),
    todayAllowance: (b && b.todayAllowance !== null && b.todayAllowance !== undefined)
      ? round2(b.todayAllowance) : null,
    purchases: Array.isArray(b?.purchases) ? b.purchases.map(purchaseRecord) : [],
    lastDate: b?.lastDate || null,
  };
}

/* A purchase as saved: a bank one keeps its transaction id and pending mark. */
export function purchaseRecord(p) {
  return {
    id: p.id, title: p.title || '', amount: round2(p.amount),
    ...(typeof p.bank === 'string' && p.bank ? { bank: p.bank } : {}),
    ...(p.bank && p.pending ? { pending: true } : {}),
  };
}

export function normalizeBankBudget(b) {
  const items = {};
  Object.entries(b && typeof b.items === 'object' && b.items ? b.items : {}).forEach(([id, e]) => {
    if (e && typeof e.since === 'string' && e.seen && typeof e.seen === 'object') items[id] = { since: e.since, seen: e.seen };
  });
  const log = Array.isArray(b?.log) ? b.log.filter(l => l && typeof l.d === 'string' && Number.isFinite(l.a))
    .map(l => ({ d: l.d, n: String(l.n || '').slice(0, 60), a: round2(l.a) })).slice(0, BANK_LOG_MAX) : [];
  const a = b && b.anchor;
  const anchor = a && typeof a.day === 'string' && typeof a.key === 'string'
    ? { day: a.day, key: a.key, start: Number.isFinite(a.start) ? round2(a.start) : null } : null;
  return { on: b?.on !== false, items, log, anchor };
}
/* The balance follows a bank: it is the bank's balance (or, with no balance
 * from the bank, Budget logs the bank's transactions into its own), so money in
 * and bills come and go with the bank, not with the daily budget. */
export function budgetFollowsBank() {
  return bankBudget.on && (Object.keys(bankBudget.items).length > 0 || bankBalance(bankSeen) !== null);
}
/* The bank's balance Budget's total is (bankbudget.js → bankBalance), or null:
 * not following a bank, or no balance from it yet. */
export function budgetBankBalance() { return bankBudget.on ? bankBalance(bankSeen) : null; }

export function normalizeRunway(r) {
  const bills = Array.isArray(r?.bills) ? r.bills : [];
  return {
    payday: typeof r?.payday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.payday) ? r.payday : null,
    repeat: PAY_REPEATS.includes(r?.repeat) ? r.repeat : 'biweekly',
    bills: bills.map((b, i) => ({
      id: Number.isFinite(b?.id) ? b.id : i + 1,
      name: String(b?.name ?? '').slice(0, 60),
      amount: Math.max(0, round2(b?.amount)),
      day: Math.min(31, Math.max(1, Math.round(Number(b?.day)) || 1)),
    })),
  };
}
/* Paycheck to paycheck: a payday is set, so the daily budget is spending, not
 * money added to the balance each morning. */
export function runwayOn() { return !!runway.payday; }

function purchasesTotal() {
  return round2(budget.purchases.reduce((s, p) => s + (Number(p.amount) || 0), 0));
}
function todayAllowance() {
  return budget.todayAllowance === null ? round2(budget.daily) : round2(budget.todayAllowance);
}
export function todayBalance() { return round2(todayAllowance() - purchasesTotal()); }
/* Today's purchases typed here that the bank hasn't shown (yet), and the ones from the bank. */
function typedTotal() { return round2(budget.purchases.reduce((s, p) => s + (p.bank ? 0 : Number(p.amount) || 0), 0)); }
function bankRowsTotal() { return round2(budget.purchases.reduce((s, p) => s + (p.bank ? Number(p.amount) || 0 : 0), 0)); }
/* Total balance is real money: what you started the day with, less what you've
 * spent. It deliberately ignores today's balance, so editing that envelope
 * never moves it. The daily budget feeds in once per day, at rollover.
 * Following a bank, it is the bank's balance, less what you typed today that
 * the bank hasn't shown yet: the bank's own number, so it can't drift from it. */
export function totalBalance() {
  const bank = budgetBankBalance();
  return bank === null ? round2(budget.initial - purchasesTotal()) : round2(bank - typedTotal());
}
/* What moved the bank's balance today besides today's purchases: money in, a
 * charge dated an earlier day, a purchase taken out of Budget (0 when not
 * following a bank). Start of the day − spent today + this = total balance. */
export function bankOtherToday() {
  return budgetBankBalance() === null ? 0 : round2(totalBalance() - (budget.initial - purchasesTotal()));
}

/* The start of the day (budget.initial), following a bank: what the bank's
 * balance was when the day began. Taken once a day, from the balance as last
 * checked: at the new day, or later that day when a balance first comes (with
 * today's purchases from the bank put back, and today's money in taken off), or
 * when the accounts followed change (a bank connected or disconnected). `anchor`
 * says when and over which accounts, so every device takes it once. */
function budgetAnchor(items) {
  const bank = bankBudget.on ? bankBalance(items) : null;
  if (bank === null) return false;
  const day = dbdTodayKey(), key = bankBalanceKey(items), a = bankBudget.anchor;
  if (a && a.day === day && a.key === key && a.start === round2(budget.initial)) return false;
  const inToday = bankBudget.log.reduce((s, l) => s + (l.d === day ? l.a : 0), 0);
  budget.initial = round2(bank + bankRowsTotal() - inToday);
  bankBudget.anchor = { day, key, start: budget.initial };
  return true;
}

function daysBetweenKeys(fromKey, toKey) {
  const diff = Math.round((calKeyToDate(toKey) - calKeyToDate(fromKey)) / 86400000);
  return Math.max(1, Math.min(diff, 366));   // clamp: never negative, never absurd
}

/* New-day rollover. The new initial balance is what you actually had left
 * (total balance) plus a fresh daily budget; purchases then clear, so the
 * total equals the initial again and today's balance is a full envelope.
 * With a payday set (runwayOn) the balance is real cash between paychecks: no
 * daily budget is added, and the bills due since the last rollover come out.
 * Following a bank, the balance is the bank's: the day starts from it as last
 * checked (budgetAnchor), since the paychecks and bills come in with the bank. */
let budgetBillsPaid = [];   // what the last rollover took out, for its toast
export function budgetRollover() {
  const today = dbdTodayKey();
  if (!budget.lastDate) { budget.lastDate = today; return false; }
  if (budget.lastDate === today) return false;
  const days = daysBetweenKeys(budget.lastDate, today);
  if (budgetFollowsBank()) {
    budgetBillsPaid = [];
    const bank = budgetBankBalance();
    budget.initial = bank === null ? totalBalance() : bank;   // (taken properly once today's purchases from the bank are in: budgetAnchor)
  } else if (runwayOn()) {
    // the daily budget is what you spend, not income; bills come out on their day
    budgetBillsPaid = billsDueBetween(runway.bills, budget.lastDate, today);
    budget.initial = round2(totalBalance() - budgetBillsPaid.reduce((t, b) => t + b.amount, 0));
  } else {
    budgetBillsPaid = [];
    budget.initial = round2(totalBalance() + budget.daily * days);
  }
  budget.purchases = [];
  budget.todayAllowance = null;
  budget.lastDate = today;
  return true;
}

/* Called by Reset: bank what was spent so the total balance is unchanged,
 * then clear the day. No new envelope — that only happens on a new day. */
export function budgetResetDay() {
  const bank = budgetBankBalance();
  budget.initial = bank === null ? totalBalance() : bank;   // (following a bank, the bank's is the total either way)
  if (bank !== null) bankBudget.anchor = { day: dbdTodayKey(), key: bankBalanceKey(bankSeen), start: budget.initial };
  budget.purchases = [];
  budget.todayAllowance = null;
  budget.lastDate = dbdTodayKey();
}

export function budgetToggleDesktop(force) {
  const want = (typeof force === 'boolean') ? force : !budgetDesktopOpen;
  if (want) {
    if (calDesktopOpen)  calToggleDesktop();
    if (homeDesktopOpen) homeToggleDesktop(false);
  }
  budgetDesktopOpen = want;
  const panel = $('budgetDesktopPanel');
  const tab   = $('budgetDesktopNavTab');
  const rp    = $('rightPanel');
  if (panel) panel.classList.toggle('active', budgetDesktopOpen);
  if (tab)   tab.classList.toggle('active', budgetDesktopOpen);
  if (rp)    rp.style.display = budgetDesktopOpen ? 'none' : '';
  if (budgetDesktopOpen) renderBudget();
  desktopNavSync();
}

/* ── UI ──
 * Both the desktop panel and the mobile tab render the same markup, so this
 * module never uses element IDs (they'd collide across the two copies and
 * getElementById would always resolve to the mobile one). Everything is
 * scoped to its container and wired with delegated listeners. */

/* Budget settings (the three balances and the cash runway) fold away under
 * the figures, so a phone shows today's money and purchases first. Whether
 * it's open is device-local. */
let budgetSettingsOpen = false;
export function budgetUiLoad() {
  try { budgetSettingsOpen = !!JSON.parse(localStorage.getItem(BUDGET_UI_LS_KEY))?.open; } catch(e) {}
}
function budgetToggleSettings() {
  budgetSettingsOpen = !budgetSettingsOpen;
  try { localStorage.setItem(BUDGET_UI_LS_KEY, JSON.stringify({ open: budgetSettingsOpen })); } catch(e) {}
  renderBudget();
}
/* What the folded row says: the daily budget and how long the cash lasts,
 * or when it runs out before payday (`short`: in red, so folding it away
 * never hides that). */
function budgetSettingsSummary(r) {
  const daily = budget.daily > 0 ? `${money(budget.daily)} a day` : 'No daily budget';
  if (!r) return { text: daily, short: false };
  if (!r.payday) return { text: `${daily} · set your next payday`, short: false };
  if (r.short) return { text: `Cash runs out ${r.runsOutOn === r.today ? 'today' : fmtDayKey(r.runsOutOn)}`, short: true };
  return { text: `${daily} · ${r.daysOfCash === null ? `${RUNWAY_HORIZON}+ days` : plural(r.daysOfCash, 'day')} of cash`, short: false };
}

function budgetFieldHtml(key, label, value, hint, readonly = false) {
  return `
    <div class="budget-field">
      <div class="budget-field-label">${label}</div>
      <div class="budget-input-wrap">
        <span class="budget-currency">$</span>
        <input class="budget-input" type="text" inputmode="decimal"
          data-bfield="${key}" value="${value.toFixed(2)}"${readonly ? ' readonly' : ''}>
      </div>
      <div class="budget-field-hint">${hint}</div>
    </div>`;
}

function budgetHtml() {
  const spent = purchasesTotal();
  const tb = todayBalance();
  const total = totalBalance();
  const follows = budgetFollowsBank();
  const fromBank = budgetBankBalance() !== null;          // the total is the bank's balance
  const other = bankOtherToday();
  const sub = fromBank
    ? `${money(round2(budget.initial))} at the start of today − ${money(spent)} spent today`
      + (other ? ` ${other > 0 ? '+' : '−'} ${money(Math.abs(other))} ${other > 0 ? 'in at your bank' : 'more out at your bank'}` : '')
    : `${money(round2(budget.initial))} initial − ${money(spent)} spent today`;
  const r = runwayResult();
  const open = budgetSettingsOpen;
  const summary = budgetSettingsSummary(r);
  const long = money(tb).length > 8 || money(total).length > 8;        // smaller figures, so both fit side by side
  const allowance = todayAllowance();
  const rows = budget.purchases.map(p => `
    <div class="budget-purchase-row${p.bank ? ' from-bank' : ''}" data-purchase-id="${p.id}">
      <input class="budget-purchase-title" data-pact="title"
        value="${escAttr(p.title)}" placeholder="Purchase…">
      ${p.bank ? `<span class="budget-bank-tag" title="${p.pending ? 'From your bank, not posted yet' : 'From your bank'}">${p.pending ? 'pending' : 'bank'}</span>` : ''}
      <input class="budget-purchase-amount" data-pact="amount" type="text" inputmode="decimal"
        value="${Number(p.amount).toFixed(2)}">
      <button class="budget-purchase-del" data-pact="del" title="Remove">×</button>
    </div>`).join('');

  return `
    <div class="budget-wrap">
      <div class="page-head">
        <h1 class="page-title">Budget</h1>
        <p class="page-sub">Today's spending money, and how long your cash lasts.</p>
      </div>

      <div class="budget-figure${total < 0 ? ' over' : ''}">
        <div class="budget-figures${long ? ' long' : ''}">
          <div class="budget-figure-cell budget-figure-today${tb < 0 ? ' over' : ''}">
            <div class="budget-figure-label">Today's balance</div>
            <div class="budget-figure-value">${money(tb)}</div>
            <div class="budget-figure-note">${allowance || budget.todayAllowance !== null ? `of ${money(allowance)} today` : 'No daily budget yet'}</div>
          </div>
          <div class="budget-figure-cell budget-figure-total${total < 0 ? ' over' : ''}">
            <div class="budget-figure-label">Total balance</div>
            <div class="budget-figure-value">${money(total)}</div>
          </div>
        </div>
        <div class="budget-figure-sub">${sub}</div>
      </div>

      <div class="budget-settings${open ? ' open' : ''}">
        <button class="budget-settings-toggle" data-budget="settings" aria-expanded="${open}">
          <span class="budget-settings-title">Budget settings</span>
          <span class="budget-settings-summary${summary.short ? ' short' : ''}">${summary.text}</span>
          <svg class="budget-settings-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="budget-settings-body"${open ? '' : ' hidden'}>
          <div class="budget-fields">
            ${budgetFieldHtml('today', "Today's balance", tb, 'Spending envelope — editing it won\'t change your total')}
            ${budgetFieldHtml('daily', 'Daily budget', round2(budget.daily), follows || runwayOn() ? 'What you let yourself spend a day' : 'Added to your balance each new day')}
            ${budgetFieldHtml('initial', 'Initial balance', round2(budget.initial), fromBank ? 'Your bank balance when today began: it follows your bank'
              : follows ? 'Your cash this morning: money in and out of your bank is logged for you'
              : runwayOn() ? 'Your cash this morning: add each paycheck here' : 'Grows by the daily budget each morning', fromBank)}
          </div>
          ${runwayHtml(r)}
        </div>
      </div>

      <div class="budget-section-header">
        <span class="section-sublabel">Purchases today</span>
        <span class="budget-spent">${money(spent)}</span>
      </div>

      <div class="budget-add-row">
        <input class="budget-new-title" placeholder="What did you buy?">
        <input class="budget-new-amount" type="text" inputmode="decimal" placeholder="0.00">
        <button class="add-btn budget-add-btn" data-pact="add">+ Add</button>
      </div>

      <div class="budget-purchase-list">
        ${rows || '<div class="budget-empty">No purchases yet today.</div>'}
      </div>
      ${follows || (bankBudget.on && bankSeen.length) ? bankLogHtml() : ''}
    </div>`;
}

/* What the bank moved outside today's purchases (money in, and earlier days),
 * after what Budget follows and how fresh it is. */
function bankLogHtml() {
  const rows = bankBudget.log.map(l => `
    <div class="bank-tx">
      <span class="bank-tx-date">${fmtDay(l.d)}</span>
      <span class="bank-tx-name">${escAttr(l.n || 'Transaction')}</span>
      <span class="bank-tx-amt${l.a > 0 ? ' in' : ''}">${l.a > 0 ? '+' : '-'}${money(Math.abs(l.a))}</span>
    </div>`).join('');
  return `
    <div class="budget-section-header">
      <span class="section-sublabel">From your bank</span>
    </div>
    ${bankStatusHtml()}
    ${rows ? `<div class="bank-txs budget-bank-list">${rows}</div>` : ''}`;
}
const fmtDay = key => calKeyToDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function fmtStamp(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return calDateKey(d) === dbdTodayKey() ? `at ${time}` : `on ${fmtDay(calDateKey(d))} at ${time}`;
}
/* Which accounts Budget follows, or why a bank logs nothing, and when each was
 * last checked: new transactions reach Plaid only a few times a day, so the
 * newest one can be hours old, and this says so. */
function bankStatusHtml() {
  const how = budgetBankBalance() !== null
    ? 'Your total balance is your bank\'s balance (available: pending charges taken off). Today\'s spending is logged under Purchases today; money in and earlier days\' charges are listed here.'
    : 'Today\'s spending is logged under Purchases today; money in and earlier days\' spending here, in your total balance.';
  const banks = bankBudgetFollowing(bankBudget.items, bankSeen);
  if (!banks.length) return `<div class="budget-bank-note">New transactions from your checking account are logged for you. ${how}</div>`;
  const notes = banks.map(f => {
    const bank = escAttr(f.bank);
    const item = bankSeen.find(i => i.id === f.id) || {};
    const fresh = item.updatedAt
      ? ` Checked ${fmtStamp(item.updatedAt)}${item.checkedAt ? `; Plaid last heard from ${bank} ${fmtStamp(item.checkedAt)}` : ''}.` : '';
    if (f.state === 'following') {
      const accounts = f.accounts.map(a => `${escAttr(a.name)}${a.mask ? ` ••${escAttr(a.mask)}` : ''}`).join(', ');
      return `Following ${accounts} at ${bank} since ${f.since === dbdTodayKey() ? 'today' : fmtDay(f.since)}.${fresh}`;
    }
    if (f.state === 'none') return `${bank} has no checking account connected, so nothing from it is logged: Budget follows checking accounts only, since a credit card's purchases would be counted again when you pay the card.`;
    if (f.state === 'waiting') return `Plaid is still gathering ${bank}'s transactions. Budget starts following it once they are in.`;
    return `${bank} needs attention: ${escAttr(f.error.code === 'ITEM_LOGIN_REQUIRED' ? 'log in to it again' : f.error.message || 'see Settings')} (Settings → Bank accounts).`;
  });
  const following = banks.some(f => f.state === 'following');
  return notes.map(n => `<div class="budget-bank-note">${n}</div>`).join('') + (following ? `
    <div class="budget-bank-note">${how} Banks send Plaid new transactions a few times a day, so a purchase can take a few hours to show up.</div>` : '');
}

/* ── cash runway (the math is in runway.js) ── */
const RUNWAY_HORIZON = 60;
const PAY_REPEAT_LABELS = { biweekly: 'Every 2 weeks', weekly: 'Every week', monthly: 'Every month', once: 'Just this once' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function ordinal(n) {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th');
}
function fmtDayKey(key) {
  return calKeyToDate(key).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function billDayOptions(day) {
  return Array.from({ length: 31 }, (_, i) => i + 1)
    .map(d => `<option value="${d}"${d === day ? ' selected' : ''}>the ${ordinal(d)}</option>`).join('');
}

/* The runway right now: this budget, the shifts before the next payday
 * (Focus, templates and Google), and the bills. null while no payday is set. */
export function runwayResult() {
  if (!runwayOn()) return null;
  const today = dbdTodayKey();
  const payday = nextPayday(runway.payday, runway.repeat, today);
  const keys = Array.from({ length: payday ? Math.min(daysBetween(today, payday), 35) : 0 }, (_, i) => addDays(today, i));
  const shifts = shiftsOnDays(keys, calShiftSources()).map(sh => ({ date: sh.date, pay: sh.pay }));
  return {
    today, payday, shiftCount: shifts.length,
    ...cashRunway({
      today, payday, balance: totalBalance(), todaySpend: Math.max(0, todayBalance()),
      dailySpend: round2(budget.daily), shifts, bills: runway.bills, horizon: RUNWAY_HORIZON,
    }),
  };
}

/* The last day whose shifts the runway counts, as the end of that day, when
 * it lies past the displayed week (Google Calendar fetches through it). */
export function runwayFetchUntil() {
  const today = dbdTodayKey();
  const payday = runwayOn() ? nextPayday(runway.payday, runway.repeat, today) : null;
  if (!payday || payday <= today) return null;
  const last = calKeyToDate(addDays(today, Math.min(daysBetween(today, payday), 35) - 1));
  last.setHours(23, 59, 59, 999);
  return last;
}

function runwayHtml(r = runwayResult()) {
  const setup = `
    <div class="runway-setup">
      <label class="runway-field"><span>Next payday</span>
        <input class="runway-input" type="date" data-rfield="payday" value="${runway.payday || ''}"></label>
      <label class="runway-field"><span>Repeats</span>
        <select class="runway-input" data-rfield="repeat">${PAY_REPEATS.map(r =>
          `<option value="${r}"${r === runway.repeat ? ' selected' : ''}>${PAY_REPEAT_LABELS[r]}</option>`).join('')}</select></label>
    </div>`;
  if (!runwayOn()) return `
    <div class="runway empty">
      <div class="runway-label">Cash runway</div>
      <div class="runway-sub">${budgetFollowsBank()
        ? 'Set your next payday to see whether your cash lasts until then. Paychecks come in with your bank\'s transactions.'
        : 'Set your next payday to see whether your cash lasts until then. From then on your daily budget is what you spend each day. It is no longer added to your balance each morning, so add each paycheck to your balance when it lands.'}</div>
      ${setup}
    </div>`;

  let head;
  if (!r.payday) {
    head = `<div class="runway-value">No payday ahead</div>
      <div class="runway-sub">Your payday has passed. Set the next one.</div>`;
  } else {
    const days = r.daysOfCash === null ? `${RUNWAY_HORIZON}+ days` : plural(r.daysOfCash, 'day');
    const when = r.daysToPayday === 0 ? `Payday is today (${fmtDayKey(r.payday)})` : `Payday ${fmtDayKey(r.payday)} · in ${plural(r.daysToPayday, 'day')}`;
    const why = r.runsOutWith.length ? ` when ${escAttr(r.runsOutWith.join(' and '))} ${r.runsOutWith.length === 1 ? 'is' : 'are'} due` : '';
    const status = r.short
      ? `Runs out ${fmtDayKey(r.runsOutOn)}${why}, ${plural(r.shortBy, 'day')} before payday.`
      : r.daysToPayday === 0 ? (budgetFollowsBank() ? 'Your paycheck comes in when your bank shows it.' : 'Add your paycheck to the balance above.')
      : `Covers you to payday${r.paycheck > 0 ? `, when about ${money(r.paycheck)} lands` : ''}.`;
    const parts = [`${money(totalBalance())} now`, `${money(budget.daily)} a day`];
    if (r.billsBeforePayday) parts.push(`−${money(r.billsBeforePayday)} bills before payday`);
    const priced = r.shiftCount - r.unpricedShifts;
    if (priced) parts.push(`+${money(r.paycheck)} from ${plural(priced, 'shift')} on payday`);
    if (r.unpricedShifts) parts.push(`${plural(r.unpricedShifts, 'shift')} without a wage not counted`);
    head = `<div class="runway-value">${days} of cash</div>
      <div class="runway-sub">${when}</div>
      <div class="runway-status">${status}</div>
      <div class="runway-parts">${parts.join(' · ')}</div>` +
      (budget.daily > 0 ? '' : '<div class="runway-parts">Set a daily budget above: the runway counts days at that pace.</div>');
  }
  const paid = budgetBillsPaid.length
    ? `<div class="runway-parts">Taken out this morning: ${budgetBillsPaid.map(b => `${escAttr(b.name || 'Bill')} ${money(b.amount)}`).join(', ')}.</div>` : '';
  const bills = runway.bills.map(b => `
    <div class="runway-bill" data-bill-id="${b.id}">
      <input class="runway-bill-name" data-bact="name" value="${escAttr(b.name)}" placeholder="Bill">
      <span class="budget-currency">$</span>
      <input class="runway-bill-amount" data-bact="amount" type="text" inputmode="decimal" value="${b.amount.toFixed(2)}">
      <select class="runway-bill-day" data-bact="day" title="Day of the month it's due">${billDayOptions(b.day)}</select>
      <button class="budget-purchase-del" data-bact="del" title="Remove">×</button>
    </div>`).join('');
  const billTotal = round2(runway.bills.reduce((t, b) => t + b.amount, 0));
  return `
    <div class="runway ${r.short ? 'short' : ''}">
      <div class="runway-label">Cash runway</div>
      ${head}
      ${paid}
      ${setup}
      <div class="budget-section-header runway-bills-head">
        <span class="section-sublabel">Monthly bills</span>
        <span class="budget-spent">${money(billTotal)}</span>
      </div>
      <div class="runway-bill-list">${bills || `<div class="budget-empty">${budgetFollowsBank() ? 'No bills yet. The runway counts each one on its day.' : 'No bills yet. They come out of your balance on their day.'}</div>`}</div>
      <div class="budget-add-row runway-add-row">
        <input class="runway-new-name" placeholder="Rent, phone, bus pass…">
        <input class="runway-new-amount" type="text" inputmode="decimal" placeholder="0.00">
        <select class="runway-bill-day runway-new-day" title="Day of the month it's due">${billDayOptions(1)}</select>
        <button class="add-btn budget-add-btn" data-bact="add">+ Add</button>
      </div>
    </div>`;
}

function setRunwayField(key, value) {
  if (key === 'payday') runway.payday = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  if (key === 'repeat' && PAY_REPEATS.includes(value)) runway.repeat = value;
  budgetChanged();
}
function billById(id) { return runway.bills.find(b => b.id === id); }
function addBill(root) {
  const name = (root.querySelector('.runway-new-name')?.value || '').trim();
  const amount = parseMoney(root.querySelector('.runway-new-amount')?.value);
  const day = parseInt(root.querySelector('.runway-new-day')?.value) || 1;
  if (!name && !amount) { root.querySelector('.runway-new-name')?.focus(); return; }
  const id = runway.bills.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  runway.bills.push({ id, name: name || 'Bill', amount: Math.max(0, amount), day });
  budgetChanged();
  root.querySelector('.runway-new-name')?.focus();
}
function setBillField(id, key, value) {
  const b = billById(id);
  if (!b) return;
  if (key === 'name') { b.name = String(value).slice(0, 60); saveToLocal(); return; }
  if (key === 'amount') b.amount = Math.max(0, parseMoney(value));
  if (key === 'day') b.day = Math.min(31, Math.max(1, parseInt(value) || 1));
  budgetChanged();
}
function removeBill(id) {
  runway.bills = runway.bills.filter(b => b.id !== id);
  budgetChanged();
}

/* Delegated listeners are attached once per container; innerHTML swaps the
 * children but never the container, so the bindings survive re-renders. */
function bindBudgetContainer(root) {
  if (!root || root._budgetBound) return;
  root._budgetBound = true;

  root.addEventListener('focusin', e => {
    if (e.target.matches('.budget-input, .budget-purchase-amount, .runway-bill-amount')) e.target.select();
  });

  root.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.bfield) { setBudgetField(el.dataset.bfield, el.value); return; }
    if (el.dataset.rfield) { setRunwayField(el.dataset.rfield, el.value); return; }
    const bill = el.closest('.runway-bill');
    if (bill && el.dataset.bact) { setBillField(parseInt(bill.dataset.billId), el.dataset.bact, el.value); return; }
    const row = el.closest('.budget-purchase-row');
    if (!row) return;
    const id = parseInt(row.dataset.purchaseId);
    if (el.dataset.pact === 'title')  setPurchaseTitle(id, el.value);
    if (el.dataset.pact === 'amount') setPurchaseAmount(id, el.value);
  });

  root.addEventListener('click', e => {
    if (e.target.closest('[data-budget="settings"]')) {
      budgetToggleSettings();
      root.querySelector('[data-budget="settings"]')?.focus();     // (the button was drawn again)
      return;
    }
    const bbtn = e.target.closest('button[data-bact]');
    if (bbtn) {
      if (bbtn.dataset.bact === 'add') addBill(root);
      if (bbtn.dataset.bact === 'del') removeBill(parseInt(bbtn.closest('.runway-bill').dataset.billId));
      return;
    }
    const btn = e.target.closest('[data-pact]');
    if (!btn || btn.tagName !== 'BUTTON') return;
    if (btn.dataset.pact === 'add') { addPurchase(root); return; }
    if (btn.dataset.pact === 'del') {
      const row = btn.closest('.budget-purchase-row');
      if (row) removePurchase(parseInt(row.dataset.purchaseId));
    }
  });

  root.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (el.matches('.budget-new-title, .budget-new-amount')) {
      e.preventDefault();
      addPurchase(root);
    } else if (el.matches('.runway-new-name, .runway-new-amount')) {
      e.preventDefault();
      addBill(root);
    } else if (el.matches('.budget-input, .budget-purchase-title, .budget-purchase-amount, .runway-bill-name, .runway-bill-amount')) {
      e.preventDefault();
      el.blur();          // commits via the change handler
    }
  });
}

export function renderBudget() {
  [$('budgetContainer-d'), $('budgetContainer-m')].forEach(el => {
    if (!el) return;
    el.innerHTML = budgetHtml();
    bindBudgetContainer(el);
  });
}

function budgetChanged() {
  saveToLocal();
  renderBudget();
  renderHome();
}

function setBudgetField(key, raw) {
  const val = parseMoney(raw);
  if (key === 'initial') {
    if (budgetBankBalance() !== null) { renderBudget(); return; }   // it follows the bank
    budget.initial = val;
  } else if (key === 'daily') {
    budget.daily = val;
    // If the user hasn't overridden today's balance, it follows the daily budget.
    if (budget.todayAllowance !== null) budget.todayAllowance = null;
  } else if (key === 'today') {
    // Store as an allowance so later purchases still subtract from it.
    budget.todayAllowance = round2(val + purchasesTotal());
  }
  budgetChanged();
}

function addPurchase(root) {
  const scope = root || $('budgetContainer-d') || $('budgetContainer-m');
  if (!scope) return;
  const titleEl = scope.querySelector('.budget-new-title');
  const amtEl   = scope.querySelector('.budget-new-amount');
  const title = (titleEl?.value || '').trim();
  const amount = parseMoney(amtEl?.value);
  if (!title && !amount) { titleEl?.focus(); return; }
  budget.purchases.push({ id: purchaseIdCounter++, title: title || 'Purchase', amount });
  budgetChanged();
  const nt = scope.querySelector('.budget-new-title');
  if (nt) nt.focus();
}

function purchaseById(id) { return budget.purchases.find(p => p.id === id); }

function setPurchaseTitle(id, value) {
  const p = purchaseById(id);
  if (!p) return;
  p.title = value;
  saveToLocal();
}

function setPurchaseAmount(id, value) {
  const p = purchaseById(id);
  if (!p) return;
  p.amount = parseMoney(value);
  budgetChanged();
}

function removePurchase(id) {
  const p = purchaseById(id);
  if (p && p.bank) bankBudget.items = bankBudgetSkip(bankBudget.items, p.bank);   // taken out of Budget: not counted again
  budget.purchases = budget.purchases.filter(q => q.id !== id);
  budgetChanged();
}

/* ── bank transactions (the rules are in bankbudget.js) ──
 * bank.js hands over the signed-in account's connections whenever they change:
 * a refresh on this device, or the account's copy changing. Returns false when
 * it waited because someone is typing (logging redraws Budget), for bank.js to
 * hand them over again a little later. */
export function budgetFromBank(items) {
  if (!bankBudget.on || !Array.isArray(items)) return true;
  if (userTyping()) return false;
  const rolled = budgetRollover();                     // today's purchases must be today's
  const r = bankBudgetStep({ tracked: bankBudget.items, items, purchases: budget.purchases, today: dbdTodayKey(), nextId: purchaseIdCounter });
  if (r.changed) {
    bankBudget.items = r.tracked;
    budget.purchases = r.purchases;
    purchaseIdCounter = r.nextId;
    if (bankBalance(items) === null) budget.initial = round2(budget.initial + r.balance);   // (the bank's balance has these in it already)
    const since = addDays(dbdTodayKey(), -BANK_LOG_DAYS);
    bankBudget.log = [...r.log.reverse(), ...bankBudget.log].filter(l => l.d >= since).slice(0, BANK_LOG_MAX);
  }
  const anchored = budgetAnchor(items);                // the start of the day, with today's purchases from the bank in
  if (!r.changed && !rolled && !anchored) return true;
  keepField(budgetChanged);                            // a cursor left in a field stays, with what was typed
  if (r.logged) showToast(r.logged === 1 ? 'Logged 1 bank transaction in Budget' : `Logged ${r.logged} bank transactions in Budget`);
  return true;
}
/* bank.js hands over the account's connections whenever they change, for From
 * your bank to say what it follows (not while someone types: that can wait). */
export function budgetSeeBank(items) {
  const view = list => JSON.stringify(list.map(i => [i.id, i.institution, i.accounts, i.updatedAt, i.checkedAt, i.error]));
  const next = Array.isArray(items) ? items : [];
  if (view(next) === view(bankSeen)) return;
  bankSeen = next;
  if (!userTyping()) { keepField(renderBudget); renderHome(); }   // (the total balance is the bank's)
}
/* A bank was disconnected: its sync point goes (connected again, it starts a new one). */
export function budgetForgetBank(id) {
  if (!bankBudget.items[id]) return;
  const items = { ...bankBudget.items };
  delete items[id];
  bankBudget = { ...bankBudget, items };
  keepField(budgetChanged);
}
/* Settings → Bank accounts: turning it on starts a new sync point, and the
 * total balance becomes the bank's; off forgets it, and the total stays where
 * it was, Budget's own again. */
export function budgetFollowBank(on, items) {
  if (!on) budget.initial = round2(totalBalance() + purchasesTotal());
  bankBudget = { on: !!on, items: {}, log: on ? bankBudget.log : [], anchor: null };
  if (on) budgetFromBank(items);
  budgetChanged();
}

/* Midnight watcher: roll over without needing a reload. */
export function budgetTickDay() {
  if (budgetRollover()) {
    budgetAnchor(bankSeen);                            // following a bank: the day starts from its balance as last checked
    saveToLocal();
    renderBudget();
    renderHome();
    const paid = budgetBillsPaid.reduce((t, b) => t + b.amount, 0);
    showToast(paid ? `New day — ${budgetBillsPaid.map(b => b.name || 'Bill').join(', ')} (${money(paid)}) came out of your balance`
                   : 'New day — budget rolled over ✓');
  }
  setTimeout(budgetTickDay, 60000);
}
