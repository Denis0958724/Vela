/**
 * Start the real main-process bundle under Node with a mock `electron`.
 *
 *   node scripts/design/startup-smoke.mjs
 *
 * This cannot render anything, but it does execute the actual startup path the
 * app takes on launch — settings, store, providers, the agent, IPC registration
 * and window creation — so a JavaScript-level crash shows up here instead of in
 * a silent "app does not open".
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const ROOT = join(tmpdir(), 'vela-startup-smoke');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const calls = [];
const record = (name) => (...args) => { calls.push(`${name}(${args.length})`); };

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.webContents = {
      setWindowOpenHandler: record('setWindowOpenHandler'),
      on: record('webContents.on'),
      send: record('webContents.send'),
      openDevTools: record('openDevTools'),
      session: { setPermissionRequestHandler: record('setPermissionRequestHandler') },
    };
    this.destroyed = false;
    calls.push(`BrowserWindow(height=${options.height}, width=${options.width}, titleBarStyle=${options.titleBarStyle}, overlay=${options.titleBarOverlay ? 'yes' : 'no'})`);
  }
  loadFile() { calls.push('loadFile'); return Promise.resolve(); }
  loadURL() { calls.push('loadURL'); return Promise.resolve(); }
  on() { return this; }
  once() { return this; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  setTitleBarOverlay(o) { calls.push(`setTitleBarOverlay(${JSON.stringify(o)})`); }
  setBackgroundColor(c) { calls.push(`setBackgroundColor(${c})`); }
  showInactive() {}
  hide() {}
  show() {}
  focus() {}
  destroy() { this.destroyed = true; }
  getBounds() { return { x: 0, y: 0, width: 1536, height: 864 }; }
  setBounds() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  maximize() {}
  isMaximized() { return false; }
  get webContentsId() { return 1; }
}

const fakeElectron = {
  app: {
    whenReady: () => Promise.resolve(),
    on: record('app.on'),
    once: record('app.once'),
    quit: record('app.quit'),
    exit: record('app.exit'),
    getPath: (name) => {
      const map = {
        userData: join(ROOT, 'userData'),
        home: join(ROOT, 'home'),
        desktop: join(ROOT, 'home', 'Desktop'),
        documents: join(ROOT, 'home', 'Documents'),
        downloads: join(ROOT, 'home', 'Downloads'),
        appData: join(ROOT, 'appData'),
        temp: ROOT,
      };
      const value = map[name] ?? join(ROOT, name);
      mkdirSync(value, { recursive: true });
      return value;
    },
    setPath: record('app.setPath'),
    setAppUserModelId: record('app.setAppUserModelId'),
    getVersion: () => '0.1.0',
    isPackaged: false,
    disableHardwareAcceleration: record('app.disableHardwareAcceleration'),
    requestSingleInstanceLock: () => true,
    getAppPath: () => process.cwd(),
  },
  BrowserWindow: FakeWindow,
  dialog: {
    showErrorBox: (title, message) => { calls.push(`showErrorBox(${title})`); console.log(`\n!! dialog.showErrorBox: ${title}\n${String(message).split('\n')[0]}\n`); },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  ipcMain: { handle: record('ipcMain.handle'), on: record('ipcMain.on') },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1536, height: 864 }, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 }),
    getDisplayNearestPoint: () => ({ workAreaSize: { width: 1536, height: 864 } }),
    getAllDisplays: () => [{ workAreaSize: { width: 1536, height: 864 } }],
    on: record('screen.on'),
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => '' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({ toPNG: () => Buffer.alloc(0) }) }) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  Menu: { setApplicationMenu: record('Menu.setApplicationMenu'), buildFromTemplate: () => ({}) },
  clipboard: { readText: () => '', writeText: () => {} },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.apply(this, arguments);
};

// Let the startup promise chain settle, then report.
const started = Date.now();
require(join(process.cwd(), 'dist/main/main.js'));

setTimeout(() => {
  const crashed = calls.some(c => c.startsWith('showErrorBox'));
  const opened = calls.some(c => c.startsWith('BrowserWindow('));
  console.log('\n--- startup trace ---');
  const interesting = calls.filter(c => /^(BrowserWindow\(|setTitleBarOverlay|setBackgroundColor|loadFile|showErrorBox)/.test(c));
  for (const line of interesting) console.log('  ' + line);
  console.log(`\nwindow created: ${opened}`);
  console.log(`error dialog  : ${crashed}`);
  console.log(`elapsed       : ${Date.now() - started}ms`);
  process.exit(crashed || !opened ? 1 : 0);
}, 2500);
