#!/usr/bin/env bun
/**
 * The JavaScript REPL (core runtime/js-repl.ts) against Node's own: the same
 * lines typed into `node -i` and into the REPL program print the same, while
 * the REPL runs where a Worker runs a program, under
 * `node --disallow-code-generation-from-strings` with the Function
 * constructors routed to the runtime-code interpreter built from core src.
 * Each line is compiled as the runtime-code service compiles one
 * (compileReplLine: interpreter/repl-line.ts's body, as an async function):
 * values, `undefined` for a statement, declarations that last to the next
 * line (let, const, var, function, class, destructuring, a for's var),
 * top-level await, a continued line, require from the working directory,
 * thrown errors, the REPL's commands.
 *
 * Each line is typed once the prompt before it is there, as at a terminal:
 * Node's REPL reads piped lines while an awaited one is still running.
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
  'function f(a) { return a + x }',
  'f(1)',
  "class C { m() { return 'm' } }",
  'new C().m()',
  '{ a: 1 }',
  'for (var i = 0; i < 3; i++) {}',
  'i',
  'let {p, q: [r]} = {p: 1, q: [2]}',
  'p + r',
  "await new Promise((resolve) => setTimeout(() => resolve('late'), 10))",
  'foo(',
  '1)',
  'undefinedVar',
  "throw new TypeError('boom')",
  "console.log('hi')",
  'this === globalThis',
  'typeof require',
  "require('fs').existsSync('.')",
  '[1, 2, 3].map((n) => n * 2)',
  'let s = `multi',
  'line`',
  's',
  "if (true) { var inBlock = 'b' }",
  'inBlock',
  'x = x + 1',
  'x',
  '',
  '.break',
  '.unknown',
];

/** `node <args>`'s stdout with LINES typed into it, each once a prompt is there; then stdin ends. */
async function typed(args, cwd) {
  const child = spawn('node', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let waiting = null;
  const prompted = () => /(?:^|\n)(?:> |\.\.\. )$/.test(stdout) || /(?:> |\.\.\. )$/.test(stdout);
  child.stdout.on('data', (d) => { stdout += d; if (waiting && prompted()) { const go = waiting; waiting = null; go(); } });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  for (const line of LINES) {
    if (!prompted()) await new Promise((resolve) => { waiting = resolve; });
    const before = stdout.length;
    child.stdin.write(line + '\n');
    // The prompt this line ends with comes after what it prints.
    await new Promise((resolve) => {
      const check = () => (stdout.length > before && prompted() ? resolve() : setTimeout(check, 5));
      check();
    });
  }
  child.stdin.end();
  const status = await closed;
  assert.equal(status, 0, stderr);
  return stdout;
}

if (process.argv[2] !== '--repl') {
  const { buildInterpreterFiles } = await import('./lib/interpreter-build.mjs');
  const { jsReplProgram } = await import('../../packages/core/src/runtime/js-repl.ts');
  const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
  // What follows the banner, each prompt on its own, trailing whitespace dropped.
  const transcript = (stdout) => stdout.slice(stdout.indexOf('\n', stdout.indexOf('Type ".help"')) + 1).trimEnd();
  try {
    const program = join(dir, 'repl.cjs');
    writeFileSync(program, jsReplProgram('Welcome.\nType ".help" for more information.\n'));
    const node = await typed(['-i'], dir);
    const repl = await typed(['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--repl', interpreterFile, opsFile, program], dir);
    assert.equal(transcript(repl), transcript(node), 'the REPL prints what node -i prints for the same lines');
    // And the commands Node's has that this one has.
    const help = spawnSync('node', ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--repl', interpreterFile, opsFile, program], {
      input: '.help\n.exit\n1 + 1\n', encoding: 'utf8', cwd: dir,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /\.exit {5}Exit the REPL/);
    assert.doesNotMatch(help.stdout, /^> 2$/m, '.exit leaves before the next line');
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
  // The runtime-code service's compileReplLine, without the launch's staging.
  globalThis.__nimbusRuntimeCode = {
    compileReplLine(code) {
      const body = replLineBody(String(code));
      return body === null ? null : new AsyncFunction(body);
    },
  };
  require(program);
}
