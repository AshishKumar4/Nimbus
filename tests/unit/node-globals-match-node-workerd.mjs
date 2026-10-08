// @serial
// The global object a session's `node` program sees, against host Node
// 22.22.3's, and a `bun` program's against host Bun's: every name globalThis
// answers (its own and its prototypes', not Object.prototype's) and its
// typeof. A difference is a workerd-only global a
// node program should not see (caches, HTMLRewriter, WebSocketPair, …), a
// Node global the runtime lacks, or one of another type. The differences
// today are recorded in tests/fixtures/node-globals-gaps.json, for the
// builtin-parity work to close: this asserts them exactly, no more and no
// fewer, so a gap closed is taken off the list and a new one fails here.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/globals';
const PROGRAM = String.raw`
// A global is any name globalThis answers: its own properties and its
// prototypes' (workerd's live on the global scope's prototype), but
// Object.prototype's.
const names = new Set();
for (let o = globalThis; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const name of Object.getOwnPropertyNames(o)) if (name !== 'constructor') names.add(name);
}
const out = {};
for (const name of [...names].sort()) {
  let type;
  try { type = typeof globalThis[name]; } catch { type = 'throws'; }
  out[name] = type;
}
console.log('GLOBALS ' + JSON.stringify(out));
`;
const globalsOf = (text) => {
  const line = text.split('\n').find((l) => l.startsWith('GLOBALS '));
  assert.ok(line, text.slice(-2000));
  return JSON.parse(line.slice('GLOBALS '.length));
};
// What differs: [name, the runtime's typeof or "absent", the reference's or "absent"].
const differences = (ours, theirs) => [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort()
  .filter((name) => ours[name] !== theirs[name])
  .map((name) => [name, ours[name] ?? 'absent', theirs[name] ?? 'absent']);

const host = mkdtempSync(join(tmpdir(), 'node-globals-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
writeFileSync(join(host, 'globals.cjs'), PROGRAM);
const reference = {};
for (const runtime of ['node', 'bun']) {
  const ran = spawnSync(runtime, ['globals.cjs'], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(ran.status, 0, `${runtime}: ${ran.stderr}`);
  reference[runtime] = globalsOf(ran.stdout);
}

const GAPS = JSON.parse(readFileSync(new URL('../fixtures/node-globals-gaps.json', import.meta.url), 'utf8'));
console.log('node-globals-match-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
const found = {};
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    await session.run(`mkdir -p ${W}`, 30_000);
    await session.writeFile(`${W}/globals.cjs`, PROGRAM);
    for (const runtime of ['node', 'bun']) {
      const r = await session.run(`cd ${W} && ${runtime} globals.cjs`, 120_000);
      found[runtime] = differences(globalsOf(splitScenarioOutput(r.stdout).lines.join('\n')), reference[runtime]);
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
assert.deepEqual(found, GAPS,
  `the globals differ from host Node's and Bun's exactly as recorded (update tests/fixtures/node-globals-gaps.json when one closes):\nFOUND ${JSON.stringify(found)}\n`);
console.log(`node-globals-match-node-workerd: ${found.node.length} node and ${found.bun.length} bun differences, as recorded`);
