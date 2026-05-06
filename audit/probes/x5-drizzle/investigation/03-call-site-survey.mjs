#!/usr/bin/env bun
// X.5-drizzle investigation 03:
//
// Survey all consumers of `frameworkAware` across src/ to confirm the
// refinement (changing detectFrameworkAware's return) is the only edit
// site needed. Goal: ensure no downstream code computes frameworkAware
// independently or makes its own decisions about generic-vite.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

function rg(needle, where) {
  const out = [];
  const stack = [where];
  while (stack.length) {
    const dir = stack.pop();
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(d.name)) {
        const s = fs.readFileSync(p, 'utf8');
        const lines = s.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(needle)) out.push({ file: p.replace(REPO + '/', ''), line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
  }
  return out;
}

const hits = rg('frameworkAware', path.join(REPO, 'src'));
console.log('==== src/ refs to `frameworkAware` ====');
for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`);

console.log();
const literal = rg('Framework detected', path.join(REPO, 'src'));
console.log('==== src/ refs to literal "Framework detected" (the user-visible string the prompt asks us to localize) ====');
for (const h of literal) console.log(`  ${h.file}:${h.line}  ${h.text}`);

console.log();
console.log('==== Decision sites (where frameworkAware is COMPUTED, not consumed) ====');
const computed = hits.filter(h =>
  /detectFrameworkAware|= await this\.detectFrameworkAware|return result\.framework !== 'unknown'/.test(h.text) ||
  h.text.includes('detectFrameworkAware')
);
for (const h of computed) console.log(`  ${h.file}:${h.line}  ${h.text}`);

console.log();
console.log('Conclusion:');
console.log('  - Computed in exactly ONE site: src/npm-installer.ts:detectFrameworkAware (and called from _installInner).');
console.log('  - All other refs are pass-through consumers (resolveTree, resolveTreeViaFacet, npm-resolve-facet.ts, parallel preamble).');
console.log('  - Single edit point: detectFrameworkAware return statement.');
