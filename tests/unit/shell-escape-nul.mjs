#!/usr/bin/env bun
// `echo -e` and `printf` expand backslash escapes. Expanding them one pass per
// escape needs a sentinel to hold a literal `\` back from the later passes, and
// the sentinel used to be NUL — the very character `\0` and `\x00` produce, so
// `printf 'a\0b'` came back as `a\b`. These are the collisions.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';

const dir = mkdtempSync(join(tmpdir(), 'nimbus-escape-nul-'));

try {
  const db = new Database(join(dir, 'w.sqlite'));
  const harness = createSqliteVfsTestHarness(db);
  const ws = await NimbusWorkspace.create({
    sql: harness.sql,
    transactions: harness.ctx,
    generation: 1,
  });

  // ── printf, through the shell ─────────────────────────────────────────────
  const printf = async (format) => {
    const result = await ws.exec(`printf '${format}'`);
    assert.equal(result.exitCode, 0, `printf '${format}' failed: ${result.stderr}`);
    return result.stdout;
  };

  assert.equal(await printf('a\\0b'), 'a\u0000b', 'printf \\0 must emit NUL, not a backslash');
  assert.equal(await printf('a\\x00b'), 'a\u0000b', 'printf \\x00 must emit NUL, not a backslash');
  assert.equal(await printf('a\\\\b'), 'a\\b', 'printf \\\\ must emit one literal backslash');
  assert.equal(await printf('a\\tb'), 'a\tb');
  assert.equal(await printf('a\\nb'), 'a\nb');
  assert.equal(await printf('a\\x41b'), 'aAb');
  assert.equal(await printf('a\\101b'), 'a\\101b', 'bare octal is not an escape here');
  assert.equal(await printf('a\\qb'), 'a\\qb', 'an unknown escape stays verbatim');

  // ── echo, through the registry (Shell has its own `echo` builtin, so the
  //    registry entry is what `xargs`/`find -exec`/`command` resolve to) ─────
  const registryEcho = await ws.registry.resolve('echo');
  assert.ok(registryEcho, 'registry must carry an echo');

  const echo = async (...args) => {
    let out = '';
    const code = await registryEcho({
      pid: 1,
      args,
      cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
      env: {},
      cwd: '/home/user',
      vfs: ws.kernel.vfs,
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
      signal: new AbortController().signal,
      setUmask: () => {},
      runAs: async () => 0,
    });
    assert.equal(code, 0, `echo ${args.join(' ')} exited ${code}`);
    return out;
  };

  assert.equal(await echo('-e', 'a\\0b'), 'a\u0000b\n', 'echo -e \\0 must emit NUL');
  assert.equal(await echo('-e', 'a\\x00b'), 'a\u0000b\n', 'echo -e \\x00 must emit NUL');
  assert.equal(await echo('-e', 'a\\\\b'), 'a\\b\n', 'echo -e \\\\ must emit one backslash');
  assert.equal(await echo('-e', 'a\\tb'), 'a\tb\n');
  assert.equal(await echo('-E', 'a\\tb'), 'a\\tb\n', '-E leaves escapes alone');
  assert.equal(await echo('-ne', 'a\\0b'), 'a\u0000b', '-n suppresses the newline');
  assert.equal(await echo('a\\tb'), 'a\\tb\n', 'escapes are off without -e');

  // A NUL already present in the argument survives untouched.
  assert.equal(await echo('-e', 'a\u0000b'), 'a\u0000b\n', 'an input NUL is not a sentinel');

  db.close();
  console.log('shell escape expansion: NUL escapes and literal backslashes both intact');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
