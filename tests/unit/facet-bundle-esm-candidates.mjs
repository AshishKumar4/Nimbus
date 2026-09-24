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
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

class FakeVfs {
  get authority() { return { acquire: async () => ({ epoch: this.epoch, rev: this.revision() }), stat: async path => this.lstat(path) }; }

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

// Stands in for esbuild's CJS emit, as the transform host the session's
// esbuild uses: marks its output and drops the import statements, so the
// bundle shows which cells the pass actually reached.
const cjsEsbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code, options }) => {
    assert.equal(options.format, 'cjs');
    return { code: '/* cjs */\n' + code.replace(/^import .*$/gm, ''), map: '', warnings: [] };
  }),
});

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

// No cell is transformed in the session isolate. esbuild-wasm's heap starts at
// ~28 MiB, grows with every module and is never released, and a launch that
// transformed in-session carried it into the next step: `node -e 1` in the
// seed project cost the session 39 MiB it never got back, `npx nuxi init`
// took it from 36 to 151 MiB, and npm install then died of exceededMemory.
// With a transform host, everything esbuild must see goes in ONE round trip,
// and a large bundled cell whose shape allows it never reaches esbuild.
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
    new FakeVfs(largeFiles), `/${entry}`, 'home/user', largeFiles[entry], hosted,
  );
  assert.equal(calls.length, 1, 'the whole launch is one round trip to the host');
  assert.equal(calls[0].length, 4, 'the entry, the unsupported large cell, the small one and the broken one');
  assert.match(state.bundle[large], /Object\.defineProperty\(module\.exports, "payload"/,
    'the bounded rewrite needs no esbuild at all');
  for (const cell of [entry, unsupported, small]) assert.equal(state.bundle[cell], '/* hosted-cjs */\n', cell);
  assert.throws(() => new Function(state.bundle[broken])(), /esbuild transform failed for .*broken\.js: Unexpected ";"/,
    'a rejected module throws its reason when required, and costs the others nothing');

  // A host that fails is no verdict on any module: this launch gets
  // diagnostics, and the next one, with the host back, gets the emit.
  const downRoot = 'home/user/node_modules/down-esm';
  const downFiles = {
    'home/user/package.json': JSON.stringify({ name: 'down-test' }),
    [`${downRoot}/package.json`]: JSON.stringify({ name: 'down-esm', type: 'module' }),
    [`${downRoot}/cli.js`]: 'import "./dep.js";\n',
    [`${downRoot}/dep.js`]: 'export const dep = 2;\n',
  };
  const failing = new EsbuildService(undefined, {
    transformHost: async () => { throw new Error('transform facet unavailable'); },
  });
  const down = await buildPrefetchBundle(
    new FakeVfs(downFiles), `/${downRoot}/cli.js`, 'home/user', downFiles[`${downRoot}/cli.js`], failing,
  );
  assert.throws(() => new Function(down.bundle[`${downRoot}/dep.js`])(),
    /esbuild transform failed for .*dep\.js: transform facet unavailable/);
  const back = await buildPrefetchBundle(
    new FakeVfs(downFiles), `/${downRoot}/cli.js`, 'home/user', downFiles[`${downRoot}/cli.js`], hosted,
  );
  assert.equal(back.bundle[`${downRoot}/dep.js`], '/* hosted-cjs */\n', 'the host failure was not cached');
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
    new FakeVfs(prepassFiles), `/${root}/cli.js`, 'home/user', prepassFiles[`${root}/cli.js`], host,
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
