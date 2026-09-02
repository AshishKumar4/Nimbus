#!/usr/bin/env bun
/**
 * The bundle's ESM→CJS pass must cover exactly what the facet compiles.
 *
 * A facet pre-compiles every bundle entry into a function at module-eval
 * time, because workerd blocks codegen from strings at request time. That
 * makes the two sets load-bearing: a file the pre-compile loop compiles but
 * the ESM→CJS pass skipped arrives at `new Function` as ESM source and dies
 * there, with nothing left that can recover it at request time.
 *
 * The loop takes extensionless entries — the shape of nearly every npm `bin`
 * script — so the transform has to take them too. The pass previously keyed
 * on `.js` / `.mjs` alone, which left exactly those files behind.
 */

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';

class FakeVfs {
  // The bundle is stamped with the cursor it was read at, so a stand-in
  // for the real VFS has to answer for one. A fake never mutates, so the
  // revision never moves.
  epoch = 'fake-vfs-epoch';
  revision() { return 0; }

  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const file of this.files.keys()) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }
  exists(p) { const s = p.replace(/^\/+/, ''); return this.files.has(s) || this.dirs.has(s); }
  isDirectory(p) { return this.dirs.has(p.replace(/^\/+/, '')); }
  readFile(p) { return new TextEncoder().encode(this.readFileString(p)); }
  readFileString(p) {
    const s = p.replace(/^\/+/, '');
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing file: ${s}`);
    return c;
  }
  readdir(p) {
    const s = p.replace(/^\/+/, '');
    const prefix = s ? `${s}/` : '';
    const entries = new Map();
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'directory');
    }
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'file');
    }
    return Array.from(entries, ([name, type]) => ({ name, type }));
  }
  lstat(p) {
    const s = p.replace(/^\/+/, '');
    if (this.dirs.has(s)) return { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing path: ${s}`);
    return { type: 'file', size: c.length, mode: 0o644, uid: 1000, gid: 1000 };
  }
  access(p) { if (!this.exists(p)) throw new Error(`missing path: ${p}`); }
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
  // walk pulls it in, and the transform must leave its bytes alone.
  [`${TS}/LICENSE`]: 'Apache License 2.0\n',
};

// Stands in for esbuild's CJS emit: marks its output and drops the import
// statements, so the bundle shows which cells the pass actually reached.
const cjsEsbuild = {
  async transform(code, opts) {
    assert.equal(opts.format, 'cjs');
    return { code: '/* cjs */\n' + code.replace(/^import .*$/gm, '') };
  },
};

const vfs = new FakeVfs(files);
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

// Sources at or above the transform isolation boundary must never initialize
// esbuild-wasm in the session supervisor. Pi 0.84.3 introduced a 3.7 MiB ESM
// chunk; transforming it beside the VFS snapshot exceeded the 128 MiB limit.
{
  const root = 'home/user/node_modules/large-esm';
  const entry = `${root}/cli.js`;
  const large = `${root}/large.js`;
  const largeFiles = {
    'home/user/package.json': JSON.stringify({ name: 'large-test' }),
    [`${root}/package.json`]: JSON.stringify({ name: 'large-esm', type: 'module' }),
    [entry]: 'import "./large.js";\n',
    [large]: `const payload = "${'x'.repeat(600_000)}";\nexport{payload};\n`,
  };
  let isolatedCalls = 0;
  const local = {
    async transform(code) {
      assert.ok(code.length < 512 * 1024, 'large source reached supervisor transform');
      return { code: '/* local-cjs */\n', map: '', warnings: [] };
    },
  };
  const isolated = async (code) => {
    isolatedCalls++;
    assert.ok(code.length >= 512 * 1024);
    return { code: '/* isolated-cjs */\n', map: '', warnings: [] };
  };
  const largeState = await buildPrefetchBundle(
    new FakeVfs(largeFiles), `/${entry}`, 'home/user', largeFiles[entry], local,
    undefined, undefined, undefined, isolated,
  );
  assert.equal(isolatedCalls, 0, 'bounded bundler rewrite should avoid esbuild entirely');
  assert.match(largeState.bundle[large], /Object\.defineProperty\(module\.exports, "payload"/);

  const unsupported = `${root}/unsupported.js`;
  const unsupportedFiles = {
    ...largeFiles,
    [entry]: 'import "./unsupported.js";\n',
    [unsupported]: `export function payload() { return "${'x'.repeat(600_000)}"; }\n`,
  };
  const unsupportedState = await buildPrefetchBundle(
    new FakeVfs(unsupportedFiles), `/${entry}`, 'home/user', unsupportedFiles[entry], local,
    undefined, undefined, undefined, isolated,
  );
  assert.equal(isolatedCalls, 1, 'unsupported large syntax should use the isolated transform worker');
  assert.equal(unsupportedState.bundle[unsupported], '/* isolated-cjs */\n');
}

console.log('facet-bundle-esm-candidates: ok');
