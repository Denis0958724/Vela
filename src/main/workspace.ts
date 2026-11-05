import { promises as fs, constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export class PathEscapeError extends Error {}

/** Why the agent has nowhere to work: moved folder, unplugged drive, permissions. */
export type WorkspaceProblem = 'missing' | 'not-directory' | 'unreadable';

/**
 * The working folder is gone. This is a separate error from ENOENT because the
 * UI has to offer a way out (point at the new location) instead of showing a
 * raw filesystem message halfway through a task.
 */
export class WorkspaceGoneError extends Error {
  constructor(
    readonly root: string,
    readonly problem: WorkspaceProblem,
    detail?: string,
  ) {
    super(detail ?? `Робочу папку недоступно: ${root}`);
    this.name = 'WorkspaceGoneError';
  }
}

/**
 * The agent's sandbox root. Every path a model produces is resolved through
 * `safe()`, so a hallucinated `../../Windows/System32` or an absolute
 * `C:\Users\...` cannot reach outside the folder the user opened.
 */
export class Workspace {
  private rootPath: string;

  constructor(root: string) {
    this.rootPath = resolve(root);
  }

  get root(): string {
    return this.rootPath;
  }

  setRoot(root: string): void {
    this.rootPath = resolve(root);
  }

  /**
   * Prove the folder is still there before a tool runs.
   *
   * A project can be renamed, moved to another drive, or sit on a USB stick
   * that was pulled out while the agent was thinking. Catching that here turns
   * a confusing pile of ENOENT tool failures into one precise message and a
   * chance to relink the project.
   */
  async check(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.rootPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new WorkspaceGoneError(
        this.rootPath,
        code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'missing',
      );
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceGoneError(this.rootPath, 'not-directory', `Це не папка: ${this.rootPath}`);
    }
    // `stat` can succeed on a directory we cannot open (ACL changes, a broken
    // network share). An access check is enough here: listing is the tool's job
    // and reading a huge root on every tool call would be wasteful.
    try {
      await fs.access(this.rootPath, constants.R_OK);
    } catch (err) {
      throw new WorkspaceGoneError(
        this.rootPath,
        'unreadable',
        `Папка є, але недоступна: ${this.rootPath} (${(err as Error).message})`,
      );
    }
  }

  /** Resolve a model-supplied path and prove it stays inside the root. */
  safe(input: string): string {
    if (!input || typeof input !== 'string') {
      throw new PathEscapeError('Порожній шлях');
    }
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.rootPath, input);
    const rel = relative(this.rootPath, abs);
    // `relative` returns '' for the root itself, and anything leaving the root
    // starts with '..' — on Windows it also returns an absolute path when the
    // target sits on a different drive, which `isAbsolute` catches.
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
      throw new PathEscapeError(
        `Шлях «${input}» виходить за межі робочої папки (${this.rootPath})`,
      );
    }
    return abs;
  }

  /** The root-relative form used in all user-facing output. */
  display(abs: string): string {
    const rel = relative(this.rootPath, abs);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
}
