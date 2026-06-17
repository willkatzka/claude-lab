// Preload: safely expose a native folder picker to the renderer (UI).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronLab', {
  // Opens the macOS folder chooser; resolves to the selected path or null.
  pickFolder: () => ipcRenderer.invoke('lab:pickFolder'),
});

// Forward native-menu actions (Settings…, New Lab) to the UI as a DOM event.
ipcRenderer.on('lab:menu', (_e, action) => {
  window.dispatchEvent(new CustomEvent('lab:menu', { detail: action }));
});
