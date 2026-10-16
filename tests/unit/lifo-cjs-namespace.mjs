#!/usr/bin/env bun
// import() of a CommonJS module answers Node's namespace: `default` is
// module.exports, and the other names are those Node detects statically,
// by cjs-module-lexer's rules, read off module.exports once it has run:
// `exports.a =`, `exports['c-d'] =`, `module.exports.b =`, a safe
// Object.defineProperty getter or value (an unsafe one opts its name out
// everywhere), a `module.exports = {...}` literal up to its first
// property that is not an identifier, and the names of what it reexports
// (`module.exports = require(...)`, `...require(...)` in the literal),
// followed through the loader. A name in a comment or a string is none, and
// a name detected but never set is undefined. The lifo node returned
// module.exports itself. One module's namespace is one object, however
// import() names it; the lifo node made a new one for each import(). The
// cases run in Node 22 where it is installed. (The loaders' lexer is the
// vendored cjs-module-lexer, checked by cjs-module-lexer-vendor.mjs.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const FILES = {
  "lib.cjs": "exports.a = 1;\nmodule.exports.b = 2;\nexports['c-d'] = 3;\nObject.defineProperty(exports, 'e', { enumerable: true, get: function () { return inner.e; } });\nObject.defineProperty(exports, 'unsafe', { get() { return 'computed'; } });\n// exports.inComment = 5;\nconst s = \"exports.inString = 6\";\nconst inner = { e: 4 };\nexports.default = 'own-default';\nif (false) exports.never = 8;\nexports.unsafe = 9;\n",
  "obj.cjs": "const x = 1, y = 2;\nmodule.exports = { x, why: y, ...require('./star.cjs'), 'q': 3 };\n",
  "star.cjs": "exports.fromStar = 's';\n",
  "re.cjs": "module.exports = require('./lib.cjs');\n",
  "main.mjs": "for (const file of ['./lib.cjs', './obj.cjs', './re.cjs', 'node:path']) {\n  const ns = await import(file);\n  const keys = Object.keys(ns).filter((k) => !(file === 'node:path' && !['default', 'join', 'sep'].includes(k)));\n  const values = keys.filter((k) => k !== 'default').map((k) => `${k}=${typeof ns[k] === 'function' ? 'fn' : JSON.stringify(ns[k])}`);\n  console.log(file, keys.join(','), values.join(' '), ns.default === (file === 'node:path' ? (await import('node:module')).createRequire(import.meta.url)(file) : undefined) || typeof ns.default, Object.prototype.toString.call(ns));\n}\nconst lib = await import('./lib.cjs');\nconsole.log('same', lib === await import('./lib.cjs'), lib === await import('../ns/lib.cjs'), (await import('path')) === (await import('node:path')));\n",
};
const WANT = [
  './lib.cjs a,b,c-d,default,e,never a=1 b=2 c-d=3 e=4 never=undefined object [object Module]',
  './obj.cjs default,fromStar,why,x fromStar="s" why=2 x=1 object [object Module]',
  './re.cjs a,b,c-d,default,e,never a=1 b=2 c-d=3 e=4 never=undefined object [object Module]',
  'node:path default,join,sep join=fn sep="/" true [object Module]',
  'same true true true',
  '',
].join('\n');

const node = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim();
const disk = mkdtempSync(join(tmpdir(), 'lifo-cjs-ns-'));
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(disk, 'ns'), { recursive: true });
    writeFileSync(join(disk, 'ns', name), text);
    await ws.fs.mkdir('/home/user/ns', { recursive: true });
    await ws.fs.writeFile(`/home/user/ns/${name}`, text);
  }
  if (node?.startsWith('v22')) assert.equal(spawnSync('node', ['main.mjs'], { cwd: join(disk, 'ns'), encoding: 'utf8' }).stdout, WANT, `Node ${node} agrees`);
  const ours = await ws.exec('cd /home/user/ns && node main.mjs');
  assert.equal(ours.stderr, '');
  assert.equal(ours.stdout, WANT);
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`lifo-cjs-namespace: CommonJS namespaces as Node's${node?.startsWith('v22') ? `; Node ${node} agrees` : ''}`);
