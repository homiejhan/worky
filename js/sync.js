/* sync.js — Cloud sync of the whole state through Firebase. */
import {
  FIREBASE_CONFIG, GCAL_CLIENT_ID, GCAL_REDIRECT, SYNC_BASE_LS_KEY, SYNC_META_LS_KEY, SYNC_SENT_LS_KEY,
  SYNC_STATE_TAG,
} from './config.js';
import { $, closeModal, keepField, showToast, typingPauseIn, userTyping } from './util.js';
import {
  bootStateStr, gatherState, loadStateString, renderLoadedState, restoreState, saveToLocal, setStateMark, STATE_BUILD,
  takeInOtherTab,
} from './persistence.js';
import { formatMode } from './formats.js';
import {
  digestGithubForget, digestGithubSeen, digestInboxSeen, digestRenderSettings, setDigestInboxPending,
} from './digest.js';
import {
  digestPromptsSeen, setDigestPromptDirty, setDigestPromptsSaved,
} from './digest-prompts.js';
import { setTourReoffer, tourMarkSeen, tourOffer, tourReoffer } from './onboarding.js';
import { bankCloudForget, bankCloudSeen } from './bank.js';
import { syncMerge } from './syncmerge.js';
import {
  copiesIndex, copiesKeep, copiesList, copiesRecent, copiesRefresh, copiesSave, copiesStart, copiesState,
  copySummary as copySummaryOf,
} from './synccopies.js';

/* ───────────────────────── CLOUD SYNC ─────────────────────────
 * Live cross-device sync of the full app state via Firebase.
 *
 *   • Sign-in: same full-page Google OAuth redirect the Calendar
 *     connection uses (state=worky-sync distinguishes the two), then
 *     the access token is exchanged for a persistent Firebase session
 *     (survives restarts; no repeated sign-ins).
 *   • Storage: one node per account — users/<uid> = { state, updatedAt,
 *     client }. `state` is the exact JSON blob saveToLocal() writes,
 *     so cloud and localStorage always speak the same format.
 *   • Push: saveToLocal() reports every save here; a fingerprint that
 *     ignores the ticking seconds of RUNNING timers decides whether a
 *     real change happened (otherwise a running timer would push every
 *     2s forever). Real changes push after a short debounce, and only
 *     over the cloud copy this device last saw (syncWrite).
 *   • Pull: a realtime listener applies remote changes from other
 *     devices through the same load path as a saved copy (loadStateString),
 *     then saves them like any change (saveToLocal). Own writes echo back and are ignored via
 *     the per-session client id.
 *   • Conflicts: when both this device and the cloud changed since the
 *     copy they last agreed on (SYNC_BASE_LS_KEY, or among the kept copies),
 *     the two are merged against it (syncmerge.js): a task added here and
 *     a purchase logged there are both kept. Without that copy there is no
 *     telling whose change is whose: the cloud's copy is taken, and this
 *     device's is kept to restore (Settings → Cloud sync → Earlier copies).
 *   • Revisions: every push stamps the state with a revision (syncRev) and a
 *     number one past the copy it was built on (syncSeq), and names that copy
 *     (syncBase, syncBaseHash, syncBaseSeq). An older version of Focus carries
 *     fields it doesn't know through untouched, so a copy it writes still
 *     names the last revision it took in. A copy built on an older one than
 *     this device has (that device was offline, or on an older version, and
 *     wrote over the cloud without looking) would undo what came after: its
 *     changes are put on top instead, merged from the copy it started from
 *     (syncBuiltOn); when this device doesn't have that copy, what it has
 *     stays and goes back to the cloud, and the older copy is kept to restore.
 *     So a whole day's changes can't be replaced by yesterday's copy.
 *   • Kept copies (synccopies.js, in IndexedDB): every agreed copy, and this
 *     device's own whenever one came in that could not be merged into it.
 *   • Typing: while someone types, other devices' changes wait (applying
 *     one redraws the screen under the cursor); they are merged in when the
 *     typing pauses or the field is left. A cursor merely left in a field
 *     holds nothing up: the redraw puts it back (util.js → keepField).
 *   • Formats (template mode): the cloud is held in both directions
 *     while Formats is open; the Done click is the single, priority
 *     push (see syncHeld / syncCommitFormat below).
 * ─────────────────────────────────────────────────────────────── */
export let syncUser        = null;   // firebase user (null = signed out)
export let syncRef         = null;   // RTDB ref users/<uid>
let syncApplying    = false;  // true while a remote state is being applied
let syncKnownFp     = null;   // fingerprint both sides last agreed on
export let syncLastSeenFp  = null;   // fingerprint at the previous local save
export function setSyncLastSeenFp(v) { syncLastSeenFp = v; }
let syncPushTimer   = null;
let syncLastSyncAt  = null;   // for the settings status line
export let syncBooting     = true;   // true during init: nothing saved then is a user edit
export function setSyncBooting(v) { syncBooting = v; }
export let syncQuietSave   = false;  // true while saving a backend delivery: pushable, but not a user edit
export function setSyncQuietSave(v) { syncQuietSave = v; }
export let syncReconciled  = false;  // true once this connection has seen the cloud copy
let syncDeferredRemote = null; // foreign cloud value that arrived while Formats was open
let syncCloudSeen   = null;   // the cloud's state as this device last saw it (a hash): pushes only write over that
let syncKnownRev    = null;   // the revision (syncRev) of the copy this device and the cloud last agreed on
let syncCloudSeq    = 0;      // … and its revision number
let syncTopSeq      = 0;      // the highest revision number this device's copy takes in
let syncOverStale   = null;   // the hash of an older copy that took the cloud's place: this device's goes back over it
let syncKnownLog    = [];     // the revisions the agreed copy comes after (syncLog), newest last
let syncSent        = null;   // the last push sent and not heard back about yet: { rev, hash, seq, state, base, baseRev, at }
let syncPushing     = false;  // a push is on its way: the next one waits for it
let syncPushAgain   = false;  // … and was asked for meanwhile
let syncOlderSeen   = false;  // a device on an older version of Focus wrote to the cloud this session
let syncCommitPending  = 0;    // >0 while a Done push awaits server ack (priority window)
const SYNC_COMMIT_MAX_REPUSH = 2;
const syncClientId  = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ── delivery: users/<uid>/digestInbox ──
 * The backend never edits the synced state blob — that would race this
 * device's own edits. It leaves its result in a sibling node instead, and
 * that node STAYS there until the next delivery overwrites it (state pushes
 * use update(), which leaves siblings alone).
 *
 * Every device merges the inbox for itself, whenever it sees one newer than
 * the digest it holds. So the digest no longer depends on riding inside the
 * state blob from the first device that saw it: a phone opened hours later,
 * or a device whose stale copy just won a sync conflict and wiped the digest,
 * reads the same inbox and lands on the same result. Merging is idempotent
 * (same inbox + same state → same digest, same fingerprint), so two devices
 * merging at once agree instead of ping-ponging.
 *
 * `clearedAt` is what keeps a durable inbox from resurrecting a digest the
 * user cleared. If the inbox arrives before this connection has a settled
 * baseline (Import/Export modal open, Formats mode), it waits in memory. */
export let digestInboxLatest  = null;   // the inbox node as last seen by the realtime listener

export function syncConfigured() {
  return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.databaseURL && window.firebase);
}

/* Fingerprint: state identity for change detection. Running timers
 * tick every second, but (startedAt, secondsAtStart) already fully
 * determine the remaining time — so mask `seconds` on running timers
 * to keep the fingerprint stable while a timer runs. */
export function syncFingerprint(state) {
  const content = { ...state };
  /* which build wrote it, the revision stamps, and where this device's copy stands are not content */
  delete content.build; delete content.syncRev; delete content.syncBase; delete content.syncBaseHash;
  delete content.syncSeq; delete content.syncBaseSeq; delete content.syncLocal; delete content.syncLog;
  return JSON.stringify(syncCanon({
    ...content,
    timers: (content.timers || []).map(t => t.running ? { ...t, seconds: -1 } : t),
  }));
}
/* Key order is not identity: a device that re-normalises a record on load
 * (e.g. digest.last) must produce the same fingerprint as the one that wrote
 * it, or the two ping-pong the same content back and forth. */
function syncCanon(v) {
  if (Array.isArray(v)) return v.map(syncCanon);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach(k => { if (v[k] !== undefined) o[k] = syncCanon(v[k]); });
    return o;
  }
  return v;
}

/* Short stable hash of a fingerprint, persisted in sync meta as
 * `knownHash` = the last state both sides agreed on. On reconnect this
 * tells us WHICH side actually changed (local, cloud, or both) instead
 * of guessing from timestamps alone. */
function syncHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16) + ':' + str.length;
}

/* Record that cloud and this device now hold `fp` (post-push, echo,
 * apply, or an identical-on-connect check), and keep that copy of the state
 * (`stateStr`): the base a later conflict is merged against, and, by its
 * revision, where a late writer may have started from. */
function syncAgree(fp, extra, stateStr, by) {
  syncKnownFp = fp;
  syncLastSyncAt = Date.now();
  const meta = syncLoadMeta();
  meta.knownHash = syncHash(fp);
  Object.assign(meta, extra || {});
  if (typeof stateStr === 'string') {
    const st = syncStampsOf(stateStr);
    syncKnownRev = st.rev;
    syncKnownLog = st.log;
    meta.knownRev = syncKnownRev;
    syncTopSeq = Math.max(syncTopSeq, st.seq);
    copiesKeep({ kind: 'agreed', rev: st.rev, seq: st.seq, build: st.build, hash: meta.knownHash, by: by || null,
      canon: !!st.rev && st.build >= SYNC_STAMPS_BUILD, state: stateStr });   // an older version's echo of a copy keeps its writer
    try { localStorage.setItem(SYNC_BASE_LS_KEY, JSON.stringify({ hash: meta.knownHash, state: stateStr })); } catch(e) {}
  }
  setStateMark({ rev: syncKnownRev, hash: meta.knownHash, seq: syncTopSeq }, syncKnownLog);   // this device's copy is built on it (saved with it)
  syncSaveMeta(meta);
}
/* The copy both sides last agreed on, if this device still has it. */
function syncBase(hash) {
  try {
    const b = JSON.parse(localStorage.getItem(SYNC_BASE_LS_KEY));
    return b && b.hash === hash && typeof b.state === 'string' ? JSON.parse(b.state) : null;
  } catch(e) { return null; }
}

/* ── Revisions ──
 * A revision is a time-ordered random id (syncRev), stamped by the device that
 * pushes, with a number one past the highest its copy takes in (syncSeq): the
 * cloud's copies count up. A copy names the one it was built on (syncBase,
 * syncBaseHash) and that number (syncBaseSeq). An older version of Focus carries
 * fields it doesn't know through untouched, so a copy it writes still has the
 * revision and number of the last copy it took in.
 * Every copy this device and the cloud agree on is kept (synccopies.js), with its
 * revision, number, fingerprint hash and writer (`by`, the client id). A
 * revision's own copy is the one a stamping version wrote (canon); an older
 * version's writes carry the revision through with other content, kept beside it.
 * This device's own copy says which agreed copy it is built on (syncLocal), so a
 * copy saved before a newer one came in (storage full, a second tab of Focus) is
 * taken for what it is when Focus opens again, not for new changes. */
const SYNC_STAMPS_BUILD = 8;    // the first build that stamps revisions
const SYNC_SEQ_BUILD = 9;       // the first that numbers them
function syncNewRev() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
const SYNC_LOG_MAX = 60;        // revisions a copy lists it comes after
function syncLogOf(st) { return Array.isArray(st && st.syncLog) ? st.syncLog.filter(r => typeof r === 'string') : []; }
function syncStampsOf(stateStr) {
  try {
    const st = JSON.parse(stateStr);
    return { rev: typeof st.syncRev === 'string' ? st.syncRev : null, seq: Number(st.syncSeq) || 0, build: Number(st.build) || 1, log: syncLogOf(st) };
  } catch(e) { return { rev: null, seq: 0, build: 1, log: [] }; }
}
/* The number of the copy a copy was built on: the one it names, or for an older
 * version (it carries the number of the last copy it took in), that one. */
function syncBaseSeqOf(st) {
  return (Number(st.build) || 1) >= SYNC_SEQ_BUILD ? Number(st.syncBaseSeq) || 0 : Number(st.syncSeq) || 0;
}
/* Where a copy of this device's stands: { rev, hash, seq } of the agreed copy it is built on. */
function syncMarkOf(st) {
  const m = st && st.syncLocal;
  return m && typeof m.hash === 'string' ? { rev: typeof m.rev === 'string' ? m.rev : null, hash: m.hash, seq: Number(m.seq) || 0 } : null;
}
function syncAgreed() { return copiesRecent().filter(e => e.kind === 'agreed' && typeof e.state === 'string'); }
/* The agreed copy a cloud copy was built on, if this device kept it ({ hash,
 * state }; just { hash } when it is the one this device has, `knownHash`). A
 * stamping version names it (syncBaseHash, syncBase). An older version carries
 * the revision it last took in through, in syncRev: its copy was built on the
 * last copy under that revision the cloud had, the revision's own or a write of
 * its own since (one that put back what that copy had is kept as that copy, so
 * the newest of either kind). `by` is the writer's client id. One other than
 * `knownHash` means the writer missed what came after it (see syncReconcileRemote). */
function syncBuiltOn(remote, knownHash, by) {
  const build = Number(remote.build) || 1;
  /* every agreed copy kept, oldest first (an older one's state may be in the database only: syncLoadCopy) */
  const agreed = copiesIndex().filter(e => e.kind === 'agreed').sort((a, b) => a.at - b.at);
  const revCopy = rev => {                     // a revision's own copy, or failing that the earliest kept under it
    const h = typeof rev === 'string' && rev ? agreed.filter(e => e.rev === rev) : [];
    return h.find(e => e.canon) || h[0] || null;
  };
  if (build >= SYNC_STAMPS_BUILD) {
    if (typeof remote.syncBaseHash !== 'string') return null;
    if (remote.syncBaseHash === knownHash) return { hash: knownHash };
    /* (the previous version hashed its stamps with the content: by revision for its copies) */
    return agreed.filter(e => e.hash === remote.syncBaseHash).pop() || (build < SYNC_SEQ_BUILD ? revCopy(remote.syncBase) : null);
  }
  if (typeof remote.syncRev !== 'string' || !remote.syncRev) return null;
  return agreed.filter(e => e.rev === remote.syncRev && (e.canon || (by && e.by === by))).pop() || revCopy(remote.syncRev);
}
/* A copy that the one this device and the cloud agreed on comes after: its own
 * revision is in that one's syncLog (a stamping version's copies only). */
function syncHadIt(remote) {
  const rev = remote && remote.syncRev;
  return (Number(remote.build) || 1) >= SYNC_STAMPS_BUILD && typeof rev === 'string' && !!rev
    && (rev === syncKnownRev || syncKnownLog.includes(rev));
}
/* Built on an older copy than the newest this device's copy takes in: the writer
 * missed what came after (it was offline, or an older version that wrote over
 * the cloud without looking). */
function syncIsStale(remote) {
  return syncTopSeq > 0 && syncBaseSeqOf(remote) < syncTopSeq;
}
/* The agreed copy with this fingerprint hash, if this device kept it. */
function syncBaseCopy(hash) {
  if (!hash) return null;
  const kept = syncBase(hash);
  if (kept) return kept;
  const e = syncAgreed().filter(x => x.hash === hash).pop();
  try { return e ? JSON.parse(e.state) : null; } catch(err) { return null; }
}
/* The copy saved on this device when Focus opened, if it is the agreed copy it
 * says it is built on: kept among the agreed copies, so a device whose last
 * version kept none still has the copy to merge from. */
function syncKeepBootCopy() {
  if (typeof bootStateStr !== 'string') return;
  let st = null;
  try { st = JSON.parse(bootStateStr); } catch(e) { return; }
  const mark = syncMarkOf(st);
  const hash = syncStateHash(bootStateStr);
  if (!hash || hash !== (mark ? mark.hash : syncLoadMeta().knownHash) || syncAgreed().some(e => e.hash === hash)) return;
  const stamps = syncStampsOf(bootStateStr);
  copiesKeep({ kind: 'agreed', rev: stamps.rev, seq: stamps.seq, build: stamps.build, hash, state: bootStateStr });
}
/* Keep a copy to restore: this device's own ('local') or another's ('older'). */
function syncKeepCopy(kind, stateStr, by) {
  const st = syncStampsOf(stateStr);
  copiesKeep({ kind, rev: st.rev, seq: st.seq, build: st.build, hash: syncStateHash(stateStr) || '', by: by || null, state: stateStr });
}
/* That writer's changes, put on top of what this device has. */
function syncRebase(baseStr, remote, onto) {
  try {
    const base = JSON.parse(baseStr);
    const r = { ...remote };
    if ((Number(r.build) || 1) < STATE_BUILD) Object.keys(base).forEach(k => { if (!(k in r)) r[k] = base[k]; });
    /* the writer missed what this device has: where both changed the same thing, this device's (newer) stays */
    return syncMerge(base, onto, r, { preferLocal: true });
  } catch(e) { return null; }
}

function syncLoadMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_META_LS_KEY)) || {}; }
  catch(e) { return {}; }
}
function syncSaveMeta(m) {
  try { localStorage.setItem(SYNC_META_LS_KEY, JSON.stringify(m)); } catch(e) {}
}

/* ── Formats hold ──
 * While Formats (template mode) is open the cloud is frozen in both
 * directions: local saves keep landing in localStorage as usual but are
 * NOT pushed, and foreign cloud values are stashed instead of applied
 * (applying one would run loadFromLocal() over the in-progress template
 * edits). Clicking Done is the single moment the template reaches the
 * cloud, and that push has priority: it bypasses the debounce, discards
 * the stashed remote copy, and re-asserts itself if a foreign write
 * races it to the server before the ack arrives. */
export function syncHeld() { return formatMode; }

/* Send any debounced push right now (used before entering Formats so the
 * queued state is the pre-Formats one, never a mix). */
export function syncFlushPending() {
  if (!syncPushTimer) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  syncPushNow();
}

/* Called by saveToLocal() on every save (mutations + 2s autosave). */
export function syncOnLocalSave(state) {
  if (syncApplying) return;
  const fp = syncFingerprint(state);
  if (fp === syncLastSeenFp) return;          // nothing meaningful changed
  syncLastSeenFp = fp;
  /* Init-time saves (load normalisation, rollovers, the first autosave)
   * are not user edits: they must not bump editAt, or every app launch
   * would look like "fresh local edits" and win the reconcile. */
  if (syncBooting) return;
  /* A delivered digest merging in is not a user edit either: if it bumped
   * editAt, a phone opened in the morning would merge the digest, look
   * "freshly edited", and win the reconcile over real edits made elsewhere. */
  if (!syncQuietSave) {
    const meta = syncLoadMeta();
    meta.editAt = Date.now();
    syncSaveMeta(meta);
  }
  if (syncHeld()) return;                     // Formats open — Done will push
  if (syncUser && syncRef) syncSchedulePush();
}

function syncSchedulePush() {
  if (syncPendingRemote || syncHeld()) return; // don't touch the cloud until the user chooses / finishes
  if (!syncReconciled) return;                 // first cloud value not seen yet — reconcile will push if needed
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(syncPushNow, 1200);
}

function syncPushNow(opts) {
  const priority = !!(opts && opts.priority);
  if (!syncUser || !syncRef || syncPendingRemote) return false;
  if (syncTypingValue) return false;           // another device's change is waiting to be merged in: don't write over it
  if (!syncReconciled) return false;          // never write blind over an unseen cloud copy
  if (syncLoading) return false;              // a kept copy is being read back to merge the cloud's with: then
  if (syncHeld() && !priority) return false;  // Formats open — only Done may push
  /* One push at a time: a second one started now would see the first one's
   * copy, not yet the cloud's, and give up. It goes once the first is done. */
  if (syncPushing && !priority) { syncPushAgain = true; return false; }
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  const state = gatherState();
  const fp = syncFingerprint(state);
  const over = !!syncOverStale && syncOverStale === syncCloudSeen;   // an older copy took the cloud's place: this one goes back over it
  if (fp === syncKnownFp && !over) return false;   // cloud already has this
  const fresh = !!(opts && opts.fresh);         // Export: this copy replaces the cloud's, built on nothing
  const meta = syncLoadMeta();
  const mark = syncKnownFp === null ? syncMarkOf(state) : null;
  const seq = fresh ? Math.max(syncTopSeq, syncCloudSeq) : syncTopSeq;
  const content = { ...state };
  delete content.syncLocal;                     // where this device's copy stands is its own
  const rev = syncNewRev();
  const baseHash = fresh ? null : (syncKnownFp !== null ? syncHash(syncKnownFp) : mark ? mark.hash : (meta.knownHash || null));
  const payload = {
    state: JSON.stringify({ ...content, syncRev: rev,
      syncBase: fresh ? null : (syncKnownFp !== null ? syncKnownRev : mark ? mark.rev : (meta.knownRev || null)),
      syncBaseHash: baseHash, syncSeq: seq + 1, syncBaseSeq: seq,
      syncLog: [...(fresh ? [] : syncKnownLog), rev].slice(-SYNC_LOG_MAX) }),
    updatedAt: Date.now(),
    client: syncClientId,
  };
  /* Kept until it is heard back about: if this device goes offline or is closed
   * before the answer, a later copy built on it says it arrived (syncTakeSent). */
  const sent = { rev, hash: syncHash(fp), seq: seq + 1, state: payload.state, base: baseHash,
    baseRev: fresh ? null : (syncKnownFp !== null ? syncKnownRev : mark ? mark.rev : (meta.knownRev || null)), at: Date.now() };
  syncSent = sent;
  syncSentSave([...syncSentList(), sent]);
  if (priority) syncCommitPending = Math.max(1, syncCommitPending);   // open (or keep) the priority window
  syncPushing = true;
  syncWrite(payload, priority)
    .then(written => {
      const mine = syncSent === sent;         // (else a later copy built on it was taken in already)
      syncForgetSent(sent);
      if (!written || !mine) return;          // the cloud moved on: the listener brings that copy to merge with, then this pushes again
      syncCloudSeen = syncHash(fp);
      syncCloudSeq = seq + 1;
      syncOverStale = null;
      syncAgree(fp, { pushedAt: Date.now() }, payload.state, syncClientId);
      syncCommitPending = 0;                  // server has it — priority window closes
      syncUpdateUI();
    })
    .catch(err => {
      syncForgetSent(sent);                   // (not written)
      syncCommitPending = 0;
      /* permission errors are the database rules; anything else (another write
       * to the account cut in, the database gave up on a busy node): again soon */
      if (err && /permission/i.test(String(err.message || err.code || ''))) syncRecordAuthError(err, 'database write');
      else syncPushAgain = true;
    })
    .then(() => {
      syncPushing = false;
      if (syncPushAgain) { syncPushAgain = false; if (syncUser && syncRef) syncSchedulePush(); }
    });
  return true;
}

/* The pushes sent and not heard back about yet, with the state each sent: this
 * tab's (syncSent), and any another tab of Focus sent before it closed, or this
 * device before it restarted (kept in localStorage, a few at most). */
const SYNC_SENT_MAX = 3;
function syncSentList() {
  try {
    const v = JSON.parse(localStorage.getItem(SYNC_SENT_LS_KEY));
    return (Array.isArray(v) ? v : v ? [v] : []).filter(x => x && typeof x.rev === 'string' && typeof x.state === 'string');
  } catch(e) { return []; }
}
function syncSentSave(list) {
  for (let l = list.slice(-SYNC_SENT_MAX); ; l = l.slice(1)) {
    try {
      if (l.length) localStorage.setItem(SYNC_SENT_LS_KEY, JSON.stringify(l)); else localStorage.removeItem(SYNC_SENT_LS_KEY);
      return;
    } catch(e) { if (!l.length) return; }       // storage full: fewer of them
  }
}
function syncForgetSent(sent) {
  if (syncSent === sent) syncSent = null;
  const list = syncSentList();
  if (list.some(x => x.rev === sent.rev)) syncSentSave(list.filter(x => x.rev !== sent.rev));
}
/* A push may have reached the cloud without the device hearing back (it went
 * offline, or was closed, right after sending). When the cloud's copy is that
 * push or comes after it (its revision is in syncLog), and the push was built on
 * the copy this device's copy is built on, the push is what it is built on now:
 * taken as agreed, so what was changed here after it (unchecking what it
 * checked, deleting what it added) counts as a change, not as no change. A push
 * is done with once the cloud's copy comes after it, or after the copy it was
 * built on without it (another took its place); not before: a copy older than
 * it, heard first, says nothing about it. */
function syncTakeSent(remote, local) {
  const list = syncSentList();
  if (syncSent && !list.some(x => x.rev === syncSent.rev)) list.push(syncSent);   // (not saved: storage full)
  if (!list.length) return;
  const mark = syncKnownFp === null ? syncMarkOf(local) : null;
  const known = syncKnownFp !== null ? syncHash(syncKnownFp) : mark ? mark.hash : null;
  const log = syncLogOf(remote);
  const after = x => remote.syncRev === x.rev || log.includes(x.rev);
  const passed = x => !!x.baseRev && remote.syncRev !== x.baseRev && log.includes(x.baseRev);
  const hit = list.filter(x => after(x) && x.base === known).sort((a, b) => a.seq - b.seq).pop();
  if (hit) {
    try { syncAgree(syncFingerprint(JSON.parse(hit.state)), { pushedAt: Date.now() }, hit.state, syncClientId); } catch(e) {}
  }
  const left = list.filter(x => !after(x) && !passed(x) && Date.now() - (Number(x.at) || 0) < 7 * 864e5);
  if (left.length === list.length) return;
  if (syncSent && !left.includes(syncSent)) syncSent = null;
  syncSentSave(left);
}

/* Write this device's state over the cloud's, but only over the copy it last
 * saw. A device waking up (a phone opened from the background) can save before
 * it has heard what another device saved meanwhile, and a plain write would put
 * its older copy over that. So the write is a transaction on users/<uid>: if the
 * cloud's state is no longer the one this device last saw, nothing is written,
 * and the listener brings the newer copy to merge with. The whole node goes in
 * one transaction, so the state and `client` (which tells an echo) change
 * together, and the rest of it (bank, digestInbox, …) is written back as the
 * database has it at that moment. `force` (Formats' Done, which must win) writes
 * the three fields with update() instead. Resolves to whether it was written. */
function syncWrite(payload, force) {
  if (force) return syncRef.update(payload).then(() => true);
  const seen = syncCloudSeen;
  return syncRef.transaction(node => {
    if (node === null) return { ...payload };                  // not cached here: the database checks it against what it has
    const cur = typeof node.state === 'string' ? node.state : null;
    if (cur !== null && cur !== payload.state && syncStateHash(cur) !== seen) return;   // moved on since: write nothing
    return { ...node, ...payload };
  }, undefined, false).then(r => !!(r && r.committed));
}
function syncStateHash(stateStr) {
  try { return syncHash(syncFingerprint(JSON.parse(stateStr))); } catch(e) { return null; }
}

/* Done was clicked: release the hold and push the committed template with
 * priority. A copy another device saved while Formats was open is merged in
 * first (the format wins where both changed the same thing), so its changes
 * stay. Returns true if it had to be replaced instead (this device no longer
 * has the copy both started from; it is kept to restore). */
export function syncCommitFormat() {
  const deferred = syncDeferredRemote;
  syncDeferredRemote = null;
  if (deferred && syncUser && syncRef && !syncPendingRemote) {
    /* taken in as if it came now (an older copy is caught the same way) */
    if (syncReconcileRemote({ state: deferred.state, updatedAt: deferred.updatedAt, client: deferred.client }, { doneWins: true })) {
      syncUpdateUI();
      return false;
    }
    syncKeepCopy('older', deferred.state, deferred.client);
  }
  syncPushNow({ priority: true });
  syncUpdateUI();
  return !!deferred;
}

/* Apply a remote state through the standard load path, then let the
 * normal save machinery detect any follow-up local diff (e.g. a budget
 * rollover triggered by the incoming state) and push it back. `mergedStr`
 * is what to load instead when this device's own changes were merged in
 * (syncMergeRemote): the remote is still what both sides now agree on, and
 * the merged difference is pushed as the follow-up. */
let syncApplyTimes = [];        // recent applies this device had to answer, for bounce detection
let syncBouncing   = false;     // true once we've decided another device is fighting us
const SYNC_BOUNCE_N  = 4;       // answers …
const SYNC_BOUNCE_MS = 90000;   // … within this window = a loop, not a person editing

function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr, by, agreedStr) {
  let remoteFp = null;
  /* A cloud copy written by an older build cannot carry fields it never knew
   * about (digest, suggested tasks, …). Missing there does not mean "the user
   * removed it" — so keep this device's copy of any top-level field the
   * remote lacks, instead of letting the old build silently erase it. */
  let effective = mergedStr || remoteStr;
  if (!mergedStr) {
    try {
      const remote = JSON.parse(remoteStr);
      if (remote && typeof remote === 'object' && (Number(remote.build) || 1) < STATE_BUILD) {
        const local = gatherState();
        let patched = false;
        Object.keys(local).forEach(k => { if (!(k in remote)) { remote[k] = local[k]; patched = true; } });
        remote.build = STATE_BUILD;
        if (patched) effective = JSON.stringify(remote);
      }
    } catch(e) {}
  }
  syncApplying = true;
  try {
    if (!loadStateString(effective)) return;  // corrupt payload — keep local (saved below, like any change: saveToLocal)
    keepField(renderLoadedState);             // a cursor left in a field stays, with what was typed
    try { remoteFp = syncFingerprint(JSON.parse(agreedStr || remoteStr)); } catch(e) {}
  } finally {
    if (remoteFp) { syncLastSeenFp = remoteFp; syncAgree(remoteFp, { editAt: remoteUpdatedAt || Date.now() }, agreedStr || remoteStr, by); }
    else syncLastSyncAt = Date.now();
    syncApplying = false;
  }
  /* A loop is two devices each answering what the other just sent: an apply
   * after which this device has to push something back (the other copy lacks
   * what an older build strips). Changes made on the other device need no
   * answer, however many there are, and a merge answers once and then agrees,
   * so neither counts. */
  const now = Date.now();
  syncApplyTimes = syncApplyTimes.filter(t => now - t < SYNC_BOUNCE_MS);
  const answer = !mergedStr && !!remoteFp && syncFingerprint(gatherState()) !== remoteFp;
  if (answer) syncApplyTimes.push(now);
  const bouncing = answer && syncApplyTimes.length >= SYNC_BOUNCE_N;
  if (bouncing && !syncBouncing) {
    syncBouncing = true;
    console.warn('[sync] remote applies are bouncing — another device is probably running an older Worky build');
    showToast('Sync keeps bouncing — update Worky on your other devices (close and reopen the app there).');
  } else if (!bouncing) {
    if (syncBouncing) syncBouncing = false;
    showToast(mergedStr ? 'Synced from cloud, with your changes kept ✓' : 'Synced from cloud ✓');
  }
  syncUpdateUI();
  /* Persist any follow-up diff (rollover, or fields we protected above).
   * Normally that diff is pushed back so the cloud converges. While bouncing
   * the push is the fuel for the loop, so keep the diff local and let the
   * user's next real edit carry it — without the other device updating,
   * nothing we push would stick anyway. */
  if (bouncing) {
    syncApplying = true;
    try { saveToLocal(); syncLastSeenFp = syncFingerprint(gatherState()); } finally { syncApplying = false; }
  } else {
    saveToLocal();
  }
}

/* Realtime listener — also performs the initial reconcile on connect.
 * The state blob settles FIRST; only then is the delivered digest checked
 * against whatever state won. That order matters twice over: a cloud copy
 * that already carries the digest makes the merge a no-op, and a stale copy
 * that won the reconcile (and so dropped the digest) gets it merged back in. */
let syncCopiesReady = true;     // the kept copies are loaded (once sync starts, the first cloud copy waits for them)
let syncCopiesWaiting = null;   // … the cloud copy that came first
function syncOnRemoteValue(snap) {
  if (!syncCopiesReady) { syncCopiesWaiting = snap; return; }
  if (syncLoading) { syncLoadingValue = snap.val(); return; }
  const v = snap.val();
  if (!syncLeader) {                          // another tab of Focus syncs the state (syncLead): just what sits beside it
    syncLastValue = v;
    digestInboxLatest = (v && v.digestInbox) || null;
    digestPromptsSeen(v ? v.digestPrompts : null);
    digestGithubSeen(v ? v.digestGithub : null);
    bankCloudSeen(v ? v.bank : null);
    return;
  }
  if (userTyping() && syncForeignChange(v)) { syncTypingValue = v; syncTypingLater(); return; }
  syncTypingValue = null;
  digestInboxLatest = (v && v.digestInbox) || null;
  syncReconcileRemote(v);
  digestInboxSeen(digestInboxLatest);         // backend-delivered digest, if any
  digestPromptsSeen(v ? v.digestPrompts : null);   // prompt edits (Settings → Email Digest)
  digestGithubSeen(v ? v.digestGithub : null);     // the Run now token (Settings → Email Digest)
  bankCloudSeen(v ? v.bank : null);                // bank connections (Settings → Bank accounts)
}
/* While someone types (util.js → userTyping), a change from another device
 * waits: applying it redraws the screen under the cursor. The latest one is
 * kept and taken in, merged with what was typed, as soon as the typing pauses
 * or the field is left; meanwhile this device doesn't push either, so it can't
 * write over it. */
let syncTypingValue = null;
let syncTypingTimer = null;
function syncForeignChange(v) {
  if (!v || typeof v.state !== 'string' || v.client === syncClientId) return false;
  try { return syncFingerprint(JSON.parse(v.state)) !== syncFingerprint(gatherState()); } catch(e) { return false; }
}
function syncTypingLater() {
  clearTimeout(syncTypingTimer);
  syncTypingTimer = setTimeout(syncTypingDone, typingPauseIn() + 50);
}
function syncTypingDone() {
  if (!syncTypingValue || !syncRef) return;
  if (userTyping()) { syncTypingLater(); return; }
  clearTimeout(syncTypingTimer);
  const v = syncTypingValue;
  syncTypingValue = null;
  syncOnRemoteValue({ val: () => v });
}

/* Both this device and the cloud changed since the copy they last agreed on:
 * the state with both sets of changes, or null without that copy (`baseCopy`: an
 * earlier one to merge from instead). */
function syncMergeRemote(remoteStr, knownHash, preferLocal, baseCopy) {
  const base = baseCopy || syncBaseCopy(knownHash);
  if (!base) return null;
  try {
    const remote = JSON.parse(remoteStr);
    if (!remote || typeof remote !== 'object') return null;
    /* fields an older build's copy lacks were not deleted there: it never knew them */
    if ((Number(remote.build) || 1) < STATE_BUILD) Object.keys(base).forEach(k => { if (!(k in remote)) remote[k] = base[k]; });
    return JSON.stringify(syncMerge(base, gatherState(), remote, { preferLocal }));
  } catch(e) { return null; }
}

/* A cloud copy, taken in. `doneWins`: it waited while Formats was open, and
 * Done is now taking it in (see syncCommitFormat): returns false instead of
 * taking it as it is, when it can't be merged. */
function syncReconcileRemote(v, { doneWins = false } = {}) {
  const local = gatherState();
  const localFp = syncFingerprint(local);
  const connected = syncReconciled;           // this connection had seen the cloud before this copy
  syncReconciled = true;                      // from here on pushes are allowed
  syncCloudSeen = v && typeof v.state === 'string' ? syncStateHash(v.state) : null;
  syncCloudSeq = v && typeof v.state === 'string' ? syncStampsOf(v.state).seq : 0;
  if (syncOverStale && syncOverStale !== syncCloudSeen) syncOverStale = null;   // that older copy is no longer the cloud's
  if (!connected) {                           // what the copy on this device takes in
    const mark = syncMarkOf(local);
    syncTopSeq = mark ? mark.seq : 0;
    syncKnownLog = mark ? syncLogOf(local) : [];
  }

  if (syncPendingRemote) {                    // choice not made yet — just keep the stash fresh
    if (v && typeof v.state === 'string' && v.client !== syncClientId) {
      syncPendingRemote = { state: v.state, updatedAt: v.updatedAt || 0, client: v.client };
      syncRenderChoiceInfo();
    }
    return;
  }

  if (!v || typeof v.state !== 'string') {    // no cloud copy yet → seed it
    syncKnownFp = null;
    syncPushNow();
    return;
  }
  if (v.client === syncClientId) {            // echo of our own write
    try { syncAgree(syncFingerprint(JSON.parse(v.state)), undefined, v.state, v.client); } catch(e) {}
    syncUpdateUI();
    return;
  }
  let remote = null, remoteFp = null;
  try { remote = JSON.parse(v.state); remoteFp = syncFingerprint(remote); } catch(e) { return; }
  syncTakeSent(remote, local);
  if (connected && (Number(remote.build) || 1) < STATE_BUILD) syncOlderDevice();
  if (syncHeld()) {                           // Formats open — stash, never apply
    if (remoteFp !== localFp) {
      syncDeferredRemote = { state: v.state, updatedAt: v.updatedAt || 0, client: v.client };
      syncUpdateUI();
    }
    return;
  }
  if (syncCommitPending) {                    // a Done push is in flight — it wins the race
    if (remoteFp !== localFp && syncCommitPending <= SYNC_COMMIT_MAX_REPUSH) {
      syncCommitPending++;
      syncPushNow({ priority: true });
      return;
    }
  }
  if (remoteFp === localFp) {                 // already identical
    syncLastSeenFp = remoteFp;
    syncAgree(remoteFp, undefined, v.state, v.client);
    syncUpdateUI();
    return true;
  }
  /* Divergence. If this is a fresh connection with no agreed baseline —
   * right after an explicit sign-in, or after local storage was wiped —
   * NEVER guess: a brand-new device's empty defaults would look like
   * "recent edits" and clobber the cloud. Ask the user instead. */
  const meta = syncLoadMeta();
  const noBaseline = syncKnownFp === null && (syncJustSignedIn || !meta.pushedAt);
  if (noBaseline) {
    syncJustSignedIn = false;
    syncPendingRemote = { state: v.state, updatedAt: v.updatedAt || 0, client: v.client };
    clearTimeout(syncPushTimer);
    syncOpenChoiceModal();
    syncUpdateUI();
    return true;
  }
  /* Established baseline: the copy this device's copy is built on. Mid-session
   * that is syncKnownFp. On a fresh connection, the saved copy says which one it
   * is built on (syncLocal): a copy saved before a newer one came in (storage
   * full, a second tab of Focus) is that older copy plus its own changes, not
   * new changes over the newest (the device's last agreement, meta.knownHash,
   * is the fallback for a copy saved by an older version). Then:
   *   • only the cloud moved → apply it (the common "other device
   *     edited while this one was closed" case)
   *   • only this device moved → push it (offline edits)
   *   • both moved → merge the two against that copy; without it, the
   *     cloud's copy is taken and this device's kept to restore */
  const mark = syncKnownFp === null ? syncMarkOf(local) : null;
  const knownHash = syncKnownFp !== null ? syncHash(syncKnownFp) : mark ? mark.hash : (meta.knownHash || null);
  const localDirty  = knownHash ? syncHash(localFp)  !== knownHash : true;
  const remoteDirty = knownHash ? syncHash(remoteFp) !== knownHash : true;
  const preferLocal = doneWins || (meta.editAt || 0) > (v.updatedAt || 0);
  /* a copy the one this device has comes after (an older one delivered late, as a
   * phone back from the background gets what it missed in order): nothing in it
   * is new here, and merging it again would bring back what was since deleted */
  if (remoteDirty && syncHadIt(remote)) {
    syncOverStale = syncCloudSeen;            // (if the cloud really holds it now, this device's goes back over it)
    syncSchedulePush();
    return true;
  }
  if (remoteDirty) {
    /* built on an older copy than this device has: applying it as it is would
     * undo what came after, so its changes go on top of this device's instead … */
    const base = syncBuiltOn(remote, knownHash, v.client);
    if (base && base.hash !== knownHash) {
      const state = typeof base.state === 'string' ? base.state : syncLoaded.get(base.id);
      if (state === undefined) { syncLoadCopy(base.id, v); return true; }   // read back from the database first
      if (state && syncOnTop(state, v, remote, remoteFp, local, knownHash)) return true;
    }
    if (!(base && base.hash === knownHash) && syncIsStale(remote)) {
      /* … from the nearest copy before it this device kept, when it no longer has
       * that one (read back from the database first, if need be) … */
      const before = syncAncestor(remote);
      const state = before ? (typeof before.state === 'string' ? before.state : syncLoaded.get(before.id)) : null;
      if (before && state === undefined) { syncLoadCopy(before.id, v); return true; }
      if (state && syncOnTop(state, v, remote, remoteFp, local, knownHash)) return true;
      /* … and with no copy from before it at all, what this device has stays */
      syncKeepOurs(v);
      return true;
    }
  }
  if (!localDirty) {
    syncApplyRemote(v.state, v.updatedAt, undefined, v.client);
  } else if (!remoteDirty) {
    /* the cloud has what this device last agreed on, under its own revision (another
     * device sent the same): taken as agreed, so this push comes after it */
    syncAgree(remoteFp, undefined, v.state, v.client);
    syncPushNow();
  } else {
    let merged = syncMergeRemote(v.state, knownHash, preferLocal);
    if (!merged && !doneWins) {
      /* without the copy both started from, the nearest one before it this device kept will do (read back first, if need be) */
      const before = syncAncestorAt(syncTopSeq);
      const state = before ? (typeof before.state === 'string' ? before.state : syncLoaded.get(before.id)) : null;
      if (before && state === undefined) { syncLoadCopy(before.id, v); return true; }
      try { if (state) merged = syncMergeRemote(v.state, null, preferLocal, JSON.parse(state)); } catch(e) {}
    }
    if (merged) syncApplyRemote(v.state, v.updatedAt, merged, v.client);
    else if (doneWins) return false;
    else {
      syncKeepCopy('local', JSON.stringify(local));
      syncApplyRemote(v.state, v.updatedAt, undefined, v.client);
      showToast('Synced from cloud ✓ · this device\'s own copy is kept in Settings → Cloud sync → Earlier copies');
    }
  }
  return true;
}

/* A cloud copy built on `baseStr`, an older copy than this device's: its changes,
 * put on top of what this device has. What the cloud's copy should have been
 * (the copy this device last agreed on, with the writer's changes on top) is
 * what this device and the cloud agree on now, not the older copy (every device
 * up to date works it out the same), so a later merge doesn't take what that
 * copy lacked for new changes here; it goes over the older copy even with
 * nothing new here. */
function syncOnTop(baseStr, v, remote, remoteFp, local, knownHash) {
  const rebased = syncRebase(baseStr, remote, local);
  if (!rebased) return false;
  const known = syncBaseCopy(knownHash);
  const fixed = known ? syncRebase(baseStr, remote, known) : null;
  const agreed = fixed ? JSON.stringify({ ...fixed, build: STATE_BUILD, syncRev: null, syncBase: null, syncBaseHash: null,
    syncSeq: syncTopSeq, syncBaseSeq: null, syncLog: syncKnownLog }) : undefined;
  if (agreed) {                               // the writer's own copy stays findable: its next one is built on it
    const st = syncStampsOf(v.state);
    copiesKeep({ kind: 'agreed', rev: st.rev, seq: st.seq, build: st.build, hash: syncHash(remoteFp), by: v.client || null, state: v.state });
  }
  syncApplyRemote(v.state, v.updatedAt, JSON.stringify(rebased), v.client, agreed);
  if (agreed) { syncOverStale = syncCloudSeen; syncSchedulePush(); }
  return true;
}
/* The nearest copy before a cloud copy's own starting point that this device
 * kept: agreed, written by a version that numbers its copies, numbered below the
 * one it was built on (one numbered the same, that isn't it, went another way).
 * What changed between the two is on both sides alike. */
function syncAncestor(remote) { return syncAncestorAt(syncBaseSeqOf(remote)); }
function syncAncestorAt(seq) {
  if (!(seq > 1)) return null;
  let best = null;
  copiesIndex().forEach(e => {
    if (e.kind !== 'agreed' || !e.canon || !((Number(e.build) || 0) >= SYNC_SEQ_BUILD) || !(e.seq < seq)) return;
    if (!best || e.seq > best.seq || (e.seq === best.seq && e.at > best.at)) best = e;
  });
  return best;
}
/* A kept copy read back from the database for a merge; meanwhile cloud copies
 * wait (the newest is taken in after it), and so do pushes. */
const syncLoaded = new Map();     // id → its state, or null when it couldn't be read
let syncLoading = false;
let syncLoadingValue = null;
function syncLoadCopy(id, v) {
  syncLoading = true;
  syncLoadingValue = v;
  copiesState(id).then(state => state, () => null).then(state => {
    syncLoaded.set(id, typeof state === 'string' ? state : null);
    if (syncLoaded.size > 4) syncLoaded.delete(syncLoaded.keys().next().value);
    syncLoading = false;
    const next = syncLoadingValue;
    syncLoadingValue = null;
    if (next && syncRef) { syncOnRemoteValue({ val: () => next }); syncSchedulePush(); }
  });
}

/* A copy built on an older one than this device has, without that one here to
 * tell its changes apart: what this device has stays, and goes back to the
 * cloud. The older copy is kept, to restore if it had something. */
function syncKeepOurs(v) {
  syncKeepCopy('older', v.state, v.client);
  syncOverStale = syncCloudSeen;
  console.warn('[sync] an older copy came in from another device; keeping this one');
  showToast('Kept this device\'s copy: another device sent an older one (it is in Settings → Cloud sync → Earlier copies)');
  syncPushNow();
  syncUpdateUI();
}

function syncStart() {
  if (!syncUser || !syncConfigured()) return;
  syncLead();
  syncRef = firebase.database().ref('users/' + syncUser.uid);
  syncRef.on('value', syncOnRemoteValue);
}

/* ── One tab per browser ──
 * Tabs of Focus in one browser share its saved state (persistence.js takes each
 * one's saves into the others). If each also synced with the cloud on its own,
 * each would count the other's changes as its own: sent twice, renumbered
 * twice, and an undo in one could lose to a copy the other sent. So one tab at a
 * time syncs the state with the cloud: it holds a browser lock while it is open,
 * and when it closes the next tab takes over, from the last copy it heard. The
 * others send their changes, and get the cloud's, through the saved state.
 * Without locks (an older browser), every tab syncs. */
let syncLeader = !(typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function');
let syncLeaderAsked = false;
let syncLastValue;              // the cloud copy last heard while another tab synced
function syncLead() {
  if (syncLeader || syncLeaderAsked) return;
  syncLeaderAsked = true;
  try {
    navigator.locks.request('focus-cloud-sync', () => new Promise(() => {   // held until this page closes
      copiesRefresh().catch(() => {}).then(() => {          // with the copies the other tab kept meanwhile
        takeInOtherTab();                                   // and what it saved last, before the cloud's copy is merged
        syncLeader = true;
        syncUpdateUI();
        if (syncRef && syncLastValue !== undefined) { const v = syncLastValue; syncLastValue = undefined; syncOnRemoteValue({ val: () => v }); }
      });
    })).catch(() => { syncLeader = true; });
  } catch(e) { syncLeader = true; }
}
function syncStop() {
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  if (syncRef) { syncRef.off(); syncRef = null; }
  syncKnownFp = null;
  syncReconciled = false;
  syncCloudSeen = null;
  syncCloudSeq = 0;
  syncOverStale = null;
  syncSent = null;                              // (the saved one is checked against the next cloud copy)
  syncLastValue = undefined;
  syncLoading = false;
  syncLoadingValue = null;
  syncCopiesWaiting = null;
  syncPushing = false;
  syncPushAgain = false;
  syncPendingRemote = null;
  syncDeferredRemote = null;
  syncCommitPending = 0;
  syncTypingValue = null;
  clearTimeout(syncTypingTimer);
  digestInboxLatest = null;
  setDigestInboxPending(null);
  setDigestPromptsSaved(undefined);             // they belong to the account that just left
  setDigestPromptDirty(false);
  digestGithubForget();                         // and so does the Run now token
  bankCloudForget();                            // and its bank connections, unless it's the same account again
  $('syncChoiceModal')?.classList.remove('show');
}

/* A copy written by an older version of Focus arrived while connected: that
 * device keeps writing without looking at the cloud first, so a change made
 * there while it was offline can arrive late. Say so, once a session. */
function syncOlderDevice() {
  if (syncOlderSeen) return;
  syncOlderSeen = true;
  console.warn('[sync] a device on an older version of Focus wrote to the cloud');
  showToast('A device on an older Focus is syncing: fully close and reopen Focus there');
  syncUpdateUI();
}

/* ── Import/Export choice (shown when sign-in finds divergent data) ── */
function syncRenderChoiceInfo() {
  const info = $('syncChoiceInfo');
  if (!info || !syncPendingRemote) return;
  const when = syncPendingRemote.updatedAt
    ? new Date(syncPendingRemote.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'unknown time';
  info.textContent = `This device's data differs from your cloud copy (last updated ${when}). Which one should Focus keep?`;
}
function syncOpenChoiceModal() {
  syncRenderChoiceInfo();
  if ($('tourWelcomeModal')?.classList.contains('show')) {   // sync choice first, tour after
    closeModal('tourWelcomeModal');
    setTourReoffer(true);
  }
  $('syncChoiceModal')?.classList.add('show');
}
export function syncChooseImport() {
  const pending = syncPendingRemote;
  syncPendingRemote = null;
  $('syncChoiceModal')?.classList.remove('show');
  if (pending) {
    syncKeepCopy('local', JSON.stringify(gatherState()));   // what this device had, to restore
    syncApplyRemote(pending.state, pending.updatedAt, undefined, pending.client);
  }
  digestInboxSeen(digestInboxLatest);          // the imported copy may predate the delivered digest
  syncUpdateUI();
  if (tourReoffer) { setTourReoffer(false); tourMarkSeen(); }   // cloud data → returning user
}
export function syncChooseExport() {
  syncPendingRemote = null;
  $('syncChoiceModal')?.classList.remove('show');
  digestInboxSeen(digestInboxLatest);          // this device's copy may predate the delivered digest
  syncPushNow({ fresh: true });
  showToast('Exported to cloud ✓');
  syncUpdateUI();
  if (tourReoffer) tourOffer();
}

/* ── Earlier copies (Settings → Cloud sync) ──
 * Every copy of the state this device kept (synccopies.js), newest first, to put
 * one back: it replaces what Focus has here and goes to the other devices like
 * any change, and what was there before is kept in the list too. */
const SYNC_COPY_KINDS = {
  agreed: 'Synced', local: 'This device, not synced', older: 'Older copy from another device', restore: 'Before a restore',
};
function syncCopyWhen(at) {
  const d = new Date(at), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(now) - day(d)) / 864e5);
  if (ago === 0) return `Today, ${time}`;
  if (ago === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}
function syncCopyWhat(sum) {
  if (!sum) return '';
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n * 100) / 100).toFixed(2);
  return [`${sum.tasks} task${sum.tasks === 1 ? '' : 's'} (${sum.done} done)`,
    sum.events ? `${sum.events} event${sum.events === 1 ? '' : 's'}` : '',
    sum.purchases ? `${sum.purchases} purchase${sum.purchases === 1 ? '' : 's'}` : '',
    `balance ${money(sum.balance)}`].filter(Boolean).join(' · ');
}
export async function syncCopiesOpen() {
  const list = $('syncCopiesList');
  if (!list) return;
  $('syncCopiesModal').classList.add('show');
  const now = $('syncCopiesNow');
  if (now) now.textContent = 'Now: ' + syncCopyWhat(copySummaryOf(JSON.stringify(gatherState())));
  list.textContent = 'Loading…';
  await copiesStart();                          // (with sync off, nothing loaded them yet)
  const copies = await copiesList();
  list.textContent = '';
  if (!copies.length) { list.textContent = 'No copies on this device yet.'; return; }
  copies.forEach(e => {
    const row = document.createElement('div');
    row.className = 'gcal-cal-row sync-copy-row';
    const text = document.createElement('div');
    text.className = 'sync-copy-text';
    const when = document.createElement('div');
    when.className = 'sync-copy-when';
    when.textContent = `${syncCopyWhen(e.at)} · ${SYNC_COPY_KINDS[e.kind] || 'Copy'}`;
    const what = document.createElement('div');
    what.className = 'sync-copy-what';
    what.textContent = syncCopyWhat(e.summary);
    text.append(when, what);
    const btn = document.createElement('button');
    btn.className = 'sync-copy-restore';
    btn.textContent = 'Restore';
    btn.addEventListener('click', () => syncRestoreCopy(e.id));
    row.append(text, btn);
    list.appendChild(row);
  });
}
export async function syncRestoreCopy(id) {
  if (syncHeld()) { showToast('Close Formats (Done) first.'); return false; }
  if (syncPendingRemote) { showToast('Choose Import or Export for cloud sync first.'); return false; }
  const entry = (await copiesList()).find(e => e.id === id);
  const stateStr = entry ? await copiesState(id) : null;
  let st = null;
  try { st = JSON.parse(stateStr); } catch(e) {}
  if (!entry || !st || st.version !== 1) { showToast('That copy is no longer on this device.'); return false; }
  const when = syncCopyWhen(entry.at);
  if (!confirm(`Put back the copy from ${when}? It replaces what Focus has now, here and on your other devices. What you have now stays in Earlier copies.`)) return false;
  syncKeepCopy('restore', JSON.stringify(gatherState()));
  restoreState(st);
  digestInboxSeen(digestInboxLatest);           // a digest delivered since that copy still lands
  copiesSave();
  closeModal('syncCopiesModal');
  showToast(`Restored the copy from ${when} ✓`);
  return true;
}

/* ── Sign-in flow ── */
function syncConnect() {
  const params = new URLSearchParams({
    client_id:     GCAL_CLIENT_ID,
    redirect_uri:  GCAL_REDIRECT,
    response_type: 'token',
    scope:         'openid email profile',
    prompt:        'select_account',
    state:         SYNC_STATE_TAG,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function syncHandleRedirect() {
  const hash = window.location.hash.slice(1);
  if (!hash.includes('access_token')) return;
  const params = new URLSearchParams(hash);
  if (params.get('state') !== SYNC_STATE_TAG) return;   // gcal redirect — not ours
  const token = params.get('access_token');
  history.replaceState(null, '', window.location.pathname);
  if (!token || !syncConfigured()) return;
  syncJustSignedIn = true;
  const cred = firebase.auth.GoogleAuthProvider.credential(null, token);
  firebase.auth().signInWithCredential(cred)
    .then(() => showToast('Cloud sync connected ✓'))
    .catch(err => {
      console.warn('Sync sign-in failed:', err);
      showToast('Sync sign-in failed — check Firebase setup.');
    });
}

function syncSignOut() {
  if (!confirm('Sign out of cloud sync? Data stays on this device and in the cloud.')) return;
  syncManualSignOut = true;
  firebase.auth().signOut();
}

/* ── Settings UI ── */
export function syncUpdateUI() {
  digestRenderSettings();                      // its "receives digests as …" line follows sign-in state
  const line = $('syncStatusLine');
  const btn  = $('syncConnectBtn');
  if (!line || !btn) return;
  if (!syncConfigured()) {
    line.textContent = window.firebase
      ? 'Not configured — paste your Firebase config into js/config.js.'
      : 'Sync unavailable (Firebase failed to load).';
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  if (syncUser && syncPendingRemote) {
    line.textContent = 'Sync paused — choose whether to import or export.';
    btn.textContent = 'Choose…';
    return;
  }
  if (syncUser && syncHeld()) {
    line.textContent = syncDeferredRemote
      ? 'Formats open — cloud sync paused until Done (a change from another device is waiting and will be replaced).'
      : 'Formats open — cloud sync paused until Done.';
    btn.textContent = 'Sign out';
    return;
  }
  if (syncUser) {
    const when = syncLastSyncAt
      ? ` · last sync ${new Date(syncLastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : '';
    line.textContent = !syncLeader
      ? `Syncing as ${syncUser.email || 'Google account'}, through the other tab of Focus open in this browser`
      : syncBouncing
      ? `Syncing as ${syncUser.email || 'Google account'}${when} — changes keep bouncing with another device. It is probably running an older version of Worky: fully close and reopen the app there.`
      : syncOlderSeen
        ? `Syncing as ${syncUser.email || 'Google account'}${when} — another device is on an older version of Focus. Fully close and reopen Focus there (on a phone, swipe it away), so a change it makes offline can't arrive late over newer ones.`
        : `Syncing as ${syncUser.email || 'Google account'}${when}`;
    btn.textContent = 'Sign out';
  } else {
    const meta = syncLoadMeta();
    if (meta.outAt || meta.authErr) {
      const when = new Date((meta.authErr && meta.authErr.at) || meta.outAt);
      const stamp = when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const why = meta.authErr
        ? (meta.authErr.code || meta.authErr.msg)
        : 'no error captured — likely a silent token-refresh failure';
      line.textContent = `Signed out unexpectedly (${stamp}): ${why}`;
    } else {
      line.textContent = 'Not signed in.';
    }
    btn.textContent = 'Sign in with Google';
  }
}

export function syncBtnClick() {
  if (!syncConfigured()) return;
  if (syncUser && syncPendingRemote) syncOpenChoiceModal();
  else if (syncUser) syncSignOut();
  else syncConnect();
}

let syncManualSignOut = false;
let syncJustSignedIn  = false;   // true between explicit sign-in and first reconcile
export let syncPendingRemote = null;    // { state, updatedAt } awaiting Import/Export choice

/* Capture WHY a session died. onAuthStateChanged(null) never says, so:
 * (a) note the timestamp of any sign-out we didn't ask for, and
 * (b) on every startup force a token refresh — if silent renewal is
 *     broken (revoked token, deleted user, blocked securetoken call),
 *     this fails NOW with the real error code instead of signing us
 *     out mysteriously an hour later. */
function syncRecordAuthError(err, where) {
  const meta = syncLoadMeta();
  meta.authErr = {
    code: (err && err.code) || '',
    msg:  String((err && err.message) || err || 'unknown'),
    at:   Date.now(),
    where,
  };
  syncSaveMeta(meta);
  console.warn('[sync] auth error (' + where + '):', err);
  syncUpdateUI();
}

export function syncInit() {
  if (!syncConfigured()) { syncUpdateUI(); return; }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
  } catch(e) {
    console.warn('Firebase init failed:', e);
    syncUpdateUI();
    return;
  }
  document.addEventListener('focusout', () => setTimeout(syncTypingDone, 0));   // a field was left: take in what waited now
  window.addEventListener('pagehide', copiesSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') copiesSave(); });
  syncCopiesReady = false;
  copiesStart().then(() => {
    syncKeepBootCopy();
    syncCopiesReady = true;
    const snap = syncCopiesWaiting;
    syncCopiesWaiting = null;
    if (snap && syncRef) syncOnRemoteValue(snap);
  });
  firebase.auth().onAuthStateChanged(user => {
    syncUser = user;
    syncStop();
    const meta = syncLoadMeta();
    if (user) {
      meta.authAt    = Date.now();
      meta.authEmail = user.email || '';
      delete meta.outAt;
      delete meta.authErr;
      syncSaveMeta(meta);
      /* diagnostic: force a refresh so a broken renewal fails loudly now */
      if (typeof user.getIdToken === 'function') {
        user.getIdToken(true).catch(err => syncRecordAuthError(err, 'token refresh'));
      }
      syncStart();
    } else {
      if (meta.authAt && !syncManualSignOut) {
        meta.outAt = Date.now();           // sign-out we did NOT request
        console.warn('[sync] unexpected sign-out at', new Date(meta.outAt).toString());
      }
      delete meta.authAt;
      delete meta.authEmail;
      syncManualSignOut = false;
      syncSaveMeta(meta);
    }
    syncUpdateUI();
  });
}
