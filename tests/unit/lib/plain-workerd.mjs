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

/** Whether something accepts a TCP connection on `port`. */
const accepts = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

/**
 * Serve on plain workerd: `files` (path → text, under a fresh directory),
 * the empty directories `dirs` (a Durable Object store's, say), and
 * `config({ port, dir })`, the text of config.capnp, whose socket listens on
 * 127.0.0.1:`port`. Ready once GET `readyPath` answers (any status), or,
 * without one, once the port accepts a connection, within `deadlineMs`;
 * each readiness request is bounded by the time left. Resolves to
 * { port, base, dir, pid, logs(), exited, stop() }. If workerd exits or the
 * deadline passes first, it is stopped and the start rejects with its logs.
 * `stop()` ends it (SIGTERM, then SIGKILL after 10 s), waits for it, then
 * removes the directory; it is also run if the test process exits first.
 */
export async function servePlainWorkerd({ files, dirs = [], config, readyPath = null, deadlineMs = 30_000, args = ['--experimental'], name = 'plain-workerd' }) {
  const dir = mkdtempSync(join(tmpdir(), `nimbus-${name}-`));
  const port = await freePort();
  for (const path of dirs) mkdirSync(join(dir, path), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, 'config.capnp'), config({ port, dir }));
  const child = spawn(WORKERD, ['serve', 'config.capnp', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const removeAtExit = () => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); };
  process.on('exit', removeAtExit);
  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
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
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const left = deadline - Date.now();
    if (child.exitCode !== null || child.signalCode !== null || left <= 0) {
      await stop();
      throw new Error(`workerd did not start within ${deadlineMs} ms (exit ${child.exitCode ?? child.signalCode}):\n${logs}`);
    }
    const ready = readyPath === null
      ? await accepts(port)
      : await fetch(`${base}${readyPath}`, { signal: AbortSignal.timeout(left) }).then(async (response) => { await response.arrayBuffer(); return true; }, () => false);
    if (ready) return { port, base, dir, pid: child.pid, logs: () => logs, exited, stop };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
