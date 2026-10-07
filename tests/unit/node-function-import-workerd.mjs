// @serial
// @tier slow — drives a local workerd
// import() in code a Function constructor built resolves as Node resolves it:
// against the module that called the constructor. prettier's bin does
// exactly this (`new Function("module", "return import(module)")` and then
// "../internal/legacy-cli.mjs"), so `npx prettier` failed in every launch:
// the first, which interprets the code, resolved against no URL ("Invalid
// URL string"), and the next, which compiles it natively from its staged
// `gen/` module, against that module ("Module not found:
// file:///bundle/internal/…").
//
// The same files run under the host's node first, and every launch must
// print what node printed. vm.compileFunction's code has no importer in
// Node, which says so (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), and so must
// the runtime. An import nothing answers names its specifier and importer.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/fn-import';
const FILES = {
  'pkg/package.json': '{"name":"pkg","version":"1.0.0"}',
  'pkg/lib/cli.mjs': 'export const where = "lib/cli.mjs";\n',
  // prettier's shape: built as the module loads, called at once.
  'pkg/bin/tool.cjs': [
    'const dynamicImport = new Function("module", "return import(module)");',
    'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;',
    'const later = () => new AsyncFunction("m", "return (await import(m)).where");',
    'dynamicImport("../lib/cli.mjs")',
    '  .then((m) => console.log("IMPORT " + m.where))',
    // Built later, from a callback: still the module that called the constructor.
    '  .then(() => new Promise((r) => setTimeout(r, 1)))',
    '  .then(() => later()("../lib/cli.mjs")).then((where) => console.log("LATER " + where))',
    '  .then(() => require("vm").compileFunction("return import(\\"../lib/cli.mjs\\")")())',
    '  .then(() => console.log("VM resolved"), (e) => console.log("VM " + e.code))',
    '  .then(() => dynamicImport("./absent.mjs"))',
    '  .then(() => console.log("ABSENT resolved"), (e) => console.log("ABSENT " + e.code + " " + /absent\\.mjs/.test(e.message) + " " + /bin\\/tool\\.cjs/.test(e.message)));',
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
  expected = host.stdout;
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
assert.equal(expected, [
  'IMPORT lib/cli.mjs',
  'LATER lib/cli.mjs',
  'VM ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
  'ABSENT ERR_MODULE_NOT_FOUND true true',
  '',
].join('\n'), 'the host node this test compares with');

console.log('node-function-import-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W}/pkg/bin ${W}/pkg/lib && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);
    // The first launch interprets the constructed code, the next runs it
    // natively from the module the first staged.
    for (const launch of ['first', 'next']) {
      const run = await terminal.run(`cd ${W} && node pkg/bin/tool.cjs`);
      assert.equal(run.status, 0, `${launch} launch: ${run.stdout}`);
      for (const line of expected.trim().split('\n')) {
        assert.ok(run.stdout.includes(line), `${launch} launch prints ${JSON.stringify(line)}:\n${run.stdout}`);
      }
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}

console.log('node-function-import-workerd: ok');
