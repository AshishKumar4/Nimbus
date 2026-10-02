#!/usr/bin/env bun
// `vite` reads a vite.config.ts without a transform when erasing its types
// cannot change what the config reader sees (parseViteConfigTypeScript). On a
// fresh session that transform is the session's first, and it starts the
// transform facet before the dev server serves anything.
//
// The property: for every config, the fast path gives exactly what the reader
// gives on the transform's TypeScript output, and it skips the transform for
// plain configs. Each case below is read both ways with the engine the
// transform facet runs (lib/oxc-engine.mjs).

import assert from 'node:assert/strict';
import { oxcEngine } from './lib/oxc-engine.mjs';
import { SEED_FILES } from '../../packages/core/src/vfs/seed-project.ts';
import {
  parseViteConfigSource,
  parseViteConfigTypeScript,
} from '../../packages/core/src/runtime/vite-config-parser.ts';

const erase = async (source) => (await oxcEngine.transform(source, { loader: 'ts', format: 'esm' })).code;

const seeded = SEED_FILES.find((file) => file.path.endsWith('/vite.config.ts'));
assert.ok(seeded, 'the seeded project has a vite.config.ts');

const cases = [
  // [name, source, whether the transform must run]
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
  ['defineConfig(({ mode }) => ({...})) with new URL(import.meta.url)', `
    import { defineConfig } from 'vite';
    import { fileURLToPath } from 'node:url';
    export default defineConfig(({ mode }) => {
      return { base: '/m/', resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } } };
    });`, false],
  ['template literal without substitutions', `
    export default { base: \`/plain/\` };`, false],
  // Generics that parse as JavaScript shifts and comparisons.
  ['nested generic defineConfig', `
    import { defineConfig } from 'vite';
    export default defineConfig<Partial<UserConfig>>({ base: '/g/', server: { port: 5180 } });`, true],
  ['nested generic plugin call', `
    import { sveltekit } from '@sveltejs/kit/vite';
    export default { plugins: [sveltekit<Record<string, string>>({})] };`, true],
  // Shapes a transform may fold (esbuild did).
  ['string concatenation', `export default { base: '/app' + '/' };`, true],
  ['logical not', `export default { nimbusInjectBasename: !0 };`, true],
  ['unary plus', `export default { server: { port: +"5173" } };`, true],
  ['nullish-or', `export default { root: null || './web' };`, true],
  ['false && plugin', `
    import react from '@vitejs/plugin-react';
    export default { plugins: [false && react()] };`, true],
  ['conditional', `export default { server: { port: true ? 5174 : 5175 } };`, true],
  ['template literal with a substitution', `export default { base: \`/\${'app'}/\` };`, true],
  ['computed key', `export default { ['base']: '/k/' };`, true],
];

for (const [name, source, needsTransform] of cases) {
  let erased = 0;
  const fast = await parseViteConfigTypeScript(source, async (text) => { erased++; return erase(text); });
  const viaTransform = parseViteConfigSource(await erase(source));
  assert.deepEqual(fast, viaTransform, `${name}: the reader sees what the transform's output gives it`);
  assert.equal(erased, needsTransform ? 1 : 0, `${name}: the transform ${needsTransform ? 'runs' : 'is skipped'}`);
  console.log(`  ok  ${name}: ${needsTransform ? 'transform' : 'read directly'}`);
}

console.log('vite-config-typescript-fast-path OK');
