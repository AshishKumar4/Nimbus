#!/usr/bin/env bun
// preview/new/real-vite-lifecycle — `NIMBUS_REAL_VITE=1 vite` is one of the
// session's processes, from start to end, as a user meets it:
//   - `vite` returns with the server up: the first page is served at once,
//     on the preview path and on its port;
//   - `ps` lists it running;
//   - `kill <pid>` ends it as SIGTERM;
//   - `vite` starts it again under a new pid, and `vite stop` ends that one;
//   - a server that ended stays ended: a request to the preview path or its
//     port does not start it again.

import { BASE, Terminal, mintSession, deleteSession, makeAsserter, heredocCommand, fetchPreview, fetchPort, outputLines } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('preview/new/real-vite-lifecycle');
const sid = await mintSession();
const root = '/home/user/lifecycle-app';
const port = 5183;
const marker = 'lifecycle-' + Date.now();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  await terminal.run(`mkdir -p ${root}/src`, 10_000);
  const files = {
    'package.json': JSON.stringify({ name: 'lifecycle-app', private: true, type: 'module' }),
    'vite.config.js': `export default ${JSON.stringify({ server: { allowedHosts: [new URL(BASE).hostname] } })};\n`,
    'index.html': `<!doctype html><html><body><p>${marker}</p><script type="module" src="/src/main.js"></script></body></html>`,
    'src/main.js': `document.body.dataset.app = ${JSON.stringify(marker)};\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    await terminal.run(heredocCommand(`${root}/${name}`, content), 10_000);
  }

  /** `ps`'s status for each real-vite pid, newest last. */
  /** After an end: /preview and /port answer without a server, and none started again. */
  const staysEnded = async (what) => {
    const preview = await fetchPreview(sid);
    a.check(`${what}: the preview path does not serve it again`, !(preview.status === 200 && preview.html.includes(marker)),
      `status=${preview.status} ${preview.html.slice(0, 200)}`);
    const onPort = await fetchPort(sid, port, '');
    a.check(`${what}: its port does not serve it again`, onPort.status !== 200, `status=${onPort.status} ${onPort.body.slice(0, 200)}`);
    const live = (await servers()).filter((s) => s.status === 'running');
    a.check(`${what}: no server was started again`, live.length === 0, JSON.stringify(live));
  };
  const servers = async () => {
    const ps = await terminal.run('ps', 10_000);
    return outputLines(ps.output).filter((l) => l.includes('vite (real,'))
      .map((l) => { const [pid, status] = l.split(/\s+/); return { pid: Number(pid), status }; });
  };
  const statusOf = async (pid) => (await servers()).find((s) => s.pid === pid)?.status;
  const start = async () => {
    const started = await terminal.run(`cd ${root} && NIMBUS_REAL_VITE=1 vite --host 0.0.0.0 --port ${port} --no-install-check`, 180_000);
    a.check('vite starts the real-vite server', started.exitCode === 0, started.output.slice(-600));
    const listed = (await servers()).at(-1);
    a.check('ps lists the server running', listed?.status === 'running', JSON.stringify(listed));
    return listed?.pid;
  };

  const pid = await start();
  const preview = await fetchPreview(sid);
  a.check('the preview path serves its first page once vite returns',
    preview.status === 200 && preview.html.includes(marker), `status=${preview.status} ${preview.html.slice(0, 300)}`);
  const onPort = await fetchPort(sid, port, 'src/main.js');
  a.check('its port serves a module', onPort.status === 200 && onPort.body.includes(marker),
    `status=${onPort.status} ${onPort.body.slice(0, 300)}`);

  const killed = await terminal.run(`kill ${pid}`, 30_000);
  a.check('kill succeeds', killed.exitCode === 0, killed.output);
  const afterKill = await statusOf(pid);
  a.check('kill ends it as SIGTERM', afterKill === 'killed(143)', String(afterKill));
  await staysEnded('after kill');

  const again = await start();
  a.check('vite starts it again under a new pid', again !== pid, `pid ${pid} then ${again}`);
  const served = await fetchPort(sid, port, '');
  a.check('the new server serves', served.status === 200 && served.body.includes(marker), `status=${served.status}`);
  const stopped = await terminal.run('vite stop', 30_000);
  a.check('vite stop says it stopped the server', stopped.output.includes('Dev server stopped'), stopped.output);
  const afterStop = await statusOf(again);
  a.check('vite stop ends it, exiting 0', afterStop === 'exited(0)', String(afterStop));
  await staysEnded('after vite stop');
} finally {
  await terminal.close();
  const deleted = await deleteSession(sid);
  a.check('the probe session is deleted', deleted.ok, `status=${deleted.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
