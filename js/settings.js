/* settings.js — The Settings modal. */
import { $ } from './util.js';
import { saveToLocal } from './persistence.js';
import { applyViewVisibility, VIEW_DEFS, viewEnabled, views } from './views.js';
import { gcalIsConnected, gcalUpdateBtn } from './gcal.js';
import { syncUpdateUI } from './sync.js';
import { renderThemePresets } from './theme.js';
import { digestRenderSettings } from './digest.js';
import { bankRenderSettings } from './bank.js';

/* ── Settings ──
 * Master–detail. SETTINGS_SECTIONS drives the section list (#settingsNav);
 * each key matches one <section data-settings-section> in #settingsPane and
 * only the active one is shown. Desktop shows list + pane side by side. On
 * mobile #settingsBox[data-stage] flips between the list ('list') and the
 * open section ('detail'), with a back button — CSS decides which applies,
 * so JS never needs to know the breakpoint. */
const SETTINGS_SECTIONS = [
  { key: 'views',      label: 'Sections',        desc: 'Show or hide tabs',
    icon: '<rect x="2.2" y="2.2" width="4.8" height="4.8" rx="1.3" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="2.2" width="4.8" height="4.8" rx="1.3" stroke="currentColor" stroke-width="1.5"/><rect x="2.2" y="9" width="4.8" height="4.8" rx="1.3" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="4.8" height="4.8" rx="1.3" stroke="currentColor" stroke-width="1.5"/>' },
  { key: 'appearance', label: 'Appearance',      desc: 'Theme, colors and fonts',
    icon: '<circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor"/>' },
  { key: 'gcal',       label: 'Google Calendar', desc: 'See and send events',
    icon: '<rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12" stroke="currentColor" stroke-width="1.5"/><path d="M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
  { key: 'bank',       label: 'Bank accounts',   desc: 'Balances and transactions',
    icon: '<path d="M2 6.2L8 2.6l6 3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.6 7.4v4.6M6.5 7.4v4.6M9.5 7.4v4.6M12.4 7.4v4.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2 13.6h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
  { key: 'sync',       label: 'Cloud sync',      desc: 'Keep your devices in step',
    icon: '<path d="M4.7 12.6h6.7a2.6 2.6 0 0 0 .5-5.15 3.9 3.9 0 0 0-7.55.85 2.2 2.2 0 0 0 .35 4.3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' },
  { key: 'digest',     label: 'Email Digest',    desc: 'Morning summary on Home',
    icon: '<rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.9" stroke="currentColor" stroke-width="1.5"/><path d="M2.4 4.7L8 8.9l5.6-4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
  { key: 'help',       label: 'Help',            desc: 'How-tos, tour and privacy',
    icon: '<circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.5 1.5c-.6.35-.9.7-.9 1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.3" r="0.85" fill="currentColor"/>' },
  { key: 'data',       label: 'Data',            desc: 'Clear storage on this device',
    icon: '<ellipse cx="8" cy="4" rx="5.5" ry="2.2" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" stroke="currentColor" stroke-width="1.5"/>' },
];
let settingsSection = 'views';     // last section shown; desktop reopens on it

function renderSettingsNav() {
  const nav = $('settingsNav');
  if (!nav) return;
  nav.innerHTML = SETTINGS_SECTIONS.map(s => `
    <button class="settings-nav-item" data-settings-nav="${s.key}">
      <span class="settings-nav-ico" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none">${s.icon}</svg></span>
      <span class="settings-nav-text">
        <span class="settings-nav-label">${s.label}</span>
        <span class="settings-nav-desc">${s.desc}</span>
      </span>
      <svg class="settings-nav-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`).join('');
}

/* Show one section. stage: 'detail' opens it on mobile too, 'list' leaves
 * mobile on the section list (desktop always shows the section). */
export function settingsShow(key, stage) {
  const def = SETTINGS_SECTIONS.find(s => s.key === key) || SETTINGS_SECTIONS[0];
  settingsSection = def.key;
  const box = $('settingsBox');
  if (!box) return;
  box.dataset.stage = stage === 'list' ? 'list' : 'detail';
  box.querySelectorAll('[data-settings-nav]').forEach(b => {
    const on = b.dataset.settingsNav === def.key;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  box.querySelectorAll('[data-settings-section]').forEach(sec => {
    sec.classList.toggle('active', sec.dataset.settingsSection === def.key);
  });
  const title = $('settingsPaneTitle');
  if (title) title.textContent = def.label;
  const pane = $('settingsPane');
  if (pane) pane.scrollTop = 0;
}
export function settingsBack() {
  const box = $('settingsBox');
  if (box) box.dataset.stage = 'list';
}

export function renderSettings() {
  const list = $('settingsViewList');
  if (list) {
    list.innerHTML = VIEW_DEFS.map(v => {
      const locked = v.key === 'home';
      return `
        <div class="settings-view-row">
          <span class="settings-view-name">${v.label}${locked ? '<span class="settings-locked">always on</span>' : ''}</span>
          <label class="gcal-toggle">
            <input type="checkbox" data-viewtoggle="${v.key}"
              ${viewEnabled(v.key) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            <span class="gcal-toggle-track"></span>
          </label>
        </div>`;
    }).join('');
  }
  const status = $('gcalStatusLine');
  if (status) {
    status.textContent = gcalIsConnected()
      ? 'Connected — tap below to pick calendars or disconnect.'
      : 'Not connected.';
  }
  gcalUpdateBtn();
  bankRenderSettings();
  digestRenderSettings();
}

export function setViewEnabled(key, on) {
  if (key === 'home') return;
  views[key] = !!on;
  saveToLocal();
  applyViewVisibility();
  renderSettings();
}

/* openSettings()          → mobile starts on the section list, desktop on the last section
 * openSettings('digest')  → straight into that section on both layouts
 * (also used as a click handler, so anything that isn't a string is ignored) */
export function openSettings(section) {
  syncUpdateUI();
  renderSettings();
  renderThemePresets('themePresets-s');
  if (!$('settingsNav')?.children.length) renderSettingsNav();
  const direct = typeof section === 'string';
  settingsShow(direct ? section : settingsSection, direct ? 'detail' : 'list');
  $('settingsModal').classList.add('show');
}
