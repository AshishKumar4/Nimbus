#!/usr/bin/env bun
// A tool's config file is code the tool executes: its imports join the
// launch's module map on the first run.
//
// Vite bundles vite.config.ts and imports the result, which imports the
// project's plugins. Nothing in Vite's own graph names them, so the first
// run of `vite` missed @vitejs/plugin-react's dependencies (ms, read through
// Babel's debug) and only the next run had them. A config is the launched
// tool's when it is named for the launched package or a package that one
// depends on; a config of a tool the launch does not run stays out.
import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const VITE = `${NM}/vite`;
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', devDependencies: { vite: '8', '@vitejs/plugin-react': '5', eslint: '9' } }),
  [`${APP}/vite.config.ts`]: "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n",
  [`${APP}/postcss.config.js`]: "import autoprefixer from 'autoprefixer'\nexport default { plugins: [autoprefixer()] }\n",
  [`${APP}/eslint.config.js`]: "import plugin from 'eslint-plugin-big'\nexport default [plugin]\n",
  [`${VITE}/package.json`]: JSON.stringify({ name: 'vite', version: '8.0.0', bin: { vite: 'bin/vite.js' }, dependencies: { postcss: '8' } }),
  [`${VITE}/bin/vite.js`]: "import '../dist/cli.js'\n",
  [`${VITE}/dist/cli.js`]: 'export const cli = 1;\n',
  [`${NM}/@vitejs/plugin-react/package.json`]: JSON.stringify({ name: '@vitejs/plugin-react', main: 'index.js' }),
  [`${NM}/@vitejs/plugin-react/index.js`]: "module.exports = require('debug');\n",
  [`${NM}/debug/package.json`]: JSON.stringify({ name: 'debug', main: 'index.js' }),
  [`${NM}/debug/index.js`]: "module.exports = require('ms');\n",
  [`${NM}/ms/package.json`]: JSON.stringify({ name: 'ms', main: 'index.js' }),
  [`${NM}/ms/index.js`]: 'module.exports = () => 0;\n',
  [`${NM}/autoprefixer/package.json`]: JSON.stringify({ name: 'autoprefixer', main: 'index.js' }),
  [`${NM}/autoprefixer/index.js`]: 'module.exports = () => ({});\n',
  [`${NM}/postcss/package.json`]: JSON.stringify({ name: 'postcss', main: 'index.js' }),
  [`${NM}/postcss/index.js`]: 'module.exports = {};\n',
  [`${NM}/eslint-plugin-big/package.json`]: JSON.stringify({ name: 'eslint-plugin-big', main: 'index.js' }),
  [`${NM}/eslint-plugin-big/index.js`]: 'module.exports = {};\n',
};

const state = await buildPrefetchBundle(launchFs(files).fs, {
  scriptPath: `/${VITE}/bin/vite.js`, cwd: `/${APP}`, entryCode: files[`${VITE}/bin/vite.js`],
});
for (const path of [`${APP}/vite.config.ts`, `${NM}/@vitejs/plugin-react/index.js`, `${NM}/debug/index.js`, `${NM}/ms/index.js`]) {
  assert.ok(state.bundle[path] !== undefined, `vite.config.ts's graph is in the map: ${path}`);
}
assert.ok(state.bundle[`${NM}/autoprefixer/index.js`] !== undefined, 'the config of a tool vite depends on (PostCSS) is too');
assert.equal(state.bundle[`${NM}/eslint-plugin-big/index.js`], undefined, 'a config of a tool this launch does not run is not');

// Launched by its node_modules/.bin link, as `./node_modules/.bin/vite` is.
{
  const linked = launchFs(files);
  await linked.fs.mkdir(`/${NM}/.bin`, { recursive: true });
  await linked.fs.symlink('../vite/bin/vite.js', `/${NM}/.bin/vite`);
  const viaBin = await buildPrefetchBundle(linked.fs, {
    scriptPath: `/${NM}/.bin/vite`, cwd: `/${APP}`, entryCode: files[`${VITE}/bin/vite.js`],
  });
  assert.ok(viaBin.bundle[`${NM}/ms/index.js`] !== undefined, 'a bin launched by its .bin link roots its config');
}

// A program that is not a package's bin roots no config.
const script = await buildPrefetchBundle(launchFs(files).fs, {
  scriptPath: `/${APP}/index.js`, cwd: `/${APP}`, entryCode: 'console.log(1)\n',
});
assert.equal(script.bundle[`${NM}/ms/index.js`], undefined, 'a plain script roots no tool config');

console.log('facet-bundle-tool-config: ok');
