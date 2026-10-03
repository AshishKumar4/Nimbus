#!/usr/bin/env bun
// python/cwd-through-absolute-link - CPython follows an absolute symlink, and
// a working directory it cannot enter fails the launch (Kinu's ask 15).
//
// Kinu's home is /home/main with /home/user -> /home/main. Through that link
// os.chdir raised errno 76 ("Capabilities insufficient"), the runner swallowed
// it, and `cd /home/user/site && python3 -m http.server` served "Directory
// listing for /". Here /home/user/alias -> /home/user/real stands in for it.

import { deleteSession, fetchPort, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/cwd-through-absolute-link';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const install = await t.run('nimbus install python', 180_000);
  a.check('python runtime is installed',
    /installed at|already installed/.test(stripAnsi(install.output)) && !/catalog cannot be fetched|command not found/.test(stripAnsi(install.output)),
    JSON.stringify(stripAnsi(install.output).slice(-500)));

  await t.run('mkdir -p /home/user/real/site/assets && ln -s /home/user/real /home/user/alias', 10_000);
  await t.run('ln -s /home/user/alias/site /home/user/chain && ln -s /home/user/real/nowhere /home/user/dangling', 10_000);
  await t.run(heredocCommand('/home/user/real/site/index.html', '<!doctype html><title>Nimbus</title><h1>PY_ALIAS_CWD_OK</h1>\n'), 10_000);

  await t.run(heredocCommand('/home/user/probe.py', [
    'import os',
    "print('cwd', os.getcwd())",
    "print('exists', os.path.exists('index.html'), os.path.exists('/home/user/chain/index.html'), os.path.exists('/home/user/dangling'))",
    "print('listdir', sorted(os.listdir('/home/user/chain')))",
    "print('stat', os.stat('/home/user/alias/site/index.html').st_size)",
    "print('open', open('/home/user/chain/index.html').read().count('PY_ALIAS_CWD_OK'))",
    "os.chdir('/home/user/chain/assets')",
    "print('chdir', os.getcwd())",
    '',
  ].join('\n')), 10_000);
  const probe = await t.run('cd /home/user/alias/site && python3 /home/user/probe.py; cd /home/user', 120_000);
  const out = stripAnsi(probe.output);
  a.check('python3 starts in a cwd reached through an absolute link', /^cwd \/home\/user\/(alias|real)\/site$/m.test(out), JSON.stringify(out.slice(-800)));
  a.check('exists answers through the link and a chain, and False for a dangling one', /^exists True True False$/m.test(out), JSON.stringify(out.slice(-800)));
  a.check('listdir, stat and open go through the links',
    /^listdir \['assets', 'index\.html'\]$/m.test(out) && /^stat \d+$/m.test(out) && /^open 1$/m.test(out), JSON.stringify(out.slice(-800)));
  a.check('os.chdir through a chain of absolute links', /^chdir \/home\/user\/(chain|alias\/site|real\/site)\/assets$/m.test(out), JSON.stringify(out.slice(-800)));

  await t.run('cd /home/user/alias/site', 10_000);
  const started = await t.run('python3 -m http.server 3097 --bind 0.0.0.0', 120_000);
  await t.run('cd /home/user', 10_000);
  const cleanStart = stripAnsi(started.output);
  a.check('python3 -m http.server starts in that cwd',
    /\[started \(long-running\): pid=\d+ .*port=3097\]/.test(cleanStart), JSON.stringify(cleanStart.slice(-1000)));
  const served = await fetchPort(sid, 3097, '');
  a.check('it serves the directory the shell was in, not /',
    served.status === 200 && /PY_ALIAS_CWD_OK/.test(served.body) && !/Directory listing for \//.test(served.body),
    `status=${served.status} body=${JSON.stringify(served.body.slice(0, 300))}`);

  const gone = await t.run('mkdir -p /tmp/gone-cwd && cd /tmp/gone-cwd && rmdir /tmp/gone-cwd && python3 -c "print(\'ran\')"; echo "exit=$?"; cd /home/user', 120_000);
  const goneOut = stripAnsi(gone.output);
  a.check('a cwd python3 cannot enter fails the launch, naming it',
    /python3: can't enter working directory '\/tmp\/gone-cwd': \[Errno \d+\] /.test(goneOut) && /exit=1/.test(goneOut) && !/^ran$/m.test(goneOut),
    JSON.stringify(goneOut.slice(-800)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
