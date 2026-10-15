#!/usr/bin/env bun
// chown(2)'s -1 keeps that side of the file's owner, as the session's
// filesystem keeps it in the same change (RuntimeFsBridge.chown's null): no
// owner set between a caller's look and its change is overwritten.
//
//   - a guest of bash's host (nimbus_proc.chown, as BusyBox's chown wrapper
//     calls it) with uid (uid_t)-1 changes the group alone;
//   - the shell's own chown :group (ProcessView.chown) and root's, while
//     another process changes the owner at the same time, leave that owner.
//
// Red before: bash's host handed -1 to the session, which refused it
// (EINVAL); ProcessView read the owner, then wrote it back, over the change
// made in between.

import assert from 'node:assert/strict';
import wabtInit from 'wabt';
import { runScript } from './lib/bash-preamble.mjs';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';

// A guest that calls chown("f", (uid_t)-1, 1000) as BusyBox's wrapper does, and prints its errno.
const wabt = await wabtInit();
const WAT = `(module
  (import "nimbus_proc" "chown" (func $chown (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "f")
  (data (i32.const 32) "chown=")
  (func (export "_start") (local $e i32) (local $at i32)
    (local.set $e (call $chown (i32.const -1) (i32.const 16) (i32.const 1) (i32.const -1) (i32.const 1000) (i32.const 1)))
    ;; "chown=" then the errno in decimal (at most two digits), then a newline.
    (local.set $at (i32.const 38))
    (if (i32.ge_u (local.get $e) (i32.const 10))
      (then (i32.store8 (local.get $at) (i32.add (i32.const 48) (i32.div_u (local.get $e) (i32.const 10))))
            (local.set $at (i32.add (local.get $at) (i32.const 1)))))
    (i32.store8 (local.get $at) (i32.add (i32.const 48) (i32.rem_u (local.get $e) (i32.const 10))))
    (i32.store8 (i32.add (local.get $at) (i32.const 1)) (i32.const 10))
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.sub (i32.add (local.get $at) (i32.const 2)) (i32.const 32)))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))`;
const failed = [];
const check = (what, actual, expected) => {
  try { assert.deepEqual(actual, expected); console.log(`  ✓ ${what}`); }
  catch { failed.push(`${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); console.log(`  ✗ ${what}`); }
};

const parsed = wabt.parseWat('chown.wat', WAT, {});
let guest;
try { parsed.validate(); guest = new WebAssembly.Module(parsed.toBinary({}).buffer); } finally { parsed.destroy(); }

{
  const r = await runScript('cd /tmp && chownkeep && stat -c %u:%g f', { files: { 'tmp/f': 'x' }, extraWasm: { 'cu_chownkeep.wasm': guest } });
  check('a guest\'s chown with uid (uid_t)-1 changes the group alone', { stdout: r.stdout, stderr: r.stderr }, { stdout: 'chown=0\n1000:1000\n', stderr: '' });
}

// The shell's chown :group, as root, while another process makes the file
// someone else's between its look and its change. The bridge's own calls are
// the seam: the other process's chown lands after the first call this
// chown makes of the file, whatever that call is.
{
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const root = files.openHost(CRED_KERNEL).fs;
  const other = files.openHost(CRED_KERNEL).fs;
  root.writeFile('/srv-file', new TextEncoder().encode('x'));
  root.chown('/srv-file', 1000, 1000);
  let landed = false;
  const landOnce = () => { if (!landed) { landed = true; other.chown('/srv-file', 3000, null); } };
  const seam = new Proxy(root, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== 'function') return value;
      if (name === 'stat' || name === 'lstat') return (...args) => { const answer = value.apply(target, args); landOnce(); return answer; };
      if (name === 'chown') return (...args) => { landOnce(); return value.apply(target, args); };
      return value.bind(target);
    },
  });
  const view = new ProcessView(seam);
  await view.chown('/srv-file', null, 2000);
  const stat = root.stat('/srv-file');
  check('chown :group keeps an owner changed between its look and its change', { uid: stat.uid, gid: stat.gid }, { uid: 3000, gid: 2000 });
}

assert.deepEqual(failed, [], failed.join('\n'));
console.log('chown-keeps-a-side: ok');
