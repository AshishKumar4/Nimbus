#!/usr/bin/env bun
/**
 * `tr` reads its SETs the way tr does: escapes and classes, not literals.
 *
 * `expandRange` understood `a-z` and nothing else, so every backslash escape
 * was taken as the two literal characters it is written with. `tr '\n' ' '` —
 * the single most common use of the command — therefore replaced every letter
 * `n` with a space, and silently corrupted its input:
 *
 *     $ ls "$SRC_DIR" | tr '\n' ' '
 *     ode_modules  package.jso   packages
 *
 * That is a wrong ANSWER, not a failure: nothing reports it, and the caller
 * has no way to see it happened. Same category as a `find` predicate that is
 * accepted and ignored.
 *
 * `[:upper:]` and friends were literal for the same reason, so
 * `tr '[:upper:]' '[:lower:]'` mapped the punctuation in the class NAME.
 *
 * Every expectation was produced by running the identical pipeline under GNU
 * coreutils tr, and everything runs through the command registry a session
 * resolves through rather than a directly constructed interpreter.
 */

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', 1000, 1000);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);

const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
registerUnixCommands(box.commands.registry, rawVfs);
registerShellEntrypointCommands(
  box.commands.registry,
  { execute: (cmd, options) => box.shell.execute(cmd, options) },
  box.kernel.vfs,
);

const failures = [];
let caseNo = 0;

async function check(name, script, expected) {
  const path = `tmp/tr-case${caseNo++}.sh`;
  root.writeFile(path, script, { mode: 0o755 });
  const result = await box.shell.execute(`bash /${path}`, {});
  const actual = { stdout: result.stdout ?? '', exitCode: result.exitCode };
  const want = { stdout: expected.stdout, exitCode: expected.exitCode ?? 0 };
  try {
    assert.deepEqual(actual, want);
    console.log(`  ok   ${name}`);
  } catch {
    failures.push(name);
    console.log(`  FAIL ${name}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(actual)}`);
  }
}

// ── The idiom that was corrupting data ────────────────────────────────────
await check('\\n in a set is a newline, not a backslash and an n',
  "printf 'a b' | tr ' ' '\\n'\n", { stdout: 'a\nb' });

await check('a literal n is left alone by tr \\n',
  "printf 'node' | tr '\\n' ' '\n", { stdout: 'node' });

await check('joining lines with spaces keeps every character',
  "printf 'node_modules\\npackage.json\\n' | tr '\\n' ' '\n",
  { stdout: 'node_modules package.json ' });

// ── The rest of the escape table ──────────────────────────────────────────
await check('\\t is a tab', "printf 'a\\tb' | tr '\\t' ':'\n", { stdout: 'a:b' });
await check('\\\\ is one backslash', "printf 'a\\\\b' | tr '\\\\\\\\' '/'\n", { stdout: 'a/b' });
await check('an octal escape names its byte', "printf 'aXb' | tr '\\130' 'Y'\n", { stdout: 'aYb' });
await check('\\r is a carriage return',
  "printf 'a\\rb' | tr '\\r' '.'\n", { stdout: 'a.b' });

// ── Character classes ─────────────────────────────────────────────────────
await check('[:upper:] maps to [:lower:]',
  "printf 'AbC' | tr '[:upper:]' '[:lower:]'\n", { stdout: 'abc' });
await check('[:lower:] maps to [:upper:]',
  "printf 'AbC' | tr '[:lower:]' '[:upper:]'\n", { stdout: 'ABC' });
await check('-d with [:digit:] deletes digits',
  "printf 'a1b2' | tr -d '[:digit:]'\n", { stdout: 'ab' });
await check('-d with [:space:] deletes whitespace',
  "printf 'a b\\tc' | tr -d '[:space:]'\n", { stdout: 'abc' });

// ── What already worked must keep working ─────────────────────────────────
await check('ranges still expand', "printf 'abc' | tr 'a-c' 'x-z'\n", { stdout: 'xyz' });
await check('a short set2 repeats its last character',
  "printf 'abc' | tr 'abc' 'x'\n", { stdout: 'xxx' });
await check('-d deletes a literal set', "printf 'a-b-c' | tr -d '-'\n", { stdout: 'abc' });
await check('-s squeezes repeats', "printf 'aaabbb' | tr -s 'ab'\n", { stdout: 'ab' });

if (failures.length > 0) {
  console.error(`\ntr-set-parsing: ${failures.length} failing case(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`tr-set-parsing: ok (${caseNo} cases)`);
