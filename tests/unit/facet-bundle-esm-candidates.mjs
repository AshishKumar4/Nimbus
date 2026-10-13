#!/usr/bin/env bun
/**
 * The bundle's module-staging pass must cover exactly what the facet runs.
 *
 * An ES module becomes a native `{ js }` module; CommonJS stays a `{ cjs }`
 * cell. A file the staging pass skips would otherwise reach the CommonJS
 * registry with module syntax, so candidate coverage remains load-bearing.
 *
 * Code cells include extensionless entries — the shape of nearly every npm
 * `bin` script — so the transform has to take them too. The pass previously
 * keyed on `.js` / `.mjs` alone, which left exactly those files behind.
 */

import assert from 'node:assert/strict';
import { looksLikeEsm, needsBundleCellTransform } from '../../packages/core/src/runtime/bundle-cell-transform.ts';
import { readModuleImportSites } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import {
  EsbuildService,
  TRANSFORM_SLICE_FILES,
  TRANSFORM_SLICE_SOURCE_BYTES,
} from '../../packages/core/src/runtime/esbuild-service.ts';
import { launchFs } from './lib/launch-fs.mjs';

for (const [path, source, type, esm, transform] of [
  ['bin/cli', 'import "./dep.js";', 'module', true, true],
  ['pkg/entry.mjs', 'const answer = 42;', null, true, true],
  ['pkg/entry.js', 'export const answer = 42;', null, true, true],
  ['pkg/entry.js', 'module.exports = 42;', 'commonjs', false, false],
  ['pkg/entry.cjs', 'module.exports = 42;', 'module', false, false],
  ['pkg/entry.cjs', 'module.exports = () => import("./dep.mjs");', null, false, true],
  ['pkg/LICENSE', 'Apache License 2.0\nimport, and otherwise transfer the Work.', 'module', false, false],
  ['pkg/data.json', '{"import":"./dep.js"}', 'module', false, false],
  ['src/code.ts', 'const answer: number = 42;', null, false, true],
  ['src/types.d.ts', 'export declare const answer: number;', null, true, false],
]) {
  assert.equal(looksLikeEsm(path, source, type), esm, `${path}: native module candidate`);
  assert.equal(needsBundleCellTransform(path, source, type), transform, `${path}: module pipeline candidate`);
}

// A typescript@7-shaped tree: an extensionless ESM bin, an ESM `lib/tsc.js`
// it side-effect imports, and the `#getExePath` imports-field target that
// one pulls in.
const TS = 'home/user/node_modules/typescript';
const files = {
  'home/user/package.json': JSON.stringify({ name: 'app' }),
  [`${TS}/package.json`]: JSON.stringify({
    name: 'typescript',
    version: '7.0.2',
    type: 'module',
    bin: { tsc: './bin/tsc' },
    imports: { '#getExePath': './lib/getExePath.js' },
  }),
  [`${TS}/bin/tsc`]: '#!/usr/bin/env node\nimport "../lib/tsc.js";\n',
  [`${TS}/lib/tsc.js`]: 'import getExePath from "#getExePath";\nconst exe = getExePath();\nexport default exe;\n',
  [`${TS}/lib/getExePath.js`]: 'export default function getExePath() { return "tsc"; }\n',
  // A data file with no extension in the same package tree: the speculative
  // walk pulls it in, and the transform must leave its bytes alone. Its prose
  // (typescript@7's own LICENSE) has an "import" token at top level.
  [`${TS}/LICENSE`]: 'Apache License 2.0\n\n3. Grant of Patent License. Each Contributor grants You a patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work.\n\n4. Redistribution. You must give any other recipients of the Work a copy of this License; and\n',
};

// A native transform host preserves the source and reports its import sites.
const nativeEsbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code, options }) => {
    assert.equal(options.esModule, 'node');
    return { code, map: JSON.stringify(readModuleImportSites(code)), warnings: [], esModule: options.esModule };
  }),
});

const vfs = launchFs(files).fs;
const state = await buildPrefetchBundle(
  vfs, { scriptPath: `${TS}/bin/tsc`, cwd: 'home/user', entryCode: files[`${TS}/bin/tsc`], esbuild: nativeEsbuild },
);

// What a path runs: its staged native module, CommonJS emit, or the file.
const moduleOf = (state, path) => state.esm?.modules.get(path)?.text ?? state.emits?.get(path) ?? state.bundle[path];
const transformed = new Set(state.esm?.modules.keys());

// The imports-field target is statically reachable from the extensionless
// bin, so it must be in the bundle — a bundle miss is unexecutable, since
// only bundled files get a pre-compiled function.
assert.ok(`${TS}/lib/getExePath.js` in state.bundle, 'imports-field target must be bundled');
assert.ok(`${TS}/lib/tsc.js` in state.bundle);
assert.ok(`${TS}/bin/tsc` in state.bundle);

// Every ESM cell — extensionless bin included — must be staged natively.
assert.ok(transformed.has(`${TS}/bin/tsc`), 'extensionless ESM bin must be staged natively');
assert.ok(transformed.has(`${TS}/lib/tsc.js`));
assert.ok(transformed.has(`${TS}/lib/getExePath.js`));

// Native modules keep their import/export syntax, with specifiers resolved
// for the registry. The file itself keeps its bytes on disk.
for (const path of Object.keys(state.bundle)) {
  const code = moduleOf(state, path);
  if (typeof code !== 'string' || path.endsWith('/LICENSE')) continue;
  assert.equal(state.bundle[path], files[path], `${path} is staged as the file it is`);
}
assert.match(moduleOf(state, `${TS}/bin/tsc`), /import "\.\.\/lib\/tsc\.js"/);
assert.match(moduleOf(state, `${TS}/lib/tsc.js`), /export default exe/);
assert.deepEqual(state.esm.missing, [], 'all static ES-module imports resolve in the staged graph');
assert.ok(state.codeOnly?.has(`${TS}/lib/tsc.js`), 'an installed ES module staged only to run is code-only');

// Non-JS content stays byte-identical: the pass parses before it rewrites.
assert.equal(state.bundle[`${TS}/LICENSE`], files[`${TS}/LICENSE`]);

// No cell is transformed in the session isolate. esbuild-wasm's heap starts at
// ~28 MiB, grows with every module and is never released, and a launch that
// transformed in-session carried it into the next step: `node -e 1` in the
// seed project cost the session 39 MiB it never got back, `npx nuxi init`
// took it from 36 to 151 MiB, and npm install then died of exceededMemory.
// With a transform host, everything esbuild must see goes to it a transform
// slice per call (transformSlices) — so a paced launch can yield between
// them. Large JavaScript modules take the same native-staging path as small ones.
{
  const root = 'home/user/node_modules/large-esm';
  const entry = `${root}/cli.js`;
  const large = `${root}/large.js`;
  const awaited = `${root}/awaited.js`;
  const small = `${root}/small.js`;
  const broken = `${root}/broken.js`;
  const largeFiles = {
    'home/user/package.json': JSON.stringify({ name: 'large-test' }),
    [`${root}/package.json`]: JSON.stringify({ name: 'large-esm', type: 'module' }),
    [entry]: 'import "./large.js";\nimport "./awaited.js";\nimport "./small.js";\nimport "./broken.js";\n',
    [large]: `const payload = "${'x'.repeat(600_000)}";\nexport{payload};\n`,
    // Top-level await remains in a large native module's source.
    [awaited]: `export const payload = await Promise.resolve("${'x'.repeat(600_000)}");\n`,
    [small]: 'export const small = 1;\n',
    [broken]: 'export const BROKEN = ;\n',
  };
  const calls = [];
  const hosted = new EsbuildService(undefined, {
    transformHost: async (requests) => {
      calls.push(requests.map(({ code }) => code));
      return requests.map(({ code }) => (code.includes('BROKEN')
        ? { error: 'Unexpected ";"' }
        : { code, map: JSON.stringify(readModuleImportSites(code)), warnings: [], esModule: 'node' }));
    },
  });
  assert.equal(hosted.transformsInIsolate, false);
  const state = await buildPrefetchBundle(
    launchFs(largeFiles).fs, { scriptPath: `/${entry}`, cwd: 'home/user', entryCode: largeFiles[entry], esbuild: hosted },
  );
  const sent = calls.flat();
  assert.equal(sent.length, 5, 'every native ES cell, including both large ones, reaches the host');
  for (const slice of calls) {
    assert.ok(slice.length <= TRANSFORM_SLICE_FILES, 'no call carries more files than a slice');
    assert.ok(slice.length === 1 || slice.reduce((n, code) => n + code.length, 0) <= TRANSFORM_SLICE_SOURCE_BYTES,
      'a call carries one slice: under the byte bound, or a single larger cell alone');
  }
  for (const cell of [large, awaited, small]) {
    const staged = state.esm?.modules.get(cell);
    assert.ok(staged, `${cell} stages natively`);
    assert.equal(staged.text.slice(staged.head, staged.text.length - staged.tail), largeFiles[cell], 'a native module keeps its original body, including top-level await');
  }
  assert.ok(state.esm?.modules.has(entry), 'the importing entry is staged too');
  assert.throws(() => new Function(moduleOf(state, broken))(), /esbuild transform failed for .*broken\.js: Unexpected ";"/,
    'a rejected module throws its reason when required, and costs the others nothing');


}

// A deeply nested large module takes the same host import-sites path, with
// no session lowering threshold or transform-engine emit.
{
  const root = 'home/user/node_modules/deep-large';
  const deep = `export const x = ${'['.repeat(7000)}"${'y'.repeat(600_000)}"${']'.repeat(7000)};\n`;
  const files = {
    'home/user/package.json': JSON.stringify({ name: 'deep-large-test' }),
    [`${root}/package.json`]: JSON.stringify({ name: 'deep-large', type: 'module' }),
    [`${root}/cli.js`]: 'import "./deep.js";\n',
    [`${root}/deep.js`]: deep,
  };
  const sent = [];
  const host = new EsbuildService(undefined, {
    transformHost: async (requests) => {
      sent.push(...requests);
      return requests.map(({ code }) => ({ code, map: JSON.stringify(readModuleImportSites(code)), warnings: [], esModule: 'node' }));
    },
  });
  const state = await buildPrefetchBundle(
    launchFs(files).fs, { scriptPath: `/${root}/cli.js`, cwd: 'home/user', entryCode: files[`${root}/cli.js`], esbuild: host },
  );
  const request = sent.find(({ code }) => code === deep);
  assert.ok(request, 'the deep module reaches the host');
  assert.equal(request.options.esModule, 'node');
  const staged = state.esm?.modules.get(`${root}/deep.js`);
  assert.ok(staged);
  assert.equal(staged.text.slice(staged.head, staged.text.length - staged.tail), deep);
}

// A cell whose import sites cannot be read fails alone; its siblings still stage.
{
  const root = 'home/user/node_modules/prepass-esm';
  const prepassFiles = {
    'home/user/package.json': JSON.stringify({ name: 'prepass-test' }),
    [`${root}/package.json`]: JSON.stringify({ name: 'prepass-esm', type: 'module' }),
    [`${root}/cli.js`]: 'import "./unreadable.js";\nimport "./dep.js";\n',
    // A malformed specifier defeats the import-sites lexer and its grammar
    // fallback. Other invalid JavaScript can still have readable import sites.
    [`${root}/unreadable.js`]: 'export const ok = 1;\nimport "./unterminated\n',
    [`${root}/dep.js`]: 'export const dep = 2;\n',
  };
  const sent = [];
  const host = new EsbuildService(undefined, {
    transformHost: async (requests) => {
      sent.push(...requests.map(({ code }) => code));
      return requests.map(({ code, options }) => {
        try {
          return { code, map: JSON.stringify(readModuleImportSites(code)), warnings: [], esModule: options.esModule };
        } catch (e) {
          return { error: e.message };
        }
      });
    },
  });
  const state = await buildPrefetchBundle(
    launchFs(prepassFiles).fs, { scriptPath: `/${root}/cli.js`, cwd: 'home/user', entryCode: prepassFiles[`${root}/cli.js`], esbuild: host },
  );
  for (const cell of [`${root}/cli.js`, `${root}/dep.js`]) {
    assert.ok(state.esm?.modules.has(cell), `${cell} is staged despite its unreadable sibling`);
  }
  assert.throws(() => new Function(moduleOf(state, `${root}/unreadable.js`))(),
    /esbuild transform failed for .*unreadable\.js: Unterminated string constant/,
    'the unreadable cell throws its own reason when required');
}


console.log('facet-bundle-esm-candidates: ok');
