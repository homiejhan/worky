/* The email digest's morning start: backend/digest-trigger/worker.mjs (a Cloudflare
 * Worker on an hourly cron) starts digest.yml at 5:00 am Central, and the
 * workflow's own GitHub schedule stays as a backup that builds only when no
 * digest came in that day (digest.py --delivered-today). GitHub is never
 * called: fetch is stubbed.
 * Run: npm test -- digest_trigger (or node tests/test_digest_trigger.js) */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
async function rejects(promise) { try { await promise; return null; } catch (e) { return e; } }

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const toml = read('backend/digest-trigger/wrangler.toml');
const tomlVar = name => (toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm')) || [])[1];
const ENV = { REPO: tomlVar('REPO'), WORKFLOW: tomlVar('WORKFLOW'), TIME_ZONE: tomlVar('TIME_ZONE'),
  START_HOUR: tomlVar('START_HOUR'), GITHUB_TOKEN: 'github_pat_test' };
const at = iso => Date.parse(iso);

/* A stand-in for GitHub: answers each call from `replies` in turn (a status, or 'down' to throw). */
function fakeGithub(replies) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply === 'down') throw new TypeError('Network connection lost.');
    return new Response(reply === 204 ? null : JSON.stringify({ message: `status ${reply}` }), { status: reply });
  };
  return { calls, fetchFn };
}

(async () => {
  const worker = await import(pathToFileURL(path.join(ROOT, 'backend/digest-trigger/worker.mjs')).href);
  const { localHour, isStartTime, startDigest } = worker;
  const handler = worker.default;

  console.log('\n── 1. It starts the digest once a morning, at 5:00 Central, all year ──');
  const hourly = day => [...Array(24).keys()].map(h => at(`${day}T${String(h).padStart(2, '0')}:00:00Z`));   // the cron's events: 0 * * * *
  const startsOn = (day, env = ENV) => hourly(day).filter(ms => isStartTime(ms, env)).map(ms => new Date(ms).toISOString().slice(11, 16));
  eq(startsOn('2026-11-16').join(), '11:00', 'in winter (CST): 11:00 UTC, the one cron event that is 5:00 there');
  eq(startsOn('2026-07-15').join(), '10:00', 'in summer (CDT): 10:00 UTC');
  eq(startsOn('2026-03-08').join(), '10:00', 'the day clocks go forward (2 am that morning): 10:00 UTC');
  eq(startsOn('2026-11-01').join(), '11:00', 'the day clocks go back (2 am that morning): 11:00 UTC');
  eq(localHour(at('2026-11-16T11:30:00Z'), 'America/Chicago'), 5, 'localHour: 11:30 UTC in November is 5 in Chicago');
  eq(localHour(at('2026-11-16T06:30:00Z'), 'America/Chicago'), 0, 'localHour: midnight is 0, not 24');
  const perDay = new Map();
  for (let ms = at('2026-01-01T00:00:00Z'); ms < at('2027-01-01T00:00:00Z'); ms += 3600e3) {
    if (!isStartTime(ms, ENV)) continue;
    const local = new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false });
    const [date, time] = local.split(', ');
    perDay.set(date, (perDay.get(date) || []).concat(time));
  }
  ok(perDay.size === 365 && [...perDay.values()].every(t => t.length === 1 && t[0] === '05:00:00'),
    `every day of 2026 gets exactly one start, at 05:00:00 local (${perDay.size} days)`);
  eq(startsOn('2026-11-16', { ...ENV, START_HOUR: '4' }).join(), '10:00', 'START_HOUR "4" moves it to 4:00 local');

  console.log('\n── 2. What it asks GitHub for ──');
  const realFetch = globalThis.fetch;
  try {
    let gh = fakeGithub([204]);
    globalThis.fetch = gh.fetchFn;
    await handler.scheduled({ scheduledTime: at('2026-11-16T10:00:00Z'), cron: '0 * * * *' }, ENV, {});
    eq(gh.calls.length, 0, 'at 4:00 am it does nothing');
    await handler.scheduled({ scheduledTime: at('2026-11-16T12:00:00Z'), cron: '0 * * * *' }, ENV, {});
    eq(gh.calls.length, 0, 'nor at 6:00');
    await handler.scheduled({ scheduledTime: at('2026-11-16T11:00:00Z'), cron: '0 * * * *' }, ENV, {});
    eq(gh.calls.length, 1, 'at 5:00 am it makes one request');
    const c = gh.calls[0] || { init: { headers: {} }, body: {} };
    eq(c.url, 'https://api.github.com/repos/homiejhan/worky/actions/workflows/digest.yml/dispatches', 'to start digest.yml, as Run now does');
    eq(c.init.method, 'POST', 'a POST');
    eq(c.init.headers.Authorization, 'Bearer github_pat_test', 'with the token');
    eq(c.init.headers.Accept, 'application/vnd.github+json', 'GitHub\'s media type');
    eq(c.init.headers['X-GitHub-Api-Version'], '2022-11-28', 'a pinned API version');
    ok(!!c.init.headers['User-Agent'], 'and a User-Agent, which GitHub requires');
    eq(JSON.stringify(c.body), '{"ref":"main"}', 'on main');

    gh = fakeGithub([204]);
    globalThis.fetch = gh.fetchFn;
    await handler.scheduled({ scheduledTime: at('2026-11-16T11:00:00Z') }, { ...ENV, GITHUB_TOKEN: '  github_pat_test\n' }, {});
    eq((gh.calls[0] || { init: { headers: {} } }).init.headers.Authorization, 'Bearer github_pat_test', 'a token pasted with spaces or a newline still works');

    gh = fakeGithub([401]);
    globalThis.fetch = gh.fetchFn;
    const e = await rejects(handler.scheduled({ scheduledTime: at('2026-11-16T11:00:00Z') }, ENV, {}));
    ok(e && /Actions: Read and write/.test(e.message), 'a refusal fails the cron event, so Cloudflare shows it, with the reason');

    console.log('\n── 3. When GitHub says no or can\'t be reached ──');
    const tryWith = async (replies, env = ENV) => {
      const g = fakeGithub(replies), waits = [];
      const r = await startDigest(env, { fetchFn: g.fetchFn, wait: async ms => { waits.push(ms); } }).catch(err => err);
      return { r, calls: g.calls.length, waits: waits.join() };
    };
    let t = await tryWith([204], { ...ENV, GITHUB_TOKEN: '' });
    ok(t.r instanceof Error && /wrangler secret put GITHUB_TOKEN/.test(t.r.message) && t.calls === 0, 'no token: says how to set it, asks GitHub nothing');
    t = await tryWith([502, 204]);
    ok(!(t.r instanceof Error) && t.r.attempts === 2 && t.waits === '30000', 'a 502 is tried again 30 s later and then starts it');
    t = await tryWith(['down', 204]);
    ok(!(t.r instanceof Error) && t.r.attempts === 2, 'so is a dropped connection');
    t = await tryWith([429, 204]);
    ok(!(t.r instanceof Error) && t.r.attempts === 2, 'and a 429 (too many requests)');
    t = await tryWith([503, 503, 503]);
    ok(t.r instanceof Error && /tried 3 times/.test(t.r.message) && t.calls === 3 && t.waits === '30000,60000',
      'three failures in a row: gives up after 30 s and 60 s waits, and says so');
    t = await tryWith([401]);
    ok(t.r instanceof Error && /Actions: Read and write/.test(t.r.message) && /expired/.test(t.r.message) && t.calls === 1 && t.waits === '',
      'a rejected token (401) is not retried; the message says what the token needs');
    t = await tryWith([403]);
    ok(t.r instanceof Error && t.calls === 1, 'nor is a 403');
    t = await tryWith([404]);
    ok(t.r instanceof Error && /Is the token for that repository/.test(t.r.message) && t.calls === 1, 'a 404 (token for another repository) is not retried');
    t = await tryWith([422]);
    ok(t.r instanceof Error && /\(422\)/.test(t.r.message) && t.calls === 1, 'nor is a 422');

    console.log('\n── 4. It has no page ──');
    gh = fakeGithub([204]);
    globalThis.fetch = gh.fetchFn;
    const res = await handler.fetch(new Request('https://focus-digest-trigger.example.workers.dev/'), ENV, {});
    ok(res.status === 404 && gh.calls.length === 0, 'a visit gets a 404 and starts nothing');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\n── 5. Its settings, the app\'s and the workflow\'s agree ──');
  const config = read('js/config.js');
  const configVal = name => (config.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`)) || [])[1];
  eq(ENV.REPO, configVal('DIGEST_GITHUB_REPO'), 'REPO is the repository Run now starts');
  eq(ENV.WORKFLOW, configVal('DIGEST_GITHUB_WORKFLOW'), 'WORKFLOW is the workflow Run now starts');
  eq(ENV.TIME_ZONE, 'America/Chicago', 'Central time');
  eq(ENV.START_HOUR, '5', '5:00 am');
  ok(/^crons\s*=\s*\["0 \* \* \* \*"\]/m.test(toml), 'the cron fires every hour on the hour');
  ok(/^main\s*=\s*"worker\.mjs"/m.test(toml), 'wrangler deploys worker.mjs');
  ok(!/^GITHUB_TOKEN\s*=/m.test(toml) && !/github_pat_|ghp_/.test(toml), 'no token in wrangler.toml');

  const yml = read('.github/workflows/digest.yml');
  ok(/^\s+workflow_dispatch:/m.test(yml), 'digest.yml can be started through the API (workflow_dispatch)');
  const [bm, bh] = ((yml.match(/^\s+- cron: "(\d+) (\d+) \* \* \*"/m) || []).slice(1)).map(Number);
  eq(`${bh}:${bm}`, '11:30', 'its GitHub schedule stays as it was, as the backup, at 11:30 UTC');
  const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  ok(['2026-11-16', '2026-07-15', '2026-03-08', '2026-11-01'].every(day => minutes(startsOn(day)[0]) <= bh * 60 + bm - 30),
    'at least half an hour after the morning start all year, so a backup GitHub happens to run on time can\'t build ahead of it');
  ok(/^concurrency:\n  group: digest\n  cancel-in-progress: false/m.test(yml), 'and one run at a time: a backup waits for the morning run, then finds its digest');
  const due = (yml.match(/\n  due:\n([\s\S]*?)\n  digest:\n/) || [])[1] || '';
  ok(/^\s+continue-on-error: true/m.test(due), 'a check that breaks doesn\'t fail the run');
  ok(/^\s+if: github\.event_name == 'schedule'$/m.test(due), 'the check runs only for a scheduled (backup) run');
  ok(/python backend\/digest\.py --delivered-today/.test(due), 'and asks digest.py whether today\'s digest came in');
  ok(/skip: \$\{\{ steps\.today\.outputs\.skip \}\}/.test(due) && /id: today/.test(due), 'its answer is the job\'s skip output');
  ok(/TZ: America\/Chicago/.test(due), '"today" is Central time');
  const digestJob = yml.split('\n  digest:\n')[1] || '';
  ok(/^\s+needs: due$/m.test(digestJob), 'the digest job waits for the check');
  ok(/^\s+if: \$\{\{ !cancelled\(\) && needs\.due\.outputs\.skip != 'true' \}\}$/m.test(digestJob),
    'and builds unless it said skip: Run now and the morning start (check skipped) and a failed check all build');

  const py = read('backend/digest.py');
  ok(/add_argument\("--delivered-today"/.test(py), 'digest.py takes --delivered-today');
  ok(/GITHUB_OUTPUT/.test(py) && /skip=/.test(py), 'and writes skip=true|false for the workflow');
  ok(/digestInbox\/at\.json/.test(py), 'from the newest delivery\'s time, users/<uid>/digestInbox/at');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
