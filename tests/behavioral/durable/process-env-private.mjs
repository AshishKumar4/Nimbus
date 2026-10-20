#!/usr/bin/env bun
// durable/process-env-private — a process's launch environment is its own.
//
// WHAT IT PROVES
//   A resident Node server and a Python socket server are launched by the
//   session user with a secret in their environment. Another account on the
//   box then searches everything the box keeps under /.nimbus and /var (the
//   image stores, which every process can read) and finds no trace of either
//   secret, as on Linux a process's environ is its owner's alone. The
//   session's diagnostics name the shell's environment, never its values.
//   Each process still sees its own environment, and after a real reset of
//   the session (`_diag/abort`) the Node server is relaunched on its port
//   with the same environment: the session keeps it in a row of its own
//   object, outside the filesystem, and gives it back.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, fetchPort, sleep, stripAnsi, requestHeaders } from '../_driver.mjs';
import { afterReset, resetInstance } from './_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/process-env-private');
console.log(`durable/process-env-private — BASE=${BASE}`);

const NODE_SECRET = `node-${crypto.randomUUID()}`;
const PYTHON_SECRET = `py-${crypto.randomUUID()}`;
const SHELL_SECRET = `shell-${crypto.randomUUID()}`;
const NODE_PORT = 3000;
const PYTHON_PORT = 8000;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

/** `command`'s output, ANSI stripped, and its exit. */
const run = async (command, ms = 120_000) => {
  const { output, exitCode } = await t.run(command, ms);
  return { text: stripAnsi(output), exitCode };
};

/** Poll the port until it answers `needle`, or the budget runs out. */
async function pollPort(port, needle, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await fetchPort(sid, port, '').catch((error) => ({ status: 0, body: String(error) }));
    if (last.status === 200 && last.body.includes(needle)) return { ok: true, last };
    await sleep(500);
  }
  return { ok: false, last };
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // ── Two processes, each with a secret in its environment ──────────────
  await run(heredocCommand('/home/user/env-server.js', `require('http').createServer((q, s) => s.end('env:' + (process.env.SECRET_TOKEN || 'none'))).listen(${NODE_PORT});\n`), 10_000);
  t.cmd(`cd /home/user && SECRET_TOKEN=${NODE_SECRET} node env-server.js &`);
  const node = await pollPort(NODE_PORT, `env:${NODE_SECRET}`, 90_000);
  a.check('the Node server sees its own environment', node.ok, JSON.stringify(node.last).slice(0, 300));

  const python = await run('nimbus install python', 240_000);
  a.check('python installs', python.exitCode === 0, python.text.slice(-300));
  await run(heredocCommand('/home/user/env-server.py', [
    'import http.server, os',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    "        body = ('env:' + os.environ.get('SECRET_TOKEN', 'none')).encode()",
    '        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)',
    `http.server.HTTPServer(("0.0.0.0", ${PYTHON_PORT}), H).serve_forever()`,
    '',
  ].join('\n')), 10_000);
  t.cmd(`cd /home/user && SECRET_TOKEN=${PYTHON_SECRET} python3 env-server.py &`);
  const py = await pollPort(PYTHON_PORT, `env:${PYTHON_SECRET}`, 120_000);
  a.check('the Python server sees its own environment', py.ok, JSON.stringify(py.last).slice(0, 300));

  // ── Another account searches what every process can read ──────────────
  await run(`sudo sh -c 'echo "alice:x:1001:1001:alice:/home/alice:/bin/sh" >> /etc/passwd && echo "alice:x:1001:" >> /etc/group'`, 10_000);
  const who = await run('sudo -u alice id -u', 10_000);
  a.check('the second account exists', who.text.includes('1001'), who.text.slice(-200));
  const search = await run(`sudo -u alice grep -rl -e ${NODE_SECRET} -e ${PYTHON_SECRET} /.nimbus /var; echo "SEARCHED $?"`, 120_000);
  const found = search.text.split('\n').filter((line) => line.startsWith('/.nimbus') || line.startsWith('/var'));
  // A directory alice may not read is no place she finds them: grep says so (status 2), and finds nothing.
  a.check('another account finds neither secret anywhere under /.nimbus or /var', /SEARCHED [12]/.test(search.text) && found.length === 0,
    `found in: ${found.join(', ') || '(none)'}; ${search.text.slice(-300)}`);

  // ── The session's diagnostics name the shell's environment only ───────
  await run(`export SHELL_TOKEN=${SHELL_SECRET}`, 10_000);
  const diag = await fetch(`${BASE}/s/${encodeURIComponent(sid)}/api/_diag/session`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(10_000) });
  const diagBody = await diag.text();
  a.check('the session diagnostics hold no value of the shell environment', diag.ok && !diagBody.includes(SHELL_SECRET),
    `${diag.status}: ${diagBody.includes(SHELL_SECRET) ? 'the value is in the body' : diagBody.slice(0, 200)}`);

  // ── A real reset: the Node server is relaunched with its environment ──
  const reset = await resetInstance(sid);
  a.check('the session object resets', reset.ok, reset.detail);
  const back = await afterReset(() => pollPort(NODE_PORT, `env:${NODE_SECRET}`, 120_000));
  a.check('after the reset, the relaunched Node server has the same environment', back.ok, JSON.stringify(back.last).slice(0, 300));
} catch (error) {
  a.check('the scenario ran', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
