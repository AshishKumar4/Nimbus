import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogKey } from '../../packages/worker/src/runtime/runtime-catalog.ts';
import { stageDeploymentProject } from './lib/deployment-project.mjs';
import { nimbusAppConfigs } from '../../scripts/generate-wrangler-configs.mjs';
import { parseWranglerJsonc } from '../../packages/worker/src/wrangler/wrangler-config.ts';

const repo = new URL('../../', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'nimbus-pin-test-'));
const scriptTmp = join(root, 'tmp');
const catalog = JSON.stringify({ version: 1, runtimes: { python: { default: '1.0', versions: {} } } });
const digest = createHash('sha256').update(catalog).digest('hex');
const old = 'f'.repeat(64);
try {
  const scripts = join(root, 'packages/worker/scripts');
  for (const dir of [scripts, scriptTmp, join(root, 'node_modules/@nimbus-sh'), join(root, 'bin')]) mkdirSync(dir, { recursive: true });
  for (const script of ['bundle-runtime.mjs', 'runtime-specs.mjs']) cpSync(join(repo, 'packages/worker/scripts', script), join(scripts, script));
  cpSync(join(repo, 'packages/worker/runtime-contracts'), join(root, 'packages/worker/runtime-contracts'), { recursive: true });
  symlinkSync(join(repo, 'packages/core'), join(root, 'node_modules/@nimbus-sh/core'));
  const spec = stageDeploymentProject(root, old);
  const specPath = join(root, 'apps/nimbus-deployments.json');
  const files = [specPath, join(root, 'apps/hosted-demo/wrangler.jsonc'), join(root, 'apps/probe/wrangler.jsonc')];
  const before = files.map((path) => readFileSync(path, 'utf8'));
  const objectsPath = join(root, 'objects.json');
  const askedPath = join(root, 'asked.log');
  writeFileSync(join(root, 'bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--file');
const key = args[3].slice(args[3].indexOf('/') + 1);
fs.appendFileSync(${JSON.stringify(askedPath)}, key + '\\n');
const objects = JSON.parse(fs.readFileSync(${JSON.stringify(objectsPath)}, 'utf8'));
if (!(key in objects)) { process.stderr.write('The specified key does not exist.'); process.exit(1); }
fs.writeFileSync(args[at + 1], objects[key]);
`, { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [join(scripts, 'bundle-runtime.mjs'), '--pin-catalog', ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CLOUDFLARE_ACCOUNT_ID: 'test-account', TMPDIR: scriptTmp },
  });
  const objects = { 'catalog/v1.json': catalog, [catalogKey(digest)]: catalog };
  writeFileSync(objectsPath, JSON.stringify(objects));
  const isolated = run('--bucket', 'experiment');
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.deepEqual(files.map((path) => readFileSync(path, 'utf8')), before, 'another bucket changes no deployment input or output');
  const published = run();
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, new RegExp(`^NIMBUS_RUNTIME_CATALOG_SHA256=${digest}$`, 'm'));
  assert.deepEqual(JSON.parse(readFileSync(specPath, 'utf8')), { ...spec, runtimeCatalogSha256: digest });
  assert.deepEqual(files.slice(1).map((path) => parseWranglerJsonc(readFileSync(path, 'utf8'))), nimbusAppConfigs({ ...spec, runtimeCatalogSha256: digest }));
  assert.ok(readFileSync(askedPath, 'utf8').split('\n').includes(catalogKey(digest)));

  for (const contents of [{ 'catalog/v1.json': catalog }, { ...objects, [catalogKey(digest)]: '{}' }]) {
    files.forEach((path, i) => writeFileSync(path, before[i]));
    writeFileSync(objectsPath, JSON.stringify(contents));
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.deepEqual(files.map((path) => readFileSync(path, 'utf8')), before, 'a missing or corrupt digest never changes a deployment');
  }
  writeFileSync(objectsPath, JSON.stringify(objects));
  writeFileSync(specPath, '{invalid');
  const invalid = run();
  assert.notEqual(invalid.status, 0);
  assert.deepEqual(files.slice(1).map((path) => readFileSync(path, 'utf8')), before.slice(1), 'invalid authority writes no partial projection');
  assert.deepEqual(readdirSync(scriptTmp), [], 'publisher cleans its work directories');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('bundle-runtime-catalog-pin: ok');
