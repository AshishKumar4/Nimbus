#!/usr/bin/env bun
// Decision test: how a staged opencode invocation is classified into a runtime
// disposition. This pins the routing decision that drives the multi-isolate
// split — a regression here would send `opencode serve` back to the unreachable
// one-shot path, or make bare `opencode` render the OOM-prone in-process TUI
// instead of the serve+attach pair.
//
//   bare `opencode`          → 'dual'     (serve facet + attach facet)
//   `opencode serve` / `web` → 'server'   (headless resident routeable facet)
//   `opencode attach <url>`  → 'attached' (interactive TUI client facet)
//   `opencode run` / models  → 'oneshot'  (fresh isolate, buffered)
//   --version / --help / -v  → 'oneshot'
//   tree-sitter diagnostic   → 'oneshot'

import assert from 'node:assert/strict';
import { classifyStagedArtifact } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import { OPENCODE_TREE_SITTER_DIAG_ARG } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

const oc = (argv, env) => classifyStagedArtifact('opencode', argv, env);

// bare opencode → dual (serve + attach)
assert.equal(oc([]), 'dual', 'bare opencode → dual');
assert.equal(oc(['--interactive']), 'dual', 'opencode --interactive (flag-only) → dual');

// serve / web → resident server facet (NOT attached-TTY, NOT one-shot)
assert.equal(oc(['serve']), 'server', 'opencode serve → server');
assert.equal(oc(['serve', '--port', '4096']), 'server', 'opencode serve --port → server');
assert.equal(oc(['serve', '--hostname', '127.0.0.1', '--port', '4096']), 'server');
assert.equal(oc(['web']), 'server', 'opencode web → server');

// attach → attached-TTY client facet
assert.equal(oc(['attach', 'http://127.0.0.1:4096']), 'attached', 'opencode attach <url> → attached');

// one-shot commands stay one-shot
assert.equal(oc(['run', 'hello world']), 'oneshot', 'opencode run → oneshot');
assert.equal(oc(['run', '-m', 'anthropic/x', 'hi']), 'oneshot');
assert.equal(oc(['models']), 'oneshot', 'opencode models → oneshot');
assert.equal(oc(['auth', 'login']), 'oneshot', 'opencode auth → oneshot');

// version/help flags are one-shot regardless of any subcommand
assert.equal(oc(['--version']), 'oneshot');
assert.equal(oc(['-v']), 'oneshot');
assert.equal(oc(['--help']), 'oneshot');
assert.equal(oc(['-h']), 'oneshot');
assert.equal(oc(['serve', '--help']), 'oneshot', 'serve --help stays one-shot (never boots a server)');

// the Nimbus tree-sitter diagnostic is a headless one-shot
assert.equal(oc([OPENCODE_TREE_SITTER_DIAG_ARG]), 'oneshot');

// non-opencode staged artifacts are always one-shot
assert.equal(classifyStagedArtifact('somethingelse', []), 'oneshot');

console.log('opencode-invocation-disposition: ok');
