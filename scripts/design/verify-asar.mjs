/** Confirm the packaged asar carries exactly what dist/ was built from. */
import asar from '@electron/asar';
import { readFileSync } from 'node:fs';

const checks = [
  ['dist\\main\\main.js', 'dist/main/main.js'],
  ['dist\\renderer\\styles.css', 'dist/renderer/styles.css'],
  ['dist\\renderer\\renderer.js', 'dist/renderer/renderer.js'],
];

let ok = true;
for (const [inside, disk] of checks) {
  const packed = asar.extractFile('release/win-unpacked/resources/app.asar', inside);
  const built = readFileSync(disk);
  const same = packed.equals(built);
  ok &&= same;
  console.log(`${same ? 'ok  ' : 'FAIL'}  ${disk} (${built.length} bytes)`);
}
process.exit(ok ? 0 : 1);
