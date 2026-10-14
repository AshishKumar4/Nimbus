#!/usr/bin/env bun
// The shell's built-in node is the process the shell started, as Node is:
//
//   - its release is one fingerprint, the one core pins (constants.ts):
//     `node --version` and process.version, process.versions.node agree;
//   - process.pid is its pid in the session's process table, and getuid,
//     getgid and getgroups are its credential's (root under sudo);
//   - process.umask() is the mask it started with, and process.umask(m)
//     the one it creates with from then on, answering the one before; the
//     program's copy, as a child's is: the shell's mask stays;
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
// Every process the session spawns, as it was spawned: a command's process is gone from the table once it ends.
class Recording extends SessionProcessSupervisor {
  spawned = new Map();
  spawn(command, argv, cwd, opts) {
    const entry = super.spawn(command, argv, cwd, opts);
    this.spawned.set(entry.pid, { argv: [...argv], cred: { ...entry.cred, groups: [...entry.cred.groups] } });
    return entry;
  }
}
const processes = new Recording();
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
    const entry = processes.spawned.get(seen.pid);
    assert.ok(entry !== undefined && seen.pid !== 1, `${who}: process.pid ${seen.pid} is the process the command ran as, not a made-up 1`);
    assert.deepEqual(seen, {
      version: NODE_VERSION, node: NODE_VERSION.slice(1), pid: seen.pid,
      uid, euid: uid, gid: entry.cred.gid, egid: entry.cred.gid, groups: entry.cred.groups,
    }, `${who}: the release and the credential are the process's`);
  }
  console.log('  ✓ the release is core\'s, and pid, uid, gid and groups are the process\'s, as the user and under sudo');

  // The program has its own copy of the mask, as a child process does: what it creates follows it, and the shell's stays.
  const umask = await run(`node -e "const fs = require('fs'); const old = process.umask(0); fs.writeFileSync('open.txt', 'a'); fs.mkdirSync('open.d'); const back = process.umask(old); fs.writeFileSync('kept.txt', 'b'); console.log(old.toString(8), back.toString(8), process.umask().toString(8))"; umask`);
  assert.equal(umask, '22 0 22\n0022\n', 'umask answers the mask before; the shell\'s is the one it had');
  const mode = async (path) => (await ws.fs.stat(`/home/user/${path}`)).mode & 0o777;
  assert.deepEqual([await mode('open.txt'), await mode('open.d'), await mode('kept.txt')], [0o666, 0o777, 0o644],
    'a file and a directory made under umask 0 have every bit; one made after umask(old) has the old mask\'s');
  console.log('  ✓ process.umask is the program\'s own: its creates follow it, the shell\'s mask stays');

  await ws.fs.writeFile('/home/user/required.js', 'module.exports = { same: global === globalThis, seen: global.SUB };\n');
  assert.equal(await run(`node -e "global.SUB = 1; const r = require('./required.js'); console.log(globalThis.SUB, global === globalThis, r.same, r.seen)"`), '1 true true 1\n',
    '`global` is globalThis, in the main script and in a required module');
  console.log('  ✓ global is the realm\'s globalThis everywhere');
} finally {
  await ws.close();
}
console.log('lifo-node-identity: ok');
