#!/usr/bin/env bun
/**
 * wasm-runner picks WASI and its ABI from the module's IMPORT section: an
 * import from `wasi_snapshot_preview1` is preview1, from `wasi_unstable`
 * preview0, and a module with neither runs in direct mode. The namespace's
 * text elsewhere in the binary (a custom section, a data segment holding a
 * debug string) decides nothing. The choice is read where it lands: the
 * facet's tag and the ABI the runner hands the facet.
 */

import assert from 'node:assert/strict';
import { makeWasmRunner } from '../../packages/core/src/runtime/wasm-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER_CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const text = (s) => [...new TextEncoder().encode(s)];
const name = (s) => [s.length, ...text(s)];
const section = (id, payload) => [id, payload.length, ...payload];
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const PREVIEW1 = 'wasi_snapshot_preview1';

/** (func (export "f") (result i32) i32.const 7), plus a custom section `x` holding PREVIEW1. */
const directWithCustomNeedle = new Uint8Array([
  ...HEADER,
  ...section(1, [1, 0x60, 0, 1, 0x7f]),
  ...section(3, [1, 0]),
  ...section(7, [1, ...name('f'), 0, 0]),
  ...section(10, [1, 4, 0, 0x41, 7, 0x0b]),
  ...section(0, [...name('x'), ...text(PREVIEW1)]),
]);

/** Imports wasi_unstable.proc_exit; a data segment and a custom section hold PREVIEW1. */
const preview0WithNeedles = new Uint8Array([
  ...HEADER,
  ...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
  ...section(2, [1, ...name('wasi_unstable'), ...name('proc_exit'), 0, 0]),
  ...section(3, [1, 1]),
  ...section(5, [1, 0, 1]),
  ...section(7, [1, ...name('_start'), 0, 1]),
  ...section(10, [1, 2, 0, 0x0b]),
  ...section(11, [1, 0, 0x41, 0, 0x0b, PREVIEW1.length, ...text(PREVIEW1)]),
  ...section(0, [...name('debug'), ...text(PREVIEW1)]),
]);

/** Imports wasi_snapshot_preview1.proc_exit and wasi_unstable.proc_exit: preview1 wins. */
const both = new Uint8Array([
  ...HEADER,
  ...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
  ...section(2, [2, ...name('wasi_unstable'), ...name('proc_exit'), 0, 0, ...name(PREVIEW1), ...name('proc_exit'), 0, 0]),
  ...section(3, [1, 1]),
  ...section(5, [1, 0, 1]),
  ...section(7, [1, ...name('_start'), 0, 2]),
  ...section(10, [1, 2, 0, 0x0b]),
]);

for (const [label, bytes] of Object.entries({ directWithCustomNeedle, preview0WithNeedles, both })) {
  assert.ok(WebAssembly.validate(bytes), `${label} is a valid module`);
}

function authority(files) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', USER_CRED.uid, USER_CRED.gid);
  for (const [path, bytes] of Object.entries(files)) root.writeFile(path, bytes, { mode: 0o755 });
  return new ProcessFiles(raw);
}

async function dispatch(bytes, argv) {
  const filesystem = authority({ 'home/user/program.wasm': bytes });
  const opened = [];
  const submitted = [];
  const run = makeWasmRunner({
    filesystem,
    facets: {
      parking: 'none',
      open(spec) {
        opened.push(spec);
        return {
          async submit(_fn, args) {
            submitted.push(args);
            return { ok: true, mode: args.mode, exitCode: 0, result: 7, stdout: '', stderr: '' };
          },
          dispose() {},
        };
      },
    },
    processes: {
      spawn: () => ({ pid: 42 }),
      appendOutput() {},
      exit() {},
      getExit: () => null,
      markExit() {},
    },
  });
  const result = await run('', {
    argv,
    env: {},
    cwd: '/home/user',
    filename: '/home/user/program.wasm',
    dirname: '/home/user',
    command: 'wasm-runner /home/user/program.wasm',
    cred: USER_CRED,
  });
  return { result, opened, submitted };
}

{
  const { result, opened, submitted } = await dispatch(directWithCustomNeedle, ['f']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(opened[0]?.tag, 'wasm-runner', 'a module that imports no WASI runs in direct mode');
  assert.deepEqual(submitted[0], { mode: 'direct', exportName: 'f', intArgs: [] });
}
{
  const { submitted } = await dispatch(preview0WithNeedles, []);
  assert.equal(submitted[0]?.mode, 'wasi');
  assert.equal(submitted[0]?.wasiAbi, 'preview0', 'the import decides the ABI, not a string in the data');
  assert.equal(submitted[0]?.wasiNamespace, 'wasi_unstable');
}
{
  const { submitted } = await dispatch(both, []);
  assert.equal(submitted[0]?.wasiAbi, 'preview1', 'a module importing both namespaces is preview1');
}

console.log('wasm-runner-abi-detect: ok');
