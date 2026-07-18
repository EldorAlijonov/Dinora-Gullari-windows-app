const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dinoraDesktop', {
  platform: process.platform,
});
