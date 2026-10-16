// @serial
// @tier slow — drives a local workerd
// The wasm bash and its programs keep a leading U+FEFF (bytes EF BB BF) in a
// relative path, as Linux keeps it: real bash 5.2 with GNU coreutils runs
// the same lines on the host, and each prints the same. $B holds the BOM;
// counts are bytes (wc -c), so no layer between needs to carry it.
//   - bash creates "$B"f (a redirection) and tests for it ([ -e ]), and cd
//     enters "$B"d: bash's own paths;
//   - ls lists the directory, and ls names "$B"f: a program's paths;
//   - a write that begins with the BOM reaches the terminal with it.
//
// Red before: the bash runner, the WASI codec and the WASI preamble each
// decoded a path with a TextDecoder that drops a leading BOM, so "$B"f was
// created as f.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const B = "B=$(printf '\\357\\273\\277')";
const lines = [
  `${B}; mkdir -p w1 && cd w1 && : > "$B"f && ls | wc -c`,
  `${B}; mkdir -p w2 && cd w2 && : > "$B"f && [ -e "$B"f ] && ls "$B"f | wc -c`,
  `${B}; mkdir -p w3/"$B"d && cd w3 && cd "$B"d && : > here && cd .. && ls | wc -c`,
];

// The oracle: host bash in a directory of its own.
const host = mkdtempSync(join(tmpdir(), 'nimbus-bom-bash-'));
const expected = [];
try {
  for (const line of lines) {
    const ran = spawnSync('bash', ['-c', line], { cwd: host, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' }, encoding: 'utf8' });
    assert.equal(ran.status, 0, `host bash: ${line}: ${ran.stderr}`);
    expected.push(ran.stdout.trim());
  }
} finally {
  rmSync(host, { recursive: true, force: true });
}
// What the oracle says, stated, so the comparison is not vacuous: each name is the BOM's 3 bytes, its letters and a newline.
assert.deepEqual(expected, ['5', '5', '5']);

const probe = await startLocalProbe();
const failed = [];
try {
  const terminal = await localTerminal(probe);
  try {
    assert.equal((await terminal.run('mkdir -p /home/user/bom && cd /home/user/bom')).status, 0);
    for (const [i, line] of lines.entries()) {
      const r = await terminal.run(`cd /home/user/bom && bash -c '${line.replaceAll("'", "'\\''")}'`, 90_000);
      const ours = r.stdout.trim();
      if (r.status === 0 && ours === expected[i]) console.log(`  ok  ${line}`);
      else {
        console.log(`  FAIL  ${line}: ours ${JSON.stringify(ours)} (status ${r.status}); bash's ${expected[i]}`);
        failed.push(line);
      }
    }
    const written = await terminal.run(`bash -c 'printf "\\357\\273\\277x\\n"'`, 90_000);
    if (written.stdout.includes('\uFEFFx')) console.log('  ok  a write that begins with the BOM reaches the terminal with it');
    else {
      console.log(`  FAIL  a write that begins with the BOM: ${JSON.stringify(written.stdout)}`);
      failed.push('write');
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
assert.deepEqual(failed, [], 'every line prints what host bash prints');
console.log('names-keep-bom-workerd: ok');
