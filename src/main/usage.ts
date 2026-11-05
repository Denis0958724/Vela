import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx.js';

export interface ModelUsage {
  prompt: number;
  completion: number;
  total: number;
  requests: number;
}

export interface UsageSnapshot {
  month: string;
  models: Record<string, ModelUsage>;
  total: number;
}

function monthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export class UsageStore {
  private month = monthKey();
  private models: Record<string, ModelUsage> = {};
  private loaded = false;

  private file(): string {
    return join(app.getPath('userData'), 'usage.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8')) as {
        month?: string;
        models?: Record<string, ModelUsage>;
      };
      if (parsed.month === this.month && parsed.models) this.models = parsed.models;
    } catch {
      /* first run */
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) return;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await writeFileAtomic(this.file(), JSON.stringify({ month: this.month, models: this.models }, null, 2));
  }

  async add(model: string, prompt: number, completion: number, total: number): Promise<void> {
    const currentMonth = monthKey();
    if (currentMonth !== this.month) {
      this.month = currentMonth;
      this.models = {};
    }
    const current = this.models[model] ?? { prompt: 0, completion: 0, total: 0, requests: 0 };
    current.prompt += Math.max(0, prompt);
    current.completion += Math.max(0, completion);
    current.total += Math.max(0, total || prompt + completion);
    current.requests += 1;
    this.models[model] = current;
    await this.persist();
  }

  snapshot(): UsageSnapshot {
    const total = Object.values(this.models).reduce((sum, item) => sum + item.total, 0);
    return { month: this.month, models: this.models, total };
  }
}
