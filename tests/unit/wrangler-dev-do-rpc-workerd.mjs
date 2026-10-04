// @serial
// A user Worker under Nimbus's `wrangler dev` calls RPC methods on a classic
// Durable Object binding as on Cloudflare: `env.P.get(env.P.idFromName('x'))`
// without an await, methods with arguments and return values, a thrown
// error's type and message, promise pipelining (`stub.info().field`), the
// object's storage (KV and SQL) across calls, its own `env`, `fetch`, and
// `getByName`. Under the real workerd (lib/workerd-probe.mjs: apps/probe,
// its session Durable Object, the LOADER that makes the inner Worker).
//
// It threw "Could not serialize object of type "RpcPromise"": env.P was a
// WorkerEntrypoint, so idFromName answered an RpcPromise that get() could
// not take, and the stub it gave had no methods but fetch.
//
// Runs the worker built in the tree: rebuild the generated artifacts before
// testing a change (dist-integrity).

import assert from 'node:assert/strict';

import { startLocalProbe } from './lib/workerd-probe.mjs';
import { WORKER, WRANGLER_CONFIG, expectedAnswers } from '../behavioral/wrangler/new/_do-rpc-worker.mjs';

console.log('wrangler-dev-do-rpc-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal, requestHeaders, stripAnsi } = await import('../behavioral/_driver.mjs');
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  const write = (path, content) => terminal.run(
    `node -e "require('fs').mkdirSync(require('path').dirname('${path}'),{recursive:true});require('fs').writeFileSync('${path}', Buffer.from('${Buffer.from(content).toString('base64')}','base64'))"`,
    30_000,
  );
  await write('/home/user/do-rpc/wrangler.jsonc', JSON.stringify(WRANGLER_CONFIG));
  await write('/home/user/do-rpc/src/index.js', WORKER);
  await terminal.run('cd /home/user/do-rpc', 10_000);
  terminal.reset();
  terminal.cmd('wrangler dev');
  await terminal.waitFor((b) => /Worker built|\x1b\[31m/.test(b), 120_000, 'wrangler dev build');
  assert.match(stripAnsi(terminal.buf), /Worker built/, stripAnsi(terminal.buf).slice(-1500));

  const answer = async () => {
    const response = await fetch(`${probe.base}/s/${sid}/worker/`, { headers: requestHeaders() });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 600));
    return JSON.parse(body);
  };
  const first = await answer();
  const { missingMethod, ...answered } = first;
  assert.deepEqual(answered, expectedAnswers(0), JSON.stringify(first, null, 2));
  assert.ok(missingMethod?.threw && !/RpcPromise/.test(missingMethod.message), `a missing method is refused: ${JSON.stringify(missingMethod)}`);
  // The object and its storage outlive the request.
  const second = await answer();
  assert.deepEqual(second.rows, [3, 4], 'the second request sees the rows the first wrote');
  assert.equal(second.get, 'v1');

  terminal.send('\x03');
} finally {
  await terminal.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
  await probe.stop();
}
console.log('wrangler-dev-do-rpc-workerd: Durable Object RPC under wrangler dev answers as on Cloudflare');
