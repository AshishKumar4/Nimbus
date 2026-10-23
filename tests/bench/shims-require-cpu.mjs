#!/usr/bin/env node
// The guest's CommonJS require through the node shims, under V8. Each arm
// bundles its side's own tree (isolated-core.mjs), its resident store
// included, with its own launch-captures plugin and shims test helper.
// A sample starts with a fresh factory; only require calls are timed.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { armImports, armTree, assertArmsInside, assertBundleInside, importBundle, repository } from './lib/isolated-core.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const short = args.includes('--short');
const baseline = resolve(option('--baseline'));
const output = option('--out');
const scratch = mkdtempSync(join(tmpdir(), 'shims-require-cpu-'));
const disposals = [];
const PAIRS = short ? 3 : 30;
const APP = '/home/user/app';
const results = [];

// Node exposes this as a getter; the shims front workerd's writable export.
const events = process.getBuiltinModule('events');
Object.defineProperty(events, 'EventEmitterAsyncResource', {
  value: events.EventEmitterAsyncResource, writable: true, enumerable: true, configurable: true,
});

/** The resident store's source, where the arm's shims test helper (`helper`) reads it. */
function residentAssetPlugin(source, helper) {
  return {
    name: 'shims-require-resident-asset',
    setup(builder) {
      builder.onResolve({ filter: /^node:fs$/ }, ({ importer }) => importer === helper
        ? { path: 'resident', namespace: 'shims-require-resident' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'shims-require-resident' }, () => ({
        contents: `export const readFileSync = () => ${JSON.stringify(source)};`, loader: 'js',
      }));
    },
  };
}

/** An arm: its side's tree (`from`) bundled on its own, every input inside it. */
async function arm(name, from) {
  const tree = armTree(from, (dispose) => disposals.push(dispose));
  const core = join(tree, 'packages/core');
  const helper = join(tree, 'tests/unit/lib/shims-namespace.mjs');
  const options = {
    platform: 'node', target: 'esnext', absWorkingDir: tree,
    conditions: ['workspace'], mainFields: ['module', 'main'], legalComments: 'none',
  };
  // The side's own captures plugin, where it has one (a side before it binds no captures).
  const capturesPlugin = 'scripts/lib/launch-captures-plugin.mjs';
  const plugins = existsSync(join(tree, capturesPlugin))
    ? [await (await armImports(tree, [capturesPlugin]))[0].launchCapturesPlugin('__nimbusLaunchCaptures', core)] : [];
  const resident = await build({
    ...options, bundle: true, write: false, metafile: true, entryPoints: [join(tree, 'packages/worker/src/vfs/resident/index.ts')],
    format: 'iife', globalName: '__nimbusResidentModule', plugins,
  });
  assertBundleInside(tree, resident.metafile, tree);
  const { createFactory } = await importBundle(tree, {
    ...options, format: 'esm', plugins: [residentAssetPlugin(resident.outputFiles[0].text, helper)],
    stdin: {
      resolveDir: tree, sourcefile: `${name}-shims-require-arm.mjs`, loader: 'js',
      contents: `
import { generateShimsCode } from ${JSON.stringify(join(tree, 'packages/worker/src/runtime/node-shims.ts'))};
import * as captures from ${JSON.stringify(join(core, 'src/_shared/primordials.ts'))};
import { createShimsStorePrelude, declareNamespace } from ${JSON.stringify(helper)};

export function createFactory(residentSource) {
  const compileCell = globalThis.__nimbusTestCompileCell;
  const nodeLib = globalThis.__nimbusTestNodeLib;
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();'
      + '\\n' + createShimsStorePrelude(residentSource) + generateShimsCode()
      + '\\n;return builtins.module.createRequire(dirname + "/");\\n//# sourceURL=shims-require-${name}.js',
  );
  return (bundle, dir) => {
    globalThis.__nimbusLaunchCaptures = captures;
    globalThis.__nimbusTestLaunchCaptures = captures;
    globalThis.__nimbusTestCompileCell = compileCell;
    globalThis.__nimbusTestNodeLib = nodeLib;
    declareNamespace();
    return factory(
      { ...bundle }, {}, null,
      { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, dir + '/main.js', dir,
    );
  };
}
`,
    },
  }, join(scratch, `${name}.mjs`));
  return createFactory(resident.outputFiles[0].text);
}

const packagesFixture = {};
const packageExports = Array.from({ length: 200 }, (_, id) => ({ id, name: `pkg${id}` }));
for (const exported of packageExports) {
  const base = `${APP.slice(1)}/node_modules/${exported.name}`;
  packagesFixture[`${base}/package.json`] = JSON.stringify({ name: exported.name, main: 'lib/main.js' });
  packagesFixture[`${base}/lib/main.js`] = `module.exports = ${JSON.stringify(exported)};\n`;
}
const packageCache = packageExports.map(({ name }) => `${APP}/node_modules/${name}/lib/main.js`).sort();
const jsonFixture = {};
const jsonExports = Array.from({ length: 100 }, (_, id) => ({ id, label: `json${id}`, values: [id, id + 1] }));
for (const exported of jsonExports) jsonFixture[`${APP.slice(1)}/json/f${exported.id}.json`] = JSON.stringify(exported);
const jsonCache = jsonExports.map(({ id }) => `${APP}/json/f${id}.json`).sort();
const relativeFixture = { [`${APP.slice(1)}/entry.js`]: 'module.exports = require("./chain/d0/file");\n' };
const relativeCache = [`${APP}/entry.js`];
let relativeDir = `${APP.slice(1)}/chain`;
for (let id = 0; id < 200; id++) {
  relativeDir += `/d${id}`;
  const key = `${relativeDir}/file.js`;
  relativeFixture[key] = `module.exports = ${id}${id === 199 ? '' : ` + require("./d${id + 1}/file")`};\n`;
  relativeCache.push('/' + key);
}
relativeCache.sort();

const workloads = {
  require: {
    bundle: packagesFixture, cache: packageCache, exports: packageExports,
    run: (require) => packageExports.map(({ name }) => require(name)),
  },
  relative: {
    bundle: relativeFixture, cache: relativeCache, exports: 19_900,
    run: (require) => require('./entry'),
  },
  json: {
    bundle: jsonFixture, cache: jsonCache, exports: jsonExports,
    run: (require) => jsonExports.map(({ id }) => require(`./json/f${id}.json`)),
  },
  cached: {
    bundle: packagesFixture, cache: packageCache,
    exports: Array.from({ length: 2000 }, (_, id) => packageExports[id % 200]),
    prepare: (require) => { for (const { name } of packageExports) require(name); },
    run: (require) => Array.from({ length: 2000 }, (_, id) => require(`pkg${id % 200}`)),
  },
};

try {
  const sources = { A: baseline, null: baseline, real: repository };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await arm(name, sources[name]);
  const cpu = async (factory, kind) => {
    const work = workloads[kind];
    const require = factory(work.bundle, APP);
    work.prepare?.(require);
    let exported;
    const used = await cpuMs(() => { exported = work.run(require); });
    assert.deepEqual(exported, work.exports, `${kind}: each arm returns the same exports`);
    assert.deepEqual(Object.keys(require.cache).sort(), work.cache, `${kind}: each arm caches the same files`);
    return used;
  };
  for (const kind of Object.keys(workloads)) {
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: short ? 1 : 4, iterations: kind === 'cached' ? 2000 : kind === 'json' ? 100 : 200 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  // What the arms loaded while they worked, a lazy import included, was theirs.
  assertArmsInside();
} finally {
  for (const dispose of disposals) dispose();
  rmSync(scratch, { recursive: true, force: true });
}
