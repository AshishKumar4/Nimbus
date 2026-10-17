// @serial
// @tier slow — drives a local workerd
// `node -c` of TypeScript whose module syntax Node retries as an ES module
// (check_syntax.js wrapSafe, for any format but commonjs; ShouldRetryAsESM):
// Node checks it as a module and exits 0; Nimbus cannot compile an ES module
// without evaluating it, so it exits 9, saying why, and runs nothing. Host
// node states its own answer for each file, so the difference is explicit.
//
// Red before: the hosted node ran every program -c named.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const ROOT = '/home/user/chk';
const modules = {
  'm.mts': 'console.log("ran");\nexport const a = 1;\n',
  'n.ts': 'export const a: number = 1;\nconsole.log("ran");\n',
};
const hostDir = mkdtempSync(join(tmpdir(), 'node-check-modules-'));
try {
  for (const [name, text] of Object.entries(modules)) {
    writeFileSync(join(hostDir, name), text);
    const host = spawnSync('node', ['-c', name], { cwd: hostDir, encoding: 'utf8' });
    assert.deepEqual([host.status, host.stdout], [0, ''], `host node checks ${name} as an ES module, and runs nothing: ${host.stderr}`);
  }
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
const REFUSED = 'node: -c cannot check an ES module entry in Nimbus without running it\n';
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    await session.run(`mkdir -p ${ROOT}`, 30_000);
    for (const [name, text] of Object.entries(modules)) await session.writeFile(`${ROOT}/${name}`, text);
    for (const name of Object.keys(modules)) {
      const r = await session.run(`cd ${ROOT} && node -c ${name} > out.txt 2> err.txt; echo "exit=$?"; cat out.txt; echo ---; cat err.txt`, 120_000);
      const text = r.stdout.replace(/\r/g, '');
      assert.match(text, /exit=9\n/, `node -c ${name}: exit 9 (${text})`);
      assert.ok(text.includes(`---\n${REFUSED}`), `node -c ${name}: says why (${text})`);
      assert.doesNotMatch(text, /\bran\b/, `node -c ${name}: nothing ran (${text})`);
      console.log(`  ok  node -c ${name}: refused, exit 9, nothing ran`);
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-check-module-refusals-workerd: ok');
