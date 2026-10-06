#!/usr/bin/env bun
// local-facet-host-parking — the in-process facet host parks a guest when the
// engine can suspend wasm (JSPI: WebAssembly.Suspending + promising, which Bun's
// JavaScriptCore ships), and answers every syscall on the guest's own stack
// where it cannot (Node 22). The choice is the host's own, made once from the
// engine, not a flag.
//
// Why it matters: a plain-WASI child (BusyBox `cat`) has no yield point inside
// its `_start`; only a suspending import table lets a writer wait at a pipe's
// capacity. Without it, `seq 100000 | cat | head -1` had `cat` spool all of
// `seq` before `head` ran, so `seq` was credited with exit 0 where GNU gives
// 141 (traced: /mnt/scratch/nimbus/verify/release/pipe-trace-local.json).
//
// Real GNU bash 5.2.37 and real BusyBox through NimbusWorkspace + localFacetHost,
// exactly as core-wasm-runtime-bun.mjs drives them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { BASH_RUNNER } from '../../packages/core/src/runtime/os-contracts.ts';

const WASM_DIR = new URL('../../packages/worker/wasm/', import.meta.url).pathname;
const files = [
  ['share/bash/bash.async.wasm', `${WASM_DIR}bash/bash.async.wasm`],
  ['share/bash/coreutils/busybox.wasm', `${WASM_DIR}bash/coreutils/busybox.wasm`],
  ['share/bash/coreutils/busybox.applets', `${WASM_DIR}bash/coreutils/busybox.applets`],
];
if (files.some(([, disk]) => !existsSync(disk))) {
  console.log('local-facet-host-parking: SKIPPED (bash runtime not built)');
  process.exit(0);
}

// ── The contract: parking follows the engine ────────────────────────────────
const engineParks = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const host = localFacetHost(ISOLATE_NETWORK);
assert.equal(host.parking, engineParks ? 'jspi' : 'none', 'the local host parks exactly when the engine can suspend wasm');
// Under the same engine with JSPI hidden, the host says 'none' and nothing
// else about it changes: the capability is read at construction.
{
  const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending');
  Object.defineProperty(WebAssembly, 'Suspending', { value: undefined, configurable: true, writable: true });
  try {
    const bare = localFacetHost(ISOLATE_NETWORK);
    assert.equal(bare.parking, 'none', 'no Suspending: the host answers syscalls on the guest stack');
    assert.equal(bare.memoryBudgetBytes, host.memoryBudgetBytes, 'the budget is the same either way');
  } finally {
    if (descriptor) Object.defineProperty(WebAssembly, 'Suspending', descriptor);
    else Reflect.deleteProperty(WebAssembly, 'Suspending');
  }
  assert.equal(localFacetHost(ISOLATE_NETWORK).parking, host.parking, 'restored: the same answer as before');
}
console.log(`  ok  localFacetHost().parking = ${host.parking} on this engine`);

// ── Real bash through the host it would get in production ───────────────────
const KERNEL = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', facets: host });
{
  const fs = ws.vfs.as(KERNEL);
  const root = 'home/user/.nimbus/runtimes/bash/5.2.37-3';
  const manifest = [];
  const applets = readFileSync(`${WASM_DIR}bash/coreutils/busybox.applets`, 'utf8').split('\n').filter(Boolean);
  const all = [...files, ...applets.map((name) => [`bin/${name}`, null])];
  for (const [path, disk] of all) {
    const bytes = disk === null ? Buffer.from('Nimbus WASI multicall entry\n') : readFileSync(disk);
    fs.mkdir(`${root}/${path}`.replace(/\/[^/]+$/, ''), { recursive: true });
    fs.writeFile(`${root}/${path}`, new Uint8Array(bytes), { mode: path.startsWith('bin/') ? 0o755 : 0o644 });
    manifest.push({ path, content: `blobs/bash-5.2.37-3/${path}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  }
  fs.writeFile(`${root}/manifest.json`, JSON.stringify({
    name: 'bash', version: '5.2.37-3', license: 'GPL-3.0-or-later', wasi_namespace: 'wasi_snapshot_preview1',
    files: manifest, entrypoints: [{ binName: 'bash', runner: BASH_RUNNER, args: [] }],
  }));
}
await ws.close();
const shell = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', facets: localFacetHost(ISOLATE_NETWORK) });

const run = async (command, seconds = 30) => Promise.race([
  shell.exec(`bash -c '${command.replaceAll("'", "'\\''")}'`),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${command}: still running after ${seconds} s`)), seconds * 1000)),
]);
const check = async (command, want, label) => {
  const r = await run(command);
  assert.equal(r.exitCode, 0, `${command}: ${r.stderr}`);
  assert.equal(r.stdout, want, label ?? command);
};

// Bytes and statuses that hold on either substrate: fully draining pipelines,
// a truncating leaf, a signalled child, exit propagation, stderr merge.
const EITHER = [
  ['seq 100000 | cat | cat >/dev/null; echo "${PIPESTATUS[*]}"', '0 0 0\n'],
  ['seq 100000 | cat | wc -l; echo "${PIPESTATUS[*]}"', '100000\n0 0 0\n'],
  ['seq 20000 | uniq -c | wc -l; echo "${PIPESTATUS[*]}"', '20000\n0 0 0\n'],
  ['seq 100000 | head -1; echo "${PIPESTATUS[*]}"', '1\n141 0\n'],
  ['yes | head -2; echo "${PIPESTATUS[*]}"', 'y\ny\n141 0\n'],
  ['seq 100000 | cat | while read x; do :; done; echo "${PIPESTATUS[*]}"', '0 0 0\n'],
  ['printf "abc\\ndef\\n" | head -c 4; s="${PIPESTATUS[*]}"; echo; echo "$s"', 'abc\n\n0 0\n'],
  ['(echo out; echo err >&2) 2>&1 | sort; echo "${PIPESTATUS[*]}"', 'err\nout\n0 0\n'],
  ['(exit 3) | cat; echo "${PIPESTATUS[*]}"', '3 0\n'],
  ['sleep 30 | cat & j=$!; kill -TERM %1; wait $j; echo "rc=$?"', 'rc=143\n'],
  // A timer under the reader while a writer is parked at capacity.
  ['seq 100000 | { sleep 1; head -1; }; echo "${PIPESTATUS[*]}"', '1\n141 0\n'],
];
for (const [command, want] of EITHER) await check(command, want);
console.log(`  ok  ${EITHER.length} draining, truncating, signal and exit cases match GNU`);

// The case a synchronous child cannot get right: the middle stage must wait at
// the pipe's capacity for `head` to leave before `seq` can be judged.
{
  const r = await run('seq 100000 | cat | head -1; echo "${PIPESTATUS[*]}"');
  assert.equal(r.exitCode, 0, r.stderr);
  if (host.parking === 'jspi') {
    assert.equal(r.stdout, '1\n141 141 0\n', 'with a parking host every stage that wrote to a closed pipe reports SIGPIPE, as GNU does');
    console.log('  ok  seq 100000 | cat | head -1 is 141 141 0 (GNU) on the parking local host');
  } else {
    // Documented residual on a host without JSPI (pipe-rules.ts holdsExit):
    // the middle stage spools before head runs. Not a waiver of the GNU
    // expectation; pipe-sigpipe-both-shells.mjs keeps it pending for this host.
    assert.equal(r.stdout, '1\n0 141 0\n', 'without JSPI the writer is credited before head closes (known residual)');
    console.log('  ok  seq 100000 | cat | head -1 is 0 141 0 on a host without JSPI (documented residual, GNU is 141 141 0)');
  }
}
await shell.close();
console.log('local-facet-host-parking: ok');
