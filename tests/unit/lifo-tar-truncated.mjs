#!/usr/bin/env bun
// The shell's `tar` on an archive that ends early, against GNU tar on the
// same bytes: run through the public workspace API, `tar -tf`, `tar -xf` and
// `tar -xzf` print, write and exit as GNU tar does.
//
//   - one that ends inside a member (its data or its padding) lists and
//     extracts the members before it, and that member's whole 512-byte
//     blocks, then fails: "Unexpected EOF in archive" (twice extracting),
//     "Error is not recoverable: exiting now", status 2;
//   - one that ends between members (at a header boundary, or inside the
//     next header) is whole: status 0.
//
// Red before: the shell's tar listed and extracted what came before the
// truncation and exited 0, as if the archive were whole.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const version = spawnSync('tar', ['--version'], { encoding: 'utf8' });
assert.match(version.stdout ?? '', /GNU tar/, `this oracle is GNU tar: ${version.stdout}${version.stderr}`);

const host = mkdtempSync(join(tmpdir(), 'lifo-tar-truncated-'));
const failed = [];
try {
  // The archive: a.txt (6 bytes), b.bin (3,000 bytes), c.txt, in 512-byte blocks.
  mkdirSync(join(host, 'src'));
  writeFileSync(join(host, 'src/a.txt'), 'first\n');
  writeFileSync(join(host, 'src/b.bin'), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251)));
  writeFileSync(join(host, 'src/c.txt'), 'third\n');
  const made = spawnSync('tar', ['--format=ustar', '-cf', join(host, 'full.tar'), '-C', join(host, 'src'), 'a.txt', 'b.bin', 'c.txt']);
  assert.equal(made.status, 0, String(made.stderr));
  const full = readFileSync(join(host, 'full.tar'));

  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });

  /** Every file under `dir` on the host, path → bytes. */
  const hostFiles = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).sort().map((name) => [name, readFileSync(join(dir, name)).toString('hex')]));
  /** The same under `dir` in the workspace. */
  const wsFiles = async (dir) => {
    const listed = await ws.exec(`cd ${dir} && find . -type f | sort`, { cwd: '/home/user' });
    const out = {};
    for (const name of listed.stdout.split('\n').filter(Boolean)) out[name.slice(2)] = Buffer.from(await ws.fs.readFile(`${dir}/${name.slice(2)}`)).toString('hex');
    return out;
  };

  const cases = {
    'ends inside b.bin\'s data': full.subarray(0, 1600),
    'ends inside b.bin\'s data, past a whole block': full.subarray(0, 2636),
    'ends inside a.txt\'s padding': full.subarray(0, 518),
    'ends at a header boundary': full.subarray(0, 1024),
    'ends inside the next header': full.subarray(0, 1100),
    'whole': full,
  };
  let n = 0;
  for (const [label, bytes] of Object.entries(cases)) {
    for (const gz of [false, true]) {
      const name = `case${n++}.tar${gz ? '.gz' : ''}`;
      const data = gz ? gzipSync(bytes) : bytes;
      writeFileSync(join(host, name), data);
      await ws.fs.writeFile(`/home/user/${name}`, data);
      for (const mode of ['t', 'x']) {
        const flags = `-${mode}${gz ? 'z' : ''}f`;
        const out = join(host, `out-${name}-${mode}`);
        mkdirSync(out);
        const native = spawnSync('tar', [flags, join(host, name)], { cwd: out, encoding: 'utf8' });
        const dir = `/home/user/out-${name}-${mode}`;
        await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
        const lifo = await ws.exec(`tar ${flags} /home/user/${name}`, { cwd: dir });
        const what = `${label}${gz ? ', gzipped' : ''}: tar ${flags}`;
        try {
          assert.equal(lifo.exitCode, native.status, `${what}: status`);
          assert.equal(lifo.stdout, native.stdout, `${what}: stdout`);
          assert.equal(lifo.stderr, native.stderr, `${what}: stderr`);
          if (mode === 'x') assert.deepEqual(await wsFiles(dir), hostFiles(out), `${what}: the files it wrote`);
        } catch (error) {
          failed.push(error.message);
        }
      }
    }
  }
  await ws.close();
} finally {
  rmSync(host, { recursive: true, force: true });
}
assert.deepEqual(failed, [], `the shell's tar differs from GNU tar:\n${failed.join('\n')}`);
console.log('ok - lifo-tar-truncated (tar -t, -x and -xz on archives that end early, as GNU tar)');
