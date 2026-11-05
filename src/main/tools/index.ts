import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolSchema } from '../types.js';
import type { Workspace } from '../workspace.js';

/** Directories never worth walking into when listing or searching. */
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'release']);

/** Tool output is fed back into the context window, so it has to stay bounded. */
const MAX_OUTPUT = 30_000;

function clip(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [обрізано, усього ${text.length} символів]`;
}

export interface ToolContext {
  workspace: Workspace;
  /** Resolves true when the user allows a side-effecting call. */
  requireApproval(name: string, args: unknown, detail: string, highRisk?: boolean): Promise<boolean>;
  signal: AbortSignal;
  /** Skill lookup, injected so the tool layer stays independent of the registry. */
  loadSkill(name: string): Promise<{ name: string; description: string; body: string } | null>;
  skillNames(): Promise<string[]>;
  /** Opens a validated http(s) URL in the user's default browser. */
  openExternal?: (url: string) => Promise<void>;
}

export interface Tool {
  schema: ToolSchema;
  /** Hidden unless the matching permission is enabled in Settings. */
  permission?: 'internet' | 'files' | 'computer';
  /** In auto mode this still asks; in ask mode everything asks. */
  risk?: 'high';
  /** Enabled by an explicit permission and intentionally runs without prompts. */
  autonomous?: boolean;
  /** Non-null means the call must be approved, and explains what it will do. */
  approvalDetail?(args: any, ctx: ToolContext): string | null;
  run(args: any, ctx: ToolContext): Promise<string>;
}

function def(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSchema {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

const readFile: Tool = {
  schema: def(
    'read_file',
    'Прочитати текстовий файл із робочої папки. Повертає вміст із номерами рядків.',
    {
      path: { type: 'string', description: 'Шлях відносно робочої папки' },
      offset: { type: 'number', description: 'З якого рядка починати (з 1)' },
      limit: { type: 'number', description: 'Скільки рядків прочитати' },
    },
    ['path'],
  ),
  async run(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    const raw = await fs.readFile(abs, 'utf8');
    const lines = raw.split('\n');
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const end = args.limit ? start + args.limit : lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
    const header = `${ctx.workspace.display(abs)} (${lines.length} рядків)`;
    return clip(`${header}\n${numbered}`);
  },
};

const writeFile: Tool = {
  permission: 'files',
  schema: def(
    'write_file',
    'Створити файл або повністю перезаписати наявний. Батьківські теки створюються автоматично.',
    {
      path: { type: 'string', description: 'Шлях відносно робочої папки' },
      content: { type: 'string', description: 'Повний вміст файлу' },
    },
    ['path', 'content'],
  ),
  approvalDetail(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    const bytes = Buffer.byteLength(args.content ?? '', 'utf8');
    return `Запис ${ctx.workspace.display(abs)} (${bytes} байт)`;
  },
  async run(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    let existed = true;
    try {
      await fs.access(abs);
    } catch {
      existed = false;
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content ?? '', 'utf8');
    const action = existed ? 'перезаписано' : 'створено';
    return `${action}: ${ctx.workspace.display(abs)} (${Buffer.byteLength(args.content ?? '')} байт)`;
  },
};

const editFile: Tool = {
  permission: 'files',
  schema: def(
    'edit_file',
    'Точкова заміна тексту у файлі. old_str мусить зустрічатися РІВНО один раз, інакше заміна не відбудеться.',
    {
      path: { type: 'string', description: 'Шлях відносно робочої папки' },
      old_str: { type: 'string', description: 'Текст, який замінити (точний збіг з відступами)' },
      new_str: { type: 'string', description: 'Новий текст' },
    },
    ['path', 'old_str', 'new_str'],
  ),
  approvalDetail(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    return `Правка ${ctx.workspace.display(abs)}`;
  },
  async run(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    const raw = await fs.readFile(abs, 'utf8');
    const parts = raw.split(args.old_str);
    if (parts.length === 1) {
      return `ПОМИЛКА: old_str не знайдено у ${ctx.workspace.display(abs)}. Прочитай файл і повтори з точним текстом.`;
    }
    if (parts.length > 2) {
      return `ПОМИЛКА: old_str зустрічається ${parts.length - 1} разів у ${ctx.workspace.display(abs)}. Додай контексту, щоб збіг був унікальним.`;
    }
    await fs.writeFile(abs, parts.join(args.new_str), 'utf8');
    return `відредаговано: ${ctx.workspace.display(abs)}`;
  },
};

const listDir: Tool = {
  schema: def(
    'list_dir',
    'Показати дерево файлів робочої папки. node_modules, .git і теки збірки пропускаються.',
    {
      path: { type: 'string', description: 'Тека (типово — корінь робочої папки)' },
      depth: { type: 'number', description: 'Глибина вкладеності, типово 2' },
    },
    [],
  ),
  async run(args, ctx) {
    const rootAbs = ctx.workspace.safe(args.path ?? '.');
    const maxDepth = args.depth ?? 2;
    const out: string[] = [];

    async function walk(dir: string, depth: number, prefix: string): Promise<void> {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) =>
        a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
      );
      // Sizes are gathered in one batch: awaiting a stat per entry turned a
      // wide directory into hundreds of sequential round trips.
      const files = entries.filter(e => !e.isDirectory() && !IGNORED.has(e.name));
      const sizes = new Map<string, number>();
      await Promise.all(files.map(async e => {
        try {
          sizes.set(e.name, (await fs.stat(join(dir, e.name))).size);
        } catch {
          /* unreadable entry: the name alone is still useful */
        }
      }));

      for (const e of entries) {
        if (IGNORED.has(e.name)) {
          out.push(`${prefix}${e.name}/ …пропущено`);
          continue;
        }
        if (e.isDirectory()) {
          out.push(`${prefix}${e.name}/`);
          await walk(join(dir, e.name), depth + 1, `${prefix}  `);
        } else {
          const size = sizes.has(e.name) ? ` (${sizes.get(e.name)}b)` : '';
          out.push(`${prefix}${e.name}${size}`);
        }
      }
    }

    await walk(rootAbs, 1, '');
    return clip(`${ctx.workspace.display(rootAbs)}/\n${out.join('\n') || '(порожньо)'}`);
  },
};

const searchFiles: Tool = {
  schema: def(
    'search_files',
    'Пошук за регулярним виразом у текстових файлах робочої папки. Повертає шлях, номер рядка і сам рядок.',
    {
      pattern: { type: 'string', description: 'JavaScript-регулярний вираз' },
      glob: { type: 'string', description: 'Фільтр за розширенням, напр. ".ts" або ".html"' },
      max_results: { type: 'number', description: 'Ліміт збігів, типово 80' },
    },
    ['pattern'],
  ),
  async run(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, 'i');
    } catch (err) {
      return `ПОМИЛКА: некоректний регвираз — ${(err as Error).message}`;
    }
    const limit = args.max_results ?? 80;
    const hits: string[] = [];

    async function walk(dir: string): Promise<void> {
      if (hits.length >= limit || ctx.signal.aborted) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= limit) return;
        if (IGNORED.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        if (args.glob && !e.name.endsWith(args.glob)) continue;
        let text: string;
        try {
          const stat = await fs.stat(full);
          if (stat.size > 2_000_000) continue;
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        // A NUL byte in the first chunk is the cheap binary test.
        if (text.slice(0, 1000).includes('\0')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i])) {
            hits.push(`${ctx.workspace.display(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }
    }

    await walk(ctx.workspace.root);
    return clip(hits.length ? hits.join('\n') : `Збігів для /${args.pattern}/ не знайдено.`);
  },
};

const makeDir: Tool = {
  permission: 'files',
  schema: def('make_dir', 'Створити теку (разом із батьківськими).', {
    path: { type: 'string', description: 'Шлях відносно робочої папки' },
  }, ['path']),
  async run(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    await fs.mkdir(abs, { recursive: true });
    return `створено теку: ${ctx.workspace.display(abs)}`;
  },
};

const deletePath: Tool = {
  permission: 'files',
  risk: 'high',
  schema: def('delete_path', 'Видалити файл або теку з робочої папки.', {
    path: { type: 'string', description: 'Шлях відносно робочої папки' },
    recursive: { type: 'boolean', description: 'Видаляти теку з вмістом' },
  }, ['path']),
  approvalDetail(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    return `ВИДАЛЕННЯ ${ctx.workspace.display(abs)}${args.recursive ? ' (рекурсивно)' : ''}`;
  },
  async run(args, ctx) {
    const abs = ctx.workspace.safe(args.path);
    if (abs === ctx.workspace.root) return 'ПОМИЛКА: не можу видалити саму робочу папку.';
    await fs.rm(abs, { recursive: Boolean(args.recursive), force: false });
    return `видалено: ${ctx.workspace.display(abs)}`;
  },
};

const runShell: Tool = {
  permission: 'files',
  risk: 'high',
  schema: def(
    'run_shell',
    'Виконати команду в PowerShell у робочій папці. Доступні npm, node, git. Інтерактивні команди не працюють.',
    {
      command: { type: 'string', description: 'Команда PowerShell' },
      timeout_ms: { type: 'number', description: 'Таймаут, типово 120000' },
    },
    ['command'],
  ),
  approvalDetail(args) {
    return `Запуск: ${args.command}`;
  },
  run(args, ctx) {
    return new Promise<string>(resolvePromise => {
      const timeout = Math.min(args.timeout_ms ?? 120_000, 600_000);
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', args.command],
        { cwd: ctx.workspace.root, windowsHide: true },
      );

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (summary: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const body = [
          stdout.trim() && `stdout:\n${stdout.trim()}`,
          stderr.trim() && `stderr:\n${stderr.trim()}`,
        ].filter(Boolean).join('\n\n');
        resolvePromise(clip(`${summary}${body ? `\n${body}` : '\n(без виводу)'}`));
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(`ТАЙМАУТ після ${timeout}ms.`);
      }, timeout);

      const onAbort = () => {
        child.kill();
        finish('СКАСОВАНО користувачем.');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => finish(`ПОМИЛКА ЗАПУСКУ: ${err.message}`));
      child.on('close', code => finish(`exit code ${code}`));
    });
  },
};

function webUrl(input: unknown): string {
  let url: URL;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new Error('Некоректна адреса. Потрібен повний http або https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Дозволені лише http і https.');
  }
  return url.toString();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchText(url: string, signal: AbortSignal, referer?: string): Promise<{ finalUrl: string; type: string; text: string }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Vela/0.1',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
        ...(referer ? { referer } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get('content-type') ?? '';
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > 3_000_000) throw new Error('Сторінка завелика для читання.');
    const text = await res.text();
    return { finalUrl: res.url || url, type, text };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runPowerShell(script: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout.trim() || '(без виводу)');
      else reject(new Error(stderr.trim() || `PowerShell exit ${code}`));
    });
  });
}

const openUrl: Tool = {
  permission: 'internet',
  schema: def(
    'open_url',
    'Відкрити http або https сторінку в типовому браузері користувача.',
    { url: { type: 'string', description: 'Повна адреса сторінки' } },
    ['url'],
  ),
  approvalDetail(args) {
    return `Відкрити в браузері: ${webUrl(args.url)}`;
  },
  async run(args, ctx) {
    const url = webUrl(args.url);
    if (!ctx.openExternal) return 'ПОМИЛКА: відкриття браузера недоступне.';
    await ctx.openExternal(url);
    return `Відкрито в браузері: ${url}`;
  },
};

const webFetch: Tool = {
  permission: 'internet',
  schema: def(
    'web_fetch',
    'Завантажити сторінку або текстовий файл з інтернету й повернути читабельний текст.',
    {
      url: { type: 'string', description: 'Повна http або https адреса' },
      max_chars: { type: 'number', description: 'Скільки символів повернути, типово 20000' },
    },
    ['url'],
  ),
  approvalDetail(args) {
    return `Завантажити з інтернету: ${webUrl(args.url)}`;
  },
  async run(args, ctx) {
    const url = webUrl(args.url);
    const { finalUrl, type, text } = await fetchText(url, ctx.signal);
    const limit = Math.min(40_000, Math.max(1000, Number(args.max_chars) || 20_000));
    if (type.includes('html')) {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? '';
      const body = htmlToText(text).slice(0, limit);
      return clip(`URL: ${finalUrl}\nTitle: ${htmlToText(title).slice(0, 200)}\n\n${body}`);
    }
    if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) {
      return clip(`URL: ${finalUrl}\nType: ${type}\n\n${text.slice(0, limit)}`);
    }
    return `ПОМИЛКА: це не текстовий ресурс (${type || 'невідомий тип'}).`;
  },
};

const webSearch: Tool = {
  permission: 'internet',
  schema: def(
    'web_search',
    'Пошук в інтернеті. Повертає кілька результатів із назвами, адресами й описами.',
    {
      query: { type: 'string', description: 'Пошуковий запит' },
      limit: { type: 'number', description: 'Скільки результатів, типово 6' },
    },
    ['query'],
  ),
  approvalDetail(args) {
    return `Пошук в інтернеті: ${String(args.query ?? '').slice(0, 200)}`;
  },
  async run(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'ПОМИЛКА: порожній запит.';
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { finalUrl, type, text } = await fetchText(url, ctx.signal);
    if (!type.includes('html')) return `ПОМИЛКА: пошук повернув ${type || 'не текст'}.`;
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 6));
    const results: string[] = [];
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) && results.length < limit) {
      let href = match[1].replace(/&amp;/g, '&');
      const title = htmlToText(match[2]).replace(/\s+/g, ' ').trim();
      if (!title) continue;
      try {
        const parsed = new URL(href, finalUrl);
        const wrapped = parsed.searchParams.get('uddg');
        href = wrapped ? decodeURIComponent(wrapped) : parsed.toString();
      } catch {
        /* keep the raw href */
      }
      results.push(`${results.length + 1}. ${title}\n   ${href}`);
    }
    return results.length
      ? clip(`Пошук: ${query}\n\n${results.join('\n\n')}`)
      : 'Пошук не повернув результатів. Можливо, DuckDuckGo обмежив запит.';
  },
};

interface ScreenShot {
  rel: string;
  /** Pixel fingerprint: equal hashes mean nothing on screen moved. */
  hash: string;
  width: number;
  height: number;
  cursor: { x: number; y: number } | null;
}

/**
 * Window and input primitives, compiled once per PowerShell process.
 *
 * A background process may not raise another program's window: Windows refuses
 * `SetForegroundWindow` unless the caller shares an input queue with the
 * current foreground window. Without the AttachThreadInput dance below, an app
 * launched from Vela stays visible but unfocused, and every following keystroke
 * is delivered to Vela's own composer instead of the program just opened. That
 * is what made typing look like it silently did nothing.
 */
const WIN_API = [
  'Add-Type @"',
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class VelaWin {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
  '  public static string Title(IntPtr h) {',
  '    StringBuilder sb = new StringBuilder(512);',
  '    GetWindowText(h, sb, 512);',
  '    return sb.ToString();',
  '  }',
  '  public static IntPtr Find(string needles) {',
  '    string[] parts = needles.ToLowerInvariant().Split(\'|\');',
  '    IntPtr found = IntPtr.Zero;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (!IsWindowVisible(h)) return true;',
  '      string t = Title(h);',
  '      if (t.Length == 0) return true;',
  '      string lower = t.ToLowerInvariant();',
  '      foreach (string n in parts) {',
  '        if (n.Length > 0 && lower.Contains(n)) { found = h; return false; }',
  '      }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    if (found != IntPtr.Zero) return found;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (!IsWindowVisible(h)) return true;',
  '      if (Title(h).Length == 0) return true;',
  '      uint pid;',
  '      GetWindowThreadProcessId(h, out pid);',
  '      try {',
  '        string name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();',
  '        foreach (string n in parts) {',
  '          if (n.Length > 0 && name.Contains(n)) { found = h; return false; }',
  '        }',
  '      } catch { }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }',
  '  public static bool Activate(IntPtr h) {',
  '    if (h == IntPtr.Zero) return false;',
  '    uint pid;',
  '    uint tid = GetWindowThreadProcessId(h, out pid);',
  '    uint self = GetCurrentThreadId();',
  '    AttachThreadInput(self, tid, true);',
  '    if (IsIconic(h)) ShowWindow(h, 9);',
  '    bool ok = SetForegroundWindow(h);',
  '    BringWindowToTop(h);',
  '    AttachThreadInput(self, tid, false);',
  '    return ok;',
  '  }',
  '}',
  '"@',
].join('\n');

/** The launcher's own windows: keystrokes sent there vanish into the chat box. */
const SELF_WINDOW = /^(vela|ironcode|electron)\b/i;

let lastScreen: { width: number; height: number } | null = null;
/** Window the agent last opened or focused: the default target for keystrokes. */
let lastTarget: string | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** PowerShell may print a warning before the payload, so scan from the end. */
function lastJson<T>(output: string): T | null {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      /* a stray brace is not the payload: keep scanning */
    }
  }
  return null;
}

async function captureScreen(ctx: ToolContext): Promise<ScreenShot> {
  const dir = ctx.workspace.safe('.vela/screenshots');
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `screen-${Date.now()}.png`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)',
    `$bmp.Save(${psQuote(file)},[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
    '$c=[System.Windows.Forms.Cursor]::Position',
    '"$($b.Width)x$($b.Height) @ $($c.X),$($c.Y)"',
  ].join('; ');
  const out = await runPowerShell(script, ctx.signal);
  const stat = await fs.stat(file);
  if (!stat.size) throw new Error('скріншот порожній');
  const shape = /(\d+)x(\d+)\s*@\s*(-?\d+),(-?\d+)/.exec(out);
  const width = Number(shape?.[1] ?? 0);
  const height = Number(shape?.[2] ?? 0);
  if (width > 0 && height > 0) lastScreen = { width, height };
  const hash = createHash('sha1').update(await fs.readFile(file)).digest('hex').slice(0, 12);
  const rel = ctx.workspace.display(file);
  console.log(`[ComputerUse] Screenshot Captured: ${rel} (${width}x${height})`);
  return {
    rel,
    hash,
    width,
    height,
    cursor: shape ? { x: Number(shape[3]), y: Number(shape[4]) } : null,
  };
}

/** A "before" picture must never stop the action it is meant to verify. */
async function safeShot(ctx: ToolContext): Promise<ScreenShot | null> {
  try {
    return await captureScreen(ctx);
  } catch (err) {
    console.log(`[ComputerUse] Verification Failed: ${(err as Error).message}`);
    return null;
  }
}

/** Screen geometry, cached: click bounds have to match the screenshot exactly. */
async function screenBounds(ctx: ToolContext): Promise<{ width: number; height: number }> {
  if (lastScreen) return lastScreen;
  const out = await runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "$($b.Width)x$($b.Height)"',
    ctx.signal,
  );
  const shape = /(\d+)x(\d+)/.exec(out);
  const bounds = { width: Number(shape?.[1] ?? 0), height: Number(shape?.[2] ?? 0) };
  if (bounds.width && bounds.height) lastScreen = bounds;
  return bounds;
}

/** Bring a top-level window to the front by title or process-name fragment. */
async function activateWindow(
  ctx: ToolContext,
  needles: string[],
): Promise<{ found: boolean; focused: boolean; title: string; foreground: string }> {
  const wanted = needles.map(needle => needle.toLowerCase().trim()).filter(Boolean).join('|');
  if (!wanted) return { found: false, focused: false, title: '', foreground: '' };
  const script = [
    WIN_API,
    `$h=[VelaWin]::Find(${psQuote(wanted)})`,
    'if ($h -eq [IntPtr]::Zero) { ConvertTo-Json -Compress -InputObject @{ found=$false; focused=$false; title=""; foreground="" }; exit }',
    '$ok=[VelaWin]::Activate($h)',
    'ConvertTo-Json -Compress -InputObject @{ found=$true; focused=[VelaWin]::IsForeground($h); title=[VelaWin]::Title($h); foreground=[VelaWin]::Title([VelaWin]::GetForegroundWindow()) }',
  ].join('\n');
  const parsed = lastJson<{ found?: boolean; focused?: boolean; title?: string; foreground?: string }>(
    await runPowerShell(script, ctx.signal),
  );
  if (!parsed?.found) return { found: false, focused: false, title: '', foreground: '' };
  const title = parsed.title ?? '';
  const foreground = parsed.foreground ?? '';
  console.log(parsed.focused
    ? `[ComputerUse] Window Focused: ${title || wanted}`
    : `[ComputerUse] Verification Failed: вікно «${title || wanted}» не стало активним, у фокусі «${foreground}»`);
  return { found: true, focused: Boolean(parsed.focused), title, foreground };
}

async function foregroundWindow(ctx: ToolContext): Promise<string> {
  const script = `${WIN_API}\n[VelaWin]::Title([VelaWin]::GetForegroundWindow())`;
  return (await runPowerShell(script, ctx.signal)).trim();
}

/**
 * Pick the window that will receive keystrokes.
 *
 * Targets the explicit `target`, then the last window the agent opened, and
 * finally whatever already has focus — but only when that is not Vela itself.
 * Typing is refused rather than silently delivered to the chat composer.
 */
async function ensureInputTarget(
  ctx: ToolContext,
  target?: unknown,
): Promise<{ ok: boolean; window: string; reason?: string }> {
  const wanted = String(target ?? '').trim() || lastTarget;
  if (wanted) {
    const win = await activateWindow(ctx, [wanted]);
    if (win.found && win.focused) {
      lastTarget = wanted;
      return { ok: true, window: win.foreground || win.title };
    }
    if (win.found) {
      return {
        ok: false,
        window: win.foreground,
        reason: `вікно «${win.title}» знайдено, але фокус лишився на «${win.foreground || 'іншому вікні'}»`,
      };
    }
    return { ok: false, window: '', reason: `вікно «${wanted}» не знайдено` };
  }
  const active = await foregroundWindow(ctx);
  if (SELF_WINDOW.test(active)) return { ok: false, window: active, reason: 'у фокусі сама Vela' };
  return { ok: true, window: active || 'активне вікно' };
}

/**
 * Screenshot after an action, plus a real verdict.
 *
 * The previous version logged "Verification Passed" merely for succeeding in
 * taking a picture, so a keystroke that went nowhere still looked verified.
 * Comparing fingerprints is what makes the verdict mean something.
 */
async function afterComputerAction(
  ctx: ToolContext,
  message: string,
  before: ScreenShot | null = null,
  delayMs = 300,
): Promise<string> {
  if (delayMs > 0) await sleep(delayMs);
  let shot: ScreenShot;
  try {
    shot = await captureScreen(ctx);
  } catch (err) {
    console.log(`[ComputerUse] Verification Failed: ${(err as Error).message}`);
    return message;
  }
  let body = message;
  if (before) {
    const changed = shot.hash !== before.hash;
    console.log(changed
      ? '[ComputerUse] Verification Passed'
      : '[ComputerUse] Verification Failed: екран не змінився');
    body += changed
      ? '\nПеревірка: екран змінився.'
      : '\nПеревірка: екран НЕ змінився, дія могла не спрацювати. Подивись на скріншот і спробуй інакше.';
  } else {
    console.log('[ComputerUse] Verification Passed');
  }
  const size = shot.width && shot.height ? `\nЕкран ${shot.width}×${shot.height}.` : '';
  return `${body}${size}\n\n![Скріншот екрана](${shot.rel})`;
}

/** Pointer primitives, injected into the scripts that move or click. */
const MOUSE_API = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class IronMouse {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);',
  '}',
  '"@',
].join('\n');

/** Names a person actually says, mapped to something Windows can start. */
const APP_ALIASES: Record<string, { run: string; match?: string }> = {
  'калькулятор': { run: 'calc', match: 'калькулятор' },
  calculator: { run: 'calc', match: 'калькулятор' },
  calc: { run: 'calc' },
  'блокнот': { run: 'notepad', match: 'блокнот' },
  notepad: { run: 'notepad', match: 'блокнот' },
  'проводник': { run: 'explorer', match: 'проводник' },
  explorer: { run: 'explorer' },
  files: { run: 'explorer' },
  'налаштування': { run: 'ms-settings:', match: 'параметри' },
  settings: { run: 'ms-settings:', match: 'параметри' },
  'малювання': { run: 'mspaint', match: 'paint' },
  paint: { run: 'mspaint', match: 'paint' },
  'браузер': { run: 'https://www.google.com', match: 'chrome|msedge|firefox|opera|brave' },
  browser: { run: 'https://www.google.com', match: 'chrome|msedge|firefox|opera|brave' },
  'термінал': { run: 'wt' },
  terminal: { run: 'wt' },
  'vs code': { run: 'code', match: 'visual studio code' },
  vscode: { run: 'code', match: 'visual studio code' },
};

/**
 * Start a program and report what happened.
 *
 * `spawn` covers plain executables; when the name is a shell target (`calc`,
 * a URI such as `ms-settings:`, an App Paths entry) only ShellExecute can
 * resolve it, which is what the Start-Process fallback uses.
 */
async function launchApp(target: string, ctx: ToolContext): Promise<string> {
  return new Promise<string>(resolve => {
    const child = spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('spawn', () => {
      child.unref();
      resolve(`Запущено: ${target}`);
    });
    child.once('error', () => {
      const script = [
        `try { Start-Process -FilePath ${psQuote(target)} -ErrorAction Stop; 'VELA_LAUNCH_OK' }`,
        `catch { 'VELA_LAUNCH_FAIL ' + $_.Exception.Message }`,
      ].join('\n');
      runPowerShell(script, ctx.signal)
        .then(out => {
          const line = out.split(/\r?\n/).find(entry => entry.startsWith('VELA_LAUNCH_')) ?? '';
          if (line.startsWith('VELA_LAUNCH_OK')) {
            resolve(`Запущено: ${target}`);
            return;
          }
          const reason = line.replace('VELA_LAUNCH_FAIL', '').trim() || 'невідома причина';
          resolve(`ПОМИЛКА запуску ${target}: ${reason}`);
        })
        .catch(err => resolve(`ПОМИЛКА запуску ${target}: ${(err as Error).message}`));
    });
  });
}

/** Poll until the window a just-launched program creates is in front. */
async function waitForWindow(
  ctx: ToolContext,
  needles: Array<string | undefined>,
  timeoutMs: number,
): Promise<{ found: boolean; focused: boolean; title: string; foreground: string }> {
  const wanted = needles.filter((needle): needle is string => Boolean(needle && needle.trim()));
  const miss = { found: false, focused: false, title: '', foreground: '' };
  if (!wanted.length) return miss;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const win = await activateWindow(ctx, wanted);
    if (win.found) return win;
    if (Date.now() >= deadline) return miss;
    await sleep(250);
  }
}

/**
 * Validate a click target against the real screen.
 *
 * The model used to receive no size at all and produced points like 370,980 on
 * an 864 px screen, which silently landed on nothing. A rejected call with the
 * bounds teaches it far faster than a screenshot of an unchanged window.
 */
function clickPoint(
  args: { x?: unknown; y?: unknown },
  bounds: { width: number; height: number },
): { x: number; y: number } | string {
  const x = Math.round(Number(args.x));
  const y = Math.round(Number(args.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return 'ПОМИЛКА: потрібні координати x і y з останнього скріншота.';
  }
  if (bounds.width && bounds.height && (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height)) {
    return `ПОМИЛКА: точка ${x},${y} поза екраном. Екран ${bounds.width}×${bounds.height}, тобто x 0..${bounds.width - 1}, y 0..${bounds.height - 1}. Зроби screenshot і візьми координати з нього.`;
  }
  return { x, y };
}

const computer: Tool = {
  permission: 'computer',
  risk: 'high',
  autonomous: true,
  schema: def(
    'computer',
    'Керування комп\'ютером: відкрити програму, показати вікна, перемкнути фокус, зробити знімок екрана, перемістити курсор, клікнути, ввести текст, натиснути клавіші або прокрутити. Для задач із вікнами Windows використовуй цей інструмент замість текстової відповіді.',
    {
      action: {
        type: 'string',
        enum: ['open_app', 'windows', 'focus', 'screenshot', 'move', 'click', 'double_click', 'type', 'key', 'scroll'],
        description: 'Що зробити',
      },
      target: {
        type: 'string',
        description: 'Для open_app: програма (calc, notepad, ms-settings:). Для focus/type/key: частина заголовка або назви процесу',
      },
      text: { type: 'string', description: 'Для type: текст' },
      keys: { type: 'string', description: 'Для key: {ENTER}, ^s, %{TAB}' },
      x: { type: 'number', description: 'Для move/click/double_click: координата X з останнього скріншота' },
      y: { type: 'number', description: 'Для move/click/double_click: координата Y з останнього скріншота' },
      amount: { type: 'number', description: 'Для scroll: додатне вниз, від\'ємне вгору' },
    },
    ['action'],
  ),
  approvalDetail(args) {
    const action = String(args.action ?? '');
    if (action === 'open_app') return `Відкрити програму: ${String(args.target ?? '').slice(0, 200)}`;
    if (action === 'screenshot') return 'Зробити знімок екрана';
    if (action === 'windows') return 'Показати відкриті вікна';
    if (action === 'focus') return `Перемкнути фокус на: ${String(args.target ?? '').slice(0, 120)}`;
    if (action === 'move') return `Перемістити курсор: ${args.x ?? '?'}, ${args.y ?? '?'}`;
    if (action === 'type') return `Ввести текст: ${String(args.text ?? '').slice(0, 160)}`;
    if (action === 'key') return `Натиснути клавіші: ${String(args.keys ?? '').slice(0, 80)}`;
    if (action === 'click' || action === 'double_click') {
      return `${action === 'click' ? 'Клікнути' : 'Двічі клікнути'} на екрані: ${args.x ?? '?'}, ${args.y ?? '?'}`;
    }
    if (action === 'scroll') return `Прокрутити: ${args.amount ?? 0}`;
    return 'Керування комп\'ютером';
  },
  async run(args, ctx) {
    const action = String(args.action ?? '');
    console.log(`[ComputerUse] Tool Selected: ${action || '(empty)'}`);

    if (action === 'open_app') {
      const raw = String(args.target ?? '').trim();
      if (!raw) return 'ПОМИЛКА: не вказано програму.';
      const alias = APP_ALIASES[raw.toLowerCase()];
      const target = alias?.run ?? raw;
      const before = await safeShot(ctx);
      const launched = await launchApp(target, ctx);
      if (launched.startsWith('ПОМИЛКА')) return launched;
      // A window can appear without taking focus; until it does, every
      // keystroke would be delivered to Vela's own composer instead.
      const win = await waitForWindow(ctx, [alias?.match, target, raw], 2500);
      if (!win.found) {
        console.log(`[ComputerUse] Verification Failed: вікно ${raw} не з'явилося`);
        return `${launched}\nПОПЕРЕДЖЕННЯ: вікно не з'явилося за 2.5 с. Зроби screenshot і перевір, що сталося.`;
      }
      lastTarget = win.title || raw;
      console.log(`[ComputerUse] Element Found: window "${win.title}"`);
      const focusNote = win.focused
        ? `Вікно «${win.title}» у фокусі.`
        : `Вікно «${win.title}» відкрите, але фокус на «${win.foreground}». Перед введенням тексту виклич focus.`;
      return afterComputerAction(ctx, `${launched}\n${focusNote}`, before, 400);
    }

    if (action === 'windows') {
      const script = 'Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object ProcessName | Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200';
      const output = clip(await runPowerShell(script, ctx.signal));
      console.log('[ComputerUse] Element Found: window list');
      return afterComputerAction(
        ctx,
        `Відкриті вікна:\n${output.trim()}\n\nДалі: focus із частиною заголовка, щоб перемкнутися на потрібне вікно.`,
        null,
        100,
      );
    }

    if (action === 'focus') {
      const target = String(args.target ?? '').trim();
      if (!target) return 'ПОМИЛКА: вкажи target — частину заголовка вікна або назву процесу.';
      const win = await activateWindow(ctx, [target]);
      if (!win.found) {
        const active = await foregroundWindow(ctx);
        console.log(`[ComputerUse] Verification Failed: вікно «${target}» не знайдено`);
        return `ПОМИЛКА: вікно «${target}» не знайдено. У фокусі зараз: «${active || 'невідомо'}». Виклич windows, щоб побачити список.`;
      }
      lastTarget = win.title || target;
      console.log(`[ComputerUse] Element Found: focused "${win.title}"`);
      if (!win.focused) {
        return `ПОПЕРЕДЖЕННЯ: вікно «${win.title}» знайдено, але фокус лишився на «${win.foreground || 'іншому вікні'}». Клавіші туди не підуть.`;
      }
      return `Фокус на «${win.title}». Клавіші й текст підуть туди.`;
    }

    if (action === 'screenshot') {
      const shot = await captureScreen(ctx);
      const cursor = shot.cursor ? `Курсор: ${shot.cursor.x},${shot.cursor.y}.` : '';
      return [
        'Знімок екрана.',
        `Екран: ${shot.width}×${shot.height}. Координати для click — у межах 0..${Math.max(0, shot.width - 1)} та 0..${Math.max(0, shot.height - 1)}.`,
        cursor,
        '',
        `![Знімок екрана](${shot.rel})`,
      ].filter(Boolean).join('\n');
    }

    if (action === 'move') {
      const point = clickPoint(args, await screenBounds(ctx));
      if (typeof point === 'string') return point;
      const out = await runPowerShell([
        MOUSE_API,
        `$ok=[IronMouse]::SetCursorPos(${point.x},${point.y})`,
        'if ($ok) { "VELA_CURSOR_OK" } else { "VELA_CURSOR_FAIL" }',
      ].join('\n'), ctx.signal);
      if (out.includes('VELA_CURSOR_FAIL')) {
        console.log(`[ComputerUse] Mouse Action Failed: move ${point.x},${point.y}`);
        return `ПОМИЛКА: курсор не вдалося перемістити в ${point.x},${point.y}. Вікно на іншому робочому столі або введення заблоковане.`;
      }
      console.log(`[ComputerUse] Mouse Action Executed: move ${point.x},${point.y}`);
      // Moving the pointer changes no pixels, so the proof is where it landed.
      const shot = await safeShot(ctx);
      const landed = shot?.cursor
        && Math.abs(shot.cursor.x - point.x) <= 2
        && Math.abs(shot.cursor.y - point.y) <= 2;
      console.log(landed
        ? '[ComputerUse] Verification Passed'
        : '[ComputerUse] Verification Failed: курсор не в заданій точці');
      const where = shot?.cursor ? ` Курсор зараз: ${shot.cursor.x},${shot.cursor.y}.` : '';
      const tail = shot
        ? `\n${landed ? 'Перевірка: курсор у заданій точці.' : 'Перевірка: курсор не там, куди його вели.'}${where}\nЕкран ${shot.width}×${shot.height}.\n\n![Скріншот екрана](${shot.rel})`
        : where;
      return `Курсор переміщено: ${point.x}, ${point.y}.${tail}`;
    }

    if (action === 'click' || action === 'double_click') {
      const point = clickPoint(args, await screenBounds(ctx));
      if (typeof point === 'string') return point;
      const before = await safeShot(ctx);
      // DOWN/UP with a beat between them: some toolkits drop a zero-length press.
      const press = '[IronMouse]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60; [IronMouse]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 90';
      const script = [
        MOUSE_API,
        `$ok=[IronMouse]::SetCursorPos(${point.x},${point.y})`,
        'if (-not $ok) { "VELA_CURSOR_FAIL"; exit }',
        'Start-Sleep -Milliseconds 80',
        action === 'click' ? press : `${press}; ${press}`,
        '"VELA_CURSOR_OK"',
      ].join('\n');
      const out = await runPowerShell(script, ctx.signal);
      if (out.includes('VELA_CURSOR_FAIL')) {
        console.log(`[ComputerUse] Mouse Action Failed: ${action} ${point.x},${point.y}`);
        return `ПОМИЛКА: курсор не вдалося перемістити в ${point.x},${point.y}, клік не виконано.`;
      }
      console.log(`[ComputerUse] Mouse Action Executed: ${action} ${point.x},${point.y}`);
      return afterComputerAction(
        ctx,
        `${action === 'click' ? 'Клік' : 'Подвійний клік'}: ${point.x}, ${point.y}.`,
        before,
        300,
      );
    }

    if (action === 'type') {
      const text = String(args.text ?? '');
      if (!text) return 'ПОМИЛКА: порожній текст.';
      const target = await ensureInputTarget(ctx, args.target);
      if (!target.ok) {
        console.log(`[ComputerUse] Verification Failed: ${target.reason}`);
        return `ПОМИЛКА: ${target.reason}, тож текст не введено. Відкрий програму або виклич focus із частиною заголовка вікна.`;
      }
      const active = target.window;
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(encoded)}))`,
        'Set-Clipboard -Value $t',
        'Start-Sleep -Milliseconds 150',
        "[System.Windows.Forms.SendKeys]::SendWait('^v')",
      ].join('; ');
      const before = await safeShot(ctx);
      await runPowerShell(script, ctx.signal);
      console.log(`[ComputerUse] Keyboard Action Executed: type ${text.length} chars into "${active}"`);
      return afterComputerAction(ctx, `Введено ${text.length} символів у «${active}».`, before, 280);
    }

    if (action === 'key') {
      const keys = String(args.keys ?? '');
      if (!keys) return 'ПОМИЛКА: не вказано клавіші.';
      const target = await ensureInputTarget(ctx, args.target);
      if (!target.ok) {
        console.log(`[ComputerUse] Verification Failed: ${target.reason}`);
        return `ПОМИЛКА: ${target.reason}, тож клавіші не натиснуто. Перемкни фокус на потрібне вікно через focus.`;
      }
      const active = target.window;
      const before = await safeShot(ctx);
      const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})`;
      await runPowerShell(script, ctx.signal);
      console.log(`[ComputerUse] Keyboard Action Executed: ${keys} into "${active}"`);
      return afterComputerAction(ctx, `Натиснуто: ${keys} («${active}»).`, before, 300);
    }

    if (action === 'scroll') {
      const amount = Math.max(-2400, Math.min(2400, Math.round(Number(args.amount) || 0)));
      if (!amount) return 'ПОМИЛКА: вкажи amount, додатне вниз або від\'ємне вгору.';
      const before = await safeShot(ctx);
      const script = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class IronWheel {',
        '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, int e);',
        '}',
        '"@',
        `[IronWheel]::mouse_event(0x0800,0,0,${amount},0)`,
      ].join('\n');
      await runPowerShell(script, ctx.signal);
      console.log(`[ComputerUse] Mouse Action Executed: scroll ${amount}`);
      return afterComputerAction(ctx, `Прокручено: ${amount}.`, before, 250);
    }

    return `ПОМИЛКА: невідома дія «${action}». Доступні: open_app, windows, focus, screenshot, move, click, double_click, type, key, scroll.`;
  },
};

const showImage: Tool = {
  permission: 'files',
  schema: def(
    'show_image',
    'Показати зображення з робочої папки прямо в чаті. Використовуй, коли треба показати картинку, скріншот або макет.',
    { path: { type: 'string', description: 'Шлях до PNG, JPG, WebP або GIF у робочій папці' } },
    ['path'],
  ),
  async run(args, ctx) {
    const path = String(args.path ?? '').trim();
    if (!path) return 'ПОМИЛКА: не вказано шлях.';
    if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) return 'ПОМИЛКА: це не PNG, JPG, WebP або GIF.';
    try {
      const rel = ctx.workspace.display(ctx.workspace.safe(path));
      return `Зображення:\n\n![${path.split(/[\\/]/).pop() ?? 'зображення'}](${rel})`;
    } catch (err) {
      return `ПОМИЛКА: ${(err as Error).message}`;
    }
  },
};

const useSkill: Tool = {
  schema: def(
    'use_skill',
    'Завантажити інструкції плагіна за назвою. Виклич це ПЕРЕД роботою, якщо у списку доступних плагінів є підхожий.',
    { name: { type: 'string', description: 'Назва плагіна зі списку доступних' } },
    ['name'],
  ),
  async run(args, ctx) {
    const skill = await ctx.loadSkill(String(args.name ?? ''));
    if (!skill) {
      const available = await ctx.skillNames();
      return `ПОМИЛКА: плагіна «${args.name}» немає. Доступні: ${available.join(', ') || '(жодного)'}`;
    }
    return clip(`Плагін «${skill.name}» — ${skill.description}\n\n${skill.body}`);
  },
};

export const TOOLS: Tool[] = [
  readFile,
  writeFile,
  editFile,
  listDir,
  searchFiles,
  makeDir,
  deletePath,
  runShell,
  openUrl,
  webFetch,
  webSearch,
  computer,
  showImage,
  useSkill,
];

export const TOOL_SCHEMAS: ToolSchema[] = TOOLS.map(t => t.schema);

export function findTool(name: string): Tool | undefined {
  return TOOLS.find(t => t.schema.function.name === name);
}
