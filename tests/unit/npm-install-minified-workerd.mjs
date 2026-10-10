// @serial
// @tier slow — runs the real minified embedder in workerd and installs from the registry.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: [], minify: true, vars: { NIMBUS_DEBUG: '1' } });
let session;
try {
  session = await localTerminal(probe, { install: [] });
  const installed = await session.run('npm install is-number@7.0.0', 120_000);
  assert.equal(installed.status, 0, installed.stdout);
  const used = await session.run('node -e "console.log(require(\'is-number\')(42))"', 60_000);
  assert.equal(used.status, 0, used.stdout);
  assert.match(used.stdout, /^true$/m);
  console.log('npm-install-minified-workerd: minified Worker installs and runs a real cache-miss package');
} finally {
  if (session) await session.close();
  await probe.stop();
}
