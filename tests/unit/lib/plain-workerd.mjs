// A test's own Worker on plain workerd (the binary wrangler ships), without
// wrangler or the session: the caller stages its modules and its config,
// and this owns the process: a free port, the start, readiness within a
// deadline, its logs, and a stop that waits for it to end before the
// directory goes. Workers that need wrangler dev or a session use
// workerd-probe.mjs instead.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** The workerd binary wrangler ships, so the tests run the runtime wrangler dev would. */
export const WORKERD = createRequire(require.resolve('wrangler/package.json'))('workerd').default;

/** A TCP port free on 127.0.0.1 now. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Whether something accepts a TCP connection on `port` within `ms`. */
const accepts = (port, ms) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  const settle = (accepted) => { clearTimeout(timer); socket.destroy(); resolve(accepted); };
  const timer = setTimeout(() => settle(false), ms);
  socket.once('connect', () => settle(true));
  socket.once('error', () => settle(false));
});

/** Whether GET `url` answers (any status, its body read) within `ms`. */
const answers = (url, ms) => fetch(url, { signal: AbortSignal.timeout(ms) })
  .then((response) => response.arrayBuffer())
  .then(() => true, () => false);

/**
 * Serve on plain workerd: `files` (path → text, under a fresh directory),
 * the empty directories `dirs` (a Durable Object store's, say), and
 * `config({ port, dir })`, the text of config.capnp, whose socket listens on
 * 127.0.0.1:`port`. Ready once GET `readyPath` answers (any status), or,
 * without one, once the port accepts a connection, within `deadlineMs`;
 * each readiness request is bounded by the time left. Resolves to
 * { port, base, dir, pid, logs(), exited, stop() }. If staging fails,
 * workerd exits or the deadline passes first, what was started is stopped
 * and the start rejects with workerd's logs.
 * `stop()` ends it (SIGTERM, then SIGKILL after 10 s), waits for it, then
 * removes the directory; it is also run if the test process exits first.
 */
export async function servePlainWorkerd({ files, dirs = [], config, readyPath = null, deadlineMs = 30_000, args = ['--experimental'], name = 'plain-workerd' }) {
  const dir = mkdtempSync(join(tmpdir(), `nimbus-${name}-`));
  let child = null;
  let logs = '';
  let exited = Promise.resolve();
  const removeAtExit = () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('exit', removeAtExit);
  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(killer);
      }
      process.off('exit', removeAtExit);
      rmSync(dir, { recursive: true, force: true });
    })();
    return stopping;
  };
  // From here, whatever fails stops what was started and names it.
  try {
    const port = await freePort();
    for (const path of dirs) mkdirSync(join(dir, path), { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    writeFileSync(join(dir, 'config.capnp'), config({ port, dir }));
    child = spawn(WORKERD, ['serve', 'config.capnp', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { logs += data; });
    child.stderr.on('data', (data) => { logs += data; });
    exited = new Promise((resolve) => child.once('close', resolve));
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const left = deadline - Date.now();
      if (child.exitCode !== null || child.signalCode !== null || left <= 0) {
        throw new Error(`workerd did not start within ${deadlineMs} ms (exit ${child.exitCode ?? child.signalCode})`);
      }
      if (readyPath === null ? await accepts(port, left) : await answers(`${base}${readyPath}`, left)) {
        return { port, base, dir, pid: child.pid, logs: () => logs, exited, stop };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  }
}
