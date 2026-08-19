#!/usr/bin/env bun
// `xargs -0` exists so that a name can contain the characters a whitespace
// split would eat. That guarantee is only as good as what reaches the split:
// `xargs` used to `.trim()` its whole stdin first, which silently rewrote the
// first and last item of every NUL-separated stream.
//
// `find -print0 | xargs -0 rm` on a file named " draft.md" therefore named the
// wrong path. Whitespace-splitting mode is unaffected either way —
// `split(/\s+/).filter(Boolean)` already drops the empties the trim removed —
// so the trim bought nothing and cost exactly the case `-0` is for.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kfs = rawVfs.as(CRED_KERNEL);
kfs.mkdir('home/user', { recursive: true, mode: 0o755 });

const registry = createDefaultRegistry();
registerUnixCommands(registry, rawVfs);

const seen = [];
registry.register('argvprobe', async (ctx) => {
  seen.push([...ctx.args]);
  return 0;
});

// ── -0 delivers the bytes between the NULs, verbatim ────────────────────────
await runXargs(['-0', 'argvprobe'], ' leading.md\0trailing.md \0mid dle.md\0');
assert.deepEqual(
  seen.at(-1),
  [' leading.md', 'trailing.md ', 'mid dle.md'],
  '-0 items keep the whitespace that is part of the name',
);

// A trailing separator terminates the last item; it does not add an empty one.
await runXargs(['-0', 'argvprobe'], 'a\0b\0');
assert.deepEqual(seen.at(-1), ['a', 'b'], 'a trailing NUL is a terminator, not an item');

// A newline inside a name is the other reason -0 exists.
await runXargs(['-0', 'argvprobe'], 'two\nlines.md\0plain.md\0');
assert.deepEqual(seen.at(-1), ['two\nlines.md', 'plain.md'], '-0 items may contain newlines');

// ── whitespace mode is unchanged: surrounding blanks are separators ─────────
await runXargs(['argvprobe'], '  alpha\n beta \n');
assert.deepEqual(seen.at(-1), ['alpha', 'beta'], 'default splitting still eats surrounding blanks');

// ── an empty or blank-only stream still invokes nothing ─────────────────────
const before = seen.length;
assert.equal(await runXargs(['argvprobe'], ''), 0);
assert.equal(await runXargs(['argvprobe'], '   \n\t '), 0);
assert.equal(await runXargs(['-0', 'argvprobe'], ''), 0);
assert.equal(seen.length, before, 'no items means no invocation');

console.log('xargs null-separated fidelity: ok');

async function runXargs(args, stdin) {
  const xargs = await registry.resolve('xargs');
  assert.ok(xargs, 'xargs is registered');
  let stderr = '';
  const exitCode = await xargs({
    args,
    cwd: '/home/user',
    env: {},
    cred: CRED_KERNEL,
    pid: 71,
    vfs: kfs,
    stdin,
    stdout: { write: () => {} },
    stderr: { write: (value) => { stderr += String(value); } },
    signal: new AbortController().signal,
    setUmask: () => {},
    runAs: async () => 126,
  });
  assert.equal(stderr, '', `xargs ${args.join(' ')} wrote to stderr: ${stderr}`);
  return exitCode;
}
