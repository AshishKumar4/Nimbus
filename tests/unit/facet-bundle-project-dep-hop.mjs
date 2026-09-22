#!/usr/bin/env bun
// facet-bundle-project-dep-hop — a CLI bin resolves its host framework's
// runtime peer from the PROJECT ROOT, and the snapshot has to hold it.
//
// The shape is `nuxt dev` on a real `nuxi init` project, measured on staging:
//
//   - the project declares `nuxt`; `nuxt` declares `@nuxt/cli` and `@nuxt/kit`
//   - `node_modules/.bin/nuxt` targets `@nuxt/cli/bin/nuxi.mjs`, because
//     `@nuxt/cli` declares a `nuxt` bin too, so THAT file is the facet's entry
//   - the CLI then calls `resolveModulePath("@nuxt/kit", { from: <rootDir> })`
//     — exsolve, synchronous `fs`, served from the startup snapshot
//   - `@nuxt/kit` is a devDependency of `@nuxt/cli` and a dependency of `nuxt`
//
// So the package that owns the entry never names the package the entry
// resolves, and the package that does name it — the project's own dependency
// — owns no staged file. The admission rule hopped one `dependencies` edge
// from every owner of a staged file, and separately admitted the project's
// own dependencies without hopping from them, so nothing reached
// `@nuxt/kit`: `readFileSync` of its package.json missed, exsolve's
// `_tryModuleResolve` swallowed the error, and the CLI reported
// `Cannot resolve module "@nuxt/kit" (from: /home/user/nuxt-probe/mvp/)`.
//
// The hop is now the same for both kinds of root, and the bound is unchanged
// in kind: one `dependencies` edge, never devDependencies, never a second hop
// — the two negative assertions below are what hold that line.

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';

class FakeVfs {
  get authority() { return { acquire: async () => ({ epoch: this.epoch, rev: this.revision() }), stat: async path => this.lstat(path) }; }

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
  stat(p) { return this.lstat(p); }
  lstat(p) {
    const s = p.replace(/^\/+/, '');
    if (this.dirs.has(s)) return { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing path: ${s}`);
    return { type: 'file', size: c.length, mode: 0o644, uid: 1000, gid: 1000 };
  }
  access(p) { if (!this.exists(p)) throw new Error(`missing path: ${p}`); }
}

const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const json = (o) => JSON.stringify(o, null, 2);

// X: the project's declared dependency. Ships a `tool` bin AND declares both
// the CLI and the kit — the `nuxt` role.
// Y: the CLI. Ships a `tool` bin of its own, which is the one `.bin/tool`
// ended up pointing at, and keeps the kit as a devDependency — `@nuxt/cli`.
// Z: the kit. Reachable only by name, at runtime, from the project root, and
// only through `exports` — no `main`, like `@nuxt/kit@4.5.2`.
const files = {
  [`${APP}/package.json`]: json({
    name: 'app',
    private: true,
    dependencies: { 'framework': '^1.0.0' },
    devDependencies: { 'unrelated-dev-tool': '^1.0.0' },
  }),
  // The materialized bin shim: the name the user typed, pointing at Y.
  [`${NM}/.bin/tool`]: `#!/usr/bin/env node\nrequire("/${NM}/framework-cli/bin/cli.mjs");\n`,

  [`${NM}/framework/package.json`]: json({
    name: 'framework',
    version: '1.0.0',
    bin: { tool: 'bin/tool.mjs' },
    exports: { '.': './dist/index.mjs' },
    dependencies: { 'framework-cli': '1.0.0', 'framework-kit': '1.0.0' },
  }),
  [`${NM}/framework/bin/tool.mjs`]: '#!/usr/bin/env node\nimport "framework-cli/cli";\n',
  [`${NM}/framework/dist/index.mjs`]: 'export const framework = true;\n',

  [`${NM}/framework-cli/package.json`]: json({
    name: 'framework-cli',
    version: '1.0.0',
    bin: { tool: 'bin/cli.mjs' },
    exports: { './cli': './dist/cli.mjs' },
    dependencies: { 'cli-helper': '1.0.0' },
    devDependencies: { 'framework-kit': '1.0.0', 'cli-dev-only': '1.0.0' },
  }),
  [`${NM}/framework-cli/bin/cli.mjs`]: '#!/usr/bin/env node\nimport "../dist/cli.mjs";\n',
  // The resolution is a runtime one: a specifier in a string, from the
  // project root. No static edge exists for the walker to follow.
  [`${NM}/framework-cli/dist/cli.mjs`]: [
    'import { resolveModulePath } from "cli-helper";',
    'const kit = await import(resolveModulePath("framework-kit", { from: process.cwd() }));',
    'export default kit;',
  ].join('\n') + '\n',
  [`${NM}/cli-helper/package.json`]: json({
    name: 'cli-helper', version: '1.0.0', main: 'index.js',
  }),
  [`${NM}/cli-helper/index.js`]: 'exports.resolveModulePath = () => "";\n',

  [`${NM}/framework-kit/package.json`]: json({
    name: 'framework-kit',
    version: '1.0.0',
    // exports only — the entry is unreachable through `main`, which is the
    // @nuxt/kit@4.5.2 shape.
    exports: { '.': './dist/index.mjs', './package.json': './package.json' },
    dependencies: { 'kit-only-dep': '1.0.0' },
  }),
  [`${NM}/framework-kit/dist/index.mjs`]: 'export const kit = true;\n',

  // Bound markers. Neither may be staged: one is a second `dependencies`
  // hop from the project, the other is a devDependency of a package in the
  // closure.
  [`${NM}/kit-only-dep/package.json`]: json({ name: 'kit-only-dep', version: '1.0.0', main: 'index.js' }),
  [`${NM}/kit-only-dep/index.js`]: 'module.exports = 1;\n',
  [`${NM}/cli-dev-only/package.json`]: json({ name: 'cli-dev-only', version: '1.0.0', main: 'index.js' }),
  [`${NM}/cli-dev-only/index.js`]: 'module.exports = 1;\n',
  [`${NM}/unrelated-dev-tool/package.json`]: json({ name: 'unrelated-dev-tool', version: '1.0.0', main: 'index.js' }),
  [`${NM}/unrelated-dev-tool/index.js`]: 'module.exports = 1;\n',
};

const entry = `${NM}/framework-cli/bin/cli.mjs`;
const state = await buildPrefetchBundle(new FakeVfs(files), `/${entry}`, APP, files[entry]);
const staged = (path) => path in state.bundle;

// Sanity: the entry and its own package arrived through the static closure.
assert.ok(staged(entry), 'entry bin must be staged');
assert.ok(staged(`${NM}/framework-cli/dist/cli.mjs`), "the CLI's dist must be staged");
assert.ok(staged(`${NM}/framework/package.json`), "the project's own dependency must be staged");

// The fix. A synchronous resolution from the project root can only be
// answered from the snapshot, so both cells the resolver reads have to be in
// it: the manifest it parses for `exports`, and the file that lands on.
assert.ok(
  staged(`${NM}/framework-kit/package.json`),
  'a dependency of the project\'s dependency must be staged: the CLI resolves it from the project root at runtime',
);
assert.ok(
  staged(`${NM}/framework-kit/dist/index.mjs`),
  'the `exports` target of that package must be staged too — resolution ends at a file that has to exist',
);

// The bound, in both directions it can fail.
assert.ok(
  !staged(`${NM}/kit-only-dep/package.json`),
  'a SECOND dependencies hop from the project must not be staged',
);
assert.ok(
  !staged(`${NM}/cli-dev-only/package.json`),
  'a devDependency of a package in the closure must not be staged',
);
assert.ok(
  !staged(`${NM}/unrelated-dev-tool/package.json`),
  "a devDependency of the project itself must not be staged",
);

console.log('facet-bundle-project-dep-hop: ok');
