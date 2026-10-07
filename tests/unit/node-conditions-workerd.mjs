// @serial
// A node program in a session runs under its command line's conditions, as
// Node runs it (host Node the oracle, on the same files): `--conditions`,
// `-C` and NODE_OPTIONS' choose its `#imports` and its packages' `exports`,
// for `import` and `require` alike, and process.execArgv and process.argv
// are Node's. Each command runs twice: the second launch is served the
// module map the first staged (keyed by the conditions), and must answer the
// same, so a map staged under one set of conditions never serves another.
// NODE_OPTIONS with an option Node does not allow there is refused as Node
// refuses it.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/cond';
const FILES = {
  'package.json': JSON.stringify({
    name: 'cond-app', type: 'module',
    imports: {
      '#cond': { development: './t.js', default: './f.js' },
      '#condc': { development: './t.cjs', default: './f.cjs' },
    },
  }),
  't.js': 'export default "dev";',
  'f.js': 'export default "prod";',
  't.cjs': 'module.exports = "dev";',
  'f.cjs': 'module.exports = "prod";',
  'node_modules/p/package.json': JSON.stringify({ name: 'p', exports: { '.': { development: { import: './dev.mjs', require: './dev.cjs' }, import: './prod.mjs', require: './prod.cjs' } } }),
  'node_modules/p/dev.mjs': 'export default "p-dev";',
  'node_modules/p/prod.mjs': 'export default "p-prod";',
  'node_modules/p/dev.cjs': 'module.exports = "p-dev";',
  'node_modules/p/prod.cjs': 'module.exports = "p-prod";',
  'main.mjs': [
    "import c from '#cond';",
    "import p from 'p';",
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    "const dyn = await import('#cond');",
    "console.log('COND ' + JSON.stringify({ import: c, dynamic: dyn.default, require: require('#condc'), pImport: p, pRequire: require('p'), execArgv: process.execArgv, args: process.argv.slice(2) }));",
  ].join('\n'),
};

const COMMANDS = [
  'node main.mjs a',
  'node --conditions=development main.mjs a b',
  'node -C development main.mjs',
  'node --conditions development -- main.mjs --x',
  'NODE_OPTIONS=--conditions=development node main.mjs',
  'NODE_OPTIONS="-C development" node --no-warnings main.mjs',
];

// Host Node on the same files.
const host = mkdtempSync(join(tmpdir(), 'node-conditions-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [path, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(host, path)), { recursive: true });
  writeFileSync(join(host, path), text);
}
const hostRun = (command) => {
  const r = spawnSync('sh', ['-c', command], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: host } });
  return { status: r.status, out: (/^COND .*$/m.exec(r.stdout)?.[0] ?? '') || r.stderr.split('\n')[0] };
};

console.log('node-conditions-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const made = await session.run(`mkdir -p ${W}/node_modules/p`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    for (const [path, text] of Object.entries(FILES)) await session.writeFile(`${W}/${path}`, text);
    for (const command of COMMANDS) {
      const expected = hostRun(command);
      assert.equal(expected.status, 0, `host: ${command}: ${expected.out}`);
      for (const launch of ['first', 'staged']) {
        const r = await session.run(`cd ${W} && ${command}`, 120_000);
        const got = /^COND .*$/m.exec(r.stdout)?.[0];
        assert.equal(got, expected.out, `${command} (${launch} launch) answers as Node: ${r.stdout.slice(-2500)}`);
      }
      console.log(`  ok  ${command}: ${expected.out.slice(5, 120)}`);
    }
    // NODE_OPTIONS refused as Node refuses it.
    const refused = hostRun('NODE_OPTIONS=--eval=1 node main.mjs');
    assert.equal(refused.status, 9);
    const ours = await session.run(`cd ${W} && NODE_OPTIONS=--eval=1 node main.mjs`, 60_000);
    assert.equal(ours.status, 9, `exit ${ours.status}: ${ours.stdout}`);
    assert.ok(ours.stdout.includes(refused.out), `${ours.stdout} names ${refused.out}`);
    console.log(`  ok  ${refused.out}`);
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-conditions-workerd: --conditions, -C and NODE_OPTIONS choose imports and exports as Node, first launch and staged alike');
