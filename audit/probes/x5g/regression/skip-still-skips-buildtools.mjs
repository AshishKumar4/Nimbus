#!/usr/bin/env bun
// X5G regression: typescript / vite / etc. as TRANSITIVE deps are
// still silent-skipped per W6+W11. X5G's changes affect optionalDeps
// path, NOT the SKIP_PACKAGES list.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER = path.join(HERE, '../../../../src/npm/resolver.ts');
const src = fs.readFileSync(RESOLVER, 'utf8');

group('SKIP_PACKAGES still contains the expected build-tools', () => {
  // X.5-G: rollup MIGRATED to WASM_SWAPS — see X5G-plan.md §6.1 + W6
  // no-conflict-with-skip rule. SKIP would mask the swap at depth>0.
  for (const name of ['typescript', 'vite', 'webpack', 'parcel',
                      'postcss', 'autoprefixer', 'tailwindcss',
                      'prettier', 'eslint', 'stylelint',
                      'chokidar', 'node-gyp', 'node-pre-gyp']) {
    ok(`SKIP_PACKAGES contains '${name}'`,
      new RegExp(`'${name}'`).test(src));
  }
});

group('X5G: rollup MOVED from SKIP_PACKAGES to WASM_SWAPS', () => {
  // The SKIP_PACKAGES list block; rollup must NOT appear in it.
  const skipBlock = src.match(/const SKIP_PACKAGES\s*=\s*new Set\(\[[\s\S]+?\]\);/);
  ok('SKIP_PACKAGES block found', !!skipBlock);
  if (skipBlock) {
    ok("'rollup' NOT in SKIP_PACKAGES", !/'rollup'/.test(skipBlock[0]));
  }
});

group('SKIP_PREFIXES untouched', () => {
  for (const prefix of ['@types/', '@eslint/', '@typescript-eslint/']) {
    ok(`SKIP_PREFIXES contains '${prefix}'`,
      new RegExp(`'${prefix.replace(/\//g, '\\/')}'`).test(src));
  }
});

summary('skip-still-skips-buildtools');
