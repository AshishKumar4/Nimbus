#!/usr/bin/env bun
// durable/image-privacy — what a process could read stays its principal's.
//
// WHAT IT PROVES
//   The session user keeps a secret in a 0600 file of their home, and types
//   another inline before a command (`SECRET_TOKEN=… node server.js &`),
//   which the shell saves in the 0600 ~/.bash_history. A resident Node
//   server and a Python socket server start and read the file. Another
//   account on the box then searches everything the box keeps under
//   /.nimbus (the generated program images, the durable images) and finds
//   no trace of either secret, as on Linux it cannot read another user's
//   0600 files. Each server still answers with what it read, and after a
//   real reset of the session (`_diag/abort`) the Node server is relaunched
//   and reads it again.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, fetchPort, sleep, stripAnsi } from '../_driver.mjs';
import { afterReset, resetInstance } from './_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/image-privacy');
console.log(`durable/image-privacy — BASE=${BASE}`);

const FILE_SECRET = `file-${crypto.randomUUID()}`;
const INLINE_SECRET = `inline-${crypto.randomUUID()}`;
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

  // ── A 0600 secret, and one the shell saves in its 0600 history ────────
  await run(heredocCommand('/home/user/.token', `${FILE_SECRET}\n`), 10_000);
  const mode = await run('chmod 600 /home/user/.token && stat -c %a /home/user/.token', 10_000);
  a.check('the secret file is the user\'s alone', mode.text.includes('600'), mode.text.slice(-200));
  await run(heredocCommand('/home/user/server.js', [
    "const token = require('fs').readFileSync('/home/user/.token', 'utf8').trim();",
    `require('http').createServer((q, s) => s.end('read:' + token + ':' + (process.env.SECRET_TOKEN || 'none'))).listen(${NODE_PORT});`,
    '',
  ].join('\n')), 10_000);
  t.cmd(`cd /home/user && SECRET_TOKEN=${INLINE_SECRET} node server.js &`);
  const node = await pollPort(NODE_PORT, `read:${FILE_SECRET}:${INLINE_SECRET}`, 90_000);
  a.check('the Node server reads its user\'s file and its environment', node.ok, JSON.stringify(node.last).slice(0, 300));

  const python = await run('nimbus install python', 240_000);
  a.check('python installs', python.exitCode === 0, python.text.slice(-300));
  await run(heredocCommand('/home/user/server.py', [
    'import http.server',
    "token = open('/home/user/.token').read().strip()",
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    "        body = ('read:' + token).encode()",
    '        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)',
    `http.server.HTTPServer(("0.0.0.0", ${PYTHON_PORT}), H).serve_forever()`,
    '',
  ].join('\n')), 10_000);
  t.cmd('cd /home/user && python3 server.py &');
  const py = await pollPort(PYTHON_PORT, `read:${FILE_SECRET}`, 120_000);
  a.check('the Python server reads its user\'s file', py.ok, JSON.stringify(py.last).slice(0, 300));

  // ── Another account searches everything under /.nimbus ────────────────
  await run(`sudo sh -c 'echo "alice:x:1001:1001:alice:/home/alice:/bin/sh" >> /etc/passwd && echo "alice:x:1001:" >> /etc/group'`, 10_000);
  const who = await run('sudo -u alice id -u', 10_000);
  a.check('the second account exists', who.text.includes('1001'), who.text.slice(-200));
  const direct = await run('sudo -u alice cat /home/user/.token; echo "READ $?"', 10_000);
  a.check('the second account cannot read the file itself', /READ 1/.test(direct.text) && !direct.text.includes(FILE_SECRET), direct.text.slice(-200));
  // A directory alice may not read is no place she finds them: grep says so (status 2) and prints no path.
  const search = await run(`sudo -u alice grep -rl -e ${FILE_SECRET} -e ${INLINE_SECRET} /.nimbus; echo "SEARCHED $?"`, 120_000);
  const found = search.text.split('\n').filter((line) => line.startsWith('/.nimbus'));
  a.check('another account finds neither secret anywhere under /.nimbus', /SEARCHED [12]/.test(search.text) && found.length === 0,
    `found in: ${found.join(', ') || '(none)'}; ${search.text.slice(-300)}`);

  // ── A real reset: the Node server is relaunched and reads it again ────
  const reset = await resetInstance(sid);
  a.check('the session object resets', reset.ok, reset.detail);
  const back = await afterReset(() => pollPort(NODE_PORT, `read:${FILE_SECRET}:${INLINE_SECRET}`, 120_000));
  a.check('after the reset, the relaunched Node server reads it again', back.ok, JSON.stringify(back.last).slice(0, 300));
} catch (error) {
  a.check('the scenario ran', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
