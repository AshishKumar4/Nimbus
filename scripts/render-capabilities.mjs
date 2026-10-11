import { readFileSync, writeFileSync } from 'node:fs';
import capabilities from '../apps/docs/src/data/capabilities.json' with { type: 'json' };

const path = new URL('../README.md', import.meta.url);
const start = '<!-- capabilities:start -->';
const end = '<!-- capabilities:end -->';
/** @type {Record<string, string>} */
const labels = { works: '✅', alpha: 'Alpha', no: '⛔' };
/** @param {string} value */
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;');
const table = ['| Capability | Status |', '|---|:---:|', ...capabilities.map((row) => {
  if (!labels[row.status]) throw new Error(`Unknown capability status: ${row.status}`);
  return `| ${escape(row.description)} | ${labels[row.status]} |`;
})].join('\n');
const source = readFileSync(path, 'utf8');
const from = source.indexOf(start);
const to = source.indexOf(end, from);
if (from < 0 || to < 0) throw new Error('README capability projection markers are missing');
const rendered = source.slice(0, from) + `${start}\n${table}\n${end}` + source.slice(to + end.length);
if (process.argv.includes('--check')) {
  if (rendered !== source) throw new Error('Regenerate the README capability table with bun scripts/render-capabilities.mjs');
} else if (rendered !== source) writeFileSync(path, rendered);
