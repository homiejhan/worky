/* budget.js — The daily-envelope budget. */
import { $, calKeyToDate, escAttr, showToast } from './util.js';
import { saveToLocal } from './persistence.js';
import { dbdTodayKey } from './dbd.js';
import { homeDesktopOpen, homeToggleDesktop, renderHome } from './home.js';
import { desktopNavSync } from './views.js';
import { calDesktopOpen, calShiftSources, calToggleDesktop } from './calendar.js';
import { shiftsOnDays } from './shifts.js';
import { addDays, billsDueBetween, cashRunway, daysBetween, nextPayday, PAY_REPEATS } from './runway.js';

/* budget state
 *   initial        — balance allocated at the start of today
 *   daily          — amount added to the balance each new day
 *   todayAllowance — null = use `daily`; set when the user edits Today's balance
 *   purchases      — today's purchases only; cleared on rollover / reset all
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
    purchases: Array.isArray(b?.purchases)
      ? b.purchases.map(p => ({ id: p.id, title: p.title || '', amount: round2(p.amount) }))
      : [],
    lastDate: b?.lastDate || null,
  };
}

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
/* Total balance is real money: what you started the day with, less what you've
 * spent. It deliberately ignores today's balance, so editing that envelope
 * never moves it. The daily budget feeds in once per day, at rollover. */
export function totalBalance() { return round2(budget.initial - purchasesTotal()); }

function daysBetweenKeys(fromKey, toKey) {
  const diff = Math.round((calKeyToDate(toKey) - calKeyToDate(fromKey)) / 86400000);
  return Math.max(1, Math.min(diff, 366));   // clamp: never negative, never absurd
}

/* New-day rollover. The new initial balance is what you actually had left
 * (total balance) plus a fresh daily budget; purchases then clear, so the
 * total equals the initial again and today's balance is a full envelope.
 * With a payday set (runwayOn) the balance is real cash between paychecks: no
 * daily budget is added, and the bills due since the last rollover come out. */
let budgetBillsPaid = [];   // what the last rollover took out, for its toast
export function budgetRollover() {
  const today = dbdTodayKey();
  if (!budget.lastDate) { budget.lastDate = today; return false; }
  if (budget.lastDate === today) return false;
  const days = daysBetweenKeys(budget.lastDate, today);
  if (runwayOn()) {
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
  budget.initial = totalBalance();
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

function budgetFieldHtml(key, label, value, hint) {
  return `
    <div class="budget-field">
      <div class="budget-field-label">${label}</div>
      <div class="budget-input-wrap">
        <span class="budget-currency">$</span>
        <input class="budget-input" type="text" inputmode="decimal"
          data-bfield="${key}" value="${value.toFixed(2)}">
      </div>
      <div class="budget-field-hint">${hint}</div>
    </div>`;
}

function budgetHtml() {
  const spent = purchasesTotal();
  const tb = todayBalance();
  const total = totalBalance();
  const rows = budget.purchases.map(p => `
    <div class="budget-purchase-row" data-purchase-id="${p.id}">
      <input class="budget-purchase-title" data-pact="title"
        value="${escAttr(p.title)}" placeholder="Purchase…">
      <input class="budget-purchase-amount" data-pact="amount" type="text" inputmode="decimal"
        value="${Number(p.amount).toFixed(2)}">
      <button class="budget-purchase-del" data-pact="del" title="Remove">×</button>
    </div>`).join('');

  return `
    <div class="budget-wrap">
      <div class="budget-header">
        <div class="budget-title">Budget</div>
      </div>

      <div class="budget-figure ${total < 0 ? 'over' : ''}">
        <div class="budget-figure-label">Total balance</div>
        <div class="budget-figure-value">${money(total)}</div>
        <div class="budget-figure-sub">${money(round2(budget.initial))} initial − ${money(spent)} spent today</div>
      </div>

      <div class="budget-fields">
        ${budgetFieldHtml('today', "Today's balance", tb, 'Spending envelope — editing it won\'t change your total')}
        ${budgetFieldHtml('daily', 'Daily budget', round2(budget.daily), runwayOn() ? 'What you let yourself spend a day' : 'Added to your balance each new day')}
        ${budgetFieldHtml('initial', 'Initial balance', round2(budget.initial), runwayOn() ? 'Your cash this morning: add each paycheck here' : 'Grows by the daily budget each morning')}
      </div>

      ${runwayHtml()}

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
    </div>`;
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

function runwayHtml() {
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
      <div class="runway-sub">Set your next payday to see whether your cash lasts until then. From then on your daily budget is what you spend each day. It is no longer added to your balance each morning, so add each paycheck to your balance when it lands.</div>
      ${setup}
    </div>`;

  const r = runwayResult();
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
      : r.daysToPayday === 0 ? 'Add your paycheck to the balance above.'
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
      <div class="runway-bill-list">${bills || '<div class="budget-empty">No bills yet. They come out of your balance on their day.</div>'}</div>
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
  budget.purchases = budget.purchases.filter(p => p.id !== id);
  budgetChanged();
}

/* Midnight watcher: roll over without needing a reload. */
export function budgetTickDay() {
  if (budgetRollover()) {
    saveToLocal();
    renderBudget();
    renderHome();
    const paid = budgetBillsPaid.reduce((t, b) => t + b.amount, 0);
    showToast(paid ? `New day — ${budgetBillsPaid.map(b => b.name || 'Bill').join(', ')} (${money(paid)}) came out of your balance`
                   : 'New day — budget rolled over ✓');
  }
  setTimeout(budgetTickDay, 60000);
}
