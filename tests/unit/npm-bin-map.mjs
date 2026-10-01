#!/usr/bin/env bun
// A package's `bin` field is linked as npm links it: npmBinMap against
// npm-normalize-package-bin, the module npm 10.9 installs with.
//
// A bin map comes from a registry, an installed package.json or a bin
// manifest, and Nimbus wrote, linked and removed files by its raw keys: a key
// ../../keep.txt reached a project file. Each row is [package name, bin
// field, what npm 10.9.8's npm-normalize-package-bin made of it], recorded
// from that module (normalize({ name, bin }).bin).

import assert from 'node:assert/strict';
import { npmBinMap, npmBinName } from '../../packages/core/src/runtime/npm-bin-map.ts';
import { getBinEntries } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';

const NPM = [
  ["p", {"../../keep.txt": "cli.js"}, {"keep.txt": "cli.js"}],
  ["p", {"x\\..\\..\\y": "cli.js"}, {"y": "cli.js"}],
  ["p", {"a:b": "x.js"}, {"b": "x.js"}],
  ["p", {"..": "x.js", ".": "x.js", "": "x.js", "ok": "x.js"}, {"ok": "x.js"}],
  ["p", {"up": "../../../outside.js"}, {"up": "outside.js"}],
  ["p", {"w": "bin\\cli.js", "d": "./bin/cli.js", "e": "..", "f": "/abs/cli.js", "g": "a/../../b.js"}, {"w": "bin/cli.js", "d": "bin/cli.js", "f": "abs/cli.js", "g": "b.js"}],
  ["@scope/tool", "./cli.js", {"tool": "cli.js"}],
  ["@scope/tool", "../../../escape.js", {"tool": "escape.js"}],
  [null, "./cli.js", {}],
  ["p", ["bin/one.js", "./two.js", "../three.js"], {"one.js": "bin/one.js", "two.js": "two.js", "three.js": "three.js"}],
  ["p", {"n": 5, "s": "x.js"}, {"s": "x.js"}],
  ["p", {"staged": "nimbus-staged:opencode"}, {"staged": "nimbus-staged:opencode"}],
  ["p", ["bin/tool/"], {"tool": "bin/tool/"}],
  ["p", {"t": "bin/tool/"}, {"t": "bin/tool/"}],
  ["p", {"t": "a//b/./c.js"}, {"t": "a/b/c.js"}],
  ["p", {"t": "/"}, {}],
  ["p", ["a\\b.js", "x:y.js"], {"b.js": "a/b.js", "y.js": "x:y.js"}],
  ["p", {"a\\b": "c\\d.js"}, {"b": "c/d.js"}],
  ["p", {"t": "../"}, {}]
];

for (const [name, bin, expected] of NPM) {
  assert.deepEqual(Object.fromEntries(npmBinMap(name ?? '', bin)), expected, `bin ${JSON.stringify(bin)} of ${name}`);
}

for (const key of ['', '.', '..', 'a/..', '//']) assert.equal(npmBinName(key), null, `${JSON.stringify(key)} links nothing`);
// The shell's npm (global install and uninstall, bin registration) reads bins through the same rule.
assert.deepEqual(getBinEntries({ name: 'p', bin: { '../../x': '../a.js' } }), { x: 'a.js' });
for (const [name, bin] of NPM) {
  for (const [link, target] of npmBinMap(name ?? '', bin)) {
    assert.equal(/[\\/:]/.test(link) || link === '..' || link === '.', false, `${link} names one file in .bin`);
    assert.equal(target.split('/').includes('..') || target.startsWith('/'), false, `${target} stays inside its package`);
  }
}

console.log('npm-bin-map: ok');
