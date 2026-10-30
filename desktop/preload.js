/* preload.js — What Focus Overlay's window gives the Focus page in it
 * (window.focusOverlay, used by js/overlay.js): asking the app to move and size
 * the window, to sign in through the browser, and for the button's menu. The
 * page gets these and nothing else of the app. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusOverlay', {
  state: () => ipcRenderer.invoke('overlay:state'),                 // 'icon' | 'panel'
  expand: () => ipcRenderer.invoke('overlay:expand'),               // resolves once the window is the panel's size
  collapse: () => ipcRenderer.invoke('overlay:collapse'),           // … the button's
  dragStart: () => ipcRenderer.send('overlay:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('overlay:drag-move', Number(dx) || 0, Number(dy) || 0),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),              // goes to the nearer side
  menu: () => ipcRenderer.send('overlay:menu'),
  signIn: url => ipcRenderer.send('overlay:sign-in', String(url)),  // Google's sign-in page, in the browser
  onSignIn: cb => ipcRenderer.on('overlay:sign-in-token', (_e, token) => cb(String(token))),
});
