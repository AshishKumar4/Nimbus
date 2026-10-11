#!/usr/bin/env bun
// A one-shot node program that has ended takes no resumption barrier on its
// way out: the runtime's own turns after the program (draining its writes)
// are the runtime's, on the platform's timer, not program timers whose
// barrier asks the session (and is answered with a read lease the run then
// has to give back).
import assert from 'node:assert/strict';

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { opSender, supervisorDouble } from './lib/supervisor-double.mjs';

const { host, rawVfs } = createAuthority();
let ops = [];
adoptCtxExports({
  SupervisorRPC: /** @type {any} */ (({ props }) => {
    const send = opSender((envelope) => host.supervisorOp({ ...envelope, pid: props?.pid }));
    return supervisorDouble(async (op, args) => {
      ops.push(op);
      if (op === 'stdout' || op === 'stderr' || op === 'reportExit') return;
      return send(op, args);
    });
  }),
});
const manager = oneShotManager('node-one-shot-end-ops', { host, rawVfs, loader: runnerLoader('node-one-shot-end-ops') });

async function run(program) {
  ops = [];
  const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
  try {
    return await manager.exec(program, { filename: '<eval>', dirname: '/home/user', cwd: '/home/user', argv: [], captureOutput: false });
  } finally { Object.assign(globalThis, real); }
}

for (const program of ["process.stdout.write('x')", "setTimeout(() => process.stdout.write('late'), 5)"]) {
  for (let i = 0; i < 3; i++) {
    const result = await run(program);
    assert.equal(result.exitCode, 0);
    const last = ops.lastIndexOf('stdout');
    assert.ok(last !== -1, `${program}: no output (${ops.join(' ')})`);
    const after = ops.slice(last + 1);
    assert.deepEqual(after.filter((op) => op === 'fsAcquire'), [], `${program}: after its last write the session was asked ${after.join(' ')}`);
  }
}
console.log('ok - node-one-shot-end-ops (an ended program takes no resumption barrier)');
