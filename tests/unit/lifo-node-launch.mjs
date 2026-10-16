#!/usr/bin/env bun
// The portable `node` prepares its program as the hosted node does (audit
// RTM-12): Node's reading of its command line (runtime/node-cli.ts), NODE_OPTIONS
// first, and the script found as runtime/script-path.ts finds it. Host Node
// running the same files is the oracle:
//   - `node .` runs its package's main, and `node start` its start.js;
//   - an option before the script (`--trace-warnings start.js`) is an option;
//   - `--conditions`, `-C` and NODE_OPTIONS='--conditions=…' pick a package's
//     conditional export, for require and import alike.
// And what this node does not run (`-p`, `-r`, `-c`,
// `--experimental-default-type`) is refused before any of it runs, exit 9,
// rather than ignored.
//
// Red before: the command read only a first-position -v, --help or -e;
// `node .` read the directory, `--trace-warnings` was taken for the script,
// and conditions reached neither resolver.
// Run by bun, the test checks the source under Bun, then runs itself under
// node against the built package (packages/core/dist: rebuild first).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

const FILES = {
  'package.json': '{"name":"app","main":"start.js"}',
  'start.js': "console.log('start ' + process.argv.slice(2).join(' '));\n",
  'node_modules/cpkg/package.json': '{"name":"cpkg","exports":{"development":"./dev.js","default":"./prod.js"}}',
  'node_modules/cpkg/dev.js': "module.exports = 'dev';\n",
  'node_modules/cpkg/prod.js': "module.exports = 'prod';\n",
  'cond.mjs': "import d from 'cpkg';\nimport { createRequire } from 'node:module';\nconsole.log(JSON.stringify([d, createRequire(import.meta.url)('cpkg')]));\n",
};
// Each: the arguments, and NODE_OPTIONS (or none).
const RUNS = [
  [['.'], undefined],
  [['start', 'a', 'b'], undefined],
  [['--trace-warnings', 'start.js', 'c'], undefined],
  [['cond.mjs'], undefined],
  [['--conditions=development', 'cond.mjs'], undefined],
  [['-C', 'development', 'cond.mjs'], undefined],
  [['cond.mjs'], '--conditions=development'],
];

// ── The oracle: host Node ──────────────────────────────────────────────────
const host = mkdtempSync(join(tmpdir(), 'lifo-node-launch-'));
let expected;
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), text);
  }
  expected = RUNS.map(([args, nodeOptions]) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const ran = spawnSync('node', args, { cwd: host, env, encoding: 'utf8' });
    return [ran.status, ran.stdout];
  });
} finally {
  rmSync(host, { recursive: true, force: true });
}
// What the oracle says, stated, so the comparison is not vacuous.
assert.deepEqual(expected.map(([, out]) => out.trim()), [
  'start', 'start a b', 'start c', '["prod","prod"]', '["dev","dev"]', '["dev","dev"]', '["dev","dev"]',
]);

// ── The portable node ──────────────────────────────────────────────────────
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  for (const [name, text] of Object.entries(FILES)) {
    await ws.fs.mkdir(dirname(`/home/user/app/${name}`), { recursive: true });
    await ws.fs.writeFile(`/home/user/app/${name}`, text);
  }
  const quote = (word) => `'${word}'`;
  for (const [i, [args, nodeOptions]] of RUNS.entries()) {
    const command = `${nodeOptions === undefined ? '' : `NODE_OPTIONS=${quote(nodeOptions)} `}node ${args.map(quote).join(' ')}`;
    const ran = await ws.exec(command, { cwd: '/home/user/app', signal: AbortSignal.timeout(60_000) });
    assert.deepEqual([ran.exitCode, ran.stdout], expected[i], `${command}: ${ran.stderr}`);
  }
  for (const [args, option] of [
    [['-p', '1'], '--print'], [['-r', './start.js', 'start.js'], '--require'], [['-c', 'start.js'], '--check'],
    [['--experimental-default-type=module', '-e', '1'], '--experimental-default-type'],
  ]) {
    const ran = await ws.exec(`node ${args.map(quote).join(' ')}`, { cwd: '/home/user/app' });
    assert.deepEqual([ran.exitCode, ran.stdout], [9, ''], `node ${args.join(' ')} is refused`);
    assert.match(ran.stderr, new RegExp(`^node: ${option} is not supported by this node`), ran.stderr);
  }
  const missing = await ws.exec('node nope', { cwd: '/home/user/app' });
  assert.deepEqual([missing.exitCode, missing.stderr], [1, "node: cannot find module 'nope'\n"]);
} finally {
  await ws.close();
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-node-launch (the portable node reads its command line, finds its script and takes conditions as Node does; under Bun and Node)');
} else {
  console.log('ok - under node');
}
