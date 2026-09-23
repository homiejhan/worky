# Worky digest backend

The email digest, running on GitHub's free Actions runner instead of your laptop.
Once a day the workflow restores a 4-bit Qwen3.5-4B (2.7 GB) from cache, starts
`llama-server` on the runner, reads the last 24 hours of Gmail, builds the digest
(five sections by default, see below), and drops the result into Firebase. The app
merges it into the digest card and suggestion pool the next time it syncs.
No paid API is involved; the recurring cost is $0.

```
backend/
├── digest.py         the pipeline (Gmail → llama-server → Firebase)
├── gmail_auth.py     one-time: prints the Gmail refresh token
├── prompts.json      the original prompts and sections (the app's editor reads it too)
├── requirements.txt  requests + google-auth
└── README.md
.github/workflows/digest.yml   the daily cron
```

## How the two halves meet

The app (`js/sync.js`) syncs everything as one JSON blob at `users/<uid>/state` with its own
conflict resolution. The backend never writes there. It writes a sibling node:

```
users/<uid>/digestInbox = { at, markdown, count, model, source: "github", tasks: [...] }
```

`js/digest.js` (`digestInboxSeen` / `digestInboxFlush`) watches for it, and every device
merges it for itself when it is newer than the digest that device holds. Sync
pushes use `update()`, which leaves sibling nodes alone, so the inbox stays until
the next run overwrites it: a device opened hours later still finds it. **Clear
digest** records `clearedAt`, so the copy that stays behind doesn't pop back in.
If two runs land before a device opens, only the newest is kept; that's a
deliberate simplification.

## Prompts and sections

The originals are in `backend/prompts.json`: three fixed prompts (`rules`, sent before every section call; `overview`, the top-of-inbox block; `tasks`, the suggested-task extraction) and an ordered `sections` list. Each section has an `id`, a `title` (the heading in the digest), the `keywords` that route emails into it, two flags (`body`: also search the first lines of the email; `lists`: also take mailing-list mail that no keywords caught), a `budget` (characters of email text per section per model call) and its own `prompt`.

Routing is `classify()`: an email goes to the first section, top to bottom, whose keywords match its sender + subject (whole words, case-insensitive, `*` for the rest of a word); else it is skipped if the subject looks promotional; else to the first section with `lists` when it came through a mailing list; else to the first section with no keywords (the catch-all); else skipped.

Edit all of this from the app under **Settings → Email Digest → Prompts**: rename, reorder, add and delete sections, change keywords and prompts. Edits are saved to `users/<uid>/digestPrompts` (`{rules?, overview?, tasks?, sections?, updatedAt}`) and read at the start of every run, so the next run picks them up with no commit. A prompt is stored only when it differs from the original; the section list is stored whole once anything about it changes. **Reset to original** restores one prompt or section, **Restore all originals** clears the node, and **Export .md** / **Import .md** move the whole set through a Markdown file (one `## Section:` block per section). Changing `prompts.json` itself changes the originals for both the script and the editor.

If the saved edits can't be read, the run logs it and falls back to the originals rather than failing. A `--dry-run` still reads your saved edits when the Firebase secrets are set, so it's the way to try a new prompt without replacing the digest on your Home card.

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
