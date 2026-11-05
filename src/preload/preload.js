// Glassbreath preload (bundled to dist/preload.js; runs sandboxed).
// 1. SmartSpectra's bridge (window.__smartspectraBridge) for the renderer SDK.
// 2. window.glassbreath: config + local gallery, all via validated IPC in main.

require('@smartspectra/node-sdk/preload');

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('glassbreath', {
  getConfig: call('glassbreath:getConfig'),
  setApiKey: call('glassbreath:setApiKey'),
  clearApiKey: call('glassbreath:clearApiKey'),
  saveVessel: (vessel) => ipcRenderer.invoke('glassbreath:saveVessel', {
    pngDataUrl: vessel?.pngDataUrl,
    recipe: vessel?.recipe,
  }),
  listVessels: call('glassbreath:listVessels'),
  deleteVessel: (id) => ipcRenderer.invoke('glassbreath:deleteVessel', String(id)),
  deleteAll: call('glassbreath:deleteAll'),
  getProgress: call('glassbreath:getProgress'),
  saveProgress: (state) => ipcRenderer.invoke('glassbreath:saveProgress', state),
  resetProgress: call('glassbreath:resetProgress'),
  readFixture: (name) => ipcRenderer.invoke('glassbreath:readFixture', String(name)),
  copyImage: (pngDataUrl) => ipcRenderer.invoke('glassbreath:copyImage', String(pngDataUrl)),
  saveImage: (pngDataUrl, name) => ipcRenderer.invoke('glassbreath:saveImage', String(pngDataUrl), String(name)),
  openShare: (target, text) => ipcRenderer.invoke('glassbreath:openShare', String(target), String(text)),
});
