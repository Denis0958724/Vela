/**
 * A small, dependency-free syntax highlighter.
 *
 * The CSP forbids remote scripts and the app must work offline, so a library
 * like Prism is not an option. This is deliberately approximate: it is a
 * scanner over ordered sticky regexes, not a parser, which is enough to make
 * code readable and cheap enough to re-run on every keystroke.
 */

export type Lang = 'js' | 'html' | 'css' | 'json' | 'md' | 'text';

interface Rule {
  type: string;
  re: RegExp;
}

/** Highlighting every keystroke of a huge file is not worth the jank. */
const MAX_HIGHLIGHT_BYTES = 200_000;

const JS_KEYWORDS =
  'await|async|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|'
  + 'finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|private|protected|'
  + 'public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|yield';

const JS_LITERALS = 'true|false|null|undefined|NaN|Infinity';

const RULES: Record<Exclude<Lang, 'text'>, Rule[]> = {
  js: [
    { type: 'com', re: /\/\/[^\n]*/y },
    { type: 'com', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: 'str', re: /`(?:[^`\\]|\\[\s\S])*`?/y },
    { type: 'str', re: /"(?:[^"\\\n]|\\.)*"?/y },
    { type: 'str', re: /'(?:[^'\\\n]|\\.)*'?/y },
    { type: 'num', re: /\b0[xX][\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?\b/y },
    { type: 'lit', re: new RegExp(`\\b(?:${JS_LITERALS})\\b`, 'y') },
    { type: 'kw', re: new RegExp(`\\b(?:${JS_KEYWORDS})\\b`, 'y') },
    { type: 'fn', re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y },
    { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
  ],
  html: [
    { type: 'com', re: /<!--[\s\S]*?(?:-->|$)/y },
    { type: 'kw', re: /<!DOCTYPE[^>]*>/iy },
    { type: 'tag', re: /<\/?[A-Za-z][\w:-]*/y },
    { type: 'str', re: /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/y },
    { type: 'attr', re: /[A-Za-z_:][\w:.-]*(?=\s*=)/y },
    { type: 'punct', re: /\/?>/y },
  ],
  css: [
    { type: 'com', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
    { type: 'kw', re: /@[-\w]+/y },
    { type: 'str', re: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y },
    { type: 'num', re: /#[\da-fA-F]{3,8}\b/y },
    { type: 'num', re: /\b-?\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|fr|deg|ch)?\b/y },
    { type: 'prop', re: /[-a-zA-Z_][-\w]*(?=\s*:)/y },
    { type: 'fn', re: /\b[-a-zA-Z_][-\w]*(?=\s*\()/y },
    { type: 'tag', re: /[.#][-\w]+|&|::?[-\w]+/y },
    { type: 'punct', re: /[{};:,()>+~*]/y },
  ],
  json: [
    { type: 'prop', re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y },
    { type: 'str', re: /"(?:[^"\\]|\\.)*"?/y },
    { type: 'num', re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: 'lit', re: /\b(?:true|false|null)\b/y },
    { type: 'punct', re: /[{}[\],:]/y },
  ],
  md: [
    { type: 'com', re: /^```[\s\S]*?(?:^```|$)/my },
    { type: 'head', re: /^#{1,6} [^\n]*/my },
    { type: 'str', re: /`[^`\n]+`/y },
    { type: 'kw', re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y },
    { type: 'lit', re: /^\s*(?:[-*+]|\d+\.) /my },
    { type: 'link', re: /\[[^\]\n]*\]\([^)\n]*\)/y },
    { type: 'tag', re: /^>[^\n]*/my },
  ],
};

const EXT_TO_LANG: Record<string, Lang> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'js', tsx: 'js', mts: 'js',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md',
};

export function langFromPath(path: string): Lang {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'text';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Returns HTML. The input is file content, so every character that is not
 * turned into a tag here is escaped first — this output goes into innerHTML.
 */
export function highlight(code: string, lang: Lang): string {
  if (lang === 'text' || code.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(code);

  const rules = RULES[lang];
  let out = '';
  let plain = '';
  let i = 0;

  while (i < code.length) {
    let matched = false;

    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (!m || !m[0]) continue;

      if (plain) {
        out += escapeHtml(plain);
        plain = '';
      }
      out += `<span class="t-${rule.type}">${escapeHtml(m[0])}</span>`;
      i += m[0].length;
      matched = true;
      break;
    }

    if (!matched) {
      plain += code[i];
      i++;
    }
  }

  return out + escapeHtml(plain);
}
