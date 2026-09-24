/* config.js — Constants: storage keys, calendar geometry, the Google OAuth client,
 * Firebase and email-digest settings. */

/* ───────────────────────── CONFIG ───────────────────────── */
export const LS_KEY          = 'focus-app-state';
export const CAL_LS_KEY      = 'focus-cal-state';
export const GCAL_LS_KEY     = 'focus-gcal-token';
export const GCAL_CAL_LS_KEY = 'focus-gcal-calendars';

export const CAL_HOUR_PX  = 64;
export const CAL_TOTAL_PX = 24 * CAL_HOUR_PX;
export const CAL_DOW      = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export const CAL_COLORS   = ['#378ADD','#EC3636','#8B5CF6','#F97316','#22C55E','#EAB308','#5DCAA5','#D4537E','#505050'];

export const GCAL_CLIENT_ID = '855884688171-80lpepboe9q7io8m8lpd3njllnrgvl0d.apps.googleusercontent.com';
export const GCAL_SCOPES    = 'https://www.googleapis.com/auth/calendar';
export const GCAL_REDIRECT  = 'https://homiejhan.github.io/worky/';

/* ── Cloud Sync (Firebase) ──
 * Paste the web-app config from the Firebase console here to enable
 * cross-device sync. Leave apiKey empty to keep sync disabled — the
 * rest of the app is unaffected. These values are safe to ship in
 * client code; access control lives in the Realtime Database rules
 * (each user can only read/write users/<their own uid>). */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCG7dkADn9NIw4GFJV9cNyKVEHfqHvpe4I",
  authDomain: "worky-b3e3a.firebaseapp.com",
  databaseURL: "https://worky-b3e3a-default-rtdb.firebaseio.com",
  projectId: "worky-b3e3a",
  appId: "1:996860584518:web:61b0638c1f8512c6786047",
};
/* Sign-in reuses the Google OAuth client + redirect of the Google Calendar
 * connection (GCAL_CLIENT_ID / GCAL_REDIRECT, proven to work in the iOS PWA).
 * The `state` tag tells the two redirect handlers apart. */
export const SYNC_STATE_TAG   = 'worky-sync';
export const SYNC_META_LS_KEY = 'focus-sync-meta';

/* ── Email Digest ──
 * Built by backend/digest.py on GitHub Actions and delivered through
 * Firebase (users/<uid>/digestInbox). Only display state lives here. */
export const DIGEST_UI_LS_KEY          = 'focus-digest-ui';        // device-local: card collapsed?
export const DIGEST_GITHUB_LS_KEY      = 'focus-digest-github';    // device-local: { token } for "Run now"
export const DIGEST_RUN_LS_KEY         = 'focus-digest-run';       // device-local: the GitHub run being watched
export const DIGEST_GITHUB_REPO        = 'homiejhan/worky';
export const DIGEST_GITHUB_WORKFLOW    = 'digest.yml';

/* ── Bank accounts (Settings → Bank accounts) ──
 * Banks connect through Plaid, via the relay in backend/bank (it holds the Plaid
 * keys). Set BANK_RELAY_URL to where that relay runs, e.g.
 * https://focus-bank-relay.<you>.workers.dev. Empty = not set up here; a relay
 * address can still be set on one device, for testing. */
export const BANK_RELAY_URL  = '';
export const BANK_LS_KEY     = 'focus-bank';   // device-local: connections, balances, transactions
export const PLAID_LINK_JS   = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
