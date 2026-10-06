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
// module.exports itself. The cases run in Node 22 where it is installed;
// the scan (runtime/cjs-export-names.ts) is also checked against the real
// cjs-module-lexer, the worker's build-time dependency, over a corpus.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { scanCjsExports } from '../../packages/core/src/runtime/cjs-export-names.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const FILES = {
  "lib.cjs": "exports.a = 1;\nmodule.exports.b = 2;\nexports['c-d'] = 3;\nObject.defineProperty(exports, 'e', { enumerable: true, get: function () { return inner.e; } });\nObject.defineProperty(exports, 'unsafe', { get() { return 'computed'; } });\n// exports.inComment = 5;\nconst s = \"exports.inString = 6\";\nconst inner = { e: 4 };\nexports.default = 'own-default';\nif (false) exports.never = 8;\nexports.unsafe = 9;\n",
  "obj.cjs": "const x = 1, y = 2;\nmodule.exports = { x, why: y, ...require('./star.cjs'), 'q': 3 };\n",
  "star.cjs": "exports.fromStar = 's';\n",
  "re.cjs": "module.exports = require('./lib.cjs');\n",
  "main.mjs": "for (const file of ['./lib.cjs', './obj.cjs', './re.cjs', 'node:path']) {\n  const ns = await import(file);\n  const keys = Object.keys(ns).filter((k) => !(file === 'node:path' && !['default', 'join', 'sep'].includes(k)));\n  const values = keys.filter((k) => k !== 'default').map((k) => `${k}=${typeof ns[k] === 'function' ? 'fn' : JSON.stringify(ns[k])}`);\n  console.log(file, keys.join(','), values.join(' '), ns.default === (file === 'node:path' ? (await import('node:module')).createRequire(import.meta.url)(file) : undefined) || typeof ns.default, Object.prototype.toString.call(ns));\n}\n",
};
const WANT = [
  './lib.cjs a,b,c-d,default,e,never a=1 b=2 c-d=3 e=4 never=undefined object [object Module]',
  './obj.cjs default,fromStar,why,x fromStar="s" why=2 x=1 object [object Module]',
  './re.cjs a,b,c-d,default,e,never a=1 b=2 c-d=3 e=4 never=undefined object [object Module]',
  'node:path default,join,sep join=fn sep="/" true [object Module]',
  '',
].join('\n');

// The real lexer, as Node runs it: its pure-JS build (the package's `default` export).
const lexer = createRequire(join(import.meta.dir, '../../packages/worker/package.json'))('cjs-module-lexer');
const CORPUS = [
  ...Object.values(FILES).filter((text) => !text.includes('await import')),
  'exports.a = 1; exports . b = 2; exports.c == 3; exports.d += 4; foo.exports.e = 5; exports.default = 6;',
  "module.exports = { a, b: c, 'd': e, ...f, g: h() , i };",
  "module.exports = { a: b , c }; module.exports = require('./x'); module.exports = require('./y');",
  "Object.defineProperty(exports, 'a', { value: 1 }); Object.defineProperty(module.exports, 'b', { enumerable: true, get() { return q['p']; } });",
  "Object.defineProperty(exports, 'c', { enumerable: false, get () { return p; } }); Object.defineProperty(exports, 'd', { get: () => p }); exports.d = 1;",
  "Object.defineProperty(exports, '__esModule', { value: true }); __exportStar(require('./s'), exports); tslib.__export(require('./t')); function f() { __exportStar(require('./nested'), exports); }",
  'const t = `exports.inTemplate = ${ exports.inSubst = 1 }`; const r = /exports.inRegex = 1/; exports.after = 1;',
  "exports['quoted\\'s'] = 1; exports[\"dq\"] = 2; exports[name] = 3;",
];

const node = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim();
const disk = mkdtempSync(join(tmpdir(), 'lifo-cjs-ns-'));
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const source of CORPUS) {
    const real = lexer.parse(source);
    assert.deepEqual(scanCjsExports(source), { names: real.exports, reexports: real.reexports }, source);
  }
  for (const [name, text] of Object.entries(FILES)) {
    writeFileSync(join(disk, name), text);
    await ws.fs.mkdir('/home/user/ns', { recursive: true });
    await ws.fs.writeFile(`/home/user/ns/${name}`, text);
  }
  if (node?.startsWith('v22')) assert.equal(spawnSync('node', ['main.mjs'], { cwd: disk, encoding: 'utf8' }).stdout, WANT, `Node ${node} agrees`);
  const ours = await ws.exec('cd /home/user/ns && node main.mjs');
  assert.equal(ours.stderr, '');
  assert.equal(ours.stdout, WANT);
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`lifo-cjs-namespace: ${CORPUS.length} sources scan as cjs-module-lexer does${node?.startsWith('v22') ? `; Node ${node} agrees` : ''}`);
