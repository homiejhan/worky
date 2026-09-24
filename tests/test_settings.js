/* Settings master–detail — section list + one pane at a time.
 * Run: npm test (or node --experimental-vm-modules tests/test_settings.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

function boot() { return loadApp(); }
const activeSections = d => [...d.querySelectorAll('.settings-section.active')].map(s => s.dataset.settingsSection);
const activeNav = d => [...d.querySelectorAll('.settings-nav-item.active')].map(b => b.dataset.settingsNav);
const KEYS = 'views,appearance,gcal,sync,digest,help,data';

(async () => {   // the app boots asynchronously now (ES modules), so the checks run in here
console.log('\n── 1. Structure: every old control still exists, in exactly one section ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  ok(d.getElementById('settingsModal').classList.contains('show'), 'gear opens Settings');
  eq([...d.querySelectorAll('[data-settings-nav]')].map(b => b.dataset.settingsNav).join(','), KEYS, 'nav lists all seven sections');
  eq([...d.querySelectorAll('[data-settings-section]')].map(s => s.dataset.settingsSection).join(','), KEYS, 'a pane exists for each nav item');
  const home = {
    settingsViewList: 'views', 'themePresets-s': 'appearance', themeOpenBtn: 'appearance',
    gcalStatusLine: 'gcal', gcalConnectBtn: 'gcal', syncStatusLine: 'sync', syncConnectBtn: 'sync',
    digestEnabledToggle: 'digest', digestStatusLine: 'digest', digestGithubToken: 'digest', digestGithubSaveBtn: 'digest',
    digestRunSettingsBtn: 'digest', digestOpenRunBtn: 'digest', digestSampleBtn: 'digest', digestClearBtn: 'digest',
    tourReplayBtn: 'help', clearStorageBtn: 'data',
  };
  Object.entries(home).forEach(([id, key]) => {
    const el = d.getElementById(id);
    ok(!!el && el.closest('[data-settings-section]')?.dataset.settingsSection === key, `#${id} lives in "${key}"`);
  });
  ok(!!d.querySelector('[data-settings-section="help"] a[href="privacy.html"]'), 'privacy link kept under Help');
  eq(d.querySelectorAll('#settingsModal .settings-section-label').length, 0, 'old stacked labels are gone');
}

console.log('\n── 2. Only one section shows at a time ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  eq(d.getElementById('settingsBox').dataset.stage, 'list', 'plain open → mobile starts on the list');
  eq(activeSections(d).join(','), 'views', 'first section is the default pane');
  eq(activeNav(d).join(','), 'views', 'and is highlighted');
  KEYS.split(',').forEach(key => {
    d.querySelector(`[data-settings-nav="${key}"]`).click();
    ok(activeSections(d).length === 1 && activeSections(d)[0] === key && activeNav(d).join(',') === key, `click "${key}" → only that pane + nav item active`);
  });
  eq(d.getElementById('settingsPaneTitle').textContent, 'Data', 'pane title follows the section');
  eq(d.getElementById('settingsBox').dataset.stage, 'detail', 'choosing a section moves mobile to the detail stage');
  ok(d.querySelector('[data-settings-nav="data"]').getAttribute('aria-current') === 'true'
     && !d.querySelector('[data-settings-nav="views"]').hasAttribute('aria-current'), 'aria-current tracks the selection');
}

console.log('\n── 3. Back button + reopen behaviour ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  d.querySelector('[data-settings-nav="appearance"]').click();
  d.getElementById('settingsBackBtn').click();
  eq(d.getElementById('settingsBox').dataset.stage, 'list', 'Back returns to the list');
  eq(activeSections(d).join(','), 'appearance', 'desktop keeps showing the section it was on');
  w.closeModal('settingsModal');
  d.getElementById('settingsBtn').click();
  eq(d.getElementById('settingsBox').dataset.stage, 'list', 'reopening starts mobile on the list again');
  eq(activeSections(d).join(','), 'appearance', 'desktop reopens on the last section');
  eq(d.querySelectorAll('[data-settings-nav]').length, 7, 'nav is not re-rendered/duplicated on reopen');
}

console.log('\n── 4. Deep links ──');
{
  const { w, d } = await boot();
  w.openSettings('digest');
  eq(d.getElementById('settingsBox').dataset.stage, 'detail', 'openSettings("digest") skips the list');
  eq(activeSections(d).join(','), 'digest', 'and lands on Email Digest');
  w.closeModal('settingsModal');
  w.openSettings('nope');
  eq(activeSections(d).join(','), 'views', 'unknown key falls back to the first section');
  w.closeModal('settingsModal');
  w.digestRunNow();
  ok(d.getElementById('settingsModal').classList.contains('show') && activeSections(d).join(',') === 'digest',
     'Run now without a token opens Settings → Email Digest directly');
}

console.log('\n── 5. Controls inside panes still work ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  d.querySelector('[data-settings-nav="views"]').click();
  const t = d.querySelector('[data-viewtoggle="budget"]');
  t.checked = false; t.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(d.querySelector('.tab-btn[data-view="budget"]').style.display === 'none', 'view toggle still hides a tab');
  eq(activeSections(d).join(','), 'views', 'toggling re-renders without leaving the section');
  d.querySelector('[data-settings-nav="appearance"]').click();
  d.querySelector('#themePresets-s [data-preset="daylight"]').click();
  eq(w.document.documentElement.style.getPropertyValue('--scheme').trim(), 'light', 'preset chip still applies a theme');
  d.getElementById('themeOpenBtn').click();
  ok(d.getElementById('themeModal').classList.contains('show') && !d.getElementById('settingsModal').classList.contains('show'), 'Customize theme still hands off to the editor');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
