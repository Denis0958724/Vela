/**
 * Builds a runnable Vela.exe in release/win-unpacked.
 *
 *   npm run dist
 *
 * electron-builder cannot finish a normal run on this setup for two reasons,
 * so the steps it would do are driven here instead:
 *
 *  1. Its own Electron download extracted without `electron.exe`. The npm
 *     `electron` package already holds a complete dist, so `electronDist` in
 *     package.json points the packager at that.
 *  2. Its `winCodeSign` bundle — which also carries rcedit, the tool that
 *     stamps the icon into the exe — is a .7z containing macOS symlinks, and
 *     extracting those needs a privilege Windows withholds outside Developer
 *     Mode. Only the Windows half is extracted here, which needs no symlinks.
 *
 * Without step 2 the exe keeps Electron's stock icon, which is what shows up
 * when the app is pinned to the taskbar.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EXE = join(ROOT, 'release', 'win-unpacked', 'Vela.exe');
const ICO = join(ROOT, 'assets', 'icon.ico');
const SEVEN_ZIP = join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const CACHE = join(
  process.env.LOCALAPPDATA ?? '',
  'electron-builder', 'Cache', 'winCodeSign',
);

function run(file, args, options = {}) {
  execFileSync(file, args, { stdio: 'inherit', cwd: ROOT, ...options });
}

/** Locate rcedit, extracting the Windows portion of the bundle if needed. */
function findRcedit() {
  if (!existsSync(CACHE)) return null;

  for (const entry of readdirSync(CACHE)) {
    const candidate = join(CACHE, entry, 'rcedit-x64.exe');
    if (existsSync(candidate)) return candidate;
  }

  const archive = readdirSync(CACHE).find(f => f.endsWith('.7z'));
  if (!archive) return null;

  const target = join(CACHE, archive.replace(/\.7z$/, ''));
  console.log('• extracting rcedit from', archive);
  try {
    // Only rcedit is pulled out; `darwin/` holds the symlinks that cannot be
    // created without Developer Mode, and nothing here needs them.
    run(SEVEN_ZIP, ['x', join(CACHE, archive), `-o${target}`, '-y', '*rcedit*'], { stdio: 'pipe' });
  } catch {
    /* judged by whether the file appeared, not by the exit code */
  }

  const extracted = join(target, 'rcedit-x64.exe');
  return existsSync(extracted) ? extracted : null;
}

console.log('• bundling');
run(process.execPath, [join(ROOT, 'build.mjs')]);

console.log('• packaging');
try {
  run(
    join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd'),
    ['--win', 'dir'],
    {
      // Node refuses to execFile a .cmd without a shell since v20.
      shell: true,
      // Signing is not wanted, and its discovery drags in the broken bundle.
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    },
  );
} catch {
  // electron-builder exits non-zero because it cannot unpack winCodeSign's
  // macOS symlinks, but it has already written the app directory by then.
  // Whether that matters is decided by looking for the exe, not by the code.
  console.warn('• packager reported an error — перевіряю, чи exe усе-таки є');
}

if (!existsSync(EXE)) {
  console.error('ПОМИЛКА: Vela.exe не створено.');
  process.exit(1);
}

const rcedit = findRcedit();
if (!rcedit) {
  console.warn('УВАГА: rcedit не знайдено — exe матиме стокову іконку Electron.');
} else {
  console.log('• stamping icon');
  run(rcedit, [
    EXE,
    '--set-icon', ICO,
    '--set-version-string', 'ProductName', 'Vela',
    '--set-version-string', 'FileDescription', 'Vela',
    '--set-version-string', 'CompanyName', 'Vela',
  ]);
}

console.log(`\nГотово: ${EXE}`);
console.log('Закріплюй на панелі завдань саме цей файл — іконка береться з нього.');
