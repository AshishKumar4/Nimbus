#!/usr/bin/env bun
// A staged module the interpreter adopts because workerd could not link its
// graph (core runtime/esm-late-link.ts linkAdopted): its graph is checked as a
// late graph's is, every imported name, unless a link checked it already.
//   - a late module that imports a staged bridge (`export * from` a query's
//     instance, which staging hands on) links the bridge's graph with its own;
//     the bridge's adoption after it reads no module again;
//   - a staged module no link has checked is read and checked at its
//     adoption, once; a name it imports that its module does not export is
//     Node's SyntaxError, and nothing is marked checked.
// Driven in-process through a LateLinkHost over a small table of rows, its
// modules read by the interpreter's parser (counted).

import assert from 'node:assert/strict';
import { moduleRequests } from '../../packages/core/src/interpreter/index.ts';
import { linkAdopted, linkLateGraph } from '../../packages/core/src/runtime/esm-late-link.ts';

const FILES = {
  'leaf.mjs': 'export const x = 1;\n',
  'bridge.mjs': "export * from './leaf.mjs?instance';\n",
  'late.mjs': "import { x } from './bridge.mjs';\nconsole.log(x);\n",
  'other.mjs': "import { x } from './leaf.mjs?instance';\nexport const y = x;\n",
  'wrong.mjs': "import { nothing } from './leaf.mjs?instance';\n",
};
// Staged rows: [kind, key, targets]; a target -2 - i is staging's missing(i), handed on.
const ROWS = [
  ['module', 'bridge.mjs', [-2]],
  ['module', 'other.mjs', [-2]],
  ['module', 'wrong.mjs', [-2]],
];
const HANDED_ON = ['file:///leaf.mjs?instance'];

const reads = [];
const host = {
  row: (kind, key) => ROWS.findIndex(([k, path]) => k === kind && path === key),
  rowKind: (row) => ROWS[row][0],
  rowKey: (row) => ROWS[row][1],
  rowBindings: () => '[]',
  rowTargets: (row) => ROWS[row][2],
  rowSettled: () => false,
  missing: (i) => (HANDED_ON[i] === undefined ? null : { handedOn: HANDED_ON[i] }),
  source: (key) => FILES[key] ?? null,
  fileFormat: () => 'module',
  loadUnread: () => {},
  resolve: (specifier, parentUrl) => {
    const url = new URL(specifier, parentUrl);
    return { url: url.href, format: 'module', path: decodeURIComponent(url.pathname) };
  },
  builtinNames: () => ['default'],
  cjsResolve: () => null,
  exportMessage: (specifier, name) => `The requested module '${specifier}' does not provide an export named '${name}'`,
  decorate: (error) => error,
  requests: (path, text, javaScript, goal) => {
    reads.push(path);
    return moduleRequests(path, text, javaScript, goal);
  },
};

// A late module's link checks the staged bridge's graph with its own.
linkLateGraph(host, 'late.mjs', 'file:///late.mjs', true);
assert.ok(reads.includes('bridge.mjs'), `the late graph's link reads the bridge (${reads.join(', ')})`);
const afterLate = reads.length;
linkAdopted(host, 0, 'bridge.mjs', 'file:///bridge.mjs');
assert.deepEqual(reads.slice(afterLate), [], 'the bridge, checked by the late graph\'s link, is not read again at its adoption');

// A staged module no link has checked: read and checked at its adoption, once.
linkAdopted(host, 1, 'other.mjs', 'file:///other.mjs');
assert.ok(reads.slice(afterLate).includes('other.mjs'), `an unchecked adoption reads its module (${reads.slice(afterLate).join(', ')})`);
const afterOther = reads.length;
linkAdopted(host, 1, 'other.mjs', 'file:///other.mjs');
assert.equal(reads.length, afterOther, 'a second adoption of it reads nothing');

// A name its module does not export: Node's SyntaxError, at every adoption (nothing marked checked).
for (let i = 0; i < 2; i++) {
  assert.throws(() => linkAdopted(host, 2, 'wrong.mjs', 'file:///wrong.mjs'),
    (error) => error instanceof SyntaxError && error.message === "The requested module './leaf.mjs?instance' does not provide an export named 'nothing'");
}

console.log('esm-late-link-adoption OK');
