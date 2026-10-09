// @serial
// The builtin modules a session's `node` program can require, against host
// Node 22.22.3's: module.builtinModules itself, and for every module Node
// lists, whether it loads and the names it exports (Object.keys) with each
// one's typeof. The differences today are recorded in
// tests/fixtures/node-builtin-exports-gaps.json, for the builtin-parity work
// to close: this asserts them exactly, no more and no fewer, so a gap closed
// is taken off the list and a new one fails here.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/builtin-exports';
const PROGRAM = String.raw`
const { builtinModules } = require('module');
// Node's list, which the oracle hands over: each is required as it names it.
const names = JSON.parse(process.argv[2] ?? 'null') ?? builtinModules;
const modules = {};
for (const name of names) {
  let mod;
  try { mod = require(name); } catch { modules[name] = null; continue; }
  const keys = {};
  if (mod !== null && (typeof mod === 'object' || typeof mod === 'function')) {
    for (const key of Object.keys(mod).sort()) {
      let type;
      try { type = typeof mod[key]; } catch { type = 'throws'; }
      keys[key] = type;
    }
  }
  modules[name] = keys;
}
console.log('EXPORTS ' + JSON.stringify({ builtinModules: [...builtinModules].sort(), modules }));
`;
const exportsOf = (text) => {
  const line = text.split('\n').find((l) => l.startsWith('EXPORTS '));
  assert.ok(line, text.slice(-2000));
  return JSON.parse(line.slice('EXPORTS '.length));
};

const host = mkdtempSync(join(tmpdir(), 'builtin-exports-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
writeFileSync(join(host, 'exports.cjs'), PROGRAM);
const ran = spawnSync('node', ['exports.cjs'], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH }, maxBuffer: 64 << 20 });
assert.equal(ran.status, 0, ran.stderr);
const node = exportsOf(ran.stdout);

console.log('node-builtin-exports-match-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
let ours;
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const made = await session.run(`mkdir -p ${W}`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    await session.writeFile(`${W}/exports.cjs`, PROGRAM);
    await session.writeFile(`${W}/names.json`, JSON.stringify(node.builtinModules));
    const r = await session.run(`cd ${W} && node exports.cjs "$(cat names.json)" > out.txt 2>/dev/null; cat out.txt`, 300_000);
    ours = exportsOf(splitScenarioOutput(r.stdout).lines.join('\n'));
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}

// Each difference: the list's missing and extra names, a module that does not
// load ("absent"), or a module's missing and extra exports and those of
// another type ([name, ours, Node's]).
const gaps = {};
const listMissing = node.builtinModules.filter((name) => !ours.builtinModules.includes(name));
const listExtra = ours.builtinModules.filter((name) => !node.builtinModules.includes(name));
if (listMissing.length + listExtra.length > 0) gaps.builtinModules = { missing: listMissing, extra: listExtra };
for (const [name, theirs] of Object.entries(node.modules)) {
  const mine = ours.modules[name];
  if (theirs === null) continue;
  if (mine === null || mine === undefined) {
    gaps[name] = 'absent';
    continue;
  }
  const missing = Object.keys(theirs).filter((key) => !(key in mine));
  const extra = Object.keys(mine).filter((key) => !(key in theirs));
  const type = Object.keys(theirs).filter((key) => key in mine && mine[key] !== theirs[key]).map((key) => [key, mine[key], theirs[key]]);
  if (missing.length + extra.length + type.length > 0) gaps[name] = { missing, extra, type };
}
const GAPS = JSON.parse(readFileSync(new URL('../fixtures/node-builtin-exports-gaps.json', import.meta.url), 'utf8'));
console.log('BUILTIN_EXPORT_GAPS ' + JSON.stringify(gaps));
const changed = [...new Set([...Object.keys(gaps), ...Object.keys(GAPS)])].sort()
  .filter((name) => JSON.stringify(gaps[name]) !== JSON.stringify(GAPS[name]))
  .map((name) => `${name}: recorded ${JSON.stringify(GAPS[name] ?? null)}, now ${JSON.stringify(gaps[name] ?? null)}`);
assert.deepEqual(changed, [], `the gaps are the recorded ones (update tests/fixtures/node-builtin-exports-gaps.json when one closes):\n${changed.join('\n')}`);
console.log(`node-builtin-exports-match-node-workerd: ${Object.keys(node.modules).length} builtins compared; their differences are the ${Object.keys(gaps).length} recorded`);
