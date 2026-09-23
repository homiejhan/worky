#!/usr/bin/env python3
"""
Worky email digest, built unattended on GitHub Actions:
  1. reads the last 24 hours of Gmail with a long-lived refresh token
  2. routes each email into a section (by default TLDR / ByteByteGo / newsletters / jobs / misc)
  3. asks a local OpenAI-compatible model (llama-server) to summarize each section
  4. writes the "Top of the inbox" overview + action checklist
  5. extracts task candidates as schema-constrained JSON
  6. drops the finished digest into Firebase at users/<uid>/digestInbox,
     where the app picks it up and merges it into its suggestion pool.

It never touches users/<uid>/state — that blob belongs to the app's own sync.

Prompts and sections: the originals live in backend/prompts.json. Edits made in
the app (Settings → Email Digest → Prompts) are saved to users/<uid>/digestPrompts
and read at the start of every run; anything without an edit uses the original.
The section list itself (titles, routing keywords, order, prompts) is part of
that, so sections can be added, renamed, reordered and removed from the app.

Environment (GitHub Secrets in Actions, or a .env locally):
  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN   from backend/gmail_auth.py
  FIREBASE_SERVICE_ACCOUNT   the service-account JSON, as one string
  WORKY_UID                  the Firebase Auth uid of the account to deliver to
  LLM_URL                    OpenAI-compatible base URL   (default http://127.0.0.1:8080)
  LLM_MODEL                  label stored with the digest (default: whatever /v1/models says)
  FIREBASE_DB_URL            only if the database isn't https://<project>-default-rtdb.firebaseio.com

Usage:
  python backend/digest.py             # full run → Firebase
  python backend/digest.py --dry-run   # everything except the Firebase write; saves digest.md
                                       # (still reads your saved prompts when the Firebase secrets are set)
"""

import argparse
import base64
import concurrent.futures as cf
import copy
import datetime as dt
import html
import json
import os
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path

import requests

# ── constants ──

CHUNK_CHARS    = 16000   # email text fed to one model call
OVERVIEW_CHARS = 18000   # assembled digest fed to the overview call
FETCH_PARALLEL = 6
WINDOW_QUERY   = "newer_than:1d -in:spam -in:trash"
MAX_EMAILS     = 400

PROMO_RX = re.compile(r"(\d+% off|sale ends|flash sale|limited time|coupon|promo code|last chance|deal of the day|free shipping)", re.I)

# ── prompts & sections ──
# The originals live in backend/prompts.json — the one copy both this script and
# the app's Settings editor read. Saved edits come from Firebase
# (users/<uid>/digestPrompts = {rules?, overview?, tasks?, sections?, updatedAt})
# and replace the original for that key only.
#   rules      prepended to every section call
#   overview   "Top of the inbox" + "Action items"
#   tasks      suggested-task extraction (shape enforced by TASKS_SCHEMA);
#              the text "{sections}" inside it becomes the list of section ids
#   sections   ordered list of {id, title, keywords, body, lists, budget, prompt}:
#              an email goes to the first section whose keywords match its
#              sender + subject (or the first lines of the body when `body`),
#              else it is skipped if promotional, else to the first section with
#              `lists` when it came through a mailing list, else to the first
#              section with no keywords (the catch-all), else skipped.
PROMPTS_FILE = Path(__file__).with_name("prompts.json")
PROMPT_KEYS = ["rules", "overview", "tasks"]
PROMPT_MAX_CHARS = 8000        # same caps as the Settings editor
SECTION_MAX = 12
KEYWORDS_MAX = 60
BUDGET_DEFAULT, BUDGET_MIN, BUDGET_MAX = 8000, 2000, 30000


def load_default_prompts():
    try:
        with open(PROMPTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise DigestError(f"Could not read {PROMPTS_FILE.name}: {e}")
    missing = [k for k in PROMPT_KEYS if not isinstance(data.get(k), str) or not data[k].strip()]
    if missing:
        raise DigestError(f"{PROMPTS_FILE.name} is missing prompts: {', '.join(missing)}")
    out = {k: data[k].strip() for k in PROMPT_KEYS}
    out["sections"] = normalize_sections(data.get("sections"))
    if not out["sections"]:
        raise DigestError(f"{PROMPTS_FILE.name} has no usable sections")
    return out


def normalize_sections(raw):
    """Accept only well-formed sections; ids are slugs and unique, in file order."""
    out, seen = [], set()
    if not isinstance(raw, list):
        return out
    for x in raw:
        if not isinstance(x, dict):
            continue
        sid = re.sub(r"[^a-z0-9-]+", "-", str(x.get("id") or "").lower()).strip("-")[:40]
        title = re.sub(r"\s+", " ", str(x.get("title") or "")).strip()[:80]
        prompt = str(x.get("prompt") or "").strip()[:PROMPT_MAX_CHARS]
        if not sid or sid in seen or not title or not prompt:
            continue
        kws = x.get("keywords")
        if isinstance(kws, str):
            kws = re.split(r"[,\n]", kws)
        kws = [re.sub(r"\s+", " ", str(k)).strip()[:60] for k in (kws or []) if str(k).strip()][:KEYWORDS_MAX] \
            if isinstance(kws, list) else []
        try:
            budget = int(x.get("budget") or BUDGET_DEFAULT)
        except (TypeError, ValueError):
            budget = BUDGET_DEFAULT
        seen.add(sid)
        out.append({"id": sid, "title": title, "prompt": prompt, "keywords": kws,
                    "body": bool(x.get("body")), "lists": bool(x.get("lists")),
                    "budget": max(BUDGET_MIN, min(BUDGET_MAX, budget)),
                    "rx": keywords_regex(kws)})
        if len(out) >= SECTION_MAX:
            break
    return out


def keywords_regex(kws):
    """Whole-word, case-insensitive match of any keyword; `*` stands for the rest
    of a word (digest* → digests). None when there are no keywords."""
    parts = []
    for k in kws:
        esc = re.escape(k).replace(r"\*", r"[\w.-]*")
        parts.append(rf"(?<![A-Za-z0-9]){esc}(?![A-Za-z0-9])")
    return re.compile("|".join(parts), re.I) if parts else None


def merge_prompts(defaults, saved):
    """Saved edits win key by key; anything unknown, empty or malformed is ignored."""
    out, edited = dict(defaults), []
    if not isinstance(saved, dict):
        return out, edited
    for k in PROMPT_KEYS:
        v = saved.get(k)
        if isinstance(v, str) and v.strip() and v.strip() != defaults[k]:
            out[k] = v.strip()[:PROMPT_MAX_CHARS]
            edited.append(k)
    if "sections" in saved:
        secs = normalize_sections(saved.get("sections"))
        if secs:
            out["sections"] = secs
            edited.append("sections")
    return out, edited


# The shape the tasks prompt asks for, as a JSON schema. llama-server turns this into a
# grammar so the model physically cannot emit anything that doesn't fit it.
# tasks_schema() fills the section enum from the live section list.
TASKS_SCHEMA = {
    "type": "object",
    "properties": {
        "reasoning": {"type": "string"},
        "tasks": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "properties": {
                    "title":   {"type": "string"},
                    "why":     {"type": "string"},
                    "due":     {"type": "string"},
                    "section": {"type": "string", "enum": []},   # filled by tasks_schema()
                },
                "required": ["title", "why", "due", "section"],
            },
        },
    },
    "required": ["reasoning", "tasks"],
}


def tasks_schema(sections):
    sc = copy.deepcopy(TASKS_SCHEMA)
    sc["properties"]["tasks"]["items"]["properties"]["section"]["enum"] = [s["id"] for s in sections]
    return sc


def fallback_section(sections):
    """Where a task with no recognisable section lands: the catch-all, else the last section."""
    for s in sections:
        if not s["keywords"]:
            return s["id"]
    return sections[-1]["id"]

GMAIL_API = "https://gmail.googleapis.com/gmail/v1"


def log(msg):
    """Progress only. Never print email content — Actions logs on a public repo are public."""
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


class DigestError(Exception):
    pass


# ── Gmail ────────────────────────────────────────────────────────────────────

def gmail_access_token():
    """Trade the long-lived refresh token for a one-hour access token."""
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["GMAIL_CLIENT_ID"],
        "client_secret": os.environ["GMAIL_CLIENT_SECRET"],
        "refresh_token": os.environ["GMAIL_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }, timeout=30)
    if r.status_code != 200:
        raise DigestError(f"Gmail token refresh failed ({r.status_code}): {r.text[:200]}")
    return r.json()["access_token"]


def gmail_fetch_recent(token):
    hdr = {"Authorization": f"Bearer {token}"}
    ids, page = [], ""
    while len(ids) < MAX_EMAILS:
        params = {"q": WINDOW_QUERY, "maxResults": min(100, MAX_EMAILS - len(ids))}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{GMAIL_API}/users/me/messages", headers=hdr, params=params, timeout=30)
        if r.status_code == 401:
            raise DigestError("Gmail rejected the token — run backend/gmail_auth.py again.")
        if not r.ok:
            raise DigestError(f"Gmail list failed ({r.status_code}).")
        j = r.json()
        ids += [m["id"] for m in j.get("messages", [])]
        page = j.get("nextPageToken", "")
        if not page:
            break
    log(f"fetching {len(ids)} emails")

    def one(mid):
        try:
            r = requests.get(f"{GMAIL_API}/users/me/messages/{mid}", headers=hdr,
                             params={"format": "full"}, timeout=30)
            return parse_message(r.json()) if r.ok else None
        except Exception:
            return None   # one bad message is skipped, not fatal

    with cf.ThreadPoolExecutor(max_workers=FETCH_PARALLEL) as ex:
        emails = [e for e in ex.map(one, ids) if e]
    emails.sort(key=lambda e: -e["date"])
    return emails


def header(msg, name):
    for h in (msg.get("payload") or {}).get("headers") or []:
        if (h.get("name") or "").lower() == name.lower():
            return str(h.get("value") or "")
    return ""


def decode_body(data):
    if not data:
        return ""
    try:
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
    except Exception:
        return ""


class _TextExtractor(HTMLParser):
    """HTML → text: drop script/style, keep links as 'text (href)', and put newlines
    around block elements so the model sees structure."""
    SKIP = {"script", "style", "head", "title", "noscript"}
    BLOCK = {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "br"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.href, self.link_text = [], 0, None, []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag == "a":
            href = dict(attrs).get("href") or ""
            self.href = href if re.match(r"^https?://", href, re.I) and len(href) <= 300 else None
            self.link_text = []
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag == "a":
            txt = "".join(self.link_text).strip()
            if self.href and txt and not re.match(r"^https?://", txt, re.I):
                self.out.append(f"{txt} ({self.href})")
            else:
                self.out.append(txt)
            self.href, self.link_text = None, []
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.skip:
            return
        if self.href is not None:
            self.link_text.append(data)
        else:
            self.out.append(data)


def html_to_text(h):
    if not h:
        return ""
    try:
        p = _TextExtractor()
        p.feed(h)
        p.close()
        return "".join(p.out)
    except Exception:
        return re.sub(r"<[^>]+>", " ", re.sub(r"<(style|script)[\s\S]*?</\1>", "", h, flags=re.I))


def clean_text(t):
    t = (t or "").replace("\u00a0", " ")
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def body_text(payload):
    plain, htm = "", ""

    def walk(p):
        nonlocal plain, htm
        if not p:
            return
        mime = (p.get("mimeType") or "").lower()
        data = (p.get("body") or {}).get("data")
        if mime == "text/plain" and data and not plain:
            plain = decode_body(data)
        elif mime == "text/html" and data and not htm:
            htm = decode_body(data)
        for part in p.get("parts") or []:
            walk(part)

    walk(payload)
    return clean_text(plain if plain.strip() else html_to_text(htm))


def parse_message(msg):
    return {
        "id": msg.get("id"),
        "from": header(msg, "From"),
        "subject": header(msg, "Subject") or "(no subject)",
        "listId": header(msg, "List-Id"),
        "date": int(msg.get("internalDate") or 0) or int(time.time() * 1000),
        "text": body_text(msg.get("payload")) or msg.get("snippet", ""),
    }


def classify(e, sections):
    """Cheap routing, see the section notes above; the model only summarizes within a section."""
    meta = f"{(e['from'] or '').lower()} {e['subject'] or ''}"
    body = (e["text"] or "")[:600]
    for s in sections:
        if s["rx"] and (s["rx"].search(meta) or (s["body"] and s["rx"].search(body))):
            return s["id"]
    if PROMO_RX.search(e["subject"] or ""):
        return "skip"
    if e["listId"]:
        for s in sections:
            if s["lists"]:
                return s["id"]
    for s in sections:
        if not s["keywords"]:
            return s["id"]
    return "skip"


# ── model ────────────────────────────────────────────────────────────────────

class LLM:
    """Thin client for any OpenAI-compatible server (llama-server, vLLM, Ollama's /v1)."""

    def __init__(self, base, model=None):
        self.base = base.rstrip("/")
        self.model = model or self._discover()

    def _discover(self):
        try:
            d = requests.get(f"{self.base}/v1/models", timeout=10).json().get("data") or []
            return d[0]["id"] if d else "local"
        except Exception:
            return "local"

    def chat(self, system, user, max_tokens=1400, schema=None, temperature=0.3):
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }
        if schema:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "tasks", "schema": schema}}
        r = requests.post(f"{self.base}/v1/chat/completions", json=body, timeout=20 * 60)
        if r.status_code == 400 and schema:
            # server without grammar support — fall back to plain JSON mode
            body["response_format"] = {"type": "json_object"}
            r = requests.post(f"{self.base}/v1/chat/completions", json=body, timeout=20 * 60)
        if not r.ok:
            raise DigestError(f"model call failed ({r.status_code}): {r.text[:200]}")
        msg = r.json()["choices"][0]["message"]
        txt = msg.get("content") or ""
        # Qwen3.5 thinking is turned off at the server, but strip a stray block just in case.
        txt = re.sub(r"<think>[\s\S]*?</think>", "", txt).strip()
        return txt


# ── build ────────────────────────────────────────────────────────────────────

def chunk(emails, per_email_budget):
    chunks, cur, size = [], [], 0
    for e in emails:
        text = (e["text"] or "")[:per_email_budget]
        ln = len(text) + 200
        if cur and size + ln > CHUNK_CHARS:
            chunks.append(cur)
            cur, size = [], 0
        cur.append({**e, "text": text})
        size += ln
    if cur:
        chunks.append(cur)
    return chunks


def email_block(e, i):
    when = dt.datetime.fromtimestamp(e["date"] / 1000).strftime("%b %-d, %-I:%M %p")
    return f"### Email {i + 1}\nFrom: {e['from']}\nSubject: {e['subject']}\nDate: {when}\n\n{e['text'] or '(empty)'}"


def split_overview(md):
    m = re.search(r"^##\s*✅", md, re.M)
    if not m:
        return md.strip(), ""
    return md[:m.start()].strip(), md[m.start():].strip()


def strip_emoji(title):
    return re.sub(r"^[^\w\s]+\s+", "", title)


def normalize_tasks(items, sections):
    ids, other = {s["id"] for s in sections}, fallback_section(sections)
    out, seen = [], set()
    for t in items or []:
        if not isinstance(t, dict):
            continue
        title = re.sub(r"\s+", " ", str(t.get("title") or "")).strip()[:140]
        key = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        due = str(t.get("due") or "")
        out.append({
            "title": title,
            "why": re.sub(r"\s+", " ", str(t.get("why") or "")).strip()[:200],
            "due": due if re.match(r"^\d{4}-\d{2}-\d{2}$", due) else "",
            "section": t.get("section") if t.get("section") in ids else other,
        })
    return out[:8]


def tasks_from_actions(md, sections):
    items = []
    for line in (md or "").split("\n"):
        m = re.match(r"^\s*[-*]\s*\[[ xX]?\]\s*(.+)$", line)
        if not m:
            continue
        title = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", m.group(1).replace("**", "")).strip()
        if title:
            items.append({"title": title, "why": "", "due": "", "section": ""})
    return normalize_tasks(items, sections)


def parse_tasks(raw, sections):
    txt = re.sub(r"```(?:json)?", "", raw or "").strip()
    a, b = txt.find("{"), txt.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        obj = json.loads(txt[a:b + 1])
    except Exception:
        return None
    return normalize_tasks(obj.get("tasks"), sections) if isinstance(obj, dict) and isinstance(obj.get("tasks"), list) else None


def build(llm, emails, prompts):
    secs = prompts["sections"]
    kept = [e for e in emails if e["section"] != "skip"]
    by = {s["id"]: [e for e in kept if e["section"] == s["id"]] for s in secs}
    total_calls = sum(len(chunk(by[s["id"]], s["budget"])) for s in secs) + 2
    done, sections = 0, []
    for s in secs:
        lst = by[s["id"]]
        if not lst:
            body = "_Nothing today_"
        else:
            parts = []
            for ch in chunk(lst, s["budget"]):
                done += 1
                log(f"summarizing {strip_emoji(s['title'])} ({done}/{total_calls}, {len(ch)} emails)")
                user = "\n\n---\n\n".join(email_block(e, i) for i, e in enumerate(ch))
                t0 = time.time()
                out = llm.chat(f"{prompts['rules']}\n\nSection: {s['title']}\n{s['prompt']}", user, max_tokens=1400)
                log(f"  done in {time.time() - t0:.0f}s")
                parts.append(out or "_The model returned nothing for these emails._")
            body = "\n\n".join(parts)
        sections.append({**s, "count": len(lst), "body": body})

    assembled = "\n\n".join(f"## {s['title']}\n{s['body']}" for s in sections)
    stats = (f"Emails processed: {len(emails)} ({len(emails) - len(kept)} promotional skipped). Per section: "
             + ", ".join(f"{strip_emoji(s['title'])} {s['count']}" for s in sections) + ".")

    log(f"overview ({done + 1}/{total_calls})")
    try:
        overview = llm.chat(prompts["overview"], f"{stats}\n\n{assembled[:OVERVIEW_CHARS]}", max_tokens=700)
    except DigestError:
        overview = ""
    top, actions = split_overview(overview)
    head = top if top and re.search(r"^##", top, re.M) else f"## 🔝 Top of the inbox\n{top or stats}"

    log(f"tasks ({done + 2}/{total_calls})")
    today = dt.date.today()
    date_line = f"Today is {today.isoformat()} ({today.strftime('%A')})."
    tasks = None
    try:
        raw = llm.chat(prompts["tasks"].replace("{sections}", "|".join(s["id"] for s in secs)),
                       f"{date_line}\n\n{assembled[:OVERVIEW_CHARS]}\n\n{actions}",
                       max_tokens=900, schema=tasks_schema(secs), temperature=0.1)
        tasks = parse_tasks(raw, secs)
    except DigestError:
        tasks = None
    if tasks is None:
        tasks = tasks_from_actions(actions, secs)

    return "\n\n".join(x for x in (head, assembled) if x), tasks


# ── Firebase ─────────────────────────────────────────────────────────────────

def firebase_service_account():
    """The secret is the downloaded key file pasted whole; also accept it base64-encoded."""
    raw = (os.environ.get("FIREBASE_SERVICE_ACCOUNT") or "").strip()
    if not raw:
        raise DigestError("FIREBASE_SERVICE_ACCOUNT is empty. Add it under Settings → Secrets (not Variables): "
                          "the whole JSON key file from Firebase → Project settings → Service accounts.")
    if not raw.startswith("{"):
        try:
            raw = base64.b64decode(raw).decode("utf-8").strip()
        except Exception:
            pass
    try:
        info = json.loads(raw)
    except Exception:
        raise DigestError("FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the key file's full contents, "
                          "starting with { and ending with }.")
    for k in ("type", "project_id", "private_key", "client_email"):
        if k not in info:
            raise DigestError(f"FIREBASE_SERVICE_ACCOUNT is missing '{k}' — is it the service-account key file?")
    return info


def firebase_token():
    from google.oauth2 import service_account
    import google.auth.transport.requests
    info = firebase_service_account()
    creds = service_account.Credentials.from_service_account_info(info, scopes=[
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/firebase.database",
    ])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token, info["project_id"]


def firebase_db(project):
    return os.environ.get("FIREBASE_DB_URL") or f"https://{project}-default-rtdb.firebaseio.com"


def firebase_prompts(token, project):
    """users/<uid>/digestPrompts, written by the app's Settings editor. Returns None if unset."""
    uid = os.environ["WORKY_UID"]
    r = requests.get(f"{firebase_db(project)}/users/{uid}/digestPrompts.json",
                     params={"access_token": token}, timeout=30)
    if not r.ok:
        raise DigestError(f"Firebase read failed ({r.status_code}): {r.text[:200]}")
    return r.json()


def load_prompts(token=None, project=None):
    """Originals from prompts.json, overlaid with the edits saved in the app.
    A failed read never fails the run — it just falls back to the originals."""
    defaults = load_default_prompts()
    if not token:
        log("prompts: originals (no Firebase access on this run)")
        return defaults
    try:
        prompts, edited = merge_prompts(defaults, firebase_prompts(token, project))
    except Exception as e:
        log(f"prompts: could not read saved edits ({e}); using the originals")
        return defaults
    log(f"prompts: saved edits for {', '.join(edited)}" if edited else "prompts: originals")
    log("sections: " + ", ".join(f"{strip_emoji(s['title'])} ({s['id']})" for s in prompts["sections"]))
    return prompts


def firebase_deliver(payload):
    """Write the digest. A service-account access token lives for one hour and
    the model step can take longer than that on a slow runner, so always mint a
    fresh token here instead of reusing the one from the pre-flight check — and
    if Firebase still says 401 (clock skew, revoked key), mint once more and retry."""
    token, project = firebase_token()
    uid = os.environ["WORKY_UID"]
    url = f"{firebase_db(project)}/users/{uid}/digestInbox.json"
    r = requests.put(url, params={"access_token": token}, json=payload, timeout=30)
    if r.status_code == 401:
        log("firebase: token rejected, minting a fresh one and retrying")
        token, _ = firebase_token()
        r = requests.put(url, params={"access_token": token}, json=payload, timeout=30)
    if not r.ok:
        raise DigestError(f"Firebase write failed ({r.status_code}): {r.text[:200]}")


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="skip the Firebase write; save digest.md locally")
    ap.add_argument("--out", default="digest.md")
    args = ap.parse_args()

    # Check everything that can be checked cheaply BEFORE spending 30 minutes on the model.
    missing = [k for k in ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN") if not os.environ.get(k)]
    if not args.dry_run:
        missing += [k for k in ("FIREBASE_SERVICE_ACCOUNT", "WORKY_UID") if not os.environ.get(k)]
    if missing:
        raise DigestError("Missing secrets: " + ", ".join(missing) + " (Settings → Secrets and variables → Actions → Secrets tab).")
    fb_token = fb_project = None
    if not args.dry_run:
        fb_token, fb_project = firebase_token()
        log(f"firebase: service account ok (project {fb_project}, uid …{os.environ['WORKY_UID'][-4:]})")
    elif os.environ.get("FIREBASE_SERVICE_ACCOUNT") and os.environ.get("WORKY_UID"):
        try:   # a dry run should test the prompts you actually saved
            fb_token, fb_project = firebase_token()
        except Exception as e:
            log(f"firebase: not reachable on this dry run ({e})")
    prompts = load_prompts(fb_token, fb_project)   # read now, before the long model step

    llm = LLM(os.environ.get("LLM_URL", "http://127.0.0.1:8080"), os.environ.get("LLM_MODEL"))
    log(f"model: {llm.model}")

    emails = gmail_fetch_recent(gmail_access_token())
    if not emails:
        raise DigestError("No emails in the last 24 hours.")
    counts = {}
    for e in emails:
        e["section"] = classify(e, prompts["sections"])
        counts[e["section"]] = counts.get(e["section"], 0) + 1
    log(f"{len(emails)} emails → {counts}")

    t0 = time.time()
    markdown, tasks = build(llm, emails, prompts)
    log(f"digest built in {(time.time() - t0) / 60:.1f} min, {len(markdown)} chars, {len(tasks)} task candidates")

    payload = {
        "at": int(time.time() * 1000),
        "markdown": markdown[:120000],
        "count": len(emails),
        "model": llm.model[:80],
        "source": "github",
        "tasks": tasks,
    }
    if args.dry_run:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(markdown + "\n\n<!-- tasks: " + json.dumps(tasks, ensure_ascii=False) + " -->\n")
        log(f"dry run — wrote {args.out}, skipped Firebase")
        return
    firebase_deliver(payload)
    log("delivered to Firebase ✓")


if __name__ == "__main__":
    try:
        main()
    except DigestError as e:
        log(f"FAILED: {e}")
        sys.exit(1)
