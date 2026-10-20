#!/usr/bin/env bun
// shell/nested-shell-abort — a hosted `bash -c` stops with its caller (ask 42).
//
// The hosted shell entrypoint runs the program in a child shell under the
// child's own stop signal; the caller's signal (an exec's timeout, a
// terminal's Ctrl-C) has to reach it too. Before, it replaced the caller's
// with its own, so the call settled while the loop ran on, burning the
// session's CPU. Each loop counts into a file: once the call has ended, the
// count stops moving.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('shell/nested-shell-abort');
console.log(`shell/nested-shell-abort — BASE=${BASE}`);

const loop = (file) => `i=0; while :; do i=$((i+1)); echo $i > ${file}; done`;

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const box = Nimbus.connect({
  endpoint: BASE,
  ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}),
}).sandbox(`nested-shell-abort-${Date.now()}`);

const counts = async (read, file) => {
  const first = Number((await read(`cat ${file}`)).trim());
  await sleep(2000);
  const second = Number((await read(`cat ${file}`)).trim());
  return { first, second };
};

try {
  for (const shell of ['bash', 'sh']) {
    const file = `/tmp/count-exec-${shell}`;
    const started = Date.now();
    const ran = await box.exec(`${shell} -c '${loop(file)}'`, { timeoutMs: 1500 }).catch((error) => ({ error: String(error) }));
    const settled = Date.now() - started;
    const { first, second } = await counts(async (cmd) => (await box.exec(cmd)).stdout, file);
    a.check(`exec ${shell} -c loop, timed out: settles (${settled} ms) and stops (${first} then ${second})`,
      settled < 10_000 && first > 0 && second === first,
      JSON.stringify(ran).slice(0, 300));
  }
} finally {
  await box.destroy({ reason: 'nested-shell-abort-complete' }).catch(() => {});
}

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const file = '/tmp/count-terminal';
  t.cmd(`bash -c '${loop(file)}'`);
  await sleep(1500);
  t.send('\x03');
  await t.waitForPrompt(30_000);
  const read = async (cmd) => stripAnsi((await t.run(cmd, 30_000)).output).split(/\r?\n/).find((line) => /^\d+$/.test(line.trim())) ?? '';
  const { first, second } = await counts(read, file);
  a.check(`terminal bash -c loop, Ctrl-C: stops (${first} then ${second})`, first > 0 && second === first, '');
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
