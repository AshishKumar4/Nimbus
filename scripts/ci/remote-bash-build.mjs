#!/usr/bin/env bun
// GNU bash and BusyBox for WASI (packages/worker/wasm/bash/bash.async.wasm,
// coreutils/busybox.wasm and its applet list) of a commit, built on armada by
// their one recipe: build-in-bwrap.sh, which runs build-bash.sh and
// coreutils/build-busybox.sh on bash 5.2.37's and BusyBox 1.37.0's pinned
// releases with wasi-sdk 25.0 and binaryen pinned by digest, in a sandbox
// with a cleared environment, so the bytes are the same wherever it runs.
// Then the bash tests drive the new modules through the Nimbus bash runner.
// What comes back, and the exit status: lib/remote-recipe-build.mjs.
//
//   bun scripts/ci/remote-bash-build.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree.
import { remoteRecipeBuild } from './lib/remote-recipe-build.mjs';
import { BASH_OUTPUTS } from '../../packages/worker/wasm/bash/inputs.mjs';

const DIR = 'packages/worker/wasm/bash';
// The module's import surface, and real bash and BusyBox through the runner: fds, pipes, signals, waits, accounts.
const VERIFY = ['bash-live-artifact-abi', 'bash-nonlocal-exit', 'bash-capture-lifetime', 'bash-wasi-correctness', 'bash-fd-posix-correctness', 'bash-pipes-jspi', 'bash-kill-wait', 'bash-wait-reaps-own-children', 'bash-accounts-and-fifos'];
await remoteRecipeBuild({
  tool: 'remote-bash-build',
  runtime: 'bash-wasi',
  dir: DIR,
  outputs: BASH_OUTPUTS,
  build: `${DIR}/build-in-bwrap.sh "$W"`,
  verify: `{ ${VERIFY.map((name) => `bun tests/unit/${name}.mjs && echo "verified ${name}"`).join(' && ')}; }`,
  summary: '^verified ',
}, process.argv.slice(2));
