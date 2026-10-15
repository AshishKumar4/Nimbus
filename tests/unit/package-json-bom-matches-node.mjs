#!/usr/bin/env bun
// A package.json is parsed as Node's reader parses it: one leading UTF-8 byte
// order mark is skipped (src/node_modules.cc; simdjson skips one), and a
// second is not JSON, so the package is refused (ERR_INVALID_PACKAGE_CONFIG)
// by require and import alike. Every way a launch resolves agrees: over the
// supervisor bridge (requireFsOverBridge's readFileString, which the
// resolvers parse), and the walk that stages from the files' bytes. The
// bridge's text used to drop one mark before the parser dropped another, so
// a package two marks deep resolved there and was refused by the walk.
//
// One tree, on disk for real node and in a launch's filesystem; each
// package's resolution must be node's: the file, or a refusal.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  prefetchForRequire, requireFsOverBridge, resolveDeferredImport,
} from '../../packages/core/src/runtime/require-resolver.ts';
import { resolveRequireEx } from '../../packages/core/src/runtime/require-resolution.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const marked = (marks, text) => new Uint8Array([...Array.from({ length: marks }, () => [...BOM]).flat(), ...new TextEncoder().encode(text)]);
const PACKAGES = { none: 0, one: 1, two: 2 };
const files = { [`${APP}/package.json`]: new TextEncoder().encode('{"name":"app"}') };
for (const [name, marks] of Object.entries(PACKAGES)) {
  files[`${APP}/node_modules/${name}/package.json`] = marked(marks, JSON.stringify({ name, version: '1.0.0', main: 'lib.js', exports: { '.': { require: './lib.js', import: './lib.mjs' } } }));
  files[`${APP}/node_modules/${name}/lib.js`] = new TextEncoder().encode(`module.exports = '${name}';\n`);
  files[`${APP}/node_modules/${name}/lib.mjs`] = new TextEncoder().encode(`export default '${name}';\n`);
}

// ── real node: each package's resolution, a tree-relative path or a refusal ──
const ORACLE = `import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const r = createRequire(import.meta.url);
const answer = (resolve) => { try { return resolve(); } catch (error) { return { code: error.code }; } };
console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(PACKAGES))}.map((name) => [name, {
  require: answer(() => r.resolve(name)),
  import: answer(() => fileURLToPath(import.meta.resolve(name))),
}]))));
`;
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'package-json-bom-')));
let node;
try {
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, path)), { recursive: true });
    writeFileSync(join(disk, path), bytes);
  }
  writeFileSync(join(disk, APP, 'oracle.mjs'), ORACLE);
  const run = spawnSync('node', ['oracle.mjs'], { cwd: join(disk, APP), encoding: 'utf8' });
  assert.equal(run.status, 0, `node oracle.mjs: ${run.stderr}`);
  const relative_ = (answer) => (typeof answer === 'string' ? relative(disk, answer) : answer);
  node = Object.fromEntries(Object.entries(JSON.parse(run.stdout)).map(([name, { require, import: imported }]) =>
    [name, { require: relative_(require), import: relative_(imported) }]));
} finally {
  rmSync(disk, { recursive: true, force: true });
}
assert.equal(node.one.require, `${APP}/node_modules/one/lib.js`, 'premise: node skips one mark');
assert.deepEqual(node.two.require, { code: 'ERR_INVALID_PACKAGE_CONFIG' }, 'premise: node refuses a second');
assert.deepEqual(node.two.import, { code: 'ERR_INVALID_PACKAGE_CONFIG' }, 'premise: and so does its import');

// ── the launch's resolutions, as a path or a refusal (null) ──────────────
const refused = (answer) => (typeof answer === 'string' ? answer : null);
const failures = [];
for (const name of Object.keys(PACKAGES)) {
  const want = { require: refused(node[name].require), import: refused(node[name].import) };
  const bridge = requireFsOverBridge(launchFs(files).fs);
  const seen = {
    'bridge require': (await resolveRequireEx(bridge, name, APP))?.resolved ?? null,
    'bridge import': await resolveDeferredImport(bridge, { specifier: name, fromDir: APP, alternatives: 1 }),
  };
  // The walk stages what each resolution names, from the files' bytes.
  for (const [mode, entry] of [['require', `require('${name}');`], ['import', `import('${name}');`]]) {
    const walked = await prefetchForRequire(requireFsOverBridge(launchFs(files).fs), entry, `/${APP}`, `/${APP}/main.js`);
    const staged = [`${APP}/node_modules/${name}/lib.js`, `${APP}/node_modules/${name}/lib.mjs`].filter((path) => walked.bundle[path] !== undefined);
    seen[`walk ${mode}`] = staged[0] ?? null;
  }
  for (const [how, answer] of Object.entries(seen)) {
    const expected = how.endsWith('require') ? want.require : want.import;
    if (answer !== expected) failures.push(`${name} (${PACKAGES[name]} mark(s)), ${how}: ${answer} where node answers ${expected ?? 'a refusal'}`);
  }
}
assert.deepEqual(failures, [], 'every resolution of a package is node\'s');

console.log(`package-json-bom-matches-node: ${Object.keys(PACKAGES).length} packages resolve or are refused as node resolves them, over the bridge and in the walk`);
