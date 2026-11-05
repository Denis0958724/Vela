import { highlight, langFromPath, type Lang } from './highlight.js';

/**
 * A small Markdown renderer that builds DOM nodes, not HTML strings.
 *
 * Model output is untrusted text. Everything here goes through `textContent`
 * or the escaping inside `highlight()`, so there is no path from a model's
 * reply to live markup — which is why this exists instead of a one-line
 * `innerHTML = marked(text)`.
 */

const LANG_BY_NAME: Record<string, Lang> = {
  js: 'js', javascript: 'js', jsx: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md',
};

function langOf(fence: string): Lang {
  const name = fence.trim().toLowerCase();
  if (LANG_BY_NAME[name]) return LANG_BY_NAME[name];
  // `js` for a path-looking fence such as ```src/app.ts
  return name.includes('.') ? langFromPath(name) : 'text';
}

/* ───────────── inline ───────────── */

interface InlineRule {
  re: RegExp;
  build(match: RegExpExecArray): Node;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const INLINE_RULES: InlineRule[] = [
  // Code first: its contents must not be re-parsed as emphasis.
  { re: /`([^`\n]+)`/, build: m => el('code', m[1], 'md-code') },
  { re: /\*\*([^*\n]+)\*\*/, build: m => el('strong', m[1]) },
  { re: /__([^_\n]+)__/, build: m => el('strong', m[1]) },
  { re: /~~([^~\n]+)~~/, build: m => el('del', m[1]) },
  { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, build: m => el('em', m[1]) },
  {
    // Images before links: the leading ! must not be parsed as prose.
    re: /!\[([^\]\n]*)\]\(([^)\s]+)\)/,
    build: m => {
      const wrap = el('span', undefined, 'md-figure');
      const img = document.createElement('img');
      img.className = 'md-image';
      img.alt = m[1] || 'зображення';
      img.loading = 'lazy';
      const src = m[2].replace(/^<|>$/g, '');
      if (/^(https?:|data:image\/)/i.test(src)) img.src = src;
      else img.dataset.path = src;
      wrap.append(img);
      if (m[1]) wrap.append(el('span', m[1], 'md-figure-caption'));
      return wrap;
    },
  },
  {
    // The renderer decides whether a clicked target is a web link or a file.
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    build: m => {
      const node = el('span', m[1], 'md-link');
      node.dataset.href = m[2];
      node.title = m[2];
      node.tabIndex = 0;
      node.setAttribute('role', 'link');
      return node;
    },
  },
  {
    // Bare URLs in prose are clickable too.
    re: /https?:\/\/[^\s<>()]+/i,
    build: m => {
      const href = m[0].replace(/[.,;:!?]+$/, '');
      const node = el('span', href, 'md-link');
      node.dataset.href = href;
      node.title = href;
      node.tabIndex = 0;
      node.setAttribute('role', 'link');
      return node;
    },
  },
];

function renderInline(text: string, into: Node): void {
  let rest = text;

  while (rest) {
    let best: { index: number; rule: InlineRule; match: RegExpExecArray } | null = null;

    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(rest);
      if (match && (best === null || match.index < best.index)) {
        best = { index: match.index, rule, match };
      }
    }

    if (!best) {
      into.appendChild(document.createTextNode(rest));
      return;
    }

    if (best.index > 0) {
      into.appendChild(document.createTextNode(rest.slice(0, best.index)));
    }
    into.appendChild(best.rule.build(best.match));
    rest = rest.slice(best.index + best.match[0].length);
  }
}

/* ───────────── blocks ───────────── */

function codeBlock(code: string, fence: string): HTMLElement {
  const wrap = el('div', undefined, 'md-pre');

  const head = el('div', undefined, 'md-pre-head');
  head.append(el('span', fence.trim() || 'code', 'md-pre-lang'));

  const copy = el('button', 'копіювати', 'md-pre-copy');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code);
    copy.textContent = 'скопійовано';
    setTimeout(() => { copy.textContent = 'копіювати'; }, 1400);
  });
  head.append(copy);

  const pre = el('pre', undefined, 'md-pre-body');
  // `highlight` escapes everything it does not turn into a token span.
  pre.innerHTML = highlight(code.replace(/\n$/, ''), langOf(fence));

  wrap.append(head, pre);
  return wrap;
}

function tableBlock(rows: string[]): HTMLElement | null {
  const cells = (line: string) =>
    line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

  if (rows.length < 2 || !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(rows[1])) return null;

  const table = el('table', undefined, 'md-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const cell of cells(rows[0])) {
    const th = document.createElement('th');
    renderInline(cell, th);
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  for (const line of rows.slice(2)) {
    const tr = document.createElement('tr');
    for (const cell of cells(line)) {
      const td = document.createElement('td');
      renderInline(cell, td);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

/** Parse `text` into DOM. Safe to call on a partially streamed message. */
export function renderMarkdown(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code — an unclosed fence still renders, so streaming looks right
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.append(codeBlock(body.join('\n'), fence[1]));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const h = el(`h${Math.min(heading[1].length + 2, 6)}`, undefined, 'md-h');
      renderInline(heading[2], h);
      out.append(h);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.append(el('hr', undefined, 'md-hr'));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = el('blockquote', undefined, 'md-quote');
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      renderInline(body.join('\n'), quote);
      out.append(quote);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const table = tableBlock(rows);
      if (table) {
        out.append(table);
        continue;
      }
      // Not a real table: fall through and treat the rows as prose.
      const p = el('p', undefined, 'md-p');
      renderInline(rows.join('\n'), p);
      out.append(p);
      continue;
    }

    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const list = el(ordered ? 'ol' : 'ul', undefined, 'md-list');
      if (ordered) (list as HTMLOListElement).start = Number(numbered![2]) || 1;

      while (i < lines.length) {
        const item = ordered
          ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i])
          : /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]);
        if (!item) break;

        const li = el('li');
        const parts = [item[3]];
        i++;
        // Continuation lines belong to the item they are indented under.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])
          && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        renderInline(parts.join(' '), li);
        list.append(li);
      }
      out.append(list);
      continue;
    }

    // paragraph: consume until a blank line or the start of another block
    const body: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !/^```/.test(lines[i])
      && !/^#{1,6}\s/.test(lines[i])
      && !/^\s*>/.test(lines[i])
      && !/^\s*\|/.test(lines[i])
      && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
      body.push(lines[i++]);
    }
    const p = el('p', undefined, 'md-p');
    renderInline(body.join('\n'), p);
    out.append(p);
  }

  return out;
}
