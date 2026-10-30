# Focus Overlay

Focus as a round button with its checkmark, above every window on your Mac.

- **Drag it** anywhere. Let go and it glides to the nearer side of the screen.
- **Click it** for a panel with your timers on the left and today's tasks on the
  right (**Daily** switches the right side to your Daily lists).
- **Minimize** (the – at the top right, or Escape) takes it back to the button.
- **Right-click** the button for **Start at login** and **Quit Focus Overlay**.

It shows the live Focus site, so it is always the latest version, and it syncs
with your other devices once signed in.

## Install

1. Download **Focus-Overlay-mac.zip** from the
   [Focus Overlay for Mac release](https://github.com/homiejhan/worky/releases/tag/desktop-latest)
   and open it (it works on Apple Silicon and Intel Macs).
2. Move **Focus Overlay** to **Applications**.
3. Open it the first time:
   - **macOS 14 and earlier:** right-click it, choose **Open**, then **Open**.
   - **macOS 15 and later:** open it once (macOS says it can't check it), then
     go to **System Settings → Privacy & Security**, scroll down and click
     **Open Anyway** next to Focus Overlay.

   macOS asks because the app isn't signed with an Apple developer account. Or,
   in Terminal: `xattr -dr com.apple.quarantine "/Applications/Focus Overlay.app"`.

The button appears against the right side of the screen. It has no Dock icon:
quit it from its right-click menu.

## Sign in

Click the button, then **Sign in to sync**. Google's sign-in opens in your
browser, where you're likely signed in already; pick your account, and when the
browser asks to open Focus Overlay, allow it. The app then takes your account's
day (it never sends its own empty one over yours).

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
