#!/usr/bin/env bun
// What a module's require wrappers load answers the text the walk read, and
// only it: a launch reuses the answer for text it has read before (wherever,
// whatever its path's revision says), and text that changed is read anew,
// even where the filesystem's revision did not move with it (a write between
// the read and the revision, or a mount, whose paths are all revision 0).

import assert from 'node:assert/strict';
import { prefetchForRequire, requireFsOverBridge } from '../../packages/core/src/runtime/require-resolver.ts';

const wrapper = (specifier) => `function load(id) { try { return require(id); } catch {} }\nmodule.exports = load('${specifier}');\n`;
const files = new Map([
  ['app/index.js', wrapper('first')],
  ['app/node_modules/first/package.json', JSON.stringify({ name: 'first', main: 'index.js' })],
  ['app/node_modules/first/index.js', 'module.exports = 1;\n'],
  ['app/node_modules/second/package.json', JSON.stringify({ name: 'second', main: 'index.js' })],
  ['app/node_modules/second/index.js', 'module.exports = 2;\n'],
]);
const strip = (path) => path.replace(/^\/+/, '');
const dirs = (path) => [...files.keys()].some((f) => f.startsWith(strip(path) + '/'));
const stat = (path) => files.has(strip(path)) ? { type: 'file', size: files.get(strip(path)).length, revision: 0 }
  : dirs(path) ? { type: 'directory', size: 0, revision: 0 } : null;
// Every path is revision 0, as a mount's are: no revision ever moves.
const bridge = {
  revision: async () => 0,
  stat: async (path) => {
    const st = stat(path);
    if (st === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return st;
  },
  readFile: async (path) => {
    if (!files.has(strip(path))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return new TextEncoder().encode(files.get(strip(path)));
  },
  access: async () => {},
};
const walk = async () => {
  const r = await prefetchForRequire(requireFsOverBridge(bridge), files.get('app/index.js'), '/app', '/app/index.js');
  assert.ok(!('kind' in r), JSON.stringify(r));
  return ['first', 'second'].filter((name) => r.bundle[`app/node_modules/${name}/index.js`] !== undefined);
};

assert.deepEqual(await walk(), ['first'], 'the wrapper call is read');
files.set('app/index.js', wrapper('second'));
assert.deepEqual(await walk(), ['second'], 'changed text is read anew, though its revision did not move');
files.set('app/index.js', wrapper('first'));
assert.deepEqual(await walk(), ['first'], 'and back');

console.log('require-wrapper-memo: ok');
