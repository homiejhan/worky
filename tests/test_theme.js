const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  // strip external scripts/links; we inject app.js ourselves
  .replace(/<script src="[^"]*"><\/script>/g, '')
  .replace(/<link[^>]*fonts\.googleapis[^>]*>/g, '');
const appJs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

function boot(storageSeed) {
  const dom = new JSDOM(html, { url: 'https://localhost/worky/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  if (storageSeed) Object.entries(storageSeed).forEach(([k, v]) => w.localStorage.setItem(k, v));
  Object.defineProperty(w, 'confirm', { value: () => true, writable: true, configurable: true });
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  const s = w.document.createElement('script');
  s.textContent = appJs;
  w.document.body.appendChild(s);
  return { dom, w, d: w.document };
}

const rootVar = (w, name) => w.document.documentElement.style.getPropertyValue(name).trim();
const savedTheme = (w) => JSON.parse(w.localStorage.getItem('focus-app-state')).theme;

console.log('\n── 1. Default boot applies Midnight ──');
{
  const { w, d } = boot();
  eq(rootVar(w, '--bg-solid'), '#0b0c0e', 'bg-solid is midnight bg');
  eq(rootVar(w, '--scheme'), 'dark', 'scheme dark');
  eq(rootVar(w, '--accent-rgb'), '93,202,165', 'accent rgb triplet');
  eq(rootVar(w, '--radius-md'), '10px', 'radius md');
  eq(rootVar(w, '--font-size'), '14px', 'font size');
  ok(rootVar(w, '--font-sans').includes("'DM Sans'"), 'font stack DM Sans');
  eq(d.getElementById('themeBg').classList.contains('on'), false, 'no bg image layer');
  w.saveToLocal();
  eq(savedTheme(w).preset, 'midnight', 'saved state carries theme');
  eq(d.querySelector('meta[name="theme-color"]').getAttribute('content'), '#0b0c0e', 'meta theme-color');
}

console.log('\n── 2. Settings → preset chip switches theme ──');
{
  const { w, d } = boot();
  d.getElementById('settingsBtn').click();
  ok(d.getElementById('settingsModal').classList.contains('show'), 'settings opens');
  const chips = d.querySelectorAll('#themePresets-s .theme-chip');
  eq(chips.length, 7, 'seven preset chips rendered');
  ok(d.querySelector('#themePresets-s .theme-chip.active').dataset.preset === 'midnight', 'midnight chip active');
  d.querySelector('#themePresets-s [data-preset="daylight"]').click();
  eq(rootVar(w, '--bg-solid'), '#f2f3f5', 'daylight bg applied');
  eq(rootVar(w, '--scheme'), 'light', 'scheme flips to light');
  ok(rootVar(w, '--border').startsWith('rgba(21,23,27'), 'borders derived from dark ink for light theme');
  eq(rootVar(w, '--accent'), '#2a63c6', 'accent updated');
  eq(savedTheme(w).preset, 'daylight', 'preset persisted');
  ok(d.querySelector('#themePresets-s .theme-chip.active').dataset.preset === 'daylight', 'chip active state re-rendered');
  d.querySelector('#themePresets-s [data-preset="forest"]').click();
  ok(rootVar(w, '--font-sans').includes("'Manrope'"), 'forest switches font');
  eq(rootVar(w, '--radius-md'), '12px', 'forest radius');
  const link = d.getElementById('themeFontLink');
  ok(link && link.href.includes('Manrope'), 'google font link injected');
}

console.log('\n── 3. Editor: live color edit detaches preset; hex + swatch stay in sync ──');
{
  const { w, d } = boot();
  d.getElementById('settingsBtn').click();
  d.getElementById('themeOpenBtn').click();
  ok(d.getElementById('themeModal').classList.contains('show'), 'theme editor opens');
  ok(!d.getElementById('settingsModal').classList.contains('show'), 'settings closes behind it (live preview)');
  eq(d.querySelectorAll('#themeColorGrid .theme-color-row').length, 7, 'seven color rows');
  const sw = d.querySelector('[data-th="accent"]');
  sw.value = '#ff8800';
  sw.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--accent'), '#ff8800', 'swatch input previews live');
  eq(rootVar(w, '--accent-rgb'), '255,136,0', 'rgb triplet follows');
  eq(d.querySelector('[data-thhex="accent"]').value, '#ff8800', 'hex field mirrors swatch');
  sw.dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(savedTheme(w).preset, 'custom', 'preset becomes custom after edit');
  eq(savedTheme(w).accent, '#ff8800', 'accent persisted');
  ok(d.getElementById('thResetBtn').textContent.includes('Midnight'), 'reset button labels fallback preset');
  // typed hex
  const hex = d.querySelector('[data-thhex="bg"]');
  hex.value = '#zzzzzz';
  hex.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok(hex.classList.contains('bad'), 'invalid hex flagged');
  eq(rootVar(w, '--bg-solid'), '#0b0c0e', 'invalid hex not applied');
  hex.value = '#101820';
  hex.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--bg-solid'), '#101820', 'valid typed hex applied');
  eq(d.querySelector('[data-th="bg"]').value, '#101820', 'swatch mirrors typed hex');
  // sliders
  const fs = d.getElementById('thFontSize');
  fs.value = '16'; fs.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--font-size'), '16px', 'font size slider');
  eq(d.getElementById('thFontSizeVal').textContent, '16px', 'slider label');
  const rad = d.getElementById('thRadius');
  rad.value = '0'; rad.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--radius-lg'), '0px', 'radius 0 → square corners');
  // reset to preset restores palette but keeps font size (not a palette field)
  d.getElementById('thResetBtn').click();
  eq(rootVar(w, '--accent'), '#5dcaa5', 'reset restores midnight accent');
  eq(savedTheme(w).preset, 'midnight', 'reset sets preset id');
  eq(rootVar(w, '--font-size'), '16px', 'text size survives reset');
}

console.log('\n── 4. Fonts: custom Google Font name ──');
{
  const { w, d } = boot();
  d.getElementById('settingsBtn').click();
  d.getElementById('themeOpenBtn').click();
  const sel = d.getElementById('thFontSelect');
  eq(sel.value, 'DM Sans', 'select shows current font');
  sel.value = '__custom';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(d.getElementById('thFontCustom').style.display !== 'none', 'custom field revealed');
  const c = d.getElementById('thFontCustom');
  c.value = 'Outfit';
  c.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(rootVar(w, '--font-sans').includes("'Outfit'"), 'custom font applied to stack');
  ok(d.getElementById('themeFontLink').href.includes('family=Outfit:wght@'), 'custom font requested from Google Fonts');
  eq(savedTheme(w).font, 'Outfit', 'custom font persisted');
  // simulate Google rejecting the weight list → fallback to bare family
  d.getElementById('themeFontLink').onerror();
  ok(d.getElementById('themeFontLink').href.endsWith('family=Outfit&display=swap'), 'falls back to plain family on error');
  sel.value = 'System';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(rootVar(w, '--font-sans').startsWith('system-ui'), 'System font uses native stack');
}

console.log('\n── 5. Background image via URL + glass/dim/blur ──');
{
  const { w, d } = boot();
  d.getElementById('settingsBtn').click();
  d.getElementById('themeOpenBtn').click();
  eq(d.getElementById('thBgControls').style.display, 'none', 'image sliders hidden without image');
  d.getElementById('thBgUrl').value = 'not a url';
  d.getElementById('thBgUseUrl').click();
  w.saveToLocal();
  eq(savedTheme(w).bgMode, '', 'rejects non-https url');
  d.getElementById('thBgUrl').value = 'https://example.com/pic.jpg';
  d.getElementById('thBgUseUrl').click();
  const layer = d.getElementById('themeBg');
  ok(layer.classList.contains('on'), 'bg layer enabled');
  ok(layer.style.backgroundImage.includes('https://example.com/pic.jpg'), 'bg image url set');
  eq(savedTheme(w).bgMode, 'url', 'bgMode url persisted');
  eq(savedTheme(w).bgUrl, 'https://example.com/pic.jpg', 'url persisted');
  ok(rootVar(w, '--bg-base').startsWith('rgba(11,12,14,0.65'), 'panels go translucent (35% glass default)');
  ok(rootVar(w, '--theme-bg-dim').startsWith('rgba(11,12,14,0.4'), 'dim overlay 40% default');
  eq(d.getElementById('thBgControls').style.display, '', 'image sliders revealed');
  const glass = d.getElementById('thBgGlass');
  glass.value = '0'; glass.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--bg-base'), '#0b0c0e', 'glass 0 → opaque panels again');
  const blur = d.getElementById('thBgBlur');
  blur.value = '8'; blur.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(layer.style.filter, 'blur(8px)', 'blur applied to layer');
  eq(layer.style.inset, '-16px', 'layer overscans to hide blur edge');
  d.getElementById('thBgRemove').click();
  ok(!layer.classList.contains('on'), 'remove clears layer');
  eq(savedTheme(w).bgMode, '', 'bgMode cleared');
}

console.log('\n── 6. Preset switch keeps the background image ──');
{
  const { w, d } = boot();
  w.themeSetBgUrl('https://example.com/a.png');
  w.themeApplyPreset('ocean');
  eq(savedTheme(w).bgMode, 'url', 'image survives preset switch');
  eq(savedTheme(w).bg, '#091120', 'ocean palette applied');
}

console.log('\n── 7. Persistence round-trip (reload) ──');
{
  const first = boot();
  first.w.themeApplyPreset('ember');
  first.w.themeSet('accent', '#123456');
  first.w.saveToLocal();
  const seed = { 'focus-app-state': first.w.localStorage.getItem('focus-app-state') };
  const { w } = boot(seed);
  eq(rootVar(w, '--bg-solid'), '#15100d', 'ember bg restored after reload');
  eq(rootVar(w, '--accent'), '#123456', 'custom accent restored');
  eq(savedTheme(w).preset, 'custom', 'custom preset restored');
}

console.log('\n── 8. Local uploaded image is device-only; other device degrades gracefully ──');
{
  const { w } = boot();
  w.localStorage.setItem('focus-theme-bg', 'data:image/jpeg;base64,AAAA');
  w.themeGet().bgMode = 'local';
  w.themeCommit();
  ok(w.document.getElementById('themeBg').style.backgroundImage.includes('data:image/jpeg'), 'local image shown');
  const state = JSON.parse(w.localStorage.getItem('focus-app-state'));
  ok(!JSON.stringify(state).includes('base64,AAAA'), 'data url NOT in synced state');
  eq(state.theme.bgMode, 'local', 'bgMode local in state');
  // "other device": same state, no local image
  const other = boot({ 'focus-app-state': JSON.stringify(state) });
  ok(!other.d.getElementById('themeBg').classList.contains('on'), 'no image layer without local file');
  eq(rootVar(other.w, '--bg-base'), '#15100d'.replace('#15100d', rootVar(other.w, '--bg-solid')), 'panels stay opaque when image missing');
}

console.log('\n── 9. Compress / decompress (export + cloud format) ──');
{
  const { w } = boot();
  w.themeApplyPreset('lavender');
  w.themeSetBgUrl('https://example.com/x.jpg');
  const st = w.gatherState();
  const c = w.compressState(st);
  ok(c.th && c.th.p === 'lavender' && c.th.iu === 'https://example.com/x.jpg', 'compressed th block');
  const back = w.decompressState(JSON.parse(JSON.stringify(c)));
  eq(JSON.stringify(back.theme), JSON.stringify(st.theme), 'theme survives compress→decompress');
  // legacy state without theme → defaults
  const legacy = w.decompressState({ ...c, th: undefined });
  eq(legacy.theme.preset, 'midnight', 'missing th → midnight default');
  // applyState (import) applies theme live
  w.applyState(back);
  eq(rootVar(w, '--bg-solid'), '#13111c', 'import applies theme');
}

console.log('\n── 10. normalizeTheme hardening ──');
{
  const { w } = boot();
  const n = w.normalizeTheme({ preset: 'nope', bg: 'red', fontSize: 99, radius: -4, bgMode: 'url', bgUrl: '', bgDim: 'x', font: '   ' });
  eq(n.preset, 'midnight', 'unknown preset → midnight');
  eq(n.bg, '#0b0c0e', 'non-hex color ignored');
  eq(n.fontSize, 18, 'font size clamped');
  eq(n.radius, 0, 'radius clamped');
  eq(n.bgMode, '', 'url mode without url dropped');
  eq(n.bgDim, 40, 'bad number → default');
  eq(n.font, 'DM Sans', 'blank font → preset font');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
