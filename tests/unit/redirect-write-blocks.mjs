#!/usr/bin/env bun
// A redirection writes its file in blocks, not one storage write per piece.
//
// `yes | head -c 48M > big.txt` took over 120 s on a local workerd (the
// node-runtime-code-workerd gate's prompt timeout). Each 8 KiB `head` wrote
// was its own file write, and each rewrote the file's still-growing last chunk
// (content-defined chunks average 32 KiB), so the database stored several
// bytes for each byte of the file; in a Durable Object every turn that wrote
// also waits for its commit. What has to hold, through ws.exec:
//
//   (1) the bytes the database is handed for a piped redirect are about the
//       file's own (no rewrite of a growing tail per piece), and the file is
//       exactly what was written;
//   (2) what a command wrote is in the file when it ends: the next command
//       reads it, through its own redirection, an `exec`-held descriptor, or
//       an append;
//   (3) a long-running writer's file stays current: what it wrote is there
//       within a fraction of a second while it still runs.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
// The bytes the workspace hands its database, as blobs.
let blobBytes = 0;
const sql = {
  exec(query, ...params) {
    for (const param of params) if (param instanceof Uint8Array) blobBytes += param.byteLength;
    return harness.sql.exec(query, ...params);
  },
};
const ws = await NimbusWorkspace.create({ sql, transactions: harness.ctx, generation: 1 });
const run = async (line) => {
  const result = await ws.exec(line, { cwd: '/home/user' });
  assert.equal(result.exitCode, 0, `${line}: ${result.stderr}`);
  return result.stdout;
};
const text = async (path) => new TextDecoder().decode(await ws.fs.readFile(path));

// ── (1) a piped redirect stores about what it writes ───────────────────────
{
  const SIZE = 4 * 1048576;
  /** The bytes the database is handed while `line` runs. */
  const stored = async (line) => {
    const before = blobBytes;
    await run(line);
    return blobBytes - before;
  };
  // Lines that never repeat, so no chunk is stored once for many.
  const unique = await stored(`seq 1 1000000 | head -c ${SIZE} > /home/user/seq.txt`);
  assert.equal((await ws.fs.stat('/home/user/seq.txt')).size, SIZE);
  assert.equal((await text('/home/user/seq.txt')).slice(0, 12), '1\n2\n3\n4\n5\n6\n');
  const amplification = unique / SIZE;
  console.log(`  seq | head -c 4M > file: the database was handed ${(unique / 1048576).toFixed(1)} MiB (${amplification.toFixed(2)}x)`);
  assert.ok(amplification < 1.25, `(1) a piped redirect stores about the file's own bytes, not ${amplification.toFixed(2)}x`);
  // And the gate's own pipeline, byte for byte.
  await run(`yes | head -c ${SIZE} > /home/user/big.txt`);
  const bytes = await ws.fs.readFile('/home/user/big.txt');
  assert.equal(bytes.byteLength, SIZE);
  assert.ok(bytes.every((b, i) => b === (i % 2 === 0 ? 121 : 10)), 'the file is exactly what yes wrote');
}

// ── (2) a command's writes are in the file when it ends ────────────────────
{
  assert.equal(await run('echo one > /home/user/a.txt; echo two >> /home/user/a.txt; cat /home/user/a.txt'), 'one\ntwo\n');
  assert.equal(await run('exec 3>/home/user/held.txt; echo held >&3; cat /home/user/held.txt; echo more >&3; cat /home/user/held.txt; exec 3>&-'), 'held\nheld\nmore\n',
    '(2) a write through an exec-held descriptor is in the file once its command ends');
  assert.equal(await run('{ echo first; cat /home/user/a.txt; } > /home/user/b.txt; cat /home/user/b.txt'), 'first\none\ntwo\n');
  assert.equal(await run('for i in 1 2 3; do echo $i >> /home/user/n.txt; done; cat /home/user/n.txt'), '1\n2\n3\n');
}

// ── (3) a long-running writer's file stays current ─────────────────────────
{
  const writer = ws.exec('{ echo early; sleep 2; echo late; } > /home/user/slow.txt', { cwd: '/home/user' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await text('/home/user/slow.txt'), 'early\n', '(3) what a running writer wrote is in its file within a fraction of a second');
  assert.equal((await writer).exitCode, 0);
  assert.equal(await text('/home/user/slow.txt'), 'early\nlate\n');
}

await ws.close();
console.log('ok - redirect-write-blocks (a redirection stores about what it writes, current at each command\'s end and within 100 ms)');
