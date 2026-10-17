#!/usr/bin/env bun
// A barrel's synthetic entry is read in memory bounded by the statement, not
// by the module: the barrel and each module it `export *`s are parsed one
// top-level statement at a time (core javascript-ast.ts parseStatements),
// as the prebundle path that exists to avoid running out of memory must.
//
// The fixture: a barrel of `export * from './big.js'` and one tiny
// re-export, where big.js is ~16 MiB of statements that export nothing (no
// declarations: acorn checks each new name against the scope's) and one
// name it does. Synthesizing raises this process's peak resident memory
// by less than 8 times big.js's size; a whole tree of it is 17 to 24 times.
//
// Red before: each module was parsed to its whole tree (acorn's parse).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSyntheticEntry } from '../../packages/worker/src/runtime/barrel-synthesizer.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

const STATEMENTS = 420_000;
const lines = [];
for (let i = 0; i < STATEMENTS; i++) lines.push(`void [${i}, "s${i}", { k: ${i} }];`);
lines.push('export const used = 1;');
const big = lines.join('\n') + '\n';
lines.length = 0;

const files = {
  'app/node_modules/kit/package.json': JSON.stringify({ name: 'kit', type: 'module', module: 'index.js' }),
  'app/node_modules/kit/index.js': "export * from './big.js';\nexport { tiny } from './tiny.js';\n",
  'app/node_modules/kit/big.js': big,
  'app/node_modules/kit/tiny.js': 'export const tiny = 2;\n',
};
const vfs = new FakeVfs(files);

/** This process's peak resident memory so far (Linux's VmHWM), in bytes. */
const peak = () => Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024;

Bun.gc(true);
const before = peak();
const entry = buildSyntheticEntry(vfs, 'app/node_modules', 'kit', new Set(['used', 'tiny']));
const grown = peak() - before;

assert.ok(entry, 'an entry is synthesized');
assert.match(entry.code, /export \{ used \} from "kit\/big\.js";/);
assert.match(entry.code, /export \{ tiny \} from "kit\/tiny\.js";/);
const ratio = grown / big.length;
assert.ok(ratio < 8, `synthesizing raised peak memory by ${(grown / 2 ** 20).toFixed(1)} MiB, ${ratio.toFixed(1)} times the ${(big.length / 2 ** 20).toFixed(1)} MiB module`);
console.log(`barrel-parse-bounded: peak +${(grown / 2 ** 20).toFixed(1)} MiB for a ${(big.length / 2 ** 20).toFixed(1)} MiB module (${ratio.toFixed(2)}x)`);
