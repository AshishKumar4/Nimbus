#!/usr/bin/env bun
// The Vite dev server bundles a barrel package (over 1500 files) from an
// entry it synthesizes from the names the project imports from it. To find
// those names it scans the project's source, and that scan, run in the
// session's isolate on every barrel request, read every source file whole:
// a large generated file in the project was read in full every time.
//
// The scan is bounded now (PROJECT_SCAN: 2048 files, 1 MiB each, 16 MiB in
// all). A scan that left files unread may miss a name one of them imports,
// so the server says so and bundles the barrel whole, as any package; and
// it serves no bundle synthesized before from fewer names. A barrel bundle
// never lacks an export the project asks for.
//
//   - a project within the budget: the barrel is bundled from a synthetic
//     entry, as before;
//   - a project source past the budget (1.5 MiB, importing a name nothing
//     else imports): the scan does not read it, the server says what it left
//     unread, and the barrel is bundled whole: the module served provides
//     that name, though the bundle synthesized and cached a moment before
//     did not.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { freshFacetClass, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? 'ok ' : 'RED'} ${name}`);
};
const encoder = new TextEncoder();
const root = 'home/user/app';
const ICONS = 1501;
const GENERATED = `${root}/src/generated.js`;

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const write = (path, content) => {
  const at = `${root}/${path}`;
  kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kernel.writeFile(at, encoder.encode(content), { mode: 0o644 });
};
write('package.json', JSON.stringify({ name: 'app', dependencies: { 'big-icons': '1.0.0' } }));
write('src/main.ts', "import { I0 } from 'big-icons';\nconsole.log(I0);\n");
write('node_modules/big-icons/package.json', JSON.stringify({ name: 'big-icons', version: '1.0.0', type: 'module', module: 'index.js', main: 'index.js' }));
const index = [];
for (let n = 0; n < ICONS; n++) {
  write(`node_modules/big-icons/icons/i${n}.js`, `export const I${n} = ${n};\n`);
  index.push(`export { I${n} } from './icons/i${n}.js';`);
}
write('node_modules/big-icons/index.js', index.join('\n') + '\n');

// Every read of the generated source, by anyone.
let generatedReads = 0;
const realAs = vfs.as.bind(vfs);
vfs.as = (cred, options) => {
  const bound = realAs(cred, options);
  return new Proxy(bound, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key !== 'readFile' && key !== 'readFileString') return value.bind(target);
      return (path, ...rest) => {
        if (path.replace(/^\/+/, '') === GENERATED) generatedReads++;
        return value.call(target, path, ...rest);
      };
    },
  });
};

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vite-dev-barrel-scan-budget-'));
try {
  const { BuildFacet } = await freshFacetClass();
  const facet = new BuildFacet({ id: { toString: () => 'vite-dev-barrel-scan-budget' } }, {});
  const entries = [];
  const pool = { prebundle: (spec) => (entries.push(spec.entryPath), facet.prebundle(spec)) };
  const server = new ViteDevServer({
    vfs, cred: CRED_KERNEL, esbuild: new EsbuildService(undefined, { engine: esbuildEngine }), root, sql: harness.sql,
    onHmrMessage() {}, basePath: '/preview', port: 5173, bundlePool: { acquire: async () => pool },
  });
  /** The module served for big-icons, what the server warned, and what an importer of `names` gets from it. */
  const serve = async (tag, names) => {
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    let response;
    try {
      response = await server.handleRequest(new Request('http://localhost/preview/@modules/big-icons'), '/@modules/big-icons');
    } finally {
      console.warn = warn;
    }
    const code = await response.text();
    const dir = join(scratch, tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'served.mjs'), code);
    writeFileSync(join(dir, 'importer.mjs'), `export { ${names.join(', ')} } from './served.mjs';\n`);
    const imported = await import(pathToFileURL(join(dir, 'importer.mjs')).href).then((module) => names.map((name) => module[name]), (error) => error);
    return { response, warned, imported };
  };

  // ── Within the budget: synthesized, as before ──────────────────────────
  const within = await serve('within', ['I0']);
  check('within the budget the barrel is bundled from a synthetic entry', entries.length === 1 && entries[0].includes('.nimbus-synthetic'), JSON.stringify(entries));
  check('and provides what the project imports', Array.isArray(within.imported) && within.imported[0] === 0, String(within.imported));

  // ── A source past the budget ───────────────────────────────────────────
  write('src/generated.js', `import { I1400 } from 'big-icons';\nconsole.log(I1400);\n// ${'x'.repeat(1536 * 1024)}\n`);
  generatedReads = 0;
  const past = await serve('past', ['I0', 'I1400']);
  check('the scan does not read a source past its budget', generatedReads === 0, `${generatedReads} reads of ${GENERATED}`);
  check('the server says what the scan left unread', past.warned.some((line) => line.includes('left 1 file(s) over 1048576 bytes') && line.includes('generated.js') && line.includes('bundling big-icons whole')), JSON.stringify(past.warned));
  check('and bundles the barrel whole, from its own entry', entries.length === 2 && entries[1].endsWith('/node_modules/big-icons/index.js'), JSON.stringify(entries));
  check('the module served provides the name only that source imports, not the bundle synthesized before', Array.isArray(past.imported) && past.imported[0] === 0 && past.imported[1] === 1400, String(past.imported));
  server.stop?.();
} finally {
  releaseBuildFacetHarness();
  await stopEsbuildEngine?.();
  rmSync(scratch, { recursive: true, force: true });
}

assert.equal(failures.length, 0, `${failures.length} failed:\n  ${failures.join('\n  ')}`);
console.log('vite-dev-barrel-scan-budget OK');
