#!/usr/bin/env bun
/**
 * find-expression-evaluator — `find` answers the question it was asked, or
 * says it cannot.
 *
 * The installer stopped here:
 *
 *     find "$tmp/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1
 *
 * `-mindepth` was not implemented, and an unrecognised predicate was
 * SILENTLY DROPPED — so the expression evaluated as `-maxdepth 1 -type d`,
 * emitted the start directory at depth 0, and `head -n 1` picked the
 * container instead of the tree inside it. The subsequent `mv` then nested
 * the source one level too deep and `bun install` reported no package.json.
 *
 * Dropping a predicate is the worse half: it does not fail, it answers a
 * DIFFERENT question. `find . ! -name x` ran as `find . -name x` — the exact
 * complement of the requested set — and nothing said so.
 *
 * So this is not a `-mindepth` fix. `find`'s argument list is an expression
 * with operators, precedence and grouping, and the fix is to evaluate it as
 * one and to refuse the tokens it does not know.
 *
 * Every expectation below was produced by running the identical expression
 * under GNU findutils 4.10.0, and everything runs through the command
 * registry a session resolves through — registerUnixCommands +
 * registerShellEntrypointCommands + installPathExecResolver, driven as
 * `bash script`, never a directly constructed interpreter.
 */

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { installPathExecResolver } from '../../packages/core/src/shell/exec-dispatch.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', 1000, 1000);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);

// The tree the differential was run against, byte for byte.
//   extract/
//     empty.txt        (0 bytes)
//     3k.bin           (3000 bytes)
//     other/
//     proteus/
//       package.json
//       bin/cli
//       src/a.ts
root.mkdir('home/user/extract', { mode: 0o755 });
root.writeFile('home/user/extract/empty.txt', '', { mode: 0o644 });
root.writeFile('home/user/extract/3k.bin', 'x'.repeat(3000), { mode: 0o644 });
root.mkdir('home/user/extract/other', { mode: 0o755 });
root.mkdir('home/user/extract/proteus', { mode: 0o755 });
root.writeFile('home/user/extract/proteus/package.json', '{}\n', { mode: 0o644 });
root.mkdir('home/user/extract/proteus/bin', { mode: 0o755 });
root.writeFile('home/user/extract/proteus/bin/cli', '#!/bin/sh\n', { mode: 0o755 });
root.mkdir('home/user/extract/proteus/src', { mode: 0o755 });
root.writeFile('home/user/extract/proteus/src/a.ts', 'export const a = 1;\n', { mode: 0o644 });

const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
installPathExecResolver(box.commands.registry, root, () => box.shell.getCwd?.() ?? '/home/user');
registerUnixCommands(box.commands.registry, rawVfs);
registerShellEntrypointCommands(
  box.commands.registry,
  { execute: (cmd, options) => box.shell.execute(cmd, options) },
  box.kernel.vfs,
);

const failures = [];
let caseNo = 0;

/** Run a script the way a user does: `bash script.sh`. */
async function check(name, script, expected) {
  const path = `tmp/find-case${caseNo++}.sh`;
  root.writeFile(path, script, { mode: 0o755 });
  const result = await box.shell.execute(`bash /${path}`, {});
  const actual = {
    stdout: result.stdout ?? '',
    exitCode: result.exitCode,
    ...(expected.stderr === undefined ? {} : { stderr: result.stderr ?? '' }),
  };
  const want = {
    stdout: expected.stdout,
    exitCode: expected.exitCode ?? 0,
    ...(expected.stderr === undefined ? {} : { stderr: expected.stderr }),
  };
  try {
    assert.deepEqual(actual, want);
    console.log(`  ok   ${name}`);
  } catch {
    failures.push(name);
    console.log(`  FAIL ${name}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(actual)}`);
  }
}

/** find prints in directory order; the tests sort so order is not asserted. */
const sorted = (script) => `cd /home/user\n${script} | sort\n`;

// ── the installer's own line ───────────────────────────────────────────────
await check(
  'mindepth 1 excludes the start path',
  sorted('find /home/user/extract -mindepth 1 -maxdepth 1 -type d'),
  { stdout: '/home/user/extract/other\n/home/user/extract/proteus\n' },
);

await check(
  'the installer picks a child, never the container',
  'cd /home/user\nfind /home/user/extract -mindepth 1 -maxdepth 1 -type d | sort | head -n 1\n',
  { stdout: '/home/user/extract/other\n' },
);

await check(
  'without mindepth the start path is still emitted',
  sorted('find /home/user/extract -maxdepth 1 -type d'),
  {
    stdout:
      '/home/user/extract\n/home/user/extract/other\n/home/user/extract/proteus\n',
  },
);

await check(
  'mindepth 2 maxdepth 2 is the grandchild band',
  sorted('find /home/user/extract -mindepth 2 -maxdepth 2'),
  {
    stdout:
      '/home/user/extract/proteus/bin\n'
      + '/home/user/extract/proteus/package.json\n'
      + '/home/user/extract/proteus/src\n',
  },
);

await check('maxdepth 0 is the start path alone',
  sorted('find /home/user/extract -maxdepth 0'), { stdout: '/home/user/extract\n' });

// ── unknown predicates fail loudly ────────────────────────────────────────
// GNU: `find: unknown predicate '-bogus'`, exit 1, nothing on stdout.
await check(
  'an unknown predicate is refused, not ignored',
  'cd /home/user\nfind extract -bogus\n',
  { stdout: '', exitCode: 1, stderr: "find: unknown predicate `-bogus'\n" },
);

await check(
  'a predicate missing its argument is refused',
  'cd /home/user\nfind extract -mindepth\n',
  { stdout: '', exitCode: 1, stderr: "find: missing argument to `-mindepth'\n" },
);

await check(
  '-maxdepth rejects a non-numeric argument',
  'cd /home/user\nfind extract -maxdepth abc\n',
  {
    stdout: '',
    exitCode: 1,
    stderr: "find: Expected a positive decimal integer argument to -maxdepth, but got `abc'\n",
  },
);

await check(
  '-type rejects an unknown letter',
  'cd /home/user\nfind extract -type x\n',
  { stdout: '', exitCode: 1, stderr: 'find: Unknown argument to -type: x\n' },
);

await check(
  'a missing start path is reported and exits 1',
  'cd /home/user\nfind nosuchdir\n',
  { stdout: '', exitCode: 1, stderr: "find: 'nosuchdir': No such file or directory\n" },
);

// ── operators: the silently-dropped category ──────────────────────────────
await check('! negates the following test',
  sorted('find extract -maxdepth 1 ! -type d'),
  { stdout: 'extract/3k.bin\nextract/empty.txt\n' });

await check('-not is a synonym for !',
  sorted('find extract -maxdepth 1 -not -type d'),
  { stdout: 'extract/3k.bin\nextract/empty.txt\n' });

await check('-o is disjunction',
  sorted('find extract -name src -o -name bin'),
  { stdout: 'extract/proteus/bin\nextract/proteus/src\n' });

await check('-a is explicit conjunction',
  sorted('find extract -type d -a -name bin'),
  { stdout: 'extract/proteus/bin\n' });

await check('-a binds tighter than -o',
  sorted('find extract -name other -o -type f -a -name a.ts'),
  { stdout: 'extract/other\nextract/proteus/src/a.ts\n' });

await check('parentheses regroup',
  sorted("find extract \\( -name other -o -name a.ts \\) -a -type d"),
  { stdout: 'extract/other\n' });

// ── relative start paths print relative ───────────────────────────────────
// GNU prints paths as given: a relative start argument yields relative output.
await check('a relative start path prints relative paths',
  sorted('find extract -maxdepth 1 -type d'),
  { stdout: 'extract\nextract/other\nextract/proteus\n' });

await check('a dot start path prints ./-prefixed paths',
  sorted('cd extract && find . -maxdepth 1 -type d'),
  { stdout: '.\n./other\n./proteus\n' });

await check('no start path at all behaves as .',
  sorted('cd extract && find -maxdepth 1 -type d'),
  { stdout: '.\n./other\n./proteus\n' });

await check('multiple start paths are all walked',
  sorted('find extract/other extract/proteus/bin'),
  { stdout: 'extract/other\nextract/proteus/bin\nextract/proteus/bin/cli\n' });

// ── -prune ────────────────────────────────────────────────────────────────
await check('-prune stops the descent and is not an action',
  sorted('find extract -name proteus -prune'),
  { stdout: 'extract/proteus\n' });

await check('the -prune / -o idiom skips a subtree',
  sorted('find extract -name proteus -prune -o -print'),
  { stdout: 'extract\nextract/3k.bin\nextract/empty.txt\nextract/other\n' });

// ── -size rounds up to whole blocks, as GNU does ──────────────────────────
// 3000 bytes is 5.86 512-byte blocks, so it is 6 blocks and not 5.
await check('-size counts rounded-up 512-byte blocks',
  sorted('find extract -name 3k.bin -size 6'), { stdout: 'extract/3k.bin\n' });
await check('-size does not match the rounded-down block count',
  sorted('find extract -name 3k.bin -size 5'), { stdout: '' });
await check('-size c is exact bytes',
  sorted('find extract -name 3k.bin -size 3000c'), { stdout: 'extract/3k.bin\n' });
await check('-size k rounds up to whole KiB',
  sorted('find extract -name 3k.bin -size 3k'), { stdout: 'extract/3k.bin\n' });
await check('-size + compares greater',
  sorted('find extract -name 3k.bin -size +2k'), { stdout: 'extract/3k.bin\n' });

// ── -empty distinguishes empty dirs from empty files ──────────────────────
await check('-empty matches zero-byte files and childless directories',
  sorted('find extract -empty'),
  { stdout: 'extract/empty.txt\nextract/other\n' });

// ── -iname / -path ────────────────────────────────────────────────────────
await check('-iname matches case-insensitively',
  sorted("find extract -iname '*.TS'"), { stdout: 'extract/proteus/src/a.ts\n' });

await check('-path matches the whole path',
  sorted("find extract -path '*/src/*'"), { stdout: 'extract/proteus/src/a.ts\n' });

// ── actions ───────────────────────────────────────────────────────────────
// An explicit action suppresses the implicit -print; -prune does not.
await check('-exec runs the command once per match',
  sorted("find extract -name a.ts -exec echo GOT {} \\;"),
  { stdout: 'GOT extract/proteus/src/a.ts\n' });

// The terminator is exactly `;`. `\;` is the shell's escaping of it, so a
// QUOTED '\;' keeps its backslash and GNU rejects it — measured, not assumed.
await check('a quoted \\; is not a terminator',
  "cd /home/user\nfind extract -name a.ts -exec echo GOT {} '\\;'\n",
  { stdout: '', exitCode: 1, stderr: "find: missing argument to `-exec'\n" });

// `-exec … +` batches every match into ONE invocation — one line carrying
// every path, not one line per path.
await check('-exec + passes every match in one invocation',
  "cd /home/user\nfind extract \\( -name a.ts -o -name cli \\) -exec echo GOT {} +\n",
  { stdout: 'GOT extract/proteus/bin/cli extract/proteus/src/a.ts\n' });

// An explicit action suppresses the implicit -print, so the left branch of
// `-o` produces nothing at all when only the right branch carries -exec.
await check('an action anywhere suppresses the implicit -print',
  'cd /home/user\nfind extract -name a.ts -o -name cli -exec echo GOT {} +\n',
  { stdout: 'GOT extract/proteus/bin/cli\n' });

await check('-print0 terminates with NUL and no newline',
  'cd /home/user\nfind extract -name a.ts -print0\n',
  { stdout: 'extract/proteus/src/a.ts\0' });

await check('-depth visits children before their parent',
  'cd /home/user\nfind extract/proteus/src -depth\n',
  { stdout: 'extract/proteus/src/a.ts\nextract/proteus/src\n' });

await check('-quit stops the walk and suppresses the implicit print',
  'cd /home/user\nfind extract -quit\n', { stdout: '' });

await check('-delete removes the matched entries',
  'cd /home/user\nmkdir -p del/sub && touch del/sub/f && find del -delete\n'
  + 'if [ -d del ]; then echo STILL-THERE; else echo GONE; fi\n',
  { stdout: 'GONE\n' });

if (failures.length > 0) {
  console.error(`\nfind-expression-evaluator: ${failures.length} failing case(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`find-expression-evaluator: ok (${caseNo} cases)`);
