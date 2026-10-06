#!/usr/bin/env bun
// `bundle-runtime.mjs --pin-catalog` points Nimbus's own deployments at the
// catalog their bucket holds: the NIMBUS_RUNTIME_CATALOG_SHA256 var in every
// vars block of apps/hosted-demo and apps/probe (CATALOG_PIN_CONFIGS), which
// runtime-catalog.ts reads the catalog by. What must hold:
//
//   1. The var is the digest of the bytes fetched, written into every vars
//      block and nowhere else, comments kept.
//   2. Only the production bucket rewrites Nimbus's configs; any other bucket
//      prints the var for the embedder's own config.
//   3. A deployment pointed at a digest must find it: without
//      catalog/sha256/<digest>.json holding the same bytes, nothing changes.
//   4. A vars block without the var is an environment the script does not
//      know: refused, no config changed.
//   5. The key the script reads is the key the Worker reads (catalogKey).
//   6. Every run prints NIMBUS_RUNTIME_CATALOG_SHA256=<digest>, the line
//      `nimbus runtime sync` reads, the production bucket's included.
//   7. The blocks are the config's, as wrangler reads it (top level, each
//      env, their previews), not text that looks like one: a `"vars"` in a
//      comment is neither counted nor written, and a block without the var
//      is refused even when a comment carries one.
//
// The script runs for real against a stub wrangler, from a temp tree laid out
// as the repo is: it resolves the configs from import.meta.url, so a copy in
// the temp tree rewrites the temp tree's configs and never the repo's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogKey } from '../../packages/worker/src/runtime/runtime-catalog.ts';

const WORKER = new URL('../../packages/worker/', import.meta.url).pathname;
const CORE = new URL('../../packages/core', import.meta.url).pathname;
const CATALOG = JSON.stringify({ version: 1, runtimes: { python: { default: '1.0', versions: {} } } }, null, 2);
const CATALOG_SHA = createHash('sha256').update(CATALOG).digest('hex');
const OLD = 'f'.repeat(64);
// A wrangler config: the first block the top level's vars, the rest env1, env2, ….
const config = (blocks) => `{
  // A comment the rewrite keeps.
  "name": "app",
  "vars": {\n${blocks[0]}\n  },
  "env": {
${blocks.slice(1).map((vars, i) => `    "env${i + 1}": {\n      "vars": {\n${vars}\n      }\n    }`).join(',\n')}
  }
}
`;
const pinned = `      // the catalog this environment reads\n      "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}",\n      "OTHER": "x"`;

const root = mkdtempSync(join(tmpdir(), 'nimbus-pin-test-'));
// The script's own working directory, under its TMPDIR: every run must remove it, refused or not.
const scriptTmp = join(root, 'tmp');
mkdirSync(scriptTmp);
try {
  const scripts = join(root, 'packages/worker/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const script of ['bundle-runtime.mjs', 'runtime-specs.mjs']) cpSync(join(WORKER, 'scripts', script), join(scripts, script));
  cpSync(join(WORKER, 'runtime-contracts'), join(root, 'packages/worker/runtime-contracts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@nimbus-sh'), { recursive: true });
  symlinkSync(CORE, join(root, 'node_modules/@nimbus-sh/core'));
  // The JSONC editor the production path loads, as the worker package resolves it.
  symlinkSync(realpathSync(join(WORKER, 'node_modules/jsonc-parser')), join(root, 'node_modules/jsonc-parser'));
  mkdirSync(join(root, 'apps/hosted-demo'), { recursive: true });
  mkdirSync(join(root, 'apps/probe'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  const hosted = join(root, 'apps/hosted-demo/wrangler.jsonc');
  const probe = join(root, 'apps/probe/wrangler.jsonc');
  const resetConfigs = (hostedBlocks = [pinned, pinned, pinned]) => {
    writeFileSync(hosted, config(hostedBlocks));
    writeFileSync(probe, config([pinned, pinned]));
  };

  // Stub wrangler: `r2 object get <bucket>/<key> --file <path> --remote`, from
  // OBJECTS (a JSON map of key → text), and a log of every key it was asked.
  const objectsPath = join(root, 'objects.json');
  const askedPath = join(root, 'asked.log');
  writeFileSync(join(root, 'bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.indexOf('--file');
if (args[0] === 'r2' && args[1] === 'object' && args[2] === 'get' && i > 0) {
  const key = args[3].slice(args[3].indexOf('/') + 1);
  fs.appendFileSync(${JSON.stringify(askedPath)}, key + '\\n');
  const objects = JSON.parse(fs.readFileSync(${JSON.stringify(objectsPath)}, 'utf8'));
  if (!(key in objects)) { process.stderr.write('The specified key does not exist.'); process.exit(1); }
  fs.writeFileSync(args[i + 1], objects[key]);
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  const setObjects = (objects) => { writeFileSync(objectsPath, JSON.stringify(objects)); writeFileSync(askedPath, ''); };
  const run = (env = {}, ...args) => spawnSync(process.execPath, [join(scripts, 'bundle-runtime.mjs'), '--pin-catalog', ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CLOUDFLARE_ACCOUNT_ID: 'test-account', TMPDIR: scriptTmp, ...env },
  });
  const values = (path) => [...readFileSync(path, 'utf8').matchAll(/"NIMBUS_RUNTIME_CATALOG_SHA256": "([a-f0-9]*)"/g)].map((m) => m[1]);
  const both = { 'catalog/v1.json': CATALOG, [catalogKey(CATALOG_SHA)]: CATALOG };

  // 2. Another bucket: printed, not written.
  resetConfigs();
  setObjects(both);
  const isolated = run({}, '--bucket', 'nimbus-runtime-cache-some-experiment');
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.match(isolated.stdout, new RegExp(`^NIMBUS_RUNTIME_CATALOG_SHA256=${CATALOG_SHA}$`, 'm'));
  assert.deepEqual([...values(hosted), ...values(probe)], Array(5).fill(OLD), 'another bucket rewrote Nimbus\'s configs');

  // 1 and 5. Production: every vars block, the digest of the bytes fetched, read under the Worker's key.
  resetConfigs();
  setObjects(both);
  const production = run();
  assert.equal(production.status, 0, production.stderr);
  assert.match(production.stdout, new RegExp(`^NIMBUS_RUNTIME_CATALOG_SHA256=${CATALOG_SHA}$`, 'm'), 'the production bucket prints the line too');
  assert.deepEqual(values(hosted), Array(3).fill(CATALOG_SHA));
  assert.deepEqual(values(probe), Array(2).fill(CATALOG_SHA));
  assert.match(readFileSync(hosted, 'utf8'), /A comment the rewrite keeps\./);
  assert.match(readFileSync(hosted, 'utf8'), /"OTHER": "x"/);
  assert.ok(readFileSync(askedPath, 'utf8').split('\n').includes(catalogKey(CATALOG_SHA)), 'the script read the key the Worker reads');

  // 3. The object by digest missing, or holding other bytes: nothing changes.
  for (const objects of [{ 'catalog/v1.json': CATALOG }, { 'catalog/v1.json': CATALOG, [catalogKey(CATALOG_SHA)]: '{}' }]) {
    resetConfigs();
    setObjects(objects);
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, new RegExp(catalogKey(CATALOG_SHA).replaceAll('/', '\\/')));
    assert.deepEqual([...values(hosted), ...values(probe)], Array(5).fill(OLD), 'a pin to a missing catalog was written');
  }

  // 4. A vars block without the var: refused, and no config changed (not even the complete one).
  resetConfigs([pinned, '      "OTHER": "x"', pinned]);
  setObjects(both);
  const unknown = run();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /every vars block must carry it/);
  assert.deepEqual(values(probe), Array(2).fill(OLD));

  // 7. A commented example of a vars block is a comment.
  const commentedVars = `      // e.g. "vars": { "OTHER": "y" }\n${pinned}`;
  resetConfigs([commentedVars, pinned, pinned]);
  setObjects(both);
  const commented = run();
  assert.equal(commented.status, 0, commented.stderr);
  assert.deepEqual(values(hosted), Array(3).fill(CATALOG_SHA));
  assert.match(readFileSync(hosted, 'utf8'), /\/\/ e\.g\. "vars": \{ "OTHER": "y" \}/, 'the comment is kept as it was');

  // 7. A block without the var is refused even when a comment carries one, and the comment is left.
  const commentedPin = `      // was: "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}"\n      "OTHER": "x"`;
  resetConfigs([pinned, commentedPin, pinned]);
  setObjects(both);
  const disguised = run();
  assert.notEqual(disguised.status, 0, 'a block without the var passed because a comment carried one');
  assert.match(disguised.stderr, /env\.env1\.vars without NIMBUS_RUNTIME_CATALOG_SHA256/);
  assert.deepEqual(values(probe), Array(2).fill(OLD));

  // 7. Every block wrangler reads: the top level, each env, and their previews.
  writeFileSync(hosted, `{
  "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}" },
  "previews": { "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}", }, },
  "env": {
    "staging": {
      "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}" },
      "previews": { "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}" } }
    },
    "production": { "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${OLD}" } }
  }
}
`);
  writeFileSync(probe, config([pinned]));
  setObjects(both);
  const everyBlock = run();
  assert.equal(everyBlock.status, 0, everyBlock.stderr);
  assert.deepEqual(values(hosted), Array(5).fill(CATALOG_SHA), 'top level, env, and previews');

  assert.deepEqual(readdirSync(scriptTmp), [], 'a refused pin left its download behind');

  // An unreadable bucket pins nothing.
  resetConfigs();
  const broken = run({ PATH: '/nonexistent' });
  assert.notEqual(broken.status, 0);
  assert.deepEqual([...values(hosted), ...values(probe)], Array(5).fill(OLD));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('bundle-runtime-catalog-pin: ok');
