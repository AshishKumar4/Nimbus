#!/usr/bin/env bun
// A Nimbus npm bin is a small require() shim, not a POSIX symlink. Looking
// only at realpath(.bin/tool) therefore mistakes .bin for the tool package
// and loses the configs (and Wasm modules) the tool will load at startup.
import assert from 'node:assert/strict';
import { toolConfigRoots } from '../../packages/worker/src/facets/manager.ts';
import { createNpmBinManifest, createNpmBinShim, NPM_BIN_MANIFEST_NAME } from '../../packages/worker/src/npm/bin-links.ts';
import { launchFs } from './lib/launch-fs.mjs';

const cwd = '/home/user/app';
const nm = 'home/user/app/node_modules';
const entry = {
  name: 'dev-tool',
  packageName: '@tools/dev',
  packageVersion: '1.0.0',
  packagePath: `${nm}/@tools/dev`,
  targetPath: `${nm}/@tools/dev/bin.cjs`,
};
const files = {
  [`${nm}/@tools/dev/package.json`]: JSON.stringify({ name: '@tools/dev', version: '1.0.0', bin: { 'dev-tool': 'bin.cjs' }, dependencies: { vite: '*' } }),
  [`${nm}/@tools/dev/bin.cjs`]: 'console.log("tool");',
  [`${nm}/.bin/dev-tool`]: createNpmBinShim(entry, `${nm}/.bin`),
  [`${nm}/.bin/${NPM_BIN_MANIFEST_NAME}`]: JSON.stringify(createNpmBinManifest([entry])),
  'home/user/app/vite.config.js': 'module.exports = {};',
  'home/user/app/eslint.config.js': 'module.exports = {};',
};
const vfs = launchFs(files).fs;
const direct = await toolConfigRoots(vfs, cwd, `${nm}/@tools/dev/bin.cjs`);
assert.deepEqual(direct, [{ path: 'home/user/app/vite.config.js', config: true }]);
const shim = await toolConfigRoots(vfs, cwd, `${nm}/.bin/dev-tool`);
assert.deepEqual(shim, direct, 'node .bin/tool must plan the same tool configuration as its package target');
console.log('tool-config-roots-npm-shim: ok');
