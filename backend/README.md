# Worky digest backend

The email digest, running on GitHub's free Actions runner instead of your laptop.
Once a day the workflow restores a 4-bit Qwen3.5-4B (2.7 GB) from cache, starts
`llama-server` on the runner, reads the last 24 hours of Gmail, builds the same
five-section digest `app.js` builds, and drops the result into Firebase. The app
merges it into the digest card and suggestion pool the next time it syncs.
No paid API is involved; the recurring cost is $0.

```
backend/
├── digest.py         the pipeline (Gmail → llama-server → Firebase)
├── gmail_auth.py     one-time: prints the Gmail refresh token
├── requirements.txt  requests + google-auth
└── README.md
.github/workflows/digest.yml   the daily cron
```

## How the two halves meet

`app.js` syncs the whole app as one JSON blob at `users/<uid>/state` with its own
conflict resolution. The backend never writes there. It writes a sibling node:

```
users/<uid>/digestInbox = { at, markdown, count, model, source: "github", tasks: [...] }
```

`app.js` (`digestInboxSeen` / `digestInboxFlush`) watches for it, merges it exactly
like a local run, saves, and the next sync push — which rewrites the user node —
clears the inbox. If two digests land before a device syncs, only the newest is
kept; that's a deliberate simplification.

## One-time setup (about 15 minutes)

**1. Gmail refresh token.** In Google Cloud Console, in the same project as the
app's existing OAuth client:
- APIs & Services → Library → make sure *Gmail API* is enabled.
- Credentials → Create credentials → OAuth client ID → **Desktop app**.
- OAuth consent screen → Publishing status → **In production**. In "Testing"
  status Google kills refresh tokens after 7 days. You'll get an "unverified
  app" screen once at login (Advanced → continue); verification is only needed
  past 100 users.
- Locally: `python backend/gmail_auth.py`, sign in, copy the three values.

**2. Firebase service account.** Firebase console → Project settings → Service
accounts → *Generate new private key*. That JSON file, as one string, is the
`FIREBASE_SERVICE_ACCOUNT` secret. Service-account writes bypass database rules,
so no rules change is needed.

**3. Your uid.** Firebase console → Authentication → Users → the *User UID*
column for your account.

**4. GitHub secrets.** Repo → Settings → Secrets and variables → Actions:

| secret | from |
|---|---|
| `GMAIL_CLIENT_ID` | gmail_auth.py |
| `GMAIL_CLIENT_SECRET` | gmail_auth.py |
| `GMAIL_REFRESH_TOKEN` | gmail_auth.py |
| `FIREBASE_SERVICE_ACCOUNT` | the downloaded JSON, pasted whole |
| `WORKY_UID` | Authentication → Users |

**5. First run.** Actions → *Email digest* → Run workflow → tick *dry run*.
The first run downloads the model (a few minutes); later runs restore it from
cache in seconds. When the dry run goes green, run it again without the tick
and the digest appears in the app.

## Running locally

Any OpenAI-compatible server works. With Ollama on the laptop:

```
export LLM_URL=http://127.0.0.1:11434 LLM_MODEL=qwen2.5:14b
python backend/digest.py --dry-run     # writes digest.md, no Firebase
```

## Things to know

- Cron is best-effort. GitHub often starts scheduled jobs 10–30 minutes late,
  and disables schedules after 60 days without a commit to the repo.
- Logs print only counts and timings, never email content — Actions logs on a
  public repo are public. The dry run deliberately does not upload the digest
  as an artifact for the same reason.
- Swapping the model is two lines in `digest.yml` (`MODEL_REPO`, `MODEL_FILE`).
  A fine-tuned GGUF later drops in the same way.
- Timezone for "today" in the task-extraction step is `TZ: America/Chicago`
  in the workflow.
