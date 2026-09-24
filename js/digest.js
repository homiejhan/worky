/* digest.js — Email digest: synced state, suggested tasks, delivery, Run now, the Home
 * card and its settings. */
import {
  DIGEST_GITHUB_LS_KEY, DIGEST_GITHUB_REPO, DIGEST_GITHUB_WORKFLOW, DIGEST_RUN_LS_KEY,
  DIGEST_UI_LS_KEY,
} from './config.js';
import {
  $, calDateKey, calKeyToDate, calToday, closeModal, escAttr, isMobileLayout, showToast,
} from './util.js';
import { saveToLocal } from './persistence.js';
import { todoLists } from './lists.js';
import { dbdById, dbdLabelFor, dbdTasks, dbdTodayKey, nextDbdId, renderDbd } from './dbd.js';
import { homeToggleDesktop, renderHome } from './home.js';
import { goTab } from './views.js';
import { openSettings, renderSettings } from './settings.js';
import {
  digestInboxLatest, setSyncQuietSave, syncHeld, syncPendingRemote, syncReconciled, syncUser,
} from './sync.js';
import { bindDigestPrompts, digestPromptRender } from './digest-prompts.js';

/* ═══════════════════════════════════════════════════════
   EMAIL DIGEST
   The digest is BUILT elsewhere: backend/digest.py runs on GitHub Actions
   every morning (Qwen3.5-4B served by llama-server on the free runner),
   reads the last day of Gmail with a stored refresh token, and delivers
   the result to Firebase at users/<uid>/digestInbox. This file only
   • merges a delivered digest into synced state (digestInboxSeen/Flush),
   • shows it as a Home card with the suggested-task pool (Add / Dismiss),
   • and can ask GitHub to run the workflow right now from this device.
   Nothing here reads mail or talks to a model.
   ═══════════════════════════════════════════════════════ */

/* ── state (synced) ── */
export let digest = null;
export function setDigest(v) { digest = v; }

/* digest = {
 *   enabled, last {at, markdown, count, model, source},
 *   clearedAt,   (optional) deliveries up to this time were cleared by the user
 *   suggestions [ {id, title, why, due, section, status, at, dbdId} ],   pool, survives runs
 *   sugIdCounter,
 * } — all synced. The suggestion pool only shrinks when the user accepts
 * (Add) or rejects (Dismiss) an item; a new digest just merges in what it
 * hasn't suggested before. */
const DIGEST_SUG_STATUSES = ['pending', 'added', 'dismissed'];
const DIGEST_SUG_MEMORY_MS = 14 * 86400000;   // how long accepted/dismissed titles block re-suggestion
const DIGEST_SUG_MAX = 120;

export function normalizeDigest(v) {
  const out = { enabled: false, last: null, suggestions: [], sugIdCounter: 1 };
  if (!v || typeof v !== 'object') return out;
  out.enabled = !!v.enabled;
  /* only present once the user has cleared a digest, so states that never did
   * keep the exact shape (and fingerprint) they had before this field existed */
  const clearedAt = Math.max(0, Number(v.clearedAt) || 0);
  if (clearedAt) out.clearedAt = clearedAt;
  const l = v.last;
  if (l && typeof l === 'object' && typeof l.markdown === 'string' && l.markdown.trim()) {
    out.last = {
      at: Number(l.at) || 0,
      markdown: l.markdown.slice(0, 120000),
      count: Math.max(0, Number(l.count) || 0),
      model: typeof l.model === 'string' ? l.model.slice(0, 80) : '',
      source: typeof l.source === 'string' ? l.source.slice(0, 20) : '',
    };
  }
  out.sugIdCounter = Math.max(1, Number(v.sugIdCounter) || 1);
  if (Array.isArray(v.suggestions)) {
    out.suggestions = digestNormalizeSuggestions(v.suggestions);
  } else if (l && Array.isArray(l.tasks)) {
    /* migration: pre-pool digests kept tasks on `last` */
    out.suggestions = digestNormalizeSuggestions(digestNormalizeTasks(l.tasks).map(t => ({
      id: t.id, title: t.title, why: t.why, due: t.due, section: t.section,
      status: t.added ? 'added' : 'pending', at: out.last ? out.last.at : 0, dbdId: t.added || 0,
    })));
  }
  out.suggestions.forEach(x => { if (x.id >= out.sugIdCounter) out.sugIdCounter = x.id + 1; });
  /* older builds also carried schedule / lastScheduled / request (the laptop
   * runner); those are dropped on normalise and disappear on the next save. */
  return out;
}
function digestNormalizeSuggestions(arr) {
  const out = [];
  const ids = new Set();
  (Array.isArray(arr) ? arr : []).forEach(x => {
    if (!x || typeof x !== 'object') return;
    const title = String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const id = Number(x.id);
    if (!title || !(id > 0) || ids.has(id)) return;
    ids.add(id);
    out.push({
      id,
      title,
      why: String(x.why || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due || '')) ? String(x.due) : '',
      section: /^[a-z0-9-]{1,40}$/.test(String(x.section || '')) ? String(x.section) : 'misc',
      status: DIGEST_SUG_STATUSES.includes(x.status) ? x.status : 'pending',
      at: Number(x.at) || 0,
      dbdId: Number(x.dbdId) > 0 ? Number(x.dbdId) : 0,
    });
  });
  return out.slice(0, DIGEST_SUG_MAX);
}
/* "Confirm the Fabrikam recruiter screen!" and "confirm fabrikam recruiter screen" are the same suggestion */
function digestSugKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
/* Merge a digest's tasks into the pool: anything the pool already holds
 * (pending, added, or recently dismissed) is skipped — same title, or the same
 * task in other words (see REDUNDANCY CHECK) — and the rest become pending.
 * Old accepted/dismissed entries fall out of the memory window. */
function digestMergeSuggestions(tasks, at) {
  const d = digestGet();
  const now = at || Date.now();
  d.suggestions = d.suggestions.filter(x => x.status === 'pending' || (now - x.at) < DIGEST_SUG_MEMORY_MS);
  const keys = new Set(d.suggestions.map(x => digestSugKey(x.title)));
  let added = 0;
  (tasks || []).forEach(t => {
    const key = digestSugKey(t.title);
    if (!key || keys.has(key)) return;
    const twin = digestDupInPool(t.title, d.suggestions);
    if (twin) {
      /* a reworded repeat can still know something the first one didn't */
      if (twin.status === 'pending') {
        if (!twin.due && t.due) twin.due = t.due;
        if (!twin.why && t.why) twin.why = t.why;
      }
      return;
    }
    keys.add(key);
    d.suggestions.push({ id: d.sugIdCounter++, title: t.title, why: t.why || '', due: t.due || '', section: t.section || 'misc', status: 'pending', at: now, dbdId: 0 });
    added++;
  });
  if (d.suggestions.length > DIGEST_SUG_MAX) {
    /* drop the oldest non-pending first, then the oldest pending */
    const keep = d.suggestions.filter(x => x.status === 'pending');
    const rest = d.suggestions.filter(x => x.status !== 'pending').sort((a, b) => b.at - a.at);
    d.suggestions = keep.concat(rest).slice(0, DIGEST_SUG_MAX).sort((a, b) => a.id - b.id);
  }
  return added;
}

/* ── REDUNDANCY CHECK: suggestions vs. what already exists ──
 * Titles are compared as weighted word sets. No model is involved, so it works
 * offline and re-evaluates on every render. It answers two questions:
 *   1. Is an incoming suggestion one the pool already holds, just worded
 *      differently ("Finish the Northwind assessment" / "Complete Northwind
 *      Labs HackerRank")?  → digestMergeSuggestions skips it.
 *   2. Does an open suggestion look like a task that is already in Day by Day
 *      or a list ("Northwind OA")?  → the row is flagged, offers "Add anyway",
 *      and is left out of Add all.
 * (1) drops silently, so it is the strict one: the two titles must be alike in
 * BOTH directions (a longer title that merely contains a shorter one is kept).
 * (2) is only a flag, so a terse task is allowed to match a wordy suggestion.
 * Nothing is persisted — like the Daily name-sync it is derived from the live
 * lists, so deleting or renaming the task clears the flag by itself.
 *
 * How two titles are scored:
 *   • words that say WHEN (dates, times, weekdays) or nothing (a, the, to) are dropped
 *   • generic verbs and filler ("complete", "reply", "online", "Labs") weigh 0.2
 *   • nouns half the inbox shares ("assessment", "interview", "bill") weigh 0.5
 *   • everything else — company, person, course — weighs 1 and is what really decides
 *   • score = 0.6 × (shared weight ÷ the shorter title) + 0.4 × (shared ÷ combined)
 *   • two vetoes: different numbers ("HW 3" / "HW 4") and different kinds of
 *     action ("Schedule the Acme interview" / "Confirm the Acme interview",
 *     "Accept the offer" / "Decline the offer") are never the same task */
const DIGEST_DUP_FLAG      = 0.66;   // suggestion ↔ existing task (score): flag the row
const DIGEST_DUP_POOL      = 0.60;   // incoming ↔ pending suggestion (shared ÷ combined): skip it
const DIGEST_DUP_SETTLED   = 0.72;   // incoming ↔ added / dismissed suggestion (shared ÷ combined): skip it
const DIGEST_DUP_EXACT     = 0.95;   // flag wording: "Already on your list" vs "Looks like"
const DIGEST_DUP_DONE_DAYS = 7;      // a finished task only counts if it was due / done this recently

const DIGEST_DUP_STOP = new Set(`a an the to for of on in at by with from and or but if so as is are be was it its this that these those
  i me my we our you your their his her them re fw fwd about up out off into over via per
  before after until till due asap now soon please kindly
  today tonight tomorrow yesterday week weekend month morning afternoon evening noon eod eow
  mon tue tues wed thu thur thurs fri sat sun monday tuesday wednesday thursday friday saturday sunday
  jan feb mar apr jun jul aug sep sept oct nov dec january february march april june july august september october november december
  am pm ct cst cdt et est edt pt pst pdt utc`.split(/\s+/).filter(Boolean));
/* abbreviations and near-synonyms → one spelling, before stemming */
const DIGEST_DUP_CANON = {
  oa: 'assessment', hackerrank: 'assessment', codesignal: 'assessment', codility: 'assessment',
  screen: 'interview', screening: 'interview',
  hw: 'homework', hmwk: 'homework', pset: 'homework',
  mtg: 'meeting', appt: 'appointment', msg: 'message', app: 'application', apps: 'application',
  doc: 'document', docs: 'document', cv: 'resume', sub: 'subscription',
  renewal: 'renew', registration: 'register', submission: 'submit', confirmation: 'confirm',
};
const DIGEST_DUP_WEAK = new Set(`complete finish do take start begin make get go check review read look see view open try
  reply respond response answer email mail message send write draft forward
  confirm accept decline rsvp schedule reschedule book set setup arrange plan pick choose select
  submit fill sign signup register upload download update renew pay follow followup call phone contact reach ask tell let know
  turn return bring give add create join attend verify activate
  new online form link request reminder invite invitation notice notification info information details yes no
  inc llc ltd corp co company labs group technologies systems team`.split(/\s+/).filter(Boolean).map(digestDupStem));
const DIGEST_DUP_MID = new Set(`assessment interview application recruiter offer position role job internship career
  meeting appointment bill payment invoice receipt statement subscription account order
  homework assignment quiz exam midterm final project report paper essay class course lecture
  document letter resume survey feedback`.split(/\s+/).filter(Boolean).map(digestDupStem));
/* What KIND of action a verb is. Verbs barely count toward the score (models
 * reword them freely), but two titles that both name an action, of different
 * kinds, are different steps: scheduling an interview is not confirming it. */
const DIGEST_DUP_ACTS = (() => {
  const m = new Map();
  Object.entries({
    act:      'complete finish do take start begin submit fill sign signup register upload turn return',
    respond:  'reply respond response answer email mail message send write draft forward confirm accept rsvp',
    schedule: 'schedule reschedule book arrange pick choose select',
    pay:      'pay renew',
    review:   'review read check look see view open verify',
    refuse:   'decline cancel reject unsubscribe dispute',
  }).forEach(([cls, words]) => words.split(' ').forEach(x => m.set(digestDupStem(x), cls)));
  return m;
})();

/* plural / -ing / -ed / trailing e, so "scheduling", "scheduled" and "schedule" meet */
function digestDupStem(w) {
  if (/\d/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  let cut = false;
  if (w.length > 5 && w.endsWith('ing')) { w = w.slice(0, -3); cut = true; }
  else if (w.length > 4 && w.endsWith('ied')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('ed')) { w = w.slice(0, -2); cut = true; }
  if (cut && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|ff|zz)$/.test(w)) w = w.slice(0, -1);   // submitt → submit
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/* title → { w: Map(word → weight), total, count, nums: Set, acts: Set, key }; cached by text */
const _digestDupCache = new Map();
function digestDupTokens(text) {
  const raw = String(text || '');
  const hit = _digestDupCache.get(raw);
  if (hit) return hit;
  let s = raw.toLowerCase();
  try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch(e) {}
  s = s.replace(/['\u2019]s\b/g, '')                                   // Patel's → patel
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')                            // dates and times say when, not what
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}(:\d{2})?\s*[ap]\.?m\b\.?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/g, ' ')
    .replace(/\b\d{1,2}(st|nd|rd|th)\b/g, ' ');
  const w = new Map();
  const nums = new Set();
  const acts = new Set();
  s.replace(/[^a-z0-9]+/g, ' ').split(' ').forEach(tok => {
    if (!tok || DIGEST_DUP_STOP.has(tok)) return;
    if (/\d/.test(tok)) {
      const n = tok.replace(/^0+(?=\d)/, '');
      nums.add(n);
      w.set(n, 0.5);
      return;
    }
    if (tok.length < 2) return;
    tok = digestDupStem(DIGEST_DUP_CANON[tok] || tok);
    if (DIGEST_DUP_ACTS.has(tok)) acts.add(DIGEST_DUP_ACTS.get(tok));
    const wt = (DIGEST_DUP_WEAK.has(tok) || DIGEST_DUP_ACTS.has(tok)) ? 0.2 : DIGEST_DUP_MID.has(tok) ? 0.5 : 1;
    w.set(tok, Math.max(w.get(tok) || 0, wt));
  });
  let total = 0;
  w.forEach(v => { total += v; });
  const out = { w, total, count: w.size, nums, acts, key: digestSugKey(raw) };
  if (_digestDupCache.size > 800) _digestDupCache.clear();
  _digestDupCache.set(raw, out);
  return out;
}

/* How alike two titles are → { score, both }, each 0 … 1.
 *   score — forgiving: a terse title fully inside a wordy one still scores high
 *   both  — strict: shared ÷ combined, high only when neither says much the other doesn't */
function digestDupCompare(textA, textB) {
  const NONE = { score: 0, both: 0 };
  const a = digestDupTokens(textA), b = digestDupTokens(textB);
  if (a.key && a.key === b.key) return { score: 1, both: 1 };
  if (!a.total || !b.total) return NONE;
  let aOnly = false, bOnly = false;
  a.nums.forEach(n => { if (!b.nums.has(n)) aOnly = true; });
  b.nums.forEach(n => { if (!a.nums.has(n)) bOnly = true; });
  if (aOnly && bOnly) return NONE;                  // "HW 3" vs "HW 4", "round 1" vs "round 2"
  if (a.acts.size && b.acts.size && ![...a.acts].some(c => b.acts.has(c))) return NONE;   // schedule vs confirm, accept vs decline
  let inter = 0, anchor = false;
  a.w.forEach((wt, tok) => { if (b.w.has(tok)) { inter += wt; if (wt >= 1) anchor = true; } });
  if (!inter) return NONE;
  const contain = inter / Math.min(a.total, b.total);
  const both = inter / (a.total + b.total - inter);
  /* a one-word title ("Gym") only matches something that is nearly that one word
   * ("Go to the gym"), never every sentence that happens to contain it */
  if (Math.min(a.count, b.count) === 1) { if (both < 0.6) return NONE; }
  /* sharing only generic words counts when the shorter title is fully covered */
  else if (!anchor && contain < 0.999) return NONE;
  return { score: 0.6 * contain + 0.4 * both, both };
}
function digestDupScore(textA, textB) { return digestDupCompare(textA, textB).score; }

/* incoming title vs the pool → the pool entry it repeats, or null */
function digestDupInPool(title, pool) {
  let best = null, bestScore = 0;
  (pool || []).forEach(x => {
    const sc = digestDupCompare(title, x.title).both;
    /* a pending twin stays on the card, so skipping costs nothing; an added or
     * dismissed one is out of sight, so the incoming title must be closer still */
    const bar = x.status === 'pending' ? DIGEST_DUP_POOL : DIGEST_DUP_SETTLED;
    if (sc >= bar && sc > bestScore) { best = x; bestScore = sc; }
  });
  return best;
}

/* Every task a suggestion could be repeating: Day by Day plus every list.
 * A finished dated task only counts for a week — last month's "Pay the water
 * bill ✓" must not block this month's. Daily lists recur, so their done flag
 * (which resets every day) is ignored. */
function digestDupCandidates() {
  const today = calToday();
  const recent = key => {
    if (!key) return false;
    return Math.abs(Math.round((calKeyToDate(key) - today) / 86400000)) <= DIGEST_DUP_DONE_DAYS;
  };
  const stale = t => t.done && t.due && !(recent(t.doneOn) || recent(t.due));
  const out = [];
  dbdTasks.forEach(t => { if (!stale(t)) out.push({ kind: 'dbd', task: t, list: null }); });
  todoLists.forEach(l => l.tasks.forEach(t => {
    if (!l.isDefault && stale(t)) return;
    out.push({ kind: 'list', task: t, list: l });
  }));
  return out;
}
/* best existing task for one suggestion: { kind, task, list, score } or null */
function digestFindExisting(sug, candidates) {
  let best = null;
  (candidates || digestDupCandidates()).forEach(c => {
    const sc = digestDupScore(sug.title, c.task.text);
    if (sc >= DIGEST_DUP_FLAG && (!best || sc > best.score)) best = { ...c, score: sc };
  });
  return best;
}
/* Map(suggestion id → match) for the open suggestions in `list` */
function digestDupMap(list) {
  const out = new Map();
  const open = (list || []).filter(t => t.status !== 'dismissed' && !digestTaskIsAdded(t));
  if (!open.length) return out;
  const cands = digestDupCandidates();
  open.forEach(t => { const m = digestFindExisting(t, cands); if (m) out.set(t.id, m); });
  return out;
}
/* same title, word for word, anywhere in Day by Day or a custom list */
function digestDupHasExact(title) {
  const key = digestSugKey(title);
  if (!key) return false;
  return dbdTasks.some(t => digestDupTokens(t.text).key === key) ||
    todoLists.some(l => !l.isDefault && l.tasks.some(t => digestDupTokens(t.text).key === key));
}
/* "Looks like “Northwind OA” · Day by Day · Tomorrow". Only a near-identical
 * title gets the confident wording; a looser match never claims more than "looks like". */
function digestDupLabel(m) {
  const t = m.task;
  const done = t.done && !(m.list && m.list.isDefault);   // a Daily task's tick resets every day
  const sure = m.score >= DIGEST_DUP_EXACT;
  const lead = sure ? (done ? 'Already done:' : 'Already on your list:') : 'Looks like';
  const where = m.kind === 'dbd' ? 'Day by Day' : ((m.list && m.list.title) || 'Untitled list');
  const bits = [where];
  if (t.due) bits.push(dbdLabelFor(t.due));
  if (done && !sure) bits.push('done \u2713');
  return `${lead} \u201c${t.text}\u201d \u00b7 ${bits.join(' \u00b7 ')}`;
}
export let digestInboxPending = null;
export function setDigestInboxPending(v) { digestInboxPending = v; }
function digestInboxHandledAt() {
  const d = digestGet();
  return Math.max(d.last ? d.last.at : 0, d.clearedAt || 0);
}
export function digestInboxSeen(inbox) {
  if (!inbox || typeof inbox !== 'object' || typeof inbox.markdown !== 'string' || !inbox.markdown.trim()) return;
  const at = Number(inbox.at) || 0;
  if (!at || at <= digestInboxHandledAt()) return;   // already merged, cleared, or something newer is showing
  digestInboxPending = inbox;
  digestInboxFlush();
}
export function digestInboxFlush() {
  const inbox = digestInboxPending;
  if (!inbox || !syncReconciled || syncPendingRemote || syncHeld()) return;
  digestInboxPending = null;
  const at = Number(inbox.at) || 0;
  const d = digestGet();
  if (at <= digestInboxHandledAt()) return;
  d.enabled = true;                   // a delivery means the feature is in use; show the card
  d.last = {
    at,
    markdown: String(inbox.markdown),
    count: Number(inbox.count) || 0,
    model: typeof inbox.model === 'string' ? inbox.model : '',
    source: typeof inbox.source === 'string' && inbox.source ? inbox.source : 'github',
  };
  const tasks = digestNormalizeTasks(Array.isArray(inbox.tasks) ? inbox.tasks : [], false);
  const fresh = digestMergeSuggestions(tasks, at);
  digest = normalizeDigest(digest);   // canonical shape, same as after a reload
  digestCollapsed = false;
  digestRunDelivered(at);             // a watched GitHub run is now complete end to end
  setSyncQuietSave(true);               // pushable, but must not look like a fresh user edit
  try { saveToLocal(); } finally { setSyncQuietSave(false); }
  renderSettings();
  renderHome();
  const dupes = fresh ? digestDupMap(digestGet().suggestions.filter(x => x.status === 'pending' && x.at === at)).size : 0;
  showToast(fresh
    ? `Email digest ready ✓ ${fresh} new suggestion${fresh === 1 ? '' : 's'}${dupes ? ` · ${dupes} already on your lists` : ''}`
    : 'Email digest ready ✓');
}

/* Suggested tasks: { id, title, why, due:'YYYY-MM-DD'|'', section, added:<dbd id>|0 } */
function digestNormalizeTasks(arr, resolve) {
  const out = [];
  const seen = new Set();
  (Array.isArray(arr) ? arr : []).forEach(t => {
    if (!t || typeof t !== 'object') return;
    const title = String(t.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: out.length + 1,
      title,
      why: String(t.why || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      due: resolve ? digestNormalizeDue(t.due) : (/^\d{4}-\d{2}-\d{2}$/.test(String(t.due || '')) ? String(t.due) : ''),
      section: /^[a-z0-9-]{1,40}$/.test(String(t.section || '')) ? String(t.section) : 'misc',
      added: Number(t.added) > 0 ? Number(t.added) : 0,
    });
  });
  return out.slice(0, 10);
}
/* Accepts ISO dates plus a few relative words; anything in the past becomes
 * today, anything more than ~3 months out (or unparseable) becomes "". */
function digestNormalizeDue(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'null') return '';
  const today = calToday();
  let d = null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
  else if (s === 'today') d = new Date(today);
  else if (s === 'tomorrow') { d = new Date(today); d.setDate(d.getDate() + 1); }
  else {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const wi = days.findIndex(n => s.startsWith(n.slice(0, 3)));
    if (wi >= 0) { d = new Date(today); d.setDate(d.getDate() + ((wi - today.getDay() + 7) % 7 || 7)); }
  }
  if (!d || isNaN(d)) return '';
  const diff = (d - today) / 86400000;
  if (diff < 0) return calDateKey(today);
  if (diff > 100) return '';
  return calDateKey(d);
}
function digestGet() { if (!digest) digest = normalizeDigest(null); return digest; }
export function digestRecord() {
  const d = digestGet();
  return {
    enabled: d.enabled,
    last: d.last ? { ...d.last } : null,
    suggestions: d.suggestions.map(x => ({ ...x })),
    sugIdCounter: d.sugIdCounter,
    ...(d.clearedAt ? { clearedAt: d.clearedAt } : {}),
  };
}
export function compressDigest(d) {
  const n = normalizeDigest(d);
  const o = { en: n.enabled ? 1 : 0 };
  if (n.last) o.l = { at: n.last.at, md: n.last.markdown, n: n.last.count, m: n.last.model, s: n.last.source };
  if (n.suggestions.length) o.sg = n.suggestions.map(x => { const c = { i: x.id, t: x.title, w: x.why, d: x.due, s: x.section, st: x.status, at: x.at }; if (x.dbdId) c.a = x.dbdId; return c; });
  if (n.sugIdCounter > 1) o.sn = n.sugIdCounter;
  if (n.clearedAt) o.ca = n.clearedAt;
  return o;
}
export function decompressDigest(c) {
  if (!c || typeof c !== 'object') return normalizeDigest(null);
  return normalizeDigest({
    enabled: !!c.en,
    last: c.l ? { at: c.l.at, markdown: c.l.md, count: c.l.n, model: c.l.m, source: c.l.s,
                  tasks: Array.isArray(c.l.tk) ? c.l.tk.map(t => ({ id: t.i, title: t.t, why: t.w, due: t.d, section: t.s, added: t.a })) : undefined } : null,
    suggestions: Array.isArray(c.sg) ? c.sg.map(x => ({ id: x.i, title: x.t, why: x.w, due: x.d, section: x.s, status: x.st, at: x.at, dbdId: x.a })) : undefined,
    sugIdCounter: c.sn,
    clearedAt: c.ca,
    /* c.sc / c.ls / c.rq from older builds are ignored */
  });
}

/* ── device-local UI state ── */
let digestCollapsed = false;
export function digestUiLoad() {
  try { digestCollapsed = !!JSON.parse(localStorage.getItem(DIGEST_UI_LS_KEY))?.collapsed; } catch(e) {}
}
export function digestToggleCollapsed() {
  digestCollapsed = !digestCollapsed;
  try { localStorage.setItem(DIGEST_UI_LS_KEY, JSON.stringify({ collapsed: digestCollapsed })); } catch(e) {}
  renderHome();
}

/* ── "Run now": ask GitHub to start the workflow from this device ──
 * Needs a fine-grained personal access token with Actions: Read and write
 * on the repo. The token is device-local (never synced), like the old Gmail
 * token was. After dispatching we watch the run until it completes; the
 * digest itself still arrives through Firebase like a scheduled one. */
let digestGithub = null;   // { token }
let digestRun = null;      // { requestedAt, status: 'queued'|'in_progress'|'completed', conclusion, url, error, startedAt }
let digestRunTimer = null;
let   DIGEST_RUN_POLL_MS   = 20000;   // let: tests shorten it
const DIGEST_RUN_MAX_MS    = 100 * 60000;   // give up watching after this (the workflow's own cap is 120 min)

function digestGithubGet() {
  if (digestGithub) return digestGithub;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DIGEST_GITHUB_LS_KEY)); } catch(e) {}
  digestGithub = { token: (saved && typeof saved.token === 'string') ? saved.token.trim() : '' };
  return digestGithub;
}
function digestGithubSave(patch) {
  const g = Object.assign(digestGithubGet(), patch || {});
  try {
    if (g.token) localStorage.setItem(DIGEST_GITHUB_LS_KEY, JSON.stringify({ token: g.token }));
    else localStorage.removeItem(DIGEST_GITHUB_LS_KEY);
  } catch(e) {}
  return g;
}
function digestGithubHeaders() {
  return {
    Authorization: `Bearer ${digestGithubGet().token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
function digestGithubApi(path) { return `https://api.github.com/repos/${DIGEST_GITHUB_REPO}/actions/${path}`; }
function digestRunSave() {
  try {
    if (digestRun) localStorage.setItem(DIGEST_RUN_LS_KEY, JSON.stringify(digestRun));
    else localStorage.removeItem(DIGEST_RUN_LS_KEY);
  } catch(e) {}
}
export function digestRunLoad() {
  try {
    const r = JSON.parse(localStorage.getItem(DIGEST_RUN_LS_KEY));
    if (r && Number(r.requestedAt) > 0 && Date.now() - r.requestedAt < DIGEST_RUN_MAX_MS) digestRun = r;
  } catch(e) {}
  if (digestRun && digestRunActive()) digestRunPollStart();
}
export function digestRunActive() { return !!(digestRun && !digestRun.error && digestRun.status !== 'completed'); }
/* the run finished on GitHub but the result hasn't reached this device yet */
function digestRunDelivering() { return !!(digestRun && !digestRun.error && digestRun.status === 'completed' && digestRun.conclusion === 'success'); }

export async function digestRunNow() {
  if (!digestGithubGet().token) {
    showToast('Add a GitHub token in Settings → Email Digest to run it from here');
    openSettings('digest');
    return;
  }
  if (digestRunActive()) return;
  digestRun = { requestedAt: Date.now(), status: 'queued' };
  digestRunSave();
  renderHome(); digestRenderSettings();
  try {
    const r = await fetch(digestGithubApi(`workflows/${DIGEST_GITHUB_WORKFLOW}/dispatches`), {
      method: 'POST',
      headers: { ...digestGithubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { dry_run: 'false' } }),
    });
    if (r.status !== 204) {
      const why = (r.status === 401 || r.status === 403) ? 'GitHub rejected the token — it needs Actions: Read and write on the repo.'
        : r.status === 404 ? `Workflow not found — is ${DIGEST_GITHUB_WORKFLOW} on main?`
        : `GitHub answered ${r.status}.`;
      throw new Error(why);
    }
    showToast('Digest run started on GitHub');
    digestRunPollStart();
  } catch(e) {
    digestRun = { requestedAt: digestRun.requestedAt, status: 'completed', error: (e && e.message) || 'Could not reach GitHub.' };
    digestRunSave();
  }
  renderHome(); digestRenderSettings();
}
function digestRunPollStart() {
  clearTimeout(digestRunTimer);
  digestRunTimer = setTimeout(digestRunPoll, Math.min(4000, DIGEST_RUN_POLL_MS));   // the run needs a moment to appear in the list
}
export async function digestRunPoll() {
  clearTimeout(digestRunTimer);
  if (!digestRunActive()) return;
  if (Date.now() - digestRun.requestedAt > DIGEST_RUN_MAX_MS) {
    digestRun = { ...digestRun, status: 'completed', error: 'Stopped watching after 100 minutes. Check the run on GitHub.' };
    digestRunSave(); renderHome(); digestRenderSettings();
    return;
  }
  try {
    const r = await fetch(digestGithubApi(`workflows/${DIGEST_GITHUB_WORKFLOW}/runs?event=workflow_dispatch&per_page=3`), { headers: digestGithubHeaders() });
    if (r.ok) {
      const j = await r.json();
      /* the run we dispatched: first one created at or after our request (minus clock slop) */
      const mine = (j.workflow_runs || []).find(x => Date.parse(x.created_at) >= digestRun.requestedAt - 90000);
      if (mine) {
        digestRun = {
          ...digestRun,
          status: mine.status === 'completed' ? 'completed' : (mine.status === 'in_progress' ? 'in_progress' : 'queued'),
          conclusion: mine.conclusion || '',
          url: mine.html_url || '',
          startedAt: Date.parse(mine.run_started_at || mine.created_at) || digestRun.requestedAt,
        };
        if (digestRun.status === 'completed' && digestRun.conclusion !== 'success') {
          digestRun.error = digestRun.conclusion === 'cancelled' ? 'The run was cancelled.' : 'The run failed on GitHub — open the log to see why.';
        }
        digestRunSave();
        renderHome(); digestRenderSettings();
      }
    }
  } catch(e) { /* offline or rate-limited: try again next tick */ }
  if (digestRunActive()) digestRunTimer = setTimeout(digestRunPoll, DIGEST_RUN_POLL_MS);
}
/* A digest landed. If it's the one we asked for, stop showing the run. */
function digestRunDelivered(at) {
  if (digestRun && at >= digestRun.requestedAt - 90000) {
    clearTimeout(digestRunTimer);
    digestRun = null;
    digestRunSave();
  }
}
export function digestRunDismiss() { clearTimeout(digestRunTimer); digestRun = null; digestRunSave(); renderHome(); digestRenderSettings(); }
function digestRunLabel() {
  if (!digestRun) return '';
  if (digestRun.error) return digestRun.error;
  const mins = Math.max(0, Math.round((Date.now() - (digestRun.startedAt || digestRun.requestedAt)) / 60000));
  if (digestRun.status === 'queued') return 'Waiting for a GitHub runner…';
  if (digestRun.status === 'in_progress') return `Running on GitHub · ${mins} min · usually 15–40`;
  if (digestRunDelivering()) return 'Finished on GitHub · arriving through sync…';
  return '';
}
function digestRunHtml() {
  if (!digestRun) return '';
  const link = digestRun.url ? ` <a href="${escAttr(digestRun.url)}" target="_blank" rel="noopener">Open run</a>` : '';
  const dismiss = (digestRun.error || digestRunDelivering()) ? ` <button class="dg-run-x" onclick="digestRunDismiss()" aria-label="Dismiss">×</button>` : '';
  return `<div class="dg-run ${digestRun.error ? 'err' : ''}">${escAttr(digestRunLabel())}${link}${dismiss}</div>`;
}

/* ── sample digest: shows the card without any backend ── */
export function digestLoadSample() {
  digestGet().enabled = true;
  const at = Date.now();
  digestGet().last = { at, markdown: DIGEST_SAMPLE_MD, count: 23, model: 'sample', source: 'sample' };
  digestMergeSuggestions(digestNormalizeTasks(DIGEST_SAMPLE_TASKS, true), at);
  digest = normalizeDigest(digest);   // canonical shape, same as after a reload
  digestCollapsed = false;
  saveToLocal();
  renderSettings();
  renderHome();
  digestShowHome();
  showToast('Sample digest loaded');
}
function digestClearLast() {
  const d = digestGet();
  /* remember how far we've cleared: the delivered copy stays in the cloud
   * inbox until the next run, and must not pop straight back in */
  const upTo = Math.max(d.clearedAt || 0, d.last ? d.last.at : 0, Number(digestInboxLatest && digestInboxLatest.at) || 0);
  if (upTo) d.clearedAt = upTo;
  d.last = null;
  saveToLocal();
  renderSettings();
  renderHome();
}

/* ── markdown → safe HTML (headings, lists, tables, code, links, bold) ── */
function digestInline(s) {
  let t = escAttr(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`);
  t = t.replace(/(^|[\s(])((https?:\/\/)[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url.length > 60 ? url.slice(0, 57) + '…' : url}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[\s(])\*([^*]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return t;
}
function digestRenderMd(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```/))) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escAttr(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const lvl = Math.max(2, Math.min(6, m[1].length));   // h1/h2 both render as h2 inside the card
      out.push(`<h${lvl}>${digestInline(m[2].trim())}</h${lvl}>`); i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map(c => `<th>${digestInline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + head.map((_, k) => `<td>${digestInline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let txt = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) txt += ' ' + lines[i++].trim();
        const task = txt.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) items.push(`<li class="dg-task ${task[1] !== ' ' ? 'done' : ''}"><span class="dg-box"></span>${digestInline(task[2])}</li>`);
        else items.push(`<li>${digestInline(txt)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${digestInline(buf.join(' '))}</blockquote>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s+|\s*>)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++].trim());
    out.push(`<p>${digestInline(buf.join(' '))}</p>`);
  }
  return out.join('');
}

function digestShowHome() {
  if (isMobileLayout()) goTab('home', true); else homeToggleDesktop(true);
}

/* ── Home card ── */
function digestMetaLine(last) {
  const when = new Date(last.at);
  const sameDay = when.toDateString() === new Date().toDateString();
  const t = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const d = when.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const bits = [sameDay ? `Today ${t}` : `${d} ${t}`];
  if (last.count) bits.push(`${last.count} emails`);
  if (last.source === 'sample') bits.push('sample data');
  else if (last.model) bits.push(last.model + (last.source === 'github' ? ' · GitHub' : ''));
  return bits.join(' \u00b7 ');
}
export function homeDigestHtml() {
  const d = digestGet();
  if (!d.enabled) return '';
  const last = d.last;
  const busy = digestRunActive();
  const hasToken = !!digestGithubGet().token;
  const runBtn = busy ? '' : `<button class="dg-btn" onclick="digestRunNow()" title="${hasToken ? 'Start the GitHub workflow now; the result arrives here in 15–40 minutes' : 'Add a GitHub token in Settings to run it from here'}">Run now</button>`;
  const chevron = last ? `<button class="dg-chev ${digestCollapsed ? 'closed' : ''}" onclick="digestToggleCollapsed()" title="${digestCollapsed ? 'Expand' : 'Collapse'}" aria-label="Toggle digest">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>` : '';
  let body;
  if (last && !digestCollapsed) body = `${digestTasksHtml()}<div class="dg-md">${digestRenderMd(last.markdown)}</div>`;
  else if (last) body = '';
  else if (busy) body = digestTasksHtml();
  else body = `${digestTasksHtml()}
      <div class="dg-empty">
        <div class="dg-empty-text">${hasToken
          ? 'Nothing delivered yet. GitHub builds the digest every morning and it lands here through sync — or press Run now to start one.'
          : 'GitHub builds the digest every morning from the last day of Gmail and it lands here through sync. To start one from this device, add a GitHub token in Settings → Email Digest.'}</div>
        <div class="dg-status-actions">
          ${hasToken ? '' : '<button class="dg-btn" onclick="openSettings(&quot;digest&quot;)">Open Settings</button>'}
          <button class="dg-btn ghost" onclick="digestLoadSample()">See a sample</button>
        </div>
      </div>`;
  return `
    <section class="home-section dg-section">
      <div class="home-card dg-card">
        <div class="dg-head">
          <div class="dg-title-wrap">
            <div class="dg-title">Email digest</div>
            ${last ? `<div class="dg-meta">${escAttr(digestMetaLine(last))}</div>` : ''}
          </div>
          <div class="dg-actions">${runBtn}${chevron}</div>
        </div>
        ${digestRunHtml()}
        ${body}
      </div>
    </section>`;
}

/* ── suggested tasks: the pool, rendered above the summary ──
 * Pending ones stay until Add or Dismiss. Ones added since the last digest
 * stay visible (struck through) so the feedback is obvious; they drop off
 * the card on the next one. An added suggestion whose task the user later
 * deleted is offered again. */
function digestTaskIsAdded(t) {
  if (t.status !== 'added') return false;
  if (t.dbdId && dbdById(t.dbdId)) return true;
  /* tagging MOVES the task into a list under a new id — the same title there still counts as added */
  return digestDupHasExact(t.title);
}
function digestVisibleSuggestions() {
  const d = digestGet();
  const lastAt = d.last ? d.last.at : 0;
  return d.suggestions.filter(t => {
    if (t.status === 'dismissed') return false;
    if (t.status === 'added') return digestTaskIsAdded(t) ? t.at >= lastAt : true;   // deleted task → re-offer
    return true;
  });
}
function digestTasksHtml() {
  const all = digestVisibleSuggestions();
  if (!all.length && !(digestGet().last)) return '';
  const dupes = digestDupMap(all);                                   // open suggestions that repeat an existing task
  const tasks = all.filter(t => !dupes.has(t.id)).concat(all.filter(t => dupes.has(t.id)));   // those sink to the bottom
  const remaining = tasks.filter(t => !digestTaskIsAdded(t) && !dupes.has(t.id));
  const rows = tasks.map(t => {
    const added = digestTaskIsAdded(t);
    const dup = dupes.get(t.id);
    const due = t.due ? `<span class="dg-todo-due">${escAttr(dbdLabelFor(t.due))}</span>` : '';
    const why = t.why ? `<span class="dg-todo-why">${escAttr(t.why)}</span>` : '';
    return `
      <div class="dg-todo ${added ? 'added' : ''} ${dup ? 'dup' : ''}" data-dgt="${t.id}">
        <div class="dg-todo-main">
          <div class="dg-todo-title">${escAttr(t.title)}</div>
          ${(why || due) ? `<div class="dg-todo-sub">${due}${why}</div>` : ''}
          ${dup ? `<div class="dg-todo-dup">${escAttr(digestDupLabel(dup))}</div>` : ''}
        </div>
        ${added
          ? `<span class="dg-todo-added" title="It's in your lists">Added ✓</span>`
          : `<span class="dg-todo-actions">
               ${dup
                 ? `<button class="dg-btn ghost dg-todo-add" onclick="digestAddTask(${t.id})" title="Add it to Day by Day even though something similar is already there">Add anyway</button>`
                 : `<button class="dg-btn dg-todo-add" onclick="digestAddTask(${t.id})" title="Add to Day by Day">Add</button>`}
               <button class="dg-todo-dismiss" onclick="digestDismissTask(${t.id})" title="Dismiss — won't be suggested again" aria-label="Dismiss">×</button>
             </span>`}
      </div>`;
  }).join('');
  const addAll = remaining.length > 1 ? `<button class="dg-btn ghost dg-todo-addall" onclick="digestAddAllTasks()">Add all (${remaining.length})</button>` : '';
  const countLabel = remaining.length ? remaining.length : dupes.size ? 'nothing new' : 'all added';
  return `
    <div class="dg-todos">
      <div class="dg-todos-head">
        <div class="dg-todos-title">✅ Suggested tasks${tasks.length ? ` <span class="dg-todos-count">${countLabel}</span>` : ''}</div>
        ${addAll}
      </div>
      ${tasks.length ? rows : '<div class="dg-todos-empty">No open suggestions.</div>'}
    </div>`;
}
function digestTaskById(id) {
  return digestGet().suggestions.find(t => t.id === Number(id)) || null;
}
/* Add → a Day by Day task (due date from the digest, else today), so it lands
 * in Today's tasks on Home and in the Lists tab like anything typed by hand. */
export function digestAddTask(id, opts) {
  const t = digestTaskById(id);
  if (!t || t.status === 'dismissed' || digestTaskIsAdded(t)) return false;
  const task = { id: nextDbdId(), text: t.title, due: t.due || dbdTodayKey(), done: false };
  dbdTasks.push(task);
  t.status = 'added';
  t.dbdId = task.id;
  t.at = Date.now();
  if (!(opts && opts.batch)) {
    renderDbd();
    renderHome();
    saveToLocal();
    showToast(`Added to Day by Day · ${dbdLabelFor(task.due)}`);
  }
  return true;
}
/* Reject: hidden for good, and the same title is not re-suggested for two weeks */
export function digestDismissTask(id) {
  const t = digestTaskById(id);
  if (!t || t.status === 'dismissed') return false;
  t.status = 'dismissed';
  t.dbdId = 0;
  t.at = Date.now();
  renderHome();
  saveToLocal();
  return true;
}
/* Add all never creates a repeat: flagged suggestions stay put (Add anyway is one tap away).
 * The flags are taken before the first add so a just-added task can't flag its neighbour. */
export function digestAddAllTasks() {
  const list = digestVisibleSuggestions();
  const dupes = digestDupMap(list);
  const n = list.reduce((c, t) => c + (!dupes.has(t.id) && digestAddTask(t.id, { batch: true }) ? 1 : 0), 0);
  renderDbd();
  renderHome();
  saveToLocal();
  const skipped = dupes.size ? ` · skipped ${dupes.size} already on your lists` : '';
  showToast(n ? `Added ${n} task${n === 1 ? '' : 's'} to Day by Day${skipped}` : (dupes.size ? 'Nothing new — the rest is already on your lists' : 'Everything is already added'));
}

/* ── Settings section ── */
export function digestRenderSettings() {
  const wrap = $('digestSettings');
  if (!wrap) return;
  const d = digestGet();
  const tog = $('digestEnabledToggle');
  if (tog) tog.checked = d.enabled;
  const fields = $('digestFields');
  if (fields) fields.style.display = d.enabled ? '' : 'none';
  const status = $('digestStatusLine');
  if (status) status.textContent = d.last
    ? (d.last.source === 'sample' ? 'Showing the sample digest.' : `Last digest: ${digestMetaLine(d.last)}.`)
    : 'No digest delivered yet.';
  /* which account this device receives digests through — the usual reason a
   * digest shows on one device and not another is that this differs */
  const via = $('digestSyncHint');
  if (via) {
    const signedIn = !!syncUser;
    via.classList.toggle('warn', !signedIn);
    via.textContent = signedIn
      ? `This device receives digests through cloud sync as ${syncUser.email || 'your Google account'}. Every device signed in to that same account shows the same digest.`
      : 'This device is not signed in to cloud sync, so digests cannot reach it. Sign in under Settings → Cloud sync with the same Google account as your other devices.';
  }
  const tokIn = $('digestGithubToken');
  const hasToken = !!digestGithubGet().token;
  if (tokIn && document.activeElement !== tokIn) tokIn.value = hasToken ? '••••••••••••' : '';
  const tokBtn = $('digestGithubSaveBtn');
  if (tokBtn) tokBtn.textContent = hasToken ? 'Remove' : 'Save';
  const gs = $('digestGithubStatus');
  if (gs) gs.textContent = digestRun ? digestRunLabel()
    : hasToken ? 'Token saved on this device only. Run now starts the workflow and the digest arrives through sync.'
    : 'No token — Run now is off on this device. Scheduled runs are unaffected.';
  const runBtn = $('digestRunSettingsBtn');
  if (runBtn) runBtn.disabled = !hasToken || digestRunActive();
  const open = $('digestOpenRunBtn');
  if (open) open.style.display = (digestRun && digestRun.url) ? '' : 'none';
  const clr = $('digestClearBtn');
  if (clr) clr.style.display = d.last ? '' : 'none';
  digestPromptRender();
}
export function bindDigest() {
  $('digestEnabledToggle')?.addEventListener('change', e => {
    digestGet().enabled = !!e.target.checked;
    saveToLocal();
    digestRenderSettings();
    renderHome();
  });
  $('digestGithubSaveBtn')?.addEventListener('click', () => {
    const inp = $('digestGithubToken');
    if (digestGithubGet().token) { digestGithubSave({ token: '' }); showToast('GitHub token removed from this device'); }
    else {
      const v = (inp?.value || '').trim();
      if (!v || /^•+$/.test(v)) { showToast('Paste a GitHub token first'); return; }
      digestGithubSave({ token: v });
      showToast('Token saved on this device');
    }
    if (inp) inp.value = '';
    digestRenderSettings(); renderHome();
  });
  $('digestGithubToken')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('digestGithubSaveBtn')?.click(); } });
  $('digestRunSettingsBtn')?.addEventListener('click', () => { closeModal('settingsModal'); digestShowHome(); digestRunNow(); });
  $('digestOpenRunBtn')?.addEventListener('click', () => { if (digestRun && digestRun.url) window.open(digestRun.url, '_blank', 'noopener'); });
  $('digestSampleBtn')?.addEventListener('click', () => { closeModal('settingsModal'); digestLoadSample(); });
  $('digestClearBtn')?.addEventListener('click', digestClearLast);
  bindDigestPrompts();
}

const DIGEST_SAMPLE_MD = `## 🔝 Top of the inbox
23 emails since yesterday morning. One thing is urgent: the **Northwind Labs** online assessment closes **tomorrow at 5pm**. Everything else can wait until lunch.

## 📰 Tech News (TLDR)
**TLDR**
- **Postgres 18 ships async I/O** — the new io_uring backend cuts sequential scan latency by up to 3× on NVMe; opt-in via \`io_method\`. [Read](https://example.com/pg18-async)
- **Bun adds a built-in S3 client** — zero-dependency uploads and presigned URLs land in 1.3. [Read](https://example.com/bun-s3)
- **GitHub Actions gets ARM runners for free tier** — public repos can now target \`ubuntu-24.04-arm\`. [Read](https://example.com/gha-arm)

**TLDR AI**
- **Small models, big context** — a 3B model trained with ring attention matches 70B baselines on 128k-token retrieval. [Paper](https://example.com/ring-3b)
- **Ollama 0.12 adds tool streaming** — function-call chunks now arrive as they're generated. [Notes](https://example.com/ollama-012)

## 🏗️ ByteByteGo
**Major concepts**
- How **rate limiters** are built at scale: token bucket vs sliding window log.
- Why the limiter must live at the edge, not inside each service.

**How it works**
\`\`\`
client ──▶ API gateway ──▶ rate limiter (Redis) ──▶ service
                              │
                              └─▶ 429 + Retry-After
\`\`\`
- Each key stores a bucket \`{tokens, lastRefill}\`; a Lua script refills and decrements atomically.
- Buckets are sharded by user id so one hot key can't saturate a node.

**Why it matters**
- A single Redis round trip per request keeps p99 under 2ms while protecting every downstream service. [Full issue](https://example.com/bbg-rate-limits)

## 📮 Other Newsletters
**Pragmatic Engineer**
- Inside a 4-person team's migration off Kafka to Postgres queues, and why it worked for them. [Read](https://example.com/pe-kafka)
- Hiring survey: take-home tasks are down 30% year over year.

**Medium Daily Digest**
- "What I learned running a PWA for 1,000 days" — mostly about service-worker cache busting.

## 💼 Job Application Updates
⚠️ **Northwind Labs** — online assessment invite, closes **tomorrow 5:00pm CT**.

| Company | Role | Status | Action needed | Deadline |
|---|---|---|---|---|
| **Northwind Labs** | Software Engineer II | Assessment invite | Complete HackerRank (90 min) | Tomorrow 5pm |
| **Fabrikam** | Backend Engineer | Recruiter screen scheduled | Confirm Thursday 10am | Wed |
| **Contoso** | Full-stack Developer | Not moving forward | — | — |

## 📬 Miscellaneous
- **Austin Energy** — August statement, $84.12 due Sep 19 — autopay is on, no action.
- **Dr. Patel's office** — appointment reminder for Sep 12, 9:30am — reply YES to confirm.
- **Google Calendar** — invitation: "Study group" Saturday 2pm — accept or decline.`;
const DIGEST_SAMPLE_TASKS = [
  { title: 'Finish the Northwind Labs online assessment', why: 'Closes tomorrow at 5pm.', due: 'tomorrow', section: 'jobs' },
  { title: 'Confirm Fabrikam recruiter screen',           why: 'Thursday 10am — reply to lock the slot.', due: 'thursday', section: 'jobs' },
  { title: "Reply YES to Dr. Patel's reminder",           why: 'Appointment confirmation requested.', due: 'today', section: 'misc' },
  { title: 'Respond to the Saturday study group invite',  why: 'Calendar invitation, accept or decline.', due: 'friday', section: 'misc' },
];
