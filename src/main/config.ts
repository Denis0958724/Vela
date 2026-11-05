import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface Settings {
  model: string;
  /** Where "Новий проєкт" creates folders by default. */
  projectsRoot: string;
  approvalMode: 'ask' | 'auto' | 'turbo';
  /** Standing instructions added to every system prompt. */
  instructions: string;
  /** Explicit user permission for the web tools. Off by default. */
  allowInternet: boolean;
  /** File writes, edits, deletion and shell commands. On by default. */
  allowFiles: boolean;
  /** Explicit user permission for desktop control. Off by default. */
  allowComputer: boolean;
  /** Visual theme, stored with the rest of the UI settings. */
  theme: 'indigo' | 'light' | 'dark';
  /** Model ids the user explicitly switched off. */
  disabledModels: string[];
  /** How fallback models are ordered when several are usable. */
  routingStrategy: 'balanced' | 'smart' | 'fast';
  /** OpenAI-compatible Free LLM API base URL. */
  gatewayUrl: string;
  /** Key for that gateway; providers themselves live behind it. */
  apiKey: string;
  /** Panel geometry, persisted so a tuned layout survives a restart. */
  leftWidth: number;
  rightWidth: number;
  rightCollapsed: boolean;
  leftCollapsed: boolean;
}

const DEFAULTS: Settings = {
  // Free LLM API routes this to Google's Gemini Flash by default.
  model: 'gemini-flash',
  projectsRoot: '',
  approvalMode: 'ask',
  instructions: '',
  allowInternet: false,
  allowFiles: true,
  allowComputer: false,
  theme: 'indigo',
  disabledModels: [],
  routingStrategy: 'balanced',
  gatewayUrl: 'http://127.0.0.1:31415',
  apiKey: '',
  leftWidth: 250,
  rightWidth: 460,
  rightCollapsed: false,
  leftCollapsed: false,
};

export const LAYOUT_LIMITS = {
  leftMin: 180,
  leftMax: 460,
  rightMin: 280,
  rightMax: 900,
};

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function loadSettings(): Promise<Settings> {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(await fs.readFile(file(), 'utf8')) as Partial<Settings>;
  } catch {
    /* first run, or a corrupted file: fall through to defaults */
  }
  const merged = { ...DEFAULTS, ...stored };

  // The old read-only mode was folded into the three-mode selector.
  if ((merged.approvalMode as string) === 'readonly') merged.approvalMode = 'ask';

  // Env vars are optional conveniences for automation.
  if (!merged.projectsRoot) merged.projectsRoot = join(app.getPath('home'), 'VelaProjects');

  // A corrupted or hand-edited file must not be able to produce an unusable window.
  merged.leftWidth = clamp(merged.leftWidth, LAYOUT_LIMITS.leftMin, LAYOUT_LIMITS.leftMax, DEFAULTS.leftWidth);
  merged.rightWidth = clamp(merged.rightWidth, LAYOUT_LIMITS.rightMin, LAYOUT_LIMITS.rightMax, DEFAULTS.rightWidth);

  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(settings, null, 2), 'utf8');
}
