// @serial
// A reset's recovery re-drives a process through the workspace's network
// before the session has made its workspace (Kinu ask 20; the egress
// review's P1). Both of the session's recovery pumps run before it:
//
//   (1) a cold alarm. A resident under NIMBUS_RESTART=on-failure crashes, and
//       its restart waits out a backoff on the session's 'resident-launch'
//       alarm with its journal row in storage. A reset inside the backoff
//       leaves both; the replacement instance's first act is that alarm,
//       which re-drives the resident with no terminal attached, so before
//       the session has made its workspace;
//   (2) a reconnect. A running resident keeps its journal row; after a
//       reset, the reconnecting terminal's init re-drives it before it makes
//       the workspace (init.ts).
//
// Each re-driven process goes out through the egress (it answers with what
// the egress told it), and without an egress through the isolate's own
// network. The network used to be read off the workspace, so a re-drive
// that reached its spawn before the workspace was made threw and was lost:
// (1) failed so on 843133122, with and without an egress; (2) held there
// only because init made the workspace before the re-drive, which recovery
// does not await, reached its spawn.
//
// Runs with the test egress, then runs itself without it (a second probe, in
// a process of its own: the driver binds its base URL once). Runs the worker
// built in the tree (lib/workerd-probe.mjs): rebuild the generated artifacts
// before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

/** A server on `port` answering with its incarnation and how it reached the network; it crashes once first when `crashOnce`. */
const server = (port, crashOnce) => `
const fs = require('fs');
const http = require('http');
const marker = '/home/user/crashed-${port}';
if (${crashOnce} && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  setTimeout(() => process.exit(1), 300);
} else {
  const boot = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  (async () => {
    const via = process.env.EGRESSED === '1'
      ? await (await fetch('https://egress-test.invalid/recovered')).text()
      : 'its own network';
    http.createServer((req, res) => res.end(boot + ' ' + via)).listen(${port});
  })();
}
`;

async function scenario(egressed) {
  const tag = `NIMBUS_TEST_EGRESS=${egressed ? 1 : 0}`;
  console.log(`workspace-egress-reset-recovery-workerd: starting local workerd (${tag})`);
  const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: egressed ? '1' : '0', NIMBUS_DEBUG: '1' } });
  try {
    const session = await localTerminal(probe, { install: [] });
    const { requestHeaders, fetchPort, sleep, Terminal } = await import('../behavioral/_driver.mjs');
    const { sid } = session;
    const via = egressed ? 'via-egress GET /recovered' : 'its own network';
    /** The port's answer once it is up, or the last one after `budgetMs`. */
    const portUp = async (port, budgetMs) => {
      let last = { status: 0, body: '' };
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        last = await fetchPort(sid, port, '');
        if (last.status === 200) break;
        await sleep(250);
      }
      return last;
    };
    /** Reset the instance, and wait for `terminal` to see it. */
    const reset = async (terminal) => {
      const abort = await fetch(`${probe.base}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders() });
      assert.equal(abort.status, 204, 'the reset was taken');
      const deadline = Date.now() + 10_000;
      while (!terminal.closed && Date.now() < deadline) await sleep(25);
      assert.ok(terminal.closed, 'the reset ended the instance (its terminal dropped)');
    };
    /** A terminal on the session, once its prompt is up (NIMBUS_DEBUG's lines may follow it). */
    const attach = async () => {
      const attached = new Terminal(sid);
      await attached.connect();
      await attached.waitFor((b) => /user@nimbus:[^\n]*\$ /.test(b), 60_000, 'prompt');
      return attached;
    };
    let terminal = session.terminal;
    try {
      await session.writeFile('/home/user/once.js', server(4322, true));
      await session.writeFile('/home/user/server.js', server(4321, false));

      // ── (1) a cold alarm ──────────────────────────────────────────────────
      {
        terminal.reset();
        terminal.cmd(`cd /home/user && NIMBUS_RESTART=on-failure EGRESSED=${egressed ? 1 : 0} node once.js`);
        await terminal.waitFor((b) => /restarting in 1s/.test(b), 60_000, 'the crash and its restart backoff');
        await reset(terminal);
        const after = await portUp(4322, 60_000);
        console.log(`  (1) cold alarm (${tag}): ${after.status} ${JSON.stringify(after.body.slice(0, 80))}`);
        assert.equal(after.status, 200, `(1) the cold alarm re-drove the resident: ${after.status} ${after.body.slice(0, 200)}`);
        assert.match(after.body, new RegExp(`^\\w+ ${via}$`), '(1) and it went out through the workspace network');
      }

      // ── (2) a reconnect ───────────────────────────────────────────────────
      {
        terminal = await attach();
        terminal.reset();
        terminal.cmd(`cd /home/user && EGRESSED=${egressed ? 1 : 0} node server.js`);
        const before = await portUp(4321, 60_000);
        assert.equal(before.status, 200, `the resident serves before the reset: ${before.body.slice(0, 200)}`);
        await reset(terminal);
        terminal = await attach();
        const after = await portUp(4321, 60_000);
        console.log(`  (2) reconnect (${tag}): ${after.status} ${JSON.stringify(after.body.slice(0, 80))}`);
        assert.equal(after.status, 200, `(2) the reconnect re-drove the resident: ${after.status} ${after.body.slice(0, 200)}`);
        assert.match(after.body, new RegExp(`^\\w+ ${via}$`), '(2) and it went out through the workspace network');
        assert.notEqual(after.body.split(' ')[0], before.body.split(' ')[0], '(2) a new incarnation answers');
      }
    } finally {
      await terminal.close().catch(() => {});
      await session.close().catch(() => {});
    }
  } finally {
    await probe.stop();
  }
}

const egressed = (process.env.NIMBUS_TEST_EGRESS ?? '1') === '1';
await scenario(egressed);
if (process.env.NIMBUS_TEST_EGRESS === undefined) {
  const without = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, NIMBUS_TEST_EGRESS: '0' }, stdio: 'inherit', timeout: 900_000,
  });
  assert.equal(without.status, 0, 'without an egress');
  console.log('ok - workspace-egress-reset-recovery-workerd (a cold alarm and a reconnect re-drive residents through the workspace network, with and without an egress)');
} else {
  console.log(`ok - workspace-egress-reset-recovery-workerd (NIMBUS_TEST_EGRESS=${process.env.NIMBUS_TEST_EGRESS})`);
}
