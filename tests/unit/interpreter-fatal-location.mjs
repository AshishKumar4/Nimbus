#!/usr/bin/env bun
// fatalLocation: where the fatal report's arrow points (node-shims.ts
// __nimbusFatalArrow). Given the offset where an error was made, the
// innermost throw whose argument holds it, as V8 places a throw; given -1,
// the syntax error that stops the parse.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fatalLocation } from '../../packages/core/src/interpreter/index.ts';

const { parse } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('acorn');

const at = (text, marker) => {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, marker);
  return i;
};
const throwAt = (text, throwMarker, madeMarker, goal = 'script') => {
  const start = at(text, throwMarker);
  assert.deepEqual(fatalLocation(text, goal, at(text, madeMarker)), [start, start + 1], `${throwMarker} in ${JSON.stringify(text)}`);
};

throwAt("const a = 1;\nthrow new Error('x');\n", 'throw', 'new Error');
throwAt("function f() {\n  throw Object.assign(new TypeError('boom'), { code: 'E' });\n}\nf();\n", 'throw', 'new TypeError');
throwAt("throw (() => { throw new Error('in'); })();\n", "throw new Error('in')", "new Error('in')");
throwAt("export function f() { if (x) { throw new RangeError('r'); } }\n", 'throw', 'new RangeError', 'module');
// A throw after functions whose bodies were dropped.
throwAt("function a() { return [1, 2]; }\nconst b = () => { a(); };\nclass C { m() { throw new Error('m'); } }\n", 'throw', "new Error('m')");
// Made away from any throw (`throw e`), or at the keyword itself: none.
assert.equal(fatalLocation("const e = new Error('x');\nthrow e;\n", 'script', 10), null);
assert.equal(fatalLocation("throw new Error('x');\n", 'script', 0), null);
// CommonJS's goal takes a top-level return.
throwAt("if (x) return;\nthrow new Error('cjs');\n", 'throw', 'new Error');

// A syntax error at the token the parse stops at: where acorn's whole parse stops.
for (const [text, goal] of [['let x = ;\n', 'script'], ['function f() { return 1 +; }\n', 'script'], ['await 1;\n', 'script']]) {
  let error;
  try { parse(text, { ecmaVersion: 'latest', allowHashBang: true, sourceType: goal, allowReturnOutsideFunction: goal === 'script' }); } catch (e) { error = e; }
  assert.ok(error, `premise: ${JSON.stringify(text)} does not parse`);
  assert.deepEqual(fatalLocation(text, goal, -1), [error.pos, Math.max(error.raisedAt, error.pos + 1)], JSON.stringify(text));
}
assert.equal(fatalLocation('const ok = 1;\n', 'script', -1), null);
// Where acorn raises past the token, it is marked as V8 marks it: the token.
assert.deepEqual(fatalLocation('enum Color { Red, Green }\n', 'script', -1), [0, 4], 'a reserved word');
assert.deepEqual(fatalLocation('const a = 1;\nconst a = 2;\n', 'script', -1), [19, 20], 'a redeclared name');
assert.deepEqual(fatalLocation('export { nope };\n', 'module', -1), [9, 13], 'an undefined export');
// A missing initializer marks the binding, a name or a pattern; an unexpected token after a let does not.
for (const [text, mark] of [['const abc: number = 1;\n', 'abc'], ['const {a};\n', '{a}'], ['let [b];\n', '[b]'], ['const x y;\n', 'x'], ['const ok = 1, bad;\n', 'bad'], ['let x y;\n', 'y']]) {
  const at = text.indexOf(mark, text.indexOf(' '));
  assert.deepEqual(fatalLocation(text, 'script', -1), [at, at + mark.length], JSON.stringify(text));
}

// A multi-MiB bundle in a heap far smaller than acorn's whole tree of it
// (17 to 24 times its source): only the throw is kept.
const moduleUrl = new URL('../../packages/core/dist/interpreter/index.js', import.meta.url).href;
const stress = spawnSync('node', [
  '--max-old-space-size=64',
  '--input-type=module',
  '--eval',
  [
    `import { fatalLocation } from ${JSON.stringify(moduleUrl)};`,
    'let text = "(function () {\\n";',
    'for (let i = 0; text.length < 8 * 1048576; i++) text += "function f" + i + "(a) { if (a) { return [a, a + 1, { k: a, s: \'s\' }]; } }\\n";',
    'text += "function last() {\\n  throw new Error(\'deep\');\\n}\\n})();\\n";',
    'const start = text.indexOf("throw new Error(\'deep\')");',
    'const found = fatalLocation(text, "script", text.indexOf("new Error(\'deep\')"));',
    'if (found?.[0] !== start) process.exit(2);',
  ].join('\n'),
], { encoding: 'utf8', timeout: 60_000 });
assert.equal(stress.status, 0, `an 8 MiB module's throw within a 64 MiB heap: ${stress.error?.message ?? stress.stderr?.slice(-1200)}`);

console.log('interpreter-fatal-location: ok');
