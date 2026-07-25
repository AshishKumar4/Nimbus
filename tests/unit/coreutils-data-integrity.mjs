#!/usr/bin/env bun
/**
 * coreutils-data-integrity — byte-exactness of the shell's file plumbing.
 *
 * Every case here failed before by producing the WRONG NUMBER OF BYTES with a
 * zero exit status, which is worse than failing:
 *
 *   - `cat a b c > out` kept only the last operand, because a `>` redirection
 *     rewrote the whole file on every write instead of advancing an offset.
 *   - `dd bs=1024 count=1024 if=/dev/zero` wrote whatever a single read of
 *     /dev/zero returned (64 KiB), not 1 MiB.
 *   - `head -c` did not exist, and /dev/zero was invisible to it.
 *   - /dev/* claimed to be empty regular files rather than character devices.
 *
 * The harness is the live session shape: SqliteVFS mounted into the kernel VFS
 * plus registerUnixCommands, i.e. exactly the commands a prod terminal runs.
 */

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const MB = 1024 * 1024;

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

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log(`  ok   ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

async function sh(line) {
  return box.shell.execute(line, {});
}

function size(path) {
  return rawVfs.as(CRED_KERNEL).stat(path).size;
}

function bytes(path) {
  return rawVfs.as(CRED_KERNEL).readFile(path);
}

// ── cat concatenates every operand, at any size ────────────────────────────
for (let i = 0; i < 6; i++) {
  root.writeFile(`tmp/f${i}`, String.fromCharCode(97 + i).repeat(MB), { mode: 0o644 });
}

let r = await sh('cat /tmp/f0 /tmp/f1 /tmp/f2 /tmp/f3 /tmp/f4 /tmp/f5 > /tmp/six');
check('cat of six 1 MB files exits 0', r.exitCode === 0, `stderr=${r.stderr}`);
check('cat of six 1 MB files writes 6291456 bytes', size('tmp/six') === 6 * MB,
  `got ${size('tmp/six')}`);
{
  const out = bytes('tmp/six');
  const boundariesIntact = [0, 1, 2, 3, 4, 5].every((i) =>
    out[i * MB] === 97 + i && out[(i + 1) * MB - 1] === 97 + i);
  check('cat preserves every operand in order', boundariesIntact);
}

// ── > truncates on open, >> continues from the end ─────────────────────────
await sh('cat /tmp/f0 > /tmp/six');
check('a later `>` truncates to just the new content', size('tmp/six') === MB,
  `got ${size('tmp/six')}`);

await sh('cat /tmp/f1 /tmp/f2 >> /tmp/six');
check('`>>` appends without rewriting the file', size('tmp/six') === 3 * MB,
  `got ${size('tmp/six')}`);

// O_APPEND: a second descriptor opened on the same file lands after the first,
// it does not overwrite from a stale offset.
await sh('printf one > /tmp/app; printf two >> /tmp/app; printf three >> /tmp/app');
check('successive `>>` descriptors each land at the end',
  new TextDecoder().decode(bytes('tmp/app')) === 'onetwothree',
  JSON.stringify(new TextDecoder().decode(bytes('tmp/app'))));

// ── line-at-a-time producers keep every line ───────────────────────────────
// `seq` writes one stdout call per line. Before, each call replaced the whole
// file, so `seq 1 N > f` left a file holding only the last number.
r = await sh('seq 1 20000 > /tmp/seq');
check('seq 1 20000 > f exits 0', r.exitCode === 0, `stderr=${r.stderr}`);
{
  const expected = Array.from({ length: 20000 }, (_, i) => i + 1).join('\n') + '\n';
  const actual = new TextDecoder().decode(bytes('tmp/seq'));
  check('seq writes every line, in order', actual === expected,
    `${actual.length} bytes vs ${expected.length}`);
}

r = await sh('seq 1 5 > /tmp/seq5; cat /tmp/seq5');
check('a buffered redirect is visible to the next command',
  r.stdout === '1\n2\n3\n4\n5\n', JSON.stringify(r.stdout));

// ── a 25 MB copy streams rather than buffering ─────────────────────────────
root.writeFile('tmp/big', 'x'.repeat(25 * MB), { mode: 0o644 });
r = await sh('cat /tmp/big > /tmp/big-copy');
check('25 MB cat exits 0', r.exitCode === 0, `stderr=${r.stderr}`);
check('25 MB cat is byte-exact', size('tmp/big-copy') === 25 * MB,
  `got ${size('tmp/big-copy')}`);

// ── dd honours bs/count/skip/seek ──────────────────────────────────────────
r = await sh('dd if=/dev/zero of=/tmp/z bs=1024 count=1024 status=none');
check('dd bs=1024 count=1024 exits 0', r.exitCode === 0, `stderr=${r.stderr}`);
check('dd bs=1024 count=1024 writes exactly 1 MiB', size('tmp/z') === MB,
  `got ${size('tmp/z')}`);
check('dd from /dev/zero writes zeros', bytes('tmp/z').every((b) => b === 0));

r = await sh('dd if=/tmp/f0 of=/tmp/part bs=1M count=1 status=none');
check('dd understands the 1M suffix', size('tmp/part') === MB, `got ${size('tmp/part')}`);

root.writeFile('tmp/abc', 'ABCDEFGH', { mode: 0o644 });
await sh('dd if=/tmp/abc of=/tmp/skipped bs=1 skip=3 count=4 status=none');
check('dd skip= offsets the input',
  new TextDecoder().decode(bytes('tmp/skipped')) === 'DEFG',
  JSON.stringify(new TextDecoder().decode(bytes('tmp/skipped'))));

await sh('dd if=/tmp/abc of=/tmp/sought bs=1 count=2 seek=4 status=none');
check('dd seek= offsets the output', size('tmp/sought') === 6, `got ${size('tmp/sought')}`);

r = await sh('dd if=/dev/zero of=/tmp/nope status=none');
check('dd without count on an endless device fails loudly', r.exitCode === 1,
  `exit=${r.exitCode}`);
check('dd failure explains itself', /count=/.test(r.stderr), `stderr=${r.stderr}`);

// ── head -c ────────────────────────────────────────────────────────────────
r = await sh('head -c 1000000 /dev/zero > /tmp/hz');
check('head -c on /dev/zero exits 0', r.exitCode === 0, `stderr=${r.stderr}`);
check('head -c 1000000 /dev/zero yields exactly 1000000 bytes', size('tmp/hz') === 1000000,
  `got ${size('tmp/hz')}`);
check('head -c /dev/zero yields zero bytes', bytes('tmp/hz').every((b) => b === 0));

r = await sh('head -c 5 /tmp/abc');
check('head -c reads a prefix of a regular file', r.stdout === 'ABCDE',
  JSON.stringify(r.stdout));

r = await sh('head -c 1K /tmp/f0 > /tmp/hk');
check('head -c accepts a size suffix', size('tmp/hk') === 1024, `got ${size('tmp/hk')}`);

r = await sh('head -n 1 /tmp/abc');
check('head -n still works', r.stdout === 'ABCDEFGH\n', JSON.stringify(r.stdout));

r = await sh('cat /tmp/abc | head -c 3');
check('head -c reads from a pipe', r.stdout === 'ABC', JSON.stringify(r.stdout));

// ── /dev nodes are character devices ───────────────────────────────────────
r = await sh('ls -la /dev');
check('ls -l renders /dev entries as character devices',
  /^c/m.test(r.stdout) && !/^-rw-rw-rw-.*zero/m.test(r.stdout),
  JSON.stringify(r.stdout));
for (const device of ['null', 'zero', 'full', 'random', 'urandom', 'tty', 'stdin', 'stdout', 'stderr']) {
  check(`ls /dev lists ${device}`, r.stdout.includes(device));
}

r = await sh('stat /dev/zero');
check('stat reports a character special file', /character special file/.test(r.stdout),
  JSON.stringify(r.stdout));

r = await sh('cat /dev/null; echo RC=$?');
check('cat /dev/null is empty and succeeds', r.stdout === 'RC=0\n', JSON.stringify(r.stdout));

r = await sh('cat /dev/zero > /tmp/endless');
check('cat of an endless device fails instead of inventing a length', r.exitCode !== 0,
  `exit=${r.exitCode}`);
check('cat of an endless device says why', /bounded slice/.test(r.stderr), `stderr=${r.stderr}`);

r = await sh('head -c 32 /dev/urandom > /tmp/rand');
check('head -c on /dev/urandom yields 32 bytes', size('tmp/rand') === 32, `got ${size('tmp/rand')}`);

await sh('echo discarded > /dev/null; echo RC=$?');
r = await sh('echo kept > /dev/stdout');
check('> /dev/stdout writes to stdout, not into the device', r.stdout === 'kept\n',
  JSON.stringify(r.stdout));

// ── curl -d @file sends the file, not the literal "@path" ──────────────────
box.kernel.portRegistry.set(8131, (req, res) => {
  res.statusCode = 200;
  res.body = `METHOD=${req.method} LEN=${req.body.length} BODY=${req.body}`;
});

root.writeFile('tmp/payload.json', '{"a":1}\n', { mode: 0o644 });

r = await sh('curl -s -d @/tmp/payload.json http://127.0.0.1:8131/');
check('curl -d @file sends the file contents', r.stdout.includes('BODY={"a":1}'),
  JSON.stringify(r.stdout));
check('curl -d @file strips newlines like curl does', r.stdout.includes('LEN=7'),
  JSON.stringify(r.stdout));
check('curl -d implies POST', r.stdout.includes('METHOD=POST'), JSON.stringify(r.stdout));

r = await sh('curl -s --data-binary @/tmp/payload.json http://127.0.0.1:8131/');
check('curl --data-binary @file keeps the trailing newline', r.stdout.includes('LEN=8'),
  JSON.stringify(r.stdout));

r = await sh('curl -s --data-raw @/tmp/payload.json http://127.0.0.1:8131/');
check('curl --data-raw takes @ literally', r.stdout.includes('BODY=@/tmp/payload.json'),
  JSON.stringify(r.stdout));

r = await sh('curl -s -d @/tmp/missing.json http://127.0.0.1:8131/');
check('curl -d @missing fails instead of sending the path', r.exitCode !== 0,
  `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);

r = await sh('curl -s -d a=1 -d b=2 http://127.0.0.1:8131/');
check('curl joins repeated -d operands with &', r.stdout.includes('BODY=a=1&b=2'),
  JSON.stringify(r.stdout));

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
