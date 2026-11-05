/**
 * Model ordering shared by the picker and the automatic context fallback.
 *
 * The gateway's catalogue is a flat list: it gives no capability tier. The
 * ranking below is deliberately a heuristic, not a benchmark — it puts the
 * newest reasoning families first and the small old ones last, which is what a
 * person choosing a coding model expects to see.
 */

export interface RankableModel {
  id: string;
  context: number | null;
  tools?: boolean;
  verdict?: 'ok' | 'dead' | 'unknown';
}

const RULES: Array<[RegExp, number]> = [
  // The default is Gemini Flash; the newest Flash revisions follow it.
  [/^gemini-flash$/, 170],
  [/gemini.*3[.-]?8.*flash(?!.*lite)/, 158],
  [/gemini.*3[.-]?7.*flash(?!.*lite)/, 156],
  [/gemini.*3[.-]?6.*flash(?!.*lite)/, 154],
  [/gemini.*3[.-]?5.*flash(?!.*lite)/, 152],
  [/gemini.*flash(?!.*lite)/, 150],
  [/claude.*opus.*4[.-]?5/, 148],
  [/claude.*opus/, 146],
  [/gpt[.-]?5(?:[.-]|\b)/, 144],
  [/\bo[345](?:[.-]|\b)/, 142],
  [/gemini.*3(?:[.-]|\b).*pro/, 140],
  [/grok[.-]?4/, 138],
  [/deepseek.*r1/, 136],
  [/claude.*sonnet.*4[.-]?5/, 134],
  [/gpt[.-]?oss[.-]?120b/, 132],
  [/nemotron.*3.*super/, 130],
  [/gemini.*3(?:[.-]|\b)/, 128],
  [/claude.*sonnet/, 126],
  [/qwen.*3[.-]?8/, 124],
  [/gpt[.-]?4[.-]?1/, 120],
  [/gemini.*2[.-]?5.*pro/, 118],
  [/llama.*4/, 116],
  [/gpt[.-]?4o(?!.*mini)/, 114],
  [/nemotron.*3[.-]?5.*lightning/, 110],
  [/qwen.*3(?:[.-]|\b)/, 108],
  [/gemini.*2[.-]?5.*flash/, 106],
  [/gpt[.-]?oss[.-]?20b/, 104],
  [/deepseek.*v3/, 102],
  [/mistral.*large/, 100],
  [/grok[.-]?3/, 96],
  [/claude.*haiku/, 94],
  [/gemini.*2[.-]?5.*flash.*lite/, 80],
  [/gpt[.-]?4o.*mini/, 78],
  [/qwen.*2[.-]?5/, 72],
  [/llama.*3[.-]?1/, 68],
  [/gemma.*3/, 62],
  [/phi[.-]?4/, 58],
  [/llama.*3/, 54],
  [/mixtral/, 48],
];

const FAMILIES = [
  'claude', 'gpt-oss', 'gpt', 'gemini', 'qwen', 'deepseek', 'llama',
  'nemotron', 'mistral', 'mixtral', 'grok', 'gemma', 'phi', 'command',
  'glm', 'yi', 'internlm', 'ernie',
];

export function modelFamily(id: string): string {
  const lower = id.toLowerCase();
  return FAMILIES.find(f => lower.includes(f)) ?? lower.split(/[-_.:]/)[0] ?? lower;
}

/** Higher means more capable/newer. `auto` and `fusion` are router slots. */
export function modelScore(id: string): number {
  const lower = id.toLowerCase().trim();
  if (lower === 'auto') return 130;
  if (lower === 'fusion') return 126;

  let score = 42;
  for (const [re, value] of RULES) {
    if (re.test(lower)) {
      score = Math.max(score, value);
      break;
    }
  }

  // Unknown but plausibly newer names: a version number is still a useful
  // signal (`foo-4` above `foo-3`), as are words that mark a small variant.
  const version = /(?:^|[^\d])(\d{1,2})(?:\.(\d{1,2}))?/.exec(lower);
  if (version) {
    const major = Number(version[1]);
    const minor = Number(version[2] ?? 0);
    score += Math.min(10, major * 2 + Math.min(minor, 9) / 3);
  }
  if (/\b(pro|max|ultra|thinking|reasoning)\b/.test(lower)) score += 5;
  if (/\b(flash|mini|small|lite|tiny|nano)\b/.test(lower)) score -= 6;

  return Math.max(1, Math.round(score));
}

/** Capability order, with the two gateway routers pinned above real models. */
export function sortModels<T extends RankableModel>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const score = modelScore(b.id) - modelScore(a.id);
    if (score !== 0) return score;
    const context = (b.context ?? 0) - (a.context ?? 0);
    if (context !== 0) return context;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Pick the closest model that can actually hold `neededTokens`.
 *
 * "Closest" means the same family first, then the nearest capability score —
 * a Claude conversation moves to another Claude, not to a tiny Llama just
 * because it has a large window.
 */
export function pickFallbackModel<T extends RankableModel>(
  rows: T[],
  currentId: string,
  neededTokens: number,
): T | null {
  const usable = rows.filter(row =>
    row.id !== currentId
    && row.id !== 'auto'
    && row.id !== 'fusion'
    && row.tools !== false
    && row.verdict !== 'dead'
    && row.context !== null,
  );
  if (!usable.length) return null;

  const family = modelFamily(currentId);
  const currentScore = modelScore(currentId);
  const sameFamily = (row: T) => modelFamily(row.id) === family;

  const fits = usable.filter(row => (row.context ?? 0) >= neededTokens);
  const pool = fits.length ? fits : usable;
  pool.sort((a, b) => {
    const familyRank = Number(!sameFamily(a)) - Number(!sameFamily(b));
    if (familyRank !== 0) return familyRank;
    const distance = Math.abs(modelScore(a.id) - currentScore)
      - Math.abs(modelScore(b.id) - currentScore);
    if (distance !== 0) return distance;
    if (!fits.length) return (b.context ?? 0) - (a.context ?? 0);
    return (a.context ?? 0) - (b.context ?? 0);
  });
  return pool[0] ?? null;
}
