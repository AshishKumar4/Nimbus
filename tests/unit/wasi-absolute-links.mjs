#!/usr/bin/env bun
// A WASI guest resolves an absolute symlink through the namespace (Kinu's
// ask 15). Kinu's home is /home/main with /home/user -> /home/main, and every
// path through that link failed in a WASI guest with errno 76 ("Capabilities
// insufficient"): the walk beneath a preopen (walkBeneath, VFS-COMP-006)
// refused any absolute link target. Now an absolute target resolves from the
// namespace's `/`, as the unrestricted walk resolves it, and what the walk
// reaches must still lie at or under the preopen's root.
//
//   - Real bash and BusyBox over the runner's WASI layer: cd, pwd, cat (open),
//     ls (listdir), test -e (exists) and stat through the link, through a
//     chain of absolute links, and a dangling one (ENOENT, not ENOTCAPABLE).
//   - The walk itself, beneath a root other than `/`: an absolute link that
//     lands beneath the root resolves, one that lands outside is ENOTCAPABLE.
//   - A runner whose guest cannot enter its working directory fails the
//     launch naming it, instead of running the program in `/` (python3 served
//     "Directory listing for /"): the CPython and Ruby runners' own preludes,
//     run under the host's python3 and ruby.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runScript } from './lib/bash-preamble.mjs';
import { makeCPythonRunnerFactory } from '../../packages/core/src/runtime/cpython-runner.ts';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { loaderFacetHost } from '../../packages/worker/src/runtime/facet-loader-host.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

// ── A WASI guest through absolute links ─────────────────────────────────────
{
  const result = await runScript([
    'rm -r /home/user && mkdir -p /home/main/site && echo hello > /home/main/site/index.html',
    'ln -s /home/main /home/user && ln -s /home/user/site /tmp/chain && ln -s /home/main/nowhere /tmp/dangling',
    'cd /home/user/site && pwd && cat index.html && ls && test -e index.html && echo exists && stat -c %s index.html',
    'cat /tmp/chain/index.html && ls /tmp/chain && test -d /tmp/chain && echo chain-is-dir',
    'test -e /tmp/dangling || echo dangling-absent',
    'cd /tmp/dangling',
  ].join('\n'), { dirs: ['home'] });
  assert.equal(result.stdout, [
    '/home/user/site', 'hello', 'index.html', 'exists', '6',
    'hello', 'index.html', 'chain-is-dir',
    'dangling-absent', '',
  ].join('\n'), `stderr: ${result.stderr}`);
  assert.equal(result.stderr, 'bash: line 6: cd: /tmp/dangling: No such file or directory\n', 'a dangling absolute link is ENOENT');
  assert.equal(result.exitCode, 1);
}

// ── The walk beneath a root that is not `/` ─────────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/main/site/assets', { recursive: true });
  root.writeFile('home/main/site/assets/a.css', 'a');
  root.writeFile('home/main/secret', 's');
  root.symlink('/home/main/site/assets', 'home/main/site/in');
  root.symlink('/home/main/secret', 'home/main/site/out');
  const files = new ProcessFiles(raw);
  for (const [pid, face] of [[7, 'synchronous'], [8, 'awaiting']]) {
    const bound = files.bind({ pid, cred: CRED_KERNEL });
    const fs = face === 'synchronous' ? bound.synchronous : bound;
    const beneath = (path) => ({ root: 'home/main/site', path, beneath: true });
    assert.equal((await fs.stat(beneath('in/a.css'))).size, 1, `${face}: an absolute link landing beneath the root resolves`);
    await assert.rejects(async () => fs.stat(beneath('out')), { code: 'ENOTCAPABLE' }, `${face}: one landing outside it does not`);
    await files.releaseProcess(pid);
  }
  harness.db.close();
}

// ── A working directory the guest cannot enter fails the launch ─────────────
const hasHost = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
const missing = '/nonexistent-nimbus-cwd/site';

if (hasHost('python3')) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  for (const path of ['runtime/python/share/cpython/python.wasm', 'runtime/python/lib/python313.zip']) {
    root.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    root.writeFile(path, new Uint8Array([0]));
  }
  root.mkdir('home/user', { recursive: true });
  const filesystem = new ProcessFiles(raw);
  const submitted = [];
  const env = { LOADER: { get: () => ({ getEntrypoint: () => ({ async execute(args) { submitted.push(args); return { exitCode: 0, stdout: '', stderr: '' }; } }) }) } };
  const run = makeCPythonRunnerFactory({ facets: loaderFacetHost(env, { id: { toString: () => 'wasi-absolute-links' }, waitUntil() {} }) })(
    { version: '3.13.14', files: [{ path: 'share/cpython/python.wasm' }, { path: 'lib/python313.zip' }] }, '/runtime/python', 'python3', undefined);
  // What the guest runs (the runner's prelude, then the program), under a real CPython.
  const guest = async (cwd) => {
    submitted.length = 0;
    const ctx = {
      pid: 41, cred: USER, vfs: new ProcessView(filesystem.bind({ pid: 41, cred: USER })),
      args: ['-c', 'import os; print("ran in", os.getcwd())'], cwd, env: {}, stdin: '', stdout: { write() {} }, stderr: { write() {} },
    };
    assert.equal(await run(ctx), 0);
    return spawnSync('python3', ['-c', submitted[0].userCode], { encoding: 'utf8', cwd: '/' });
  };
  const refused = await guest(missing);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `python3: can't enter working directory '${missing}': [Errno 2] No such file or directory\n`);
  assert.equal(refused.stdout, '', 'the program does not run in /');
  const entered = await guest('/tmp');
  assert.equal(entered.stdout, 'ran in /tmp\n');
  await filesystem.releaseProcess(41);
  harness.db.close();
} else {
  console.log('wasi-absolute-links: python3 prelude SKIPPED (no host python3)');
}

if (hasHost('ruby')) {
  // The facet's own __rubyRun, with the VM stood in for by a recorder of
  // what it evaluates; then that Ruby, under a real Ruby.
  const evaluated = [];
  const scope = { __nimbusRubyStdout: [], __nimbusRubyStderr: [], __nimbusRubyStep: async () => ({ resumed: false, alive: false }), __evaluated: evaluated };
  const stand = 'function __nimbusInstallRubyFs() {}\nfunction __wasiAdoptSupervisor() {}\nasync function __nimbusRubyEval(boot, code) { globalThis.__evaluated.push(code); return { status: 0 }; }';
  new Function('globalThis', `${RUBY_RUNNER_PREAMBLE_TAIL}\n${stand}`).call(scope, scope);
  scope.__rubyBootstrap = Promise.resolve({ ok: true, rubyInitialized: true });
  const guest = async (cwd) => {
    evaluated.length = 0;
    await scope.__rubyRun({ userCode: 'puts "ran in #{Dir.pwd}"', rbArgv: ['-e'], userEnv: { HOME: '/tmp' }, progName: '-e', binName: 'ruby', cwd });
    return spawnSync('ruby', ['-e', evaluated.join('\n')], { encoding: 'utf8', cwd: '/' });
  };
  const refused = await guest(missing);
  assert.match(refused.stderr, new RegExp(`^ruby: can't enter working directory '${missing}': \\[Errno 2\\] No such file or directory\\n`));
  assert.match(refused.stderr, /__NIMBUS_RUBY_EXIT_1\n$/, 'and exits 1');
  assert.equal(refused.stdout, '', 'the program does not run in /');
  const entered = await guest('/tmp');
  assert.equal(entered.stdout, 'ran in /tmp\n');
  assert.match(entered.stderr, /__NIMBUS_RUBY_EXIT_0\n$/);
} else {
  console.log('wasi-absolute-links: ruby prelude SKIPPED (no host ruby)');
}

console.log('wasi-absolute-links: ok');
