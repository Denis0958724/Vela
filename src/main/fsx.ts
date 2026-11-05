import { promises as fs } from 'node:fs';

/**
 * Write a file as atomically as the filesystem allows.
 *
 * The temp-file-plus-rename dance is what keeps a crash mid-write from leaving
 * a truncated file. But `rename` is not universally available even within one
 * directory: a redirected or synced `AppData\Roaming` answers EXDEV
 * ("cross-device link not permitted"), which took the app down on startup
 * before this fallback existed. Losing atomicity is far better than losing the
 * write, so a failed rename falls back to writing in place.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  // A unique temp name, not a shared `file.tmp`: a turn's final save and the
  // next queued turn's checkpoint can overlap, and two writers must not share
  // the same scratch file.
  const tmp = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    await fs.writeFile(file, data, 'utf8');
  }
}
