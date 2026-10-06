// A WASI process answers its filesystem from its own copy (core
// runtime/wasi/resident-filesystem.ts). These are the ways that copy could
// be wrong, each observed on a live session:
//   - what a process writes and never closes is in the session after it exits;
//   - a running process sees a change the shell makes once input reaches it
//     (a sleep's wakeup is such input);
//   - a resident server reads the file as it is when the request arrives;
//   - a file the process wrote is there for whoever it then talks to.
import { mintSession, deleteSession, Terminal, stripAnsi, makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('wasi-fs-coherence');
const sid = await mintSession();
const t = new Terminal(sid);
const run = async (cmd, timeout = 300_000) => {
  const r = await t.run(cmd, timeout);
  const out = stripAnsi(r.output).replace(/\s+$/, '');
  console.log(JSON.stringify({ cmd: cmd.slice(0, 120), out: out.slice(-400) }));
  return out;
};
const py = (body) => `python3 -c "${body.replace(/"/g, '\\"')}"`;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run('nimbus install python 2>&1 | tail -1', 900_000);

  // Written to the descriptor (flushed out of Python's buffer) and never closed.
  await run(py("f = open('unclosed.txt', 'w')\nf.write('kept by exit')\nf.flush()"));
  a.check('a file written and never closed is in the session after the run', (await run('cat unclosed.txt')).includes('kept by exit'));

  await run('echo one > watch.txt');
  await run(py("import time\nfor i in range(16):\n  print('saw', open('watch.txt').read().strip(), flush=True)\n  time.sleep(0.5)") + ' > watch.log 2>&1 &');
  await run('sleep 2; echo two > watch.txt; sleep 4; cat watch.log');
  const log = await run('sleep 3; cat watch.log');
  a.check('a running process saw the shell\'s change after its sleep woke it', log.includes('saw one') && log.includes('saw two'), log.slice(-300));

  await run('mkdir -p site && echo first > site/page.txt');
  const served = await run('cd site && python3 -m http.server 8077 2>&1 | head -3; cd ..', 120_000);
  console.log(JSON.stringify({ served }));
  const first = await run('curl -s http://localhost:8077/page.txt');
  a.check('the resident server serves the file', first.includes('first'), first);
  await run('echo second > site/page.txt');
  const second = await run('curl -s http://localhost:8077/page.txt');
  a.check('the resident server serves the file as edited since', second.includes('second') && !second.split('\n').slice(1).join('\n').includes('first'), second);

  await run(`cat > writer.py <<'EOF'
import http.server, socketserver
kept = []
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Written to the descriptor and kept open: only the reply can carry it out.
        f = open('from-server.txt', 'w')
        f.write('written before the reply')
        f.flush()
        kept.append(f)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
socketserver.TCPServer(('127.0.0.1', 8078), H).serve_forever()
EOF`);
  await run('python3 writer.py 2>&1 | head -2', 120_000);
  await run('curl -s http://localhost:8078/');
  a.check('a file the server wrote before replying is there when the reply arrives', (await run('cat from-server.txt')).includes('written before the reply'));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const { fail } = a.summary();
process.exit(fail > 0 ? 1 : 0);
