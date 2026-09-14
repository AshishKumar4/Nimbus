#!/usr/bin/env bun

import { parseViteConfigSource, unsupportedVitePlugins } from '../../packages/core/src/runtime/vite-config-parser.ts';
import assert from 'node:assert/strict';

{
  const config = parseViteConfigSource(`
    import react from '@vitejs/plugin-react';
    import { defineConfig } from 'vite';
    import path from 'node:path';

    export default defineConfig({
      root: './web',
      base: '/app/',
      nimbusInjectBasename: false,
      nimbusDevServer: 'auto',
      server: { port: 5174 },
      preview: { port: 4174 },
      build: { outDir: 'public' },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
          components: './src/components'
        }
      },
      define: {
        global: 'globalThis',
        'process.env.NODE_ENV': JSON.stringify('production'),
        __DEV__: false
      }
    });
  `);

  assert.equal(config.root, './web');
  assert.equal(config.base, '/app/');
  assert.equal(config.injectBasename, false);
  assert.equal(config.devServer, 'auto');
  assert.equal(config.importsVitePlugin, true);
  assert.equal(config.port, 5174);
  assert.equal(config.outDir, 'public');
  assert.deepEqual(config.alias, { '@': './src', components: './src/components' });
  assert.deepEqual(config.define, {
    global: 'globalThis',
    'process.env.NODE_ENV': '"production"',
    __DEV__: 'false',
  });
}

{
  const config = parseViteConfigSource(`
    const cfg = {
      resolve: {
        alias: [
          { find: '~', replacement: './lib' },
          { find: 'styles', replacement: resolve(__dirname, './styles') }
        ]
      },
      preview: { port: 5000 }
    };
    export { cfg as default };
  `);

  assert.equal(config.port, 5000);
  assert.deepEqual(config.alias, { '~': './lib', styles: './styles' });
}

{
  const config = parseViteConfigSource(`
    module.exports = {
      port: 3000,
      outDir: 'dist',
      nimbusDevServer: 'real'
    };
  `);

  assert.equal(config.port, 3000);
  assert.equal(config.outDir, 'dist');
  assert.equal(config.devServer, 'real');
}

{
  const config = parseViteConfigSource(`
    var stdin_default = ({ mode }) => {
      const env = loadEnv(mode, process.cwd());
      return defineConfig({
        server: { port: 3000 },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./src"),
            "@shared": path.resolve(__dirname, "./shared")
          }
        },
        define: { global: "globalThis" }
      });
    };
    export { stdin_default as default };
  `);

  assert.equal(config.port, 3000);
  assert.deepEqual(config.alias, { '@': './src', '@shared': './shared' });
  assert.deepEqual(config.define, { global: 'globalThis' });
}

{
  // SvelteKit's scaffold — the G4-sibling failure: the built-in builder
  // assumed a react entry and died inside esbuild instead of reporting the
  // plugin it cannot run.
  const config = parseViteConfigSource(`
    import { sveltekit } from '@sveltejs/kit/vite';
    import { defineConfig } from 'vite';

    export default defineConfig({
      plugins: [sveltekit()]
    });
  `);
  assert.deepEqual(config.plugins, ['@sveltejs/kit/vite']);
  assert.deepEqual(unsupportedVitePlugins(config), ['@sveltejs/kit/vite']);
}

{
  // The canonical create-vite react template: @vitejs/plugin-react is
  // inert for the built-in server (JSX is compiled natively), so it must
  // not trip the diagnostic.
  const config = parseViteConfigSource(`
    import { defineConfig } from 'vite'
    import react from '@vitejs/plugin-react'

    export default defineConfig({
      plugins: [react()],
    })
  `);
  assert.deepEqual(config.plugins, ['@vitejs/plugin-react']);
  assert.deepEqual(unsupportedVitePlugins(config), []);
}

{
  // Mixed: a supported plugin plus unsupported ones reports only the
  // unsupported specifiers; inline/local plugins are named too.
  const config = parseViteConfigSource(`
    import vue from '@vitejs/plugin-vue';
    import react from '@vitejs/plugin-react';
    import legacy from '@vitejs/plugin-legacy';
    export default defineConfig({
      plugins: [react(), vue(), legacy({ targets: ['defaults'] }), { name: 'mine', transform() {} }]
    });
  `);
  assert.deepEqual(
    unsupportedVitePlugins(config),
    ['@vitejs/plugin-vue', '@vitejs/plugin-legacy', "inline plugin 'mine'"],
  );
}

{
  // No plugins at all — nothing unsupported.
  const config = parseViteConfigSource(`export default { server: { port: 5173 } };`);
  assert.equal(config.plugins, undefined);
  assert.deepEqual(unsupportedVitePlugins(config), []);
}

console.log('vite-config-parser: ok');
