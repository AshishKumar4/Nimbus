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

// What a config names by a string, the tool loads by name. Vite loads
// postcss.config.js's plugins with createRequire(config).resolve(name), and a
// Tailwind v3 app's dev server missed node_modules/tailwindcss/lib/index.js on
// the launch after its first. Names that resolve to no installed package, and
// a config of a tool the launch does not run, stage nothing.
{
  const named = {
    ...files,
    [`${APP}/postcss.config.js`]: "export default { plugins: { tailwindcss: {}, '@scope/fmt': {}, plugins: 1 }, parser: 'not-installed' };\n",
    [`${APP}/eslint.config.js`]: "export default { plugins: ['eslint-plugin-big'] };\n",
    [`${NM}/tailwindcss/package.json`]: JSON.stringify({ name: 'tailwindcss', main: 'lib/index.js' }),
    [`${NM}/tailwindcss/lib/index.js`]: "module.exports = require('./plugin.js');\n",
    [`${NM}/tailwindcss/lib/plugin.js`]: 'module.exports = () => ({});\n',
    [`${NM}/@scope/fmt/package.json`]: JSON.stringify({ name: '@scope/fmt', exports: { require: './fmt.cjs', import: './fmt.mjs' } }),
    [`${NM}/@scope/fmt/fmt.cjs`]: 'module.exports = 1;\n',
    [`${NM}/@scope/fmt/fmt.mjs`]: 'export default 1;\n',
  };
  const state = await buildPrefetchBundle(launchFs(named).fs, {
    scriptPath: `/${VITE}/bin/vite.js`, cwd: `/${APP}`, entryCode: named[`${VITE}/bin/vite.js`],
  });
  for (const path of [`${NM}/tailwindcss/lib/index.js`, `${NM}/tailwindcss/lib/plugin.js`, `${NM}/@scope/fmt/fmt.cjs`]) {
    assert.ok(state.bundle[path] !== undefined, `a package postcss.config.js names is in the map, as require resolves it: ${path}`);
  }
  assert.equal(state.bundle[`${NM}/@scope/fmt/fmt.mjs`], undefined, 'resolved as the config\'s require resolves it');
  assert.equal(state.bundle[`${NM}/eslint-plugin-big/index.js`], undefined, 'a config of a tool this launch does not run names nothing');
}

// A config the tool may never read is no mandatory part of the launch: a
// `vite --version` whose vite.config.ts imports a graph past the map's bound
// still launches. The config's graph is staged within the bound, evictable,
// ahead of every other optional subtree.
{
  const heavy = {
    ...files,
    [`${APP}/vite.config.ts`]: "import big from 'big'\nexport default { plugins: [big()] }\n",
    [`${NM}/big/package.json`]: JSON.stringify({ name: 'big', main: 'index.js' }),
    [`${NM}/big/index.js`]: `module.exports = () => ${JSON.stringify('x'.repeat(64 * 1024))};\n`,
  };
  const bound = 32 * 1024;
  const state = await buildPrefetchBundle(launchFs(heavy).fs, {
    scriptPath: `/${VITE}/bin/vite.js`, cwd: `/${APP}`, entryCode: heavy[`${VITE}/bin/vite.js`], maxBundleBytes: bound,
  });
  assert.ok(state.bundle[`${VITE}/dist/cli.js`] !== undefined, "the tool's own closure launches");
  assert.equal(state.bundle[`${NM}/big/index.js`], undefined, 'the part of the config graph past the bound is left out, not refused');
  assert.ok(state.bundle[`${APP}/vite.config.ts`] !== undefined, 'what fits is staged');
}

// A plugin a config names resolves as the config's require resolves it, and
// the package.json files that resolution reads are staged with it: the
// process repeats it from them.
{
  const nested = {
    ...files,
    [`${APP}/postcss.config.js`]: "export default { plugins: { 'deep-plugin': {} } };\n",
    [`${NM}/deep-plugin/package.json`]: JSON.stringify({ name: 'deep-plugin', main: 'lib' }),
    [`${NM}/deep-plugin/lib/package.json`]: JSON.stringify({ main: 'actual.cjs' }),
    [`${NM}/deep-plugin/lib/actual.cjs`]: 'module.exports = () => ({});\n',
  };
  const state = await buildPrefetchBundle(launchFs(nested).fs, {
    scriptPath: `/${VITE}/bin/vite.js`, cwd: `/${APP}`, entryCode: nested[`${VITE}/bin/vite.js`],
  });
  assert.ok(state.bundle[`${NM}/deep-plugin/lib/actual.cjs`] !== undefined, 'the plugin is staged');
  assert.ok(state.bundle[`${NM}/deep-plugin/lib/package.json`] !== undefined, 'with the nested package.json its resolution read');
}

console.log('facet-bundle-tool-config: ok');
