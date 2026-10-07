#!/usr/bin/env bun
/**
 * The JavaScript REPL (core runtime/js-repl.ts) against Node's own: the same
 * lines typed into `node -i` and into the REPL program print the same, while
 * the REPL runs where a Worker runs a program, under
 * `node --disallow-code-generation-from-strings` with the Function
 * constructors routed to the runtime-code interpreter built from core src.
 * Each line is compiled as the runtime-code service compiles one
 * (compileReplLine: interpreter/repl-line.ts's body, as an async function):
 * values and `_`, `undefined` for a statement, declarations that last to the
 * next line (let, const, class, and var and function as globals before the
 * line runs: in a block, a loop head, a pattern, a function reassigned), a
 * line continued where the parser ran out, top-level await, import() from
 * the working directory, require, thrown errors and `_error`, a rejection
 * and a timer's exception no one handles, the REPL's commands while a block
 * is pending.
 *
 * Each line is typed once the prompt before it is there and the output has
 * settled, as at a terminal: Node's REPL reads piped lines while an awaited
 * one is still running, and reports an unhandled rejection after its prompt.
 * Stack frames (Node prints them for an asynchronous error) are not compared.
 * Where Node's script semantics have no counterpart (a block's completion
 * value, a redeclared let), the REPL differs, and those lines are not here;
 * nor is a promise's value, which Node's REPL shows with its async ids.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINES = [
  '1 + 1',
  'let x = 40',
  'x + 2',
  'const y = await Promise.resolve(5)',
  'y * 2',
  'var z',
  'z',
  'var kept = 7; var kept',
  'kept',
  // A var is a global before its line runs, wherever it is declared.
  'if (false) { var hidden = 1 }',
  'hidden',
  'early; var early = 3',
  'early',
  'for (var i = 0; i < 3; i++) {}',
  'i',
  'for (var [k, v] of [[1, 2]]) {}',
  'k + v',
  'var { p: [deep] } = { p: [9] }',
  'deep',
  // A function declaration is the global itself, hoisted.
  'function f(a) { return a + x }',
  'f(1)',
  'function g() { return 1 }; g = () => 2',
  'g()',
  'let viaHoist = h(); function h() { return "hoisted" }',
  'viaHoist',
  "class C { m() { return 'm' } }",
  'new C().m()',
  '{ a: 1 }',
  'let {p2, q: [r]} = {p2: 1, q: [2]}',
  'p2 + r',
  // A line the parser ran out of is continued, as Node's isRecoverableError decides.
  'let [a1]',
  '= [1]',
  'a1',
  "await new Promise((resolve) => setTimeout(() => resolve('late'), 10))",
  'foo(',
  '1)',
  'undefinedVar',
  "throw new TypeError('boom')",
  '_error.message',
  "console.log('hi')",
  'this === globalThis',
  'typeof require',
  "require('fs').existsSync('.')",
  '[1, 2, 3].map((n) => n * 2)',
  '_',
  'let s = `multi',
  'line`',
  's',
  "if (true) { var inBlock = 'b' }",
  'inBlock',
  'x = x + 1',
  'x',
  // import() resolves as from the working directory's `repl`.
  "(await import('./dep.mjs')).v",
  // What no line awaits is reported, and the REPL goes on.
  'void Promise.reject(new Error("rejected"))',
  '1',
  'setTimeout(() => { throw new Error("timer") }, 10); 2',
  '3',
  '_error.message',
  '',
  // A command acts while a block is pending.
  '[',
  '.break',
  '{',
  '.clear',
  '.unknown',
];

/** A key typed without Enter (Ctrl-C), where a line is typed with it. */
const key = (raw) => ({ raw });

/**
 * `node <args>`'s stdout with `lines` typed into it, each once a prompt is
 * there and output has settled; then stdin ends. Typing stops if it exits.
 */
async function typed(args, cwd, lines = LINES) {
  const child = spawn('node', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let waiting = null;
  const prompted = () => /(?:^|\n)(?:> |\.\.\. )$/.test(stdout) || /(?:> |\.\.\. )$/.test(stdout);
  child.stdout.on('data', (d) => { stdout += d; if (waiting && prompted()) { const go = waiting; waiting = null; go(); } });
  child.stderr.on('data', (d) => { stderr += d; });
  let exited = false;
  const closed = new Promise((resolve) => child.on('close', (status) => { exited = true; if (waiting) waiting(); resolve(status); }));
  const settled = () => new Promise((resolve) => {
    let length = -1;
    const check = () => {
      if (exited || (stdout.length === length && prompted())) resolve();
      else { length = stdout.length; setTimeout(check, 60); }
    };
    check();
  });
  for (const line of lines) {
    if (!prompted() && !exited) await new Promise((resolve) => { waiting = resolve; });
    if (exited) break;
    const before = stdout.length;
    child.stdin.write(typeof line === 'string' ? line + '\n' : line.raw);
    // The prompt this line ends with comes after what it prints, and an
    // asynchronous error after that.
    await new Promise((resolve) => {
      const check = () => (exited || (stdout.length > before && prompted()) ? resolve() : setTimeout(check, 5));
      check();
    });
    await settled();
  }
  if (!exited) child.stdin.end();
  const status = await closed;
  assert.equal(status, 0, stderr);
  return stdout;
}

if (process.argv[2] !== '--repl') {
  const { buildInterpreterFiles } = await import('./lib/interpreter-build.mjs');
  const { jsReplProgram } = await import('../../packages/core/src/runtime/js-repl.ts');
  const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
  // What follows the banner, trailing whitespace dropped, without stack frames.
  const transcript = (stdout) => stdout.slice(stdout.indexOf('\n', stdout.indexOf('Type ".help"')) + 1)
    .split('\n').filter((line) => !/^\s+at /.test(line)).join('\n').trimEnd();
  try {
    writeFileSync(join(dir, 'dep.mjs'), 'export const v = 42;\n');
    const program = join(dir, 'repl.cjs');
    writeFileSync(program, jsReplProgram('Welcome.\nType ".help" for more information.\n'));
    const node = await typed(['-i'], dir);
    const repl = await typed(['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--repl', interpreterFile, opsFile, program], dir);
    assert.equal(transcript(repl), transcript(node), 'the REPL prints what node -i prints for the same lines');
    const replArgs = ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--repl', interpreterFile, opsFile, program];
    // The commands Node's has that this one has, while a block is pending:
    // .help prints and the block goes on, .exit leaves at once.
    const help = transcript(await typed(replArgs, dir, ['[', '.help', '1]', '[', '.exit', '1 + 1']));
    assert.match(help, /^> \.\.\. \.break {4}Sometimes you get stuck[^]*Ctrl\+D to exit the REPL\n\.\.\. \[ 1 \]\n> \.\.\.$/, JSON.stringify(help));
    // Ctrl-C, which the terminal hands the REPL as input: a pending block is
    // abandoned, an empty prompt warns, and a second in a row exits.
    const interrupted = transcript(await typed(replArgs, dir, ['let kept = 1', '[', key('\x03'), 'kept', key('\x03'), key('\x03')]));
    assert.equal(interrupted, '> undefined\n> ... > 1\n> (To exit, press Ctrl+C again or Ctrl+D or type .exit)\n>', JSON.stringify(interrupted));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`js-repl: ${LINES.length} lines print as node -i prints them, run under a Worker's code-generation refusal`);
} else {
  const [interpreterFile, opsFile, program] = process.argv.slice(3);
  const require = createRequire(import.meta.url);
  const { loadInterpreter } = await import('./lib/interpreter-load.mjs');
  const { ROUTE_FUNCTION_CONSTRUCTORS } = await import('./lib/interpreter-build.mjs');
  const interp = loadInterpreter(interpreterFile, opsFile, (_parent, specifier) => import(specifier));
  assert.throws(() => Function('return 1'), EvalError, 'the process refuses string code generation');
  interp.compileFunction('function', [], `return ${ROUTE_FUNCTION_CONSTRUCTORS};`)()(interp);
  const { replLineBody } = require(interpreterFile);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // The guest's import() (node-shims __nimbusDynamicImport), over this Node's.
  globalThis.__nimbusDynamicImport = (parentUrl, specifier, options) => import(new URL(String(specifier), parentUrl).href, options);
  // The runtime-code service's compileReplLine, without the launch's staging.
  globalThis.__nimbusRuntimeCode = {
    compileReplLine(code) {
      const body = replLineBody(String(code));
      return body === null ? null : new AsyncFunction(body);
    },
  };
  require(program);
}
