#!/usr/bin/env bun
/**
 * scratch: GNU-anchored flag differential.
 *
 * Every snippet runs in a scratch dir under real GNU bash+coreutils and under
 * the Nimbus registry, on identical fixtures, with relative operands. The box's
 * cwd is normalised out. Any difference is a fidelity gap.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const CASES = [
  ['ls -la',      'ls -la d | wc -l'],
  ['rm -rf',      'rm -rf d/sub; echo $?; ls d'],
  ['grep -in',    'grep -in ab f.txt'],
  ['grep -iv',    'grep -iv ab f.txt'],
  ['grep -ic',    'grep -ic ab f.txt'],
  ['grep -c',     'grep -c ab f.txt'],
  ['grep -rn',    'grep -rn ab d'],
  ['grep -Eq',    'grep -Eq "a." f.txt; echo $?'],
  ['grep -lr',    'grep -lr ab d'],
  ['wc -l',       'wc -l < f.txt'],
  ['wc -lw',      'wc -lw < f.txt'],
  ['wc -lwc',     'wc -lwc < f.txt'],
  ['wc -l file',  'wc -l f.txt'],
  ['sort',        'sort n.txt'],
  ['sort -r',     'sort -r n.txt'],
  ['sort -n',     'sort -n n.txt'],
  ['sort -rn',    'sort -rn n.txt'],
  ['sort -nu',    'sort -nu n.txt'],
  ['sort -u',     'sort -u f.txt'],
  ['sort stdin',  'sort < n.txt'],
  ['uniq -c',     'sort f.txt | uniq -c'],
  ['uniq file',   'uniq f.txt'],
  ['uniq -d',     'sort f.txt | uniq -d'],
  ['tr -d',       'printf "aabbcc" | tr -d b'],
  ['tr -s',       'printf "aabbcc" | tr -s b'],
  ['tr -ds',      'printf "aabbcc" | tr -ds b a'],
  ['head -n1',    'head -n 1 f.txt'],
  ['head -1',     'head -1 f.txt'],
  ['head -qn',    'head -qn 1 f.txt'],
  ['head 2files', 'head -n 1 f.txt f2.txt'],
  ['tail -n1',    'tail -n 1 f.txt'],
  ['tail -1',     'tail -1 f.txt'],
  ['tail -qn',    'tail -qn 1 f.txt'],
  ['tail -n+2',   'tail -n +2 f.txt'],
  ['du -sh',      'du -sh d >/dev/null; echo $?'],
  ['tar -xzf',    'tar -xzf a.tgz -C x1; ls x1'],
  ['gzip -dk',    'gzip -dk g1.gz; ls g1 g1.gz'],
  ['gunzip -k',   'gunzip -k g2.gz; ls g2 g2.gz'],
  ['unzip -o',    'unzip -o z.zip >/dev/null; echo $?; ls zme.txt'],
  ['unzip -oq',   'unzip -oq z.zip; echo $?'],
  ['unzip -oqd',  'unzip -oqd u1 z.zip; echo $?; ls u1'],
  ['unzip -l',    'unzip -l z.zip >/dev/null; echo $?'],
  ['cut -d -f',   'printf "a:b:c\\n" | cut -d: -f2'],
  ['ln -sf',      'ln -sf f.txt l1; readlink l1'],
  ['base64 -dw',  'printf YWJj | base64 -dw 0'],
  ['sed -n',      'sed -n 1p f.txt'],
  ['sed -i',      'cp f.txt s.txt; sed -i s/ab/XY/ s.txt; cat s.txt'],
  ['xargs',       'printf "a\\nb\\n" | xargs echo'],
];

function fixture(dir) {
  mkdirSync(join(dir, 'd/sub'), { recursive: true });
  mkdirSync(join(dir, 'x1'), { recursive: true });
  writeFileSync(join(dir, 'f.txt'), 'ab\nAB\nab\ncd\n');
  writeFileSync(join(dir, 'f2.txt'), 'ab\nAB\nab\nce\n');
  writeFileSync(join(dir, 'n.txt'), '10\n9\n9\n100\n');
  writeFileSync(join(dir, 'd/inner.txt'), 'ab\n');
}

const host = mkdtempSync(join(tmpdir(), 'flagref-'));
fixture(host);
execFileSync('bash', ['-c',
  'printf "hello\\n" > tarme.txt; tar -czf a.tgz tarme.txt; rm tarme.txt; ' +
  'printf "z\\n" > zme.txt; zip -q z.zip zme.txt; rm zme.txt; ' +
  'printf "g\\n" > g1; gzip g1; printf "g\\n" > g2; gzip g2'], { cwd: host });

function runHost(script) {
  const r = execFileSync('bash', ['-c', `{ ${script} ; } 2>&1`], {
    cwd: host, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r;
}

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

function seed(hostDir, vfsDir) {
  for (const e of readdirSync(hostDir)) {
    const hp = join(hostDir, e);
    const vp = `${vfsDir}/${e}`;
    if (statSync(hp).isDirectory()) {
      try { root.mkdir(vp, { mode: 0o777 }); } catch {}
      root.chmod(vp, 0o777); root.chown(vp, 1000, 1000);
      seed(hp, vp);
    } else {
      root.writeFile(vp, readFileSync(hp), { mode: 0o666 });
      root.chown(vp, 1000, 1000);
    }
  }
}

let n = 0;
async function runBox(script) {
  const wd = `tmp/w${n++}`;
  root.mkdir(wd, { mode: 0o777 });
  root.chmod(wd, 0o777); root.chown(wd, 1000, 1000);
  seed(host, wd);
  const r = await box.shell.execute(script, { cwd: `/${wd}` });
  return ((r.stdout ?? '') + (r.stderr ?? '')).split(`/${wd}/`).join('').split(`/${wd}`).join('.');
}

let bad = 0;
for (const [name, script] of CASES) {
  let want; try { want = runHost(script); } catch (e) { want = (e.stdout ?? '') + (e.stderr ?? ''); }
  const got = await runBox(script);
  if (want === got) console.log(`ok     ${name}`);
  else {
    bad++;
    console.log(`DIFF   ${name}   ${script}`);
    console.log(`         GNU    ${JSON.stringify(want)}`);
    console.log(`         Nimbus ${JSON.stringify(got)}`);
  }
}
console.log(`\ndiffs: ${bad}/${CASES.length}`);
box.destroy();
rmSync(host, { recursive: true, force: true });
