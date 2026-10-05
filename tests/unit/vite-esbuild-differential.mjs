#!/usr/bin/env bun
// The built-in Vite dev server against real Vite 5.4.21 and 6.4.3, on the
// projects of tests/reference/vite-esbuild-cases.mjs: create-vite's
// TypeScript templates and projects that each turn one setting Vite's
// esbuild plugin reads (the tsconfig tsconfck finds, vite.config's
// `esbuild`, @vitejs/plugin-react's and @preact/preset-vite's). What Vite
// made of each module is recorded by tests/reference/record-vite.mjs in
// tests/fixtures/vite-esbuild-reference.json; here, for each:
//
// - the case list and the fixture agree (names and what each case is made of);
// - tsconfck: runtime/tsconfck.ts finds and reads the same config, with
//   the same content, as tsconfck 3.1.6 did;
// - config.esbuild: what the server makes of vite.config and its plugins is
//   what Vite's resolveConfig made;
// - the module: what the server serves and what Vite's transform made,
//   each run (imports stubbed to record what they are called with), import
//   the same modules and make the same values; where Vite fails it, the
//   server serves the same error in its overlay.
//
// Where Vite 5 (esbuild 0.21) and Vite 6 (esbuild 0.25) differ for a
// module, the difference is printed with its case and the case says why
// (`versions`); the server must make Vite 6's. A `fallback` case, where the server keeps its own JSX
// defaults or cannot read vite.config statically, must differ from Vite,
// in the way the case names.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { parseTsconfig } from '../../packages/core/src/runtime/tsconfck.ts';
import { viteEsbuildSettings } from '../../packages/core/src/runtime/vite-esbuild-options.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { readViteConfigFile } from '../../packages/worker/src/facets/vite-config-file.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { CASES, caseDigest } from '../reference/vite-esbuild-cases.mjs';
import { oxcEngine } from './lib/oxc-engine.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/vite-esbuild-reference.json', import.meta.url), 'utf8'));
const ROOT = fixture.root.replace(/^\//, '');
const COLUMNS = ['vite5', 'vite6'];
const failures = [];
const fail = (message) => failures.push(message);

// ── The case list and the fixture agree ──────────────────────────────────
{
  const listed = Object.keys(CASES).sort();
  const recorded = Object.keys(fixture.cases).sort();
  assert.deepEqual(recorded, listed, 'every case is recorded and every recording is a case: run node tests/reference/record-vite.mjs');
  for (const [name, definition] of Object.entries(CASES)) {
    assert.equal(fixture.cases[name].digest, caseDigest(definition), `${name}: changed since it was recorded: run node tests/reference/record-vite.mjs`);
  }
  for (const column of COLUMNS) assert.ok(fixture.versions[column]?.vite && fixture.versions[column]?.esbuild, `${column}: versions recorded`);
  console.log(`  ok  ${listed.length} cases, recorded on Vite ${fixture.versions.vite5.vite} (esbuild ${fixture.versions.vite5.esbuild}) and ${fixture.versions.vite6.vite} (esbuild ${fixture.versions.vite6.esbuild})`);
}

// ── Running a module ────────────────────────────────────────────────────

const scratch = join(process.env.TMPDIR || tmpdir(), `vite-esbuild-differential-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const write = (path, content) => {
  mkdirSync(join(scratch, path, '..'), { recursive: true });
  writeFileSync(join(scratch, path), content);
};
// jsxDEV's sixth argument is the caller's \`this\`: at a module's top level
// the browser's is undefined, esbuild writes \`this\` and Oxc \`void 0\`; a
// non-object there is the same as none.
const runtime = (label) => `
const trim = (args) => {
  const out = [...args];
  if (out.length === 6 && (out[5] === null || typeof out[5] !== 'object')) out.pop();
  while (out.length && out[out.length - 1] === undefined) out.pop();
  return out;
};
exports.Fragment = Symbol.for(${JSON.stringify(`${label}.Fragment`)});
exports.jsx = (...args) => ({ call: ${JSON.stringify(`${label}.jsx`)}, args: trim(args) });
exports.jsxs = (...args) => ({ call: ${JSON.stringify(`${label}.jsxs`)}, args: trim(args) });
exports.jsxDEV = (...args) => ({ call: ${JSON.stringify(`${label}.jsxDEV`)}, args: trim(args) });
`;
const classic = (label, names) => names.map((name, i) => (i === 0
  ? `exports.${name} = (...args) => ({ call: ${JSON.stringify(`${label}.${name}`)}, args });\n`
  : `exports.${name} = Symbol.for(${JSON.stringify(`${label}.${name}`)});\n`)).join('');
for (const pkg of ['react', 'preact', '@emotion/react']) {
  write(`node_modules/${pkg}/package.json`, JSON.stringify({
    name: pkg, exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js', './jsx-dev-runtime': './jsx-dev-runtime.js' },
  }));
  write(`node_modules/${pkg}/index.js`, classic(pkg, ['createElement', 'Fragment']) + (pkg === 'preact' ? classic(pkg, ['h']) : '')
    + (pkg === 'react' ? 'exports.default = exports;\n' : ''));
  write(`node_modules/${pkg}/jsx-runtime.js`, runtime(`${pkg}/jsx-runtime`));
  write(`node_modules/${pkg}/jsx-dev-runtime.js`, runtime(`${pkg}/jsx-dev-runtime`));
}
write('node_modules/dep/package.json', JSON.stringify({ name: 'dep', exports: './index.js' }));
write('node_modules/dep/index.js', "exports.name = 'dep'; exports.used = 'used'; exports.unused = 'unused'; exports.other = 'other';\n");

/** A value as data: symbols and functions by name, so two runs compare. */
function label(value) {
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  if (Array.isArray(value)) return value.map(label);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, label(value[k])]));
}

/** The modules an output imports: each specifier with the names it takes. */
function importsOf(code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+(?:([^'"]*?)\s+from\s+)?["']([^"']+)["']/gm)) {
    const clause = m[1] ?? '';
    const names = [];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const part of named[1].split(',').map((x) => x.trim()).filter(Boolean)) names.push(part.split(/\s+as\s+/)[0]);
    if (/\*\s+as\s+/.test(clause)) names.push('*');
    if (/^\s*[\w$]+\s*(,|$)/.test(clause)) names.push('default');
    out.push(`${m[2]}: ${names.sort().join(' ')}`);
  }
  return out.sort();
}

let serial = 0;
/**
 * What running an output makes, beside the modules it imports (what it
 * loads is not: a stub runs once per process, whichever output is first).
 */
async function run(code) {
  const file = join(scratch, `out-${serial++}.mjs`);
  try {
    writeFileSync(file, code);
    const exports = { ...(await import(pathToFileURL(file).href)) };
    return { imports: importsOf(code), exports: label(exports) };
  } catch (error) {
    return { imports: importsOf(code), throws: `${error.constructor.name}: ${error.message}` };
  }
}

/** What Vite recorded for a module, as run. */
async function viteOutcome(recorded) {
  if (recorded.error) return { error: recorded.error };
  if (recorded.untransformed) return { untransformed: true };
  return run(recorded.code);
}

// ── The cases ────────────────────────────────────────────────────────────

const engine = new EsbuildService(undefined, { engine: async () => oxcEngine });
const versionDifferences = [];
let compared = 0;
try {
  for (const [name, definition] of Object.entries(CASES)) {
    const recorded = fixture.cases[name];
    // The project, at the root the fixture spells.
    const harness = createSqliteVfsTestHarness();
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const kernel = vfs.as(CRED_KERNEL);
    for (const [path, content] of Object.entries(definition.files)) {
      const at = `${ROOT}/${path}`;
      kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
      kernel.writeFile(at, new TextEncoder().encode(content), { mode: 0o644 });
    }

    // tsconfck: the same config, read the same.
    for (const path of definition.modules) {
      const expected = recorded.vite6.modules[path].tsconfck;
      assert.deepEqual(recorded.vite5.modules[path].tsconfck, expected, `${name} ${path}: tsconfck 3.1.6 read the same under both`);
      let ours;
      try {
        const { tsconfigFile, tsconfig } = parseTsconfig(`/${ROOT}/${path}`, {
          isFile: (p) => kernel.isFile(p),
          readFileString: (p) => kernel.readFileString(p),
        });
        ours = { tsconfigFile, tsconfig };
      } catch (error) {
        ours = { error: String(error.message) };
      }
      try {
        assert.deepEqual(ours, expected);
      } catch {
        fail(`${name} ${path}: tsconfck read\n      tsconfck: ${JSON.stringify(expected)}\n      ours:     ${JSON.stringify(ours)}`);
      }
    }

    // config.esbuild, as `vite` reads vite.config.
    const configFile = await readViteConfigFile(kernel, ROOT, async (source) => (await engine.transform(source, { loader: 'ts', format: 'esm' })).code);
    assert.equal(configFile.error, null, `${name}: vite.config read`);
    const settings = viteEsbuildSettings(configFile.path ? configFile.config : null);
    for (const column of COLUMNS) {
      const same = JSON.stringify(sorted(settings.esbuild)) === JSON.stringify(sorted(recorded[column].esbuild));
      if (!same && !definition.fallback) fail(`${name} [${column}]: config.esbuild\n      Vite: ${JSON.stringify(recorded[column].esbuild)}\n      ours: ${JSON.stringify(settings.esbuild)}`);
    }

    // Each module, served.
    const server = new ViteDevServer({
      vfs, cred: CRED_KERNEL, esbuild: engine, root: ROOT, basePath: '/preview', port: 5173, onHmrMessage() {},
      aliases: configFile.config.alias, define: configFile.config.define, injectBasename: false, viteEsbuild: settings,
    });
    try {
      for (const path of definition.modules) {
        const response = await server.handleRequest(new Request(`http://localhost/preview/${path}`), `/${path}`);
        // The dev server's own rewrite of bare imports, undone: what is compared is what the transform made of them.
        const served = (await response.text()).replaceAll('"/preview/@modules/', '"');
        const vite = {};
        for (const column of COLUMNS) vite[column] = await viteOutcome(recorded[column].modules[path]);
        // Where Vite fails the module, the server serves the error in its overlay.
        const ours = vite.vite6.error
          ? { error: served.includes('[nimbus-vite] Transform error') && served.includes(vite.vite6.error) ? vite.vite6.error : served.slice(0, 300) }
          : await run(served);
        const text = (value) => JSON.stringify(value);
        const versionsDiffer = text(vite.vite5) !== text(vite.vite6);
        if (versionsDiffer) {
          versionDifferences.push(`${name} ${path}: ${definition.versions ?? '(no reason given)'}\n      Vite 5 (esbuild ${fixture.versions.vite5.esbuild}): ${text(vite.vite5)}\n      Vite 6 (esbuild ${fixture.versions.vite6.esbuild}): ${text(vite.vite6)}`);
          if (!definition.versions) fail(`${name} ${path}: Vite 5 and Vite 6 differ, and the case does not say why (\`versions\`)`);
        }
        compared++;
        if (definition.fallback) {
          if (COLUMNS.some((column) => text(vite[column]) === text(ours))) {
            fail(`${name} ${path}: expected to differ from Vite (${definition.fallback}), but made the same: ${text(ours)}`);
          }
        } else if (text(vite.vite6) !== text(ours)) {
          fail(`${name} ${path}: served\n      Vite 6: ${text(vite.vite6)}\n      ours:   ${text(ours)}`);
        }
      }
    } finally {
      server.stop?.();
      if (definition.versions && !versionDifferences.some((difference) => difference.startsWith(`${name} `))) {
        fail(`${name}: says Vite 5 and Vite 6 differ (\`versions\`), and they do not`);
      }
    }
    console.log(`  ${failures.length === 0 ? 'ok ' : '...'} ${name}${definition.fallback ? ` (differs, as named: ${definition.fallback})` : ''}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
}

for (const difference of versionDifferences) console.log(`  Vite 5 and Vite 6 differ: ${difference}`);
assert.equal(failures.length, 0, `${failures.length} differences from Vite:\n  ${failures.join('\n  ')}`);
console.log(`vite-esbuild-differential OK: ${compared} modules in ${Object.keys(CASES).length} projects served as Vite 5 and 6 transform them; `
  + `${versionDifferences.length} where Vite 5 and 6 differ`);
