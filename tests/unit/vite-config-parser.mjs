#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { parseViteConfigSource } from '../../packages/worker/src/runtime/vite-config-parser.ts';

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

console.log('vite-config-parser: ok');
