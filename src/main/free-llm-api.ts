import { GatewayClient } from './gateway.js';
import type { ModelInfo } from './types.js';

/**
 * Vela's only model source. Free LLM API is an OpenAI-compatible gateway that
 * owns the upstream provider keys, so the desktop app never has to juggle
 * Google/Groq/NVIDIA/OpenRouter credentials itself.
 */
export class FreeLlmApiClient extends GatewayClient {
  constructor(url: string, key: string) {
    super(url, key, { includeUsage: true });
  }

  override async listModels(availableOnly = true): Promise<ModelInfo[]> {
    const models = await super.listModels(availableOnly);
    return models
      // The gateway advertises decorative Claude slots that are not real
      // models; they must never reach the picker.
      .filter(model => !/^claude-(opus|sonnet|haiku)-4-5$/.test(model.id) && !/\bslot\b/i.test(model.name ?? ''))
      .map(model => ({
        ...model,
        provider: 'freellmapi',
        reasoning: supportsReasoning(model.id),
      }));
  }
}

function supportsReasoning(id: string): boolean {
  return /gpt-oss|qwen|deepseek|nemotron|reasoning|thinking|o[134](?:-|\b)|gpt-5|gemini-(?:3|2\.5)|claude/i.test(id);
}
