#!/usr/bin/env bun
// python/module-http-server-preview - `python -m http.server` runs through
// the Python virtual socket kernel and is previewable through /port/<n>/.

import { deleteSession, fetchPort, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'python/module-http-server-preview';
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

  await t.run('mkdir -p /home/user/py-site', 10_000);
  await t.run(heredocCommand('/home/user/py-site/index.html', '<!doctype html><title>Nimbus</title><h1>PY_MODULE_HTTP_OK</h1>\n'), 10_000);

  const started = await t.run('python -m http.server 3098 --bind 0.0.0.0 --directory /home/user/py-site', 120_000);
  const cleanStart = stripAnsi(started.output);
  a.check(
    'python -m http.server starts as a long-running virtual-socket process',
    /\[started \(long-running\): pid=\d+ cmd="python -m http\.server 3098 --bind 0\.0\.0\.0 --directory \/home\/user\/py-site" port=3098\]/.test(cleanStart),
    JSON.stringify(cleanStart.slice(-1000)),
  );

  const r = await fetchPort(sid, 3098, '');
  a.check('port proxy returns module http.server response',
    r.status === 200 && /PY_MODULE_HTTP_OK/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))} elapsed=${r.elapsed}ms`);

  const head = await fetchPort(sid, 3098, '', { method: 'HEAD' });
  a.check('port proxy returns module http.server HEAD response without waiting for a body',
    head.status === 200 && head.body === '',
    `status=${head.status} body=${JSON.stringify(head.body)} contentLength=${head.headers.get('content-length')} elapsed=${head.elapsed}ms`);
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
