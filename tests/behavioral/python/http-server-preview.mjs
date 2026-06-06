#!/usr/bin/env bun
// python/http-server-preview - Python stdlib HTTPServer is previewable.
//
// Public contract:
//   1. `nimbus install python --reinstall` installs the current Pyodide
//      runtime artifact from R2.
//   2. `python app.py` can bind a loopback HTTP server.
//   3. `/s/<sid>/port/<n>/...` routes through Nimbus preview plumbing and
//      returns the Python server's response.

import { fetchPort, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/http-server-preview';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const install = await t.run('nimbus install python --reinstall', 240_000);
a.check('python runtime installs from runtime catalog',
  /installed at|already installed/.test(stripAnsi(install.output)) && !/catalog cannot be fetched|command not found/.test(stripAnsi(install.output)),
  JSON.stringify(stripAnsi(install.output).slice(-500)));

const script = `from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("PYHTTP_OK:" + self.path).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass

HTTPServer(("0.0.0.0", 3097), Handler).serve_forever()
`;

await t.run(heredocCommand('/home/user/py-http.py', script), 15_000);

const started = await t.run('python /home/user/py-http.py', 120_000);
const cleanStart = stripAnsi(started.output);
a.check(
  'python server starts as a long-running process on port 3097',
  /\[started \(long-running\): pid=\d+ cmd="python \/home\/user\/py-http\.py" port=3097\]/.test(cleanStart),
  JSON.stringify(cleanStart.slice(-500)),
);

const r = await fetchPort(sid, 3097, 'hello?n=1');
a.check('port proxy returns Python HTTP response', r.status === 200 && r.body === 'PYHTTP_OK:/hello?n=1',
  `status=${r.status} body=${JSON.stringify(r.body)} elapsed=${r.elapsed}ms`);

const plain = await t.run('cat > /home/user/py-plain.py << "PYEOF"\nprint("PYTHON_SCRIPT_OK")\nPYEOF\npython /home/user/py-plain.py', 120_000);
a.check('ordinary Python scripts still exit and print output',
  /PYTHON_SCRIPT_OK/.test(stripAnsi(plain.output)),
  JSON.stringify(stripAnsi(plain.output).slice(-500)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
