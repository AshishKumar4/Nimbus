#!/usr/bin/env bun
// diff compares two 10,000-line files in memory linear in their size: GNU's
// Myers search (gnulib diffseq.h, ported in diff-analysis.ts) keeps two
// diagonal vectors, not the (m+1)×(n+1) table the LCS diff built, which for
// these files was a hundred million cells. Its output is GNU diff 3.12's,
// checked against /usr/bin/diff where GNU diffutils is installed: on a
// sparse change, and on two permutations of the same lines, where the
// search runs past its cost bound and GNU's give-up heuristic decides.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const N = 10_000;
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffled = () => {
  const lines = Array.from({ length: N }, (_, i) => `line ${i}`);
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  return lines;
};
const sparse = Array.from({ length: N }, (_, i) => `line ${i % 97}`);
const PAIRS = {
  sparse: [sparse, sparse.map((line, i) => (i % 50 === 0 ? `changed ${i}` : line))],
  permuted: [shuffled(), shuffled()],
};

const gnu = spawnSync('/usr/bin/diff', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU diffutils');
const disk = mkdtempSync(join(tmpdir(), 'diff-linear-'));
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const [name, [a, b]] of Object.entries(PAIRS)) {
    const [textA, textB] = [`${a.join('\n')}\n`, `${b.join('\n')}\n`];
    await ws.fs.writeFile('/tmp/a', textA);
    await ws.fs.writeFile('/tmp/b', textB);
    for (const options of [[], ['-u', '-L', 'A', '-L', 'B']]) {
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      const result = await ws.exec(`cd /tmp && diff ${options.join(' ')} a b > out; echo $?`);
      const grown = process.memoryUsage().rss - before;
      assert.equal(result.stdout, '1\n', `${name} ${options.join(' ')}: ${result.stderr}`);
      assert.ok(grown < 128 * 1048576, `${name} ${options.join(' ') || 'normal'}: diff grew the process by ${(grown / 1048576).toFixed(0)} MiB`);
      if (gnu) {
        writeFileSync(join(disk, 'a'), textA);
        writeFileSync(join(disk, 'b'), textB);
        const reference = spawnSync('/usr/bin/diff', [...options, 'a', 'b'], { cwd: disk, maxBuffer: 1 << 26 });
        const ours = Buffer.from(await ws.fs.readFile('/tmp/out'));
        assert.ok(ours.equals(reference.stdout), `${name} ${options.join(' ') || 'normal'}: the output is GNU diff's`);
      }
    }
  }
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`diff-linear-memory: two 10,000-line pairs, linear memory${gnu ? ', GNU diff output' : ''}`);
