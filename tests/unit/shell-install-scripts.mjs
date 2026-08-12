#!/usr/bin/env bun
/**
 * shell-install-scripts — what a real `curl … | bash` installer needs.
 *
 * The owner's command,
 *
 *     curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash
 *
 * cleared its platform gate and then stopped, in order, on: `unzip -oqd`
 * (clustered short flags rejected outright), `mv` (every rename inside a
 * mounted filesystem reported "cannot rename across mount boundaries", and
 * there was no cross-device fallback at all), `x="$(cmd)"` swallowing cmd's
 * exit status so `|| die` never fired, a missing `local`, and missing arrays.
 * None of those are specific to that installer — they are the ordinary
 * vocabulary of shell scripts.
 *
 * Every expectation was produced by running the identical snippet under real
 * GNU bash, and everything runs through the command registry a session
 * resolves through: registerUnixCommands + registerShellEntrypointCommands +
 * installPathExecResolver, driven as `bash script`, never a directly
 * constructed interpreter.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { installPathExecResolver } from '../../packages/core/src/shell/exec-dispatch.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { installCompressionStreams } from './lib/web-compression-streams.mjs';

// gzip is a Workers global; this host is bun, which lacks it. Without this the
// archive commands cannot be exercised at all — which is how their argument
// handling stayed broken.
installCompressionStreams();

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
  const path = `tmp/case${caseNo++}.sh`;
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

// ── clustered short flags ──────────────────────────────────────────────────
// POSIX Utility Syntax Guideline 5: `-oqd` is `-o -q -d`. Rejecting the
// cluster is what stopped the bun installer's `unzip -oqd "$bin_dir" …`.

await check('unzip accepts a cluster ending in an option that takes a value',
  `cd /tmp\nmkdir -p src out\nprintf payload > src/f.txt\nzip -q a.zip src/f.txt\n` +
  `unzip -oqd out a.zip\necho "rc=$?"\ncat out/src/f.txt\necho\n`,
  { stdout: 'rc=0\npayload\n' });

await check('unzip -q suppresses the extraction listing',
  `cd /tmp\nmkdir -p q\nprintf payload > q/f.txt\nzip -q q.zip q/f.txt\nrm -rf q\nunzip -oq q.zip\n`,
  { stdout: '' });

await check('unzip without -q names each entry it extracted',
  `cd /tmp\nmkdir -p v\nprintf payload > v/f.txt\nzip -q v.zip v/f.txt\nrm -rf v\n` +
  `unzip -o v.zip | grep -c v/f.txt\n`,
  { stdout: '1\n' });

await check('unzip -d creates the destination directory',
  `cd /tmp\nprintf p > d1.txt\nzip -q d1.zip d1.txt\nunzip -q -d made/deeper d1.zip\ncat made/deeper/d1.txt\necho\n`,
  { stdout: 'p\n' });

await check('an option the command does not have is still an error',
  `cd /tmp\nprintf p > e.txt\nzip -q e.zip e.txt\nunzip -oZ e.zip\necho "rc=$?"\n`,
  { stdout: 'rc=1\n', stderr: 'unzip: invalid option: -Z\n' });

await check('gzip -dk is -d -k, and keeps the original',
  `cd /tmp\nprintf body > g.txt\ngzip g.txt\ngzip -dk g.txt.gz\ncat g.txt\necho\n`
  + `test -f g.txt.gz && echo kept\n`,
  { stdout: 'body\nkept\n' });

await check('gzip round-trips a file through a real gzip stream',
  `cd /tmp\nprintf 'the payload' > r.txt\ngzip r.txt\ntest ! -e r.txt && echo source-gone\n`
  + `gunzip r.txt.gz\ncat r.txt\necho\n`,
  { stdout: 'source-gone\nthe payload\n' });

await check('gzip accepts a compression level and ignores it',
  `cd /tmp\nprintf body > lv.txt\ngzip -9 lv.txt\ntest -f lv.txt.gz && echo compressed\n`,
  { stdout: 'compressed\n' });

await check('gunzip -k keeps the compressed file',
  `cd /tmp\nprintf body > k.txt\ngzip k.txt\ngunzip -k k.txt.gz\ncat k.txt\necho\n`
  + `test -f k.txt.gz && echo kept\n`,
  { stdout: 'body\nkept\n' });

await check('tar -czf then -xzf round-trips a directory',
  `cd /tmp\nmkdir -p t/inner\nprintf leaf > t/inner/f.txt\ntar -czf t.tgz t\n`
  + `rm -rf t\nmkdir -p out\ntar -xzf t.tgz -C out\ncat out/t/inner/f.txt\necho\n`,
  { stdout: 'leaf\n' });

await check('tar stores a multi-component operand under the path given',
  `cd /tmp\nmkdir -p m/sub\nprintf x > m/sub/f\ntar -czf m.tgz m/sub/f\ntar -tzf m.tgz\n`,
  { stdout: 'm/sub/f\n' });

await check('gunzip still rejects an option it does not have',
  `cd /tmp\ngunzip -Z absent.gz\necho "rc=$?"\n`,
  { stdout: 'rc=1\n', stderr: "gunzip: invalid option -- 'Z'\n" });

// ── mv ─────────────────────────────────────────────────────────────────────
// Every mount hands out a fresh credentialed view per lookup, so comparing the
// two derived providers never matched and *every* rename inside one filesystem
// failed. Renames between two mounts are a genuine EXDEV, which `mv` resolves
// by copying and then removing the source — `mv "$tmp/download" "$HOME/bin/x"`
// is in both installers.

await check('mv renames within one mount',
  'set -e\nmkdir -p /home/user/m/sub\nprintf body > /home/user/m/sub/f\n' +
  'mv /home/user/m/sub/f /home/user/m/g\ncat /home/user/m/g\necho\n' +
  'test ! -e /home/user/m/sub/f && echo source-gone\n',
  { stdout: 'body\nsource-gone\n' });

await check('mv moves across two mounts',
  'set -e\nprintf body > /tmp/x1\nmv /tmp/x1 /home/user/x1\ncat /home/user/x1\necho\n' +
  'test ! -e /tmp/x1 && echo source-gone\n',
  { stdout: 'body\nsource-gone\n' });

await check('mv across mounts carries the mode',
  'set -e\nprintf "#!/bin/sh\\necho ran\\n" > /tmp/x2\nchmod 755 /tmp/x2\n' +
  'mv /tmp/x2 /home/user/x2\nstat -c %a /home/user/x2\n',
  { stdout: '755\n' });

await check('mv moves a directory across mounts',
  'set -e\nmkdir -p /tmp/tree/inner\nprintf leaf > /tmp/tree/inner/f\n' +
  'mv /tmp/tree /home/user/tree\ncat /home/user/tree/inner/f\necho\n' +
  'test ! -e /tmp/tree && echo source-gone\n',
  { stdout: 'leaf\nsource-gone\n' });

await check('mv moves several sources into a directory',
  'set -e\nmkdir -p /home/user/many\nprintf a > /tmp/a\nprintf b > /tmp/b\n' +
  'mv /tmp/a /tmp/b /home/user/many\ncat /home/user/many/a /home/user/many/b\necho\n',
  { stdout: 'ab\n' });

await check('mv -n keeps an existing destination',
  'set -e\nprintf old > /home/user/keep\nprintf new > /tmp/keep\n' +
  'mv -n /tmp/keep /home/user/keep\ncat /home/user/keep\necho\n',
  { stdout: 'old\n' });

// ── the exit status of an assignment ───────────────────────────────────────
// `help="$(… --help)" || die` never fired, so a failing download reported a
// misleading error several lines later.

await check('an assignment takes the status of its command substitution',
  'v="$(false)" || echo propagated\nw=$(exit 7)\necho "rc=$?"\n',
  { stdout: 'propagated\nrc=7\n' });

await check('an assignment from a command that succeeds is still 0',
  'ok=$(echo hi)\necho "ok=$ok rc=$?"\n',
  { stdout: 'ok=hi rc=0\n' });

await check('set -e aborts on an assignment whose substitution fails',
  'set -e\nx=$(exit 3)\necho UNREACHED\n',
  { stdout: '', exitCode: 3 });

await check('a substitution in an argument does not set the command status',
  'echo "$(false)"\necho "rc=$?"\n',
  { stdout: '\nrc=0\n' });

// ── arrays ────────────────────────────────────────────────────────────────
// `commands=(…)` and `"${arr[@]}"` are what the bun installer writes shell
// profiles with, and nothing in the shell understood either: the lexer broke
// the word at `(` so the list read as a subshell. Every expectation below is
// what real GNU bash prints for the same snippet.

await check("literal",
  "a=(x y z); echo \"${a[0]} ${a[1]} ${a[2]}\"\n",
  { stdout: "x y z\n" });
await check("whole @",
  "a=(x y z); echo \"${a[@]}\"\n",
  { stdout: "x y z\n" });
await check("whole *",
  "a=(x y z); echo \"${a[*]}\"\n",
  { stdout: "x y z\n" });
await check("bare name is [0]",
  "a=(x y z); echo \"$a\"\n",
  { stdout: "x\n" });
await check("count",
  "a=(x y z); echo \"${#a[@]}\"\n",
  { stdout: "3\n" });
await check("count star",
  "a=(x y z); echo \"${#a[*]}\"\n",
  { stdout: "3\n" });
await check("element length",
  "a=(xx yyy); echo \"${#a[1]}\"\n",
  { stdout: "3\n" });
await check("quoted @ fields",
  "a=(\"a b\" c); for e in \"${a[@]}\"; do echo \"[$e]\"; done\n",
  { stdout: "[a b]\n[c]\n" });
await check("unquoted @ splits",
  "a=(\"a b\" c); for e in ${a[@]}; do echo \"[$e]\"; done\n",
  { stdout: "[a]\n[b]\n[c]\n" });
await check("quoted * one field",
  "a=(\"a b\" c); for e in \"${a[*]}\"; do echo \"[$e]\"; done\n",
  { stdout: "[a b c]\n" });
await check("* joins on IFS",
  "IFS=-; a=(x y z); echo \"${a[*]}\"\n",
  { stdout: "x-y-z\n" });
await check("@ ignores IFS",
  "IFS=-; a=(x y z); echo \"${a[@]}\"\n",
  { stdout: "x y z\n" });
await check("empty array count",
  "a=(); echo \"${#a[@]}\"\n",
  { stdout: "0\n" });
await check("empty array @",
  "a=(); for e in \"${a[@]}\"; do echo \"[$e]\"; done; echo done\n",
  { stdout: "done\n" });
await check("empty array in args",
  "a=(); f(){ echo \"$#\"; }; f \"${a[@]}\"\n",
  { stdout: "0\n" });
await check("append",
  "a=(x); a+=(y z); echo \"${a[@]}\"\n",
  { stdout: "x y z\n" });
await check("append to empty",
  "a=(); a+=(y); echo \"${a[@]}\"\n",
  { stdout: "y\n" });
await check("element assign",
  "a=(x y); a[1]=Q; echo \"${a[@]}\"\n",
  { stdout: "x Q\n" });
await check("element beyond end",
  "a=(x); a[3]=Q; echo \"${a[@]}\"\n",
  { stdout: "x Q\n" });
await check("sparse count",
  "a=(x); a[3]=Q; echo \"${#a[@]}\"\n",
  { stdout: "2\n" });
await check("sparse indices",
  "a=(x); a[3]=Q; echo \"${!a[@]}\"\n",
  { stdout: "0 3\n" });
await check("dense indices",
  "a=(x y z); echo \"${!a[@]}\"\n",
  { stdout: "0 1 2\n" });
await check("negative index",
  "a=(x y z); echo \"${a[-1]}\"\n",
  { stdout: "z\n" });
await check("arithmetic index",
  "a=(x y z); i=1; echo \"${a[i+1]}\"\n",
  { stdout: "z\n" });
await check("dollar index",
  "a=(x y z); i=2; echo \"${a[$i]}\"\n",
  { stdout: "z\n" });
await check("unset element read",
  "a=(x); echo \"[${a[9]}]\"\n",
  { stdout: "[]\n" });
await check("default on element",
  "a=(x); echo \"${a[9]:-fb}\"\n",
  { stdout: "fb\n" });
await check("slice",
  "a=(p q r s); echo \"${a[@]:1:2}\"\n",
  { stdout: "q r\n" });
await check("slice to end",
  "a=(p q r s); echo \"${a[@]:2}\"\n",
  { stdout: "r s\n" });
await check("trim each",
  "a=(/a/x /a/y); echo \"${a[@]#/a/}\"\n",
  { stdout: "x y\n" });
await check("substitute each",
  "a=(ab cb); echo \"${a[@]/b/Z}\"\n",
  { stdout: "aZ cZ\n" });
await check("case each",
  "a=(ab cd); echo \"${a[@]^^}\"\n",
  { stdout: "AB CD\n" });
await check("from command sub",
  "a=($(echo p q r)); echo \"${#a[@]} ${a[1]}\"\n",
  { stdout: "3 q\n" });
await check("from positional",
  "f(){ local -a c; c=(\"$@\"); echo \"${#c[@]} [${c[0]}]\"; }; f \"x y\" z\n",
  { stdout: "2 [x y]\n" });
await check("quoted elements",
  "a=(\"x y\" \"z w\"); echo \"${#a[@]} [${a[0]}]\"\n",
  { stdout: "2 [x y]\n" });
await check("expansion in elem",
  "v=hi; a=($v there); echo \"${a[0]}-${a[1]}\"\n",
  { stdout: "hi-there\n" });
await check("scalar then index",
  "v=one; v[1]=two; echo \"${v[@]}\"\n",
  { stdout: "one two\n" });
await check("array then scalar",
  "a=(x y); a=plain; echo \"[${a[@]}] [${a[1]}]\"\n",
  { stdout: "[plain y] [y]\n" });
await check("unset whole",
  "a=(x y); unset a; echo \"[${a[@]}] ${#a[@]}\"\n",
  { stdout: "[] 0\n" });
await check("loop over array",
  "a=(one two); for e in \"${a[@]}\"; do echo \"-$e\"; done\n",
  { stdout: "-one\n-two\n" });
await check("array in condition",
  "a=(x); if [ \"${#a[@]}\" -gt 0 ]; then echo nonempty; fi\n",
  { stdout: "nonempty\n" });
await check("nested quotes",
  "a=(\"a\\\"b\"); echo \"${a[0]}\"\n",
  { stdout: "a\"b\n" });
await check("set -u empty array",
  "set -u; a=(); echo \"${#a[@]}\"; f(){ echo \"$#\"; }; f \"${a[@]}\"\n",
  { stdout: "0\n0\n" });
await check("append scalar",
  "v=a; v+=b; echo \"$v\"\n",
  { stdout: "ab\n" });
await check("append element",
  "a=(x y); a[0]+=Z; echo \"${a[@]}\"\n",
  { stdout: "xZ y\n" });
await check("bun config shape",
  "P=/bin; cmds=(\"export A=1\" \"export PATH=\\\"x:$P\\\"\"); for c in \"${cmds[@]}\"; do echo \"  $c\"; done\n",
  { stdout: "  export A=1\n  export PATH=\"x:/bin\"\n" });
await check("local basic",
  "f(){ local v=in; echo \"$v\"; }; v=out; f; echo \"$v\"\n",
  { stdout: "in\nout\n" });
await check("local unset outside",
  "f(){ local v=in; }; f; echo \"[${v-unset}]\"\n",
  { stdout: "[unset]\n" });
await check("local no value",
  "v=out; f(){ local v; echo \"[$v]\"; }; f; echo \"[$v]\"\n",
  { stdout: "[]\n[out]\n" });
await check("local several",
  "f(){ local a=1 b=2; echo \"$a$b\"; }; f\n",
  { stdout: "12\n" });
await check("local is dynamic",
  "g(){ echo \"$v\"; }; f(){ local v=inner; g; }; v=outer; f\n",
  { stdout: "inner\n" });
await check("local recursion",
  "f(){ local d=$1; [ \"$1\" -eq 0 ] && { echo \"$d\"; return; }; f $(( $1 - 1 )); echo \"$d\"; }; f 2\n",
  { stdout: "0\n1\n2\n" });
await check("local restores on return",
  "f(){ local v=x; return 3; }; v=keep; f; echo \"$? $v\"\n",
  { stdout: "3 keep\n" });
await check("local array",
  "f(){ local a=(p q); echo \"${#a[@]} ${a[1]}\"; }; a=(z); f; echo \"${a[@]}\"\n",
  { stdout: "2 q\nz\n" });
await check("local -r",
  "f(){ local -r c=1; echo \"$c\"; }; f\n",
  { stdout: "1\n" });
await check("declare in fn",
  "f(){ declare v=in; echo \"$v\"; }; v=out; f; echo \"$v\"\n",
  { stdout: "in\nout\n" });
await check("declare at top",
  "declare v=top; echo \"$v\"\n",
  { stdout: "top\n" });
await check("typeset alias",
  "f(){ typeset v=in; echo \"$v\"; }; f\n",
  { stdout: "in\n" });
await check("local shadows array",
  "f(){ local a; a=(1 2); echo \"${#a[@]}\"; }; a=(x y z); f; echo \"${#a[@]}\"\n",
  { stdout: "2\n3\n" });
await check("bash_configs shape",
  "cfg=(\"$HOME/.bash_profile\" \"$HOME/.bashrc\"); cfg+=(\"$HOME/x\"); echo \"${#cfg[@]}\"\n",
  { stdout: "3\n" });

// ── the shell's own options end at the script ─────────────────────────────
// `bash script.sh --help` printed the shell's usage and exited 0, because the
// entrypoint scanned all of argv for --help instead of parsing options up to
// the first operand. Any installer that runs `"$CLI" --help` got the shell's
// banner and concluded its download was broken.

await check('a script receives --help rather than the shell answering it',
  'printf \'#!/usr/bin/env bash\\necho "script saw: $*"\\n\' > /tmp/cli.sh\n'
  + 'chmod 755 /tmp/cli.sh\n/tmp/cli.sh --help\nbash /tmp/cli.sh --version\n',
  { stdout: 'script saw: --help\nscript saw: --version\n' });

await check('the shell still answers --help given before a script',
  'bash --help | head -n 1\n',
  { stdout: 'usage: bash [-c command] [script]\n' });

// ── sha256sum over the real bytes ─────────────────────────────────────────
// The digest was taken over enc.encode(readFileString(path)) — a UTF-8 decode
// and re-encode, which turns every byte that is not valid UTF-8 into U+FFFD.
// Any binary file hashed to something it does not contain, silently, so an
// installer verifying a downloaded tarball saw a mismatch on a good download.

{
  const bytes = new Uint8Array(512);
  for (let i = 0; i < 512; i++) bytes[i] = i & 0xff;
  root.writeFile('tmp/every-byte.bin', bytes, { mode: 0o644 });
  const expected = createHash('sha256').update(bytes).digest('hex');

  await check('sha256sum digests a binary file byte for byte',
    'sha256sum /tmp/every-byte.bin | cut -d" " -f1\n',
    { stdout: expected + '\n' });

  await check('sha256sum -c verifies a checksum list',
    `printf '%s  /tmp/every-byte.bin\\n' ${expected} > /tmp/sums.txt\n`
    + 'sha256sum -c /tmp/sums.txt\n',
    { stdout: '/tmp/every-byte.bin: OK\n' });

  await check('sha256sum -c reports a file whose contents changed',
    "printf '%s  /tmp/every-byte.bin\\n' "
    + "'0000000000000000000000000000000000000000000000000000000000000000' > /tmp/bad.txt\n"
    + 'sha256sum -c /tmp/bad.txt\necho "rc=$?"\n',
    { stdout: '/tmp/every-byte.bin: FAILED\nrc=1\n' });
}

// ── file tests resolve against the working directory ──────────────────────
// `[ -f name ]` handed the VFS a bare name, which it read as a path at the
// root, so the test was false for a file sitting in the working directory —
// and a false file test does not fail, it takes the other branch.

await check('a file test finds a file by its relative name',
  'cd /tmp\nprintf x > rel.txt\nmkdir -p reld\n'
  + '[ -f rel.txt ] && echo f\n[ -e rel.txt ] && echo e\n[ -r rel.txt ] && echo r\n'
  + '[ -s rel.txt ] && echo s\n[ -d reld ] && echo d\n[[ -f rel.txt ]] && echo dbl\n'
  + '[ -f nope ] || echo absent-still-absent\n',
  { stdout: 'f\ne\nr\ns\nd\ndbl\nabsent-still-absent\n' });

await check('a relative file test follows the working directory',
  'cd /tmp\nprintf x > cwd-rel.txt\ncd /\n[ -f cwd-rel.txt ] || echo not-here\n'
  + 'cd /tmp\n[ -f cwd-rel.txt ] && echo here\n',
  { stdout: 'not-here\nhere\n' });

// ── clustered flags across the text utilities ─────────────────────────────
// Same defect as unzip's, in the commands scripts lean on hardest: each one
// matched flags with `args.includes('-r')`, so a cluster matched nothing and
// the command silently did the default thing. `wc -lw` printed no counts at
// all, `sort -rn` sorted lexically, `head -qn 1` was an unrecognised option.
// Alongside them, defects the cluster work uncovered: `uniq` ignored file
// operands outright, `tail -n 1` printed the blank line after the last one,
// and `grep -q` did not exist. Expectations are GNU's own output.

const SETUP = "cd /tmp\nprintf 'ab\\nAB\\nab\\ncd\\n' > f.txt\n"
  + "printf 'ab\\nAB\\nab\\nce\\n' > f2.txt\nprintf '10\\n9\\n9\\n100\\n' > n.txt\n";

await check("wc -lw clusters, and lays columns out like GNU",
  SETUP + "wc -lw < f.txt\n",
  { stdout: "      4       4\n" });
await check("wc pads every column to the same width",
  SETUP + "wc f.txt\n",
  { stdout: " 4  4 12 f.txt\n" });
await check("wc totals several files",
  SETUP + "wc -l f.txt f2.txt\n",
  { stdout: " 4 f.txt\n 4 f2.txt\n 8 total\n" });
await check("wc -l of standard input has no padding",
  SETUP + "wc -l < f.txt\n",
  { stdout: "4\n" });
await check("sort -rn clusters",
  SETUP + "sort -rn n.txt\n",
  { stdout: "100\n10\n9\n9\n" });
await check("sort -nu clusters",
  SETUP + "sort -nu n.txt\n",
  { stdout: "9\n10\n100\n" });
await check("uniq reads a file operand",
  SETUP + "uniq f.txt\n",
  { stdout: "ab\nAB\nab\ncd\n" });
await check("uniq -ci clusters",
  SETUP + "sort f.txt | uniq -ci\n",
  { stdout: "      3 ab\n      1 cd\n" });
await check("tr -ds deletes SET1 then squeezes SET2",
  SETUP + "printf aabbcc | tr -ds b a; echo\n",
  { stdout: "acc\n" });
await check("head -qn clusters",
  SETUP + "head -qn 1 f.txt\n",
  { stdout: "ab\n" });
await check("head separates several files with a blank line",
  SETUP + "head -n 1 f.txt f2.txt\n",
  { stdout: "==> f.txt <==\nab\n\n==> f2.txt <==\nab\n" });
await check("tail -n 1 is the last line, not a blank one",
  SETUP + "tail -n 1 f.txt\n",
  { stdout: "cd\n" });
await check("tail -1 is a count",
  SETUP + "tail -1 f.txt\n",
  { stdout: "cd\n" });
await check("tail -qn clusters",
  SETUP + "tail -qn 1 f.txt\n",
  { stdout: "cd\n" });
await check("tail -n +2 counts from the start",
  SETUP + "tail -n +2 f.txt\n",
  { stdout: "AB\nab\ncd\n" });
await check("grep -q is quiet and reports through its status",
  SETUP + "grep -q ab f.txt; echo \"rc=$?\"; grep -q zz f.txt; echo \"rc=$?\"\n",
  { stdout: "rc=0\nrc=1\n" });
await check("grep -Eq clusters",
  SETUP + "grep -Eq \"a.\" f.txt; echo \"rc=$?\"\n",
  { stdout: "rc=0\n" });
await check("base64 -dw clusters",
  SETUP + "printf YWJj | base64 -dw 0; echo\n",
  { stdout: "abc\n" });
await check("base64 wraps at 76 columns by default",
  SETUP + "printf %s xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | base64 | wc -l\n",
  { stdout: "2\n" });

box.destroy();

if (failures.length > 0) {
  console.error(`shell install scripts: ${failures.length} failed`);
  process.exit(1);
}
console.log('shell install scripts: ok');
