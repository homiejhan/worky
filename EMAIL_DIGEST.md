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

## What runs when you press Run digest

1. `GET gmail/v1/users/me/messages?q=newer_than:24h -in:spam -in:trash` (up to 80 ids),
   then each message with `format=full`, 6 at a time. HTML bodies become text with
   links kept as `text (url)`.
2. Each email is routed by sender/subject: TLDR, ByteByteGo, jobs (ATS words),
   promotions (skipped), newsletters (`List-Id` or newsletter words), everything else.
3. One `/api/chat` call per section (chunked at ~16k chars of email text), using the
   section rules from the original digest spec. Empty sections say *Nothing today*.
4. One more call writes **Top of the inbox** and the **Action items** checklist.
5. The markdown is saved to `digest.last` (synced), rendered on Home, and a toast fires.

Progress shows on the card; Cancel aborts. Errors stay on the card with the fix
(Connect Gmail / Open Settings) until dismissed; the previous digest stays visible.

## Where things live

| Thing | Where | Synced |
|---|---|---|
| `digest.enabled`, `digest.last {at, markdown, count, model, source}` | app state (`dg` compressed) | yes |
| Gmail token | `localStorage focus-gmail-token` | no |
| Ollama URL, model, window | `localStorage focus-digest-engine` | no |
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
