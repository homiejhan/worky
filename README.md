# Focus

Your day, one page: timers, lists, Daily routines, the calendar, a budget and an
email digest, synced across your devices.

- **Open Focus:** https://homiejhan.github.io/worky/ (on a phone or computer;
  install it from the browser to use it like an app)
- **Help:** https://homiejhan.github.io/worky/help/

## Focus Overlay for Mac

A small Mac app that puts Focus above every window as a round button with its
checkmark. Click it for your timers and today's tasks, whatever you're working in.

### 1. Download

**[Download Focus-Overlay-mac.zip](https://github.com/homiejhan/worky/releases/download/desktop-latest/Focus-Overlay-mac.zip)**
(from the [Focus Overlay for Mac release](https://github.com/homiejhan/worky/releases/tag/desktop-latest);
one app for Apple Silicon and Intel Macs)

### 2. Install

1. Open the zip, and move **Focus Overlay** to your **Applications** folder.
2. Open **Focus Overlay** from Applications.

### 3. If macOS says "Focus Overlay" Not Opened

The first time you open it, macOS says *Apple could not verify "Focus Overlay"
is free of malware*. It says that about any app that isn't signed with a paid
Apple developer account. To open it:

1. Click **Done** (not Move to Trash).
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the **Security** section. Next to *"Focus Overlay" was blocked
   to protect your Mac*, click **Open Anyway**.
4. Enter your password or use Touch ID, then click **Open Anyway** once more.

macOS won't ask again. The **Open Anyway** button shows for about an hour after
the blocked attempt; if it's gone, open the app again and it comes back.

**Or, in one step**, run this in Terminal, then open Focus Overlay as usual:

```sh
xattr -dr com.apple.quarantine "/Applications/Focus Overlay.app"
```

On macOS 14 and earlier you can instead right-click Focus Overlay, choose
**Open**, then **Open**.

### 4. Sign in

1. The checkmark button appears against the right side of your screen. Click it,
   then **sign in** at the panel's top right (or **⋯ → settings → Cloud sync**).
2. Google's sign-in opens in your browser. Pick your account, and when the
   browser asks to open Focus Overlay, allow it.

The panel then shows your own timers and Focus, kept in step with your other
devices.

### 5. Use it

- **Drag the button** anywhere. Let go and it glides to the nearer side of the screen.
- **Click it** to open the panel beside it, and again to close it. The button
  stays; drag it while the panel is open and the panel goes with it.
- **The panel:** your timers on the left (each one's name in gray over its time,
  then **est. finish**: when they'd all be done, one after another from now),
  and a tab of Focus on the right: **Home** when it opens, and **Lists**,
  **Daily**, **Calendar**, **Budget** (and **Digest**, while it's on) on the
  small round buttons under the checkmark. It's plain on purpose: a typewriter's
  letters, a task in its list's color (bold when overdue), due dates in gray (red
  when passed).
- **Clocks when minimized** (the switch under the timers): while the panel is
  closed, each running timer's time left shows beside the button.
- **⋯** at the top right: **settings**, **formats** (add or change timers and
  Daily lists), **reset the day**, **open in the browser** (all of Focus), and
  **more…** (Start at login, Quit). The **–** next to it (or Escape) closes the
  panel too.
- **Right-click the button** for **Start at login** and **Quit Focus Overlay**.
  It has no Dock icon.

It shows the live Focus site, so it's always the latest version; download it
again only when a new [release](https://github.com/homiejhan/worky/releases/tag/desktop-latest)
says the app itself changed. More in the [help](https://homiejhan.github.io/worky/help/#overlay).
Building it yourself: [desktop/README.md](desktop/README.md).

## For developers

- `npm test` runs every test (`npm ci` first).
- [EMAIL_DIGEST.md](EMAIL_DIGEST.md): how the email digest is built and delivered.
- [desktop/](desktop/): Focus Overlay (Electron); its Mac build runs on GitHub
  ([.github/workflows/desktop.yml](.github/workflows/desktop.yml)).
