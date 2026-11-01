// Bridge for the privileged browser UI only (ADR 0008).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('veilUI', {
  // Which window buttons the OS puts on the toolbar (traffic lights vs. a caption
  // overlay). Presentation only — the real platform logic stays in main/platform.js.
  // process.platform is one of the few fields a *sandboxed* preload may read.
  chrome: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  invoke: (cmd, ...args) => ipcRenderer.invoke('veil:ui', cmd, ...args),
  onState: cb => ipcRenderer.on('veil:state', (e, state) => cb(state)),
  onFocusAddress: cb => ipcRenderer.on('veil:focus-address', () => cb()),
  onFocusFind: cb => ipcRenderer.on('veil:focus-find', () => cb()),
  onFindStep: cb => ipcRenderer.on('veil:find-step', (e, forward) => cb(forward)),
})
