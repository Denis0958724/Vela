/**
 * Renders assets/icon.svg into the two files Windows needs:
 *   assets/icon.png — exactly 256×256, used by the BrowserWindow and the gallery
 *   assets/icon.ico — multi-size, the only thing the taskbar and Explorer read
 *
 *   npm run icon
 *
 * Electron is already a dependency and ships a full renderer, so it does the
 * rasterising — no image library, no network, nothing extra to install.
 *
 * The window must be transparent. Loading an SVG as a document gives it the
 * browser's default white page background, which fills the corners outside the
 * squircle and makes the icon render as a plain square — the rounding is in the
 * file but invisible in the output.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const { promises: fs, readFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZE = 256;
/** Sizes Windows picks between: the taskbar uses 32, the tray 16, tiles 256. */
const ICO_SIZES = [256, 64, 48, 32, 16];
const ROOT = join(__dirname, '..');

/**
 * Pack PNGs into an .ico. The format is a 6-byte header, one 16-byte directory
 * entry per image, then the payloads — and Vista and later accept PNG payloads
 * directly, so no BMP encoding is needed.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);  // palette size
    entry.writeUInt8(0, 3);  // reserved
    entry.writeUInt16LE(1, 4);  // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = readFileSync(join(ROOT, 'assets', 'icon.svg'), 'utf8');
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
</style>
${svg}`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Give the compositor a frame to paint before grabbing it.
  await new Promise(resolve => setTimeout(resolve, 600));

  // capturePage measures in CSS pixels but writes device pixels, so on a scaled
  // display the capture is larger than SIZE and never divides evenly. Capture
  // whatever the display gives, then resize down to the exact size.
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const master = shot.getSize().width === SIZE
    ? shot
    : shot.resize({ width: SIZE, height: SIZE, quality: 'best' });

  const pngPath = join(ROOT, 'assets', 'icon.png');
  await fs.writeFile(pngPath, master.toPNG());

  const images = ICO_SIZES.map(size => ({
    size,
    data: (size === SIZE ? master : master.resize({ width: size, height: size, quality: 'best' })).toPNG(),
  }));
  const icoPath = join(ROOT, 'assets', 'icon.ico');
  await fs.writeFile(icoPath, buildIco(images));

  // Prove the corners actually came out transparent; a silent regression here
  // is exactly what produced a square-looking icon before.
  const check = nativeImage.createFromPath(pngPath);
  const bitmap = check.getBitmap();
  const cornerAlpha = bitmap[3];
  const centreAlpha = bitmap[((128 * SIZE) + 128) * 4 + 3];

  console.log(`png: ${pngPath} (${master.getSize().width}×${master.getSize().height})`);
  console.log(`ico: ${icoPath} (${ICO_SIZES.join(', ')} px)`);
  console.log(`corner alpha=${cornerAlpha} (має бути 0), centre alpha=${centreAlpha} (має бути 255)`);

  win.destroy();
  app.quit();
  if (cornerAlpha !== 0 || centreAlpha !== 255) {
    process.exitCode = 1;
    console.error('ПОМИЛКА: кути не прозорі — заокруглення не буде видно.');
  }
});
