import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the workspace over loopback so the preview pane can render a site the
 * agent just wrote. Bound to 127.0.0.1 only — this exposes the user's project
 * folder, and must never be reachable from the network.
 */
export class PreviewServer {
  private server: Server | null = null;
  private port = 0;
  private rootDir = '';

  get url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/` : null;
  }

  setRoot(dir: string): void {
    this.rootDir = resolve(dir);
  }

  async start(dir: string): Promise<string> {
    this.setRoot(dir);
    if (this.server) return this.url!;

    this.server = createServer(async (req, res) => {
      try {
        const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
        // Normalize first, then prove the result is still under the root: a
        // request for `/../../secrets` must not escape the served folder.
        const candidate = resolve(join(this.rootDir, normalize(requested)));
        if (candidate !== this.rootDir && !candidate.startsWith(this.rootDir + sep)) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        let target = candidate;
        let stat = await fs.stat(target).catch(() => null);
        if (stat?.isDirectory()) {
          const indexFile = join(target, 'index.html');
          const indexStat = await fs.stat(indexFile).catch(() => null);
          if (indexStat?.isFile()) {
            target = indexFile;
            stat = indexStat;
          } else {
            const entries = await fs.readdir(target, { withFileTypes: true });
            const links = entries
              .map(e => {
                const name = e.name + (e.isDirectory() ? '/' : '');
                const href = join(requested, name).split(sep).join('/');
                return `<li><a href="${href}">${name}</a></li>`;
              })
              .join('');
            res.writeHead(200, { 'Content-Type': MIME['.html'] })
              .end(`<!doctype html><meta charset="utf-8"><title>Vela preview</title>
<body style="font:14px system-ui;padding:24px"><h3>Немає index.html — вміст теки:</h3><ul>${links}</ul></body>`);
            return;
          }
        }

        if (!stat?.isFile()) {
          res.writeHead(404, { 'Content-Type': MIME['.html'] })
            .end('<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px">404 — файл не знайдено</body>');
          return;
        }

        const body = await fs.readFile(target);
        res.writeHead(200, {
          'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        }).end(body);
      } catch (err) {
        res.writeHead(500).end(`Preview error: ${(err as Error).message}`);
      }
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', reject);
      // Port 0 lets the OS pick a free one, so a second Vela window or a
      // user's own dev server never collides with the preview.
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolvePromise();
      });
    });

    return this.url!;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
