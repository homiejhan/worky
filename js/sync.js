/* sync.js — Cloud sync of the whole state through Firebase. */
import {
  FIREBASE_CONFIG, GCAL_CLIENT_ID, GCAL_REDIRECT, LS_KEY, SYNC_BASE_LS_KEY, SYNC_META_LS_KEY, SYNC_STATE_TAG,
} from './config.js';
import { $, closeModal, keepField, showToast, typingPauseIn, userTyping } from './util.js';
import {
  gatherState, loadFromLocal, renderLoadedState, saveToLocal, STATE_BUILD,
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
 *     devices through the same localStorage → loadFromLocal() path
 *     used everywhere else. Own writes echo back and are ignored via
 *     the per-session client id.
 *   • Conflicts: when both this device and the cloud changed since the
 *     copy they last agreed on (kept in localStorage, SYNC_BASE_LS_KEY),
 *     the two are merged against it (syncmerge.js): a task added here and
 *     a purchase logged there are both kept. Without that copy, the newer
 *     edit wins by timestamp.
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
  return JSON.stringify(syncCanon({
    ...state,
    timers: (state.timers || []).map(t => t.running ? { ...t, seconds: -1 } : t),
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
 * (`stateStr`): the base a later conflict is merged against. */
function syncAgree(fp, extra, stateStr) {
  syncKnownFp = fp;
  syncLastSyncAt = Date.now();
  const meta = syncLoadMeta();
  meta.knownHash = syncHash(fp);
  Object.assign(meta, extra || {});
  syncSaveMeta(meta);
  if (typeof stateStr === 'string') {
    try { localStorage.setItem(SYNC_BASE_LS_KEY, JSON.stringify({ hash: meta.knownHash, state: stateStr })); } catch(e) {}
  }
}
/* The copy both sides last agreed on, if this device still has it. */
function syncBase(hash) {
  try {
    const b = JSON.parse(localStorage.getItem(SYNC_BASE_LS_KEY));
    return b && b.hash === hash && typeof b.state === 'string' ? JSON.parse(b.state) : null;
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
  if (syncHeld() && !priority) return false;  // Formats open — only Done may push
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  const state = gatherState();
  const fp = syncFingerprint(state);
  if (fp === syncKnownFp) return false;       // cloud already has this
  const payload = {
    state: JSON.stringify(state),
    updatedAt: Date.now(),
    client: syncClientId,
  };
  if (priority) syncCommitPending = Math.max(1, syncCommitPending);   // open (or keep) the priority window
  syncWrite(payload, priority)
    .then(written => {
      if (!written) return;                   // the cloud moved on: the listener brings that copy to merge with, then this pushes again
      syncCloudSeen = syncHash(fp);
      syncAgree(fp, { pushedAt: Date.now() }, payload.state);
      syncCommitPending = 0;                  // server has it — priority window closes
      syncUpdateUI();
    })
    .catch(err => {
      syncCommitPending = 0;
      /* permission errors are the database rules; anything else (the database
       * gave up on a busy node, say): try again in a moment */
      if (err && /permission/i.test(String(err.message || err.code || ''))) syncRecordAuthError(err, 'database write');
      else setTimeout(() => { if (syncUser && syncRef) syncSchedulePush(); }, 5000);
    });
  return true;
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

/* Done was clicked: release the hold and push the committed template
 * with priority. Returns true if a foreign cloud copy that arrived during
 * Formats was discarded in favour of this commit. */
export function syncCommitFormat() {
  const overrode = !!syncDeferredRemote;
  syncDeferredRemote = null;
  syncPushNow({ priority: true });
  syncUpdateUI();
  return overrode;
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

function syncApplyRemote(remoteStr, remoteUpdatedAt, mergedStr) {
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
    localStorage.setItem(LS_KEY, effective);
    if (!loadFromLocal()) return;             // corrupt payload — keep local
    keepField(renderLoadedState);             // a cursor left in a field stays, with what was typed
    try { remoteFp = syncFingerprint(JSON.parse(remoteStr)); } catch(e) {}
  } finally {
    if (remoteFp) { syncLastSeenFp = remoteFp; syncAgree(remoteFp, { editAt: remoteUpdatedAt || Date.now() }, remoteStr); }
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
function syncOnRemoteValue(snap) {
  const v = snap.val();
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
 * the state with both sets of changes, or null without that copy. */
function syncMergeRemote(remoteStr, knownHash, preferLocal) {
  const base = knownHash ? syncBase(knownHash) : null;
  if (!base) return null;
  try {
    const remote = JSON.parse(remoteStr);
    if (!remote || typeof remote !== 'object') return null;
    /* fields an older build's copy lacks were not deleted there: it never knew them */
    if ((Number(remote.build) || 1) < STATE_BUILD) Object.keys(base).forEach(k => { if (!(k in remote)) remote[k] = base[k]; });
    return JSON.stringify(syncMerge(base, gatherState(), remote, { preferLocal }));
  } catch(e) { return null; }
}

function syncReconcileRemote(v) {
  const localFp = syncFingerprint(gatherState());
  syncReconciled = true;                      // from here on pushes are allowed
  syncCloudSeen = v && typeof v.state === 'string' ? syncStateHash(v.state) : null;

  if (syncPendingRemote) {                    // choice not made yet — just keep the stash fresh
    if (v && typeof v.state === 'string' && v.client !== syncClientId) {
      syncPendingRemote = { state: v.state, updatedAt: v.updatedAt || 0 };
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
    try { syncAgree(syncFingerprint(JSON.parse(v.state)), undefined, v.state); } catch(e) {}
    syncUpdateUI();
    return;
  }
  let remoteFp = null;
  try { remoteFp = syncFingerprint(JSON.parse(v.state)); } catch(e) { return; }
  if (syncHeld()) {                           // Formats open — stash, never apply
    if (remoteFp !== localFp) {
      syncDeferredRemote = { state: v.state, updatedAt: v.updatedAt || 0 };
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
    syncAgree(remoteFp, undefined, v.state);
    syncUpdateUI();
    return;
  }
  /* Divergence. If this is a fresh connection with no agreed baseline —
   * right after an explicit sign-in, or after local storage was wiped —
   * NEVER guess: a brand-new device's empty defaults would look like
   * "recent edits" and clobber the cloud. Ask the user instead. */
  const meta = syncLoadMeta();
  const noBaseline = syncKnownFp === null && (syncJustSignedIn || !meta.pushedAt);
  if (noBaseline) {
    syncJustSignedIn = false;
    syncPendingRemote = { state: v.state, updatedAt: v.updatedAt || 0 };
    clearTimeout(syncPushTimer);
    syncOpenChoiceModal();
    syncUpdateUI();
    return;
  }
  /* Established baseline. Mid-session, syncKnownFp is the live baseline;
   * on a fresh connection it is null, so fall back to the persisted hash
   * of the last agreed state to work out which side actually moved:
   *   • only the cloud moved → apply it (the common "other device
   *     edited while this one was closed" case)
   *   • only this device moved → push it (offline edits)
   *   • both moved → merge the two against the copy both last agreed on;
   *     without that copy, the newer edit wins by timestamp */
  const knownHash = syncKnownFp !== null ? syncHash(syncKnownFp) : (meta.knownHash || null);
  const localDirty  = knownHash ? syncHash(localFp)  !== knownHash : true;
  const remoteDirty = knownHash ? syncHash(remoteFp) !== knownHash : true;
  if (!localDirty) {
    syncApplyRemote(v.state, v.updatedAt);
  } else if (!remoteDirty) {
    syncPushNow();
  } else {
    const preferLocal = (meta.editAt || 0) > (v.updatedAt || 0);
    const merged = syncMergeRemote(v.state, knownHash, preferLocal);
    if (merged) syncApplyRemote(v.state, v.updatedAt, merged);
    else if (preferLocal) syncPushNow();
    else syncApplyRemote(v.state, v.updatedAt);
  }
}

function syncStart() {
  if (!syncUser || !syncConfigured()) return;
  syncRef = firebase.database().ref('users/' + syncUser.uid);
  syncRef.on('value', syncOnRemoteValue);
}
function syncStop() {
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  if (syncRef) { syncRef.off(); syncRef = null; }
  syncKnownFp = null;
  syncReconciled = false;
  syncCloudSeen = null;
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
  if (pending) syncApplyRemote(pending.state, pending.updatedAt);
  digestInboxSeen(digestInboxLatest);          // the imported copy may predate the delivered digest
  syncUpdateUI();
  if (tourReoffer) { setTourReoffer(false); tourMarkSeen(); }   // cloud data → returning user
}
export function syncChooseExport() {
  syncPendingRemote = null;
  $('syncChoiceModal')?.classList.remove('show');
  digestInboxSeen(digestInboxLatest);          // this device's copy may predate the delivered digest
  syncPushNow();
  showToast('Exported to cloud ✓');
  syncUpdateUI();
  if (tourReoffer) tourOffer();
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
    line.textContent = syncBouncing
      ? `Syncing as ${syncUser.email || 'Google account'}${when} — changes keep bouncing with another device. It is probably running an older version of Worky: fully close and reopen the app there.`
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
