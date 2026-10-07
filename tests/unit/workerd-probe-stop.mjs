// workerd-probe's stop() ends every wrangler dev the probe started, each
// with its whole process group. wrangler spawns an esbuild service beneath
// it that outlives it: when the first wrangler lost its bind and the probe
// retried on another port, that service kept the stderr the test reads, and
// the test process never exited after its last line (3 of 48 copies of
// node-runtime-code-workerd at eight at once, each killed by the suite's
// per-file timeout after passing).
//
// A stand-in wrangler: `r2 object put` succeeds; the first `dev` leaves a
// helper holding its stderr, as the esbuild service does, loses its bind
// and exits; the next serves. The probe runs in a process of its own, which
// must exit once stop() has returned, and no helper may be left.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const dir = mkdtempSync(join(tmpdir(), 'workerd-probe-stop-'));
let child = null;
let helper = null;
try {
  const wrangler = join(dir, 'wrangler');
  writeFileSync(wrangler, `#!/bin/sh
case "$1" in r2) exit 0 ;; esac
while [ $# -gt 0 ]; do [ "$1" = --port ] && port=$2; shift; done
if [ ! -e "${dir}/lost" ]; then
  : > "${dir}/lost"
  sleep 600 &
  echo $! > "${dir}/helper"
  echo "Address already in use (127.0.0.1:$port)" >&2
  exit 1
fi
exec "${process.execPath}" -e "Bun.serve({ hostname: '127.0.0.1', port: $port, fetch: () => new Response('ok') }); console.log('Ready on http://127.0.0.1:$port')"
`);
  chmodSync(wrangler, 0o755);
  const lib = new URL('./lib/workerd-probe.mjs', import.meta.url).href;
  child = spawn(process.execPath, ['-e', `
    const { startLocalProbe } = await import(${JSON.stringify(lib)});
    const probe = await startLocalProbe({ runtimes: [], wrangler: ${JSON.stringify(wrangler)} });
    console.log('serving ' + probe.base);
    await probe.stop();
    console.log('stopped');`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // The work (two stand-ins started, one served) is bounded loosely; the
  // exit after `stopped` is not work: a process left holding nothing ends
  // at once, and the bug leaves it running for good.
  const settled = (ms) => Promise.race([exit, new Promise((resolve) => setTimeout(resolve, ms, 'running'))]);
  for (const started = Date.now(); !/^stopped$/m.test(out) && Date.now() - started < 120_000;) {
    if (await settled(100) !== 'running') break;
  }
  assert.match(out, /^stopped$/m, `the probe served on the second wrangler and stopped:\n${out}`);
  assert.equal(out.match(/workerd-probe: starting wrangler dev/g)?.length, 2, `the first wrangler lost its bind and the probe retried:\n${out}`);
  assert.equal(await settled(20_000), 0, `the probe's process exits once stop() has returned:\n${out}`);
  helper = Number(readFileSync(join(dir, 'helper'), 'utf8'));
  for (let i = 0; i < 40 && alive(helper); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(helper), false, 'the helper the first wrangler left in its group is ended with it');
  console.log('  ok  stop() ends every wrangler group the probe started, a retried one\'s too, and the process exits');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (helper === null && existsSync(join(dir, 'helper'))) helper = Number(readFileSync(join(dir, 'helper'), 'utf8'));
  if (helper && alive(helper)) process.kill(helper, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
console.log('workerd-probe-stop OK');
