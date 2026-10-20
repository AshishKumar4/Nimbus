#!/usr/bin/env bun
// A nested shell stops with its caller (ask 42): `bash -c`, `sh -c` and
// `bash script` run their program in a shell of their own, which takes the
// command's signal. Before, the entrypoint passed none, so an aborted
// `bash -c 'while :; do …; done'` was reported stopped while its loop ran on.
// Each loop counts into a file; once the call settles the count stops moving.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LOOP = 'i=0; while :; do i=$((i+1)); echo $i > /tmp/count; done';
const CASES = [
  `bash -c '${LOOP}'`,
  `sh -c '${LOOP}'`,
  `printf '%s\\n' '${LOOP}' > /tmp/loop.sh; bash /tmp/loop.sh`,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
registerShellEntrypointCommands(ws.registry, {
  execute: (cmd, options) => ws.shellFor(options?.commandContext?.pid ?? 1, { cwd: options?.cwd ?? '/home/user', env: options?.env, inheritEnv: false }).execute(cmd, options),
});
const count = async () => Number((await ws.shell.execute('cat /tmp/count')).stdout);
try {
  for (const line of CASES) {
    await ws.shell.execute('rm -f /tmp/count');
    const stop = new AbortController();
    const run = ws.shell.execute(line, { signal: stop.signal });
    await sleep(300);
    stop.abort();
    const result = await Promise.race([run, sleep(5000).then(() => null)]);
    assert.notEqual(result, null, `${line}: settles once aborted`);
    const before = await count();
    await sleep(300);
    const after = await count();
    assert.ok(before > 0, `${line}: the loop ran (${before})`);
    assert.equal(after, before, `${line}: the loop stops with its caller (${before} then ${after})`);
  }
  console.log(`shell-entrypoint-abort: ${CASES.length} nested shells stop with their caller`);
} finally {
  await ws.close();
}
