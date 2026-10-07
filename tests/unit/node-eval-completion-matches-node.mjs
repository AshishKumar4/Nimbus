#!/usr/bin/env bun
// `node -p` prints its code's completion value, and the code Nimbus runs for
// it (core runtime/node-eval.ts) returns that value, as V8 computes it for a
// script: host Node the oracle, `node -p <code>` against the rewritten code
// run as an entry's body, for each kind of statement whose value V8's rewrite
// decides (the last value-producing statement; `undefined` before an `if`, a
// loop, a switch, a try or a `with` that may complete without one; values
// before a `break`/`continue`; a `finally` that keeps its entry value unless
// it breaks; labels; directives), and Node's `crypto` (node:crypto in eval
// code). Code Node refuses: module syntax (ERR_EVAL_ESM_CANNOT_PRINT), a
// top-level `return`, and a syntax error, which runs unchanged.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { nodeEvalCode, nodeStdinPrintCode } from '../../packages/core/src/runtime/node-eval.ts';

const SAMPLES = [
  '1+1', '"use strict"', '"use strict"; var x = 1', '"a"; "b"; var x', 'var x = 5', 'let y = 1; y', 'const z = 2',
  '1; if (false) 2;', '1; if (true) 2; else 3', 'if (0) {} else { 4 }', '1; if (true) {}', 'if (1) { 2 } else {}',
  '(function () {})', '(class {})', '() => 1', 'function f() {} f', 'class A {}', '1; class A {}', '1; function g() {}',
  'l: { 1; break l; }', 'l: { 1; break l; 2 }', 'x: while (true) { 7; break x }', '5; while (false);',
  '5; do { 6 } while (false)', 'for (var i = 0; i < 3; i++) i', 'for (var i = 0; i < 3; i++) { if (i == 1) continue; i * 10 }',
  'for (var i = 0; i < 3; i++) { i * 10; if (i == 1) continue; 4 }', 'for (const k in { a: 1, b: 2 }) k',
  'for (const v of [1, 2, 3]) { v; if (v == 2) break; 0 }', '9; for (const v of []) v',
  'switch (2) { case 1: "one"; case 2: "two"; case 3: "three"; break; default: "d" }', 'switch (9) { case 1: "one" }',
  '1; switch (1) { case 1: }', 'switch (1) { case 1: "a"; break; "b" }',
  'try { 1 } finally { 2 }', 'try { 1; throw 0 } catch (e) { 2 }', 'try { 1 } catch (e) { 2 }', '3; try { throw 0 } catch { }',
  '3; try { } finally { }', 'try { 1 } catch { 2 } finally { 3 }', 'try { throw 1 } catch { 2 } finally { 3 }',
  'while (true) { try { 1; break } finally { 2 } }', 'while (true) { try { 1 } finally { 2; break } }',
  'l: try { 1 } finally { 3; break l }', 'l: try { 1 } finally { if (true) { 3; break l } }',
  'do { try { 4 } catch { 5 } finally { 6; break } } while (true)',
  'with ({ a: 1 }) a', '1; with ({}) {}',
  '1, 2, 3', 'void 0', 'undefined', 'null', '[1, { a: "b" }]', 'new Map([[1, 2]])', '"a" + 1', '`t${1}`', 'Symbol("s")', '10n',
  'a: b: for (;;) { 9; break a }', 'a: for (;;) { b: for (;;) { 8; continue a } }', 'if (1) l: { 4; break l; }',
  '0; { }', '1; ;', 'debugger; 2', 'var r = 1; r += 1', '[1, 2].map((n) => n * 2)', 'x = 3\nx\n++x',
  'crypto.createHash("md5").update("").digest("hex")', 'typeof crypto.subtle', 'crypto === require("node:crypto")',
  'const __nimbus_print_result = 4; __nimbus_print_result + 1',
];
// Node refuses these: the line its stderr names, which the code throws too.
const REFUSED = [
  ['import fs from "fs"; 1', 'Error [ERR_EVAL_ESM_CANNOT_PRINT]: --print cannot be used with ESM input'],
  ['await 1', 'Error [ERR_EVAL_ESM_CANNOT_PRINT]: --print cannot be used with ESM input'],
  ['export const a = 1', 'Error [ERR_EVAL_ESM_CANNOT_PRINT]: --print cannot be used with ESM input'],
  ['return 1', 'SyntaxError: Illegal return statement'],
];

// The rewritten code, run by host Node as an entry's body: each value as
// console.log formats it, or the first line of what it throws, and what it logged.
const RUNNER = `
const { format } = require('node:util');
const codes = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(codes.map((code) => {
  const logged = [];
  const log = console.log;
  console.log = (...args) => { logged.push(format(...args) + '\\n'); };
  try {
    const value = new Function('exports', 'require', 'module', '__filename', '__dirname', code)({}, require, { exports: {} }, '[eval]', '.');
    return { printed: format(value) + '\\n', logged: logged.join('') };
  } catch (error) {
    return { thrown: String(error.stack).split('\\n')[0], logged: logged.join('') };
  } finally {
    console.log = log;
  }
})));
`;
const host = (args, input) => spawnSync('node', args, { encoding: 'utf8', input, env: { PATH: process.env.PATH } });
const runAll = (codes) => {
  const ran = host(['-e', RUNNER], JSON.stringify(codes));
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout);
};

const ours = runAll(SAMPLES.map((sample) => nodeEvalCode(sample, true)));
SAMPLES.forEach((sample, i) => {
  const said = host(['-p', sample]);
  assert.equal(said.status, 0, `node -p ${JSON.stringify(sample)}: ${said.stderr}`);
  assert.equal(ours[i].printed, said.stdout, `node -p ${JSON.stringify(sample)}, run as:\n${nodeEvalCode(sample, true)}\n${JSON.stringify(ours[i])}`);
});
console.log(`  ok  ${SAMPLES.length} completion values as node -p prints them`);

const refused = runAll(REFUSED.map(([sample]) => nodeEvalCode(sample, true)));
REFUSED.forEach(([sample, line], i) => {
  const said = host(['-p', sample]);
  assert.equal(said.status, 1, `node -p ${JSON.stringify(sample)} fails`);
  assert.ok(said.stderr.includes(line), `node -p ${JSON.stringify(sample)} says ${line}: ${said.stderr}`);
  assert.equal(refused[i].thrown, line, `${JSON.stringify(sample)}: ${JSON.stringify(refused[i])}`);
});
console.log(`  ok  ${REFUSED.length} refused as Node refuses them`);

// A syntax error is left to fail as it does in Node.
assert.equal(nodeEvalCode('1 +', true), '1 +');
// -e: code that names crypto has node:crypto, as Node's eval does.
const EVALS = ['console.log(typeof crypto.createHash, crypto === require("node:crypto"))', 'console.log(typeof globalThis.crypto.subtle, 1)'];
const evaluated = runAll(EVALS.map((sample) => nodeEvalCode(sample, false)));
EVALS.forEach((sample, i) => assert.equal(evaluated[i].logged, host(['-e', sample]).stdout, `node -e ${JSON.stringify(sample)}`));
// From stdin: Node's eval_stdin, with no crypto wrapper.
const [fromStdin] = runAll([nodeStdinPrintCode('2 * 21')]);
assert.equal(fromStdin.printed, host(['-p'], '2 * 21').stdout);
console.log('  ok  -e keeps crypto node:crypto; -p from stdin');

console.log('node-eval-completion-matches-node: -p prints the completion value V8 gives a script');
