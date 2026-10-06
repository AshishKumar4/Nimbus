#!/usr/bin/env bun
/**
 * git-children-workerd — git starts children as session processes.
 *
 * git.wasm has no fork; it starts a child as Windows does (patches/0002,
 * nimbus_spawnvpe), and the WASI layer starts it through the session's
 * child-process route (core runtime/wasi/processes.ts). On local workerd
 * (apps/probe), with the git runtime installed:
 *
 *   - a hook runs, and what git wrote before it (the commit) is there for it;
 *   - a hook that runs git runs a second git as a child;
 *   - git waits for its child and acts on its exit status (a failing
 *     pre-commit hook stops the commit).
 *
 * Aliases are not here yet: git tries an alias's dashed external first
 * (git-<alias>) and needs that spawn to fail with ENOENT, which the
 * session's child-process route does not do yet (it starts a child that
 * exits 127; RealFlea's process-layer fix).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const ID = 'GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com';
const probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
let checks = 0;
try {
  const terminal = await localTerminal(probe, { install: ['git'] });
  const run = async (command, timeoutMs = 300_000) => {
    const r = await terminal.run(command, timeoutMs);
    console.log(`git-children-workerd: ${command} -> ${r.status} ${JSON.stringify(r.stdout.slice(-300))}`);
    return r;
  };
  try {
    await run(`mkdir -p repo && cd repo && git init -q -b main && printf 'a\\n' > a.txt && git add a.txt && ${ID} git commit -q -m first; cd ~`);

    await run(`cd repo && mkdir -p .git/hooks && printf '#!/bin/sh\\ngit log --format=hook-saw:%%s -1 > .git/hook.out\\n' > .git/hooks/post-commit && chmod +x .git/hooks/post-commit; cd ~`);
    const hooked = await run(`cd repo && printf 'b\\n' > b.txt && git add b.txt && ${ID} git commit -q -m second && cat .git/hook.out; cd ~`);
    assert.equal(hooked.status, 0);
    assert.match(hooked.stdout, /hook-saw:second/);
    checks++;

    await run(`cd repo && printf '#!/bin/sh\\necho refused by pre-commit >&2\\nexit 1\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit; cd ~`);
    const refused = await run(`cd repo && printf 'c\\n' > c.txt && git add c.txt && ${ID} git commit -q -m third; echo "status=$?"; git log --format=%s -1; cd ~`);
    assert.match(refused.stdout, /status=1/);
    assert.match(refused.stdout, /^second$/m, 'the commit did not happen');
    checks++;

    // The hook returns NUL-delimited bytes through an ordinary registry
    // child. Compare real Git's monitored status to native Git's full scan.
    const native = mkdtempSync(join(tmpdir(), 'git-fsmonitor-native-'));
    const nativeEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
    const host = (...args) => execFileSync('git', args, { cwd: native, env: nativeEnv, encoding: 'utf8' });
    try {
      host('init', '-q', '-b', 'main');
      for (const name of ['a', 'b']) writeFileSync(join(native, `${name}.txt`), `${name}\n`);
      host('add', '-A'); host('commit', '-q', '-m', 'base');
      writeFileSync(join(native, 'c.txt'), 'c\n'); host('add', 'c.txt');
      const options = '-c core.fsmonitor=git-fsmonitor-nimbus -c core.fsmonitorHookVersion=2';
      for (let n = 0; n < 3; n++) assert.equal((await run(`git -C repo ${options} status --porcelain`)).status, 0);
      const trace = await run(`GIT_TRACE_FSMONITOR=1 git -C repo ${options} status --porcelain`);
      assert.match(trace.stdout, /returned success/, 'Git queried the v2 hook successfully');
      const compare = async (label) => {
        const got = await run(`git -C repo ${options} status --porcelain`);
        assert.equal(got.status, 0, got.stdout);
        assert.equal(got.stdout, host('status', '--porcelain'), label);
      };
      await compare('warm monitored status');
      writeFileSync(join(native, 'a.txt'), 'edited\n');
      writeFileSync(join(native, 'new.txt'), 'new\n');
      await run("printf 'edited\\n' > repo/a.txt && printf 'new\\n' > repo/new.txt");
      await compare('tracked and untracked additions');
      host('mv', 'b.txt', 'renamed.txt');
      await run('git -C repo mv b.txt renamed.txt');
      await compare('rename');
      chmodSync(join(native, 'a.txt'), 0o755);
      await run('chmod 755 repo/a.txt');
      await compare('executable mode change');
      rmSync(join(native, 'new.txt'));
      await run('rm repo/new.txt');
      await compare('untracked deletion');
      checks++;
    } finally { rmSync(native, { recursive: true, force: true }); }

  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log(`git-children-workerd: ${checks} checks passed`);
process.exit(0);
