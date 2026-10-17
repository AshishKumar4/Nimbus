// @serial
// @tier slow — drives a local workerd session through every program.
// `node -c` (--check) checks a CommonJS program's syntax and does not run
// it, as Node 22's check_syntax.js does:
//   - a script, a script with a shebang, TypeScript's own text, and stdin
//     (CommonJS whatever its syntax, Node's warning before its SyntaxError),
//     its preloads run first, and its refusals with -e;
//   - text that would close the CommonJS wrapper's function (and run what
//     follows it there) is the SyntaxError Node reports, and runs nothing.
// A shebang script's lines are its own, checked or run (one that throws on
// its third line). The SyntaxErrors are inside the source: one at its end is
// reported at the CommonJS cell's wrapper, by a run as by a check
// (ticket-commonjs-eof-syntax-errors). One fixture tree, on disk for host
// node and in a local workerd session for the shell's `node`
// (lib/node-differential.mjs): each run's stdout, stderr and exit code must
// be node's. What is refused where Node checks an ES module is
// node-check-module-refusals-workerd's.
//
// Red before: the hosted node ran every program -c named, its wrapper could
// be closed by the program's text, and a shebang script's lines were each
// one less than the file's.

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/chk';
const files = {
  'ok.js': 'console.log("ran");\n',
  'bad.js': 'const x = ;\nconsole.log("ran");\n',
  'shebang.js': '#!/usr/bin/env node\nconst x = ;\nconsole.log("ran");\n',
  'ok.ts': 'const a: number = 1;\nconsole.log("ran");\n',
  'pre.js': 'console.log("preloaded");\n',
  'throws.js': '#!/usr/bin/env node\n\nthrow new Error("on line three");\n',
  // Text that closes the wrapper's function, then calls console.log at the cell's top level.
  'close.cjs': '}; }); console.log("ran"); (0, function () { return function () {\n',
  'close-call.cjs': '}(), globalThis.console.log("ran"), function () {\n',
  // One that parses both as a function's statements and inside a function expression.
  'close-both.cjs': '} (console.log("ran")) && function () {\n',
  // One whose next token, in a declaration's place, would be a regular expression.
  'close-divide.cjs': '} / 0; return function () {\n',
  // What a function body may hold: new.target; what it may not: a wrapper name redeclared.
  'new-target.cjs': 'console.log(new.target);\n',
  'require-redeclared.cjs': 'const require = 1;\n',
  // Run, a name declared twice: V8 marks it by its first character.
  'redeclared.js': 'let alpha = 1;\nlet alpha = 2;\n',
  // TypeScript whose first error compiling it as CommonJS is not of module syntax: Node's SyntaxError.
  'typed-export.cts': 'const a: number = 1;\nexport {};\n',
};

await matchNodeInWorkerd('node-check-matches-node-workerd', ROOT, files, [
  'node -c ok.js',
  'node --check bad.js',
  'node -c shebang.js',
  'node -c ok.ts',
  'node -r ./pre.js -c ok.js',
  "echo 'console.log(\"ran\")' | node -c",
  "echo 'const x = ;' | node -c",
  "echo 'export const a = 1' | node -c",
  'node -c -e 1',
  'node throws.js',
  'node -c close.cjs',
  'node -c close-call.cjs',
  'node -c close-both.cjs',
  'node -c close-divide.cjs',
  'node -c new-target.cjs',
  'node -c require-redeclared.cjs',
  "echo 'const require = 1' | node -c",
  'node redeclared.js',
  'node -c typed-export.cts',
]);
