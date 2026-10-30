# Focus Overlay

Focus as a round button with its checkmark, above every window on your Mac.

- **Drag it** anywhere. Let go and it glides to the nearer side of the screen.
- **Click it** for a panel with your timers on the left, and today's tasks and
  your Daily lists on the right.
- **⋯** (top right) has Settings, Formats, Reset the day, Open in the browser and
  the app's own menu; **–** (or Escape) minimizes it back to the button.
- **Right-click** the button for **Start at login** and **Quit Focus Overlay**.

It shows the live Focus site, so it is always the latest version, and it syncs
with your other devices once signed in.

## Install and sign in

**[Download Focus-Overlay-mac.zip](https://github.com/homiejhan/worky/releases/download/desktop-latest/Focus-Overlay-mac.zip)**,
then follow the steps in the [repository's README](../README.md#focus-overlay-for-mac):
install, what to do when macOS says *"Focus Overlay" Not Opened*, and signing in.

The first sign-in takes your account's day; the app never sends its own empty
one over yours.

## Build it yourself

On a Mac with Node.js 22:

```sh
cd desktop
npm ci
npm start          # run it from here
npm run dist:mac   # build dist/mac-universal/Focus Overlay.app
```

`FOCUS_URL=http://localhost:8080/worky/ npm start` shows a local copy of Focus
instead of the live site.

## How it is made

- `main.js`: the window (no frame, see-through, above the others, on every
  desktop), moving it while the button is dragged, sizing it for the panel, the
  sign-in hand-off (`focus-overlay://` links), the right-click menu, and where the
  button was.
- `preload.js`: what the Focus page in the window may ask of the app
  (`window.focusOverlay`).
- `snap.js`: where the window goes: the nearer side, kept on the screen.
- `../js/overlay.js`: the button and the panel, drawn by the Focus page itself
  when it finds itself in this app.

Tests: `npm test -- overlay` (the page and `snap.js`) and `npm run overlay:e2e`
from the repository's root (the app itself, driven with the mouse; needs
`npm ci` here and, on Linux, `xvfb-run`). The Mac build runs on GitHub
(`.github/workflows/desktop.yml`).
