#!/usr/bin/env bun
// WASI Stage 1: chmod(1) mode-spec parsing — octal and symbolic forms.

import assert from 'node:assert/strict';
import {
  parseModeSpec,
  applyModeSpec,
} from '../../packages/worker/src/substrate/lifo/commands/fs/chmod.ts';

function apply(spec, current, isDir = false) {
  const parsed = parseModeSpec(spec);
  assert.ok(parsed, `spec '${spec}' must parse`);
  return applyModeSpec(parsed, current, isDir);
}

// ── octal ────────────────────────────────────────────────────────────────
assert.equal(apply('755', 0o644), 0o755);
assert.equal(apply('0644', 0o755), 0o644);
assert.equal(apply('600', 0o777), 0o600);
assert.equal(apply('7', 0o644), 0o007, 'short octal is absolute');
// Current mode with filetype bits: absolute result is perms-only.
assert.equal(apply('755', 0o100644), 0o755);

// ── symbolic: the Stage-1 gate forms ─────────────────────────────────────
assert.equal(apply('+x', 0o644), 0o755, '+x defaults to a');
assert.equal(apply('-x', 0o755), 0o644);
assert.equal(apply('u+x', 0o644), 0o744);
assert.equal(apply('a+x', 0o644), 0o755);
assert.equal(apply('go-w', 0o666), 0o644);

// ── symbolic: who combinations, =, commas ───────────────────────────────
assert.equal(apply('ug+x', 0o644), 0o754);
assert.equal(apply('o-r', 0o644), 0o640);
assert.equal(apply('u=rwx', 0o644), 0o744);
assert.equal(apply('a=r', 0o777), 0o444);
assert.equal(apply('g=', 0o777), 0o707, '= with no perms clears');
assert.equal(apply('u+x,go-r', 0o644), 0o700);
// Symbolic ops on a filetype-stamped current mode operate on perms only.
assert.equal(apply('+x', 0o100644), 0o755);

// ── conditional execute (X) ─────────────────────────────────────────────
assert.equal(apply('a+rX', 0o600, true), 0o755, 'X grants x to directories');
assert.equal(apply('a+rX', 0o700, false), 0o755, 'X grants x when a file already has exec');
assert.equal(apply('a+rX', 0o600, false), 0o644, 'X skips non-exec files');
assert.equal(apply('a-X', 0o755, false), 0o644, '-X removes exec from exec files');

// ── invalid specs ────────────────────────────────────────────────────────
assert.equal(parseModeSpec('banana'), null);
assert.equal(parseModeSpec('u~x'), null);
assert.equal(parseModeSpec('88'), null, 'non-octal digits rejected');
assert.equal(parseModeSpec(''), null);
assert.equal(parseModeSpec('u+x,'), null, 'trailing empty clause rejected');

console.log('chmod-mode-spec: all assertions passed');
