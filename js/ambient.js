/* ambient.js — The colors behind everything: soft lights in the theme's accent
 * colors that drift and mix while Focus is in front.
 *
 * They are drawn into one small canvas, an eighth of the window each way (a few
 * KB), that the browser stretches over the window, 8 times a second. The
 * CSS blobs it replaces animated three window-sized layers on every frame, which
 * kept a CPU core three quarters busy for as long as Focus was open. This moves
 * only while Focus is in use, and rests, holding its last frame, while Focus is
 * hidden, in the background (another app has the focus and the pointer hasn't
 * moved over Focus lately), left alone for five minutes, under a dialog, behind
 * a background image, with the system's Reduce motion, or with Moving background
 * off (Settings → Appearance, each device its own). Input sets it going again,
 * from where it stopped. While it moves, body.motion-live lets the little CSS
 * motions run too (the Now badge on Home pulses).
 *
 * Without a 2D canvas (an older browser, the tests' jsdom) the still CSS blobs
 * stay. */
import { $ } from './util.js';

const AMBIENT_MOTION_LS_KEY = 'focus-bg-motion';   // '0': off on this device (on unless turned off)
let AMBIENT_FPS = 8;                      // the lights are soft and slow: 8 frames a second look as smooth as 60 here
let AMBIENT_IDLE_MS = 5 * 60 * 1000;      // Focus in front, no input for this long: rest
let AMBIENT_HOVER_MS = 15 * 1000;         // another app in front: moves while the pointer moved over Focus lately
let AMBIENT_DIALOG_MS = 1000;             // under a dialog: look again this often (closing one is not an event here)
const AMBIENT_SCALE = 1 / 8;              // canvas pixels per CSS pixel: the lights are soft, stretching loses nothing
const AMBIENT_TAU = Math.PI * 2;

/* The lights: which accent (1–3: the accent and the two derived from it), where
 * it rests (x, y as fractions of the width and height), how far it wanders and
 * how long a round takes on each axis (s, none a multiple of another, so the
 * colors never fall into the same pattern twice), its radius (a fraction of the
 * window's longer side) and its alpha at the center and at the first stop. The
 * first three sit where the CSS blobs did. */
const AMBIENT_LIGHTS = [
  { c: 1, x: 0.10, y: 0.06, ax: 0.20, ay: 0.17, tx: 33, ty: 26, fx: 0.0, fy: 1.3, r: 0.45, a0: 0.38, a1: 0.11, s1: 0.38 },
  { c: 2, x: 0.86, y: 0.96, ax: 0.20, ay: 0.19, tx: 41, ty: 30, fx: 2.1, fy: 0.4, r: 0.45, a0: 0.34, a1: 0.10, s1: 0.38 },
  { c: 3, x: 0.71, y: 0.62, ax: 0.26, ay: 0.22, tx: 50, ty: 37, fx: 4.0, fy: 2.6, r: 0.33, a0: 0.20, a1: 0.06, s1: 0.40 },
  { c: 2, x: 0.34, y: 0.80, ax: 0.24, ay: 0.16, tx: 58, ty: 43, fx: 1.1, fy: 5.0, r: 0.30, a0: 0.22, a1: 0.06, s1: 0.40 },
];

let ambientCanvas = null, ambientCtx = null;
let ambientColors = ['93,202,165', '93,202,165', '93,202,165'];
let ambientClock = 0;                 // ms of motion so far: it only runs while the lights move
let ambientLastFrame = 0;             // performance.now() of the last frame drawn while moving (0: resting)
let ambientLastInput = Date.now();
let ambientTimer = 0;
let ambientReduced = null;
let ambientResizeTimer = 0;

export function ambientMotionOn() { try { return localStorage.getItem(AMBIENT_MOTION_LS_KEY) !== '0'; } catch(e) { return true; } }
function ambientSetMotion(on) {
  try { localStorage.setItem(AMBIENT_MOTION_LS_KEY, on ? '1' : '0'); } catch(e) {}
  ambientRefresh();
}

/* The lights may move now. */
function ambientMoving() {
  if (!ambientCtx || !ambientMotionOn() || (ambientReduced && ambientReduced.matches) || document.hidden) return false;
  const bg = $('themeBg');
  if (bg && bg.classList.contains('on')) return false;      // a background image covers them
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return Date.now() - ambientLastInput < (focused ? AMBIENT_IDLE_MS : AMBIENT_HOVER_MS);
}
function ambientLive(on) {
  if (document.body.classList.contains('motion-live') !== on) document.body.classList.toggle('motion-live', on);
}

function ambientDraw() {
  const w = ambientCanvas.width, h = ambientCanvas.height, m = Math.max(w, h), t = ambientClock / 1000;
  ambientCtx.clearRect(0, 0, w, h);
  for (const L of AMBIENT_LIGHTS) {
    const rgb = ambientColors[L.c - 1];
    const x = (L.x + L.ax * Math.sin(AMBIENT_TAU * t / L.tx + L.fx)) * w;
    const y = (L.y + L.ay * Math.sin(AMBIENT_TAU * t / L.ty + L.fy)) * h;
    const r = L.r * m * (1 + 0.08 * Math.sin(AMBIENT_TAU * t / (L.tx * 0.6) + L.fy));   // and it breathes a little
    const g = ambientCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${L.a0})`);
    g.addColorStop(L.s1, `rgba(${rgb},${L.a1})`);
    g.addColorStop(0.68, `rgba(${rgb},0)`);
    ambientCtx.fillStyle = g;
    ambientCtx.fillRect(0, 0, w, h);
  }
}

function ambientTick() {
  ambientTimer = 0;
  if (!ambientMoving()) { ambientLastFrame = 0; ambientLive(false); return; }    // rests: input, the focus or the page coming back wakes it
  if (document.querySelector('.modal-overlay.show')) {      // a dialog covers it (and blurs what is behind: costly to redo)
    ambientLastFrame = 0; ambientLive(false);
    ambientTimer = setTimeout(ambientTick, AMBIENT_DIALOG_MS);
    return;
  }
  const now = performance.now();
  if (ambientLastFrame) ambientClock += Math.min(now - ambientLastFrame, 250);   // (from where it stopped: no jump after a rest)
  ambientLastFrame = now;
  ambientDraw();
  ambientLive(true);
  ambientTimer = setTimeout(ambientTick, 1000 / AMBIENT_FPS);
}
function ambientWake() { if (!ambientTimer && ambientMoving()) ambientTick(); }
function ambientInput() { ambientLastInput = Date.now(); ambientWake(); }

function ambientFit() {
  const w = Math.max(16, Math.ceil(window.innerWidth * AMBIENT_SCALE)), h = Math.max(16, Math.ceil(window.innerHeight * AMBIENT_SCALE));
  if (ambientCanvas.width !== w) ambientCanvas.width = w;
  if (ambientCanvas.height !== h) ambientCanvas.height = h;
}

function ambientStart() {
  const host = $('ambient');
  if (!host) return false;
  const el = document.createElement('canvas');
  let c = null;
  try { c = el.getContext('2d', { alpha: true }); } catch(e) {}
  if (!c) return false;                                     // the still CSS blobs stay
  ambientCanvas = el; ambientCtx = c;
  ambientCanvas.className = 'ambient-canvas';
  ambientCanvas.setAttribute('aria-hidden', 'true');
  host.appendChild(ambientCanvas);
  host.classList.add('has-canvas');
  const opts = { passive: true, capture: true };
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(type => window.addEventListener(type, ambientInput, opts));
  window.addEventListener('focus', ambientInput);
  window.addEventListener('blur', () => { ambientLastInput = 0; });  // another app: moves on only while the pointer moves over Focus
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ambientInput(); });
  window.addEventListener('resize', () => {
    clearTimeout(ambientResizeTimer);
    ambientResizeTimer = setTimeout(() => { ambientFit(); ambientDraw(); }, 150);
  });
  try {
    ambientReduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const changed = () => ambientRefresh();
    if (ambientReduced && ambientReduced.addEventListener) ambientReduced.addEventListener('change', changed);
    else if (ambientReduced && ambientReduced.addListener) ambientReduced.addListener(changed);
  } catch(e) { ambientReduced = null; }
  return true;
}

/* The theme changed (theme.js → applyTheme), or the switch, or Reduce motion:
 * its colors again, a frame drawn now (the still one, if it rests), and moving if
 * it may. */
let ambientStarted = null;
export function ambientRefresh() {
  if (ambientStarted === null) {
    $('themeMotionToggle')?.addEventListener('change', e => ambientSetMotion(e.target.checked));   // (kept with or without a canvas)
    ambientStarted = ambientStart();
  }
  const on = ambientMotionOn();
  document.body.classList.toggle('bg-motion', on);
  const toggle = $('themeMotionToggle');
  if (toggle) toggle.checked = on;
  if (!ambientStarted) return;
  const style = document.documentElement.style;
  ambientColors = ['--accent-rgb', '--accent-2-rgb', '--accent-3-rgb'].map((v, i) => style.getPropertyValue(v).trim() || ambientColors[i]);
  ambientFit();
  ambientDraw();
  if (!ambientMoving()) { clearTimeout(ambientTimer); ambientTimer = 0; ambientLastFrame = 0; ambientLive(false); }
  else ambientWake();
}
