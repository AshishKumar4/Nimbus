// @serial
// A node program in a session runs under its command line's conditions, as
// Node runs it (host Node the oracle, on the same files): `--conditions`,
// `-C` and NODE_OPTIONS' choose its `#imports` and its packages' `exports`,
// for `import` and `require` alike, and process.execArgv and process.argv
// are Node's. Each command runs twice: the second launch is served the
// module map the first staged (keyed by the conditions), and must answer the
// same, so a map staged under one set of conditions never serves another.
// NODE_OPTIONS with an option Node does not allow there is refused as Node
// refuses it. And at the edges (the review of 38a267381):
//   - a package whose map has its entry only under `import`, nested under
//     conditions ({ import: { development, default } }), reached by a
//     static import the shims load through require, takes -C development;
//   - a package reached only by a computed require (the launch's
//     speculative root selection, not its walk) answers under -C
//     development on the first launch;
//   - fork passes the parent's execArgv to the child (an eval's -e left
//     out), or options.execArgv when given, as Node's fork does;
//   - two launches whose conditions differ only in how a list joins
//     (['a', 'b'] and ['a\u0001b']) are not served one module map.
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
    // The packages a computed require may reach: the launch's speculative roots.
    dependencies: { r: '*', s: '*' },
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
  'node_modules/q/package.json': JSON.stringify({ name: 'q', type: 'module', exports: { '.': { import: { development: './dev.js', default: './prod.js' } } } }),
  'node_modules/q/dev.js': 'export default "q-dev";',
  'node_modules/q/prod.js': 'export default "q-prod";',
  'node_modules/r/package.json': JSON.stringify({ name: 'r', exports: { development: './dev.cjs', default: './prod.cjs' } }),
  'node_modules/r/dev.cjs': 'module.exports = "r-dev";',
  'node_modules/r/prod.cjs': 'module.exports = "r-prod";',
  'node_modules/s/package.json': JSON.stringify({ name: 's', exports: { a: './a.cjs', default: './d.cjs' } }),
  'node_modules/s/a.cjs': 'module.exports = "s-a";',
  'node_modules/s/d.cjs': 'module.exports = "s-d";',
  'nested.mjs': "import q from 'q'; console.log('COND ' + JSON.stringify({ q }));",
  'computed.cjs': "const name = ['r'].join(''); console.log('COND ' + JSON.stringify({ r: require(name) }));",
  'joined.cjs': "const name = ['s'].join(''); console.log('COND ' + JSON.stringify({ s: require(name), conditions: process.execArgv }));",
  'joined-run.cjs': [
    "const { execFile } = require('child_process');",
    "execFile('node', ['-C', 'a\\u0001b', 'joined.cjs'], { encoding: 'utf8' }, (error, out) => process.stdout.write(error ? String(error) : out));",
  ].join('\n'),
  // The child says what it saw in a file (a fork's stdout is its IPC channel here), and the parent prints it.
  'fork-child.mjs': "import fs from 'node:fs'; import c from '#cond'; fs.writeFileSync('fork-out.json', JSON.stringify({ child: c, execArgv: process.execArgv })); process.exit(0);",
  'fork-parent.mjs': [
    "import { fork } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const opts = process.argv[2] === 'none' ? { execArgv: [] } : {};",
    "fork('./fork-child.mjs', [], opts).on('exit', () => { console.log('COND ' + fs.readFileSync('fork-out.json', 'utf8')); process.exit(0); });",
  ].join('\n'),
  'main.mjs': [
    "import c from '#cond';",
    "import p from 'p';",
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    "const dyn = await import('#cond');",
    "console.log('COND ' + JSON.stringify({ import: c, dynamic: dyn.default, require: require('#condc'), pImport: p, pRequire: require('p'), execArgv: process.execArgv, args: process.argv.slice(2) }));",
  ].join('\n'),
};

const FORK_EVAL = "require('child_process').fork('./fork-child.mjs').on('exit', () => { console.log('COND ' + require('fs').readFileSync('fork-out.json', 'utf8')); process.exit(0); })";
const COMMANDS = [
  'node -C development nested.mjs',
  'node nested.mjs',
  'node -C development computed.cjs',
  'node -C a -C b joined.cjs',
  'node joined-run.cjs',
  'node -C development fork-parent.mjs',
  'node -C development fork-parent.mjs none',
  `node -C development -e "${FORK_EVAL}"`,
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
    const made = await session.run(`mkdir -p ${['p', 'q', 'r', 's'].map((name) => `${W}/node_modules/${name}`).join(' ')}`, 30_000);
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
