/* The moving background (js/ambient.js): soft lights drawn into a small canvas,
 * moving only while Focus is in use. jsdom has no canvas, so each check puts in
 * a stand-in 2D context that counts frames and keeps the colors drawn with.
 * Run: npm test -- ambient (or node --experimental-vm-modules tests/test_ambient.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BOOT = { 'focus-tour-done': '1' };

/* a window with a 2D canvas, in front (focused) unless said otherwise */
function withCanvas(state) {
  return w => {
    state.frames = 0; state.colors = [];
    w.HTMLCanvasElement.prototype.getContext = function () {
      return {
        clearRect() { state.frames++; },
        fillRect() {},
        createRadialGradient() { return { addColorStop(_, c) { state.colors.push(c); } }; },
        fillStyle: '',
      };
    };
    state.focused = true;
    w.document.hasFocus = () => state.focused;
    let hidden = false;
    Object.defineProperty(w.document, 'hidden', { get: () => hidden, configurable: true });
    state.hide = on => { hidden = on; w.document.dispatchEvent(new w.Event('visibilitychange')); };
  };
}
async function frames(state, ms) { const n = state.frames; await sleep(ms); return state.frames - n; }

(async () => {
  console.log('\n── 1. Without a canvas: the still picture ──');
  {
    const { w, d, errors } = await loadApp({ storage: BOOT });
    const host = d.getElementById('ambient');
    ok(!host.querySelector('canvas') && !host.classList.contains('has-canvas') && host.querySelectorAll('.ambient-blob').length === 3,
      'no 2D canvas (an older browser): the three CSS blobs stay, still');
    ok(!d.body.classList.contains('motion-live'), 'and nothing counts as moving');
    eq(errors.length, 0, 'without an error');
  }

  console.log('\n── 2. In front and in use: the lights move ──');
  {
    const S = {};
    const { w, d } = await loadApp({ storage: BOOT, before: withCanvas(S) });
    const host = d.getElementById('ambient');
    const canvas = host.querySelector('canvas.ambient-canvas');
    ok(canvas && host.classList.contains('has-canvas'), 'a canvas takes the blobs\' place');
    ok(canvas && canvas.width === Math.ceil(w.innerWidth / 8) && canvas.height === Math.ceil(w.innerHeight / 8),
      `an eighth of the window each way (${canvas && canvas.width}×${canvas && canvas.height} for ${w.innerWidth}×${w.innerHeight}), stretched over it`);
    const n = await frames(S, 1500);
    ok(n >= 8 && n <= 14, `about 8 frames a second (${n} in 1.5 s)`);
    ok(d.body.classList.contains('motion-live'), 'and the little CSS motions may run (body.motion-live)');
    const accent = d.documentElement.style.getPropertyValue('--accent-rgb').trim();
    ok(accent && S.colors.some(c => c.startsWith(`rgba(${accent},`)), `in the theme's accent (${accent})`);
    const t0 = w.eval('ambientClock');
    await sleep(500);
    ok(w.eval('ambientClock') > t0, 'its clock runs while it moves');
  }

  console.log('\n── 3. When it rests ──');
  {
    const S = {};
    const { w, d } = await loadApp({ storage: BOOT, before: withCanvas(S) });
    await sleep(300);
    S.focused = false; w.dispatchEvent(new w.Event('blur'));
    await sleep(250);
    eq(await frames(S, 1000), 0, 'another app in front: no frames');
    ok(!d.body.classList.contains('motion-live'), 'and the little motions stop too');
    const stopped = w.eval('ambientClock');
    w.dispatchEvent(new w.Event('pointermove'));
    ok(await frames(S, 1000) >= 5, 'the pointer moving over Focus all the same: it moves again');
    ok(w.eval('ambientClock') - stopped < 1500, 'from where it stopped, not jumping ahead');
    w.eval('AMBIENT_HOVER_MS = 300');
    await sleep(600);
    eq(await frames(S, 800), 0, 'the pointer still a while: it rests again');
    S.focused = true; w.dispatchEvent(new w.Event('focus'));
    ok(await frames(S, 800) >= 4, 'Focus in front again: it moves');

    w.eval('AMBIENT_IDLE_MS = 400');
    await sleep(700);
    eq(await frames(S, 800), 0, 'left alone a while, even in front: it rests');
    w.eval('AMBIENT_IDLE_MS = 5 * 60 * 1000');
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a' }));
    ok(await frames(S, 800) >= 4, 'a key pressed: it moves');

    S.hide(true);
    await sleep(250);
    eq(await frames(S, 800), 0, 'hidden (another tab, minimized): no frames');
    S.hide(false);
    ok(await frames(S, 800) >= 4, 'shown again: it moves');

    w.eval('AMBIENT_DIALOG_MS = 100');
    d.getElementById('settingsModal').classList.add('show');
    await sleep(300);
    eq(await frames(S, 800), 0, 'under a dialog (which blurs what is behind it): no frames');
    d.getElementById('settingsModal').classList.remove('show');
    ok(await frames(S, 800) >= 4, 'the dialog closed: it moves again, by itself');

    d.getElementById('themeBg').classList.add('on');
    w.ambientRefresh();
    await sleep(250);
    eq(await frames(S, 800), 0, 'a background image over it: no frames');
    d.getElementById('themeBg').classList.remove('on');
    w.ambientRefresh();
    ok(await frames(S, 800) >= 4, 'the image gone: it moves');
  }

  console.log('\n── 4. Moving background off, and Reduce motion ──');
  {
    const S = {};
    const { w, d } = await loadApp({ storage: BOOT, before: withCanvas(S) });
    const toggle = d.getElementById('themeMotionToggle');
    ok(toggle.checked && d.body.classList.contains('bg-motion'), 'on unless turned off (Settings → Appearance)');
    toggle.checked = false; toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
    eq(w.localStorage.getItem('focus-bg-motion'), '0', 'turned off: kept on this device');
    await sleep(200);
    eq(await frames(S, 800), 0, 'and it holds still');
    ok(!d.body.classList.contains('motion-live') && !d.body.classList.contains('bg-motion'), 'with the little motions off');
    const before = S.frames;
    w.themeApplyPreset('daylight');
    ok(S.frames === before + 1, 'a new theme: one still frame in its colors');
    toggle.checked = true; toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
    eq(w.localStorage.getItem('focus-bg-motion'), '1', 'on again');
    ok(await frames(S, 800) >= 4, 'and it moves');

    const R = {};
    const reduced = await loadApp({ storage: BOOT, before: win => {
      withCanvas(R)(win);
      win.matchMedia = q => ({ matches: /reduce/.test(q), addListener() {}, removeListener() {} });
    } });
    await sleep(300);
    ok(R.frames >= 1 && await frames(R, 800) === 0 && !reduced.d.body.classList.contains('motion-live'),
      'Reduce motion on in the system: the still frame only');

    const O = {};
    const off = await loadApp({ storage: { ...BOOT, 'focus-bg-motion': '0' }, before: withCanvas(O) });
    await sleep(300);
    ok(!off.d.getElementById('themeMotionToggle').checked && O.frames >= 1 && await frames(O, 800) === 0, 'turned off, Focus opens still');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
