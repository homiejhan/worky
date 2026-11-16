/* worker.mjs — Starts the email digest on time every morning.
 *
 * The digest runs on GitHub Actions (.github/workflows/digest.yml). GitHub's own
 * schedule for it is best-effort, and in practice it has started the digest hours
 * late every day (5½ typically, up to 10). A Cloudflare Cron Trigger runs on the minute, so this
 * Worker starts the workflow the way Run now in the app does (a
 * workflow_dispatch through GitHub's API) at START_HOUR:00 in TIME_ZONE. The cron
 * fires every hour on the hour and the Worker acts only on the one that is START_HOUR
 * there, so the change to and from daylight saving time needs no edit.
 *
 * GitHub's schedule stays in digest.yml as the backup. It builds a digest only
 * if none has come in that day, so a morning this Worker misses still gets one
 * (late) and a morning it starts doesn't get a second.
 *
 * Settings (wrangler.toml [vars], and one secret):
 *   GITHUB_TOKEN  secret: a fine-grained token for this repository only, with
 *                 Actions: Read and write.   npx wrangler secret put GITHUB_TOKEN
 *   REPO          owner/name, e.g. homiejhan/worky
 *   WORKFLOW      the workflow file, digest.yml
 *   TIME_ZONE     an IANA time zone, e.g. America/Chicago
 *   START_HOUR    0–23 in TIME_ZONE; the digest starts on the hour
 *
 * If GitHub can't be reached or answers 429 or 5xx, the Worker tries twice more,
 * 30 s and then 60 s later. A refusal (a bad or expired token, the wrong
 * repository) is not retried. Either way a failure is thrown, so Cloudflare's
 * dashboard shows that morning's event as failed, with the reason. */

/* The hour (0–23) at `ms` in `timeZone`. */
export function localHour(ms, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).find(p => p.type === 'hour');
  return Number(part && part.value);
}

/* Is the cron event scheduled for `ms` the morning's start? */
export function isStartTime(ms, env) {
  return localHour(ms, env.TIME_ZONE) === Number(env.START_HOUR);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Ask GitHub to start the workflow. Resolves to { status, attempts }; throws why not. */
export async function startDigest(env, { fetchFn = fetch, wait = sleep, tries = 3 } = {}) {
  const token = String(env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('No GitHub token yet. Set it once from backend/digest-trigger: npx wrangler secret put GITHUB_TOKEN');
  const url = `https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;
  for (let attempt = 1; ; attempt++) {
    let status = 0, detail = '';
    try {
      const r = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'focus-digest-trigger',     // GitHub turns away API requests without one
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: env.REF || 'main' }),
      });
      if (r.ok) return { status: r.status, attempts: attempt };
      status = r.status;
      detail = String(await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);   // GitHub's JSON comes pretty-printed
    } catch (e) {
      detail = (e && e.message) || String(e);
    }
    const passing = status === 0 || status === 429 || status >= 500;
    if (!passing || attempt >= tries) throw new Error(refusal(status, detail, env, attempt));
    await wait(attempt * 30000);
  }
}

function refusal(status, detail, env, attempts) {
  const tried = attempts > 1 ? ` (tried ${attempts} times)` : '';
  if (status === 0) return `Could not reach GitHub${tried}: ${detail}`;
  if (status === 401 || status === 403) {
    return `GitHub turned the token down (${status}). It needs Actions: Read and write on ${env.REPO}, `
      + `and it may have expired: make a new one and run npx wrangler secret put GITHUB_TOKEN. ${detail}`;
  }
  if (status === 404) return `GitHub can't find ${env.WORKFLOW} in ${env.REPO} (404). Is the token for that repository? ${detail}`;
  return `GitHub didn't start ${env.WORKFLOW} (${status})${tried}: ${detail}`;
}

export default {
  async scheduled(controller, env) {
    if (!isStartTime(controller.scheduledTime, env)) return;
    const { attempts } = await startDigest(env);
    console.log(`Started ${env.WORKFLOW} on ${env.REPO}${attempts > 1 ? ` (try ${attempts})` : ''}.`);
  },
  /* It has no page: it only runs on its schedule. */
  async fetch() {
    return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  },
};
