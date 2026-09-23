/* budget.js — The daily-envelope budget. */
import { $, calKeyToDate, escAttr, showToast } from './util.js';
import { saveToLocal } from './persistence.js';
import { dbdTodayKey } from './dbd.js';
import { homeDesktopOpen, homeToggleDesktop, renderHome } from './home.js';
import { desktopNavSync } from './views.js';
import { calDesktopOpen, calToggleDesktop } from './calendar.js';

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
 * total equals the initial again and today's balance is a full envelope. */
export function budgetRollover() {
  const today = dbdTodayKey();
  if (!budget.lastDate) { budget.lastDate = today; return false; }
  if (budget.lastDate === today) return false;
  const days = daysBetweenKeys(budget.lastDate, today);
  budget.initial = round2(totalBalance() + budget.daily * days);
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
        ${budgetFieldHtml('daily', 'Daily budget', round2(budget.daily), 'Added to your balance each new day')}
        ${budgetFieldHtml('initial', 'Initial balance', round2(budget.initial), 'Grows by the daily budget each morning')}
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
    </div>`;
}

/* Delegated listeners are attached once per container; innerHTML swaps the
 * children but never the container, so the bindings survive re-renders. */
function bindBudgetContainer(root) {
  if (!root || root._budgetBound) return;
  root._budgetBound = true;

  root.addEventListener('focusin', e => {
    if (e.target.matches('.budget-input, .budget-purchase-amount')) e.target.select();
  });

  root.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.bfield) { setBudgetField(el.dataset.bfield, el.value); return; }
    const row = el.closest('.budget-purchase-row');
    if (!row) return;
    const id = parseInt(row.dataset.purchaseId);
    if (el.dataset.pact === 'title')  setPurchaseTitle(id, el.value);
    if (el.dataset.pact === 'amount') setPurchaseAmount(id, el.value);
  });

  root.addEventListener('click', e => {
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
    } else if (el.matches('.budget-input, .budget-purchase-title, .budget-purchase-amount')) {
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
    showToast('New day — budget rolled over ✓');
  }
  setTimeout(budgetTickDay, 60000);
}
