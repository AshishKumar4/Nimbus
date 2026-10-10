import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintToken } from '../../packages/cli/src/commands/token.ts';
import { setupCloudflare } from '../../packages/cli/src/commands/setup.ts';
import { syncRuntimes, listRuntimes } from '../../packages/cli/src/commands/runtime-sync.ts';
import { verifyNimbusToken } from '../../packages/sdk/src/token.ts';
import { SPECS } from '../../packages/worker/scripts/runtime-specs.mjs';

async function capture(command, args, options) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  let stdout = '', stderr = '';
  process.stdout.write = (value) => { stdout += String(value); return true; };
  process.stderr.write = (value) => { stderr += String(value); return true; };
  try { return { code: await command(args, options), stdout, stderr }; }
  finally { process.stdout.write = out; process.stderr.write = err; }
}

const root = mkdtempSync(join(tmpdir(), 'cli-options-'));
const saved = { PATH: process.env.PATH, JWT_SECRET: process.env.JWT_SECRET, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID };
try {
  process.env.JWT_SECRET = 'cli-option-behavior-secret';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  const minted = await capture(mintToken, ['--tenant=acme', '--sub', 'alice', '--sid=job_123', '--ttl', '60', '--scopes=sandbox:use,session:attach']);
  assert.equal(minted.code, 0);
  const { claims } = await verifyNimbusToken({ JWT_SECRET: process.env.JWT_SECRET }, minted.stdout.trim());
  assert.equal(claims.tn, 'acme');
  assert.equal(claims.sub, 'alice');
  assert.equal(claims.sid, 'job_123');
  assert.equal(claims.exp - claims.iat, 60);
  for (const args of [['--tenant'], ['--tenant', '--sub', 'alice'], ['--tenant', 'acme', '--unknown'], ['unexpected']]) {
    assert.equal((await capture(mintToken, args)).code, 64);
  }

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const commands = join(root, 'commands.jsonl');
  const catalog = { version: 1, runtimes: { ruby: { default: 'old-build', versions: {
    'old-build': { manifest: 'manifests/old.json', size_bytes: 2 * 1024 * 1024, license: 'actual-license' },
    'new-build': { manifest: 'manifests/new.json', size_bytes: 3 * 1024 * 1024, license: 'other-license' },
  } } } };
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + '\\n');
if (args.includes('--pipe')) process.stdout.write(${JSON.stringify(JSON.stringify(catalog))});
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${saved.PATH}`;
  const setup = await capture(setupCloudflare, ['--name=operator', '--bucket-prefix=custom', '--runtime-bucket=runtime-selected', '--skip-runtimes']);
  assert.equal(setup.code, 0);
  assert.deepEqual(JSON.parse(setup.stdout).buckets, ['custom-npm-cache', 'custom-npm-packument-cache', 'runtime-selected']);
  const listed = await capture(listRuntimes, ['--bucket=runtime-selected']);
  assert.equal(listed.code, 0);
  assert.deepEqual(JSON.parse(listed.stdout), [{ name: 'ruby', version: 'old-build', size_mb: 2, license: 'actual-license' }]);
  assert.deepEqual(JSON.parse(readFileSync(commands, 'utf8').trim().split('\n').at(-1)),
    ['wrangler', 'r2', 'object', 'get', 'runtime-selected/catalog/v1.json', '--pipe', '--remote']);

  const script = join(root, 'bundle-runtime.mjs');
  const specsPath = new URL('../../packages/worker/scripts/runtime-specs.mjs', import.meta.url).href;
  writeFileSync(join(root, 'runtime-specs.mjs'), `export { SPECS } from ${JSON.stringify(specsPath)};\n`);
  writeFileSync(script, `console.log(JSON.stringify(process.argv.slice(2))); console.log('NIMBUS_RUNTIME_CATALOG_SHA256=${'a'.repeat(64)}');\n`);
  const options = { scriptPath: script };
  const defaults = await capture(syncRuntimes, ['--bucket=selected'], options);
  assert.equal(defaults.code, 0);
  const invocations = defaults.stdout.trim().split('\n').filter((line) => line.startsWith('[')).map((line) => JSON.parse(line));
  assert.deepEqual(invocations, Object.entries(SPECS).filter(([, spec]) => spec.cliDefaultSync).map(([key]) => [...key.split('/'), '--bucket', 'selected']));
  const optional = await capture(syncRuntimes, ['--runtimes=bash,cpython', '--bucket', 'selected'], options);
  assert.equal(optional.code, 0);
  assert.deepEqual(JSON.parse(optional.stdout.trim().split('\n').at(-1)).runtimes, ['bash', 'cpython']);
  const mixed = await capture(syncRuntimes, ['--runtimes=bash', 'cpython', '--runtimes=ruby', 'python@0.29.4'], options);
  assert.deepEqual(JSON.parse(mixed.stdout.trim().split('\n').at(-1)).runtimes, ['bash', 'cpython', 'ruby', 'python@0.29.4']);
  assert.equal((await capture(syncRuntimes, ['--unknown'], options)).code, 64);
  assert.equal((await capture(syncRuntimes, ['not-a-publisher@1'], options)).code, 64);
} finally {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
console.log('cli-options: ok');
