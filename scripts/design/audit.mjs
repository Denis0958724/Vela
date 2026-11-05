/**
 * Static design audit for styles.css.
 *
 *   node scripts/design/audit.mjs
 *
 * Checks the things a screenshot would not prove anyway: every var() has a
 * definition, text contrast meets WCAG AA on the surfaces it is used on, and
 * no rule animates a layout property (the usual source of jank).
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');

/** Last definition wins, which is exactly how the cascade resolves the skin. */
function themeBlock(selector) {
  const marker = `${selector} {`;
  let at = css.lastIndexOf(marker);
  if (at < 0) return {};
  at += marker.length;
  let depth = 1;
  let i = at;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  const body = css.slice(at, i - 1);
  const vars = {};
  for (const line of body.split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

const themes = {
  Кріо: themeBlock(':root, :root[data-theme="indigo"]'),
  Папір: themeBlock(':root[data-theme="light"]'),
  Ніч: themeBlock(':root[data-theme="dark"]'),
};

/* ── 1. every var() must resolve ─────────────────────────────────────── */

const used = new Set();
for (const m of css.matchAll(/var\((--[a-z0-9-]+)/gi)) used.add(m[1]);

const defined = new Set(Object.keys(themes.Кріо));
// @property and JS-set variables are declared outside :root on purpose.
for (const m of css.matchAll(/@property\s+(--[a-z0-9-]+)/gi)) defined.add(m[1]);
for (const js of ['--left-w', '--right-w', '--composer-space']) defined.add(js);
const missing = [...used].filter(name => !defined.has(name));
console.log(`\n[1] design tokens`);
console.log(`    var() references : ${used.size}`);
console.log(`    defined in :root : ${defined.size}`);
console.log(`    unresolved       : ${missing.length ? missing.join(', ') : 'none'}`);

/* ── 2. contrast ─────────────────────────────────────────────────────── */

function hex(value) {
  const v = value.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const f = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const a = hex(fg);
  const b = hex(bg);
  if (!a || !b) return null;
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const pairs = [
  ['text / bg', '--text', '--bg', 4.5],
  ['text / surface', '--text', '--surface', 4.5],
  ['dim / surface', '--text-dim', '--surface', 4.5],
  ['faint / surface', '--text-faint', '--surface', 4.5],
  ['faint / bg', '--text-faint', '--bg', 4.5],
  ['accent / surface', '--accent', '--surface', 3.0],
  ['accent-fg / accent', '--accent-fg', '--accent', 4.5],
  ['text / user bubble', '--text', '--user-bg', 4.5],
];

console.log(`\n[2] contrast (WCAG AA)`);
let worst = 99;
for (const [label, fgVar, bgVar, need] of pairs) {
  const row = [];
  for (const [name, vars] of Object.entries(themes)) {
    const value = ratio(vars[fgVar], vars[bgVar]);
    if (value === null) { row.push(`${name}: n/a`); continue; }
    worst = Math.min(worst, value / need);
    const mark = value >= need ? 'ok' : 'LOW';
    row.push(`${name} ${value.toFixed(2)} ${mark}`);
  }
  console.log(`    ${label.padEnd(20)} ${row.join('   ')}`);
}
console.log(`    tightest margin: ${(worst * 100).toFixed(0)}% of the AA threshold`);

/* ── 3. motion cost ──────────────────────────────────────────────────── */

const expensive = [];
for (const m of css.matchAll(/transition:\s*([^;]+);/gi)) {
  const value = m[1];
  if (/\ball\b/.test(value)) expensive.push(`transition: all`);
  if (/\b(width|height|top|left|right|bottom|margin|padding|font-size|letter-spacing)\b/.test(value)) {
    expensive.push(`layout property in: ${value.trim().slice(0, 70)}`);
  }
}

const animated = new Set();
for (const m of css.matchAll(/animation:\s*([a-z0-9-]+)/gi)) animated.add(m[1]);
for (const m of css.matchAll(/@keyframes\s+([a-z0-9-]+)\s*\{([\s\S]*?)\n\}/gi)) {
  const body = m[2];
  const props = new Set([...body.matchAll(/([a-z-]+)\s*:/gi)].map(x => x[1].toLowerCase()));
  const bad = [...props].filter(p => ['width', 'height', 'top', 'left', 'margin', 'padding'].includes(p));
  if (bad.length) expensive.push(`@keyframes ${m[1]} animates ${bad.join(', ')}`);
}

const reduced = /prefers-reduced-motion/.test(css);
console.log(`\n[3] motion`);
console.log(`    transitions on layout props : ${expensive.length ? expensive.join(' | ') : 'none'}`);
console.log(`    keyframes                   : ${[...animated].join(', ') || 'none'}`);
console.log(`    prefers-reduced-motion      : ${reduced ? 'handled' : 'MISSING'}`);

/* ── 4. leftovers from the old skins ─────────────────────────────────── */

function violets(text) {
  const hits = new Set();
  for (const m of text.matchAll(/#([0-9a-f]{6})/gi)) {
    const h = m[1].toLowerCase();
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    // Blue-violet: blue leads green, and red is not far behind.
    if (b > g + 20 && b > r && r > g - 30) hits.add(`#${h}`);
  }
  return hits;
}

const skinStart = css.lastIndexOf('/* ====');
const activeViolet = violets(css.slice(skinStart));
const legacyViolet = violets(css.slice(0, skinStart));
console.log(`\n[4] palette`);
console.log(`    violet in the active skin : ${activeViolet.size ? [...activeViolet].join(' ') : 'none'}`);
console.log(`    violet in superseded base : ${legacyViolet.size} (overridden, kept for rollback)`);

const ok = missing.length === 0 && worst >= 1 && expensive.length === 0 && reduced && activeViolet.size === 0;
console.log(`\n${ok ? 'PASS' : 'REVIEW'} — ${ok ? 'tokens, contrast, motion and palette all within budget' : 'see items above'}\n`);
