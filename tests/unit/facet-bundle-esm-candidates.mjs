#!/usr/bin/env bun
/**
 * The bundle's ESM→CJS pass must cover exactly what the facet compiles.
 *
 * Every code file of the bundle becomes a `{ cjs }` module the guest's
 * registry compiles as CommonJS (core/_shared/commonjs-cell.ts). That makes
 * the two sets load-bearing: a file that is a code cell but that the ESM→CJS
 * pass skipped reaches the registry as ESM source and dies there, with
 * nothing left that can recover it at request time.
 *
 * Code cells include extensionless entries — the shape of nearly every npm
 * `bin` script — so the transform has to take them too. The pass previously
 * keyed on `.js` / `.mjs` alone, which left exactly those files behind.
 */

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import {
  EsbuildService,
  TRANSFORM_SLICE_FILES,
  TRANSFORM_SLICE_SOURCE_BYTES,
} from '../../packages/core/src/runtime/esbuild-service.ts';
import { launchFs } from './lib/launch-fs.mjs';


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

// Stands in for esbuild's CJS emit, as the transform host the session's
// esbuild uses: marks its output and drops the import statements, so the
// bundle shows which cells the pass actually reached.
const cjsEsbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code, options }) => {
    assert.equal(options.format, 'cjs');
    return { code: '/* cjs */\n' + code.replace(/^import .*$/gm, ''), map: '', warnings: [] };
  }),
});

const vfs = launchFs(files).fs;
const state = await buildPrefetchBundle(
  vfs, `${TS}/bin/tsc`, 'home/user', files[`${TS}/bin/tsc`], cjsEsbuild,
);

const transformed = new Set(
  Object.entries(state.bundle)
    .filter(([, cell]) => typeof cell === 'string' && cell.startsWith('/* cjs */'))
    .map(([path]) => path),
);

// The imports-field target is statically reachable from the extensionless
// bin, so it must be in the bundle — a bundle miss is unexecutable, since
// only bundled files get a pre-compiled function.
assert.ok(`${TS}/lib/getExePath.js` in state.bundle, 'imports-field target must be bundled');
assert.ok(`${TS}/lib/tsc.js` in state.bundle);
assert.ok(`${TS}/bin/tsc` in state.bundle);

// Every ESM cell — extensionless bin included — must have been rewritten.
assert.ok(transformed.has(`${TS}/bin/tsc`), 'extensionless ESM bin must be rewritten to CJS');
assert.ok(transformed.has(`${TS}/lib/tsc.js`));
assert.ok(transformed.has(`${TS}/lib/getExePath.js`));

// No import statement may survive anywhere in the bundle: each one is a
// `new Function` SyntaxError at facet startup.
for (const [path, cell] of Object.entries(state.bundle)) {
  if (typeof cell !== 'string') continue;
  assert.doesNotMatch(cell, /^\s*import\s/m, `${path} still carries ESM import syntax`);
}

// Non-JS content stays byte-identical: the pass parses before it rewrites.
assert.equal(state.bundle[`${TS}/LICENSE`], files[`${TS}/LICENSE`]);

// No cell is transformed in the session isolate. esbuild-wasm's heap starts at
// ~28 MiB, grows with every module and is never released, and a launch that
// transformed in-session carried it into the next step: `node -e 1` in the
// seed project cost the session 39 MiB it never got back, `npx nuxi init`
// took it from 36 to 151 MiB, and npm install then died of exceededMemory.
// With a transform host, everything esbuild must see goes to it a transform
// slice per call (transformSlices) — so a paced launch can yield between
// them — and a large bundled cell whose shape allows it never reaches esbuild.
{
  const root = 'home/user/node_modules/large-esm';
  const entry = `${root}/cli.js`;
  const large = `${root}/large.js`;
  const unsupported = `${root}/unsupported.js`;
  const small = `${root}/small.js`;
  const broken = `${root}/broken.js`;
  const largeFiles = {
    'home/user/package.json': JSON.stringify({ name: 'large-test' }),
    [`${root}/package.json`]: JSON.stringify({ name: 'large-esm', type: 'module' }),
    [entry]: 'import "./large.js";\nimport "./unsupported.js";\nimport "./small.js";\nimport "./broken.js";\n',
    [large]: `const payload = "${'x'.repeat(600_000)}";\nexport{payload};\n`,
    [unsupported]: `export function payload() { return "${'x'.repeat(600_000)}"; }\n`,
    [small]: 'export const small = 1;\n',
    [broken]: 'export const BROKEN = ;\n',
  };
  const calls = [];
  const hosted = new EsbuildService(undefined, {
    transformHost: async (requests) => {
      calls.push(requests.map(({ code }) => code));
      return requests.map(({ code }) => (code.includes('BROKEN')
        ? { error: 'Unexpected ";"' }
        : { code: '/* hosted-cjs */\n', map: '', warnings: [] }));
    },
  });
  assert.equal(hosted.transformsInIsolate, false);
  const state = await buildPrefetchBundle(
    launchFs(largeFiles).fs, `/${entry}`, 'home/user', largeFiles[entry], hosted,
  );
  const sent = calls.flat();
  assert.equal(sent.length, 4, 'the entry, the unsupported large cell, the small one and the broken one');
  for (const slice of calls) {
    assert.ok(slice.length <= TRANSFORM_SLICE_FILES, 'no call carries more files than a slice');
    assert.ok(slice.length === 1 || slice.reduce((n, code) => n + code.length, 0) <= TRANSFORM_SLICE_SOURCE_BYTES,
      'a call carries one slice: under the byte bound, or a single larger cell alone');
  }
  assert.ok(calls.some((slice) => slice.length === 1 && slice[0].length > TRANSFORM_SLICE_SOURCE_BYTES),
    'the unsupported large cell travels alone');
  const compiled = { exports: {} };
  new Function('exports', 'require', 'module', state.bundle[large])(compiled.exports, null, compiled);
  assert.equal(compiled.exports.payload, 'x'.repeat(600_000), 'the bounded module exports its original value');
  for (const cell of [entry, unsupported, small]) assert.equal(state.bundle[cell], '/* hosted-cjs */\n', cell);
  assert.throws(() => new Function(state.bundle[broken])(), /esbuild transform failed for .*broken\.js: Unexpected ";"/,
    'a rejected module throws its reason when required, and costs the others nothing');


}

// A cell the pre-pass cannot parse fails alone; the rest of the launch still transforms.
{
  const root = 'home/user/node_modules/prepass-esm';
  const prepassFiles = {
    'home/user/package.json': JSON.stringify({ name: 'prepass-test' }),
    [`${root}/package.json`]: JSON.stringify({ name: 'prepass-esm', type: 'module' }),
    [`${root}/cli.js`]: 'import "./unreadable.js";\nimport "./dep.js";\n',
    [`${root}/unreadable.js`]: 'export const ok = 1;\nimport, and otherwise;\n',
    [`${root}/dep.js`]: 'export const dep = 2;\n',
  };
  const sent = [];
  const host = new EsbuildService(undefined, {
    transformHost: async (requests) => {
      sent.push(...requests.map(({ code }) => code));
      return requests.map(() => ({ code: '/* hosted-cjs */\n', map: '', warnings: [] }));
    },
  });
  const state = await buildPrefetchBundle(
    launchFs(prepassFiles).fs, `/${root}/cli.js`, 'home/user', prepassFiles[`${root}/cli.js`], host,
  );
  for (const cell of [`${root}/cli.js`, `${root}/dep.js`]) {
    assert.equal(state.bundle[cell], '/* hosted-cjs */\n', `${cell} is transformed despite its unreadable sibling`);
  }
  assert.throws(() => new Function(state.bundle[`${root}/unreadable.js`])(),
    /esbuild transform failed for .*unreadable\.js: Unexpected token/,
    'the unreadable cell throws its own reason when required');
  assert.ok(!sent.some((code) => code.includes('and otherwise')), 'the unreadable cell never reaches the host');
}


console.log('facet-bundle-esm-candidates: ok');
