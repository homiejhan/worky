/* snap.js — Where Focus Overlay's window goes, from where it is and the screen
 * it is on. Pure, so the tests load it without Electron; main.js applies it.
 *   rect, button, panel  { x, y, width, height }: the window
 *   area                 { x, y, width, height }: the screen's work area (the
 *                        part without the menu bar and the Dock) */
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

/* the panel, opened from the button: against the button's side, its top at
 * the button's top, all of it on the screen (smaller on a small one) */
function panelFrom(button, size, area, margin = MARGIN) {
  const side = nearerSide(button, area);
  const width = Math.min(size.width, area.width - 2 * margin);
  const height = Math.min(size.height, area.height - 2 * margin);
  return {
    side,
    x: side === 'left' ? area.x + margin : area.x + area.width - width - margin,
    y: Math.round(clamp(button.y, area.y + margin, area.y + area.height - height - margin)),
    width,
    height,
  };
}

/* the button again, from the panel (which its header may have moved): against
 * the side the panel is nearer to, at the panel's top */
function buttonFrom(panel, size, area, margin = MARGIN) {
  return snapButton({ x: panel.x + panel.width / 2 - size / 2, y: panel.y, width: size, height: size }, area, margin);
}

module.exports = { MARGIN, nearerSide, snapButton, panelFrom, buttonFrom };
