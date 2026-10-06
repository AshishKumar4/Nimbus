#!/usr/bin/env bun
// `nimbus runtime sync` (packages/cli/src/commands/runtime-sync.ts) runs the
// publisher (packages/worker/scripts/bundle-runtime.mjs) once per runtime and
// reports the catalog the bucket was left holding, which it reads from the
// one line every publish prints: NIMBUS_RUNTIME_CATALOG_SHA256=<digest>.
//
//   - For Nimbus's production bucket, whose publish also rewrites Nimbus's
//     own configs, the sync succeeds and names the digest the configs now
//     carry. Before, that publish printed only its own log line, and the
//     sync exited 70 after publishing and rewriting the configs.
//   - For any other bucket the same: the digest of the catalog written.
//
// The publisher runs for real, from a temp tree laid out as the repo is (so
// the production path rewrites the temp tree's configs, never the repo's),
// against a stub wrangler holding the bucket in a directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogKey } from '../../packages/worker/src/runtime/runtime-catalog.ts';
import { syncRuntimes } from '../../packages/cli/src/commands/runtime-sync.ts';

const WORKER = new URL('../../packages/worker/', import.meta.url).pathname;
const CORE = new URL('../../packages/core', import.meta.url).pathname;
const OLD = 'f'.repeat(64);
const config = `{
  // A comment the rewrite keeps.
  "name": "app",
  "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}" },
  "env": { "production": { "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}" } } }
}
`;

const root = mkdtempSync(join(tmpdir(), 'nimbus-cli-sync-'));
const cwd = process.cwd();
const savedPath = process.env.PATH;
const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
try {
  const scripts = join(root, 'packages/worker/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const script of ['bundle-runtime.mjs', 'runtime-specs.mjs']) cpSync(join(WORKER, 'scripts', script), join(scripts, script));
  cpSync(join(WORKER, 'runtime-contracts'), join(root, 'packages/worker/runtime-contracts'), { recursive: true });
  for (const file of ['bash.async.wasm', 'coreutils/busybox.wasm', 'coreutils/busybox.applets']) {
    mkdirSync(join(root, 'packages/worker/wasm/bash/coreutils'), { recursive: true });
    cpSync(join(WORKER, 'wasm/bash', file), join(root, 'packages/worker/wasm/bash', file));
  }
  mkdirSync(join(root, 'node_modules/@nimbus-sh'), { recursive: true });
  symlinkSync(CORE, join(root, 'node_modules/@nimbus-sh/core'));
  // The JSONC editor the production path loads, as the worker package resolves it.
  symlinkSync(realpathSync(join(WORKER, 'node_modules/jsonc-parser')), join(root, 'node_modules/jsonc-parser'));
  for (const app of ['hosted-demo', 'probe']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'wrangler.jsonc'), config);
  }

  // Stub wrangler over a bucket directory: object put/get (--file or --pipe) and bucket info.
  const bucketDir = join(root, 'bucket');
  mkdirSync(bucketDir);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = ${JSON.stringify(bucketDir)};
const at = (spec) => path.join(dir, encodeURIComponent(spec.slice(spec.indexOf('/') + 1)));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'info') { console.log('object_count: ' + fs.readdirSync(dir).length); process.exit(0); }
if (args[0] === 'r2' && args[1] === 'object' && args[2] === 'put') { fs.copyFileSync(flag('--file'), at(args[3])); process.exit(0); }
if (args[0] === 'r2' && args[1] === 'object' && args[2] === 'get') {
  if (!fs.existsSync(at(args[3]))) { process.stderr.write('The specified key does not exist.'); process.exit(1); }
  if (args.includes('--pipe')) process.stdout.write(fs.readFileSync(at(args[3])));
  else fs.copyFileSync(at(args[3]), flag('--file'));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  process.env.PATH = `${join(root, 'bin')}:${savedPath}`;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.chdir(root);

  const object = (key) => readFileSync(join(bucketDir, encodeURIComponent(key)));
  const pins = (app) => [...readFileSync(join(root, 'apps', app, 'wrangler.jsonc'), 'utf8').matchAll(/"NIMBUS_RUNTIME_CATALOG_SHA256": "([a-f0-9]*)"/g)].map((m) => m[1]);
  const sync = async (bucket) => {
    const out = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return write(chunk, ...rest); };
    try {
      const code = await syncRuntimes(['--bucket', bucket, 'bash@5.2.37-3'], { scriptPath: join(scripts, 'bundle-runtime.mjs') });
      return { code, report: out.map((l) => l.trim()).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).at(-1) };
    } finally {
      process.stdout.write = write;
    }
  };

  // Nimbus's production bucket: published, configs pinned, and the sync reports that digest.
  const production = await sync('nimbus-runtime-cache');
  assert.equal(production.code, 0, 'the sync of the production bucket succeeds');
  const written = object('catalog/v1.json');
  const sha = createHash('sha256').update(written).digest('hex');
  assert.equal(production.report.catalogSha256, sha, 'it names the catalog the bucket holds');
  assert.deepEqual(object(catalogKey(sha)), written, 'held by its digest too');
  assert.deepEqual([...pins('hosted-demo'), ...pins('probe')], Array(4).fill(sha), 'and Nimbus\'s configs carry it');

  // Any other bucket: the same report, configs untouched.
  rmSync(bucketDir, { recursive: true });
  mkdirSync(bucketDir);
  const other = await sync('nimbus-runtime-cache-experiment');
  assert.equal(other.code, 0);
  const otherSha = createHash('sha256').update(object('catalog/v1.json')).digest('hex');
  assert.equal(other.report.catalogSha256, otherSha);
  assert.deepEqual([...pins('hosted-demo'), ...pins('probe')], Array(4).fill(sha), 'another bucket leaves Nimbus\'s configs');
} finally {
  process.chdir(cwd);
  process.env.PATH = savedPath;
  if (savedAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
  rmSync(root, { recursive: true, force: true });
}
console.log('cli-runtime-sync: ok');
