/* The help page (help/index.html) and the privacy policy on it. Every link from
 * the app into help/ lands on a section that exists, every picture is there at
 * the size the page says and has alt text, no picture sits unused, the privacy
 * policy covers each kind of data Focus touches, and privacy.html sends old
 * links to it. The page is static: nothing here boots the app.
 * Run: npm test (or node tests/test_help.js) */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HELP = path.join(ROOT, 'help');
const IMG = path.join(HELP, 'img');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

/* Width and height of a WebP file, from its header (lossy, lossless or extended). */
function webpSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
  if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  return null;
}

const html = fs.readFileSync(path.join(HELP, 'index.html'), 'utf8');
const d = new JSDOM(html).window.document;
const ids = new Set([...d.querySelectorAll('[id]')].map(el => el.id));

console.log('\n── 1. Every link from the app lands on a section that exists ──');
{
  const SECTIONS = ['start', 'home', 'timers', 'lists', 'daily', 'calendar', 'google-calendar', 'budget',
    'cloud', 'bank', 'bank-setup', 'digest', 'formats', 'data', 'privacy'];
  const missing = SECTIONS.filter(id => !ids.has(id));
  eq(missing.join(','), '', `the page has all ${SECTIONS.length} sections`);

  const sources = ['index.html', ...fs.readdirSync(path.join(ROOT, 'js')).map(f => 'js/' + f)];
  const links = [];
  sources.forEach(f => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/href="help\/(#[\w-]+)?"/g)) links.push({ f, anchor: m[1] || '' });
  });
  ok(links.length >= 7, `the app links into help/ (${links.length} links)`);
  const broken = links.filter(l => l.anchor && !ids.has(l.anchor.slice(1)));
  eq(broken.map(l => `${l.f} → ${l.anchor}`).join(', '), '', 'each of them names a section on the page');
  ['#google-calendar', '#cloud', '#digest', '#privacy', '#bank', '#bank-setup'].forEach(a =>
    ok(links.some(l => l.anchor === a), `something in the app links to help/${a}`));

  const toc = [...d.querySelectorAll('nav.toc a')].map(a => a.getAttribute('href'));
  ok(toc.length >= 14, `the contents list has ${toc.length} entries`);
  eq(toc.filter(h => !h.startsWith('#') || !ids.has(h.slice(1))).join(','), '', 'every contents entry points at a section');
  const inPage = [...d.querySelectorAll('main a[href^="#"]')].map(a => a.getAttribute('href'));
  eq(inPage.filter(h => !ids.has(h.slice(1))).join(','), '', 'so does every link within the page');
}

console.log('\n── 2. Pictures ──');
{
  const imgs = [...d.querySelectorAll('img')];
  const sources = [...d.querySelectorAll('picture source')];
  ok(imgs.length >= 15, `the page has ${imgs.length} pictures`);
  const used = new Set();
  const check = (el, attr) => {
    const src = el.getAttribute(attr);
    const file = path.join(HELP, src);
    used.add(path.basename(src));
    if (!src.startsWith('img/') || !fs.existsSync(file)) return `${src}: missing`;
    const size = webpSize(file);
    if (!size) return `${src}: not a WebP file`;
    const w = Number(el.getAttribute('width')), h = Number(el.getAttribute('height'));
    if (!w || !h) return `${src}: no width/height (the page would jump as it loads)`;
    if (Math.abs(w / h - size.w / size.h) > 0.02) return `${src}: says ${w}×${h}, the file is ${size.w}×${size.h}`;
    if (fs.statSync(file).size > 150 * 1024) return `${src}: over 150 KB`;
    return null;
  };
  const problems = [...imgs.map(i => check(i, 'src')), ...sources.map(s => check(s, 'srcset'))].filter(Boolean);
  eq(problems.join('; '), '', 'every picture exists, is WebP, matches its width and height, and is under 150 KB');
  eq(imgs.filter(i => (i.getAttribute('alt') || '').trim().length < 20).map(i => i.getAttribute('src')).join(','), '',
    'every picture has alt text that says what it shows');
  ok(sources.every(s => s.getAttribute('media') === '(max-width: 640px)'), 'phone-sized versions only replace pictures on narrow screens');
  eq(imgs.slice(1).filter(i => i.getAttribute('loading') !== 'lazy').map(i => i.getAttribute('src')).join(','), '',
    'pictures below the first one load lazily');
  const unused = fs.readdirSync(IMG).filter(f => !used.has(f));
  eq(unused.join(','), '', 'no picture in help/img sits unused');
  const total = fs.readdirSync(IMG).reduce((n, f) => n + fs.statSync(path.join(IMG, f)).size, 0);
  ok(total < 1.5 * 1024 * 1024, `all pictures together are ${Math.round(total / 1024)} KB (under 1.5 MB)`);
}

console.log('\n── 3. The how-tos the help page was asked for ──');
{
  const text = id => (d.getElementById(id)?.textContent || '').replace(/\s+/g, ' ');
  const cloud = text('cloud');
  ok(/Settings → Cloud sync/.test(cloud) && /Sign in with Google/.test(cloud), 'cloud sync: where to go and what to press');
  ok(/Import from cloud/.test(cloud) && /Export to cloud/.test(cloud), 'cloud sync: the Import/Export choice is explained');
  const bank = text('bank');
  ok(/Settings → Bank accounts/.test(bank) && /Connect a bank/.test(bank) && /Plaid/.test(bank), 'bank: where to go and what to press');
  ok(/npm run bank:check/.test(bank) && /npm run bank\b/.test(bank) && /http:\/\/localhost:8787\/api\/bank/.test(bank),
    'bank: how to set up the relay and prove the connection');
  ok(/user_good/.test(bank) && /pass_good/.test(bank), 'bank: the sandbox login');
  const gcal = text('google-calendar');
  ok(/Connect Google Calendar/.test(gcal) && /From URL/.test(gcal) && /paid shifts/.test(gcal), 'Google Calendar: connect, subscribe a work schedule, mark it as shifts');
  ok(d.querySelectorAll('script').length === 0, 'the page runs no scripts');
  const outside = [...d.querySelectorAll('a[target="_blank"]')].filter(a => !/noopener/.test(a.getAttribute('rel') || ''));
  eq(outside.length, 0, 'links that open a new tab use rel="noopener"');
  const local = [...d.querySelectorAll('a[href], link[rel="icon"]')].map(a => a.getAttribute('href'))
    .filter(h => !/^(https?:|mailto:|#)/.test(h));
  const exists = h => {
    let f = path.join(HELP, h.replace(/#.*$/, ''));
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    return fs.existsSync(f);
  };
  const gone = local.filter(h => !exists(h));
  eq(gone.join(','), '', 'links back into the app point at files that exist');
}

console.log('\n── 4. The privacy policy lives on the help page ──');
{
  const p = (d.getElementById('privacy')?.textContent || '').replace(/\s+/g, ' ');
  ok(/Last updated: [A-Z][a-z]+ \d{1,2}, \d{4}/.test(p), 'it carries a "Last updated" date');
  [['Google Calendar', /Google Calendar/], ['Gmail (gmail.readonly)', /gmail\.readonly/], ['cloud sync (Firebase)', /Firebase/],
    ['bank connections (Plaid)', /Plaid/], ['the relay keeps nothing', /relay[^.]*(keeps none|has no database)/],
    ['bank data never synced', /never synced/], ['Limited Use', /Limited Use/], ['how to delete', /Retention and deletion/],
    ['revoking Google access', /myaccount\.google\.com\/permissions/], ['ending bank connections', /my\.plaid\.com/],
    ['a contact address', /justhan47@gmail\.com/]]
    .forEach(([what, re]) => ok(re.test(p), `it covers ${what}`));

  const redirect = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  ok(/<meta http-equiv="refresh" content="0; url=help\/#privacy">/.test(redirect), 'privacy.html forwards to help/#privacy');
  ok(/location\.replace\('help\/#privacy'\)/.test(redirect), 'without adding a step to the back button');
  ok(/<a href="help\/#privacy">/.test(redirect), 'and links there for browsers that do neither');
  ok(!/Gmail|Firebase/.test(redirect), 'the old copy of the policy is gone (one policy, one place)');
}

console.log('\n── 5. The app reaches the help page ──');
{
  const app = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')).window.document;
  const help = app.querySelector('[data-settings-section="help"]');
  eq(help?.querySelector('#helpOpenLink')?.getAttribute('href'), 'help/', 'Settings → Help has "Open the help page"');
  ok(!!help?.querySelector('a[href="help/#privacy"]'), 'and the privacy policy link');
  [['gcal', 'help/#google-calendar'], ['sync', 'help/#cloud'], ['digest', 'help/#digest']].forEach(([key, href]) =>
    ok(!!app.querySelector(`[data-settings-section="${key}"] a[href="${href}"]`), `Settings → ${key} links to ${href}`));
  const bank = fs.readFileSync(path.join(ROOT, 'js/bank.js'), 'utf8');
  ok(/href="help\/#bank-setup"/.test(bank) && /href="help\/#bank"/.test(bank), 'Settings → Bank accounts links to its setup and how-to sections');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok(/'\.\/help\/'/.test(sw), 'the service worker keeps the help page for offline use');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
