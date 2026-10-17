// @serial
// @tier slow — drives a local workerd session through every program.
// `node -c` (--check) checks a CommonJS program's syntax and does not run
// it, as Node 22's check_syntax.js does: a script, a script with a shebang,
// TypeScript's own text, and stdin (CommonJS whatever its syntax, Node's
// warning before its SyntaxError); its preloads run first. Its refusals
// with -e are Node's. One fixture tree, on disk for host node and in a
// local workerd session for the shell's `node` (lib/node-differential.mjs):
// each run's stdout, stderr and exit code must be node's.
//
// Red before: the hosted node ran every program -c named.

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/chk';
const files = {
  'ok.js': 'console.log("ran");\n',
  'bad.js': 'console.log("ran"\n',
  'shebang.js': '#!/usr/bin/env node\nconsole.log("ran"\n',
  'ok.ts': 'const a: number = 1;\nconsole.log("ran");\n',
  'pre.js': 'console.log("preloaded");\n',
};

await matchNodeInWorkerd('node-check-matches-node-workerd', ROOT, files, [
  'node -c ok.js',
  'node --check bad.js',
  'node -c shebang.js',
  'node -c ok.ts',
  'node -r ./pre.js -c ok.js',
  "echo 'console.log(\"ran\")' | node -c",
  "echo 'syntax(' | node -c",
  "echo 'export const a = 1' | node -c",
  'node -c -e 1',
]);
