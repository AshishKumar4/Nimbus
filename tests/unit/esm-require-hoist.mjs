// Which require() calls of an ES module's top level staging may import
// instead (core runtime/esm-require-hoist.ts hoistableRequires): only those
// after statements that cannot observe the target's evaluation or be
// observed by it; and hasTopLevelAwait, which decides whether a require()
// refuses a graph. Node is the oracle for the hoist's claim: a program runs
// as Node runs it when its hoisted targets are its last static imports, as
// staging links them (core runtime/native-esm.ts stageEsModule). The staged
// program itself is checked in native-esm-matches-node-workerd.mjs (hoist/,
// req/tla-after.mjs).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTopLevelAwait, hoistableRequires } from '../../packages/core/src/runtime/esm-require-hoist.ts';

const hoists = [
  // pi's bin, as published.
  ['#!/usr/bin/env node\nimport { createRequire, enableCompileCache } from "node:module";\n\nenableCompileCache();\ncreateRequire(import.meta.url)("./cli-runtime.js");\n', ['./cli-runtime.js']],
  ["import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst app = require('./a.js');\nrequire('./b.js');\n", ['./a.js', './b.js']],
  ["import m from 'node:module';\nm.enableCompileCache();\nm.createRequire(import.meta.url)('./a.js');\n", ['./a.js']],
  ["import * as m from 'node:module';\nimport './side.js';\nexport { x } from './x.js';\n'use strict';\nconst n = 1, s = 'a', t = `b`, u = -1;\nlet v;\nfunction f() {}\nclass C { static k = 1; m() { return f(); } }\n;\nexport const w = m.createRequire(import.meta.url)('./a.js');\n", ['./a.js']],
];
for (const [code, want] of hoists) assert.deepEqual(hoistableRequires(code), want, code);

const kept = [
  // Code that runs before the require, which the target could observe or be observed by.
  "import { createRequire } from 'node:module';\nconsole.log('before');\ncreateRequire(import.meta.url)('./a.js');\n",
  "import { createRequire } from 'node:module';\nconst t = Date.now();\ncreateRequire(import.meta.url)('./a.js');\n",
  "import { createRequire } from 'node:module';\nclass C { static x = f(); }\ncreateRequire(import.meta.url)('./a.js');\n",
  "import { createRequire } from 'node:module';\nclass C { static { g(); } }\ncreateRequire(import.meta.url)('./a.js');\n",
  "import { createRequire } from 'node:module';\nclass C extends make() {}\ncreateRequire(import.meta.url)('./a.js');\n",
  "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nr.resolve('./a.js');\nr('./b.js');\n",
  // A require that is not its statement's whole effect, or not of a literal, or not top level.
  "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./a.js').main();\n",
  "import { createRequire } from 'node:module';\nconst name = './a.js';\ncreateRequire(import.meta.url)(name);\n",
  "import { createRequire } from 'node:module';\ntry { createRequire(import.meta.url)('./a.js'); } catch {}\n",
  "import { createRequire } from 'node:module';\nif (ok) createRequire(import.meta.url)('./a.js');\n",
  // Not the module's createRequire.
  "function createRequire() { return () => {}; }\ncreateRequire(import.meta.url)('./a.js');\n",
  "import { createRequire } from 'node:module';\ncreateRequire('/x.js')('./a.js');\n",
  "import { createRequire } from 'not-node-module';\ncreateRequire(import.meta.url)('./a.js');\n",
  // A text that does not parse.
  "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./a.js'\n",
];
for (const code of kept) assert.deepEqual(hoistableRequires(code), [], code);
// The prefix ends at the first statement that is not quiet: requires after it stay at their calls.
assert.deepEqual(hoistableRequires("import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nr('./a.js');\nwork();\nr('./b.js');\n"), ['./a.js']);

// Programs whose targets print, so an order Node does not have shows: each
// runs under Node as written, and with its hoistable requires imported.
const head = "import { createRequire } from 'node:module';\n";
const aliased = head + 'const require = createRequire(import.meta.url);\n';
const app = "console.log('app');\n";
const programs = {
  // Hoisted, and as Node runs them.
  bin: { 'main.mjs': "#!/usr/bin/env node\nimport { createRequire, enableCompileCache } from 'node:module';\nenableCompileCache();\ncreateRequire(import.meta.url)('./app.mjs');\n", 'app.mjs': app },
  destructured: { 'main.mjs': aliased + "const { main } = require('./cli.mjs');\nmain();\n", 'cli.mjs': "console.log('cli');\nexport function main() { console.log('main'); }\n" },
  // A pattern runs code, or throws, where it is: a default, a computed key,
  // a getter (inherited, or of an export named 'module.exports'), an iterator, null.
  default: { 'main.mjs': aliased + "function bootstrap() { console.log('bootstrap'); }\nconst { setup = bootstrap() } = require('./settings.mjs');\nrequire('./app.mjs');\n", 'settings.mjs': "console.log('settings');\nexport const other = 1;\n", 'app.mjs': app },
  literalDefault: { 'main.mjs': head + "const { x = console.log('prefix') } = 0;\ncreateRequire(import.meta.url)('./app.mjs');\n", 'app.mjs': app },
  computedKey: { 'main.mjs': aliased + "const { [console.log('key')]: k } = require('./settings.mjs');\nrequire('./app.mjs');\n", 'settings.mjs': "console.log('settings');\n", 'app.mjs': app },
  inherited: { 'main.mjs': head + "const { tag } = 0;\ncreateRequire(import.meta.url)('./tag.mjs');\n", 'tag.mjs': "Object.defineProperty(Number.prototype, 'tag', { get() { console.log('getter'); } });\nconsole.log('tag');\n" },
  moduleExports: { 'main.mjs': aliased + "const { x } = require('./value.mjs');\nrequire('./app.mjs');\n", 'value.mjs': "const value = { get x() { console.log('getter'); } };\nexport { value as 'module.exports' };\n", 'app.mjs': app },
  iterator: { 'main.mjs': head + "const [c] = 'x';\ncreateRequire(import.meta.url)('./iter.mjs');\n", 'iter.mjs': "String.prototype[Symbol.iterator] = function* () { console.log('iterated'); };\nconsole.log('iter');\n" },
  nullish: { 'main.mjs': head + "const {} = null;\ncreateRequire(import.meta.url)('./app.mjs');\n", 'app.mjs': app },
  // A heritage throws: not a constructor, or a name in its TDZ.
  extendsUndefined: { 'main.mjs': head + "class C extends undefined {}\ncreateRequire(import.meta.url)('./app.mjs');\n", 'app.mjs': app },
  extendsUninitialized: { 'main.mjs': head + "class C extends Base {}\nclass Base {}\ncreateRequire(import.meta.url)('./app.mjs');\n", 'app.mjs': app },
};
const root = realpathSync(mkdtempSync(join(tmpdir(), 'esm-require-hoist-')));
let hoisting = 0;
try {
  const run = (dir, name) => {
    const r = spawnSync('node', [name], { cwd: dir, encoding: 'utf8' });
    return { out: r.stdout, err: r.stderr.replaceAll(name, 'main.mjs').replace(/^\(node:\d+\) /gm, '(node:PID) '), code: r.status };
  };
  for (const [name, files] of Object.entries(programs)) {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    const hoisted = hoistableRequires(files['main.mjs']);
    if (hoisted.length > 0) hoisting++;
    writeFileSync(join(dir, 'hoisted.mjs'), files['main.mjs'] + '\n;' + hoisted.map((specifier) => `import${JSON.stringify(specifier)};`).join(''));
    assert.deepEqual(run(dir, 'hoisted.mjs'), run(dir, 'main.mjs'), `${name}: hoisted ${JSON.stringify(hoisted)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const awaits = [
  ['await 1;', true],
  ['export const v = await f();', true],
  ['for await (const x of y) {}', true],
  ['const v = [(await 1), f(await 2)];', true],
  ['if (x) { await y; }', true],
  ['async function f() { await 1; }', false],
  ['const f = async () => { for await (const x of y); };', false],
  ['class C { async m() { await 1; } }', false],
  ['export const s = "await";', false],
  ['export const a = 1;', false],
  ['await (', false],
];
for (const [code, want] of awaits) assert.equal(hasTopLevelAwait(code), want, code);
console.log(`esm-require-hoist: ${hoists.length + kept.length + 1} hoist cases, ${Object.keys(programs).length} programs as Node runs them (${hoisting} hoisting), ${awaits.length} top-level await cases`);
