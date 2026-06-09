#!/usr/bin/env bun
// python/module-flask-run-preview - `python -m flask run` runs through
// the Python virtual socket kernel and is previewable through /port/<n>/.

import { fetchPort, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/module-flask-run-preview';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const install = await t.run('nimbus install python', 180_000);
a.check('python runtime is installed',
  /installed at|already installed/.test(stripAnsi(install.output)) && !/catalog cannot be fetched|command not found/.test(stripAnsi(install.output)),
  JSON.stringify(stripAnsi(install.output).slice(-500)));

const pip = await t.run('pip install flask', 300_000);
const cleanPip = stripAnsi(pip.output);
a.check('pip install flask completes without extension wasm failures',
  /Successfully installed flask/.test(cleanPip) && !/Failed to load MarkupSafe|Failed to load dynamic library|Wasm code generation disallowed/i.test(cleanPip),
  JSON.stringify(cleanPip.slice(-1200)));

const app = `from flask import Flask, request

app = Flask(__name__)

@app.get("/")
def index():
    return "FLASK_MODULE_OK:" + request.args.get("name", "world")
`;

await t.run(heredocCommand('/home/user/flask_cli_app.py', app), 15_000);
await t.run('export FLASK_APP=/home/user/flask_cli_app.py', 10_000);

const started = await t.run('python -m flask run --host=0.0.0.0 --port=3121', 180_000);
const cleanStart = stripAnsi(started.output);
a.check(
  'python -m flask run starts as a long-running virtual-socket process',
  /\[started \(long-running\): pid=\d+ cmd="python -m flask run --host=0\.0\.0\.0 --port=3121" port=3121\]/.test(cleanStart),
  JSON.stringify(cleanStart.slice(-1500)),
);

const r = await fetchPort(sid, 3121, '?name=nimbus');
a.check('port proxy returns Flask CLI response',
  r.status === 200 && r.body === 'FLASK_MODULE_OK:nimbus',
  `status=${r.status} body=${JSON.stringify(r.body)} elapsed=${r.elapsed}ms`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
