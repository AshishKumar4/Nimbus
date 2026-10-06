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

  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log(`git-children-workerd: ${checks} checks passed`);
process.exit(0);
