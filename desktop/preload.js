/* preload.js — What Focus Overlay's window gives the Focus page in it
 * (window.focusOverlay, used by js/overlay.js): asking the app to move the
 * window and to open the panel beside the button or close it, room for the
 * running timers' clocks, where the button is in the window, signing in through
 * the browser, and the button's menu. The page gets these and nothing else of
 * the app. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusOverlay', {
  state: () => ipcRenderer.invoke('overlay:state'),                 // 'icon' | 'panel'
  layout: () => ipcRenderer.invoke('overlay:layout'),               // { state, side, buttonTop }: the button against which side, how far down the window
  onLayout: cb => ipcRenderer.on('overlay:layout-changed', (_e, l) => cb(l)),   // … whenever that changes
  expand: () => ipcRenderer.invoke('overlay:expand'),               // resolves once the panel has its room beside the button
  collapse: () => ipcRenderer.invoke('overlay:collapse'),           // … once it is the button again
  clocks: (width, height) => ipcRenderer.invoke('overlay:clocks', Number(width) || 0, Number(height) || 0),   // room beside the button for the running timers
  dragStart: () => ipcRenderer.send('overlay:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('overlay:drag-move', Number(dx) || 0, Number(dy) || 0),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),              // goes to the nearer side
  menu: () => ipcRenderer.send('overlay:menu'),
  signIn: url => ipcRenderer.send('overlay:sign-in', String(url)),  // Google's sign-in page, in the browser
  onSignIn: cb => ipcRenderer.on('overlay:sign-in-token', (_e, token) => cb(String(token))),
});
