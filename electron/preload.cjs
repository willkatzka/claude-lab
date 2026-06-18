// Preload: safely expose a native folder picker to the renderer (UI).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronLab', {
  // Opens the macOS folder chooser; resolves to the selected path or null.
  pickFolder: () => ipcRenderer.invoke('lab:pickFolder'),
  // Electron 32+ removed File.path; this resolves a dropped File to its absolute
  // path (used so non-image files dragged into chat can be read by the agent).
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

// Forward native-menu actions (Settings…, New Lab) to the UI as a DOM event.
ipcRenderer.on('lab:menu', (_e, action) => {
  window.dispatchEvent(new CustomEvent('lab:menu', { detail: action }));
});
