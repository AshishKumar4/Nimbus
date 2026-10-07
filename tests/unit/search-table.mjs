#!/usr/bin/env bun
// npm search and lifo search print one results table (renderSearchTable):
// NAME cut at 28 columns with `..`, VERSION, 40 columns of DESCRIPTION;
// lifo's lists only lifo-pkg-* packages, named without the prefix.
import assert from 'node:assert/strict';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { createLifoPkgCommand } from '../../packages/core/src/substrate/lifo/commands/system/lifo.ts';

const LONG = 'a-package-name-longer-than-twenty-eight';
const hits = { objects: [
  { package: { name: `lifo-pkg-${LONG}`, version: '1.2.3', description: 'x'.repeat(50) } },
  { package: { name: 'left-pad', version: '1.3.0' } },
] };
const origFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json(hits);
async function run(command, args) {
  let out = '';
  const status = await command({ args, env: {}, cwd: '/', stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { out += s; } }, signal: new AbortController().signal });
  return { status, out };
}
try {
  const rule = `${'NAME'.padEnd(30)}${'VERSION'.padEnd(12)}DESCRIPTION\n${'-'.repeat(70)}\n`;
  const npm = await run(createNpmCommand(new CommandRegistry()), ['search', 'pad']);
  assert.equal(npm.status, 0);
  assert.equal(npm.out, `${rule}${`lifo-pkg-${LONG}`.slice(0, 28)}..1.2.3       ${'x'.repeat(40)}\n${'left-pad'.padEnd(30)}1.3.0       \n`);
  const lifo = await run(createLifoPkgCommand(new CommandRegistry()), ['search', 'pad']);
  assert.equal(lifo.status, 0);
  assert.equal(lifo.out, `${rule}${LONG.slice(0, 28)}..1.2.3       ${'x'.repeat(40)}\n`);
} finally {
  globalThis.fetch = origFetch;
}
console.log('search-table: ok');
