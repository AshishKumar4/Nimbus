// @serial
// `node -p` and node's preloads in a session, as Node runs them (host Node
// the oracle, on the same files and command lines):
//   - `-p` is `-e` that prints the code's completion value with console.log
//     when the process exits: after its timers and its own 'exit' handlers,
//     not after process.exit(); `crypto` is
//     node:crypto in eval code; `-p` reads its code from stdin when it has
//     none; code with module syntax is refused (ERR_EVAL_ESM_CANNOT_PRINT);
//   - a syntax error is reported where Node's eval mode compiles: by default
//     before `--import`'s modules load, with --input-type=commonjs after,
//     and a module's (eval or file) after `-r`'s and `--import`'s;
//   - `-r`/`--require` modules are required from the working directory, in
//     order and once each, NODE_OPTIONS' first, before the program is
//     require.main; `--import` ones are imported after them; for a script, an
//     eval and a resident server alike; one that does not resolve fails the
//     run (the dotenv shape: `node -r envload/config app.js`).
// A launch with preloads is staged its own module map: `node main.cjs` runs
// first, then the same program with `-r`.
//
// The values printed are primitives: -p prints with the process's
// console.log, which formats an object or a function as JSON or its source
// (node-shims.ts __fmt), not as util.inspect does in Node. And no line sets
// process.exitCode, which a process that ends on its own does not exit with
// yet (`node -e 'process.exitCode = 3'` exits 0).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/pp';
const FILES = {
  'package.json': JSON.stringify({ name: 'pp', dependencies: { envload: '*' } }),
  'pre.cjs': "console.log('pre', require.main === undefined, process.argv.length); globalThis.PRE = (globalThis.PRE || 0) + 1;",
  // With module syntax: an ES module with only import.meta is not lowered yet (bundle-cell-transform.ts looksLikeEsm).
  'imp.mjs': "import { sep } from 'node:path'; console.log('imp', typeof import.meta.url, sep, globalThis.PRE);",
  'main.cjs': "console.log('main', require.main === module, globalThis.PRE ?? 0);",
  // An ES module that does not parse.
  'bad.mjs': 'return 1;\n',
  'data.json': JSON.stringify({ name: 'data' }),
  '.env': 'GREETING=hello\n',
  'env.cjs': "console.log('env', process.env.GREETING);",
  'server.cjs': "require('http').createServer().listen(0, function () { console.log('srv', globalThis.PRE); this.close(); });",
  'node_modules/envload/package.json': JSON.stringify({ name: 'envload', main: 'index.js' }),
  'node_modules/envload/index.js': "exports.load = () => { for (const line of require('fs').readFileSync('.env', 'utf8').split('\\n')) { const m = /^(\\w+)=(.*)$/.exec(line); if (m) process.env[m[1]] = m[2]; } };",
  'node_modules/envload/config.js': "require('./index.js').load();",
};

// Each prints what Node prints and exits as Node exits.
const COMMANDS = [
  'node -p 1+1',
  `node -p '"use strict"'`,
  `node -p "[1, { a: 'b' }, 'x'].length"`,
  `node -p 'var x = 5'`,
  `node -p 'x: while (true) { 7; break x }'`,
  `node -p 'typeof (function () {})'`,
  `node -p 'setTimeout(() => console.log("t")); 5'`,
  `node -p 'process.on("exit", () => console.log("exit-handler")); 6'`,
  `node -p 'process.exit(2); 4'`,
  `node -p 'console.log = (v) => process.stdout.write("custom " + v + "\\n"); 5'`,
  `node -p 'crypto.createHash("sha1").update("a").digest("hex")'`,
  `node -e 'console.log(typeof crypto.createHash, crypto === require("crypto"))'`,
  `node -pe 'process.argv.length' a b`,
  `node -p 'require("./data.json").name'`,
  `echo '1 + 2' | node -p`,
  'node main.cjs',
  'node -r ./pre.cjs main.cjs',
  'node -r ./pre.cjs -r ./pre.cjs main.cjs',
  'node --require=./pre.cjs -p PRE',
  'node --import ./imp.mjs -r ./pre.cjs main.cjs',
  `NODE_OPTIONS='-r ./pre.cjs' node main.cjs`,
  'node -r envload/config env.cjs',
  'node -r ./pre.cjs server.cjs',
];
// Node refuses these: its exit status, and the start of a line its output
// names (or a pattern the line matches). Which error a run ends on shows
// what ran first: a preload that does not resolve fails the run only if it
// is loaded before the code is compiled.
const MISSING_IMPORT = /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module '[^']*\/missing\.mjs' imported from /;
const REFUSED = [
  [`node -p 'import fs from "fs"; 1'`, 1, 'Error [ERR_EVAL_ESM_CANNOT_PRINT]: --print cannot be used with ESM input'],
  [`node -p 'return 1'`, 1, 'SyntaxError: Illegal return statement'],
  // Refused as it compiles: after -r's modules, before --import's load.
  [`node -r ./pre.cjs --import ./missing.mjs -p 'export default 1'`, 1, 'Error [ERR_EVAL_ESM_CANNOT_PRINT]: --print cannot be used with ESM input'],
  // By default Node compiles a script before --import's modules load
  // (evalTypeScript); --input-type=commonjs compiles it as it runs, after
  // (evalScript).
  [`node --import ./missing.mjs -p 'return 1'`, 1, 'SyntaxError: Illegal return statement'],
  [`node --input-type=commonjs --import ./missing.mjs -p 'return 1'`, 1, MISSING_IMPORT],
  // A module's syntax error is Node's as it evaluates the entry: after -r's
  // modules run and --import's load. (Its message is acorn's: the module is
  // parsed here, not by V8.)
  [`node --input-type=module -e 'return 1'`, 1, 'SyntaxError: '],
  [`node -r ./nope.cjs --input-type=module -e 'return 1'`, 1, "Error: Cannot find module './nope.cjs'"],
  [`node --input-type=module --import ./missing.mjs -e 'return 1'`, 1, MISSING_IMPORT],
  ['node bad.mjs', 1, 'SyntaxError: '],
  ['node -r ./nope.cjs bad.mjs', 1, "Error: Cannot find module './nope.cjs'"],
  ['node -r ./nope.cjs main.cjs', 1, "Error: Cannot find module './nope.cjs'"],
];

// Host Node on the same files.
const host = mkdtempSync(join(tmpdir(), 'node-print-preload-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [path, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(host, path)), { recursive: true });
  writeFileSync(join(host, path), text);
}
const hostRun = (command) => {
  const r = spawnSync('sh', ['-c', command], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: host } });
  return { status: r.status, lines: splitScenarioOutput(r.stdout + r.stderr).lines };
};

console.log('node-print-preload-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const made = await session.run(`mkdir -p ${W}/node_modules/envload`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    for (const [path, text] of Object.entries(FILES)) await session.writeFile(`${W}/${path}`, text);
    for (const command of COMMANDS) {
      const expected = hostRun(command);
      const r = await session.run(`cd ${W} && ${command}`, 120_000);
      const got = splitScenarioOutput(r.stdout).lines;
      assert.deepEqual({ status: r.status, lines: got }, expected, `${command} answers as Node: ${r.stdout.slice(-2500)}`);
      console.log(`  ok  ${command}: ${JSON.stringify(expected.lines).slice(0, 120)} (exit ${expected.status})`);
    }
    const names = (lines, line) => lines.some((got) => (line instanceof RegExp ? line.test(got) : got.startsWith(line)));
    for (const [command, status, line] of REFUSED) {
      const expected = hostRun(command);
      assert.equal(expected.status, status, `host: ${command}`);
      assert.ok(names(expected.lines, line), `host: ${command} names ${line}: ${expected.lines.join('\n')}`);
      const r = await session.run(`cd ${W} && ${command}`, 120_000);
      assert.equal(r.status, status, `${command}: exit ${r.status}: ${r.stdout.slice(-1500)}`);
      assert.ok(names(splitScenarioOutput(r.stdout).lines, line), `${command} names ${line}: ${r.stdout.slice(-1500)}`);
      console.log(`  ok  ${command}: ${line}`);
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-print-preload-workerd: -p prints, -r and --import preload, as Node does');
