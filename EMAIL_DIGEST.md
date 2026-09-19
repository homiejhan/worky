# Email Digest

The digest is built **off-device** and delivered to the app.

```
GitHub Actions (daily 6:30 am CT, or "Run now")
  └─ backend/digest.py
       ├─ Gmail API  ← refresh token (GitHub secret)
       ├─ llama-server + Qwen3.5-4B (GGUF, cached on the runner)
       └─ Firebase  → users/<uid>/digestInbox
                          │
Worky (any device)  ◄─────┘  digestInboxSeen → digestInboxFlush
  ├─ merges into digest.last + the suggestion pool (synced state)
  ├─ next sync push rewrites the user node, clearing the inbox
  └─ Home card: summary + Suggested tasks (Add / Dismiss / Add all)
```

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
`suggestions[]`, `sugIdCounter`. Older builds also stored `schedule`, `lastScheduled`
and `request` for the laptop runner; those are dropped on load.

Device-local (localStorage): `focus-digest-ui` (collapsed), `focus-digest-github`
(token), `focus-digest-run` (the GitHub run being watched, so a reload keeps watching).

## Tests

```
npm install jsdom          # once
node test_digest.js        # state, pool, rendering, delivery merge, Run now against a fake GitHub API
node test_sync.js          # two devices converging, including a backend delivery
```
