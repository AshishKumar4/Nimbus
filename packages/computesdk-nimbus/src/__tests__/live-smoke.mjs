#!/usr/bin/env bun
// live-smoke — drive @computesdk/nimbus against a real Nimbus deployment
// through the ComputeSDK provider interface.
//
//   BASE=<url> NIMBUS_PROBE_TOKEN=<jwt> bun packages/computesdk-nimbus/src/__tests__/live-smoke.mjs
//
// Every check asserts a value only the sandbox could have produced, so a
// provider that answered locally without reaching Nimbus would fail.
//
// All checks run even after one fails: stopping at the first failure would
// hide the state of everything after it, which is exactly what you need to
// see when a deployment is partly broken.

import { nimbus } from '../index.ts';

const endpoint = process.env.BASE;
const token = process.env.NIMBUS_PROBE_TOKEN;
if (!endpoint || !token) {
  console.error('live-smoke: BASE and NIMBUS_PROBE_TOKEN are required');
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const compute = nimbus({ endpoint, token });
const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
let sandbox;

console.log(`live-smoke — ${endpoint}\n`);

try {
  sandbox = await compute.sandbox.create();
  console.log(`created ${sandbox.sandboxId}\n`);

  await check('node -v returns a version', async () => {
    const r = await sandbox.runCommand('node -v');
    expect(r.exitCode === 0, `exit ${r.exitCode}: ${r.stderr}`);
    expect(/^v\d+\.\d+\.\d+/.test(r.stdout), `unexpected output: ${JSON.stringify(r.stdout)}`);
    return r.stdout.trim();
  });

  await check('a real process runs and returns computed output', async () => {
    const r = await sandbox.runCommand('echo $((6*7))-$$');
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
    expect(/^42-\d+/.test(r.stdout.trim()), `unexpected output: ${JSON.stringify(r.stdout)}`);
    return r.stdout.trim();
  });

  await check('the Node runtime executes JavaScript', async () => {
    const r = await sandbox.runCommand('node -e "console.log(6*7)"');
    expect(r.exitCode === 0, `exit ${r.exitCode}: ${r.stderr}`);
    expect(r.stdout.trim() === '42', `stdout was ${JSON.stringify(r.stdout)} (expected "42")`);
  });

  await check('a non-zero exit survives the round trip', async () => {
    const r = await sandbox.runCommand('exit 3');
    expect(r.exitCode === 3, `exit was ${r.exitCode}`);
  });

  await check('filesystem write is visible to the shell', async () => {
    await sandbox.filesystem.writeFile('smoke.txt', nonce);
    const read = await sandbox.filesystem.readFile('smoke.txt');
    expect(read === nonce, 'readFile did not return what writeFile wrote');
    const catted = await sandbox.runCommand('cat smoke.txt');
    expect(catted.stdout.trim() === nonce, 'the shell cannot see the file the FS API wrote');
  });

  await check('exists distinguishes present from absent', async () => {
    expect((await sandbox.filesystem.exists('smoke.txt')) === true, 'existing file reported absent');
    expect((await sandbox.filesystem.exists('nope.txt')) === false, 'absent file reported present');
  });

  await check('mkdir and readdir report real entries', async () => {
    await sandbox.filesystem.mkdir('sub');
    const entries = await sandbox.filesystem.readdir('.');
    const names = entries.map((e) => e.name);
    expect(names.includes('smoke.txt'), `readdir missing smoke.txt: ${names}`);
    expect(entries.find((e) => e.name === 'sub')?.type === 'directory', 'sub not typed as directory');
  });

  await check('remove deletes', async () => {
    await sandbox.filesystem.remove('smoke.txt');
    expect((await sandbox.filesystem.exists('smoke.txt')) === false, 'file survived remove');
  });

  await check('readFile on a missing path is ENOENT', async () => {
    try {
      await sandbox.filesystem.readFile('definitely-missing.txt');
    } catch (e) {
      expect(/ENOENT/.test(e.message), `wrong error: ${e.message}`);
      return;
    }
    throw new Error('readFile resolved for a missing path');
  });

  await check('getInfo reports the real creation time', async () => {
    const info = await sandbox.getInfo();
    expect(info.provider === 'nimbus', `provider was ${info.provider}`);
    expect(info.createdAt.getTime() > 0 && info.createdAt.getTime() <= Date.now(), 'implausible createdAt');
  });

  await check('getById recovers a created sandbox', async () => {
    const found = await compute.sandbox.getById(sandbox.sandboxId);
    expect(found !== null, 'getById missed a sandbox create() made');
    const info = await found.getInfo();
    expect(info.createdAt.getTime() > 0, 'recovered createdAt is not real');
  });

  await check('getById reports a miss for an id never created', async () => {
    const ghost = await compute.sandbox.getById(`ghost-${Math.random().toString(36).slice(2, 8)}`);
    expect(ghost === null, 'getById invented a sandbox that was never created');
  });

  await check('streaming exec delivers chunks', async () => {
    const chunks = [];
    const r = await sandbox.runCommand('echo streamed', { onStdout: (d) => chunks.push(d) });
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
    expect(/streamed/.test(r.stdout), `stdout was ${JSON.stringify(r.stdout)}`);
    expect(chunks.length > 0, 'onStdout never fired');
  });

  await check('list is refused rather than faked', async () => {
    try {
      await compute.sandbox.list();
    } catch (e) {
      expect(/does not support listing/.test(e.message), `wrong error: ${e.message}`);
      return;
    }
    throw new Error('list() resolved');
  });

  // ── ComputeSDK conformance ────────────────────────────────────────────
  // The assertions @computesdk/test-utils' runProviderTestSuite makes, so
  // the provider is checked against upstream's contract and not only
  // against what this adapter chose to expose.

  await check('conformance: shell command', async () => {
    const r = await sandbox.runCommand('echo "Hello from command"');
    expect(r.stdout.includes('Hello from command'), `stdout: ${JSON.stringify(r.stdout)}`);
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
  });

  await check('conformance: background command', async () => {
    const r = await sandbox.runCommand('sleep 1', { background: true });
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
  });

  await check('conformance: invalid command is not a success', async () => {
    const r = await sandbox.runCommand('nonexistent-command-12345');
    expect(r.exitCode !== 0, 'an unknown command reported exit 0');
  });

  await check('conformance: getUrl returns a URL', async () => {
    const url = await sandbox.getUrl({ port: 3000 });
    expect(/^(https?|wss?):\/\/.+/.test(url), `url was ${url}`);
    return url;
  });

  await check('conformance: quoting with spaces', async () => {
    const r = await sandbox.runCommand(`sh -c 'echo "hello world"'`);
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
    expect(r.stdout.trim() === 'hello world', `stdout: ${JSON.stringify(r.stdout)}`);
  });

  await check('conformance: variable expansion', async () => {
    const r = await sandbox.runCommand(`sh -c 'echo "$HOME"'`);
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
    expect(r.stdout.trim().length > 0, '$HOME expanded to nothing');
  });

  await check('conformance: redirect and pipe', async () => {
    const r = await sandbox.runCommand(
      `sh -c 'echo "test content" > /tmp/test-quoting.txt && cat /tmp/test-quoting.txt'`,
    );
    expect(r.exitCode === 0, `exit ${r.exitCode}`);
    expect(r.stdout.trim() === 'test content', `stdout: ${JSON.stringify(r.stdout)}`);
  });
} finally {
  if (sandbox) {
    await sandbox.destroy().catch((e) => console.warn(`cleanup failed: ${e.message}`));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nlive-smoke: ${results.length - failed.length} pass / ${failed.length} fail`);
process.exit(failed.length > 0 ? 1 : 0);
