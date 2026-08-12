#!/usr/bin/env bun

// ls / rm / ln / touch / file / sha256sum / tree / xxd / whereis all kept
// their operands with `args.filter(a => !a.startsWith('-'))`, discarding every
// flag they did not implement. `ls -h` printed raw byte counts, `touch -c`
// created the file it was told not to create, `file -b` printed the prefix it
// was told to omit — all without a word. Each flag now works or is refused.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.mkdir('etc', { recursive: true });
kernel.writeFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home/user:/bin/sh\n');
kernel.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');

const commands = new Map();
const registry = {
  register: (name, fn) => commands.set(name, fn),
  registerLazy: (name, loader) => commands.set(name, loader),
  has: (name) => commands.has(name),
  get: (name) => commands.get(name),
  unregister: (name) => commands.delete(name),
  list: () => [...commands.keys()],
};
registerUnixCommands(registry, vfs);

async function run(name, args, cwd = '/home/user') {
  const out = [];
  const err = [];
  const exitCode = await commands.get(name)({
    args,
    cwd,
    env: {},
    cred: CRED_KERNEL,
    vfs: kernel,
    stdout: { write: (d) => out.push(d) },
    stderr: { write: (d) => err.push(d) },
    signal: new AbortController().signal,
  });
  return { exitCode, stdout: out.join(''), stderr: err.join('') };
}

// ── every command refuses an option it does not implement ─────────────────
for (const [name, badExit] of [
  ['ls', 2], ['rm', 1], ['ln', 1], ['touch', 1], ['file', 1],
  ['sha256sum', 1], ['tree', 1], ['xxd', 1], ['whereis', 1], ['read', 1],
]) {
  const refused = await run(name, ['--definitely-not-a-flag']);
  assert.equal(refused.exitCode, badExit, `${name} exit on unknown option`);
  assert.match(
    refused.stderr,
    /unrecognized option '--definitely-not-a-flag'/,
    `${name} names the option it refused`,
  );
  assert.equal(refused.stdout, '', `${name} emits nothing when it refused`);
}

// `rm -i` asks for a confirmation this shell cannot show. It must be refused
// rather than accepted-and-ignored, which would delete without confirming.
kernel.writeFile('home/user/precious.txt', 'keep\n');
const interactive = await run('rm', ['-i', 'precious.txt']);
assert.equal(interactive.exitCode, 1);
assert.match(interactive.stderr, /invalid option -- 'i'/);
assert.ok(kernel.exists('home/user/precious.txt'), 'rm -i must not delete');

// ── touch ─────────────────────────────────────────────────────────────────
// -c must NOT create a missing file. It used to be dropped, so it did.
const noCreate = await run('touch', ['-c', 'absent.txt']);
assert.equal(noCreate.exitCode, 0, noCreate.stderr);
assert.equal(kernel.exists('home/user/absent.txt'), false, 'touch -c created a file');

// Without -c the file appears, so the flag is what made the difference.
await run('touch', ['present.txt']);
assert.ok(kernel.exists('home/user/present.txt'));

// -t sets the timestamp instead of using "now".
const stamped = await run('touch', ['-t', '202001020304.05', 'present.txt']);
assert.equal(stamped.exitCode, 0, stamped.stderr);
assert.equal(
  kernel.stat('home/user/present.txt').mtime,
  new Date(2020, 0, 2, 3, 4, 5).getTime(),
);

// -d takes a parseable date, and -r copies another file's timestamp.
await run('touch', ['-d', '2021-03-04T05:06:07Z', 'dated.txt']);
assert.equal(kernel.stat('home/user/dated.txt').mtime, Date.parse('2021-03-04T05:06:07Z'));
await run('touch', ['-r', 'dated.txt', 'copied.txt']);
assert.equal(
  kernel.stat('home/user/copied.txt').mtime,
  kernel.stat('home/user/dated.txt').mtime,
);

// A timestamp that is not a timestamp is an error, not a silent "now".
const badStamp = await run('touch', ['-t', 'not-a-date', 'x.txt']);
assert.equal(badStamp.exitCode, 1);
assert.match(badStamp.stderr, /invalid date format/);

// touch must not truncate an existing file.
kernel.writeFile('home/user/keep.txt', 'contents\n');
await run('touch', ['keep.txt']);
assert.equal(kernel.readFileString('home/user/keep.txt'), 'contents\n');

// ── ls ────────────────────────────────────────────────────────────────────
kernel.writeFile('home/user/big.bin', new Uint8Array(4096));
kernel.writeFile('home/user/.hidden', 'x\n');

const human = await run('ls', ['-lh', 'big.bin']);
assert.match(human.stdout, /\b4\.0K\b/, `ls -lh should scale the size: ${human.stdout}`);

// Without -h the same listing reports raw bytes, so -h changed the output.
const raw = await run('ls', ['-l', 'big.bin']);
assert.match(raw.stdout, /\b4096\b/);

// -a reveals dotfiles; the default hides them.
const withHidden = await run('ls', ['-a']);
assert.match(withHidden.stdout, /\.hidden/);
const withoutHidden = await run('ls', []);
assert.doesNotMatch(withoutHidden.stdout, /\.hidden/);

// -F appends a type sigil.
const classified = await run('ls', ['-F', 'big.bin']);
assert.match(classified.stdout, /big\.bin/);

// -r reverses the order.
const forward = await run('ls', ['-1']);
const reversed = await run('ls', ['-1r']);
assert.deepEqual(
  reversed.stdout.trim().split('\n'),
  forward.stdout.trim().split('\n').reverse(),
);

// ── file ──────────────────────────────────────────────────────────────────
kernel.writeFile('home/user/hello.txt', 'plain text\n');
const named = await run('file', ['hello.txt']);
assert.match(named.stdout, /^hello\.txt: /);

// -b drops the `name:` prefix it used to print regardless.
const brief = await run('file', ['-b', 'hello.txt']);
assert.doesNotMatch(brief.stdout, /hello\.txt/);
assert.match(brief.stdout, /ASCII text/);

const mime = await run('file', ['-i', 'hello.txt']);
assert.match(mime.stdout, /text\/plain/);

// ── sha256sum ─────────────────────────────────────────────────────────────
// The digest must be over the file's BYTES. Hashing went through a UTF-8
// decode first, so any byte that is not valid UTF-8 hashed as U+FFFD.
kernel.writeFile('home/user/binary.bin', new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
const digest = await run('sha256sum', ['binary.bin']);
assert.match(digest.stdout, /^[0-9a-f]{64} {2}binary\.bin\n$/, digest.stderr);
const digestHex = digest.stdout.slice(0, 64);

// The same bytes through a UTF-8 round trip give a DIFFERENT digest; proving
// they differ is what proves the raw-byte path is the one in use.
const mangled = new TextEncoder().encode(
  new TextDecoder('utf-8').decode(new Uint8Array([0xff, 0xfe, 0x00, 0x01])),
);
const mangledDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', mangled))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');
assert.notEqual(digestHex, mangledDigest, 'sha256sum must hash raw bytes, not a UTF-8 round trip');

const expected = [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new Uint8Array([0xff, 0xfe, 0x00, 0x01])),
)].map((b) => b.toString(16).padStart(2, '0')).join('');
assert.equal(digestHex, expected);

// -c verifies a checklist and reports each result.
kernel.writeFile('home/user/sums.txt', `${expected}  binary.bin\n`);
const checked = await run('sha256sum', ['-c', 'sums.txt']);
assert.equal(checked.exitCode, 0, checked.stderr);
assert.match(checked.stdout, /binary\.bin: OK/);

kernel.writeFile('home/user/bad-sums.txt', `${'0'.repeat(64)}  binary.bin\n`);
const failedCheck = await run('sha256sum', ['-c', 'bad-sums.txt']);
assert.equal(failedCheck.exitCode, 1);
assert.match(failedCheck.stdout, /binary\.bin: FAILED/);

// ── tree ──────────────────────────────────────────────────────────────────
kernel.mkdir('home/user/proj/sub', { recursive: true });
kernel.writeFile('home/user/proj/a.txt', 'a\n');
kernel.writeFile('home/user/proj/.dot', 'd\n');

const shallow = await run('tree', ['-L', '1', 'proj']);
assert.doesNotMatch(shallow.stdout, /sub\n.*a\.txt/s, 'depth 1 should not recurse');

// Dotfiles are hidden unless -a, which is what makes -a mean anything.
const treeDefault = await run('tree', ['proj']);
assert.doesNotMatch(treeDefault.stdout, /\.dot/);
const treeAll = await run('tree', ['-a', 'proj']);
assert.match(treeAll.stdout, /\.dot/);

const dirsOnly = await run('tree', ['-d', 'proj']);
assert.doesNotMatch(dirsOnly.stdout, /a\.txt/);
assert.match(dirsOnly.stdout, /sub/);

const noReport = await run('tree', ['--noreport', 'proj']);
assert.doesNotMatch(noReport.stdout, /directories, /);

// A level that is not a number is refused rather than silently defaulted.
const badLevel = await run('tree', ['-L', 'deep', 'proj']);
assert.equal(badLevel.exitCode, 1);
assert.match(badLevel.stderr, /Invalid level/);

// ── xxd ───────────────────────────────────────────────────────────────────
kernel.writeFile('home/user/hex.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
const limited = await run('xxd', ['-l', '4', 'hex.bin']);
assert.equal(limited.stdout.trim().split('\n').length, 1);
assert.match(limited.stdout, /^00000000: 01 02 03 04/);

// -s skips, and the offset column reflects the skip.
const skipped = await run('xxd', ['-s', '4', '-l', '4', 'hex.bin']);
assert.match(skipped.stdout, /^00000004: 05 06 07 08/);

// -c sets the column count; it used to be dropped and 16 always used.
const narrow = await run('xxd', ['-c', '4', 'hex.bin']);
assert.equal(narrow.stdout.trim().split('\n').length, 2);

// ── rm ────────────────────────────────────────────────────────────────────
kernel.mkdir('home/user/empty', { recursive: true });
const rmDir = await run('rm', ['emptyy']);
assert.equal(rmDir.exitCode, 1);

// -d removes an empty directory, and refuses a non-empty one.
const removedEmpty = await run('rm', ['-d', 'empty']);
assert.equal(removedEmpty.exitCode, 0, removedEmpty.stderr);
assert.equal(kernel.exists('home/user/empty'), false);

kernel.mkdir('home/user/full', { recursive: true });
kernel.writeFile('home/user/full/f.txt', 'x\n');
const refusedFull = await run('rm', ['-d', 'full']);
assert.equal(refusedFull.exitCode, 1);
assert.ok(kernel.exists('home/user/full'));

// -v names what it removed.
const verbose = await run('rm', ['-rv', 'full']);
assert.equal(verbose.exitCode, 0, verbose.stderr);
assert.match(verbose.stdout, /removed 'full'/);

// ── du ────────────────────────────────────────────────────────────────────
kernel.mkdir('home/user/sized', { recursive: true });
kernel.writeFile('home/user/sized/four-k.bin', new Uint8Array(4096));

// -h is 1024-based, like every other human size GNU prints. It used to
// divide by 1000 and still label the result K.
const duHuman = await run('du', ['-sh', 'sized']);
assert.match(duHuman.stdout, /4\.0K/, `du -sh should be 1024-based: ${duHuman.stdout}`);

const duBlocks = await run('du', ['-s', 'sized']);
assert.match(duBlocks.stdout, /^4\b/, duBlocks.stderr);

const duRefused = await run('du', ['--definitely-not-a-flag']);
assert.equal(duRefused.exitCode, 1);
assert.match(duRefused.stderr, /unrecognized option '--definitely-not-a-flag'/);

// ── whereis ───────────────────────────────────────────────────────────────
// -b asks for binaries, which is all this filesystem has, so it is accepted.
const binaries = await run('whereis', ['-b', 'ls']);
assert.equal(binaries.exitCode, 0, binaries.stderr);
assert.match(binaries.stdout, /^ls:/);

// -m has nothing to search and is refused rather than answered emptily.
const manuals = await run('whereis', ['-m', 'ls']);
assert.equal(manuals.exitCode, 1);
assert.match(manuals.stderr, /invalid option -- 'm'/);

console.log('unix-fs-command-flags: ok');
