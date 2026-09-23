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
  └─ Home card: summary + Suggested tasks (Add / Dismiss / Add all)
```

## Same digest on every device

A digest reaches a device through **cloud sync**, so the rule is simply: every
device signed in to the same Worky cloud-sync account shows the same digest.
Settings → Email Digest names the account this device receives through (or says
it isn't signed in). The GitHub token plays no part in receiving a digest — it
only powers *Run now* — so the phone doesn't need one.

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
- *Show digest on Home* — the only switch. A delivery turns it on automatically.
- Status line — when the last digest arrived, how many emails, which model.
- *Run it from this device* — paste a GitHub fine-grained token (scope: this repo,
  **Actions: Read and write**). It's stored in this device's localStorage only,
  never synced. With it, **Run digest now** dispatches the workflow and the card
  shows the run's progress (queued → running → finished → arriving) with a link
  to the log. The result still arrives through Firebase like a scheduled one.
- *Load sample* / *Clear digest* — for demos and cleanup.

**Home card**
- Suggested tasks sit above the summary until you **Add** (becomes a Day by Day
  task with the digest's due date, else today) or **Dismiss** (hidden, and the same
  title isn't re-suggested for two weeks). A dismissed or added title survives
  across runs; an added task you later delete is offered again.
- Chevron collapses the summary (device-local).

## State

Synced (`digest` in app state): `enabled`, `last {at, markdown, count, model, source}`,
`suggestions[]`, `sugIdCounter`, and `clearedAt` (only once a digest has been cleared). Older builds also stored `schedule`, `lastScheduled`
and `request` for the laptop runner; those are dropped on load.

Device-local (localStorage): `focus-digest-ui` (collapsed), `focus-digest-github`
(token), `focus-digest-run` (the GitHub run being watched, so a reload keeps watching).

## Tests

```
npm install                      # once (jsdom)
npm test                         # every suite in tests/
node tests/test_digest.js        # just the digest: state, pool, rendering, delivery merge, Run now against a fake GitHub API
node tests/test_sync.js          # just sync: two devices converging (deliveries, a phone opening late, Clear, Import)
```
