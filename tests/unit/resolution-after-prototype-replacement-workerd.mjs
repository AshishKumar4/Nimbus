// @serial
// @tier slow — drives a local workerd session
// A program's module loading after it replaced a built-in its loader could
// call: Node's loader holds what it uses from when it started (primordials),
// so a program that replaces String.prototype.charCodeAt, or makes
// Array.prototype.push throw, still imports and requires as it did. For each
// built-in below, replaced by one that throws (and charCodeAt also by one
// that answers each code unit XOR 1), the program imports an ES module two
// directories down, requires a CommonJS one, imports a package by its name
// (its exports' import condition) and resolves it with import.meta.resolve,
// and formats stacks (an error the staged module makes, its own, and the
// sites its own Error.prepareStackTrace is handed), then puts the built-in
// back and prints what each gave. Host node runs the
// same program (lib/node-differential.mjs): its output is the answer.
//
// Red before: the guest's resolver read String.prototype methods on every
// import (ticket-guest-resolver-prototypes); until loader primordials 4b, an
// import()'s fill of a file the launch did not hold (Array.prototype.push,
// String.prototype.split and replace, RegExp.prototype.exec, the array
// iterator), a missed module's read (Set.prototype.has) and the stack of an
// error it formats (the array iterator) still did: 7 of 71 refused.

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/prims';

/** [label, owner expression, key]: what the program replaces. */
const BUILTINS = [
  ...['charCodeAt', 'codePointAt', 'at', 'startsWith', 'endsWith', 'slice', 'substring', 'indexOf', 'lastIndexOf', 'includes',
    'split', 'replace', 'replaceAll', 'toLowerCase', 'toUpperCase', 'trim', 'padStart', 'normalize', 'match', 'search']
    .map((key) => [`String.prototype.${key}`, 'String.prototype', key]),
  ...['push', 'pop', 'shift', 'unshift', 'join', 'map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'indexOf',
    'includes', 'slice', 'splice', 'concat', 'reverse', 'sort', 'reduce', 'flat', 'flatMap', 'keys', 'values', 'entries', Symbol.iterator]
    .map((key) => [`Array.prototype.${String(key.description ?? key)}`, 'Array.prototype', key]),
  ...['exec', 'test', Symbol.replace, Symbol.split, Symbol.match].map((key) => [`RegExp.prototype.${String(key.description ?? key)}`, 'RegExp.prototype', key]),
  ...['get', 'set', 'has', 'delete'].map((key) => [`Map.prototype.${key}`, 'Map.prototype', key]),
  ...['add', 'has'].map((key) => [`Set.prototype.${key}`, 'Set.prototype', key]),
  ...['keys', 'entries', 'assign', 'freeze', 'getOwnPropertyNames', 'defineProperty'].map((key) => [`Object.${key}`, 'Object', key]),
  ['JSON.parse', 'JSON', 'parse'],
  ['JSON.stringify', 'JSON', 'stringify'],
  ...['decodeURIComponent', 'encodeURIComponent', 'decodeURI', 'encodeURI'].map((key) => [key, 'globalThis', key]),
];

const files = {};
const lines = [];
BUILTINS.forEach(([label, owner, key], n) => {
  files[`m${n}/main/esm/index.mjs`] = `export const v = 'e${n}';\nexport function probe() { return new Error('p').stack; }\n`;
  files[`m${n}/c.cjs`] = `exports.v = 'c${n}';\n`;
  files[`node_modules/pkg${n}/package.json`] = JSON.stringify({ name: `pkg${n}`, exports: { '.': { import: './esm/i.mjs', require: './cjs/i.cjs' } } });
  files[`node_modules/pkg${n}/esm/i.mjs`] = `export const v = 'p${n}';\n`;
  files[`node_modules/pkg${n}/cjs/i.cjs`] = `exports.v = 'r${n}';\n`;
  const keyText = typeof key === 'symbol' ? `Symbol.${key.description.slice('Symbol.'.length)}` : JSON.stringify(key);
  lines.push(`  [${JSON.stringify(label)}, ${owner}, ${keyText}, ${n}],`);
});
files['main.mjs'] = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cases = [
${lines.join('\n')}
];
const xor = [String.prototype, 'charCodeAt', (original) => function (i) { return original.call(this, i) ^ 1; }];
const thrower = () => function () { throw new Error('a replaced built-in was called'); };
const out = [];
async function attempt(label, owner, key, n, fake) {
  const original = owner[key];
  owner[key] = fake(original);
  let got;
  try {
    const esm = await import('./m' + n + '/main/esm/index.mjs');
    const cjs = require('./m' + n + '/c.cjs');
    const bare = await import('pkg' + n);
    const resolved = import.meta.resolve('pkg' + n);
    // Stacks formatted while the built-in is still replaced: a staged module's error, the program's own, and the sites a program's formatter is handed.
    const staged = esm.probe();
    const own = new Error('q').stack;
    Error.prepareStackTrace = (error, sites) => (Array.isArray(sites) && sites.length > 0 && typeof sites[0].getFileName === 'function' ? 'sites' : 'none');
    let formatted;
    try { formatted = new Error('r').stack; } finally { Error.prepareStackTrace = undefined; }
    owner[key] = original;
    got = [esm.v, cjs.v, bare.v, resolved.slice(resolved.indexOf('/node_modules/')), typeof staged, staged.startsWith('Error: p\\n'), typeof own, own.startsWith('Error: q\\n'), formatted].join(' ');
  } catch (error) {
    owner[key] = original;
    got = 'refused: ' + (error && error.code);
  }
  out.push(label + ': ' + got);
}
for (const [label, owner, key, n] of cases) await attempt(label, owner, key, n, thrower);
// charCodeAt answering each code unit XOR 1 (ticket-guest-resolver-prototypes), on a fresh tree of its own.
await attempt('String.prototype.charCodeAt (xor)', xor[0], xor[1], ${BUILTINS.length}, xor[2]);
console.log(out.join('\\n'));
`;
const n = BUILTINS.length;
files[`m${n}/main/esm/index.mjs`] = `export const v = 'e${n}';\nexport function probe() { return new Error('p').stack; }\n`;
files[`m${n}/c.cjs`] = `exports.v = 'c${n}';\n`;
files[`node_modules/pkg${n}/package.json`] = JSON.stringify({ name: `pkg${n}`, exports: { '.': { import: './esm/i.mjs', require: './cjs/i.cjs' } } });
files[`node_modules/pkg${n}/esm/i.mjs`] = `export const v = 'p${n}';\n`;
files[`node_modules/pkg${n}/cjs/i.cjs`] = `exports.v = 'r${n}';\n`;

await matchNodeInWorkerd('resolution-after-prototype-replacement-workerd', ROOT, files, ['node main.mjs']);
