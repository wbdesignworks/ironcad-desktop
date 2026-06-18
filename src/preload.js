const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ironcad', {
  // Platform info
  platform: process.platform,
  arch: process.arch,
  version: require('../package.json').version,

  // Server URL
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  setServerUrl: (url) => ipcRenderer.invoke('set-server-url', url),

  // Connection chooser
  getDefaultServerUrl: () => ipcRenderer.invoke('get-default-server-url'),
  useDefaultServer: () => ipcRenderer.invoke('use-default-server'),
  configureServer: (url) => ipcRenderer.invoke('configure-server', url),

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Connection check
  checkConnection: () => ipcRenderer.invoke('check-connection'),

  // Notification listener — main process can push notifications to renderer
  onNotification: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('notification', handler);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener('notification', handler);
  },
});
