#!/usr/bin/env node
// Record what real Vite's dev server serves for CommonJS dependencies, into
// tests/fixtures/vite-cjs-interop-reference.json, which
// tests/unit/vite-cjs-interop-differential.mjs holds the built-in Vite dev
// server's CJS interop to. Vite's output is no function of Nimbus's code, so
// it is recorded once rather than installed for every test run.
//
//   node tests/reference/record-vite-cjs-interop.mjs
//
// It installs the pinned packages (PINNED) with npm into a temporary
// directory outside the repository and its lockfile; for each package,
// starts Vite 7.3.6's dev server (middleware mode) on a project whose
// main.js imports the package by name, a named import included, and
// records:
//   - what Vite serves for the pre-bundled dependency (esbuild's CommonJS
//     wrapped as `export default require_x()`), and whether its optimizer
//     marked it for interop;
//   - the interop lines Vite wrote into main.js (a named import read off the
//     default export: any key of module.exports works);
//   - the keys of the served module's default export, and its own named
//     exports, as Node imports the served module.
// Needs network access to the npm registry.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'fixtures', 'vite-cjs-interop-reference.json');
const PINNED = { vite: '7.3.6', 'color-name': '1.1.4', 'react-is': '18.3.1' };
/** Each package, and the named import its main.js makes. */
const PACKAGES = { 'color-name': 'red', 'react-is': 'isElement' };

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nimbus-vite-cjs-'));
const fixture = { generator: 'tests/reference/record-vite-cjs-interop.mjs', versions: {}, packages: {} };
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'reference-vite-cjs', private: true, type: 'module', dependencies: PINNED }, null, 2));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd: work, stdio: 'inherit' });
  const version = (name) => JSON.parse(readFileSync(join(work, 'node_modules', name, 'package.json'), 'utf8')).version;
  fixture.versions = { ...Object.fromEntries(Object.keys(PINNED).map((name) => [name, version(name)])), esbuild: JSON.parse(readFileSync(join(work, 'node_modules', 'esbuild', 'package.json'), 'utf8')).version, node: process.version };
  for (const [name, pinned] of Object.entries(PINNED)) {
    if (fixture.versions[name] !== pinned) throw new Error(`${name} installed ${fixture.versions[name]}, pinned ${pinned}`);
  }
  writeFileSync(join(work, 'load.mjs'), "export * as vite from 'vite';\n");
  const { vite } = await import(pathToFileURL(join(work, 'load.mjs')).href);

  for (const [pkg, named] of Object.entries(PACKAGES)) {
    const root = join(work, 'p', pkg);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'main.js'), `import value, { ${named} } from '${pkg}';\nconsole.log(value, ${named});\n`);
    const server = await vite.createServer({
      configFile: false,
      root,
      logLevel: 'error',
      appType: 'custom',
      cacheDir: join(root, '.vite'),
      server: { middlewareMode: true, hmr: false, ws: false },
      optimizeDeps: { include: [pkg], force: true },
      // Dependencies resolve from the install above the project.
      resolve: { preserveSymlinks: false },
    });
    try {
      const main = await server.transformRequest('/main.js');
      const depUrl = /from\s+"([^"]*\/\.vite\/deps\/[^"]+)"/.exec(main.code)?.[1];
      if (!depUrl) throw new Error(`${pkg}: main.js imports no pre-bundled dependency:\n${main.code}`);
      const dep = await server.transformRequest(depUrl);
      const optimized = server.environments?.client?.depsOptimizer?.metadata?.optimized?.[pkg];
      // The install's path, absolute or as esbuild's comments spell it (from the recorder's cwd), is spelled <work>.
      const served = dep.code.replace(/\n\/\/# sourceMappingURL=.*$/s, '\n').split(path.relative(process.cwd(), work)).join('<work>').split(work).join('<work>');
      if (/^\s*import\s/m.test(served)) throw new Error(`${pkg}: the served dependency imports a chunk; record it too`);
      const file = join(root, 'served.mjs');
      writeFileSync(file, served);
      const module = await import(pathToFileURL(file).href);
      fixture.packages[pkg] = {
        namedImport: named,
        needsInterop: optimized?.needsInterop ?? null,
        // The optimizer's browser hash varies with the install: spelled HASH.
        interop: main.code.split('\n').filter((line) => line.includes('__vite__cjsImport')).map((line) => line.replace(/\?v=[0-9a-f]+/g, '?v=HASH')),
        served,
        defaultKeys: Object.keys(module.default ?? {}),
        namedExports: Object.keys(module).filter((key) => key !== 'default'),
      };
    } finally {
      await server.close();
    }
  }
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`record-vite-cjs-interop: ${Object.keys(fixture.packages).length} packages into ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
