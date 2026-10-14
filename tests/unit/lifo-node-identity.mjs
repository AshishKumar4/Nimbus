#!/usr/bin/env bun
// The shell's built-in node is the process the shell started, as Node is:
//
//   - its release is one fingerprint, the one core pins (constants.ts):
//     `node --version` and process.version, process.versions.node agree;
//   - process.pid is its pid in the session's process table, and getuid,
//     getgid and getgroups are its credential's (root under sudo);
//   - process.umask() is its live mask, and process.umask(m) sets the
//     process's mask in the session, answering the one before;
//   - `global` is the realm's globalThis, in the main script and in every
//     module it requires.
//
// Red before: --version printed v20.0.0 and process.version v22.14.0; pid
// was 1, every id 1000, umask a constant; each module's `global` was an
// object of its own.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { NODE_VERSION } from '../../packages/core/src/constants.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const processes = new SessionProcessSupervisor();
const ws = await NimbusWorkspace.create({ sql, transactions, processes, generation: 1 });
const run = async (command) => {
  const result = await ws.exec(command, { cwd: '/home/user' });
  assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
  return result.stdout;
};
const IDENTITY = "console.log(JSON.stringify({ version: process.version, node: process.versions.node, pid: process.pid, uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(), groups: process.getgroups() }))";
try {
  assert.equal(await run('node --version'), `${NODE_VERSION}\n`, 'node --version is core\'s release');
  for (const [who, prefix, uid] of [['the user', '', 1000], ['root', 'sudo ', 0]]) {
    const seen = JSON.parse(await run(`${prefix}node -e "${IDENTITY}"`));
    const entry = processes.get(seen.pid);
    assert.ok(entry !== undefined && /\bnode\b/.test(entry.command), `${who}: process.pid ${seen.pid} is the node process the table has: ${JSON.stringify(entry)} ${JSON.stringify([...Array(12).keys()].map((pid) => processes.get(pid)).filter(Boolean).map((e) => [e.pid, e.command, e.state, e.cred?.uid, e.parentPid]))}`);
    assert.deepEqual(seen, {
      version: NODE_VERSION, node: NODE_VERSION.slice(1), pid: seen.pid,
      uid, euid: uid, gid: entry.cred.gid, egid: entry.cred.gid, groups: [...entry.cred.groups],
    }, `${who}: the release and the credential are the process's`);
  }
  console.log('  ✓ the release is core\'s, and pid, uid, gid and groups are the process\'s, as the user and under sudo');

  const masks = JSON.parse(await run(`node -e "const before = process.umask(0o077); console.log(JSON.stringify({ pid: process.pid, before, now: process.umask() }))"`));
  assert.deepEqual({ before: masks.before, now: masks.now }, { before: 0o022, now: 0o077 }, 'umask answers the mask before and keeps the new one');
  assert.equal(processes.get(masks.pid).cred.umask, 0o077, 'the process\'s mask in the session is the one it set');
  console.log('  ✓ process.umask reads and sets the process\'s live mask');

  await ws.fs.writeFile('/home/user/required.js', 'module.exports = { same: global === globalThis, seen: global.SUB };\n');
  assert.equal(await run(`node -e "global.SUB = 1; const r = require('./required.js'); console.log(globalThis.SUB, global === globalThis, r.same, r.seen)"`), '1 true true 1\n',
    '`global` is globalThis, in the main script and in a required module');
  console.log('  ✓ global is the realm\'s globalThis everywhere');
} finally {
  await ws.close();
}
console.log('lifo-node-identity: ok');
