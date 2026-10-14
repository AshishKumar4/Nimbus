#!/usr/bin/env bun
// CPython for WASI (packages/worker/wasm/python) of a commit, built on armada
// by its one recipe: build-in-bwrap.sh, which runs build-python.sh with the
// tree at /src/python, wasi-sdk 25.0 (pinned by digest) at /wasi-sdk and a
// cleared environment, so the bytes are the same wherever it runs. armada's
// image has bubblewrap, and its containers unprivileged user namespaces.
// Then build-python.sh verify drives the new artifacts through the Nimbus
// WASI host. What comes back, and the exit status: lib/remote-recipe-build.mjs.
//
//   bun scripts/ci/remote-python-build.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree.
import { remoteRecipeBuild } from './lib/remote-recipe-build.mjs';
import { PYTHON_OUTPUTS } from '../../packages/worker/wasm/python/inputs.mjs';

const DIR = 'packages/worker/wasm/python';
await remoteRecipeBuild({
  tool: 'remote-python-build',
  runtime: 'cpython-wasi',
  dir: DIR,
  outputs: PYTHON_OUTPUTS,
  build: `${DIR}/build-in-bwrap.sh "$W"`,
  verify: `${DIR}/build-python.sh verify`,
  summary: 'import namespaces|inittab|all cases passed',
}, process.argv.slice(2));
