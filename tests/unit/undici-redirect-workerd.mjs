// @serial
// @tier slow — drives the production embedder under workerd and real Node's bundled undici
// Credential isolation, redirects and their cap through builtins.undici, not
// a Function evaluating the shim or a mocked fetch. Both processes run the
// identical client/server fixtures; Node 22's real bundled undici is the oracle.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
import { REDIRECT_CLIENT, REDIRECT_SERVER, redirectFailures } from './lib/undici-redirect-fixture.mjs';

const host = mkdtempSync(join(tmpdir(), 'undici-redirect-node-'));
let server;
let probe;
try {
  // No npm release or host-package resolution drift: this is the exact
  // undici version the CI Node executable bundles, with request() exposed.
  mkdirSync(join(host, 'node_modules/undici'), { recursive: true });
  writeFileSync(join(host, 'node_modules/undici/index.js'), 'module.exports = require("internal/deps/undici/undici");\n');
  writeFileSync(join(host, 'server.cjs'), REDIRECT_SERVER);
  writeFileSync(join(host, 'client.cjs'), REDIRECT_CLIENT);
  server = spawn('node', ['server.cjs'], { cwd: host, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  server.stderr.on('data', (chunk) => { errors += chunk; });
  const origins = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Node redirect server did not listen: ${errors}`)), 10_000);
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Node redirect server exited ${code}: ${errors}`)); });
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const ready = /^REDIRECT_ORIGINS (.+)$/m.exec(output);
      if (ready) { clearTimeout(timer); resolve(JSON.parse(ready[1])); }
    });
  });
  const reference = spawnSync('node', ['--expose-internals', 'client.cjs', origins[0]], { cwd: host, encoding: 'utf8', timeout: 60_000 });
  assert.equal(reference.status, 0, `Node's real undici: ${reference.stderr}`);
  const expected = JSON.parse(/^UNDICI_REDIRECT (.+)$/m.exec(reference.stdout)?.[1] ?? 'null');
  assert.ok(expected, reference.stdout);
  assert.deepEqual(redirectFailures(expected), [], 'fixture expectations match the actual Node 22 bundled RedirectHandler');
  console.log('undici-redirect-workerd: real Node bundled undici passes all receiver-visible assertions');

  probe = await startLocalProbe({ runtimes: [] });
  const terminal = await localTerminal(probe, { install: [] });
  try {
    await terminal.writeFile('/home/user/redirect-server.cjs', REDIRECT_SERVER);
    await terminal.writeFile('/home/user/redirect-client.cjs', REDIRECT_CLIENT);
    const boot = await terminal.run('node /home/user/redirect-server.cjs 7321 7322');
    assert.equal(boot.status, 0, boot.stdout);
    assert.match(boot.stdout, /REDIRECT_ORIGINS|facet started/, boot.stdout);
    const result = await terminal.run('node /home/user/redirect-client.cjs http://127.0.0.1:7321', 180_000);
    assert.equal(result.status, 0, result.stdout);
    const actual = JSON.parse(/^UNDICI_REDIRECT (.+)$/m.exec(result.stdout)?.[1] ?? 'null');
    assert.ok(actual, result.stdout);
    const failures = redirectFailures(actual);
    assert.deepEqual(failures, [], failures.join('\n'));
    assert.deepEqual(actual, expected, 'the identical program agrees with real Node/undici on every header, method, body, status and error');
  } finally {
    await terminal.close();
  }
} finally {
  if (probe) await probe.stop();
  if (server) {
    const ended = new Promise((resolve) => server.once('close', resolve));
    server.kill();
    await ended;
  }
  rmSync(host, { recursive: true, force: true });
}
console.log('ok: undici.request redirects isolate credentials and match Node 22 bundled undici through the real Nimbus process');
