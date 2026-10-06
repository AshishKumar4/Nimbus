#!/usr/bin/env bun
// python/numpy-flask-startup-modules - declared Pyodide startup modules
// import without request-time WebAssembly generation and Flask remains
// previewable through Nimbus virtual sockets.

import {
  deleteSession,
  fetchPort,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../_driver.mjs';
import { installPython, pipInstall } from './_setup.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/numpy-flask-startup-modules';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await installPython(t, a, { reinstall: true, timeoutMs: 360_000 });
  await pipInstall(t, a, 'numpy flask', { timeoutMs: 420_000, installed: /Successfully installed/ });

  const imports = await t.run(
    'python -c "import flask, markupsafe._speedups, numpy as np; print(\'PY_IMPORT_OK\', int(np.arange(5).sum()))"',
    180_000,
  );
  const cleanImports = stripAnsi(imports.output);
  a.check('flask markupsafe speedups and numpy import',
    /PY_IMPORT_OK\s+10/.test(cleanImports)
      && !/Traceback|Wasm code generation disallowed|Failed to load dynamic library/i.test(cleanImports),
    JSON.stringify(cleanImports.slice(-1800)));

  const script = `from flask import Flask, request

app = Flask(__name__)

@app.get("/")
def index():
    return "FLASK_STARTUP_MODULE_OK:" + request.args.get("name", "world")

app.run(host="0.0.0.0", port=3130)
`;

  await t.run(heredocCommand('/home/user/startup_module_flask_app.py', script), 15_000);
  const started = await t.run('python /home/user/startup_module_flask_app.py', 180_000);
  const cleanStart = stripAnsi(started.output);
  a.check('flask starts as a long-running port process',
    /\[started \(long-running\): pid=\d+ cmd="python \/home\/user\/startup_module_flask_app\.py" port=3130\]/.test(cleanStart),
    JSON.stringify(cleanStart.slice(-1500)));

  const response = await fetchPort(sid, 3130, '?name=nimbus');
  a.check('flask preview responds through port bridge',
    response.status === 200 && response.body === 'FLASK_STARTUP_MODULE_OK:nimbus',
    `status=${response.status} body=${JSON.stringify(response.body)} elapsed=${response.elapsed}ms`);
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
