#!/usr/bin/env bun
/**
 * shell-parameter-expansion — the expansion table a real install script uses.
 *
 * The reported failure was `curl -fsSL … | bash` printing
 *
 *     Proteus install error: $*
 *
 * from `die() { printf 'Proteus install error: %s\n' "$*" >&2; exit 1; }`.
 * `$*` had no entry in the expansion table at all, so the two characters came
 * out literally. The gap was categorical, not a single missing case: `$*` in
 * every form, `${#@}`, `${?}`, every modifier on a positional or special
 * parameter (`${1:-x}`), every non-colon modifier (`${v-x}` `${v+x}` `${v=x}`
 * `${v?x}`), `${!v}`, `${@:o:l}`, the word inside `${v:-word}` (which was
 * never expanded, so `${HOME:-$HOME/x}` produced a literal `$HOME`), and IFS
 * field splitting — including `"$@"`, which collapsed to a single argument.
 *
 * Every expectation below was produced by running the same snippet under real
 * GNU bash. Everything runs through the shell entrypoint a user's script
 * actually goes through: `bash script args` and `… | bash`, resolved from the
 * command registry, not a directly constructed interpreter.
 */

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** Run a script the way a user does: `bash script.sh arg…`. */
async function runScript(script, args = []) {
  root.writeFile('tmp/case.sh', script, { mode: 0o755 });
  return box.shell.execute(`bash /tmp/case.sh ${args.map(shellQuote).join(' ')}`, {});
}

async function check(name, script, expected, args = []) {
  const result = await runScript(script, args);
  const actual = {
    stdout: result.stdout ?? '',
    exitCode: result.exitCode,
    ...(expected.stderr === undefined ? {} : { stderr: result.stderr ?? '' }),
  };
  const want = { stdout: expected.stdout, exitCode: expected.exitCode ?? 0, ...(expected.stderr === undefined ? {} : { stderr: expected.stderr }) };
  try {
    assert.deepEqual(actual, want);
    console.log(`  ok   ${name}`);
  } catch {
    failures.push(name);
    console.log(`  FAIL ${name}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(actual)}`);
  }
}

// ── the reported case, verbatim ────────────────────────────────────────────
await check(
  'a function echoing "$*" expands the positional parameters',
  `die() { printf 'Proteus install error: %s\\n' "$*" >&2; exit 1; }\ndie "macOS and Linux are supported by this installer."\n`,
  {
    stdout: '',
    stderr: 'Proteus install error: macOS and Linux are supported by this installer.\n',
    exitCode: 1,
  });

{
  // The same shape through the invocation that was reported: piped into bash.
  root.writeFile('tmp/piped.sh',
    `die() { printf 'error: %s\\n' "$*" >&2; exit 1; }\ndie one two three\n`,
    { mode: 0o644 });
  const piped = await box.shell.execute('cat /tmp/piped.sh | bash', {});
  try {
    assert.equal(piped.stderr ?? '', 'error: one two three\n');
    assert.equal(piped.exitCode, 1);
    console.log('  ok   `… | bash` expands "$*" inside a function');
  } catch (e) {
    failures.push('piped bash "$*"');
    console.log(`  FAIL \`… | bash\` expands "$*" inside a function — ${e.message}`);
  }
}

// ── $* and $@ ──────────────────────────────────────────────────────────────
await check('$* unquoted inside a function', 'f(){ echo $*; }\nf a b c\n', { stdout: 'a b c\n' });
await check('"$*" is a single field', 'f(){ for x in "$*"; do echo "[$x]"; done; }\nf "a b" c\n',
  { stdout: '[a b c]\n' });
await check('$* splits into fields when unquoted', 'f(){ for x in $*; do echo "[$x]"; done; }\nf "a b" c\n',
  { stdout: '[a]\n[b]\n[c]\n' });
await check('"$*" joins on the first IFS character', 'f(){ IFS=-; echo "$*"; }\nf a b c\n',
  { stdout: 'a-b-c\n' });
await check('$* at script top level', 'echo "top: $*"\n', { stdout: 'top: a b\n' }, ['a', 'b']);
await check('$* after shift', 'f(){ shift; echo "$*"; }\nf a b c\n', { stdout: 'b c\n' });
await check('$* after set --', 'set -- x y z; echo "$*"\n', { stdout: 'x y z\n' });
await check('${*} and ${#*}', 'f(){ echo "${*} ${#*}"; }\nf a b\n', { stdout: 'a b 2\n' });

await check('"$@" keeps each parameter a separate field',
  'f(){ for x in "$@"; do echo "[$x]"; done; }\nf "a b" c\n', { stdout: '[a b]\n[c]\n' });
await check('"$@" forwards arguments unchanged through a function',
  'g(){ echo "n=$# 1=[$1] 2=[$2]"; }\nf(){ g "$@"; }\nf "a b" c\n',
  { stdout: 'n=2 1=[a b] 2=[c]\n' });
await check('"$@" preserves empty arguments', 'g(){ echo "$#"; }\nf(){ g "$@"; }\nf "" ""\n',
  { stdout: '2\n' });
await check('"$@" with no parameters produces no field', 'f(){ set --; g(){ echo "$#"; }; g "$@"; }\nf\n',
  { stdout: '0\n' });
await check('"$@" inside a larger word', 'f(){ set --; for x in "pre$@post"; do echo "[$x]"; done; }\nf\n',
  { stdout: '[prepost]\n' });
await check('${@} and ${#@}', 'f(){ echo "${@} ${#@}"; }\nf a b\n', { stdout: 'a b 2\n' });
await check('${@:2} slices from the second parameter',
  'f(){ for x in "${@:2}"; do echo "[$x]"; done; }\nf a "b c" d\n', { stdout: '[b c]\n[d]\n' });
await check('${*:2:2} slices a range', 'f(){ echo "${*:2:2}"; }\nf a b c d\n', { stdout: 'b c\n' });
await check('pattern operators apply to every element of $@',
  'f(){ echo "${@#/a/}"; }\nf /a/x /a/y\n', { stdout: 'x y\n' });

// ── positional and special parameters ──────────────────────────────────────
await check('$1..$3 and $#', 'f(){ echo "$#:$1-$2-$3"; }\nf a b c\n', { stdout: '3:a-b-c\n' });
await check('${10} reaches the tenth parameter',
  'f(){ echo "${10}"; }\nf 1 2 3 4 5 6 7 8 9 TEN\n', { stdout: 'TEN\n' });
await check('$10 is ${1} followed by a literal 0', 'f(){ echo "$10"; }\nf A B\n', { stdout: 'A0\n' });
await check('${?} and $?', 'false; echo "$? ${?}"\n', { stdout: '1 1\n' });
await check('${#}', 'f(){ echo "${#}"; }\nf a b\n', { stdout: '2\n' });
await check('$$ and $0 are set', 'if [ -n "$$" ] && [ -n "$0" ]; then echo IDOK; fi\n',
  { stdout: 'IDOK\n' });
await check('modifiers work on positional parameters',
  'f(){ echo "[${1:-def}][${2:-def}][${1:1:2}]"; }\nf abcdef\n', { stdout: '[abcdef][def][bc]\n' });

// ── ${var<modifier>} ───────────────────────────────────────────────────────
await check('${v:-word} and ${v-word} differ on the empty string',
  'V=; echo "[${V:-d}][${V-d}]"\n', { stdout: '[d][]\n' });
await check('${v+alt} is set-only, ${v:+alt} is set-and-non-empty',
  'unset V; A="[${V+alt}]"; V=; B="[${V+alt}][${V:+alt}]"; echo "$A$B"\n',
  { stdout: '[][alt][]\n' });
await check('${v=word} assigns without a colon', 'unset V; echo "[${V=def}][$V]"\n',
  { stdout: '[def][def]\n' });
await check('${v?message} fails without a colon', 'unset V; echo "${V?boom}"; echo UNREACHED\n',
  { stdout: '', stderr: 'V: boom\n', exitCode: 1 });
await check('${v:?message} fails on the empty string', 'V=; echo "${V:?boom}"; echo UNREACHED\n',
  { stdout: '', stderr: 'V: boom\n', exitCode: 1 });
await check('the word inside ${v:-word} is itself expanded',
  'HOME=/h; unset V; echo "${V:-$HOME/x}"\n', { stdout: '/h/x\n' });
await check('the word inside ${v:-word} runs command substitution',
  'unset V; echo "${V:-$(echo sub)}"\n', { stdout: 'sub\n' });
await check('quotes inside ${v:-word} are removed', 'unset V; echo "[${V:-"a b"}]"\n',
  { stdout: '[a b]\n' });
await check('${!v} expands indirectly', 'V=W; W=deep; echo "${!V}"\n', { stdout: 'deep\n' });
await check('${!v:-word} falls back when the target is unset',
  'V=W; unset W; echo "${!V:-fb}"\n', { stdout: 'fb\n' });
await check('${#v} is the string length', 'V=abcd; echo "${#V}"\n', { stdout: '4\n' });
await check('prefix and suffix trimming', 'V=/a/b/c.sh; echo "${V##*/} ${V%.sh} ${V#/a}"\n',
  { stdout: 'c.sh /a/b/c /b/c.sh\n' });
await check('the pattern inside ${v#pattern} is expanded', 'P=/a; V=/a/b; echo "${V#$P}"\n',
  { stdout: '/b\n' });
await check('substitution, anchored and unanchored',
  'V=banana; echo "${V/a/o} ${V//a/o} ${V/#ba/X} ${V/%na/Y}"\n',
  { stdout: 'bonana bonono Xnana banaY\n' });
await check('case conversion', 'V=abc; U=ABC; echo "${V^^} ${U,,} ${V^}"\n',
  { stdout: 'ABC abc Abc\n' });
await check('negative substring offsets and lengths',
  'V=abcdef; echo "[${V: -3}][${V:1:-1}]"\n', { stdout: '[def][bcde]\n' });

// ── IFS field splitting ────────────────────────────────────────────────────
await check('an unquoted expansion splits on IFS',
  'V="a b c"; for x in $V; do echo "[$x]"; done\n', { stdout: '[a]\n[b]\n[c]\n' });
await check('a quoted expansion does not split',
  'V="a b c"; for x in "$V"; do echo "[$x]"; done\n', { stdout: '[a b c]\n' });
await check('literal IFS characters are not delimiters',
  'IFS=:; for x in a:b; do echo "[$x]"; done\n', { stdout: '[a:b]\n' });
await check('a non-whitespace IFS keeps interior empty fields',
  'IFS=:; V="a::b"; for x in $V; do echo "[$x]"; done\n', { stdout: '[a]\n[]\n[b]\n' });
await check('a trailing IFS delimiter adds no field',
  'IFS=:; V="a:"; for x in $V; do echo "[$x]"; done\n', { stdout: '[a]\n' });
await check('a leading IFS delimiter adds an empty field',
  'IFS=:; V=":a"; for x in $V; do echo "[$x]"; done\n', { stdout: '[]\n[a]\n' });
await check('splitting sees the whole word, not just the expansion',
  'V=" a b "; for x in x$V; do echo "[$x]"; done\n', { stdout: '[x]\n[a]\n[b]\n' });
await check('an unquoted empty expansion produces no argument',
  'E=; f(){ echo "$#"; }\nf x $E y\n', { stdout: '2\n' });
await check('a quoted empty expansion produces an argument',
  'unset E; f(){ echo "$#"; }\nf x "$E" y\n', { stdout: '3\n' });
await check('command substitution splits when unquoted and not when quoted',
  'f(){ echo "$#"; }\nf $(echo a b c); f "$(echo a b c)"\n', { stdout: '3\n1\n' });

// ── set -u ─────────────────────────────────────────────────────────────────
await check('set -u aborts on an unset variable', 'set -u; echo "$NOPE"; echo UNREACHED\n',
  { stdout: '', stderr: 'NOPE: unbound variable\n', exitCode: 1 });
await check('set -u accepts a default', 'set -u; echo "${NOPE:-fallback}"\n',
  { stdout: 'fallback\n' });
await check('set -u accepts "$@" with no parameters', 'set -u; f(){ echo "count=$#"; }\nf\n',
  { stdout: 'count=0\n' });
await check('[[ ]] does not expand past a decided &&',
  'set -u; f(){ if [[ $# = 2 && $2 = x ]]; then echo YES; else echo NO; fi; }\nf\n',
  { stdout: 'NO\n', stderr: '', exitCode: 0 });
await check('[[ ]] does not expand past a decided ||',
  'set -u; f(){ if [[ $# = 0 || $1 = x ]]; then echo YES; else echo NO; fi; }\nf\n',
  { stdout: 'YES\n', stderr: '', exitCode: 0 });

box.destroy();

if (failures.length > 0) {
  console.error(`shell parameter expansion: ${failures.length} failed`);
  process.exit(1);
}
console.log('shell parameter expansion: ok');
