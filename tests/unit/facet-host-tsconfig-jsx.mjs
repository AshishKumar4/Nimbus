#!/usr/bin/env bun
// Kinu's call path: a host bundling in its own Durable Object reaches Nimbus's
// builds and transforms through the public `facet-host` entry's
// supervisorEsbuildService, so a build runs in the build facet (rolldown) and
// a transform in the transform facet (Oxc), both here as production loads
// them (the staged runtimes, binding and wasm). tsconfigRaw and esbuild's own
// JSX options reach both as they reached esbuild 0.24.2 in Nimbus 0.14.0
// (tests/unit/tsconfig-jsx-differential.mjs compares every setting).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import * as buildHarness from './lib/build-facet-harness.mjs';
import * as oxcHarness from './lib/oxc-facet-harness.mjs';

const worker = JSON.parse(await readFile(new URL('../../packages/worker/package.json', import.meta.url), 'utf8'));
const { supervisorEsbuildService } = await import(new URL(`../../packages/worker/${worker.exports['./facet-host'].workspace}`, import.meta.url).href);

const harness = createSqliteVfsTestHarness();
const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
const APP = 'export const App = () => <div>hi</div>;\n';
kernel.writeFile('a.tsx', APP);
kernel.writeFile('b.ts', 'function dec(t: any) { return t; }\n@dec class A {}\nexport { A };\n');

// One Durable Object with both facets, as Kinu's has.
const { BuildFacet, cleanup } = await buildHarness.freshFacetClass();
const build = buildHarness.durableObject(BuildFacet);
const transform = oxcHarness.durableObject(await oxcHarness.freshFacetClass());
const own = (name) => (name.startsWith('nimbus-oxc:') ? transform : build);
const ctx = {
  id: { toString: () => 'kinu-do' },
  facets: {
    get: (name, load) => own(name).ctx.facets.get(name, load),
    abort: (name, reason) => build.ctx.facets.abort(name, reason),
  },
};
const env = { ASSETS: build.env.ASSETS, LOADER: { get: (id, load) => own(id).env.LOADER.get(id, load) } };
const service = supervisorEsbuildService(ctx, env, kernel);
const text = (result) => {
  const contents = result.outputFiles.find((f) => f.path.endsWith('.js')).contents;
  return typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
};

try {
  // Kinu's repro, exactly: refused on 0.15.0, `import { jsx } from "react/jsx-runtime"` on 0.14.0.
  {
    const result = await service.build(['/a.tsx'], { tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }) });
    const code = text(result);
    assert.match(code, /^import \{ jsx \} from "react\/jsx-runtime";$/m, code);
    assert.doesNotMatch(code, /createElement/);
    assert.deepEqual(result.warnings, []);
    assert.equal(build.counts.calls, 1, 'the build ran in the build facet');
    console.log('  ok  build: Kinu\'s tsconfigRaw (react-jsx, jsxImportSource react) emits the automatic runtime');
  }
  // esbuild's own JSX options, which build() refused as unknown.
  {
    const code = text(await service.build(['/a.tsx'], { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: true }));
    assert.match(code, /^import \{ jsxDEV \} from "preact\/jsx-dev-runtime";$/m, code);
    // jsxDEV names the file by its absolute path, as the session sees it.
    assert.match(code, /_jsxFileName = "\/a\.tsx"/, code);
    console.log('  ok  build: jsx automatic, jsxImportSource and jsxDev, the file named by its absolute path');
  }
  // The same tsconfig through transform(), which refused it too.
  {
    const result = await service.transform(APP, { loader: 'tsx', tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }) });
    assert.match(result.code, /^import \{ jsx as (\w+) \} from "react\/jsx-runtime";$/m, result.code);
    assert.equal(transform.counts.transformCalls, 1, 'the transform ran in the transform facet');
    console.log('  ok  transform: Kinu\'s tsconfigRaw emits the automatic runtime');
  }
  // jsxImportSource and jsxDev, which the transform dropped without a word.
  {
    const { code } = await service.transform(APP, { loader: 'tsx', jsx: 'automatic', jsxImportSource: 'preact', jsxDev: true });
    assert.match(code, /^import \{ jsxDEV as (\w+) \} from "preact\/jsx-dev-runtime";$/m, code);
    console.log('  ok  transform: jsx automatic, jsxImportSource and jsxDev');
  }
  // A field neither engine can honour is refused by name, where it would change the output.
  {
    const tsconfigRaw = JSON.stringify({ compilerOptions: { experimentalDecorators: true, jsx: 'react-jsx' } });
    const error = await service.build(['/b.ts'], { tsconfigRaw }).then(() => assert.fail('a decorated class must be refused'), (e) => e);
    assert.match(error.message, /compilerOptions\.experimentalDecorators true is not supported for a TypeScript file with decorators/);
    assert.equal(error.errors[0].location.file, 'nimbus-vfs:/b.ts', 'placed as esbuild names a module: its namespace and path');
    assert.equal(error.errors[0].location.line, 2);
    await assert.rejects(service.transform(kernel.readFileString('b.ts'), { loader: 'ts', tsconfigRaw }), /compilerOptions\.experimentalDecorators true/);
    const plain = text(await service.build(['/a.tsx'], { tsconfigRaw }));
    assert.match(plain, /from "react\/jsx-runtime"/, 'the same tsconfig builds a file without decorators');
    console.log('  ok  experimentalDecorators: refused by name for a decorated class, honoured elsewhere');
  }
} finally {
  buildHarness.releaseBuildFacetHarness();
  oxcHarness.releaseFacetHarness();
  cleanup();
}

console.log('facet-host-tsconfig-jsx: ok');
