// @serial
// @tier slow — drives a local workerd session through every program.
// `node -c` (--check) checks a CommonJS program's syntax and does not run
// it, as Node 22's check_syntax.js does: a script, a script with a shebang,
// TypeScript's own text, and stdin (CommonJS whatever its syntax, Node's
// warning before its SyntaxError); its preloads run first. Its refusals
// with -e are Node's. The SyntaxErrors are inside the source: one at its end
// is reported at the CommonJS cell's wrapper, by a run as by a check
// (ticket-commonjs-eof-syntax-errors). A shebang script's lines are its
// own, checked or run (one that throws on its third line). One fixture tree, on disk for host node and in a
// local workerd session for the shell's `node` (lib/node-differential.mjs):
// each run's stdout, stderr and exit code must be node's.
//
// Red before: the hosted node ran every program -c named, and a shebang
// script's lines were each one less than the file's.

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/chk';
const files = {
  'ok.js': 'console.log("ran");\n',
  'bad.js': 'const x = ;\nconsole.log("ran");\n',
  'shebang.js': '#!/usr/bin/env node\nconst x = ;\nconsole.log("ran");\n',
  'ok.ts': 'const a: number = 1;\nconsole.log("ran");\n',
  'pre.js': 'console.log("preloaded");\n',
  'throws.js': '#!/usr/bin/env node\n\nthrow new Error("on line three");\n',
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
]);
