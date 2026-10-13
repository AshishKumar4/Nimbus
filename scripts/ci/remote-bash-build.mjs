#!/usr/bin/env bun
// GNU bash for WASI (packages/worker/wasm/bash/bash.async.wasm) of a commit,
// built on armada by its one recipe: build-in-bwrap.sh, which runs
// build-bash.sh on bash 5.2.37's pinned release with wasi-sdk 25.0 and
// binaryen pinned by digest, in a sandbox with a cleared environment, so the
// bytes are the same wherever it runs. Then the bash tests drive the new
// module through the Nimbus bash runner. What comes back, and the exit
// status: lib/remote-recipe-build.mjs.
//
//   bun scripts/ci/remote-bash-build.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree.
import { remoteRecipeBuild } from './lib/remote-recipe-build.mjs';
import { BASH_OUTPUTS } from '../../packages/worker/wasm/bash/inputs.mjs';

const DIR = 'packages/worker/wasm/bash';
// The module's import surface, and real bash through the runner: fds, pipes, signals, waits.
const VERIFY = ['bash-live-artifact-abi', 'bash-wasi-correctness', 'bash-fd-posix-correctness', 'bash-pipes-jspi', 'bash-kill-wait', 'bash-wait-reaps-own-children'];
await remoteRecipeBuild({
  tool: 'remote-bash-build',
  runtime: 'bash-wasi',
  dir: DIR,
  outputs: BASH_OUTPUTS,
  build: `${DIR}/build-in-bwrap.sh "$W"`,
  verify: `{ ${VERIFY.map((name) => `bun tests/unit/${name}.mjs && echo "verified ${name}"`).join(' && ')}; }`,
  summary: '^verified ',
}, process.argv.slice(2));
