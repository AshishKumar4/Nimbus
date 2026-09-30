#!/usr/bin/env bun
// Which programs read stdin synchronously, judged from their code: those get
// their whole piped stdin before they start (a synchronous read cannot wait
// for input that arrives later); every other program has it streamed, so one
// that ignores a pipe that never ends still runs and exits.

import assert from 'node:assert/strict';
import { programReadsStdinSync } from '../../packages/core/src/runtime/stdin-read.ts';

const ROOT = 'home/user/app';
const files = new Map([
  [`${ROOT}/package.json`, '{}'],
  [`${ROOT}/lib/input.js`, 'module.exports = () => require("fs").readFileSync(0, "utf8");'],
  [`${ROOT}/lib/helper.js`, 'module.exports = require("./input.js");'],
  [`${ROOT}/lib/async.js`, 'module.exports = async () => { let s = ""; for await (const c of process.stdin) s += c; return s; };'],
  ['home/user/node_modules/reader/index.js', 'module.exports = require("fs").readFileSync(0);'],
]);
const host = {
  async resolve(dir, specifier) {
    const parts = `${dir}/${specifier}`.split('/');
    const out = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part !== '.' && part !== '') out.push(part);
    }
    const key = out.join('/');
    return files.has(key) ? key : files.has(`${key}.js`) ? `${key}.js` : null;
  },
  async read(path) { return files.get(path) ?? null; },
};
const reads = (source, path = null) => programReadsStdinSync({ source, path, dir: ROOT, packageRoot: ROOT }, host);

const syncReads = [
  'require("fs").readFileSync(0, "utf8")',
  'const fs = require("fs"); JSON.parse(fs.readFileSync(0))',
  'const { readFileSync } = require("fs"); readFileSync(0)',
  'require("fs")["readFileSync"](0)',
  'require("fs").readFileSync(process.stdin.fd, "utf8")',
  'require("fs").readFileSync("/dev/stdin", "utf8")',
  'require("fs").readFileSync(`/proc/self/fd/0`)',
  'require("fs").readFileSync("/dev/fd/0")',
  'const b = Buffer.alloc(64); require("fs").readSync(0, b, 0, 64)',
  'require("fs").readSync(process.stdin.fd, Buffer.alloc(8))',
  // esbuild's CommonJS for `import { readFileSync } from "fs"`.
  'var import_fs = require("fs"); console.log((0, import_fs.readFileSync)(0, "utf8"));',
  'import { readFileSync } from "node:fs"; readFileSync(0);',
  // Only inside a function: still read whole, whether or not it runs.
  'function main() { return require("fs").readFileSync(0); } if (process.argv[2]) main();',
  // The program's own module it loads.
  'require("./lib/input.js")()',
  'import read from "./lib/input.js"; read();',
];
for (const source of syncReads) assert.equal(await reads(source), true, `reads stdin synchronously: ${source}`);

const streamed = [
  'console.log(1)',
  'process.stdin.on("data", (c) => console.log(String(c)))',
  '(async () => { for await (const c of process.stdin) console.log(String(c)); })()',
  'require("fs").readFileSync("0")',
  'require("fs").readFileSync("data.txt", "utf8")',
  'const fd = require("fs").openSync("x", "r"); require("fs").readSync(fd, Buffer.alloc(8))',
  'require("fs").readFile(0, () => {})',
  'require("./lib/async.js")()',
  // Two hops away, and outside the package: not followed.
  'require("./lib/helper.js")',
  'require("../node_modules/reader/index.js")',
  // Not JavaScript the parser reads.
  'this is not javascript (',
];
for (const source of streamed) assert.equal(await reads(source), false, `streams stdin: ${source}`);

console.log('stdin-read-analysis: synchronous stdin reads in a program and its own first-hop modules are recognised');
