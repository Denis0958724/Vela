import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * A minimal MCP (Model Context Protocol) client.
 *
 * Implementing the protocol once is what makes "connectors" cheap: every
 * existing MCP server — GitHub, Postgres, Notion, filesystem — then works
 * without a bespoke integration each time.
 *
 * Two transports are supported:
 *  - `stdio`: a child process exchanging newline-delimited JSON-RPC.
 *  - `http`:  JSON-RPC over POST, accepting either a JSON or an SSE response.
 */

export const PROTOCOL_VERSION = '2024-11-05';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface StdioConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpConfig = StdioConfig | HttpConfig;

export class McpError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT = 30_000;
/** Server output is fed back into the context window, so it has to stay bounded. */
const MAX_RESULT = 30_000;

/** Flatten MCP's content blocks into the plain text the agent loop consumes. */
export function renderContent(result: any): string {
  if (result == null) return '(порожня відповідь)';
  if (typeof result === 'string') return result;

  const blocks = Array.isArray(result.content) ? result.content : null;
  if (!blocks) return JSON.stringify(result).slice(0, MAX_RESULT);

  const parts: string[] = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'resource' && block.resource?.text) parts.push(String(block.resource.text));
    else if (block?.type === 'image') parts.push('[зображення — агент його не бачить]');
    else parts.push(JSON.stringify(block));
  }
  const text = parts.join('\n').trim() || '(порожня відповідь)';
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… [обрізано]` : text;
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private sessionId: string | null = null;
  private initialized = false;
  private stderrTail: string[] = [];

  constructor(private config: McpConfig) {}

  get isOpen(): boolean {
    return this.initialized;
  }

  /** Start the server (if stdio) and run the MCP handshake. */
  async connect(): Promise<{ serverName: string; tools: McpTool[] }> {
    if (this.config.transport === 'stdio') this.spawnChild(this.config);

    const init = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'vela', version: '0.1.0' },
    })) as any;

    // The spec requires this notification before any other request.
    await this.notify('notifications/initialized');
    this.initialized = true;

    const listed = (await this.request('tools/list', {})) as any;
    return {
      serverName: init?.serverInfo?.name ?? 'mcp',
      tools: Array.isArray(listed?.tools) ? listed.tools : [],
    };
  }

  async listTools(): Promise<McpTool[]> {
    const listed = (await this.request('tools/list', {})) as any;
    return Array.isArray(listed?.tools) ? listed.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = (await this.request('tools/call', {
      name,
      arguments: args ?? {},
    })) as any;
    const text = renderContent(result);
    return result?.isError ? `ПОМИЛКА: ${text}` : text;
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new McpError('З\'єднання закрито'));
    }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
    this.initialized = false;
    this.sessionId = null;
  }

  /* ── stdio ── */

  private spawnChild(config: StdioConfig): void {
    try {
      this.child = spawn(config.command, config.args ?? [], {
        // The server's own credentials arrive here, never through the prompt.
        env: { ...process.env, ...(config.env ?? {}) },
        cwd: config.cwd,
        windowsHide: true,
        shell: process.platform === 'win32',
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw new McpError(`Не вдалося запустити «${config.command}»: ${(err as Error).message}`);
    }

    this.child.on('error', err => this.failAll(new McpError(`Процес сервера: ${err.message}`)));
    this.child.on('exit', code => {
      const tail = this.stderrTail.join('\n').trim();
      this.failAll(new McpError(`Сервер завершився (код ${code})${tail ? `:\n${tail}` : ''}`));
      this.initialized = false;
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.onStdout(String(chunk)));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      // Kept only to explain a failed start; MCP servers log freely to stderr.
      this.stderrTail.push(String(chunk).trim());
      if (this.stderrTail.length > 12) this.stderrTail.shift();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed));
      } catch {
        // Servers sometimes print non-JSON banners to stdout; ignore them.
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(msg: any): void {
    if (typeof msg?.id !== 'number') return; // a notification or a server request
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    clearTimeout(waiting.timer);
    if (msg.error) waiting.reject(new McpError(msg.error.message ?? 'MCP error'));
    else waiting.resolve(msg.result);
  }

  /* ── requests ── */

  private async request(method: string, params: unknown): Promise<unknown> {
    return this.config.transport === 'stdio'
      ? this.requestStdio(method, params)
      : this.requestHttp(method, params);
  }

  private async notify(method: string): Promise<void> {
    const body = { jsonrpc: '2.0', method };
    if (this.config.transport === 'stdio') {
      this.child?.stdin.write(`${JSON.stringify(body)}\n`);
      return;
    }
    await fetch(this.config.url, {
      method: 'POST',
      headers: this.httpHeaders(),
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }

  private requestStdio(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new McpError('Сервер не запущено'));
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`Таймаут ${REQUEST_TIMEOUT}ms на ${method}`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${body}\n`, err => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`Запис у сервер: ${err.message}`));
      });
    });
  }

  private httpHeaders(): Record<string, string> {
    const config = this.config as HttpConfig;
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(config.headers ?? {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  private async requestHttp(method: string, params: unknown): Promise<unknown> {
    const config = this.config as HttpConfig;
    const id = this.nextId++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let res: Response;
    try {
      res = await fetch(config.url, {
        method: 'POST',
        headers: this.httpHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new McpError(`HTTP: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // The server assigns a session on initialize and expects it echoed back.
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (!res.ok) throw new McpError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = await res.text();
    const message = res.headers.get('content-type')?.includes('text/event-stream')
      ? parseSse(body)
      : safeParse(body);

    if (!message) throw new McpError('Порожня або нечитна відповідь сервера');
    if (message.error) throw new McpError(message.error.message ?? 'MCP error');
    return message.result;
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pull the last JSON-RPC payload out of an SSE body. */
function parseSse(body: string): any {
  let last: any = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const parsed = safeParse(line.slice(5).trim());
    if (parsed) last = parsed;
  }
  return last;
}
