// @serial
// @tier slow — drives a local workerd
// import() in code a Function constructor built resolves as Node resolves it:
// against the module that called the constructor. prettier's bin does
// exactly this (`new Function("module", "return import(module)")` and then
// "../internal/legacy-cli.mjs"), so `npx prettier` failed in every launch.
//
// The files run under the host's node first, and every launch must print
// what node printed:
//   IMPORT   a function built as the module loads;
//   LATER    one built later, from a callback;
//   BFROMA   one built by module B (written at runtime, so interpreted in the
//            first launch) when module A calls it: B is the importer;
//   VM       vm.compileFunction's code, which has no importer in Node;
//   ABSENT   an import nothing answers, named with its specifier and importer;
//   HOOKED   a program whose Error.prepareStackTrace cannot be read or set
//            still builds functions (bin/hooked.cjs).
// STAGED says where the code ran: the first launch interprets it, and the
// next runs it natively from the module the first staged, resolving against
// the same importer.
//
// The one deliberate difference from Node: code built by a constructor
// reached through a prototype (AsyncFunction here) is not its module's own
// `Function`, so it has no importer, and its import() is refused by name.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/fn-import';
const MAKER = [
  // Module B: builds the function for its caller.
  'module.exports = () => new Function("m", "return import(m)");',
].join('\n');
const FILES = {
  'pkg/package.json': '{"name":"pkg","version":"1.0.0"}',
  'pkg/lib/cli.mjs': 'export const where = "lib/cli.mjs";\n',
  'other/lib/cli.mjs': 'export const where = "other/lib/cli.mjs";\n',
  'pkg/bin/tool.cjs': [
    'const fs = require("fs");',
    'const path = require("path");',
    'const dynamicImport = new Function("module", "return import(module)");',
    'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;',
    // B is written as A runs, so the first launch interprets it.
    'const makerPath = path.join(__dirname, "../../other/bin/make.cjs");',
    'fs.mkdirSync(path.dirname(makerPath), { recursive: true });',
    `if (!fs.existsSync(makerPath)) fs.writeFileSync(makerPath, ${JSON.stringify(MAKER)});`,
    'const staged = new Function("m", "const native = new Error().stack.includes(\\"/gen/\\"); return import(m).then((x) => x.where + (native ? \\" native\\" : \\" interpreted\\"));");',
    'dynamicImport("../lib/cli.mjs")',
    '  .then((m) => console.log("IMPORT " + m.where))',
    '  .then(() => new Promise((r) => setTimeout(r, 1)))',
    '  .then(() => new Function("m", "return import(m)")("../lib/cli.mjs")).then((m) => console.log("LATER " + m.where))',
    '  .then(() => require(makerPath)()("../lib/cli.mjs")).then((m) => console.log("BFROMA " + m.where))',
    '  .then(() => require("vm").compileFunction("return import(\\"../lib/cli.mjs\\")")())',
    '  .then(() => console.log("VM resolved"), (e) => console.log("VM " + e.code))',
    '  .then(() => dynamicImport("./absent.mjs"))',
    '  .then(() => console.log("ABSENT resolved"), (e) => console.log("ABSENT " + e.code + " " + /absent\\.mjs/.test(e.message) + " " + /bin\\/tool\\.cjs/.test(e.message)))',
    '  .then(() => new AsyncFunction("m", "return (await import(m)).where")("../lib/cli.mjs"))',
    '  .then((where) => console.log("ASYNC " + where), (e) => console.log("ASYNC " + e.code))',
    '  .then(() => staged("../lib/cli.mjs")).then((line) => console.log("STAGED " + line));',
  ].join('\n'),
  'pkg/bin/hooked.cjs': [
    'Object.defineProperty(Error, "prepareStackTrace", {',
    '  configurable: true,',
    '  get() { throw new TypeError("a hook that cannot be read"); },',
    '  set() { throw new TypeError("a hook that cannot be set"); },',
    '});',
    'new Function("m", "return import(m)")("../lib/cli.mjs").then((m) => console.log("HOOKED " + m.where));',
  ].join('\n'),
};

// What the host's node prints for the same files.
const hostDir = mkdtempSync(join(tmpdir(), 'node-function-import-'));
let expected;
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(hostDir, name)), { recursive: true });
    writeFileSync(join(hostDir, name), text);
  }
  const host = spawnSync('node', [join(hostDir, 'pkg/bin/tool.cjs')], { encoding: 'utf8' });
  assert.equal(host.status, 0, host.stderr);
  const hooked = spawnSync('node', [join(hostDir, 'pkg/bin/hooked.cjs')], { encoding: 'utf8' });
  assert.equal(hooked.status, 0, hooked.stderr);
  expected = host.stdout + hooked.stdout;
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
assert.equal(expected, [
  'IMPORT lib/cli.mjs',
  'LATER lib/cli.mjs',
  'BFROMA other/lib/cli.mjs',
  'VM ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
  'ABSENT ERR_MODULE_NOT_FOUND true true',
  'ASYNC lib/cli.mjs',
  'STAGED lib/cli.mjs interpreted',
  'HOOKED lib/cli.mjs',
  '',
].join('\n'), 'the host node this test compares with');
const asNode = expected.trim().split('\n').filter((line) => !/^(ASYNC|STAGED) /.test(line));

console.log('node-function-import-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W}/pkg/bin ${W}/pkg/lib ${W}/other/lib && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);
    for (const [launch, where] of [['first', 'interpreted'], ['next', 'native']]) {
      const run = await terminal.run(`cd ${W} && node pkg/bin/tool.cjs && node pkg/bin/hooked.cjs`);
      assert.equal(run.status, 0, `${launch} launch: ${run.stdout}`);
      for (const line of asNode) {
        assert.ok(run.stdout.includes(line), `${launch} launch prints ${JSON.stringify(line)}:\n${run.stdout}`);
      }
      assert.ok(run.stdout.includes('ASYNC ERR_NIMBUS_IMPORT_NO_IMPORTER'), `${launch} launch refuses the prototype's constructor by name:\n${run.stdout}`);
      assert.ok(run.stdout.includes(`STAGED lib/cli.mjs ${where}`), `${launch} launch runs the code ${where}:\n${run.stdout}`);
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}

console.log('node-function-import-workerd: ok');
