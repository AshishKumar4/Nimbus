#!/usr/bin/env bun
// python/flask-preview - Flask runs through Nimbus virtual sockets.
//
// Public contract:
//   1. `pip install flask` persists packages into the Nimbus VFS.
//   2. A Flask dev server can bind a loopback HTTP port.
//   3. `/s/<sid>/port/<n>/...` routes through the virtual socket bridge
//      and returns the Flask response.

import { fetchPort, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/flask-preview';
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

const pip = await t.run('pip install flask', 300_000);
const cleanPip = stripAnsi(pip.output);
a.check('pip install flask completes',
  /Successfully installed flask/.test(cleanPip) && !/ModuleNotFoundError|PackageManager\.install\(\) got an unexpected keyword|Failed to load MarkupSafe|Failed to load dynamic library|Wasm code generation disallowed/i.test(cleanPip),
  JSON.stringify(cleanPip.slice(-1000)));

const script = `from flask import Flask, request

app = Flask(__name__)

@app.get("/")
def index():
    return "FLASK_OK:" + request.args.get("name", "world")

app.run(host="0.0.0.0", port=3120)
`;

await t.run(heredocCommand('/home/user/flask_app.py', script), 15_000);

const started = await t.run('python /home/user/flask_app.py', 180_000);
const cleanStart = stripAnsi(started.output);
a.check(
  'flask server starts as a long-running process on port 3120',
  /\[started \(long-running\): pid=\d+ cmd="python \/home\/user\/flask_app\.py" port=3120\]/.test(cleanStart),
  JSON.stringify(cleanStart.slice(-1000)),
);

const r = await fetchPort(sid, 3120, '?name=nimbus');
a.check('port proxy returns Flask response',
  r.status === 200 && r.body === 'FLASK_OK:nimbus',
  `status=${r.status} body=${JSON.stringify(r.body)} elapsed=${r.elapsed}ms`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
