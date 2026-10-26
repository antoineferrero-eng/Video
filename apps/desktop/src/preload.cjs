// Pont entre la fenêtre de contrôle (page locale) et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumiere', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  login: () => ipcRenderer.invoke('loadix:login'),
  account: () => ipcRenderer.invoke('loadix:account'),
  logout: () => ipcRenderer.invoke('loadix:logout'),
  links: (media) => ipcRenderer.invoke('loadix:links', media),
  revealAndTest: (media, linkId, summary) =>
    ipcRenderer.invoke('loadix:reveal-test', media, linkId, summary),
  testOnefichier: () => ipcRenderer.invoke('onefichier:test'),
  openReports: () => ipcRenderer.invoke('report:open-folder'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  onLog: (callback) => ipcRenderer.on('log', (_event, line) => callback(line)),
});
