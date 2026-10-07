#!/usr/bin/env bun
// wasi-files/rename-existing — path_rename overwriting an existing destination.
//
// Exercises the W-3 sqlite-vfs.ts:1171 fix (pre-unlink-existing-target).
// Fixture creates "a" with "A\n", "b" with "B\n", then path_rename("a", "b"),
// reads "b" back and echoes it. With the W-3 fix the readback shows "A\n";
// without the fix, path_rename either errors or "b" still reads "B\n".

import { openWasiProbe, tailLines, trimmedLines } from '../wasi/_harness.mjs';

const probe = await openWasiProbe('wasi-files/rename-existing', { dir: '/home/user/w2', fixture: 'rename-existing', as: 're.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner re.wasm', 60_000);
  const tail = tailLines(r.output, 8);
  const lines = trimmedLines(tail);
  // Look for a line that's exactly "A" (the readback after rename).
  const ok = lines.includes('A');

  probe.report([['path_rename("a", "b") overwrites existing b; readback is "A"', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
