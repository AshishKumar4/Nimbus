#!/usr/bin/env bun
// `vite` reads a vite.config.ts without esbuild when erasing its types cannot
// change what the config reader sees (parseViteConfigTypeScript). On a fresh
// session that transform is the first esbuild use, and it starts the esbuild
// facet (about a second) before the dev server serves anything.
//
// The property: for every config, the fast path gives exactly what the reader
// gives on esbuild's own TypeScript output, and it skips esbuild for plain
// configs. Each case below is read both ways with the real esbuild.

import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { SEED_FILES } from '../../packages/core/src/vfs/seed-project.ts';
import {
  parseViteConfigSource,
  parseViteConfigTypeScript,
} from '../../packages/core/src/runtime/vite-config-parser.ts';

const erase = async (source) => (await transform(source, { loader: 'ts', format: 'esm' })).code;

const seeded = SEED_FILES.find((file) => file.path.endsWith('/vite.config.ts'));
assert.ok(seeded, 'the seeded project has a vite.config.ts');

const cases = [
  // [name, source, whether esbuild must run]
  ['seeded starter config', seeded.content, false],
  ['plain config with plugins, alias, define', `
    import react from '@vitejs/plugin-react';
    import { defineConfig } from 'vite';
    import path from 'node:path';
    export default defineConfig({
      base: '/app/',
      plugins: [react()],
      server: { port: 5174 },
      resolve: { alias: { '@': path.resolve(__dirname, './src') } },
      define: { __DEV__: false, 'process.env.NODE_ENV': JSON.stringify('production') },
    });`, false],
  ['type annotation', `
    import { defineConfig, type UserConfig } from 'vite';
    const config: UserConfig = { server: { port: 3000 } };
    export default defineConfig(config);`, true],
  ['satisfies', `
    import type { UserConfig } from 'vite';
    export default { base: '/x/', server: { port: 4000 } } satisfies UserConfig;`, true],
  ['generic plugin call (TypeScript reads a call, JavaScript a comparison)', `
    import react from '@vitejs/plugin-react';
    import { sveltekit } from '@sveltejs/kit/vite';
    export default { plugins: [sveltekit<Options>({}), react()] };`, true],
  ['imported plugin never used (TypeScript drops the import)', `
    import react from '@vitejs/plugin-react';
    export default { server: { port: 5173 } };`, true],
  ['import name shadowed by a declaration', `
    import react from '@vitejs/plugin-react';
    const make = (react) => ({ plugins: [react] });
    export default { base: '/y/' };`, true],
  ['side-effect import only', `
    import './setup';
    export default { root: './web' };`, false],
];

for (const [name, source, needsEsbuild] of cases) {
  let erased = 0;
  const fast = await parseViteConfigTypeScript(source, async (text) => { erased++; return erase(text); });
  const viaEsbuild = parseViteConfigSource(await erase(source));
  assert.deepEqual(fast, viaEsbuild, `${name}: the reader sees what esbuild's output gives it`);
  assert.equal(erased, needsEsbuild ? 1 : 0, `${name}: esbuild ${needsEsbuild ? 'runs' : 'is skipped'}`);
  console.log(`  ok  ${name}: ${needsEsbuild ? 'esbuild' : 'read directly'}`);
}

console.log('vite-config-typescript-fast-path OK');
