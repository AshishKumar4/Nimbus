#!/usr/bin/env bun
// The lifo node resolves package.json "exports" and "imports" with the one
// resolver (_shared/exports-resolver.ts) the install pipeline, the bundler
// and the node shims share, under require's conditions (and `import` after
// them, since the lifo node requires what an ES module imports). Its loader
// had a resolver of its own, which knew no array fallbacks, no `node`
// condition, no null target blocking a subpath, no pattern with an
// extension, and no "imports" pattern. The same tree runs in Node 22 where
// it is installed, and both answer the same.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const FILES = {
  "lib/c.js": "module.exports = \"imports-require\";\n",
  "lib/u.js": "module.exports = \"imports-pattern\";\n",
  "main.js": "const tryReq = (id) => { try { return require(id); } catch (e) { return e.code || e.message; } };\nconsole.log([tryReq('arr'), tryReq('nodecond'), tryReq('blocked'), tryReq('blocked/open'), tryReq('blocked/private/secret') === 'secret' ? 'reached' : 'refused', tryReq('pat/features/x.js'), tryReq('#util/u'), tryReq('#cond')].join(' '));\n",
  "node_modules/arr/cjs.js": "module.exports = \"arr-cjs\";\n",
  "node_modules/arr/fallback.js": "module.exports = \"arr-fallback\";\n",
  "node_modules/arr/package.json": "{ \"name\": \"arr\", \"exports\": { \".\": [{ \"require\": \"./cjs.js\" }, \"./fallback.js\"] } }\n",
  "node_modules/blocked/index.js": "module.exports = \"blocked-root\";\n",
  "node_modules/blocked/open.js": "module.exports = \"open\";\n",
  "node_modules/blocked/package.json": "{ \"name\": \"blocked\", \"exports\": { \".\": \"./index.js\", \"./private/*\": null, \"./*\": \"./*.js\" } }\n",
  "node_modules/blocked/private/secret.js": "module.exports = \"secret\";\n",
  "node_modules/nodecond/default.js": "module.exports = \"default-condition\";\n",
  "node_modules/nodecond/node.js": "module.exports = \"node-condition\";\n",
  "node_modules/nodecond/package.json": "{ \"name\": \"nodecond\", \"exports\": { \"node\": \"./node.js\", \"default\": \"./default.js\" } }\n",
  "node_modules/pat/dist/feat/x.js": "module.exports = \"pattern-ext\";\n",
  "node_modules/pat/package.json": "{ \"name\": \"pat\", \"exports\": { \"./features/*.js\": \"./dist/feat/*.js\" } }\n",
  "package.json": "{ \"name\": \"app\", \"imports\": { \"#util/*\": \"./lib/*.js\", \"#cond\": { \"require\": \"./lib/c.js\", \"default\": \"./lib/d.js\" } } }\n",
};
const WANT = 'arr-cjs node-condition blocked-root open refused pattern-ext imports-pattern imports-require\n';

const node = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim();
const disk = mkdtempSync(join(tmpdir(), 'lifo-exports-'));
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(disk, name)), { recursive: true });
    writeFileSync(join(disk, name), text);
    await ws.fs.mkdir(dirname(`/home/user/rx/${name}`), { recursive: true });
    await ws.fs.writeFile(`/home/user/rx/${name}`, text);
  }
  if (node?.startsWith('v22')) assert.equal(spawnSync('node', ['main.js'], { cwd: disk, encoding: 'utf8' }).stdout, WANT, `Node ${node} agrees`);
  const ours = await ws.exec('cd /home/user/rx && node main.js');
  assert.equal(ours.stderr, '');
  assert.equal(ours.stdout, WANT);
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`lifo-exports-resolution: ok${node?.startsWith('v22') ? ` (Node ${node} agrees)` : ''}`);
