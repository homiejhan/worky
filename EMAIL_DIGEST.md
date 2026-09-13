# Email Digest — personal demo

Everything runs inside Worky: the browser reads your last day of Gmail, sends it to
Ollama on your laptop, and shows the summary as a card on Home. The finished digest is
part of synced state, so once the laptop has run it your phone shows the same card.

No byo-llm, no GitHub Actions, no server. That's deliberate for the demo — the pieces
that would let other people use this (a hosted engine, refresh tokens) come later.

## One-time setup

**1. Google Cloud (same project as the Calendar OAuth client)**
- APIs & Services → Library → enable **Gmail API**.
- APIs & Services → OAuth consent screen → Data access → add scope
  `https://www.googleapis.com/auth/gmail.readonly`.
- The app is in Testing mode, so your Google account must be listed under Test users
  (it already is if Calendar works).

**2. Ollama on the laptop**
- `ollama pull qwen2.5:14b` (or any model you like — 8b models work, 14b reads
  newsletters better).
- For the GitHub Pages build the browser origin must be allowed:
  - macOS: `launchctl setenv OLLAMA_ORIGINS https://homiejhan.github.io` then restart Ollama
  - Windows: set user env var `OLLAMA_ORIGINS=https://homiejhan.github.io`, restart Ollama
  - Linux/systemd: `Environment="OLLAMA_ORIGINS=https://homiejhan.github.io"` in the service override
  - `http://localhost:8000` needs nothing — Ollama trusts localhost origins by default.

**3. In Worky**
- Settings → Email Digest → turn on **Show digest on Home**.
- **Connect Gmail** → Google consent (read-only). This is a full-page redirect like
  cloud sign-in; the token is device-local and lasts about an hour, so reconnect when
  the card says the session expired.
- **Test** next to the Ollama URL → the model dropdown fills from `/api/tags`; pick one.
- **Run digest** on the Home card (or "Run digest now" in Settings).

**Load sample** shows the card with canned data if you just want to see the layout.

## What runs when you press Run digest (or the schedule does)

1. `GET gmail/v1/users/me/messages?q=newer_than:1d -in:spam -in:trash`, paged until Gmail
   runs out (every email from the past 24 hours; a 400-message ceiling is the only limit),
   then each message with `format=full`, 6 at a time. HTML bodies become text with links
   kept as `text (url)`.
2. Each email is routed by sender/subject: TLDR, ByteByteGo, jobs (ATS words),
   promotions (skipped), newsletters (`List-Id` or newsletter words), everything else.
3. One `/api/chat` call per section (chunked at ~16k chars of email text). Empty sections
   say *Nothing today*.
4. One more call writes **Top of the inbox** and an action-items checklist.
5. A structured-output call (`format: json`, reasoning field first) turns the digest into
   task candidates `{title, why, due, section}`, given today's date so "Friday" becomes a
   real date. Every field is re-validated; if the JSON is unusable the checklist from step 4
   is used instead.
6. The candidates are **merged into the suggestion pool**, the markdown is saved to
   `digest.last`, everything syncs, and a toast reports how many suggestions are new.

## Suggested tasks — the pool

Suggestions live in `digest.suggestions`, not on a single digest, so they never expire on
their own. Each has a status:

- **pending** — shown on the card with **Add** and **×**. Stays until you act on it, across
  any number of runs.
- **added** — Add created a normal Day by Day task (due = suggested date, else today) and
  remembered its id. It shows as *Added ✓* until the next run, then drops off the card. If
  you delete that task later, the suggestion is offered again.
- **dismissed** — × hides it for good. Its title is remembered for 14 days so the next run
  doesn't re-suggest the same email.

Matching is by normalised title (case, punctuation and spacing ignored), so the same
follow-up seen in two runs is one suggestion. Load sample twice → still four suggestions.

## Schedule

Settings → Email Digest → **Run automatically** → add one or more times of day. The times
are synced; **which device runs them** is device-local ("Use this device to run them") —
only the machine with Ollama can. Every minute, on launch and when the tab becomes
visible, that device checks for a slot that has passed in the last 12 hours and hasn't run
yet, claims it (`digest.lastScheduled`, synced, so a second configured device won't repeat
it) and runs. Editing the schedule claims any already-passed slot instead of running it
("7:00" added at 9:00 means tomorrow). If Gmail's one-hour token has expired at run time the
card says so and the slot is skipped, not retried every minute. Worky has to be open for a
scheduled run — it's a browser app; a true background cron is the hosted/backend step.

## Where things live

| Thing | Where | Synced |
|---|---|---|
| `digest.enabled`, `digest.last {at, markdown, count, model, source}`, `digest.suggestions[]`, `digest.schedule`, `digest.lastScheduled` | app state (`dg` compressed) | yes |
| Gmail token | `localStorage focus-gmail-token` | no |
| Ollama URL, model, autorun | `localStorage focus-digest-engine` | no |
| Card collapsed | `localStorage focus-digest-ui` | no |

Files touched: `app.js` (EMAIL DIGEST section + hooks in config, state
compress/decompress/gather/apply/load, `renderHome`, `renderSettings`,
`gcalHandleRedirect`, `bindStatic`, init), `index.html` (Settings section),
`style.css` (`.dg-*` rules). `sw.js` / `manifest.json` unchanged.

Tests: `node test_digest.js` (needs `npm i jsdom`) — fake Gmail + fake Ollama end to
end, state round trip, redirect routing, renderer safety. `test_theme.js` still passes.

## Known limits of the demo

- Gmail token is one hour (implicit OAuth). A refresh-token flow needs a backend, which
  is the multi-user step.
- The laptop must be on and Ollama running to *generate*; any signed-in device can *read*
  the last result.
- Local dev at `localhost:8000` still redirects OAuth to GitHub Pages (existing limitation).

## Sync notes (added after the "digest keeps reverting" bug)

A device running an older Worky build does not know the `digest` field, so when it
applied a newer cloud copy it dropped the field and pushed the stripped state back —
newer devices then "synced from cloud" and lost the digest, over and over. Three
changes in `app.js` make that impossible to repeat:

- State carries a `build` number and unknown top-level fields pass straight through
  `loadFromLocal → gatherState`, so a build never strips what a newer one wrote.
- The sync fingerprint is canonical (sorted keys), so re-normalising a record on load is
  not a "change".
- When a cloud copy from an older build lacks fields this device has, the local values
  are kept; if applies start bouncing (4 in 90 s) the device stops pushing back and the
  Settings line says which device to update.

Devices already on an old build still need one refresh (desktop: hard reload; iPhone:
fully close and reopen the PWA). `node test_sync.js` covers all three scenarios.
