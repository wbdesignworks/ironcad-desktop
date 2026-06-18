const { app, BrowserWindow, Menu, Tray, shell, ipcMain, Notification, dialog, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

// ── Managed hosting default ────────────────────────────────────────
// One-tap default server for most users. Self-hosted/on-prem agencies
// can point the app at their own server via the connection chooser.
const DEFAULT_SERVER_URL = 'https://api.ironcad.tech';

// ── Persistent config ──────────────────────────────────────────────
const store = new Store({
  defaults: {
    serverUrl: DEFAULT_SERVER_URL,
    serverConfigured: false, // false = show connection chooser on launch
    windowBounds: { width: 1280, height: 800, x: undefined, y: undefined },
    darkMode: true,
  },
});

let mainWindow = null;
let tray = null;
let offlineOverlayVisible = false;
let connectionCheckInterval = null;
let onConnectionScreen = false; // true while the native chooser is shown

// ── Deep link protocol ─────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('ironcad', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('ironcad');
}

// ── Crash reporter ─────────────────────────────────────────────────
try {
  const { crashReporter } = require('electron');
  // submitURL is read from CRASH_REPORT_URL env var (set in production).
  // If unset, uploadToServer is forced false so crashes are only logged locally
  // and nothing is silently swallowed.
  const submitURL = process.env.CRASH_REPORT_URL || '';
  const uploadToServer = Boolean(submitURL);
  crashReporter.start({
    productName: 'IronCAD',
    submitURL,
    uploadToServer,
  });
  if (!uploadToServer) {
    console.log('[crashReporter] No CRASH_REPORT_URL set — crash dumps saved locally only');
  }
} catch (err) {
  // crashReporter not available in all Electron builds (e.g. some Linux distros)
  console.warn('[crashReporter] Could not start crash reporter:', err.message);
}

// ── Auto-updater setup ─────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.logger = null; // suppress default logging

autoUpdater.on('update-available', (info) => {
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: 'IronCAD Update Available',
      body: `Version ${info.version} is available. Click to download.`,
      icon: path.join(__dirname, '../assets/icon.png'),
    });
    notif.on('click', () => autoUpdater.downloadUpdate());
    notif.show();
  }
});

autoUpdater.on('update-downloaded', () => {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'A new version has been downloaded. Restart now to apply the update?',
    buttons: ['Restart', 'Later'],
    defaultId: 0,
  });
  if (choice === 0) autoUpdater.quitAndInstall();
});

autoUpdater.on('error', (err) => {
  // Log update errors rather than silently swallowing them.
  // The app continues to function normally without auto-updates.
  console.warn('[autoUpdater] Update check failed:', err.message);
});

// ── Connection health check ────────────────────────────────────────
async function checkServerConnection(url) {
  // Accept the namespaced route OR the host's plain /healthz alias; require a
  // JSON {status:'ok'} body so a 200 HTML page (marketing site) is NOT healthy.
  for (const path of ['/api/health', '/healthz']) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${url}${path}`, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timeout);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data && data.status === 'ok') return true;
      }
    } catch {
      // try next path
    }
  }
  return false;
}

function showOfflineOverlay() {
  if (!mainWindow || offlineOverlayVisible) return;
  offlineOverlayVisible = true;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      if (document.getElementById('ironcad-offline-overlay')) return;
      const d = document.createElement('div');
      d.id = 'ironcad-offline-overlay';
      d.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(10,10,10,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
      d.innerHTML = '<div style="width:48px;height:48px;border:4px solid #333;border-top-color:#00d4f0;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:24px;"></div>'
        + '<div style="color:#fff;font-size:20px;font-weight:600;">Reconnecting...</div>'
        + '<div style="color:#A8B2C0;font-size:14px;margin-top:8px;">Waiting for server connection</div>'
        + '<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
      document.body.appendChild(d);
    })();
  `).catch(() => {});
}

function hideOfflineOverlay() {
  if (!mainWindow || !offlineOverlayVisible) return;
  offlineOverlayVisible = false;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const d = document.getElementById('ironcad-offline-overlay');
      if (d) d.remove();
    })();
  `).catch(() => {});
}

function startConnectionMonitor() {
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  connectionCheckInterval = setInterval(async () => {
    if (onConnectionScreen) return; // don't monitor while choosing a server
    const serverUrl = store.get('serverUrl');
    const ok = await checkServerConnection(serverUrl);
    if (!ok) {
      showOfflineOverlay();
    } else {
      hideOfflineOverlay();
    }
  }, 15000);
}

// ── Connection chooser (native first-run screen) ───────────────────
function loadConnectionChooser() {
  if (!mainWindow) return;
  onConnectionScreen = true;
  hideOfflineOverlay();
  mainWindow.loadFile(path.join(__dirname, 'connection.html')).catch((err) => {
    console.warn('[connection] Failed to load chooser:', err.message);
  });
}

// Apply a chosen server URL: persist, mark configured, and load the portal.
function applyServerUrl(rawUrl) {
  let url;
  try {
    const u = new URL(String(rawUrl).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'Server address must start with http:// or https://' };
    }
    url = u.toString().replace(/\/+$/, '');
  } catch {
    return { ok: false, error: 'Enter a valid server address (e.g. https://api.ironcad.tech)' };
  }

  store.set('serverUrl', url);
  store.set('serverConfigured', true);
  onConnectionScreen = false;
  if (mainWindow) mainWindow.loadURL(url);
  return { ok: true, serverUrl: url };
}

// ── Legacy free-form URL dialog (kept for power users) ──────────────
function showServerUrlDialog() {
  const currentUrl = store.get('serverUrl');

  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    title: 'Server Settings',
    message: 'Enter the IronCAD server URL:',
    detail: `Current: ${currentUrl}\n\nClick OK to enter a new URL, or Cancel to keep the current setting.`,
    buttons: ['Configure...', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result !== 0) return;

  // Use an input dialog via a small child BrowserWindow
  const inputWin = new BrowserWindow({
    width: 480,
    height: 220,
    parent: mainWindow,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Server URL',
    backgroundColor: '#111418',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  const html = `<!DOCTYPE html>
<html><head><style>
body{margin:0;padding:24px;background:#111418;color:#fff;font-family:system-ui,sans-serif;}
label{font-size:14px;color:#A8B2C0;display:block;margin-bottom:8px;}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;background:#0A0A0A;color:#fff;border:1px solid #333;border-radius:6px;outline:none;}
input:focus{border-color:#00d4f0;}
.btns{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}
button{padding:8px 20px;border:none;border-radius:6px;font-size:14px;cursor:pointer;}
.ok{background:#C8102E;color:#fff;} .ok:hover{background:#a80d25;}
.cancel{background:#222;color:#A8B2C0;} .cancel:hover{background:#333;}
</style></head><body>
<label>Server URL</label>
<input id="url" value="${currentUrl}" autofocus />
<div class="btns">
  <button class="cancel" onclick="window.close()">Cancel</button>
  <button class="ok" onclick="save()">Save & Connect</button>
</div>
<script>
function save(){
  const v=document.getElementById('url').value.trim();
  if(v){document.title='URL:'+v;window.close();}
}
document.getElementById('url').addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape')window.close();});
</script></body></html>`;

  inputWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  inputWin.on('page-title-updated', (e, title) => {
    e.preventDefault();
    if (title.startsWith('URL:')) {
      const newUrl = title.slice(4);
      applyServerUrl(newUrl);
    }
  });
}

// ── IPC handlers ───────────────────────────────────────────────────
ipcMain.handle('get-server-url', () => store.get('serverUrl'));
ipcMain.handle('get-default-server-url', () => DEFAULT_SERVER_URL);

ipcMain.handle('set-server-url', (_event, url) => {
  const res = applyServerUrl(url);
  return res.ok ? res.serverUrl : store.get('serverUrl');
});

// Connection chooser actions
ipcMain.handle('use-default-server', () => applyServerUrl(DEFAULT_SERVER_URL));
ipcMain.handle('configure-server', (_event, url) => applyServerUrl(url));

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('check-connection', async () => {
  const serverUrl = store.get('serverUrl');
  const ok = await checkServerConnection(serverUrl);
  return { connected: ok, serverUrl };
});

// ── Window creation ────────────────────────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 600,
    title: 'IronCAD',
    backgroundColor: '#0A0A0A',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  // First run (or after "Change Connection") → show chooser; otherwise the portal.
  if (store.get('serverConfigured')) {
    onConnectionScreen = false;
    mainWindow.loadURL(store.get('serverUrl'));
  } else {
    loadConnectionChooser();
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    startConnectionMonitor();
  });

  // Persist window position + size
  const saveBounds = () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    store.set('windowBounds', { width: b.width, height: b.height, x: b.x, y: b.y });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle navigation failures (server unreachable on load)
  mainWindow.webContents.on('did-fail-load', () => {
    if (!onConnectionScreen) showOfflineOverlay();
  });
}

// ── System tray ────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../assets/icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    return; // no icon available yet
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('IronCAD');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Change Connection...',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          loadConnectionChooser();
        }
      },
    },
    {
      label: 'Server Settings...',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          showServerUrlDialog();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Application menu ───────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'IronCAD',
      submenu: [
        { label: 'About IronCAD', role: 'about' },
        { type: 'separator' },
        {
          label: 'Change Connection...',
          click: () => loadConnectionChooser(),
        },
        {
          label: 'Server Settings...',
          click: () => showServerUrlDialog(),
        },
        {
          label: 'Check for Updates...',
          click: () => autoUpdater.checkForUpdates(),
        },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Deep link handling ─────────────────────────────────────────────
function handleDeepLink(url) {
  if (!url || !mainWindow) return;
  // Parse ironcad:// URLs and navigate within the app
  try {
    const parsed = new URL(url);
    const route = parsed.pathname || '/';
    const serverUrl = store.get('serverUrl');
    mainWindow.loadURL(`${serverUrl}${route}${parsed.search || ''}`);
    mainWindow.show();
    mainWindow.focus();
  } catch {
    // Invalid URL — ignore
  }
}

// ── Single instance lock ───────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Handle deep link from second instance (Windows)
    const deepLink = commandLine.find((arg) => arg.startsWith('ironcad://'));
    if (deepLink) handleDeepLink(deepLink);
  });
}

// ── Handle open-url for macOS deep links ───────────────────────────
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── App lifecycle ──────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createMenu();
  createTray();

  // Check for updates silently on launch
  try {
    autoUpdater.checkForUpdates();
  } catch {
    // Update server not configured yet — ignore
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
