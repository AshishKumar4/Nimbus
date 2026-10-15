#!/usr/bin/env bun
// The WASI layer tells a guest the truth about its descriptors and clocks,
// as Linux does, whichever host answers it: bash's own (bash/preamble.ts,
// over the shared codec wasi/filesystem.ts) and the generic WASI runner's
// (worker runtime/wasi/preamble.ts). Real bash and a WAT probe guest
// (lib/wasi-probe-guest.mjs) drive them.
//
//   - a small file read from the copy the codec keeps of it has its own
//     offset: past the end it stays where a seek put it, a read at the end
//     moves nothing, pread never moves it, and a negative pread is EINVAL;
//   - a file whose bytes are made when read (/proc's) is read anew at each
//     open, though its stat names no revision;
//   - stdin that is not a terminal is no character device, nor are its
//     duplicates and a subshell's, and `test -t 0` is false for it; a
//     terminal's is one. (Linux calls a piped stdin a FIFO, which preview1
//     has no filetype for: the libc's stat takes only the permission bits
//     from stat_metadata, so `[ -p /dev/stdin ]` stays false.)
//   - a poll on a clock no host has is that subscription's EINVAL event,
//     as clock_time_get refuses the same clock.
//
// Red before: a read at the end set the offset to the file's size; the
// codec kept a generated file's first bytes for every later open; every
// stdio descriptor reported a character device, a piped stdin too; and
// the generic runner's poll took any clock id for the monotonic clock.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';
import { probeBytes, probeWasmEntry } from './lib/wasi-probe-guest.mjs';
import { ProcVFS } from '../../packages/core/src/vfs/proc-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const failed = [];
const check = (what, actual, expected) => {
  try { assert.deepEqual(actual, expected); console.log(`  ✓ ${what}`); }
  catch { failed.push(`${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); console.log(`  ✗ ${what}`); }
};
const extraWasm = probeWasmEntry();

{
  const r = await runScript('printf abc > /tmp/f; probe seekeof < /tmp/f', { extraWasm });
  check('a resident file\'s offset: past its end, at a read at its end, under pread', r.stdout, 'seek=100 nread=0 tell=100 pread=0 tell=1 npread=E28\n');
}

{
  const gen = new ProcVFS();
  let calls = 0;
  gen.register('counter', () => `${String(++calls).padStart(6, '0')}\n`);
  const r = await runScript('read -r a </gen/counter; read -r b </gen/counter; echo "$a $b"', { mounts: { '/gen': gen } });
  const [a, b] = r.stdout.trim().split(' ').map(Number);
  check('a file made when read is read anew at the next open', { exitCode: r.exitCode, later: b > a }, { exitCode: 0, later: true });
}

{
  const kinds = '[ -c /dev/stdin ] && echo chr || echo nochr; exec 4<&0; [ -c /dev/fd/4 ] && echo chr4 || echo nochr4; '
    + '( [ -c /dev/fd/4 ] && echo sub || echo nosub )';
  check('stdin that is not a terminal is no character device, nor are its duplicate and a subshell\'s, and test -t is false',
    (await runScript(`${kinds}; test -t 0 && echo tty || echo notty`, { stdin: 'x' })).stdout, 'nochr\nnochr4\nnosub\nnotty\n');
  check('a terminal stdin is a character device', (await runScript(kinds, { stdinTty: true })).stdout, 'chr\nchr4\nsub\n');
}

{
  check('bash\'s host: a poll on clock 99 is its EINVAL event (relative)', (await runScript('probe pollbad', { extraWasm })).stdout, 'poll=0 n=1 err=28 ud=4660\n');
  check('bash\'s host: and absolute', (await runScript('probe pollbadabs', { extraWasm })).stdout, 'poll=0 n=1 err=28 ud=4660\n');
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, facets: localFacetHost(ISOLATE_NETWORK) });
  try {
    const kernel = ws.vfs.as(CRED_KERNEL);
    kernel.writeFile('home/user/probe.wasm', new Uint8Array(probeBytes()), { mode: 0o755 });
    kernel.chown('home/user/probe.wasm', 1000, 1000);
    for (const mode of ['pollbad', 'pollbadabs']) {
      const r = await ws.exec(`/home/user/probe.wasm ${mode}`, { cwd: '/home/user' });
      check(`the generic runner: ${mode}`, { stdout: r.stdout, exitCode: r.exitCode }, { stdout: 'poll=0 n=1 err=28 ud=4660\n', exitCode: 0 });
    }
  } finally {
    await ws.close();
  }
}

assert.deepEqual(failed, [], `as Linux:\n${failed.join('\n')}`);
console.log('wasi-codec-truth: ok');
