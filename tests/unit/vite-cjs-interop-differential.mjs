#!/usr/bin/env bun
// The built-in Vite dev server's CommonJS interop against real Vite 7.3.6,
// recorded by tests/reference/record-vite-cjs-interop.mjs in
// tests/fixtures/vite-cjs-interop-reference.json. Real Vite pre-bundles a
// CJS dependency as `export default require_x()` and rewrites each named
// import of it to a read off that default (`mod["red"]`), so any key of
// module.exports is a named import. The built-in server cannot rewrite the
// importer; it gives the served bundle named exports instead
// (synthesizeCjsNamedExports), from the CJS scan's Vite policy. Held here:
// for real Vite's own served bundle, every key of its default that can be an
// ES name is a named export of what the built-in server makes of it, with
// the default's value. color-name's module.exports is an object literal of
// arrays, whose names Node's cjs-module-lexer policy does not detect. And for
// every shape a `module.exports = { ... }` literal's property takes, the
// policy names exactly the keys the module, run, puts on module.exports.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { scanCjsExports } from '../../packages/core/src/runtime/cjs-export-names.ts';
import { synthesizeCjsNamedExports } from '../../packages/worker/src/facets/vite-dev-server.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/vite-cjs-interop-reference.json', import.meta.url), 'utf8'));
assert.equal(fixture.versions.vite, '7.3.6');
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'super', 'switch', 'static', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);
const work = mkdtempSync(join(tmpdir(), 'vite-cjs-interop-'));
let checked = 0;
try {
  for (const [pkg, recorded] of Object.entries(fixture.packages)) {
    // Real Vite's contract, as recorded: interop, and a named import read off the default.
    assert.equal(recorded.needsInterop, true, pkg);
    assert.ok(recorded.interop.some((line) => line.includes(`["${recorded.namedImport}"]`)), `${pkg}: Vite reads ${recorded.namedImport} off the default`);
    const file = join(work, `${pkg}.mjs`);
    writeFileSync(file, synthesizeCjsNamedExports(recorded.served));
    const ours = await import(pathToFileURL(file).href);
    assert.deepEqual(Object.keys(ours.default), recorded.defaultKeys, `${pkg}: the default is module.exports`);
    const names = recorded.defaultKeys.filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED.has(key));
    const missing = names.filter((key) => !Object.hasOwn(ours, key));
    assert.deepEqual(missing, [], `${pkg}: every key of module.exports is a named export (${names.length - missing.length} of ${names.length})`);
    for (const key of names) assert.equal(ours[key], ours.default[key], `${pkg}: ${key} is the default's`);
    checked += names.length;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Each property shape, its value holding commas, brackets and braces at depth.
// What a scan cannot see comes from outside the module: a spread's source
// (`base`, a required module) and a computed key's value (`key`), whose
// names a literal's own keys are compared without. A required module is a
// reexport when the whole of it is spread: every key of it is on
// module.exports.
const MODULES = { './x': { fromX: 1, sub: { fromSub: 1 } }, './y': { fromY: 1, sub: { fromSub: 1 } } };
const UNSEEN = { base: { fromSpread: 1 }, key: 'computed', require: (id) => MODULES[id] };
const outside = (name) => ['fromSpread', 'fromX', 'fromY', 'sub', 'fromSub'].includes(name) || name.startsWith(UNSEEN.key);
const LITERALS = [
  'module.exports = { a: [1, 2], b: { c: 1, d: [3] }, e: (x, y) => ({ x, y }), f: `${[1, 2]},${{ g: 1 }.g}`, h: /[,}]/g };',
  'module.exports = { "aliceblue": [240, 248, 255], \'red\': [255, 0, 0], 3: "three", 0x10: 16 };',
  'module.exports = { m() { return { n: 1 }; }, get g() { return 1; }, set s(v) {}, async am() {}, *gen() {}, async *ag() {} };',
  'module.exports = { get: 1, set: 2, async: 3, static: 4, get() {}, async() {} };',
  'module.exports = { short, other, f: function (a, b) { return a, b; } }; var short = 1, other = 2;',
  'module.exports = { a: 1, b: 2, };',
  'module.exports = {};',
  'module.exports = { a: x ? { b: 1 } : [c, d], e: new Map([[1, 2]]) }; var x, c, d;',
  'module.exports = { [key]: 1, red: [255, 0, 0] };',
  'module.exports = { ...base, red: [255, 0, 0] };',
  'module.exports = { [[key][0]]: 1, [Symbol.toStringTag]: "Module", ...[base][0], green: [0, 128, 0], ...{ ...base }, blue: [0, 0, 255] };',
  'module.exports = { get [key]() { return 1; }, set [key](v) {}, async [key]() {}, *[Symbol.iterator]() {}, async *[key + 1]() {}, red: 1 };',
  'module.exports = { a: 1, ...require("./x"), b: 2 };',
  'module.exports = { ...require("./y").sub, d: 1 };',
  'module.exports = { [key]: 1, ...require("./x") };',
];
for (const source of LITERALS) {
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, ...UNSEEN });
  const scanned = scanCjsExports(source, 'vite');
  assert.deepEqual(new Set(scanned.names), new Set(Object.keys(module.exports).filter((name) => !outside(name))), source);
  const whole = Object.keys(MODULES).filter((id) => Object.keys(MODULES[id]).every((name) => Object.hasOwn(module.exports, name)));
  assert.deepEqual(scanned.reexports, whole, `${source}: reexports`);
}
console.log(`vite-cjs-interop-differential: ${checked} named imports serve as real Vite ${fixture.versions.vite} serves them; ${LITERALS.length} literal shapes name their keys`);
