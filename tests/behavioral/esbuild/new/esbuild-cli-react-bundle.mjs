#!/usr/bin/env bun
// esbuild/new/esbuild-cli-react-bundle — `esbuild` builds a React app from the
// working directory, and the session survives what follows.
//
// Two reported failures (Kinu integration report, N1 and N3):
//   - `cd ~/app && esbuild src/main.jsx --bundle --outfile=dist/bundle.js`
//     wrote /dist/bundle.js, owned by root, instead of ~/app/dist/bundle.js.
//   - `nimbus install python` after that React bundle dropped the session's
//     socket (1006): the bundle ran in the session's own isolate, and
//     esbuild's wasm memory, which never shrinks, stayed there.
//
// Asserts only what a user sees: where the file lands and whose it is,
// esbuild's own stdout behavior, and that the next heavy command runs on the
// same live session instead of a reset one.

import { mintSession, deleteSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('esbuild/new/esbuild-cli-react-bundle');

const PACKAGE_JSON = JSON.stringify({
  name: 'esbuild-react-probe', private: true, type: 'module',
  dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
});
const MAIN_JSX = "import React, { StrictMode } from 'react'; import { createRoot } from 'react-dom/client'; "
  + "function App() { return <h1>ESBUILD_PROBE_APP</h1>; } "
  + "createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);";
const RESET_NOTICE = /resumed on a new instance/;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  await t.run(`mkdir -p /home/user/app/src && printf '%s\\n' '${PACKAGE_JSON}' > /home/user/app/package.json`, 15_000);
  await t.run(`printf '%s\\n' "${MAIN_JSX}" > /home/user/app/src/main.jsx`, 15_000);
  const install = await t.run('cd /home/user/app && npm install; echo NPM_EXIT=$?', 300_000);
  a.check('npm install react react-dom', /NPM_EXIT=0/.test(install.output), JSON.stringify(install.output.slice(-400)));

  const build = await t.run('cd /home/user/app && esbuild src/main.jsx --bundle --outfile=dist/bundle.js; echo BUILD_EXIT=$?', 180_000);
  const buildOut = stripAnsi(build.output);
  a.check('the React bundle builds', /BUILD_EXIT=0/.test(buildOut), JSON.stringify(buildOut.slice(-600)));
  a.check('esbuild reports the output relative to the cwd', /dist\/bundle\.js/.test(buildOut), JSON.stringify(buildOut.slice(-600)));

  // A file the shell user just created is the reference for who that user is.
  const owner = stripAnsi((await t.run("touch /home/user/app/.mine && stat -c 'OWNER=%u SIZE=%s' /home/user/app/dist/bundle.js && stat -c 'USER=%u' /home/user/app/.mine", 15_000)).output);
  const file = /OWNER=(\d+) SIZE=(\d+)/.exec(owner);
  const user = /USER=(\d+)/.exec(owner)?.[1];
  a.check('the bundle lands in <cwd>/dist', file !== null, JSON.stringify(owner));
  a.check('the bundle belongs to the user who built it', file !== null && user !== undefined && file[1] === user, JSON.stringify(owner));
  a.check('the bundle carries React and the app', file !== null && Number(file[2]) > 500_000, JSON.stringify(owner));
  const root = stripAnsi((await t.run('ls /dist; echo LS_EXIT=$?', 15_000)).output);
  a.check('nothing is written at /dist', /LS_EXIT=[1-9]/.test(root), JSON.stringify(root));

  const grep = stripAnsi((await t.run('grep -c ESBUILD_PROBE_APP /home/user/app/dist/bundle.js', 15_000)).output);
  a.check('the app component is in the bundle', /^1\s*$/m.test(grep), JSON.stringify(grep));

  const stdout = stripAnsi((await t.run('cd /home/user/app && esbuild src/main.jsx --bundle --minify | wc -c', 120_000)).output);
  const bytes = Number(/^\s*(\d+)\s*$/m.exec(stdout)?.[1] ?? 0);
  a.check('without --outfile the bundle goes to stdout', bytes > 100_000, JSON.stringify(stdout.slice(-300)));

  const python = await t.run('nimbus install python; echo PY_INSTALL_EXIT=$?', 300_000);
  const pythonOut = stripAnsi(python.output);
  a.check('nimbus install python completes after the bundle', /PY_INSTALL_EXIT=0/.test(pythonOut), JSON.stringify(pythonOut.slice(-600)));
  a.check('the terminal stayed connected', !t.closed, t.closeDetail ?? '');
  a.check('the session was not reset', !RESET_NOTICE.test(buildOut + stdout + pythonOut), JSON.stringify(pythonOut.slice(-300)));

  const run = stripAnsi((await t.run("python3 -c 'print(6*7)'", 120_000)).output);
  a.check('python runs in the same session', /^42\s*$/m.test(run), JSON.stringify(run.slice(-300)));
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
