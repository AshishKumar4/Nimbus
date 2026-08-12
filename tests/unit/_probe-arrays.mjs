#!/usr/bin/env bun
/**
 * scratch: array differential. Every snippet runs under real GNU bash and
 * through the Nimbus registry; expectations are bash's own output.
 */
import { execFileSync } from 'node:child_process';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const CASES = [
  ['literal',            'a=(x y z); echo "${a[0]} ${a[1]} ${a[2]}"'],
  ['whole @',            'a=(x y z); echo "${a[@]}"'],
  ['whole *',            'a=(x y z); echo "${a[*]}"'],
  ['bare name is [0]',   'a=(x y z); echo "$a"'],
  ['count',              'a=(x y z); echo "${#a[@]}"'],
  ['count star',         'a=(x y z); echo "${#a[*]}"'],
  ['element length',     'a=(xx yyy); echo "${#a[1]}"'],
  ['quoted @ fields',    'a=("a b" c); for e in "${a[@]}"; do echo "[$e]"; done'],
  ['unquoted @ splits',  'a=("a b" c); for e in ${a[@]}; do echo "[$e]"; done'],
  ['quoted * one field', 'a=("a b" c); for e in "${a[*]}"; do echo "[$e]"; done'],
  ['* joins on IFS',     'IFS=-; a=(x y z); echo "${a[*]}"'],
  ['@ ignores IFS',      'IFS=-; a=(x y z); echo "${a[@]}"'],
  ['empty array count',  'a=(); echo "${#a[@]}"'],
  ['empty array @',      'a=(); for e in "${a[@]}"; do echo "[$e]"; done; echo done'],
  ['empty array in args','a=(); f(){ echo "$#"; }; f "${a[@]}"'],
  ['append',             'a=(x); a+=(y z); echo "${a[@]}"'],
  ['append to empty',    'a=(); a+=(y); echo "${a[@]}"'],
  ['element assign',     'a=(x y); a[1]=Q; echo "${a[@]}"'],
  ['element beyond end', 'a=(x); a[3]=Q; echo "${a[@]}"'],
  ['sparse count',       'a=(x); a[3]=Q; echo "${#a[@]}"'],
  ['sparse indices',     'a=(x); a[3]=Q; echo "${!a[@]}"'],
  ['dense indices',      'a=(x y z); echo "${!a[@]}"'],
  ['negative index',     'a=(x y z); echo "${a[-1]}"'],
  ['arithmetic index',   'a=(x y z); i=1; echo "${a[i+1]}"'],
  ['dollar index',       'a=(x y z); i=2; echo "${a[$i]}"'],
  ['unset element read', 'a=(x); echo "[${a[9]}]"'],
  ['default on element', 'a=(x); echo "${a[9]:-fb}"'],
  ['slice',              'a=(p q r s); echo "${a[@]:1:2}"'],
  ['slice to end',       'a=(p q r s); echo "${a[@]:2}"'],
  ['trim each',          'a=(/a/x /a/y); echo "${a[@]#/a/}"'],
  ['substitute each',    'a=(ab cb); echo "${a[@]/b/Z}"'],
  ['case each',          'a=(ab cd); echo "${a[@]^^}"'],
  ['from command sub',   'a=($(echo p q r)); echo "${#a[@]} ${a[1]}"'],
  ['from positional',    'f(){ local -a c; c=("$@"); echo "${#c[@]} [${c[0]}]"; }; f "x y" z'],
  ['quoted elements',    'a=("x y" "z w"); echo "${#a[@]} [${a[0]}]"'],
  ['expansion in elem',  'v=hi; a=($v there); echo "${a[0]}-${a[1]}"'],
  ['scalar then index',  'v=one; v[1]=two; echo "${v[@]}"'],
  ['array then scalar',  'a=(x y); a=plain; echo "[${a[@]}] [${a[1]}]"'],
  ['unset whole',        'a=(x y); unset a; echo "[${a[@]}] ${#a[@]}"'],
  ['loop over array',    'a=(one two); for e in "${a[@]}"; do echo "-$e"; done'],
  ['array in condition', 'a=(x); if [ "${#a[@]}" -gt 0 ]; then echo nonempty; fi'],
  ['nested quotes',      'a=("a\\"b"); echo "${a[0]}"'],
  ['set -u empty array', 'set -u; a=(); echo "${#a[@]}"; f(){ echo "$#"; }; f "${a[@]}"'],
  ['append scalar',      'v=a; v+=b; echo "$v"'],
  ['append element',     'a=(x y); a[0]+=Z; echo "${a[@]}"'],
  ['bun config shape',   'P=/bin; cmds=("export A=1" "export PATH=\\"x:$P\\""); for c in "${cmds[@]}"; do echo "  $c"; done'],
  ['local basic',        'f(){ local v=in; echo "$v"; }; v=out; f; echo "$v"'],
  ['local unset outside', 'f(){ local v=in; }; f; echo "[${v-unset}]"'],
  ['local no value',     'v=out; f(){ local v; echo "[$v]"; }; f; echo "[$v]"'],
  ['local several',      'f(){ local a=1 b=2; echo "$a$b"; }; f'],
  ['local is dynamic',   'g(){ echo "$v"; }; f(){ local v=inner; g; }; v=outer; f'],
  ['local recursion',    'f(){ local d=$1; [ "$1" -eq 0 ] && { echo "$d"; return; }; f $(( $1 - 1 )); echo "$d"; }; f 2'],
  ['local restores on return', 'f(){ local v=x; return 3; }; v=keep; f; echo "$? $v"'],
  ['local outside fn',   'local v=1; echo "rc=$?"'],
  ['local array',        'f(){ local a=(p q); echo "${#a[@]} ${a[1]}"; }; a=(z); f; echo "${a[@]}"'],
  ['local -r',           'f(){ local -r c=1; echo "$c"; }; f'],
  ['declare in fn',      'f(){ declare v=in; echo "$v"; }; v=out; f; echo "$v"'],
  ['declare at top',     'declare v=top; echo "$v"'],
  ['typeset alias',      'f(){ typeset v=in; echo "$v"; }; f'],
  ['local shadows array','f(){ local a; a=(1 2); echo "${#a[@]}"; }; a=(x y z); f; echo "${#a[@]}"'],
  ['bash_configs shape', 'cfg=("$HOME/.bash_profile" "$HOME/.bashrc"); cfg+=("$HOME/x"); echo "${#cfg[@]}"'],
];

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

let n = 0;
let bad = 0;
const rows = [];
for (const [name, script] of CASES) {
  let want;
  try {
    want = execFileSync('bash', ['-c', `HOME=/home/user; { ${script} ; } 2>&1`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { want = (e.stdout ?? '') + (e.stderr ?? ''); }

  const path = `tmp/arr${n++}.sh`;
  root.writeFile(path, script + '\n', { mode: 0o755 });
  const r = await box.shell.execute(`bash /${path}`, {});
  const got = (r.stdout ?? '') + (r.stderr ?? '');

  if (want === got) console.log(`ok     ${name}`);
  else {
    bad++;
    rows.push(name);
    console.log(`DIFF   ${name}   ${script}`);
    console.log(`         bash   ${JSON.stringify(want)}`);
    console.log(`         nimbus ${JSON.stringify(got)}`);
  }
}
console.log(`\ndiffs: ${bad}/${CASES.length}`);
box.destroy();
