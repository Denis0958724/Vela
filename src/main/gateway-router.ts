import type { ModelInfo } from './types.js';
import { GatewayClient, type StreamResult } from './gateway.js';
import type { ProviderStore } from './providers.js';

const SEP = '::';

function supportsReasoning(provider: string, id: string, advertised?: boolean): boolean {
  if (advertised) return true;
  const lower = id.toLowerCase();
  if (provider === 'openrouter') {
    return /(reasoning|thinking|o[134](?:-|\b)|gpt-5|gpt-oss|deepseek|qwen|gemini|claude|nemotron|dots|north|lfm)/.test(lower);
  }
  if (provider === 'google') return /gemini-(?:3|2\.5)/.test(lower);
  if (provider === 'groq') return /gpt-oss|deepseek|qwen/.test(lower);
  if (provider === 'nvidia') return /nemotron|reasoning|thinking/.test(lower);
  return false;
}

/** Audio, image and guard endpoints are advertised as models but cannot chat. */
function isChatModel(id: string): boolean {
  return !/(whisper|tts|orpheus|prompt[-_]?guard|guard|embed|embedding|imagen|image|diffusion|flux|sdxl|video|audio|voice|music|speech|dall|stable[-_]?diffusion|rerank)/i.test(id);
}

/** Split a qualified provider model id. */
export function splitProviderModel(id: string): { provider: string; model: string } | null {
  const index = id.indexOf(SEP);
  if (index <= 0 || index + SEP.length >= id.length) return null;
  return { provider: id.slice(0, index), model: id.slice(index + SEP.length) };
}

/**
 * Routes qualified `provider::model` ids to direct provider clients. Vela no
 * longer has a FreeLLMAPI fallback; a model must belong to a configured
 * provider.
 */
export class ProviderRouter extends GatewayClient {
  constructor(private providers: ProviderStore) {
    super('', '');
  }

  override async listModels(availableOnly = true): Promise<ModelInfo[]> {
    const direct: ModelInfo[] = [];
    for (const summary of this.providers.summaries()) {
      if (!summary.configured || !summary.enabled) continue;
      const client = this.providers.client(summary.id);
      if (!client) continue;
      try {
        const models = await client.listModels(availableOnly);
        for (const model of models) {
          if (!isChatModel(model.id)) continue;
          // The OpenRouter key has no usable paid balance. Keep the catalogue
          // honest instead of showing hundreds of models that fail with
          // "requires more credits" on the first request.
          if (summary.id === 'openrouter' && model.free !== true) continue;
          direct.push({
            ...model,
            id: `${summary.id}${SEP}${model.id}`,
            name: model.name ?? model.id,
            provider: summary.id,
            reasoning: supportsReasoning(summary.id, model.id, model.reasoning),
          });
        }
      } catch {
        // One dead provider must not hide all the others.
      }
    }
    return direct;
  }

  override async probeModel(model: string, withTools: boolean, timeoutMs: number): Promise<string> {
    const split = splitProviderModel(model);
    if (!split) throw new Error('Модель не належить прямому провайдеру.');
    const client = this.providers.client(split.provider);
    if (!client) throw new Error('Провайдер не налаштований.');
    return client.probeModel(split.model, withTools, timeoutMs);
  }

  override async streamChat(opts: Parameters<GatewayClient['streamChat']>[0]): Promise<StreamResult> {
    const split = splitProviderModel(opts.model);
    if (!split) throw new Error('Спочатку додай API-ключ у Налаштуваннях → Провайдери.');
    const client = this.providers.client(split.provider);
    if (!client) throw new Error(`Провайдер ${split.provider} не налаштований.`);

    const fallbacks = (opts.fallbacks ?? [])
      .map(fallback => splitProviderModel(fallback))
      .filter((fallback): fallback is { provider: string; model: string } => fallback?.provider === split.provider)
      .map(fallback => fallback.model);
    if (!fallbacks.length) fallbacks.push(split.model);

    const result = await client.streamChat({
      ...opts,
      model: split.model,
      fallbacks,
      // The gateway's vision chain uses unprefixed model names. A direct
      // provider must keep its own model, otherwise the fallback points at a
      // model that provider has never heard of.
      requireVision: false,
      reasoningStyle: split.provider === 'openrouter' ? 'openrouter' : 'effort',
      handlers: {
        ...opts.handlers,
        onModel: (model, note) => opts.handlers.onModel(`${split.provider}${SEP}${model}`, note),
      },
    });
    return { ...result, servedModel: `${split.provider}${SEP}${result.servedModel}` };
  }

  override async health(): Promise<{ ok: boolean; detail: string; modelCount?: number }> {
    const configured = this.providers.summaries().filter(p => p.configured && p.enabled);
    if (!configured.length) return { ok: false, detail: 'API-ключі не додані' };
    let count = 0;
    const errors: string[] = [];
    for (const provider of configured) {
      const client = this.providers.client(provider.id);
      if (!client) continue;
      try {
        count += (await client.listModels(true)).length;
      } catch (err) {
        errors.push(`${provider.name}: ${(err as Error).message}`);
      }
    }
    if (count) return { ok: true, detail: `${count} моделей у прямих провайдерах`, modelCount: count };
    return { ok: false, detail: errors.join(' · ').slice(0, 240) || 'Провайдери не відповіли' };
  }
}
