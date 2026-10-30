/* Themes: presets, custom colors, fonts, background image.
 * Run: npm test (or node --experimental-vm-modules tests/test_theme.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

function boot(storageSeed) { return loadApp({ storage: storageSeed }); }

const rootVar = (w, name) => w.document.documentElement.style.getPropertyValue(name).trim();
const savedTheme = (w) => JSON.parse(w.localStorage.getItem('focus-app-state')).theme;
/* Expected colors come from the app's own preset table, so retuning a palette
 * doesn't break these checks; what they verify is that the preset is applied. */
const preset = (w, id) => w.eval(`themePreset(${JSON.stringify(id)})`);
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');

(async () => {   // the app boots asynchronously now (ES modules), so the checks run in here
console.log('\n── 1. Default boot applies Black ──');
{
  const { w, d } = await boot();
  eq(w.eval('THEME_PRESETS.map(p => p.name).join(", ")'), 'Black, Dark grey, Light grey, White', 'four themes, no others');
  const blk = preset(w, 'black');
  eq(blk.bg + ' ' + blk.line, '#000000 #ffffff', 'Black: a black background with white outlines');
  eq(preset(w, 'darkgrey').bg + ' ' + preset(w, 'darkgrey').line, '#2a2a2a #8c8c8c', 'Dark grey: dark grey with grey outlines');
  eq(preset(w, 'lightgrey').bg + ' ' + preset(w, 'lightgrey').line, '#d9d9d9 #4d4d4d', 'Light grey: light grey with dark grey outlines');
  eq(preset(w, 'white').bg + ' ' + preset(w, 'white').line, '#ffffff #000000', 'White: white with black outlines');
  eq(rootVar(w, '--bg-solid'), blk.bg, 'bg-solid is black');
  eq(rootVar(w, '--scheme'), 'dark', 'scheme dark');
  eq(rootVar(w, '--accent-rgb'), rgb(blk.accent), 'accent rgb triplet');
  eq(rootVar(w, '--line'), blk.line, 'outlines (--line) in the theme\'s line colour');
  ok(rootVar(w, '--border').startsWith(`rgba(${rgb(blk.line)},`) && rootVar(w, '--border-strong') === `rgba(${rgb(blk.line)},1)`, 'borders drawn from the outlines');
  eq(rootVar(w, '--ambient-alpha'), '0', 'a grey accent: no coloured lights behind, the background stays plain');
  ok(d.querySelector('.settings-motion-row').style.display === 'none' && d.getElementById('themeMotionHint').style.display === 'none', 'so Settings doesn\'t offer to move them');
  eq(rootVar(w, '--radius-md'), blk.radius + 'px', 'radius md');
  eq(rootVar(w, '--font-size'), '14px', 'font size');
  ok(rootVar(w, '--font-sans').includes("'DM Sans'"), 'font stack DM Sans');
  eq(d.getElementById('themeBg').classList.contains('on'), false, 'no bg image layer');
  w.saveToLocal();
  eq(savedTheme(w).preset, 'black', 'saved state carries theme');
  eq(d.querySelector('meta[name="theme-color"]').getAttribute('content'), blk.bg, 'meta theme-color');
  /* the stylesheet's own values (before the theme is applied) are Black's, so it opens without a flash of another colour */
  const css = require('fs').readFileSync(require('path').join(require('./load-app').ROOT, 'style.css'), 'utf8');
  ok(css.includes('--bg-solid:    #000000;') && css.includes('--line:          #ffffff;'), 'style.css starts out Black');
}

console.log('\n── 2. Settings → preset chip switches theme ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  ok(d.getElementById('settingsModal').classList.contains('show'), 'settings opens');
  const chips = d.querySelectorAll('#themePresets-s .theme-chip');
  eq(chips.length, 4, 'one chip per theme: four');
  eq([...chips].map(c => c.dataset.preset).join(), 'black,darkgrey,lightgrey,white', 'in order');
  ok(d.querySelector('#themePresets-s .theme-chip.active').dataset.preset === 'black', 'black chip active');
  ok(chips[3].getAttribute('style').includes('--c-line:#000000'), 'a chip shows its theme\'s outlines');
  d.querySelector('#themePresets-s [data-preset="white"]').click();
  const wht = preset(w, 'white');
  eq(rootVar(w, '--bg-solid'), wht.bg, 'white bg applied');
  eq(rootVar(w, '--scheme'), 'light', 'scheme flips to light');
  ok(rootVar(w, '--border').startsWith('rgba(0,0,0,') && rootVar(w, '--line') === '#000000', 'black outlines on white');
  eq(rootVar(w, '--accent'), wht.accent, 'accent updated');
  eq(rootVar(w, '--on-accent'), '#ffffff', 'white text on its black accent');
  eq(savedTheme(w).preset, 'white', 'preset persisted');
  ok(d.querySelector('#themePresets-s .theme-chip.active').dataset.preset === 'white', 'chip active state re-rendered');
  d.querySelector('#themePresets-s [data-preset="lightgrey"]').click();
  eq(rootVar(w, '--bg-solid') + ' ' + rootVar(w, '--line') + ' ' + rootVar(w, '--scheme'), '#d9d9d9 #4d4d4d light', 'light grey, dark grey outlines');
  d.querySelector('#themePresets-s [data-preset="darkgrey"]').click();
  eq(rootVar(w, '--bg-solid') + ' ' + rootVar(w, '--line') + ' ' + rootVar(w, '--scheme'), '#2a2a2a #8c8c8c dark', 'dark grey, grey outlines');
  eq(rootVar(w, '--on-accent'), '#040404', 'dark text on its light grey accent');
}

console.log('\n── 3. Editor: live color edit detaches preset; hex + swatch stay in sync ──');
{
  const { w, d } = await boot();
  d.getElementById('settingsBtn').click();
  d.getElementById('themeOpenBtn').click();
  ok(d.getElementById('themeModal').classList.contains('show'), 'theme editor opens');
  ok(!d.getElementById('settingsModal').classList.contains('show'), 'settings closes behind it (live preview)');
  eq(d.querySelectorAll('#themeColorGrid .theme-color-row').length, 8, 'eight color rows');
  eq(d.querySelector('[data-th="line"]').value, '#ffffff', 'Outlines among them, in the theme\'s colour');
  const sw = d.querySelector('[data-th="accent"]');
  sw.value = '#ff8800';
  sw.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--accent'), '#ff8800', 'swatch input previews live');
  eq(rootVar(w, '--accent-rgb'), '255,136,0', 'rgb triplet follows');
  eq(d.querySelector('[data-thhex="accent"]').value, '#ff8800', 'hex field mirrors swatch');
  sw.dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(savedTheme(w).preset, 'custom', 'preset becomes custom after edit');
  eq(savedTheme(w).accent, '#ff8800', 'accent persisted');
  ok(d.getElementById('thResetBtn').textContent.includes('Black'), 'reset button labels fallback preset');
  const ln = d.querySelector('[data-th="line"]');
  ln.value = '#ff0000';
  ln.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--line'), '#ff0000', 'Outlines previews live');
  ok(rootVar(w, '--border').startsWith('rgba(255,0,0,'), 'and the borders follow');
  ln.dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(savedTheme(w).line, '#ff0000', 'outline colour persisted');
  // typed hex
  const hex = d.querySelector('[data-thhex="bg"]');
  hex.value = '#zzzzzz';
  hex.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok(hex.classList.contains('bad'), 'invalid hex flagged');
  eq(rootVar(w, '--bg-solid'), preset(w, 'black').bg, 'invalid hex not applied');
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
  eq(rootVar(w, '--accent'), preset(w, 'black').accent, 'reset restores black accent');
  eq(rootVar(w, '--line'), '#ffffff', 'and its outlines');
  eq(savedTheme(w).preset, 'black', 'reset sets preset id');
  eq(rootVar(w, '--font-size'), '16px', 'text size survives reset');
}

console.log('\n── 4. Fonts: custom Google Font name ──');
{
  const { w, d } = await boot();
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
  const { w, d } = await boot();
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
  const bgRgb = rgb(preset(w, 'black').bg);
  ok(rootVar(w, '--bg-base').startsWith(`rgba(${bgRgb},0.65`), 'panels go translucent (35% glass default)');
  ok(rootVar(w, '--theme-bg-dim').startsWith(`rgba(${bgRgb},0.4`), 'dim overlay 40% default');
  eq(d.getElementById('thBgControls').style.display, '', 'image sliders revealed');
  const glass = d.getElementById('thBgGlass');
  glass.value = '0'; glass.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq(rootVar(w, '--bg-base'), `rgba(${bgRgb},1)`, 'glass 0 → opaque panels again');
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
  const { w, d } = await boot();
  w.themeSetBgUrl('https://example.com/a.png');
  w.themeApplyPreset('darkgrey');
  eq(savedTheme(w).bgMode, 'url', 'image survives preset switch');
  eq(savedTheme(w).bg, preset(w, 'darkgrey').bg, 'dark grey palette applied');
}

console.log('\n── 7. Persistence round-trip (reload) ──');
{
  const first = await boot();
  first.w.themeApplyPreset('lightgrey');
  first.w.themeSet('accent', '#123456');
  first.w.saveToLocal();
  const seed = { 'focus-app-state': first.w.localStorage.getItem('focus-app-state') };
  const { w } = await boot(seed);
  eq(rootVar(w, '--bg-solid'), preset(w, 'lightgrey').bg, 'light grey bg restored after reload');
  eq(rootVar(w, '--line'), preset(w, 'lightgrey').line, 'its outlines too (kept with the custom theme)');
  eq(rootVar(w, '--accent'), '#123456', 'custom accent restored');
  eq(savedTheme(w).preset, 'custom', 'custom preset restored');
}

console.log('\n── 8. Local uploaded image is device-only; other device degrades gracefully ──');
{
  const { w } = await boot();
  w.localStorage.setItem('focus-theme-bg', 'data:image/jpeg;base64,AAAA');
  w.themeGet().bgMode = 'local';
  w.themeCommit();
  ok(w.document.getElementById('themeBg').style.backgroundImage.includes('data:image/jpeg'), 'local image shown');
  const state = JSON.parse(w.localStorage.getItem('focus-app-state'));
  ok(!JSON.stringify(state).includes('base64,AAAA'), 'data url NOT in synced state');
  eq(state.theme.bgMode, 'local', 'bgMode local in state');
  // "other device": same state, no local image
  const other = await boot({ 'focus-app-state': JSON.stringify(state) });
  ok(!other.d.getElementById('themeBg').classList.contains('on'), 'no image layer without local file');
  eq(rootVar(other.w, '--bg-surface'), preset(other.w, 'black').surface, 'panels stay opaque when image missing');
  eq(rootVar(other.w, '--bg-base'), 'transparent', 'canvas shows the ambient wash, as with no image at all');
}

console.log('\n── 9. Compress / decompress (export + cloud format) ──');
{
  const { w } = await boot();
  w.themeApplyPreset('white');
  w.themeSetBgUrl('https://example.com/x.jpg');
  const st = w.gatherState();
  const c = w.compressState(st);
  ok(c.th && c.th.p === 'white' && c.th.iu === 'https://example.com/x.jpg' && c.th.l === '#000000', 'compressed th block (with the outlines)');
  const back = w.decompressState(JSON.parse(JSON.stringify(c)));
  eq(JSON.stringify(back.theme), JSON.stringify(st.theme), 'theme survives compress→decompress');
  // legacy state without theme → defaults
  const legacy = w.decompressState({ ...c, th: undefined });
  eq(legacy.theme.preset, 'black', 'missing th → black default');
  // applyState (import) applies theme live
  w.applyState(back);
  eq(rootVar(w, '--bg-solid'), preset(w, 'white').bg, 'import applies theme');
}

console.log('\n── 10. normalizeTheme hardening ──');
{
  const { w } = await boot();
  const mid = preset(w, 'black');
  const n = w.normalizeTheme({ preset: 'nope', bg: 'red', fontSize: 99, radius: -4, bgMode: 'url', bgUrl: '', bgDim: 'x', font: '   ' });
  eq(n.preset, 'black', 'unknown preset → black');
  eq(n.bg, mid.bg, 'named preset keeps its own palette');
  eq(n.radius, mid.radius, 'named preset keeps its own radius');
  eq(n.fontSize, 18, 'font size clamped');
  eq(n.bgMode, '', 'url mode without url dropped');
  eq(n.bgDim, 40, 'bad number → default');
  eq(n.font, 'DM Sans', 'blank font → preset font');
  /* only a custom theme carries its own colors and shape, so that is where
   * junk has to be filtered and values clamped */
  const c = w.normalizeTheme({ preset: 'custom', bg: 'red', accent: '#ABCDEF', radius: -4 });
  eq(c.bg, mid.bg, 'custom: non-hex color ignored');
  eq(c.accent, '#abcdef', 'custom: hex color kept, lower-cased');
  eq(c.radius, 0, 'custom: radius clamped');
}

console.log('\n── 10b. The themes from before: each to the nearest of the four ──');
{
  const { w } = await boot();
  const to = id => w.normalizeTheme({ preset: id, bg: '#123456' }).preset;
  eq(['midnight', 'forest', 'ocean', 'ember', 'lavender', 'sunset'].map(to).join(), 'black,black,black,black,black,black', 'a dark one (Midnight, the old default, and the rest): Black');
  eq(['daylight', 'rose', 'sky'].map(to).join(), 'white,white,white', 'a light one: White');
  const was = w.normalizeTheme({ preset: 'daylight', bg: '#f3f4f8', accent: '#2f6fe0' });
  eq(was.bg + ' ' + was.accent + ' ' + was.line, '#ffffff #000000 #000000', 'with the new theme\'s colours, not the old');
  /* a custom theme saved before outlines had a colour keeps its look: drawn from its text */
  const old = { preset: 'custom', bg: '#101820', surface: '#18202a', ink: '#eef0f4', ink2: '#9aa3b2', ink3: '#5f6878', accent: '#5dcaa5', danger: '#e05555', font: 'DM Sans', radius: 12 };
  const kept = w.normalizeTheme(old);
  eq(kept.preset + ' ' + kept.bg + ' ' + JSON.stringify(kept.line), 'custom #101820 ""', 'a custom theme stays custom, no outline colour of its own');
  const back = w.decompressTheme(JSON.parse(JSON.stringify(w.compressTheme(kept))));
  eq(JSON.stringify(back.line), '""', 'and stays without one through the cloud\'s format');
  w.setTheme(kept); w.applyTheme();
  eq(rootVar(w, '--border'), 'rgba(238,240,244,0.06)', 'its borders as before: from the text, faint');
  eq(rootVar(w, '--ambient-alpha'), '1', 'a coloured accent: the lights behind are there');
  eq(w.document.querySelector('.settings-motion-row').style.display, '', 'and Moving background is offered again');
  eq(rootVar(w, '--accent-2-rgb') !== rootVar(w, '--accent-rgb'), true, 'in companion colours');
}

console.log('\n── 11. Moving background: on unless turned off, on this device only ──');
{
  const { w, d } = await boot();
  const toggle = () => d.getElementById('themeMotionToggle');
  const flip = on => { toggle().checked = on; toggle().dispatchEvent(new w.Event('change', { bubbles: true })); };
  ok(toggle() && toggle().checked && d.body.classList.contains('bg-motion'), 'on at first (the lights move while Focus is in use: tests/test_ambient.js)');
  flip(false);
  ok(!d.body.classList.contains('bg-motion') && w.localStorage.getItem('focus-bg-motion') === '0', 'Settings → Appearance turns it off, kept on this device');
  w.saveToLocal();
  ok(!/motion/i.test(w.localStorage.getItem('focus-app-state')), 'not in the synced state: each device keeps its own');
  const again = await boot({ 'focus-bg-motion': '0' });
  ok(!again.d.body.classList.contains('bg-motion') && !again.d.getElementById('themeMotionToggle').checked, 'still off when Focus opens again');
  w.themeApplyPreset('white');
  ok(!d.body.classList.contains('bg-motion'), 'and through a change of theme');
  flip(true);
  ok(d.body.classList.contains('bg-motion') && w.localStorage.getItem('focus-bg-motion') === '1', 'on again');

  /* nothing animates for good while Focus sits idle or in the background: every
   * endless animation runs only while Focus is in use (body.motion-live, which
   * ambient.js sets only then), or is art on a screen that is open at the time */
  const fs = require('fs'), path = require('path');
  const css = fs.readFileSync(path.join(require('./load-app').ROOT, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const endless = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /animation[^;]*\binfinite\b/.test(m[2])).map(m => m[1].trim());
  const allowed = sel => /^body\.motion-live /.test(sel) || ['.welcome-orb', '.welcome-chip', '.tour-spot::after'].includes(sel);
  ok(endless.length >= 4 && endless.every(allowed), `endless animations only while Focus is in use, on the welcome screen or in the tour: ${endless.join(' | ')}`);
  ok(/\.modal-overlay:not\(\.show\) \.welcome-orb, \.modal-overlay:not\(\.show\) \.welcome-chip \{ animation-play-state: paused; \}/.test(css),
    'the welcome screen\'s art stops once it is closed (it is only faded out)');
  ok(!/\.ambient-blob[^{]*\{[^}]*(will-change|animation)/.test(css), 'the still blobs (no canvas) keep no layers of their own and never move');
  ok(/@keyframes nowRing \{[^}]*\{ opacity: [\d.]+; transform: [^}]*\}[^}]*\{ opacity: 0; transform: [^}]*\} \}/.test(css) && !/@keyframes \w+ \{[^@]*box-shadow/.test(css.slice(css.indexOf('@keyframes nowRing'), css.indexOf('@keyframes nowRing') + 200)),
    'the Now pulse changes only size and opacity, which the GPU does alone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
