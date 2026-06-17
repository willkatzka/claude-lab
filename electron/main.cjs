// Electron main process for Claude Lab.
//
// Starts the bridge (Agent SDK + orchestrator in-process; serves the built UI),
// waits for it, then opens a native window. Production runs the precompiled
// bundle on Electron's own Node (no tsx); dev (LAB_DEV=1) uses tsx + Vite.

const { app, BrowserWindow, shell, ipcMain, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const isDev = process.env.LAB_DEV === '1';
const APP_URL = isDev ? 'http://localhost:5173' : 'http://localhost:8787';
const HEALTH = 'http://localhost:8787/api/labs';

let bridge = null;
let mainWin = null;

// App menu (the "file dropdown"): Settings + New Lab go to the renderer via IPC;
// the standard Edit menu enables copy/paste/etc. in text fields.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action) => mainWin?.webContents.send('lab:menu', action);
  const template = [
    ...(isMac
      ? [
          {
            label: 'Claude Lab',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Lab', accelerator: 'CmdOrCtrl+N', click: () => send('new-lab') },
        ...(isMac
          ? []
          : [
              { label: 'Settings…', click: () => send('settings') },
              { type: 'separator' },
              { role: 'quit' },
            ]),
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The app bundle is read-only, so graphs/labs.json live in userData. Seed it
// from the bundled demo data on first run.
function ensureDataDir() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const seedDir = app.isPackaged ? path.join(process.resourcesPath, 'data-seed') : path.join(ROOT, 'data');
  if (!fs.existsSync(path.join(dataDir, 'labs.json')) && fs.existsSync(seedDir)) {
    for (const f of fs.readdirSync(seedDir)) {
      if (f === 'labs.json' || f.startsWith('graph')) {
        fs.copyFileSync(path.join(seedDir, f), path.join(dataDir, f));
      }
    }
  }
  return dataDir;
}

function startBridge(dataDir) {
  const env = { ...process.env, LAB_DATA_DIR: dataDir };
  const compiled = path.join(ROOT, 'dist-server', 'bridge.mjs');
  if (!isDev && fs.existsSync(compiled)) {
    // Run the precompiled bridge on Electron's bundled Node — no tsx needed.
    bridge = spawn(process.execPath, [compiled], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } else {
    // Dev: run TypeScript source via tsx.
    const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
    bridge = spawn(tsx, ['server/bridge.mjs'], { cwd: ROOT, stdio: 'inherit', env });
  }
  bridge.on('exit', (code) => console.log(`[bridge] exited ${code}`));
}

function waitForBridge(cb, tries = 80) {
  http
    .get(HEALTH, (res) => {
      res.resume();
      cb();
    })
    .on('error', () => (tries > 0 ? setTimeout(() => waitForBridge(cb, tries - 1), 250) : cb()));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Claude Lab',
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadURL(APP_URL);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin = win;
}

// Native folder picker for the "working directory" field.
ipcMain.handle('lab:pickFolder', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose a working directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  buildMenu();
  startBridge(ensureDataDir());
  waitForBridge(createWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
  if (bridge) {
    bridge.kill();
    bridge = null;
  }
}

app.on('window-all-closed', () => {
  shutdown();
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', shutdown);
