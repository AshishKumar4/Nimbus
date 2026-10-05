#!/usr/bin/env node
// Record what real Vite's esbuild plugin makes of each project in
// tests/reference/vite-esbuild-cases.mjs, into
// tests/fixtures/vite-esbuild-reference.json, which
// tests/unit/vite-esbuild-differential.mjs compares the built-in Vite dev
// server with. Vite's output is no function of Nimbus's code, so it is
// recorded once rather than installed for every test run. Vite 7.3.6 is the
// reference the server is held to (it bundles tsconfck 3.1.6); Vite 5.4.21
// and 6.4.3 are recorded beside it, and each case where one differs says why.
//
//   node tests/reference/record-vite.mjs
//
// It installs the pinned packages (PINNED) with npm into a temporary
// directory outside the repository and its lockfile, one per Vite version;
// writes each project there; runs Vite's own resolveConfig on it (its
// vite.config, its plugins' config hooks) in serve mode; and runs the
// resolved `vite:esbuild` plugin's transform on each module, as the dev
// server does. Recorded per module: the code (the project root spelled as
// /home/user/app, the root the differential serves from), the warnings, and
// what tsconfck 3.1.6 parses for the module (the config file and its
// compiler options). The exact versions installed, esbuild's included, are
// recorded beside them. Needs network access to the npm registry.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES, caseDigest } from './vite-esbuild-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'fixtures', 'vite-esbuild-reference.json');
/** The Vite each column of the fixture is, and what it is resolved with. */
const PINNED = {
  vite5: { vite: '5.4.21', '@vitejs/plugin-react': '4.7.0', '@preact/preset-vite': '2.10.6', tsconfck: '3.1.6' },
  vite6: { vite: '6.4.3', '@vitejs/plugin-react': '4.7.0', '@preact/preset-vite': '2.10.6', tsconfck: '3.1.6' },
  vite7: { vite: '7.3.6', '@vitejs/plugin-react': '4.7.0', '@preact/preset-vite': '2.10.6', tsconfck: '3.1.6' },
};
/** Where the differential serves every project from. */
const ROOT = '/home/user/app';

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nimbus-vite-reference-'));
const fixture = { generator: 'tests/reference/record-vite.mjs', root: ROOT, versions: {}, cases: {} };
try {
  for (const [column, pins] of Object.entries(PINNED)) {
    const dir = join(work, column);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `reference-${column}`, private: true, type: 'module', dependencies: pins }, null, 2));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd: dir, stdio: 'inherit' });
    // A package.json as installed, read off disk (not every package exports it).
    const version = (name, from = dir) => {
      for (let at = from; ; at = dirname(at)) {
        try {
          return JSON.parse(readFileSync(join(at, 'node_modules', name, 'package.json'), 'utf8')).version;
        } catch {
          if (dirname(at) === at) throw new Error(`${column}: ${name} is not installed`);
        }
      }
    };
    fixture.versions[column] = {
      ...Object.fromEntries(Object.keys(pins).map((name) => [name, version(name)])),
      esbuild: version('esbuild', join(dir, 'node_modules', 'vite')),
      node: process.version,
    };
    for (const [name, pinned] of Object.entries(pins)) {
      if (fixture.versions[column][name] !== pinned) throw new Error(`${column}: ${name} installed ${fixture.versions[column][name]}, pinned ${pinned}`);
    }
    // Imported from the install, as its own ES modules resolve them.
    writeFileSync(join(dir, 'load.mjs'), "export * as vite from 'vite';\nexport * as tsconfck from 'tsconfck';\n");
    const { vite, tsconfck } = await import(pathToFileURL(join(dir, 'load.mjs')).href);

    let serial = 0;
    for (const [caseName, definition] of Object.entries(CASES)) {
      // Under the install, so a vite.config's imports of the plugins resolve there.
      const project = join(dir, 'p', String(serial++));
      for (const [path, content] of Object.entries(definition.files)) {
        mkdirSync(dirname(join(project, path)), { recursive: true });
        writeFileSync(join(project, path), content);
      }
      const spell = (value) => (typeof value === 'string' ? value.split(project).join(ROOT) : JSON.parse(JSON.stringify(value ?? null).split(project).join(ROOT)));
      const configFile = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].find((file) => file in definition.files);
      const entry = fixture.cases[caseName] ??= { digest: caseDigest(definition) };
      const config = await vite.resolveConfig(
        { root: project, configFile: configFile ? join(project, configFile) : false, logLevel: 'silent' },
        'serve',
        'development',
      );
      const plugin = config.plugins.find((p) => p.name === 'vite:esbuild');
      const modules = {};
      for (const path of definition.modules) {
        const id = join(project, path);
        const code = readFileSync(id, 'utf8');
        const warnings = [];
        let outcome;
        try {
          const result = plugin ? await plugin.transform.call({ warn: (message) => warnings.push(String(message)) }, code, id) : null;
          outcome = result ? { code: spell(result.code) } : { untransformed: true };
        } catch (error) {
          outcome = { error: spell(String(error?.message ?? error)) };
        }
        let parsed;
        try {
          const { tsconfigFile, tsconfig } = await tsconfck.parse(id);
          parsed = { tsconfigFile: tsconfigFile ? spell(tsconfigFile) : null, tsconfig: spell(tsconfig) };
        } catch (error) {
          parsed = { error: spell(String(error?.message ?? error)) };
        }
        modules[path] = { ...outcome, warnings: warnings.map(spell), tsconfck: parsed };
      }
      entry[column] = { esbuild: spell(config.esbuild), modules };
      console.log(`${column}: ${caseName}`);
    }
  }
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
