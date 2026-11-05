/**
 * Catch dead selectors: every class used by the skin must exist in the markup
 * or be created by the renderer, otherwise the rule silently does nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const skin = css.slice(css.lastIndexOf('/* ===='));

let haystack = '';
for (const file of readdirSync('src/renderer')) {
  if (/\.(ts|html|css)$/.test(file)) haystack += readFileSync(`src/renderer/${file}`, 'utf8');
}

const classes = new Set();
for (const m of skin.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) classes.add(m[1]);

/** Generated from a template literal such as `t-${rule.type}`. */
const dynamic = [/^t-/];

const missing = [...classes].filter(name => {
  if (dynamic.some(re => re.test(name))) return false;
  return !new RegExp(`\\b${name}\\b`).test(haystack);
});

console.log(`skin classes: ${classes.size}`);
console.log(`not found in markup or renderer: ${missing.length ? missing.join(', ') : 'none'}`);
process.exit(missing.length ? 1 : 0);
