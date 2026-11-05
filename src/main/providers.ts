import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx.js';
import { GatewayClient } from './gateway.js';

export interface ProviderDef {
  id: string;
  name: string;
  /** Base passed to GatewayClient; it appends /v1 unless the URL ends in /openai. */
  baseUrl: string;
  hint: string;
  docs: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  hint: string;
  docs: string;
  configured: boolean;
  enabled: boolean;
  keyMask: string;
  status: 'unknown' | 'ok' | 'error';
  detail: string;
  checkedAt: number | null;
  modelCount: number | null;
}

interface StoredProvider {
  encryptedKey?: string;
  enabled?: boolean;
  checkedAt?: number | null;
  status?: 'unknown' | 'ok' | 'error';
  detail?: string;
  modelCount?: number | null;
}

interface ProviderFile {
  providers: Record<string, StoredProvider>;
}

export const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'google',
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hint: 'Gemini API key з aistudio.google.com',
    docs: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai',
    hint: 'Ключ з console.groq.com',
    docs: 'https://console.groq.com/keys',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com',
    hint: 'Ключ з build.nvidia.com',
    docs: 'https://build.nvidia.com',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    hint: 'Ключ з openrouter.ai/keys',
    docs: 'https://openrouter.ai/keys',
  },
  {
    id: 'orcarouter',
    name: 'OrcaRouter',
    baseUrl: 'https://api.orcarouter.ai',
    hint: 'Ключ з orcarouter.ai, безкоштовні слоти теж працюють',
    docs: 'https://www.orcarouter.ai',
  },
];

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export class ProviderStore {
  private data: ProviderFile = { providers: {} };
  private keys = new Map<string, string>();
  private loaded = false;

  private file(): string {
    return join(app.getPath('userData'), 'providers.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8')) as ProviderFile;
      this.data = { providers: parsed.providers ?? {} };
    } catch {
      this.data = { providers: {} };
    }

    for (const [id, stored] of Object.entries(this.data.providers)) {
      if (!stored.encryptedKey) continue;
      try {
        const key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'));
        if (key) this.keys.set(id, key);
      } catch {
        stored.status = 'error';
        stored.detail = 'Не вдалося розшифрувати ключ на цьому ПК. Введи його знову.';
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) return;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await writeFileAtomic(this.file(), JSON.stringify(this.data, null, 2));
  }

  private def(id: string): ProviderDef | undefined {
    return PROVIDER_DEFS.find(provider => provider.id === id);
  }

  key(id: string): string | null {
    return this.keys.get(id) ?? null;
  }

  hasUsable(): boolean {
    return this.summaries().some(provider => provider.configured && provider.enabled);
  }

  client(id: string): GatewayClient | null {
    const def = this.def(id);
    const key = this.key(id);
    if (!def || !key) return null;
    if (def.id === 'google') {
      return new GatewayClient(def.baseUrl, key, {
        includeUsage: false,
        modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        // Google's native model list authenticates with x-goog-api-key. The
        // OpenAI-compatible chat endpoint uses the Bearer header instead.
        modelsAuth: 'x-goog-api-key',
      });
    }
    return new GatewayClient(def.baseUrl, key, { includeUsage: true });
  }

  summaries(): ProviderSummary[] {
    return PROVIDER_DEFS.map(def => {
      const stored = this.data.providers[def.id] ?? {};
      const key = this.keys.get(def.id) ?? '';
      return {
        id: def.id,
        name: def.name,
        baseUrl: def.baseUrl,
        hint: def.hint,
        docs: def.docs,
        configured: Boolean(key),
        enabled: stored.enabled !== false && Boolean(key),
        keyMask: maskKey(key),
        status: stored.status ?? 'unknown',
        detail: stored.detail ?? '',
        checkedAt: stored.checkedAt ?? null,
        modelCount: stored.modelCount ?? null,
      };
    });
  }

  async save(id: string, key: string | undefined, enabled: boolean): Promise<ProviderSummary> {
    const def = this.def(id);
    if (!def) throw new Error('Невідомий провайдер.');
    const stored = this.data.providers[id] ?? {};
    const incoming = key?.trim() ?? '';

    if (incoming) {
      if (id === 'google' && incoming.length < 20) {
        throw new Error('Ключ Google виглядає обрізаним. Скопіюй його повністю з AI Studio.');
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Системне шифрування недоступне. Ключ не збережено.');
      }
      stored.encryptedKey = safeStorage.encryptString(incoming).toString('base64');
      this.keys.set(id, incoming);
      stored.status = 'unknown';
      stored.detail = 'Ключ збережено. Натисни «Перевірити».';
      stored.modelCount = null;
      stored.checkedAt = null;
    } else if (!this.keys.has(id)) {
      throw new Error('Введи API-ключ.');
    }

    stored.enabled = enabled;
    this.data.providers[id] = stored;
    await this.persist();
    return this.summaries().find(row => row.id === id)!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ProviderSummary> {
    const stored = this.data.providers[id];
    if (!stored || !this.keys.has(id)) throw new Error('Спочатку додай ключ.');
    stored.enabled = enabled;
    await this.persist();
    return this.summaries().find(row => row.id === id)!;
  }

  async remove(id: string): Promise<void> {
    delete this.data.providers[id];
    this.keys.delete(id);
    await this.persist();
  }

  async test(id: string): Promise<ProviderSummary> {
    const client = this.client(id);
    const stored = this.data.providers[id];
    if (!client || !stored) throw new Error('Спочатку додай ключ.');
    const started = Date.now();
    try {
      const models = await client.listModels(true);
      stored.status = 'ok';
      stored.detail = `Підключено, ${models.length} моделей`;
      stored.modelCount = models.length;
    } catch (err) {
      const message = (err as Error).message || 'Помилка підключення';
      stored.status = 'error';
      const aqKey = (this.keys.get(id) ?? '').startsWith('AQ.');
      stored.detail = id === 'google' && aqKey && /ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid|UNAUTHENTICATED/i.test(message)
        ? 'Google зараз відхиляє нові AQ-ключі на публічному API (відомий баг Google). Ключ правильний, але прямий доступ не працює. Створи стандартний AIza-ключ у Google Cloud Console.'
        : message.slice(0, 220);
      stored.modelCount = null;
    }
    stored.checkedAt = started;
    await this.persist();
    return this.summaries().find(row => row.id === id)!;
  }
}
