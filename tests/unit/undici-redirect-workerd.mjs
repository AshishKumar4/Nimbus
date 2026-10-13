// @serial
// @tier slow — drives the production embedder under workerd and real Node's bundled undici
// Credential isolation, redirects and their cap through builtins.undici, not
// a Function evaluating the shim or a mocked fetch. Both processes run the
// identical client/server fixtures; Node 22's real bundled undici is the oracle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
import { REDIRECT_PROGRAM, redirectFailures } from './lib/undici-redirect-fixture.mjs';

const host = mkdtempSync(join(tmpdir(), 'undici-redirect-node-'));
let probe;
try {
  // No npm release or host-package resolution drift: this is the exact
  // undici version the CI Node executable bundles. Node exports its real
  // dispatcher, whose .request() uses that same bundled RedirectHandler;
  // this facade only translates the top-level URL to dispatcher arguments.
  mkdirSync(join(host, 'node_modules/undici'), { recursive: true });
  writeFileSync(join(host, 'node_modules/undici/index.js'), [
    'const undici = require("internal/deps/undici/undici");',
    'exports.request = (url, options = {}) => {',
    '  const target = new URL(url);',
    '  return undici.getGlobalDispatcher().request({ ...options, origin: target.origin, path: target.pathname + target.search, method: options.method || (options.body ? "PUT" : "GET") });',
    '};',
  ].join('\n'));
  writeFileSync(join(host, 'program.cjs'), REDIRECT_PROGRAM);
  const reference = spawnSync('node', ['--expose-internals', 'program.cjs'], { cwd: host, encoding: 'utf8', timeout: 60_000 });
  assert.equal(reference.status, 0, `Node's real undici: ${reference.stderr}`);
  const expected = JSON.parse(/^UNDICI_REDIRECT (.+)$/m.exec(reference.stdout)?.[1] ?? 'null');
  assert.ok(expected, reference.stdout);
  assert.deepEqual(redirectFailures(expected), [], 'fixture expectations match the actual Node 22 bundled RedirectHandler');
  console.log('undici-redirect-workerd: real Node bundled undici passes all receiver-visible assertions');

  probe = await startLocalProbe({ runtimes: [] });
  const terminal = await localTerminal(probe, { install: [] });
  try {
    await terminal.writeFile('/home/user/redirect-program.cjs', REDIRECT_PROGRAM);
    const boot = await terminal.run('cd /home/user && node redirect-program.cjs 7321 7322');
    assert.equal(boot.status, 0, boot.stdout);
    assert.match(boot.stdout, /REDIRECT_ORIGINS|facet started/, boot.stdout);
    let result;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      result = await terminal.run('cat /home/user/undici-redirect-result.json');
      if (result.status === 0) break;
      await Bun.sleep(250);
    }
    assert.equal(result?.status, 0, `the real process never wrote its result: ${boot.stdout}\n${result?.stdout}`);
    const actual = JSON.parse(result.stdout.trim());
    const failures = redirectFailures(actual);
    assert.deepEqual(failures, [], failures.join('\n'));
    assert.deepEqual(actual, expected, 'the identical program agrees with real Node/undici on every header, method, body, status and error');
  } finally {
    await terminal.close();
  }
} finally {
  if (probe) await probe.stop();
  rmSync(host, { recursive: true, force: true });
}
console.log('ok: undici.request redirects isolate credentials and match Node 22 bundled undici through the real Nimbus process');
