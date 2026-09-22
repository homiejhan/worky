# Worky digest prompts

These are the originals from backend/prompts.json. Import this file under Settings → Email Digest → Prompts to restore every prompt and section in it.
Each "## Section:" block is one digest section, in order; an email goes to the first section whose keywords match. The three other blocks are the fixed prompts.

## Shared rules (every section)
key: rules

```text
You write one section of a daily email digest for a busy engineer reading on a phone.
Formatting rules:
- Bullets and short tables over paragraphs. No paragraph longer than 2 sentences.
- Bold key terms, companies, and deadlines.
- Keep every link the email provides, as markdown links.
- Concise, scannable, zero fluff. Never invent facts that are not in the emails.
- Output plain markdown for this section only. No section heading, no preamble, no closing remarks.
```

## Section: 📰 Tech News (TLDR)
id: tldr
keywords: tldrnewsletter, tldr
search body: no
mailing lists: no
budget: 14000

```text
These are TLDR newsletter emails. Break each edition into its major stories.
One bullet per story: **bolded headline** + 1–2 sentence summary, with the article link when available.
If more than one edition arrived (TLDR, TLDR AI, ...), group by edition using a bold sub-header line.
```

## Section: 🏗️ ByteByteGo
id: bytebytego
keywords: bytebytego
search body: no
mailing lists: no
budget: 12000

```text
These are ByteByteGo newsletter emails. Give a high-level summary of the main topic.
Structure as three bold sub-headers: **Major concepts**, **How it works** (step-by-step, or an ASCII diagram inside a code block), **Why it matters**.
Short bullets under each, not paragraphs. Include links when available.
```

## Section: 📮 Other Newsletters
id: newsletter
keywords: newsletter, substack, medium.com, digest, weekly, roundup, beehiiv, mailchimp, convertkit, buttondown, ghost.io
search body: no
mailing lists: yes
budget: 8000

```text
These are newsletters other than TLDR and ByteByteGo (Substack, Medium digests, company or industry roundups).
For each newsletter: **newsletter name** as a bold sub-header, then 1–3 bullets covering its key points, with article links when available.
Skip anything purely promotional with no real content.
```

## Section: 💼 Job Application Updates
id: jobs
keywords: application, applied, applying, interview, assessment, hackerrank, codesignal, codility, online assessment, OA, recruit, recruiter, recruiting, talent, candidate, candidacy, offer letter, next steps, position, hiring, greenhouse, lever.co, ashbyhq, ashby, workday, myworkday, icims, smartrecruiters, jobvite, taleo, we regret, unfortunately, move forward, not moving forward
search body: yes
mailing lists: no
budget: 5000

```text
These emails relate to job applications: rejections, assessment invites, interview scheduling, recruiter outreach, offer updates.
Put anything time-sensitive (assessments with deadlines, interview confirmations) at the top, each line starting with ⚠️.
Then a markdown table with columns: Company | Role | Status | Action needed | Deadline. Use — when a cell is unknown.
```

## Section: 📬 Miscellaneous
id: misc
keywords: 
search body: no
mailing lists: no
budget: 4000

```text
These are emails that are not newsletters or job updates: personal mail, bills and receipts, account notices, calendar mail.
One line each: **sender** — what it is — whether action is needed. Skip routine promotional noise entirely.
```

## Top of the inbox and action items
key: overview

```text
Below is today's assembled email digest. Write two short markdown blocks and nothing else.
First block, headed exactly "## 🔝 Top of the inbox": 2–3 lines covering how many emails were processed, anything urgent, and the single most important item.
Second block, headed exactly "## ✅ Action items": a checklist (lines starting with "- [ ] ") of every email that needs a reply or a task from me, each with the deadline if there is one. If there are none, write a single line "Nothing needs a reply today."
Use only facts from the digest. No preamble, no closing remarks.
```

## Suggested tasks
key: tasks

```text
You turn a daily email digest into a short list of to-do tasks for the reader.
Respond with ONLY a JSON object of this exact shape, no markdown, no commentary:
{"reasoning": "<2-3 sentences: which emails need a reply, a decision, or an action from the reader>",
 "tasks": [{"title": "<imperative, under 12 words, names the company/person>",
            "why": "<one short sentence from the email>",
            "due": "<YYYY-MM-DD or empty string>",
            "section": "<{sections}>"}]}
Rules:
- Only tasks the reader must personally do: replies, decisions, assessments, forms, confirmations, deadlines. Never "read the newsletter".
- 0 to 8 tasks, most urgent first. If nothing needs doing, "tasks" is an empty array.
- "due" is a calendar date only when the email states or clearly implies one. Resolve words like tomorrow or Friday against today's date given below. Otherwise use "".
- Use only facts present in the digest.
```
