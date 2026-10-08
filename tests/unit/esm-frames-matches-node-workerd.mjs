// @serial
// Stack frames and the fatal report's arrow, for ES modules small and large
// (the transform facet's lowering and the session's are one:
// async-module-lowering.ts lowerEsModule) and for CommonJS: an ES module's
// frame names its file: URL, a CommonJS module's its path, top-level code
// reads Node's way (`Object.<anonymous>`, or nothing in an ES module), and
// the line and column are the file's, past what the lowering adds on the
// first line, past a removed import, and past import.meta's binding; a
// program's own Error.prepareStackTrace is handed call sites so named.
// stdout and stderr are host Node's, with the program's frames kept and
// Node's own left out.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';
import { withoutInternalArrow } from './lib/node-report.mjs';

const W = '/home/user/frames';
const FILES = {
  'top.mjs': "const a = 1;\nthrow new Error('top ' + a);\n",
  'fn.mjs': "import { sep } from 'node:path';\nexport function fail(n) {\n  throw new RangeError('fn ' + n + sep);\n}\nfail(1);\n",
  'reject.mjs': "console.log('before');\nPromise.reject(new Error('rejected'));\n",
  'tla.mjs': "const v = await Promise.resolve(2);\nthrow new TypeError('after await ' + v);\n",
  'meta.mjs': "const u = import.meta.url;\nconst d = 2;\nthrow new Error('after meta ' + d + typeof u);\n",
  'line1.mjs': "import { sep } from 'node:path'; const s = 1; throw new Error('line one ' + s);\n",
  'big.mjs': `export function deep() {\n  throw new Error('big');\n}\nconst pad = "${'x'.repeat(600_000)}";\ndeep(pad);\n`,
  'cjs.cjs': "const a = 1;\nfunction f() { throw new Error('cjs ' + a); }\nf();\n",
  // Columns after what the lowering rewrites on a line: an import's use, import.meta, an anonymous default's head.
  'sameline.mjs': "import { sep, join } from 'node:path'; const u = import.meta.url; const s = join('a', 'b') + sep; throw new Error('same line ' + s.length + typeof u);\n",
  'anon.mjs': "export default function () { throw new Error('anonymous default'); }\n",
  'callanon.mjs': "import run from './anon.mjs'; import { sep } from 'node:path'\nconst x = sep\nrun()\n",
  // Node shows the line it compiled, not what the file holds when it throws.
  'overwrite.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL(import.meta.url), 'replaced\\nreplaced\\nreplaced\\n');\nthrow new Error('overwritten');\n",
  'lib.mjs': "export function make() { return new Error('lib'); }\nexport function fail() {\n  null.x;\n}\n",
  'caught.mjs': [
    "import * as lib from './lib.mjs';",
    "const frame = (e) => e.stack.split('\\n').slice(1, 3).map((line) => line.trim()).join(' | ');",
    "class C { m() { return new Error('method'); } }",
    'console.log(frame(new C().m()));',
    "const arrow = () => new Error('arrow');",
    'console.log(frame(arrow()));',
    'console.log(frame(lib.make()));',
    'try { lib.fail(); } catch (e) { console.log(frame(e)); }',
    "export default class Thing { static make() { return new Error('default'); } }",
    'console.log(frame(Thing.make()));',
    "console.log(new Error('top').stack.split('\\n')[1].trim());",
  ].join('\n') + '\n',
  'prepare.mjs': [
    "Error.prepareStackTrace = function () { return this === Error; };",
    "console.log(new Error('receiver').stack);",
    "Error.prepareStackTrace = (error, sites) => sites.slice(0, 1).map((site) => [site.getFileName(), site.getLineNumber(), site.getColumnNumber(), site.getFunctionName()].join(' ')).join();",
    "function named() { return new Error('third'); }",
    'console.log(named().stack);',
    'Error.prepareStackTrace = undefined;',
    "console.log(new Error('fourth').stack.split('\\n')[1].trim());",
  ].join('\n') + '\n',
};
const COMMANDS = [
  'node top.mjs', 'node fn.mjs', 'node reject.mjs', 'node tla.mjs', 'node meta.mjs', 'node line1.mjs', 'node big.mjs',
  'node cjs.cjs', 'node caught.mjs', 'node prepare.mjs', `node --input-type=module -e "const x = 1; throw new Error('eval ' + x);"`,
  'node sameline.mjs', 'node callanon.mjs', 'node overwrite.mjs', `node --input-type=module -e "process.chdir('/'); throw new Error('moved');"`,
];

const host = realpathSync(mkdtempSync(join(tmpdir(), 'esm-frames-')));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [name, text] of Object.entries(FILES)) writeFileSync(join(host, name), text);
// What a command printed, with the place it ran named W, and the program's frames alone.
const shown = (text, from) => text.split(from).join(W)
  .split('\n').filter((line) => !/^\s+at /.test(line) || line.includes(`${W}/`)).join('\n');
const run = (command) => `${command} > out.txt 2> err.txt; echo $? > code.txt`;
const read = `node -e "const fs = require('fs'); process.stdout.write(JSON.stringify({ out: fs.readFileSync('out.txt').toString('base64'), err: fs.readFileSync('err.txt').toString('base64'), code: fs.readFileSync('code.txt', 'utf8') }))"`;
const hostRead = (name) => spawnSync('cat', [name], { cwd: host, encoding: 'utf8' }).stdout;

console.log('esm-frames-matches-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    await session.run(`mkdir -p ${W}`, 30_000);
    for (const [name, text] of Object.entries(FILES)) await session.writeFile(`${W}/${name}`, text);
    for (const command of COMMANDS) {
      assert.equal(spawnSync('sh', ['-c', run(command)], { cwd: host, env: { PATH: process.env.PATH, HOME: host } }).status, 0);
      const want = { out: shown(hostRead('out.txt'), host), err: withoutInternalArrow(shown(hostRead('err.txt'), host)), code: hostRead('code.txt').trim() };
      await session.run(`cd ${W} && ${run(command)}`, 120_000);
      const r = await session.run(`cd ${W} && ${read}`, 60_000);
      const line = splitScenarioOutput(r.stdout).lines.find((l) => l.startsWith('{'));
      assert.ok(line, `${command}: read its output: ${r.stdout.slice(-1500)}`);
      const got = JSON.parse(line);
      const decode = (b64) => shown(Buffer.from(b64, 'base64').toString('utf8'), W);
      assert.equal(decode(got.out), want.out, `${command}: stdout is Node's`);
      assert.equal(decode(got.err), want.err, `${command}: stderr is Node's`);
      assert.equal(got.code.trim(), want.code, `${command}: exits as Node does`);
      console.log(`  ok  ${command.slice(0, 60)}: exit ${want.code}`);
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log(`esm-frames-matches-node-workerd: ${COMMANDS.length} programs' frames and arrows as Node's`);
