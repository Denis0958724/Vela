import type { ChatMessage, ModelInfo, TokenUsage, ToolCall, ToolSchema } from './types.js';

/**
 * Models to fall back to when the requested one fails.
 *
 * Every entry was verified by calling it: probing the gateway's full catalogue
 * showed only half the advertised models answer at all, and an earlier version
 * of this list contained two that are gone upstream
 * (`nemotron-3-super-120b`, `gemini-2.5-flash`) — so the fallback silently
 * fell through to nothing. Only live, tool-calling models belong here, fastest
 * first. `auto` leads because the gateway's own router load-balances behind it.
 */
const FALLBACK_CHAIN = [
  'auto',
  'gpt-oss-120b',
  'qwen3.8-27b',
  'nemotron-3.5-lightning-30b-a3b',
  'gpt-oss-20b',
];

/**
 * Models that answered a real image correctly when probed, and also call tools.
 *
 * Most tool-capable models here have no vision at all — asking them about an
 * attachment returns "model lacks vision" — so a turn with images is routed
 * through this list instead of the ordinary chain.
 */
const VISION_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite',
  'gemini-3.1-flash-lite-preview',
];

/** Upstream hiccups worth retrying on another model rather than surfacing. */
function isTransient(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isNetworkFailure(message: string): boolean {
  return /fetch failed|failed to fetch|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|terminated|other side closed|UND_ERR_SOCKET|network|socket|internet|мереж/i.test(message);
}

export interface StreamHandlers {
  onModel(model: string, note?: string): void;
  onText(delta: string): void;
  onReasoning(delta: string): void;
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  servedModel: string;
  usage?: TokenUsage;
}

export class GatewayError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface GatewayOptions {
  includeUsage?: boolean;
  /** Models live outside the chat base on Google's native endpoint. */
  modelsUrl?: string;
  modelsAuth?: 'bearer' | 'x-goog-api-key';
}

export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ReasoningStyle = 'effort' | 'openrouter';

export class GatewayClient {
  private url: string;
  private apiKey: string;
  private includeUsage: boolean;
  private modelsUrl?: string;
  private modelsAuth: 'bearer' | 'x-goog-api-key';

  constructor(url: string, apiKey: string, options: boolean | GatewayOptions = false) {
    this.url = url;
    this.apiKey = apiKey;
    this.includeUsage = typeof options === 'boolean' ? options : Boolean(options.includeUsage);
    this.modelsUrl = typeof options === 'object' ? options.modelsUrl : undefined;
    this.modelsAuth = (typeof options === 'object' ? options.modelsAuth : undefined) ?? 'bearer';
  }

  update(url: string, apiKey: string): void {
    this.url = url;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private base(): string {
    return this.url.replace(/\/+$/, '');
  }

  /** Google's OpenAI-compatible root already includes its own API version. */
  private endpoint(path: string): string {
    const base = this.base();
    return /\/v1beta\/openai$/i.test(base) ? `${base}${path}` : `${base}/v1${path}`;
  }

  /** Probe the gateway so the UI can state a precise reason when it is unusable. */
  async health(): Promise<{ ok: boolean; detail: string; modelCount?: number }> {
    try {
      const models = await this.listModels();
      return { ok: true, detail: `${models.length} моделей доступно`, modelCount: models.length };
    } catch (err) {
      const e = err as GatewayError;
      if (e.status === 401) return { ok: false, detail: 'Шлюз відповідає, але ключ відхилено (401)' };
      if (e.status) return { ok: false, detail: `Шлюз відповів HTTP ${e.status}` };
      return { ok: false, detail: `Шлюз недосяжний: ${e.message}` };
    }
  }

  async listModels(availableOnly = true): Promise<ModelInfo[]> {
    const qs = availableOnly && !this.modelsUrl ? '?available=true' : '';
    const url = this.modelsUrl ?? `${this.endpoint('/models')}${qs}`;
    const headers: Record<string, string> = this.modelsAuth === 'x-goog-api-key'
      ? { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey }
      : this.headers();
    if (this.modelsAuth === 'x-goog-api-key') headers['x-goog-api-key'] = this.apiKey;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      throw new GatewayError((err as Error).message);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        /* keep raw text */
      }
      throw new GatewayError(detail || `GET /models failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { data?: ModelInfo[]; models?: any[] };
    if (Array.isArray(body.models)) {
      return body.models.map((m): ModelInfo => ({
        id: String(m.name ?? '').replace(/^models\//, ''),
        name: m.displayName ?? String(m.name ?? '').replace(/^models\//, ''),
        context_window: Number(m.inputTokenLimit) || undefined,
        supported_parameters: undefined,
      }));
    }
    return (body.data ?? []).map((m): ModelInfo => {
      const pricing = (m as ModelInfo & { pricing?: { prompt?: string; completion?: string } }).pricing;
      return {
        ...m,
        free: pricing
          ? Number(pricing.prompt) === 0 && Number(pricing.completion) === 0
          : undefined,
      };
    });
  }

  /**
   * One tiny non-streaming call, used to find out whether a model is real.
   *
   * Throws with the gateway's own wording on failure — "not in the catalog",
   * "removed upstream", "rate-limited" — which is what the UI shows.
   */
  async probeModel(model: string, withTools: boolean, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          ...(withTools
            ? {
                tools: [{
                  type: 'function',
                  function: {
                    name: 'ping',
                    description: 'ping',
                    parameters: { type: 'object', properties: {}, required: [] },
                  },
                }],
              }
            : {}),
        }),
      });

      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok || body.error) {
        throw new GatewayError(body.error?.message ?? `HTTP ${res.status}`, res.status);
      }
      return (body.choices?.[0]?.message?.content ?? '').trim() || '(порожня відповідь)';
    } catch (err) {
      if (controller.signal.aborted) throw new GatewayError(`таймаут ${timeoutMs}ms`);
      throw err instanceof GatewayError ? err : new GatewayError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stream one assistant turn, retrying down the fallback chain.
   *
   * Fallback applies only while nothing has been emitted yet: once deltas have
   * reached the UI, silently restarting on another model would duplicate half
   * an answer, so a late failure is raised instead.
   */
  async streamChat(opts: {
    model: string;
    messages: ChatMessage[];
    tools: ToolSchema[];
    signal: AbortSignal;
    handlers: StreamHandlers;
    /** Set when the turn carries images: only vision models can serve it. */
    requireVision?: boolean;
    /** Live catalogue order; replaces the built-in chain when provided. */
    fallbacks?: string[];
    /** Per-chat effort; only sent for models that advertise support. */
    reasoning?: ReasoningEffort;
    reasoningStyle?: ReasoningStyle;
  }): Promise<StreamResult> {
    const base = opts.requireVision
      ? VISION_CHAIN
      : (opts.fallbacks?.length ? opts.fallbacks : FALLBACK_CHAIN);
    // A model without vision cannot be first when the turn carries an image,
    // so the user's pick is only honoured if it is itself vision-capable.
    const head = opts.requireVision && !VISION_CHAIN.includes(opts.model) ? [] : [opts.model];
    const chain = [...head, ...base.filter(m => m !== opts.model)];

    if (opts.requireVision && !head.length) {
      opts.handlers.onModel(chain[0], `${opts.model} не читає зображення — беру ${chain[0]}`);
    }
    let lastError: Error | null = null;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      let emitted = false;
      try {
        if (i > 0) opts.handlers.onModel(model, `фолбек після збою ${chain[i - 1]}`);
        return await this.streamOnce(model, opts, () => { emitted = true; });
      } catch (err) {
        if (opts.signal.aborted) throw err;
        const e = err as GatewayError;
        // When the machine is offline, trying every model only burns time and
        // produces a misleading "all models failed" message.
        if (isNetworkFailure(e.message)) {
          throw new GatewayError('Немає з\'єднання з інтернетом або шлюзом. Перевір мережу й натисни «Повторити».');
        }
        const retryable = !emitted && (e.status === undefined || isTransient(e.status));
        if (!retryable || i === chain.length - 1) throw err;
        lastError = e;
      }
    }
    throw lastError ?? new GatewayError('Жодна модель не відповіла');
  }

  private async streamOnce(
    model: string,
    opts: {
      messages: ChatMessage[];
      tools: ToolSchema[];
      signal: AbortSignal;
      handlers: StreamHandlers;
      reasoning?: ReasoningEffort;
      reasoningStyle?: ReasoningStyle;
    },
    markEmitted: () => void,
  ): Promise<StreamResult> {
    let res: Response;
    try {
      res = await fetch(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        signal: opts.signal,
        body: JSON.stringify({
          model,
          stream: true,
          ...(this.includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...(opts.reasoning
            ? (opts.reasoningStyle === 'openrouter'
              ? { reasoning: { effort: opts.reasoning } }
              : { reasoning_effort: opts.reasoning })
            : {}),
          max_tokens: 8192,
          messages: opts.messages.map(({ at: _at, ...message }) => message),
          ...(opts.tools.length
            ? { tools: opts.tools, tool_choice: 'auto', parallel_tool_calls: true }
            : {}),
        }),
      });
    } catch (err) {
      if (opts.signal.aborted) throw err;
      throw new GatewayError((err as Error).message);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        /* keep the raw text */
      }
      if (this.url.includes('generativelanguage.googleapis.com')
        && (res.status === 401 || /ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid/i.test(detail))) {
        const aqKey = this.apiKey.startsWith('AQ.');
        throw new GatewayError(
          aqKey
            ? 'Google зараз відхиляє нові AQ-ключі на публічному API (відомий баг Google). Ключ правильний, але прямий доступ не працює. Створи стандартний AIza-ключ у Google Cloud Console.'
            : 'Google не прийняв ключ. Перевір, що це Gemini API-ключ і що він не відкликаний.',
          res.status,
        );
      }
      throw new GatewayError(detail || `HTTP ${res.status}`, res.status);
    }

    let content = '';
    let finishReason = 'stop';
    let servedModel = model;
    let usage: TokenUsage | undefined;
    // Keyed by the delta's `index` so parallel tool calls accumulate separately.
    const partial = new Map<number, { id: string; name: string; args: string }>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.error) throw new GatewayError(chunk.error.message ?? 'stream error');
        if (chunk.model) servedModel = chunk.model;
        if (chunk.usage) {
          usage = {
            prompt: Number(chunk.usage.prompt_tokens) || 0,
            completion: Number(chunk.usage.completion_tokens) || 0,
            total: Number(chunk.usage.total_tokens) || 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (typeof delta.reasoning === 'string' && delta.reasoning) {
          markEmitted();
          opts.handlers.onReasoning(delta.reasoning);
        }
        if (typeof delta.content === 'string' && delta.content) {
          markEmitted();
          content += delta.content;
          opts.handlers.onText(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          markEmitted();
          for (let pos = 0; pos < delta.tool_calls.length; pos++) {
            const tc = delta.tool_calls[pos];
            const idx = typeof tc.index === 'number' ? tc.index : pos;
            const slot = partial.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            partial.set(idx, slot);
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, s]) => s.name)
      .map(([idx, s]) => ({
        id: s.id || `call_${idx}`,
        type: 'function' as const,
        function: { name: s.name, arguments: s.args || '{}' },
      }));

    if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_calls';
    return { content, toolCalls, finishReason, servedModel, usage };
  }
}
