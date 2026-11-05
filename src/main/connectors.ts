import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx.js';
import { McpClient, type McpConfig, type McpTool } from './mcp.js';
import type { ToolSchema } from './types.js';

/**
 * Connectors: MCP servers the agent may reach through.
 *
 * Credentials live here and are handed to the transport at call time — they are
 * never put in the prompt, so the model sees a connector's name and description
 * and nothing else.
 */

export const TOOL_PREFIX = 'mcp__';

export interface Connector {
  id: string;
  /** Slug used in tool names; must survive the function-name charset. */
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /** 'all' projects, or only the ids listed in `projects`. */
  scope: 'all' | 'selected';
  projects: string[];
}

export type ConnectorSummary = Omit<Connector, 'env' | 'headers'> & {
  /** Key names only — values never leave the main process. */
  secretKeys: string[];
  status: 'idle' | 'ready' | 'error';
  statusDetail: string;
  toolCount: number;
};

function slug(input: string): string {
  return (input || 'mcp')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'mcp';
}

/** Function names must match ^[A-Za-z0-9_-]{1,64}$ for the chat-completions API. */
function toolName(connector: string, tool: string): string {
  return `${TOOL_PREFIX}${connector}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

interface Live {
  client: McpClient;
  tools: McpTool[];
  status: 'ready' | 'error';
  detail: string;
}

export class ConnectorRegistry {
  private connectors: Connector[] = [];
  private live = new Map<string, Live>();
  private loaded = false;

  private file(): string {
    return join(app.getPath('userData'), 'connectors.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8')) as { connectors?: Connector[] };
      this.connectors = Array.isArray(parsed.connectors) ? parsed.connectors : [];
    } catch {
      this.connectors = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) throw new Error('ConnectorRegistry.persist() до load()');
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await writeFileAtomic(this.file(), JSON.stringify({ connectors: this.connectors }, null, 2));
  }

  list(): ConnectorSummary[] {
    return this.connectors.map(c => {
      const live = this.live.get(c.id);
      const { env, headers, ...rest } = c;
      return {
        ...rest,
        secretKeys: [...Object.keys(env ?? {}), ...Object.keys(headers ?? {})],
        status: live?.status ?? 'idle',
        statusDetail: live?.detail ?? '',
        toolCount: live?.tools.length ?? 0,
      };
    });
  }

  async save(input: Partial<Connector> & { name: string }): Promise<Connector> {
    const existing = input.id ? this.connectors.find(c => c.id === input.id) : undefined;
    const connector: Connector = {
      id: existing?.id ?? `conn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: slug(input.name),
      description: input.description ?? existing?.description ?? '',
      transport: input.transport ?? existing?.transport ?? 'stdio',
      command: input.command ?? existing?.command,
      args: input.args ?? existing?.args ?? [],
      // An omitted secret map means "unchanged", so editing a connector in the
      // UI without retyping the token does not wipe it.
      env: input.env ?? existing?.env ?? {},
      url: input.url ?? existing?.url,
      headers: input.headers ?? existing?.headers ?? {},
      enabled: input.enabled ?? existing?.enabled ?? true,
      scope: input.scope ?? existing?.scope ?? 'all',
      projects: input.projects ?? existing?.projects ?? [],
    };

    if (existing) this.connectors[this.connectors.indexOf(existing)] = connector;
    else this.connectors.push(connector);

    // Configuration changed: drop the live session so the next use reconnects.
    this.disconnect(connector.id);
    await this.persist();
    return connector;
  }

  async remove(id: string): Promise<void> {
    this.disconnect(id);
    this.connectors = this.connectors.filter(c => c.id !== id);
    await this.persist();
  }

  private mcpConfig(c: Connector): McpConfig {
    return c.transport === 'http'
      ? { transport: 'http', url: c.url ?? '', headers: c.headers ?? {} }
      : { transport: 'stdio', command: c.command ?? '', args: c.args ?? [], env: c.env ?? {} };
  }

  /** Connect without storing anything — used by the dialog's "Перевірити". */
  async test(id: string): Promise<{ ok: boolean; detail: string; tools: string[] }> {
    const connector = this.connectors.find(c => c.id === id);
    if (!connector) return { ok: false, detail: 'Конектор не знайдено', tools: [] };

    const client = new McpClient(this.mcpConfig(connector));
    try {
      const { serverName, tools } = await client.connect();
      return {
        ok: true,
        detail: `${serverName}: ${tools.length} інструментів`,
        tools: tools.map(t => t.name),
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, tools: [] };
    } finally {
      client.close();
    }
  }

  private activeFor(projectId: string | null): Connector[] {
    return this.connectors.filter(c => {
      if (!c.enabled) return false;
      if (c.scope === 'all') return true;
      return projectId !== null && c.projects.includes(projectId);
    });
  }

  /** Open (or reuse) a session and return its tools. */
  private async ensureLive(connector: Connector): Promise<Live> {
    const cached = this.live.get(connector.id);
    if (cached?.status === 'ready' && cached.client.isOpen) return cached;

    const client = new McpClient(this.mcpConfig(connector));
    try {
      const { tools } = await client.connect();
      const live: Live = { client, tools, status: 'ready', detail: `${tools.length} інструментів` };
      this.live.set(connector.id, live);
      return live;
    } catch (err) {
      client.close();
      const live: Live = { client, tools: [], status: 'error', detail: (err as Error).message };
      this.live.set(connector.id, live);
      return live;
    }
  }

  /**
   * Tool schemas the agent may offer this turn. A connector that fails to start
   * is skipped rather than failing the turn — the rest stay usable.
   */
  async toolsFor(projectId: string | null): Promise<ToolSchema[]> {
    const schemas: ToolSchema[] = [];
    for (const connector of this.activeFor(projectId)) {
      const live = await this.ensureLive(connector);
      if (live.status !== 'ready') continue;
      for (const tool of live.tools) {
        schemas.push({
          type: 'function',
          function: {
            name: toolName(connector.name, tool.name),
            description: `[${connector.name}] ${tool.description ?? tool.name}`,
            parameters: (tool.inputSchema as Record<string, unknown>) ?? {
              type: 'object',
              properties: {},
            },
          },
        });
      }
    }
    return schemas;
  }

  owns(name: string): boolean {
    return name.startsWith(TOOL_PREFIX);
  }

  /** Human-readable target of a call, for the approval prompt. */
  describe(name: string): string {
    const match = this.resolve(name);
    if (!match) return name;
    return `${match.connector.name} → ${match.tool}`;
  }

  private resolve(name: string): { connector: Connector; tool: string } | null {
    for (const connector of this.connectors) {
      for (const live of [this.live.get(connector.id)]) {
        for (const tool of live?.tools ?? []) {
          if (toolName(connector.name, tool.name) === name) return { connector, tool: tool.name };
        }
      }
    }
    return null;
  }

  async call(name: string, args: unknown): Promise<string> {
    const match = this.resolve(name);
    if (!match) return `ПОМИЛКА: конектор для «${name}» недоступний.`;
    const live = await this.ensureLive(match.connector);
    if (live.status !== 'ready') return `ПОМИЛКА: ${match.connector.name} не підключено — ${live.detail}`;
    try {
      return await live.client.callTool(match.tool, args);
    } catch (err) {
      // A dead session should not poison every later call.
      this.disconnect(match.connector.id);
      return `ПОМИЛКА: ${(err as Error).message}`;
    }
  }

  disconnect(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.client.close();
    this.live.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.disconnect(id);
  }
}
