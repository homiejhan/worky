/* theme.js — Themes: presets, custom colors, fonts, background image and the editor. */
import { $, closeModal, escAttr, showToast } from './util.js';
import { saveToLocal } from './persistence.js';

export let theme = null;          // normalized theme record (see below)
export function setTheme(v) { theme = v; }

/* ───────────────────────── THEME ─────────────────────────
 * Everything visual is driven by CSS custom properties on :root, so a
 * theme is just a small record of colors + type + shape + background
 * image settings. applyTheme() derives every token (hover/elevated
 * tints, alpha borders, rgb triplets, light/dark scheme, radii) from
 * that record and writes it to :root; the CSS never changes.
 *
 * Persistence: the theme record travels inside the main app state
 * (gatherState → theme / compressed th) so it syncs across devices and
 * rides along in export/import. The one exception is an UPLOADED
 * background image: that's a data URL that can be a megabyte or more,
 * so it stays device-local in THEME_BG_LS_KEY. Another device sees
 * bgMode 'local', finds no image and simply shows the palette alone. */
const THEME_BG_LS_KEY   = 'focus-theme-bg';
const THEME_BG_MAX_EDGE = 1920;      // uploaded images are downscaled to this
const THEME_BG_MAX_B64  = 2.5e6;     // and refused above ~2.5 MB encoded

const THEME_PRESETS = [
  { id: 'midnight', name: 'Midnight', bg: '#0d0f15', surface: '#151823', ink: '#eef0f4', ink2: '#9aa3b2', ink3: '#5f6878', accent: '#5dcaa5', danger: '#e05555', font: 'DM Sans',        radius: 12 },
  { id: 'daylight', name: 'Daylight', bg: '#f3f4f8', surface: '#ffffff', ink: '#15171b', ink2: '#5a6070', ink3: '#9aa1ad', accent: '#2f6fe0', danger: '#cf3d3d', font: 'DM Sans',        radius: 12 },
  { id: 'forest',   name: 'Forest',   bg: '#0c1611', surface: '#132019', ink: '#e4efe7', ink2: '#93a89b', ink3: '#54685c', accent: '#e0b84f', danger: '#e26a5a', font: 'Manrope',        radius: 14 },
  { id: 'ocean',    name: 'Ocean',    bg: '#081020', surface: '#0f1a2e', ink: '#e2ebf7', ink2: '#93a3bd', ink3: '#54637d', accent: '#5aa9ff', danger: '#ef6262', font: 'Inter',          radius: 10 },
  { id: 'ember',    name: 'Ember',    bg: '#16100d', surface: '#1e1712', ink: '#f3eae0', ink2: '#b39d8a', ink3: '#6f5f52', accent: '#f0894a', danger: '#e05555', font: 'Nunito',         radius: 16 },
  { id: 'lavender', name: 'Lavender', bg: '#13111c', surface: '#1b1828', ink: '#ebe8f5', ink2: '#a29dbd', ink3: '#625d7c', accent: '#b49cff', danger: '#f0668a', font: 'Space Grotesk',  radius: 14 },
  { id: 'sunset',   name: 'Sunset',   bg: '#170f14', surface: '#20151c', ink: '#f6e9ee', ink2: '#b8a0ab', ink3: '#725e68', accent: '#ff7a8a', danger: '#e05555', font: 'DM Sans',        radius: 16 },
  { id: 'rose',     name: 'Rosé',     bg: '#fbf3f5', surface: '#ffffff', ink: '#2b1f25', ink2: '#6f5d65', ink3: '#a8979f', accent: '#c94d7a', danger: '#c8403a', font: 'Lora',           radius: 16 },
  { id: 'sky',      name: 'Sky',      bg: '#eef4fb', surface: '#ffffff', ink: '#14202e', ink2: '#57677a', ink3: '#93a2b3', accent: '#1f8fd8', danger: '#d4463f', font: 'Manrope',        radius: 14 },
];

/* Curated Google Fonts; anything else typed in is fetched by name. */
const THEME_FONTS = [
  { name: 'DM Sans',               gf: 'DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700', serif: false },
  { name: 'Inter',                 gf: 'Inter:wght@300;400;500;600;700', serif: false },
  { name: 'Manrope',               gf: 'Manrope:wght@300;400;500;600;700', serif: false },
  { name: 'Nunito',                gf: 'Nunito:wght@300;400;500;600;700', serif: false },
  { name: 'Space Grotesk',         gf: 'Space+Grotesk:wght@300;400;500;600;700', serif: false },
  { name: 'Poppins',               gf: 'Poppins:wght@300;400;500;600;700', serif: false },
  { name: 'Atkinson Hyperlegible', gf: 'Atkinson+Hyperlegible:wght@400;700', serif: false },
  { name: 'Lora',                  gf: 'Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500', serif: true },
  { name: 'Merriweather',          gf: 'Merriweather:wght@300;400;700', serif: true },
  { name: 'Fraunces',              gf: 'Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700', serif: true },
  { name: 'JetBrains Mono',        gf: 'JetBrains+Mono:wght@300;400;500;600;700', serif: false, mono: true },
  { name: 'System',                gf: null, serif: false },
];
const THEME_CUSTOM_FONT = '__custom';

const THEME_COLOR_FIELDS = [
  { key: 'bg',      label: 'Background' },
  { key: 'surface', label: 'Panels' },
  { key: 'ink',     label: 'Text' },
  { key: 'ink2',    label: 'Secondary text' },
  { key: 'ink3',    label: 'Muted text' },
  { key: 'accent',  label: 'Accent' },
  { key: 'danger',  label: 'Danger' },
];

export function themePreset(id) { return THEME_PRESETS.find(p => p.id === id) || THEME_PRESETS[0]; }

export function themeIsHex(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s); }
function themeNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* Any input (undefined, v1 object, partial, garbage) → complete valid record. */
export function normalizeTheme(v) {
  const base = themePreset(v && v.preset);
  const out = {
    preset:  base.id,
    bg: base.bg, surface: base.surface,
    ink: base.ink, ink2: base.ink2, ink3: base.ink3,
    accent: base.accent, danger: base.danger,
    font: base.font, fontSize: 14, radius: base.radius,
    bgMode: '', bgUrl: '', bgDim: 40, bgBlur: 0, bgGlass: 35,
  };
  if (!v || typeof v !== 'object') return out;
  if (v.preset === 'custom') out.preset = 'custom';
  THEME_COLOR_FIELDS.forEach(f => { if (themeIsHex(v[f.key])) out[f.key] = v[f.key].toLowerCase(); });
  if (typeof v.font === 'string' && v.font.trim()) out.font = v.font.trim().slice(0, 60);
  out.fontSize = themeNum(v.fontSize, 12, 18, 14);
  out.radius   = themeNum(v.radius, 0, 20, base.radius);
  if (v.bgMode === 'url' || v.bgMode === 'local') out.bgMode = v.bgMode;
  if (typeof v.bgUrl === 'string') out.bgUrl = v.bgUrl.trim().slice(0, 2048);
  if (out.bgMode === 'url' && !out.bgUrl) out.bgMode = '';
  out.bgDim   = themeNum(v.bgDim, 0, 90, 40);
  out.bgBlur  = themeNum(v.bgBlur, 0, 24, 0);
  out.bgGlass = themeNum(v.bgGlass, 0, 80, 35);
  /* A named preset always means "the preset's palette" — any edit flips the
   * record to 'custom' — so re-derive it here. That lets a refreshed preset
   * reach devices that saved the old values. */
  if (out.preset !== 'custom') {
    THEME_COLOR_FIELDS.forEach(f => { out[f.key] = base[f.key]; });
    out.font = base.font; out.radius = base.radius;
  }
  return out;
}

/* Compressed (v2) form for cloud/export: short keys, same values. */
export function compressTheme(t) {
  const n = normalizeTheme(t);
  const o = { p: n.preset, b: n.bg, s: n.surface, t: n.ink, t2: n.ink2, t3: n.ink3,
              a: n.accent, d: n.danger, f: n.font, fs: n.fontSize, r: n.radius };
  if (n.bgMode) { o.im = n.bgMode; o.id = n.bgDim; o.ib = n.bgBlur; o.ig = n.bgGlass; }
  if (n.bgMode === 'url') o.iu = n.bgUrl;
  return o;
}
export function decompressTheme(c) {
  if (!c || typeof c !== 'object') return normalizeTheme(null);
  return normalizeTheme({
    preset: c.p, bg: c.b, surface: c.s, ink: c.t, ink2: c.t2, ink3: c.t3,
    accent: c.a, danger: c.d, font: c.f, fontSize: c.fs, radius: c.r,
    bgMode: c.im, bgUrl: c.iu, bgDim: c.id, bgBlur: c.ib, bgGlass: c.ig,
  });
}

export function themeGet() { if (!theme) theme = normalizeTheme(null); return theme; }

/* ── color math ── */
function themeHexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function themeRgbToHex(r) {
  return '#' + r.map(x => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
}
function themeMix(a, b, t) {           // a,b hex; t 0..1 toward b
  const A = themeHexToRgb(a), B = themeHexToRgb(b);
  return themeRgbToHex(A.map((x, i) => x + (B[i] - x) * t));
}
export function themeLuma(h) {
  const [r, g, b] = themeHexToRgb(h).map(x => x / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function themeRgbStr(h) { return themeHexToRgb(h).join(','); }
/* Rotate a hex colour's hue by `deg` (keeps saturation/lightness) — used to
 * derive the two companion accents that colour the ambient wash. */
function themeRotate(hex, deg) {
  let [r, g, b] = themeHexToRgb(hex).map(x => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, sat = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360 + 1) % 1;
  sat = Math.min(1, Math.max(0.42, sat));          // keep companions vivid
  const f = (p, q, t) => { t = (t + 1) % 1; if (t < 1/6) return p + (q - p) * 6 * t; if (t < 1/2) return q; if (t < 2/3) return p + (q - p) * (2/3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, pp = 2 * l - q;
  return themeRgbToHex([f(pp, q, h + 1/3), f(pp, q, h), f(pp, q, h - 1/3)].map(x => x * 255));
}
function themeRgba(h, a) { return `rgba(${themeRgbStr(h)},${a})`; }

export function themeFontStack(name) {
  if (name === 'System') return 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const def = THEME_FONTS.find(f => f.name === name);
  const generic = def && def.mono ? 'ui-monospace, monospace' : (def && def.serif ? 'Georgia, serif' : 'system-ui, sans-serif');
  return `'${name.replace(/'/g, '')}', ${generic}`;
}

/* Load a Google Font on demand. Curated fonts ship with a known axis
 * spec; unknown names try a weight list first and, if Google rejects
 * that combination (static families), fall back to the plain family. */
let _themeFontLoaded = '';
function themeEnsureFont(name) {
  if (!name || name === 'System' || name === 'DM Sans' || name === _themeFontLoaded) return;
  _themeFontLoaded = name;
  const def = THEME_FONTS.find(f => f.name === name);
  const fam = name.trim().replace(/\s+/g, '+');
  const specs = def ? [def.gf] : [`${fam}:wght@400;500;600;700`, fam];
  const old = $('themeFontLink'); if (old) old.remove();
  const tryLoad = i => {
    if (i >= specs.length) return;
    const link = document.createElement('link');
    link.id = 'themeFontLink';
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${specs[i]}&display=swap`;
    link.onerror = () => { link.remove(); tryLoad(i + 1); };
    document.head.appendChild(link);
  };
  tryLoad(0);
}

function themeBgSrc(t) {
  if (t.bgMode === 'url' && t.bgUrl) return t.bgUrl;
  if (t.bgMode === 'local') { try { return localStorage.getItem(THEME_BG_LS_KEY) || ''; } catch(e) { return ''; } }
  return '';
}

/* Write every derived token to :root and update the background layer. */
export function applyTheme() {
  const t = themeGet();
  const root = document.documentElement.style;
  const light = themeLuma(t.bg) > 0.5;
  const hasImg = !!themeBgSrc(t);
  const glass = hasImg ? t.bgGlass / 100 : 0;

  const elevated = themeMix(t.surface, t.ink, light ? 0.035 : 0.045);
  const hover    = themeMix(t.surface, t.ink, light ? 0.075 : 0.09);

  root.setProperty('--bg-solid',    t.bg);
  /* No image → panels are transparent so the ambient wash paints the canvas
   * (html/body still hold --bg-solid, so nothing ever shows through to white). */
  root.setProperty('--bg-base',     hasImg ? themeRgba(t.bg, 1 - glass) : 'transparent');
  root.setProperty('--bg-surface',  glass ? themeRgba(t.surface, 1 - glass * 0.85) : t.surface);
  root.setProperty('--bg-elevated', glass ? themeRgba(elevated, 1 - glass * 0.45) : elevated);
  root.setProperty('--bg-hover',    hover);
  root.setProperty('--bg-rgb',      themeRgbStr(t.bg));
  root.setProperty('--ink',   t.ink);
  root.setProperty('--ink-2', t.ink2);
  root.setProperty('--ink-3', t.ink3);
  root.setProperty('--ink-rgb', themeRgbStr(t.ink));
  const bAlpha = light ? [0.08, 0.14, 0.22] : [0.06, 0.11, 0.18];
  root.setProperty('--border',        themeRgba(t.ink, bAlpha[0]));
  root.setProperty('--border-mid',    themeRgba(t.ink, bAlpha[1]));
  root.setProperty('--border-strong', themeRgba(t.ink, bAlpha[2]));
  root.setProperty('--accent',     t.accent);
  root.setProperty('--accent-rgb', themeRgbStr(t.accent));
  root.setProperty('--accent-dim', themeRgba(t.accent, light ? 0.12 : 0.14));
  const acc2 = themeRotate(t.accent, 120), acc3 = themeRotate(t.accent, 240);
  root.setProperty('--accent-2',     acc2);
  root.setProperty('--accent-2-rgb', themeRgbStr(acc2));
  root.setProperty('--accent-3',     acc3);
  root.setProperty('--accent-3-rgb', themeRgbStr(acc3));
  root.setProperty('--on-accent',    themeLuma(t.accent) > 0.62 ? themeMix(t.bg, '#000000', light ? 0.85 : 0.9) : '#ffffff');
  root.setProperty('--ambient-alpha', light ? '0.75' : '1');
  root.setProperty('--star', light ? '#c8921a' : '#E8B341');
  root.setProperty('--danger',     t.danger);
  root.setProperty('--danger-rgb', themeRgbStr(t.danger));
  root.setProperty('--danger-dim', themeRgba(t.danger, 0.12));
  root.setProperty('--shadow-pop',   light ? '0 18px 48px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.06)' : '0 18px 48px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)');
  root.setProperty('--shadow-card',  light ? '0 1px 2px rgba(0,0,0,0.05), 0 6px 18px rgba(0,0,0,0.04)' : '0 1px 2px rgba(0,0,0,0.18)');
  root.setProperty('--shadow-ghost', light ? '0 12px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)'
                                           : '0 12px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4)');
  root.setProperty('--scheme', light ? 'light' : 'dark');
  root.setProperty('--font-sans', themeFontStack(t.font));
  root.setProperty('--font-size', t.fontSize + 'px');
  root.setProperty('--radius-sm', Math.round(t.radius * 0.6) + 'px');
  root.setProperty('--radius-md', t.radius + 'px');
  root.setProperty('--radius-lg', Math.round(t.radius * 1.4) + 'px');
  themeEnsureFont(t.font);

  const layer = $('themeBg');
  if (layer) {
    const src = themeBgSrc(t);
    layer.classList.toggle('on', !!src);
    layer.style.backgroundImage = src ? `url("${src.replace(/"/g, '%22')}")` : '';
    layer.style.filter = src && t.bgBlur ? `blur(${t.bgBlur}px)` : '';
    layer.style.inset  = src && t.bgBlur ? `-${t.bgBlur * 2}px` : '';
    root.setProperty('--theme-bg-dim', src ? themeRgba(t.bg, t.bgDim / 100) : 'transparent');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.bg);
}

/* Palette + type from a preset; the background image is a separate
 * choice and survives preset switches. */
export function themeApplyPreset(id) {
  const p = themePreset(id);
  const t = themeGet();
  Object.assign(t, { preset: p.id, bg: p.bg, surface: p.surface, ink: p.ink, ink2: p.ink2, ink3: p.ink3,
                     accent: p.accent, danger: p.danger, font: p.font, radius: p.radius });
  themeCommit();
}

/* Field edit from the editor. Palette/type edits detach from the preset. */
function themeSet(key, value) {
  const t = themeGet();
  const next = normalizeTheme({ ...t, [key]: value, preset: 'custom' });   // 'custom' so the edit isn't re-derived away
  if (!(key in next)) return;
  const paletteKey = THEME_COLOR_FIELDS.some(f => f.key === key) || key === 'font' || key === 'radius';
  t[key] = next[key];
  if (paletteKey && t.preset !== 'custom') {
    const p = themePreset(t.preset);
    const same = THEME_COLOR_FIELDS.every(f => t[f.key] === p[f.key]) && t.font === p.font && t.radius === p.radius;
    if (!same) t.preset = 'custom';
  }
  applyTheme();
}
function themeCommit() {
  applyTheme();
  saveToLocal();
  renderThemeUI();
}

/* ── background image ── */
function themeSetBgUrl(url) {
  const t = themeGet();
  const u = String(url || '').trim();
  if (!u) { showToast('Paste an image URL first.'); return; }
  if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) { showToast('Use a link that starts with https://'); return; }
  t.bgMode = 'url'; t.bgUrl = u.slice(0, 2048);
  themeCommit();
}
function themeRemoveBg() {
  const t = themeGet();
  t.bgMode = ''; t.bgUrl = '';
  try { localStorage.removeItem(THEME_BG_LS_KEY); } catch(e) {}
  themeCommit();
}
/* Upload → downscale on a canvas → JPEG data URL → device-local storage. */
function themeUploadBg(file) {
  if (!file || !/^image\//.test(file.type)) { showToast('Choose an image file.'); return; }
  const reader = new FileReader();
  reader.onerror = () => showToast('Could not read that file.');
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => showToast('That image could not be decoded.');
    img.onload = () => {
      const scale = Math.min(1, THEME_BG_MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let data = '';
      try { data = canvas.toDataURL('image/jpeg', 0.84); } catch(e) {}
      if (!data || data.length > THEME_BG_MAX_B64) { showToast('Image is too large — try a smaller one.'); return; }
      try { localStorage.setItem(THEME_BG_LS_KEY, data); }
      catch(e) { showToast('Not enough storage on this device for that image.'); return; }
      const t = themeGet();
      t.bgMode = 'local'; t.bgUrl = '';
      themeCommit();
      showToast('Background set ✓');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* ── editor UI ── */
export function renderThemePresets(containerId) {
  const el = $(containerId);
  if (!el) return;
  const cur = themeGet().preset;
  el.innerHTML = THEME_PRESETS.map(p => `
    <button class="theme-chip${p.id === cur ? ' active' : ''}" data-preset="${p.id}" title="${escAttr(p.name)}"
      style="--c-bg:${p.bg};--c-sf:${p.surface};--c-ink:${p.ink};--c-ac:${p.accent};--c-font:${escAttr(themeFontStack(p.font))}">
      <span class="theme-chip-ball"></span>${escAttr(p.name)}
    </button>`).join('');
}

export function renderThemeUI() {
  renderThemePresets('themePresets-s');
  renderThemePresets('themePresets-m');
  const t = themeGet();
  const grid = $('themeColorGrid');
  if (grid) {
    grid.innerHTML = THEME_COLOR_FIELDS.map(f => `
      <div class="theme-color-row">
        <input type="color" class="theme-swatch" data-th="${f.key}" value="${t[f.key]}" aria-label="${escAttr(f.label)}">
        <div class="theme-color-meta">
          <span class="theme-color-name">${f.label}</span>
          <input type="text" class="theme-hex" data-thhex="${f.key}" value="${t[f.key]}" maxlength="7" spellcheck="false" autocomplete="off">
        </div>
      </div>`).join('');
  }
  const sel = $('thFontSelect');
  if (sel) {
    const known = THEME_FONTS.some(f => f.name === t.font);
    sel.innerHTML = THEME_FONTS.map(f => `<option value="${escAttr(f.name)}"${f.name === t.font ? ' selected' : ''}>${escAttr(f.name)}${f.name === 'System' ? ' (no download)' : ''}</option>`).join('')
      + `<option value="${THEME_CUSTOM_FONT}"${known ? '' : ' selected'}>Other Google Font…</option>`;
    const custom = $('thFontCustom');
    if (custom) {
      custom.style.display = known ? 'none' : '';
      if (!known) custom.value = t.font;
    }
  }
  const setRange = (id, val, txt) => {
    const r = $(id); if (r) r.value = val;
    const v = $(id + 'Val'); if (v) v.textContent = txt;
  };
  setRange('thFontSize', t.fontSize, t.fontSize + 'px');
  setRange('thRadius',   t.radius,   t.radius + 'px');
  setRange('thBgDim',    t.bgDim,    t.bgDim + '%');
  setRange('thBgBlur',   t.bgBlur,   t.bgBlur + 'px');
  setRange('thBgGlass',  t.bgGlass,  t.bgGlass + '%');
  const src = themeBgSrc(t);
  const ctl = $('thBgControls'); if (ctl) ctl.style.display = src ? '' : 'none';
  const status = $('thBgStatus');
  if (status) {
    status.textContent =
      t.bgMode === 'local' ? (src ? 'Using an uploaded image (stored on this device only).' : 'An uploaded image is set on another device — upload one here or use a URL.')
      : t.bgMode === 'url' ? 'Using image from URL.'
      : 'No background image.';
  }
  const urlIn = $('thBgUrl');
  if (urlIn && document.activeElement !== urlIn) urlIn.value = t.bgMode === 'url' ? t.bgUrl : '';
  themeRenderResetBtn();
}

/* The preset Reset returns to: the current one, or Midnight from a custom theme. */
function themeResetTarget() {
  const t = themeGet();
  return themePreset(t.preset === 'custom' ? 'midnight' : t.preset);
}
function themeRenderResetBtn() {
  const r = $('thResetBtn');
  if (r) r.textContent = `Reset to ${themeResetTarget().name}`;
}

function openThemeEditor() {
  closeModal('settingsModal');
  renderThemeUI();
  $('themeModal').classList.add('show');
}

export function bindTheme() {
  $('themeOpenBtn')?.addEventListener('click', openThemeEditor);
  $('thDoneBtn')?.addEventListener('click', () => closeModal('themeModal'));
  $('thResetBtn')?.addEventListener('click', () => themeApplyPreset(themeResetTarget().id));
  /* preset chips live in two places (settings + editor) — unique ids, one handler */
  ['themePresets-s', 'themePresets-m'].forEach(id => {
    $(id)?.addEventListener('click', e => {
      const chip = e.target.closest('[data-preset]');
      if (chip) themeApplyPreset(chip.dataset.preset);
    });
  });
  const modal = $('themeModal');
  if (!modal) return;
  /* live preview while dragging / picking; persist on change */
  modal.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.th && el.dataset.th !== 'font') {
      themeSet(el.dataset.th, el.value);
      const v = $(el.id + 'Val');
      if (v) v.textContent = el.value + (el.dataset.th === 'fontSize' || el.dataset.th === 'radius' || el.dataset.th === 'bgBlur' ? 'px' : '%');
      const hex = modal.querySelector(`[data-thhex="${el.dataset.th}"]`);
      if (hex) hex.value = el.value;
    } else if (el.dataset.thhex) {
      const ok = themeIsHex(el.value);
      el.classList.toggle('bad', !ok);
      if (ok) {
        themeSet(el.dataset.thhex, el.value);
        const sw = modal.querySelector(`[data-th="${el.dataset.thhex}"]`);
        if (sw) sw.value = el.value.toLowerCase();
      }
    }
  });
  modal.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'thFontSelect') {
      const custom = $('thFontCustom');
      if (el.value === THEME_CUSTOM_FONT) {
        if (custom) { custom.style.display = ''; custom.focus(); }
        return;
      }
      if (custom) custom.style.display = 'none';
      themeSet('font', el.value);
      themeCommit();
      return;
    }
    if (el.id === 'thFontCustom') {
      const name = el.value.trim();
      if (!name) return;
      themeSet('font', name);
      themeCommit();
      return;
    }
    if (el.dataset.th || el.dataset.thhex) {
      /* slider released / picker closed: persist and refresh the bits
       * that depend on whether we're still on a preset */
      saveToLocal();
      renderThemePresets('themePresets-m');
      renderThemePresets('themePresets-s');
      themeRenderResetBtn();
    }
  });
  $('thFontCustom')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('thBgUseUrl')?.addEventListener('click', () => themeSetBgUrl($('thBgUrl')?.value));
  $('thBgUrl')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); themeSetBgUrl(e.target.value); } });
  $('thBgUpload')?.addEventListener('click', () => $('themeBgFile')?.click());
  $('themeBgFile')?.addEventListener('change', e => { themeUploadBg(e.target.files && e.target.files[0]); e.target.value = ''; });
  $('thBgRemove')?.addEventListener('click', themeRemoveBg);
}
