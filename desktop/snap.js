/* snap.js — Where Focus Overlay's window goes, from where it is and the screen
 * it is on. Pure, so the tests load it without Electron; main.js applies it.
 *   rect, button  { x, y, width, height }: a window, or the button in it
 *   room          { width, height }: what opens beside the button (the panel,
 *                 the running timers' clocks, or nothing: 0 × 0)
 *   area          { x, y, width, height }: the screen's work area (the part
 *                 without the menu bar and the Dock) */
const MARGIN = 12;   // between the window and the screen's edge

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/* the side of the screen the window's middle is nearer to */
function nearerSide(rect, area) {
  return rect.x + rect.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
}

/* the button, let go: against the nearer side, at the height it was let go
 * (kept on the screen) */
function snapButton(rect, area, margin = MARGIN) {
  const side = nearerSide(rect, area);
  return {
    side,
    x: side === 'left' ? area.x + margin : area.x + area.width - rect.width - margin,
    y: Math.round(clamp(rect.y, area.y + margin, area.y + area.height - rect.height - margin)),
    width: rect.width,
    height: rect.height,
  };
}

/* The window round the button: the button against the nearer side (snapButton),
 * and the room beside it, toward the middle of the screen, its top at the
 * button's unless that would take it off the bottom of the screen (then it is
 * higher, and the button lower in the window). All of it on the screen: the
 * room is smaller on a small one. buttonTop: where the button is in the window. */
function around(button, room, area, margin = MARGIN) {
  const b = snapButton(button, area, margin);
  const w = room.width > 0 ? Math.max(0, Math.min(room.width, area.width - 2 * margin - b.width)) : 0;
  const h = Math.min(room.height, area.height - 2 * margin);
  const width = b.width + w, height = Math.max(b.height, h);
  const y = Math.round(clamp(b.y, area.y + margin, area.y + area.height - height - margin));
  return { side: b.side, x: b.side === 'left' ? b.x : b.x + b.width - width, y, width, height, buttonTop: b.y - y };
}

/* the button in a window laid out round it (around) */
function buttonIn(rect, side, buttonTop, size) {
  return { x: side === 'right' ? rect.x + rect.width - size : rect.x, y: rect.y + buttonTop, width: size, height: size };
}

module.exports = { MARGIN, nearerSide, snapButton, around, buttonIn };
