#!/usr/bin/env bun

import { parseViteConfigSource, unhandledVitePlugins, viteBuildBlockingPlugins } from '../../packages/core/src/runtime/vite-config-parser.ts';
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
  // plugin it cannot run. Build refuses; dev only warns (it still serves).
  const config = parseViteConfigSource(`
    import { sveltekit } from '@sveltejs/kit/vite';
    import { defineConfig } from 'vite';

    export default defineConfig({
      plugins: [sveltekit()]
    });
  `);
  assert.deepEqual(config.plugins, ['@sveltejs/kit/vite']);
  assert.deepEqual(viteBuildBlockingPlugins(config), ['@sveltejs/kit/vite']);
  assert.deepEqual(unhandledVitePlugins(config), []);
}

{
  // The canonical create-vite react template: @vitejs/plugin-react is
  // inert for the built-in server (JSX is compiled natively) — neither
  // gate fires.
  const config = parseViteConfigSource(`
    import { defineConfig } from 'vite'
    import react from '@vitejs/plugin-react'

    export default defineConfig({
      plugins: [react()],
    })
  `);
  assert.deepEqual(config.plugins, ['@vitejs/plugin-react']);
  assert.deepEqual(viteBuildBlockingPlugins(config), []);
  assert.deepEqual(unhandledVitePlugins(config), []);
}

{
  // Markflow's real vite.config.ts shape — react + @cloudflare/vite-plugin
  // + two local plugin factories. The known-handled plugins produce no
  // refusal and no warning; the local plugins warn but never block, so
  // neither dev nor build refuses the project.
  const config = parseViteConfigSource(`
    import { defineConfig, loadEnv } from 'vite';
    import react from '@vitejs/plugin-react';
    import { cloudflare } from '@cloudflare/vite-plugin';

    function watchDependenciesPlugin() { return { name: 'watch-dependencies' }; }
    function reloadTriggerPlugin() { return { name: 'reload-trigger' }; }

    export default ({ mode }) => defineConfig({
      plugins: [react(), cloudflare(), watchDependenciesPlugin(), reloadTriggerPlugin()],
    });
  `);
  assert.deepEqual(config.plugins, [
    '@vitejs/plugin-react',
    '@cloudflare/vite-plugin',
    "local plugin 'watchDependenciesPlugin'",
    "local plugin 'reloadTriggerPlugin'",
  ]);
  assert.deepEqual(viteBuildBlockingPlugins(config), [], 'markflow must never be refused a build');
  assert.deepEqual(
    unhandledVitePlugins(config),
    ["local plugin 'watchDependenciesPlugin'", "local plugin 'reloadTriggerPlugin'"],
    'local plugins warn only',
  );
}

{
  // Tailwind v4's vite plugin is covered by the dev server's Tailwind
  // pipeline — no refusal, no warning.
  const config = parseViteConfigSource(`
    import tailwindcss from '@tailwindcss/vite';
    export default { plugins: [tailwindcss()] };
  `);
  assert.deepEqual(viteBuildBlockingPlugins(config), []);
  assert.deepEqual(unhandledVitePlugins(config), []);
}

{
  // An arbitrary third-party plugin: build does NOT refuse (warning only),
  // dev warns. Only framework plugins block the build.
  const config = parseViteConfigSource(`
    import legacy from '@vitejs/plugin-legacy';
    import vue from '@vitejs/plugin-vue';
    export default defineConfig({ plugins: [legacy({ targets: ['defaults'] }), vue()] });
  `);
  assert.deepEqual(viteBuildBlockingPlugins(config), ['@vitejs/plugin-vue']);
  assert.deepEqual(unhandledVitePlugins(config), ['@vitejs/plugin-legacy']);
}

{
  // No plugins at all — nothing to refuse or warn about.
  const config = parseViteConfigSource(`export default { server: { port: 5173 } };`);
  assert.equal(config.plugins, undefined);
  assert.deepEqual(viteBuildBlockingPlugins(config), []);
  assert.deepEqual(unhandledVitePlugins(config), []);
}

console.log('vite-config-parser: ok');
