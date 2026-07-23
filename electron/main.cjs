const fs = require('fs');
const path = require('path');

const earlyLogDir = path.join(process.env.APPDATA || process.cwd(), 'dinora-gullari-windows', 'logs');
fs.mkdirSync(earlyLogDir, { recursive: true });
const mainLogPath = path.join(earlyLogDir, 'desktop-main.log');
function logMain(message) {
  fs.appendFileSync(mainLogPath, `${new Date().toISOString()} ${message}\n`);
}

logMain('main module loading');

const { app, BrowserWindow, Menu, Tray, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const http = require('http');

const backendPort = Number(process.env.DINORA_BACKEND_PORT || 5000);
const backendStartupTimeoutMs = Number(process.env.DINORA_BACKEND_TIMEOUT_MS || 300000);
const updateCheckIntervalMs = Number(process.env.DINORA_UPDATE_INTERVAL_MS || 6 * 60 * 60 * 1000);
let backendProcess;
let mainWindow;
let tray;
let isQuitting = false;
let updateCheckTimer;
let updateCheckInProgress = false;
let updateDialogShown = false;
let installingUpdate = false;
let updaterConfigured = false;
let lastUpdateProgressLogAt = 0;

function rootPath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, '..', ...parts);
}

function formatLogValue(value) {
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function updaterLog(level, value) {
  logMain(`[updater:${level}] ${formatLogValue(value)}`);
}

function setupAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (!app.isPackaged) {
    logMain('auto updater skipped in development');
    return;
  }

  autoUpdater.logger = {
    info: (value) => updaterLog('info', value),
    warn: (value) => updaterLog('warn', value),
    error: (value) => updaterLog('error', value),
    debug: (value) => updaterLog('debug', value),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    logMain('checking for app update');
  });

  autoUpdater.on('update-available', (info) => {
    logMain(`app update available version=${info.version || 'unknown'}`);
  });

  autoUpdater.on('update-not-available', (info) => {
    updateCheckInProgress = false;
    logMain(`app update not available current=${info.version || 'unknown'}`);
  });

  autoUpdater.on('download-progress', (progress) => {
    const now = Date.now();
    if (now - lastUpdateProgressLogAt < 5000) return;

    lastUpdateProgressLogAt = now;
    logMain(`app update downloading percent=${Math.round(progress.percent || 0)}`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updateCheckInProgress = false;
    logMain(`app update downloaded version=${info.version || 'unknown'}`);

    if (updateDialogShown || installingUpdate) return;
    updateDialogShown = true;

    try {
      const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const result = await dialog.showMessageBox(targetWindow, {
        type: 'info',
        title: 'Dinora Gullari yangilanishi',
        message: 'Yangi versiya yuklandi.',
        detail: "Dasturni hozir qayta ishga tushirib o'rnatilsinmi?",
        buttons: ["Hozir o'rnatish", 'Keyinroq'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });

      if (result.response === 0) {
        installingUpdate = true;
        autoUpdater.quitAndInstall(false, true);
      }
    } catch (error) {
      logMain(`update install dialog failed ${error instanceof Error ? error.stack || error.message : String(error)}`);
      updateDialogShown = false;
    }
  });

  autoUpdater.on('error', (error) => {
    updateCheckInProgress = false;
    logMain(`app update error ${error instanceof Error ? error.stack || error.message : String(error)}`);
  });
}

async function checkForAppUpdates(reason) {
  if (!app.isPackaged || installingUpdate || updateCheckInProgress) return;

  updateCheckInProgress = true;
  logMain(`app update check requested reason=${reason}`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    updateCheckInProgress = false;
    logMain(`app update check failed ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

function scheduleUpdateChecks() {
  setupAutoUpdater();

  if (!app.isPackaged) return;

  setTimeout(() => {
    checkForAppUpdates('startup');
  }, 15000);

  updateCheckTimer = setInterval(() => {
    checkForAppUpdates('interval');
  }, updateCheckIntervalMs);
}

function desktopBackendEnv() {
  return {
    ELECTRON_DESKTOP: 'true',
    LOCAL_DATABASE_ENABLED: 'true',
    PORT: String(backendPort),
    CLIENT_URLS: 'http://localhost:5173,http://127.0.0.1:5173,file://,null',
    COOKIE_SECURE: 'false',
    COOKIE_SAME_SITE: 'lax',
    JWT_SECRET: process.env.JWT_SECRET || 'desktop_local_jwt_secret_change_later_123456',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  };
}

function waitForBackend(timeoutMs = backendStartupTimeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let finished = false;
    let lastLogAt = 0;

    const retry = (reason) => {
      if (finished) return;
      const elapsedMs = Date.now() - startedAt;

      if (elapsedMs > timeoutMs) {
        finished = true;
        reject(new Error(`Backend did not start in time (${Math.round(timeoutMs / 1000)}s). Last connection error: ${reason}`));
        return;
      }

      if (Date.now() - lastLogAt > 10000) {
        lastLogAt = Date.now();
        logMain(`waiting for backend elapsed=${Math.round(elapsedMs / 1000)}s last=${reason}`);
      }

      setTimeout(tick, 500);
    };

    const tick = () => {
      if (finished) return;
      if (backendProcess && backendProcess.exitCode !== null) {
        finished = true;
        reject(new Error(`Backend process exited before startup. Code: ${backendProcess.exitCode}`));
        return;
      }

      let handled = false;
      const fail = (reason) => {
        if (handled) return;
        handled = true;
        retry(reason);
      };

      const request = http.get(`http://127.0.0.1:${backendPort}/settings/public`, (response) => {
        if (handled) return;
        handled = true;
        response.resume();
        if (response.statusCode && response.statusCode >= 500) {
          retry(`HTTP ${response.statusCode}`);
          return;
        }
        finished = true;
        logMain(`backend health check ok status=${response.statusCode || 'unknown'}`);
        resolve();
      });
      request.on('error', (error) => fail(error.code || error.message));
      request.setTimeout(1000, () => {
        fail('health check timeout');
        request.destroy();
      });
    };
    tick();
  });
}

function startBackend() {
  logMain(`startBackend packaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`);
  const backendMain = rootPath('backend', 'dist', 'main.js');
  const backendCwd = rootPath('backend');
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const packagedNodeExecutable = rootPath('runtime', 'node.exe');
  const hasPackagedNode = app.isPackaged && fs.existsSync(packagedNodeExecutable);
  const nodeExecutable = hasPackagedNode ? packagedNodeExecutable : app.isPackaged ? process.execPath : 'node';
  const args = [backendMain];
  const out = fs.openSync(path.join(logDir, 'backend.out.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'backend.err.log'), 'a');
  const electronNodeFallback = app.isPackaged && !hasPackagedNode;

  if (electronNodeFallback) {
    logMain(`packaged node runtime missing, falling back to ELECTRON_RUN_AS_NODE path=${packagedNodeExecutable}`);
  }

  backendProcess = spawn(nodeExecutable, args, {
    cwd: backendCwd,
    windowsHide: true,
    env: {
      ...process.env,
      ...desktopBackendEnv(),
      ...(electronNodeFallback ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stdio: ['ignore', out, err],
  });
  logMain(`backend spawned pid=${backendProcess.pid} executable=${nodeExecutable} main=${backendMain}`);

  backendProcess.on('error', (error) => {
    logMain(`backend spawn error ${error.stack || error.message}`);
    fs.appendFileSync(path.join(logDir, 'backend.err.log'), `${new Date().toISOString()} ${error.stack || error.message}\n`);
  });

  backendProcess.on('exit', (code) => {
    logMain(`backend exited code=${code}`);
    if (code && mainWindow) {
      dialog.showErrorBox('Dinora Gullari', `Backend to'xtadi. Kod: ${code}`);
    }
  });
}

function appIconPath() {
  return rootPath('assets', 'icon.ico');
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch((error) => {
      logMain(`show window failed ${error instanceof Error ? error.stack || error.message : String(error)}`);
    });
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;

  tray = new Tray(appIconPath());
  tray.setToolTip('Dinora Gullari');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Ochish',
        click: showMainWindow,
      },
      {
        label: 'Yashirish',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.hide();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Chiqish',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  logMain('tray created');
}

async function createWindow() {
  logMain('createWindow');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 720,
    title: 'Dinora Gullari',
    icon: appIconPath(),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('close', (event) => {
    if (isQuitting || installingUpdate) return;

    event.preventDefault();
    mainWindow.hide();
  });

  await waitForBackend();
  logMain('backend ready');

  if (!app.isPackaged && process.env.ELECTRON_LOAD_DEV_SERVER === 'true') {
    await mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    await mainWindow.loadFile(rootPath('frontend', 'dist', 'index.html'));
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  logMain('second instance rejected');
  app.quit();
} else {
  app.on('second-instance', () => {
    logMain('second instance requested');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    logMain('app ready');
    try {
      startBackend();
      await createWindow();
      createTray();
      scheduleUpdateChecks();
    } catch (error) {
      logMain(`startup error ${error instanceof Error ? error.stack || error.message : String(error)}`);
      dialog.showErrorBox('Dinora Gullari', error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    logMain('all windows closed, keeping app in tray');
  });

  app.on('before-quit', () => {
    isQuitting = true;

    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = undefined;
    }

    if (tray) {
      tray.destroy();
      tray = undefined;
    }

    if (backendProcess && !backendProcess.killed) {
      backendProcess.kill();
    }
  });
}
