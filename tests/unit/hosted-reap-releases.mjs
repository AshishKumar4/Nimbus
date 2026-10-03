#!/usr/bin/env bun
// A session's ended processes let go of the filesystem when they are reaped.
//
// Each hosted exec, startProcess run and sudo call binds a pid of its own to
// the namespace: a descriptor scope holding what its commands opened and
// watched. A session does not reap a call when it returns; its process table
// is pruned by age (SessionProcessSupervisor.reap, which the facet manager
// runs before each launch), and that prune forgot each entry without
// releasing it, so every call left a scope behind, its watches still firing.
// What has to hold: the reap releases each pid through the release slot the
// workspace set on the table, before forgetting it.

import assert from 'node:assert/strict';

import { rpcExec, rpcStartProcess } from '../../packages/worker/src/session/programmatic.ts';
import { programmaticHost } from './lib/programmatic-host.mjs';

let fired = 0;
const pids = [];
const { ws, host, held, close } = await programmaticHost({
  commands: {
    'watch-home': async (ctx) => {
      pids.push(ctx.pid);
      ctx.vfs.process.subscribe('/home/user', () => { fired += 1; });
      return 0;
    },
  },
});
try {
  for (let i = 0; i < 3; i++) assert.equal((await rpcExec(host, 'watch-home')).exitCode, 0);
  // `sudo` runs its program as a child process, bound to a pid of its own.
  assert.equal((await rpcExec(host, 'sudo watch-home')).exitCode, 0);
  for (let i = 0; i < 2; i++) await rpcStartProcess(host, 'watch-home');
  await Promise.all(held);
  assert.equal(pids.length, 6, 'every call ran under a pid of its own');

  // The prune the facet manager runs before each launch, with every ended
  // entry past its age.
  await ws.processes.reap(-1);
  await ws.fs.writeFile('/home/user/watched.txt', 'x');
  await ws.fs.remove('/home/user/watched.txt');
  assert.equal(fired, 0, 'no watch outlived the reap of the process that made it');
  const cred = ws.processes.cred(ws.shellProcessPid);
  for (const pid of pids) {
    assert.equal(ws.processes.get(pid), undefined, `pid ${pid} was reaped`);
    assert.throws(() => ws.filesystem.bind({ pid, cred }), { code: 'ESTALE' }, `pid ${pid} was released`);
  }
} finally {
  close();
}

console.log('ok - hosted-reap-releases (a reaped session process lets go of what it bound)');
