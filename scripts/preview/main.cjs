/**
 * Offscreen design preview.
 *
 *   node_modules\electron\dist\electron.exe scripts\preview
 *
 * Loads the real renderer bundle against a static API stub and writes PNGs to
 * screenshots/preview/. The window is never shown, so the UI can be reviewed
 * repeatedly without touching the user's desktop.
 *
 * `PREVIEW_MODE=watch` keeps the app alive and re-captures whenever the built
 * renderer changes, which is what makes CSS iteration possible.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'screenshots', 'preview');
const LOG = path.join(OUT, 'run.log');
const WATCH = process.env.PREVIEW_MODE === 'watch';

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(message) {
  fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)}  ${message}\n`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let win = null;

async function shoot(name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  const size = image.getSize();
  log(`captured ${name} ${size.width}x${size.height}`);
}

function setTheme(theme) {
  return win.webContents.executeJavaScript(`
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.documentElement.style.colorScheme = ${JSON.stringify(theme === 'light' ? 'light' : 'dark')};
  `);
}

function click(selector) {
  return win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
  );
}

async function captureSet() {
  await setTheme('indigo');
  await wait(250);
  await shoot('01-chat-indigo');

  await setTheme('light');
  await wait(300);
  await shoot('02-chat-light');

  await setTheme('dark');
  await wait(300);
  await shoot('03-chat-dark');

  await setTheme('indigo');
  await wait(200);
  await click('#settingsBtn');
  await wait(450);
  await shoot('04-settings-appearance');

  await click('[data-settings-tab="permissions"]');
  await wait(300);
  await shoot('05-settings-permissions');

  await click('[data-settings-tab="models"]');
  await wait(300);
  await shoot('06-settings-models');

  await click('[data-settings-tab="providers"]');
  await wait(300);
  await shoot('07-settings-providers');

  await click('[data-settings-tab="general"]');
  await wait(250);
  await shoot('08-settings-general');
}

function boot() {
  return new Promise(resolve => {
    win.webContents.on('console-message', (_event, _level, message) => {
      if (String(message).includes('Vela ready')) resolve('ready');
    });
    setTimeout(() => resolve('timeout'), 9000);
  });
}

async function load() {
  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
  log(`boot: ${await boot()}`);
  await wait(500);
}

function watchForChanges() {
  const files = [
    path.join(ROOT, 'dist', 'renderer', 'styles.css'),
    path.join(ROOT, 'dist', 'renderer', 'renderer.js'),
    path.join(ROOT, 'dist', 'renderer', 'index.html'),
  ];
  const stamp = () => files.map(f => {
    try { return fs.statSync(f).mtimeMs; } catch { return 0; }
  }).join(':');

  let last = stamp();
  setInterval(async () => {
    const now = stamp();
    if (now === last) return;
    last = now;
    try {
      log('change detected, reloading');
      await load();
      await captureSet();
      log('recapture done');
    } catch (err) {
      log(`reload failed: ${err.message}`);
    }
  }, 400);
}

async function main() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // A renderer crash must be visible in the log, not silent.
  win.webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason}`));
  win.webContents.on('preload-error', (_e, file, error) => log(`preload error ${file}: ${error.message}`));

  await load();
  await captureSet();
  log('all captures done');

  if (WATCH) {
    watchForChanges();
    log('watching for changes');
  } else {
    app.quit();
  }
}

app.whenReady().then(main).catch(err => {
  log(`failed: ${err && err.stack ? err.stack : err}`);
  app.exit(1);
});
