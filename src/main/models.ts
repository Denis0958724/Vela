import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx.js';
import type { GatewayClient } from './gateway.js';
import { supportsTools, type ModelInfo } from './types.js';

/**
 * The gateway's catalogue is not a list of models that work.
 *
 * Probing it found half the advertised entries unusable: `claude-opus-4-5`,
 * `claude-sonnet-4-5` and `claude-haiku-4-5` are listed but answer "not in the
 * catalog", and several others are gone upstream or permanently rate-limited.
 * Offering those in the picker means handing the user a choice that silently
 * fails, so this module records what actually responded and the UI shows only
 * that.
 */

export type Verdict = 'ok' | 'dead' | 'unknown';

export interface ProbeResult {
  id: string;
  verdict: Verdict;
  ms: number;
  detail: string;
  checkedAt: number;
}

export interface ModelRow {
  id: string;
  name: string;
  context: number | null;
  tools: boolean;
  /** Direct provider id, absent for FreeLLMAPI entries. */
  provider?: string;
  /** Advertised router slot without real parameter metadata. */
  slot: boolean;
  /** Supports a reasoning-effort setting. */
  reasoning: boolean;
  verdict: Verdict;
  ms: number | null;
  detail: string;
}

/** Beyond this the cached verdict is treated as stale rather than wrong. */
const FRESH_FOR = 1000 * 60 * 60 * 12;
const PROBE_TIMEOUT = 20_000;
const CONCURRENCY = 6;

export class ModelCatalog {
  private results = new Map<string, ProbeResult>();
  private lastList: ModelRow[] = [];
  private loaded = false;

  private file(): string {
    return join(app.getPath('userData'), 'models.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8')) as ProbeResult[];
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          // Older builds marked rate limits, credit failures and timeouts as
          // "dead". Those models are real; only a hard 404/missing answer is
          // permanent.
          if (r.verdict === 'dead' && !isHardDead(r.detail)) r.verdict = 'unknown';
          this.results.set(r.id, r);
        }
      }
    } catch {
      /* no cache yet */
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) return;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await writeFileAtomic(this.file(), JSON.stringify([...this.results.values()], null, 2));
  }

  lastCheckedAt(): number | null {
    let newest = 0;
    for (const r of this.results.values()) newest = Math.max(newest, r.checkedAt);
    return newest || null;
  }

  /** Catalogue entries annotated with what the last probe found. */
  async list(gateway: GatewayClient): Promise<ModelRow[]> {
    const models = await gateway.listModels(true);
    const rows = models.map(m => {
      const probed = this.results.get(m.id);
      const fresh = probed && Date.now() - probed.checkedAt < FRESH_FOR;
      const router = m.id === 'auto' || m.id === 'fusion';
      return {
        id: m.id,
        name: m.name ?? m.id,
        context: m.context_window ?? m.context_length ?? null,
        tools: supportsTools(m),
        provider: m.provider,
        // The gateway advertises decorative Claude slots without any parameter
        // metadata. They answer "not in the catalog" when called, so keep them
        // out of the picker. auto and fusion are real routers and stay.
        slot: !m.provider && !router && m.supported_parameters == null,
        reasoning: Boolean(m.reasoning),
        verdict: fresh ? probed.verdict : (probed?.verdict === 'dead' ? 'dead' : 'unknown'),
        ms: probed?.ms ?? null,
        detail: probed?.detail ?? '',
      } satisfies ModelRow;
    });
    this.lastList = rows;
    return rows;
  }

  /** Last fetched catalogue, so a send does not need a network round trip. */
  cached(): ModelRow[] {
    return this.lastList;
  }

  /**
   * Call every model once and record whether it answered.
   *
   * `onProgress` lets the UI count up rather than freeze for a minute.
   */
  async probeAll(
    gateway: GatewayClient,
    onProgress?: (done: number, total: number, id: string) => void,
  ): Promise<{ ok: number; dead: number; total: number }> {
    const models = await gateway.listModels(true);
    const queue = [...models];
    const total = models.length;
    let done = 0;

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const model = queue.shift();
        if (!model) return;
        const result = await this.probeOne(gateway, model);
        this.results.set(result.id, result);
        done++;
        onProgress?.(done, total, result.id);
      }
    });

    await Promise.all(workers);
    await this.persist();

    const values = [...this.results.values()];
    return {
      ok: values.filter(r => r.verdict === 'ok').length,
      dead: values.filter(r => r.verdict === 'dead').length,
      total,
    };
  }

  /** Probe one model on demand, for the picker's "does this exist" check. */
  async probeById(gateway: GatewayClient, id: string, withTools: boolean): Promise<ProbeResult> {
    const result = await this.probeOne(gateway, { id, supported_parameters: withTools ? ['tools'] : [] } as ModelInfo);
    this.results.set(result.id, result);
    await this.persist();
    return result;
  }

  private async probeOne(gateway: GatewayClient, model: ModelInfo): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const reply = await gateway.probeModel(model.id, supportsTools(model), PROBE_TIMEOUT);
      return {
        id: model.id,
        verdict: 'ok',
        ms: Date.now() - started,
        detail: reply.slice(0, 80),
        checkedAt: Date.now(),
      };
    } catch (err) {
      const detail = (err as Error).message.slice(0, 160).replace(/\s+/g, ' ');
      return {
        id: model.id,
        // "Out of credits", 429 and timeout do not prove the model is gone.
        // Keep it visible and let the user retry when the provider recovers.
        verdict: isHardDead(detail) ? 'dead' : 'unknown',
        ms: Date.now() - started,
        detail,
        checkedAt: Date.now(),
      };
    }
  }
}

function isHardDead(detail: string): boolean {
  return /\b404\b|not found|does not exist|no longer available|unknown model|model not supported|not supported/i.test(detail);
}
