// Which require() calls of an ES module's top level staging may import
// instead (core runtime/esm-require-hoist.ts hoistableRequires): only those
// after statements that cannot observe the target's evaluation or be
// observed by it; and hasTopLevelAwait, which decides whether a require()
// refuses a graph. Their effect on a program is checked against Node in
// native-esm-matches-node-workerd.mjs (hoist/, req/tla-after.mjs).

import assert from 'node:assert/strict';
import { hasTopLevelAwait, hoistableRequires } from '../../packages/core/src/runtime/esm-require-hoist.ts';

const hoists = [
  // pi's bin, as published.
  ['#!/usr/bin/env node\nimport { createRequire, enableCompileCache } from "node:module";\n\nenableCompileCache();\ncreateRequire(import.meta.url)("./cli-runtime.js");\n', ['./cli-runtime.js']],
  ["import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst app = require('./a.js');\nrequire('./b.js');\n", ['./a.js', './b.js']],
  ["import m from 'node:module';\nm.enableCompileCache();\nm.createRequire(import.meta.url)('./a.js');\n", ['./a.js']],
  ["import * as m from 'node:module';\nimport './side.js';\nexport { x } from './x.js';\n'use strict';\nconst n = 1, s = 'a', t = `b`, u = -1;\nlet v;\nfunction f() {}\nclass C extends Base { static k = 1; m() { return f(); } }\n;\nexport const w = m.createRequire(import.meta.url)('./a.js');\n", ['./a.js']],
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
console.log(`esm-require-hoist: ${hoists.length + kept.length + 1} hoist cases, ${awaits.length} top-level await cases`);
