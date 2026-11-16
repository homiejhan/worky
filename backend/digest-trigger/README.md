# The digest's morning start

A small Cloudflare Worker that starts the email digest at **5:00 am Central** every
morning. A run takes minutes on a quiet day and about an hour on a busy weekday
(4 to 89 minutes since October), so the digest is in the app by about 6, and by
6:30 even on the busiest days.

The digest itself runs on GitHub Actions (`.github/workflows/digest.yml`), but
GitHub's own schedule is best-effort. Not one of its 57 scheduled runs from
September 20 to November 15, 2026 started on time: they started 2¾ to 10 hours
late, 5½ on a typical day and over 7 on a typical day in November. A Cloudflare
Cron Trigger runs on the minute, so this Worker asks GitHub to start the workflow
(`workflow_dispatch`, the same request as **Run now** in the app) at the right
time. The cron fires every hour on the hour and the Worker acts only on the one
that is 5 am in Chicago, so daylight saving time needs no change.

GitHub's schedule stays in `digest.yml` as the backup. That run starts with a
check (`digest.py --delivered-today`) and builds a digest only if none has come
in that day: a morning this Worker misses still gets a digest, late, and a morning
it starts doesn't get a second one in the afternoon. **Run now** always builds.

## Setup (about 5 minutes, once)

**1. A GitHub token.** GitHub → Settings → Developer settings → Personal access
tokens → *Fine-grained tokens* → *Generate new token*:
- Name: `Focus digest morning start`; Expiration: as long as you're comfortable with
  (when it runs out, the digest goes back to arriving late until you replace it).
- Repository access: *Only select repositories* → `worky`.
- Permissions → Repository permissions → **Actions: Read and write**. Nothing else.

Copy the token (it's shown once).

**2. Deploy and give it the token.** From this folder, signed in to the same
Cloudflare account as the bank relay (`npx wrangler login` if needed):

```
cd backend/digest-trigger
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN     # paste the token when it asks
```

`wrangler deploy` should end by listing `schedule: 0 * * * *`. That's it: the
next start is 5:00 am Central.

The same can be done by hand in the Cloudflare dashboard: a Worker named
`focus-digest-trigger` with `worker.mjs` as its code, the four variables from
`wrangler.toml`, the secret `GITHUB_TOKEN`, and a cron trigger `0 * * * *`.

## Checking on it

- **GitHub:** Actions → *Email digest*. Each morning's run shows up at 5:00 am
  Central as run manually (`workflow_dispatch`) by you. A late backup run that
  found the digest already in shows its *digest* job as skipped.
- **Cloudflare:** Workers & Pages → `focus-digest-trigger` → Logs. A failed
  morning says why, e.g. *GitHub turned the token down (401)* when the token has
  expired or lacks Actions: Read and write.

## Changing it

- **The time:** `START_HOUR` in `wrangler.toml` (0–23, Central time; it starts on
  the hour), then `npx wrangler deploy`. Keep it at 5 or earlier: GitHub's backup
  is due at 5:30 (6:30 in summer) and has to come after the morning start to find
  that day's digest and skip.
- **Stopping it:** `npx wrangler delete` from this folder, or delete the Worker in
  the dashboard. GitHub's (late) schedule keeps the digest coming.
- **Tests:** `npm test -- digest_trigger` runs the Worker against a stand-in
  for GitHub.
