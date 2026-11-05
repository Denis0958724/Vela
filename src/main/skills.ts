import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';

export interface Skill {
  /** Slug and filename stem; what the model passes to `use_skill`. */
  name: string;
  description: string;
  /** Always-on skills are inlined into the system prompt instead of loaded on demand. */
  always: boolean;
  body: string;
}

export type SkillSummary = Omit<Skill, 'body'>;

/** Shipped so the feature is demonstrable on first run rather than an empty list. */
const SEEDS: Array<Omit<Skill, 'always'> & { always?: boolean }> = [
  {
    name: 'static-site',
    description: 'Структура й вимоги до статичного сайту: семантика, адаптивність, доступність',
    body: [
      '# Статичний сайт',
      '',
      'Структура: `index.html`, `styles.css`, за потреби `script.js`. Без зовнішніх',
      'залежностей і CDN — усе має працювати з локального файлу.',
      '',
      '## Розмітка',
      '- Семантичні теги: `header`, `nav`, `main`, `section`, `footer`.',
      '- Один `h1` на сторінку, далі рівні без пропусків.',
      '- У `img` завжди `alt`; декоративним — `alt=""`.',
      '- `<html lang="uk">` і `<meta name="viewport" content="width=device-width, initial-scale=1">`.',
      '',
      '## Стилі',
      '- Кольори через CSS-змінні в `:root`, щоб тему можна було змінити в одному місці.',
      '- Працює від 360px: `flex-wrap` або `grid` з перебудовою в одну колонку.',
      '- Контраст тексту щонайменше 4.5:1.',
      '- Інтерактивні елементи мають видимий `:focus-visible`.',
      '',
      '## Перевірка',
      'Після створення скажи користувачеві відкрити вкладку «Прев\'ю».',
    ].join('\n'),
  },
  {
    name: 'code-review',
    description: 'Огляд коду: що перевіряти і в якому порядку',
    body: [
      '# Огляд коду',
      '',
      'Спочатку прочитай код, і лише потім суди. Не вигадуй проблем, яких немає.',
      '',
      'Порядок перевірки:',
      '1. **Коректність** — чи робить код те, що заявлено; межові випадки, пусті',
      '   значення, помилки, які проглинаються.',
      '2. **Безпека** — неперевірений ввід, шляхи з користувацьких даних, секрети',
      '   у коді, конкатенація запитів.',
      '3. **Ресурси** — незакриті файли й підписки, зайві проходи по даних.',
      '4. **Читність** — назви, мертвий код, дублювання.',
      '',
      'На кожну знахідку: файл і рядок, у чому саме дефект, і конкретний сценарій,',
      'за якого він спрацює. Якщо сценарій не складається — це не знахідка.',
    ].join('\n'),
  },
  {
    name: 'writing-style',
    description: 'Живий розмовний стиль: коротко, по суті, з іронією',
    always: true,
    body: [
      '# Стиль письма',
      '',
      'Пиши в живом разговорном стиле. Избегай вычурных слов: кофе, вдохновение,',
      'нервы, восторг, дедлайн, стероиды, бывший, шаманство.',
      '',
      'Не используй длинные тире. Не пихай эмоджи. Пиши короткими предложениями,',
      'по сути, с иронией.',
    ].join('\n'),
  },
];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';
}

/** Minimal frontmatter reader — only the keys a skill actually declares. */
function parse(name: string, raw: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { name, description: '', always: false, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return {
    name: meta.name ? slugify(meta.name) : name,
    description: meta.description ?? '',
    always: meta.always === 'true',
    body: match[2].trim(),
  };
}

function serialize(skill: Skill): string {
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description.replace(/\r?\n/g, ' ')}`,
    `always: ${skill.always}`,
    '---',
    '',
    skill.body.trim(),
    '',
  ].join('\n');
}

/**
 * Reusable instruction sets the agent can pull in. Kept as plain `.md` files so
 * they can be edited, copied between machines or kept in version control.
 */
export class SkillRegistry {
  private dir(): string {
    return join(app.getPath('userData'), 'skills');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    const existing = await fs.readdir(this.dir()).catch(() => [] as string[]);
    for (const seed of SEEDS) {
      if (existing.includes(`${slugify(seed.name)}.md`)) continue;
      await this.save({ ...seed, always: seed.always ?? false });
    }
  }

  async list(): Promise<Skill[]> {
    const files = await fs.readdir(this.dir()).catch(() => [] as string[]);
    const skills: Skill[] = [];
    for (const file of files.filter(f => f.endsWith('.md'))) {
      try {
        const raw = await fs.readFile(join(this.dir(), file), 'utf8');
        skills.push(parse(basename(file, '.md'), raw));
      } catch {
        /* unreadable skill file: skip rather than break the whole list */
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async summaries(): Promise<SkillSummary[]> {
    return (await this.list()).map(({ name, description, always }) => ({ name, description, always }));
  }

  async get(name: string): Promise<Skill | null> {
    const slug = slugify(name);
    try {
      return parse(slug, await fs.readFile(join(this.dir(), `${slug}.md`), 'utf8'));
    } catch {
      // Tolerate a model naming the skill by its description-ish title.
      return (await this.list()).find(s => s.name === slug) ?? null;
    }
  }

  async save(input: { name: string; description: string; body: string; always: boolean }): Promise<Skill> {
    await fs.mkdir(this.dir(), { recursive: true });
    const skill: Skill = { ...input, name: slugify(input.name) };
    await fs.writeFile(join(this.dir(), `${skill.name}.md`), serialize(skill), 'utf8');
    return skill;
  }

  async remove(name: string): Promise<void> {
    await fs.rm(join(this.dir(), `${slugify(name)}.md`), { force: true });
  }

  /** Imports an existing markdown file as a skill, keeping its filename as the slug. */
  async importFile(path: string): Promise<Skill> {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = parse(slugify(basename(path).replace(/\.mdx?$/i, '')), raw);
    if (!parsed.description) {
      // Fall back to the first prose line so the picker is not blank.
      const line = parsed.body.split('\n').find(l => l.trim() && !l.startsWith('#'));
      parsed.description = (line ?? '').trim().slice(0, 120);
    }
    return this.save(parsed);
  }

  /**
   * Installs an instruction plugin from a GitHub repo or a raw markdown URL.
   * Only GitHub hosts are accepted, and the fetch is size-limited.
   */
  async installFromGitHub(input: string): Promise<Skill> {
    const candidates = githubCandidates(input);
    let lastError = 'Не вдалося завантажити плагін.';
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate.url, {
          headers: { 'User-Agent': 'Vela/1.0', Accept: 'text/plain, text/markdown, */*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          lastError = `GitHub повернув ${res.status}.`;
          continue;
        }
        const raw = await res.text();
        if (!raw.trim() || raw.length > 512_000) {
          lastError = 'Файл плагіна порожній або завеликий.';
          continue;
        }
        const parsed = parse(slugify(candidate.name), raw);
        if (!parsed.description) {
          const line = parsed.body.split('\n').find(l => l.trim() && !l.startsWith('#'));
          parsed.description = (line ?? '').trim().slice(0, 160) || 'Плагін з GitHub';
        }
        return this.save(parsed);
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    throw new Error(lastError);
  }

  folder(): string {
    return this.dir();
  }
}

interface GithubCandidate {
  url: string;
  name: string;
}

function githubCandidates(input: string): GithubCandidate[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Встав посилання на GitHub.');
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  const raw = shorthand ? `https://github.com/${shorthand[1]}/${shorthand[2]}` : trimmed;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Це не схоже на посилання GitHub.');
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'raw.githubusercontent.com') {
    throw new Error('Підтримується лише github.com.');
  }

  if (url.hostname === 'raw.githubusercontent.com') {
    return [{ url: url.toString(), name: basename(url.pathname).replace(/\.mdx?$/i, '') || 'plugin' }];
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Посилання має містити власника й репозиторій.');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  const base = `https://raw.githubusercontent.com/${owner}/${repo}`;

  if (parts[2] === 'blob' && parts.length >= 4) {
    const ref = parts[3];
    const file = parts.slice(4).join('/');
    return [{ url: `${base}/${ref}/${file}`, name: basename(file).replace(/\.mdx?$/i, '') || repo }];
  }
  if (parts[2] === 'tree' && parts.length >= 4) {
    const ref = parts[3];
    const path = parts.slice(4).join('/');
    const suffix = path ? `${path}/SKILL.md` : 'SKILL.md';
    return [{ url: `${base}/${ref}/${suffix}`, name: repo }];
  }

  const result: GithubCandidate[] = [];
  for (const branch of ['main', 'master']) {
    result.push({ url: `${base}/${branch}/SKILL.md`, name: repo });
  }
  for (const branch of ['main', 'master']) {
    result.push({ url: `${base}/${branch}/README.md`, name: repo });
  }
  return result;
}
