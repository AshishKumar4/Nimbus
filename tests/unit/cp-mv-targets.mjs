#!/usr/bin/env bun
// cp and mv read their operands with one resolver (commands/fs/copy-targets.ts):
// -t DIR, or more than one source, needs a directory, refused in GNU's words.
// mv took `mv -t FILE SOURCE` as a rename onto FILE, and both said "is not a
// directory" where GNU names the errno. The expectations are GNU coreutils
// 9.7's cp and mv, recorded 2026-10-05.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const run = (line) => ws.exec(`cd /tmp && rm -rf t && mkdir t && cd t && echo a > a && echo b > b && echo f > f && mkdir d && ${line}`);
  for (const tool of ['cp', 'mv']) {
    for (const [args, stderr] of [
      ['-t f a', `${tool}: target directory 'f': Not a directory\n`],
      ['-t nope a', `${tool}: target directory 'nope': No such file or directory\n`],
      ['a b f', `${tool}: target 'f': Not a directory\n`],
      ['a b nope', `${tool}: target 'nope': No such file or directory\n`],
    ]) {
      const r = await run(`${tool} ${args}`);
      assert.deepEqual([r.exitCode, r.stderr], [1, stderr], `${tool} ${args}`);
    }
    const into = await run(`${tool} -t d a b && ls -1 d && cat f`);
    assert.deepEqual([into.exitCode, into.stdout], [0, 'a\nb\nf\n'], `${tool} -t d a b`);
  }
} finally {
  await ws.close();
}
console.log('cp-mv-targets: ok');
