// @serial
// @tier slow — drives a local workerd
// An ES module entry attached to a terminal runs until Node's process would
// end: at process.exit, or once it holds no live handle. Completing its
// evaluation does not end it. A TUI's top level typically puts stdin in raw
// mode, listens for keys and returns, and stdin is the handle that keeps
// Node's process alive.
//
// The bug this pins: a native ES entry's evaluation is a promise, and the
// attached lifecycle ended the process when it settled. pi's bin
// (@earendil-works/pi-coding-agent, cli.js → cli-runtime.js) drew its
// interface and exited 0 at once. The cases:
//   - plain: an ES module bin whose top level listens to stdin and returns;
//   - tla: the same after a top-level await, so its evaluation settles later.
// Each must still run seconds after it is ready, read the key it is sent,
// and end with the code it exits with.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const PACKAGE = '/home/user/node_modules/esm-tui';
const FILES = {
  [`${PACKAGE}/package.json`]: JSON.stringify({
    name: 'esm-tui', version: '1.0.0', type: 'module', bin: { 'esm-tui': 'cli.js' }, nimbus: { terminal: 'attached' },
  }),
  [`${PACKAGE}/cli.js`]: [
    'if (process.argv[2] === "tla") await new Promise((resolve) => setTimeout(resolve, 200));',
    'process.stdin.setRawMode?.(true);',
    'process.stdin.on("data", (chunk) => {',
    '  if (!String(chunk).includes("q")) return;',
    '  process.stdout.write("ESM_TUI_BYE\\n");',
    '  process.exit(7);',
    '});',
    'process.stdout.write("ESM_TUI_READY " + process.argv[2] + "\\n");',
  ].join('\n'),
  // A bin shim, as an install writes one; the bin runs its target.
  '/home/user/node_modules/.bin/esm-tui': '#!/usr/bin/env node\nrequire("../esm-tui/cli.js");\n',
};

const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const { connectProcessTerminal, sleep } = await import('../behavioral/_driver.mjs');
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await session.run(
      `mkdir -p ${PACKAGE} /home/user/node_modules/.bin && node -e "const f=JSON.parse(Buffer.from('${payload}','base64').toString());for(const [n,t] of Object.entries(f))require('fs').writeFileSync(n,t);console.log('SETUP')"`,
    );
    assert.equal(setup.status, 0, setup.stdout);
    for (const mode of ['plain', 'tla']) {
      const launch = await session.run(`esm-tui ${mode}`, 120_000);
      const pid = Number(launch.stdout.match(/pid=(\d+)/)?.[1] ?? 0);
      assert.ok(pid > 0, `${mode}: the bin starts as a process of its own: ${launch.stdout.slice(-400)}`);
      const proc = await connectProcessTerminal(session.sid, pid);
      try {
        await proc.waitFor((text) => text.includes(`ESM_TUI_READY ${mode}`), 90_000, `${mode}: ready`);
        await sleep(3_000);
        assert.equal(proc.exit, null, `${mode}: still running with stdin its only handle: ${JSON.stringify(proc.exit)}`);
        proc.input('q');
        await proc.waitFor((text) => text.includes('ESM_TUI_BYE'), 30_000, `${mode}: the key read`);
        for (let i = 0; i < 200 && proc.exit === null; i++) await sleep(50);
        assert.equal(proc.exit?.code, 7, `${mode}: ends with the code it exits with: ${JSON.stringify(proc.exit)}`);
      } finally {
        proc.ws.close();
      }
      console.log(`  ${mode}: ran on past its evaluation, read its key, exited 7`);
    }
  } finally {
    await session.close();
  }
} finally {
  await probe.stop();
}
console.log('attached-esm-entry-runs-on-workerd: an attached ES entry ends as Node\'s process does');
