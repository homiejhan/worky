# Email Digest

The digest is built **off-device** and delivered to the app.

```
GitHub Actions (daily 6:30 am CT, or "Run now")
  └─ backend/digest.py
       ├─ Gmail API  ← refresh token (GitHub secret)
       ├─ llama-server + Qwen3.5-4B (GGUF, cached on the runner)
       └─ Firebase  → users/<uid>/digestInbox
                          │
Worky (every device) ◄────┘  digestInboxSeen → digestInboxFlush
  ├─ each device merges the inbox itself when it is newer than the digest it holds
  ├─ the inbox stays in the cloud until the next run overwrites it
  │    (state pushes use update(), so they never touch it)
  ├─ Digest tab: summary + Suggested tasks (Add / Dismiss / Add all);
  │    a button on Home opens it
  └─ "Run now": the GitHub token saved at users/<uid>/digestGithub
       starts the workflow from any device signed in to the account
```

## Same digest on every device

A digest reaches a device through **cloud sync**, so the rule is simply: every
device signed in to the same Worky cloud-sync account shows the same digest.
Settings → Email Digest names the account this device receives through (or says
it isn't signed in). The GitHub token plays no part in receiving a digest — it
only powers *Run now* — and it is saved to the account as well, so a token saved
once works on every device signed in to it.

How it stays consistent:

- The delivered digest is **durable**. It used to be consumed by the first device
  that saw it and then travelled inside the last-write-wins state blob; if a
  device opened later with newer edits of its own, its copy won and the digest
  disappeared everywhere with nothing left to restore it. Now any device, whenever
  it opens, reads the same inbox.
- The state blob reconciles **first**, then the inbox is checked against whatever
  won. A cloud copy that already has the digest makes the merge a no-op; a stale
  copy that won gets the digest merged back in.
- Merging a delivery is **not a user edit** (it doesn't bump `editAt`), so a phone
  that merges the morning digest can't out-rank real edits made on the laptop.
- Merging is idempotent — same inbox + same state gives the same fingerprint — so
  two devices merging at once agree instead of ping-ponging.
- **Clear digest** records `clearedAt`, so the inbox copy doesn't pop back in.

Nothing in the browser reads mail or talks to a model. Setup, secrets, and the
workflow are documented in [`backend/README.md`](backend/README.md).

## In the app

**Settings → Email Digest**
- *Show the email digest* — the digest on or off everywhere: the button on Home,
  the tab in the ☰ menu and the sidebar. Off also takes it off a phone's bottom
  bar, on puts it back there. A delivery turns it on automatically.
- Settings → Sections only decides whether Digest sits on a phone's bottom bar
  (`views.digest`); off there, the button on Home and the ☰ menu still open it.
  Sections lists Digest even while the digest is off, and switching it on there
  turns the digest on. (Before, that switch turned the whole digest off; a copy
  saved then — the digest in use but off, and never taken off the bar — opens
  with the digest on and off the bar: `digestFromOldSwitch`.)
- Status line — when the last digest arrived, how many emails, which model.
- *Run it from any device* — paste a GitHub fine-grained token (scope: this repo,
  **Actions: Read and write**, with an expiry). It's saved to the signed-in account
  at `users/<uid>/digestGithub` = `{ token, updatedAt }`: a sibling of the state
  blob like `digestInbox`, so it never enters Export and state pushes never touch
  it. Every device signed in to that account can then use Run now. **Remove**
  takes it out of the account, so off every device; signing out takes it off that
  device. Saving needs cloud sync (the digest can only arrive through it anyway).
  With a token, **Run digest now** dispatches the workflow and the Digest tab shows
  the run's progress (queued → running → finished → arriving) with a link to the log.
  The result still arrives through Firebase like a scheduled one.
- A token saved by an older build lives in that device's localStorage. The first
  time the device opens signed in to the account the digest is delivered to (the
  one with a `digestInbox`), it moves into the account and leaves the device. Into
  no other account: the token starts that account's workflow, and someone else
  signing in on the device must not receive it. If the account already has a
  token, or had one removed, the local copy is dropped instead of moved, so a
  removed token doesn't come back from an older device.
- *Load sample* / *Clear digest* — for demos and cleanup.

**Digest tab** (a sidebar page on a computer, a tab on a phone)
- The newest digest, with **Run now** and a gear for Settings → Email Digest.
- The page follows the digest's own shape: the "Top of the inbox" overview leads,
  suggested tasks follow, then a card per `##` section in the order the backend
  wrote them, its leading emoji as the card's icon. A section whose whole body is
  "Nothing today" shrinks to one line. A bold line on its own is a sub-heading, a
  line starting with ⚠️ is a callout, and on a phone a table of 3+ columns shows
  each row as a block. "In this digest" lists the cards (chips on a phone, a
  sticky column on a wide screen) and jumps to them.
- Suggested tasks sit under the overview until you **Add** (becomes a Day by Day
  task with the digest's due date, else today) or **Dismiss** (hidden, and the same
  title isn't re-suggested for two weeks). A dismissed or added title survives
  across runs; an added task you later delete is offered again.

**Home**
- An *Email digest* button under the progress bar opens the tab. It shows when the
  digest came and how many suggestions wait (or a run's progress), and **New**
  until this device has shown the newest digest on the tab (device-local).

## State

Synced (`digest` in app state): `enabled`, `last {at, markdown, count, model, source}`,
`suggestions[]`, `sugIdCounter`, and `clearedAt` (only once a digest has been cleared). Older builds also stored `schedule`, `lastScheduled`
and `request` for the laptop runner; those are dropped on load.

Account, beside the state blob: `digestGithub {token, updatedAt}` (the Run now
token; `{updatedAt}` alone once removed). The database rules must limit
`users/<uid>` to its owner, as they already should for the rest of the data.

Device-local (localStorage): `focus-digest-ui` (`seenAt`: the newest digest this
device has shown, for New on Home), `focus-digest-run` (the
GitHub run being watched, so a reload keeps watching), and `focus-digest-github` (a
token an older build saved, until it moves into the account).

## Tests

```
npm install                      # once (jsdom)
npm test                         # every suite in tests/
npm test -- digest               # just the digest: state, pool, rendering, delivery merge, Run now against a fake GitHub API
npm test -- sync                 # just sync: two devices converging (deliveries, a phone opening late, Clear, Import, the Run now token)
```
