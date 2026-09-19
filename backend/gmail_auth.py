#!/usr/bin/env python3
"""
One-time setup: get a Gmail *refresh token* for the digest backend.

Why this exists: the app's in-browser Gmail login hands out a token that dies
after an hour, which is fine when you're sitting there but useless for a cron
job. A refresh token is a long-lived credential the backend trades for a fresh
one-hour token every run. You get it once, here, and store it as a secret.

Steps (5 minutes):
  1. Google Cloud Console → APIs & Services → Credentials → Create credentials
     → OAuth client ID → Application type: "Desktop app". Copy the client ID
     and secret. (Your existing web client for GitHub Pages can't do this
     flow; a second client in the same project is normal.)
  2. On the OAuth consent screen, set Publishing status to "In production".
     While it stays "Testing", Google expires refresh tokens after 7 days and
     the cron would die weekly. You'll see an "unverified app" warning once
     during login — click Advanced → continue. Verification is only needed
     if you ever go beyond 100 users.
  3. Run:   python backend/gmail_auth.py
     A browser opens; sign in with the Gmail account to digest.
  4. Paste the three printed values into GitHub → repo → Settings → Secrets.

Stdlib only — nothing to install.
"""

import http.server
import json
import os
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
PORT = 8765


def main():
    cid = os.environ.get("GMAIL_CLIENT_ID") or input("Desktop OAuth client ID: ").strip()
    csec = os.environ.get("GMAIL_CLIENT_SECRET") or input("Desktop OAuth client secret: ").strip()
    redirect = f"http://127.0.0.1:{PORT}/"

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",   # ← this is what makes Google issue a refresh token
        "prompt": "consent",        # ← and this forces one even if you've consented before
    })

    got = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got["code"] = (q.get("code") or [""])[0]
            got["error"] = (q.get("error") or [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Done. You can close this tab and go back to the terminal.</h2>")

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.handle_request, daemon=True).start()

    print("\nOpening your browser. If it doesn't open, paste this URL:\n\n" + auth_url + "\n")
    webbrowser.open(auth_url)
    while "code" not in got:
        threading.Event().wait(0.2)
    srv.server_close()
    if got.get("error") or not got.get("code"):
        sys.exit(f"Login failed: {got.get('error') or 'no code returned'}")

    body = urllib.parse.urlencode({
        "code": got["code"],
        "client_id": cid,
        "client_secret": csec,
        "redirect_uri": redirect,
        "grant_type": "authorization_code",
    }).encode()
    with urllib.request.urlopen("https://oauth2.googleapis.com/token", data=body, timeout=30) as r:
        tok = json.load(r)

    rt = tok.get("refresh_token")
    if not rt:
        sys.exit("Google returned no refresh_token. Revoke the app at myaccount.google.com/permissions and run again.")

    print("\nAdd these as GitHub repository secrets (Settings → Secrets and variables → Actions):\n")
    print(f"  GMAIL_CLIENT_ID      = {cid}")
    print(f"  GMAIL_CLIENT_SECRET  = {csec}")
    print(f"  GMAIL_REFRESH_TOKEN  = {rt}")
    print("\nThe refresh token is a password to your inbox. Never commit it.")


if __name__ == "__main__":
    main()
