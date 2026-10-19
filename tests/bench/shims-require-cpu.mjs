#!/usr/bin/env node
// The guest's CommonJS require through the node shims, under V8. Each arm
// bundles its own worker and core sources, including its resident store.
// A sample starts with a fresh factory; only require calls are timed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { launchCapturesPlugin } from '../../scripts/lib/launch-captures-plugin.mjs';
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
const root = fileURLToPath(new URL('../../', import.meta.url));
const packages = join(root, 'packages');
const worker = join(packages, 'worker');
const scratch = mkdtempSync(join(worker, '.shims-require-cpu-'));
const PAIRS = short ? 3 : 30;
const APP = '/home/user/app';
const results = [];

// Node exposes this as a getter; the shims front workerd's writable export.
const events = process.getBuiltinModule('events');
Object.defineProperty(events, 'EventEmitterAsyncResource', {
  value: events.EventEmitterAsyncResource, writable: true, enumerable: true, configurable: true,
});

/** Every worker/core import, including the fixture helper's, comes from this arm's source tree. */
function sourcePlugin(dir) {
  return {
    name: 'shims-require-arm-source',
    setup(builder) {
      builder.onResolve({ filter: /^@nimbus-sh\/core\// }, ({ path }) => ({
        path: join(dir, 'core', 'src', path.slice('@nimbus-sh/core/'.length).replace(/\.js$/, '.ts')),
      }));
      builder.onResolve({ filter: /^\./ }, ({ path, resolveDir }) => {
        const target = resolve(resolveDir, path);
        for (const name of ['worker', 'core']) {
          const source = join(packages, name, 'src') + '/';
          if (target.startsWith(source)) return { path: join(dir, name, 'src', target.slice(source.length)).replace(/\.js$/, '.ts') };
        }
      });
    },
  };
}

function residentAssetPlugin(source) {
  return {
    name: 'shims-require-resident-asset',
    setup(builder) {
      builder.onResolve({ filter: /^node:fs$/ }, ({ importer }) => importer === join(root, 'tests/unit/lib/shims-namespace.mjs')
        ? { path: 'resident', namespace: 'shims-require-resident' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'shims-require-resident' }, () => ({
        contents: `export const readFileSync = () => ${JSON.stringify(source)};`, loader: 'js',
      }));
    },
  };
}

async function arm(name, dir) {
  const core = join(dir, 'core');
  const options = {
    bundle: true, write: false, platform: 'node', target: 'esnext', absWorkingDir: root,
    nodePaths: [join(worker, 'node_modules'), join(packages, 'core', 'node_modules'), join(root, 'node_modules')],
    conditions: ['workspace'], mainFields: ['module', 'main'], legalComments: 'none',
  };
  const resident = await build({
    ...options, entryPoints: [join(dir, 'worker', 'src/vfs/resident/index.ts')],
    format: 'iife', globalName: '__nimbusResidentModule',
    plugins: [await launchCapturesPlugin('__nimbusLaunchCaptures', core), sourcePlugin(dir)],
  });
  const bundled = await build({
    ...options, format: 'esm', plugins: [sourcePlugin(dir), residentAssetPlugin(resident.outputFiles[0].text)],
    stdin: {
      resolveDir: root, sourcefile: `${name}-shims-require-arm.mjs`, loader: 'js',
      contents: `
import { generateShimsCode } from ${JSON.stringify(join(dir, 'worker/src/runtime/node-shims.ts'))};
import { VFS_WRITE_LEDGER_SOURCE } from ${JSON.stringify(join(core, 'src/_shared/vfs-write-ledger.ts'))};
import * as captures from ${JSON.stringify(join(core, 'src/_shared/primordials.ts'))};
import { createShimsStorePrelude, declareNamespace } from ${JSON.stringify(join(root, 'tests/unit/lib/shims-namespace.mjs'))};

export function createFactory(residentSource) {
  const compileCell = globalThis.__nimbusTestCompileCell;
  const nodeLib = globalThis.__nimbusTestNodeLib;
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();'
      + VFS_WRITE_LEDGER_SOURCE + '\\n' + createShimsStorePrelude(residentSource) + generateShimsCode()
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
  });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, bundled.outputFiles[0].text);
  const { createFactory } = await import(pathToFileURL(file).href);
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
  const sources = { A: baseline, null: baseline, real: packages };
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
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
