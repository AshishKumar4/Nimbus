#!/usr/bin/env bun
// uptime and top print how long the shell has been up as procps does
// ("5 min", " 1:23", "2 days,  3:04"), from one clock: they used to read
// three (the shell's registration time, and performance.now() twice, which
// in a Worker restarts with each request), in three formats. free, top,
// fastfetch and node's os read the heap through one reader too.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { formatUptime } from '../../packages/core/src/substrate/lifo/utils/system-info.ts';
import { createTopCommand } from '../../packages/core/src/substrate/lifo/commands/system/top.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

// procps' sprint_uptime: days when there are any, then H:MM (hours padded
// to two) past the first hour, else whole minutes.
for (const [seconds, want] of [
  [0, '0 min'], [59, '0 min'], [3599, '59 min'], [3600, ' 1:00'], [36000 + 61, '10:01'],
  [86400, '1 day, 0 min'], [86400 + 3660, '1 day,  1:01'], [3 * 86400 + 7200, '3 days,  2:00'],
]) {
  assert.equal(formatUptime(seconds), want, `${seconds}s`);
}

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const uptime = await ws.exec('uptime');
  assert.match(uptime.stdout, /^ \d\d:\d\d:\d\d up \d+ min,  1 user\n$/, uptime.stdout);
  // top is the hosted shell's (a factory over the process table), run here directly.
  let topOut = '';
  await createTopCommand(new ProcessRegistry())({ args: [], env: {}, stdout: { write: (s) => { topOut += s; } } });
  assert.match(topOut.split('\n')[0], /^top - \d\d:\d\d:\d\d up \d+ min,  1 user$/, topOut);
  const free = await ws.exec('free -h');
  assert.equal(free.stdout, 'Memory information not available in this runtime\n', 'Bun reports no heap, as workerd does not');
} finally {
  await ws.close();
}
console.log('system-info-commands: ok');
