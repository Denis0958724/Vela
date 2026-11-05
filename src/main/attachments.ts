import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';

const run = promisify(execFile);

/**
 * Turns what the user drops into the composer into something a model can read.
 *
 * Images are downscaled before being base64'd — a raw 4K screenshot is several
 * megabytes of payload for detail no model needs. Video cannot be sent at all,
 * so it is sampled into frames; without ffmpeg that is reported rather than
 * silently dropped.
 */

export type Attachment =
  | { kind: 'image'; name: string; dataUrl: string; note?: string }
  | { kind: 'text'; name: string; text: string }
  | { kind: 'error'; name: string; message: string };

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);

/** Wide enough to read UI text in a screenshot, small enough to stay cheap. */
const MAX_IMAGE_WIDTH = 1280;
/** Frames sampled from a video — enough to follow what happens, not a flipbook. */
const VIDEO_FRAMES = 8;
const MAX_TEXT_CHARS = 60_000;

/** Candidate ffmpeg locations: PATH first, then where it is commonly unpacked. */
async function findBinary(name: string): Promise<string | null> {
  const candidates = [
    name,
    join(process.env.LOCALAPPDATA ?? '', 'ffmpeg', 'ffmpeg-9.0.2-essentials_build', 'bin', `${name}.exe`),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', `${name}.exe`),
    join('C:', 'ffmpeg', 'bin', `${name}.exe`),
  ];
  for (const candidate of candidates) {
    try {
      await run(candidate, ['-version'], { timeout: 5000, windowsHide: true });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

let ffmpegPath: string | null | undefined;
let ffprobePath: string | null | undefined;

export async function hasVideoSupport(): Promise<boolean> {
  if (ffmpegPath === undefined) ffmpegPath = await findBinary('ffmpeg');
  return ffmpegPath !== null;
}

/** Downscale and re-encode, so one screenshot does not dominate the request. */
function encodeImage(buffer: Buffer, name: string): Attachment {
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    return { kind: 'error', name, message: 'не вдалося прочитати як зображення' };
  }
  const { width } = image.getSize();
  if (width > MAX_IMAGE_WIDTH) image = image.resize({ width: MAX_IMAGE_WIDTH, quality: 'good' });

  // JPEG keeps screenshots far smaller than PNG at a quality models cannot tell apart.
  const encoded = image.toJPEG(82);
  return {
    kind: 'image',
    name,
    dataUrl: `data:image/jpeg;base64,${encoded.toString('base64')}`,
  };
}

async function videoFrames(path: string): Promise<Attachment[]> {
  if (ffmpegPath === undefined) ffmpegPath = await findBinary('ffmpeg');
  if (ffprobePath === undefined) ffprobePath = await findBinary('ffprobe');

  const name = basename(path);
  if (!ffmpegPath) {
    return [{
      kind: 'error',
      name,
      message: 'ffmpeg не знайдено — відео не можна розібрати на кадри. '
        + 'Встанови ffmpeg або додай скріншоти вручну.',
    }];
  }

  let duration = 0;
  if (ffprobePath) {
    try {
      const { stdout } = await run(ffprobePath, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', path,
      ], { timeout: 20_000, windowsHide: true });
      duration = Number.parseFloat(stdout.trim()) || 0;
    } catch {
      /* fall back to a fixed rate below */
    }
  }

  const dir = await fs.mkdtemp(join(tmpdir(), 'vela-frames-'));
  try {
    // Spread the frames across the whole clip rather than sampling the opening.
    const fps = duration > 0 ? VIDEO_FRAMES / duration : 1 / 3;
    await run(ffmpegPath, [
      '-v', 'error', '-i', path,
      '-vf', `fps=${fps.toFixed(6)},scale=${MAX_IMAGE_WIDTH}:-1`,
      '-frames:v', String(VIDEO_FRAMES),
      '-q:v', '4',
      join(dir, 'f%02d.jpg'),
    ], { timeout: 120_000, windowsHide: true });

    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.jpg')).sort();
    if (!files.length) {
      return [{ kind: 'error', name, message: 'не вдалося витягти жодного кадру' }];
    }

    const step = duration > 0 ? duration / files.length : 0;
    return Promise.all(files.map(async (file, i) => {
      const buffer = await fs.readFile(join(dir, file));
      const at = step ? `${Math.round(i * step)}с` : `кадр ${i + 1}`;
      return {
        kind: 'image' as const,
        name: `${name} — ${at}`,
        dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
        note: `кадр ${i + 1}/${files.length}`,
      };
    }));
  } catch (err) {
    return [{ kind: 'error', name, message: `ffmpeg: ${(err as Error).message.slice(0, 160)}` }];
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Build attachments from a file on disk. One video expands into many frames. */
export async function fromPath(path: string): Promise<Attachment[]> {
  const name = basename(path);
  const ext = extname(path).toLowerCase();

  try {
    if (VIDEO_EXT.has(ext)) return await videoFrames(path);

    if (IMAGE_EXT.has(ext)) {
      return [encodeImage(await fs.readFile(path), name)];
    }

    const stat = await fs.stat(path);
    if (stat.size > 5_000_000) {
      return [{ kind: 'error', name, message: 'файл завеликий (>5 МБ)' }];
    }
    const text = await fs.readFile(path, 'utf8');
    // A NUL byte early on is the cheap "this is binary" test.
    if (text.slice(0, 1000).includes('\0')) {
      return [{ kind: 'error', name, message: 'двійковий файл — агент його не прочитає' }];
    }
    return [{
      kind: 'text',
      name,
      text: text.length > MAX_TEXT_CHARS
        ? `${text.slice(0, MAX_TEXT_CHARS)}\n… [обрізано, усього ${text.length} символів]`
        : text,
    }];
  } catch (err) {
    return [{ kind: 'error', name, message: (err as Error).message.slice(0, 160) }];
  }
}

/** Build an attachment from bytes, which is how a pasted screenshot arrives. */
export function fromBytes(name: string, bytes: Uint8Array): Attachment {
  return encodeImage(Buffer.from(bytes), name);
}
