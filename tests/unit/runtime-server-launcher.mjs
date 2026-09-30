#!/usr/bin/env bun
// A script whose entry hands off to its own server module runs resident.
//
// A port is reachable only from the keyed long-running facet, and that has to
// be chosen before the program runs, so `node <file>` is judged by its source
// (node-runner.ts looksLikeServer). The entry alone misses the usual bin: a
// few lines that parse argv and require the package's server module.
// `npx static-server` is exactly that (bin/static-server.js requires
// ../server.js, which calls http.createServer().listen()), so it ran in the
// one-shot facet: it held the terminal in the foreground and its port was
// never reachable. sirv-cli and live-server have the same shape.
//
// Through the public entry: the runtime handler (buildRuntimeHandler) over
// the real runFresh, with a FacetManager that records which facet it was asked
// for. What must hold:
//   - an entry that requires or imports a module of its own package that
//     creates a server is promoted, CommonJS or ESM;
//   - a module that only names `.listen(` (degit's keypress listener) is not
//     a server, and neither is a module outside the entry's package;
//   - a query or `build` of such a CLI stays one-shot, as a named server
//     bin's does;
//   - a .bin wrapper keeps its own rule (the handler is not asked to guess).

import assert from 'node:assert/strict';
import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';
import { runFresh } from '../../packages/worker/src/runtime/node-runner.ts';

function facetMgr() {
  const calls = { exec: 0, spawnNode: 0 };
  return {
    calls,
    async exec() { calls.exec++; return { exitCode: 0, stdout: '', stderr: '' }; },
    async spawnNode() { calls.spawnNode++; return { pid: 4242 }; },
    processExitCode: () => null,
  };
}

async function run(files, script, args = [], ctxExtra = {}) {
  const fm = facetMgr();
  const fs = {
    exists: (p) => Object.hasOwn(files, p),
    isFile: (p) => Object.hasOwn(files, p),
    readFileString: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error('ENOENT ' + p);
      return files[p];
    },
  };
  const handler = buildRuntimeHandler(
    {
      name: 'node', version: 'v22.0.0', helpText: 'help', supportsBinSpawn: true, routesServers: true,
      run: (code, opts) => runFresh(fm, code, opts),
    },
    {
      getEsbuild: () => ({ async transform(code) { return { code }; } }),
      registry: { resolve: () => undefined },
    },
  );
  const stderr = [];
  const exitCode = await handler({
    vfs: fs, args: [script, ...args], cwd: '/home/user', env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) },
    ...ctxExtra,
  });
  assert.equal(exitCode, 0, stderr.join(''));
  return fm.calls;
}

const NPX = 'tmp/.npx-cache/node_modules';
const STATIC_SERVER = {
  [`${NPX}/static-server/package.json`]: JSON.stringify({ name: 'static-server', bin: { 'static-server': './bin/static-server.js' } }),
  [`${NPX}/static-server/bin/static-server.js`]: [
    '#!/usr/bin/env node',
    "var program = require('commander');",
    "var StaticServer = require('../server.js');",
    'var server = new StaticServer(program);',
    'server.start(function () { console.log("started"); });',
  ].join('\n'),
  [`${NPX}/static-server/server.js`]: "this._socket = http.createServer(requestHandler(this)).listen(this.port, this.host, callback);\n",
};
const STATIC_BIN = `/${NPX}/static-server/bin/static-server.js`;

// ── the launcher shape serves ───────────────────────────────────────────────
{
  const calls = await run(STATIC_SERVER, STATIC_BIN, ['-p', '9080', '/home/user/site']);
  assert.deepEqual(calls, { exec: 0, spawnNode: 1 }, 'npx static-server runs resident, where its port is routed');
}
{
  const calls = await run({
    'home/user/node_modules/sirv-esm/package.json': JSON.stringify({ name: 'sirv-esm', type: 'module' }),
    'home/user/node_modules/sirv-esm/bin.js': "import sade from 'sade';\nimport { boot } from './lib/index.js';\nsade('sirv [dir]').action(boot).parse(process.argv);\n",
    'home/user/node_modules/sirv-esm/lib/index.js': "export function boot(dir, opts) { require('http').createServer(fn).listen(opts.port); }\n",
  }, '/home/user/node_modules/sirv-esm/bin.js', ['public', '--port', '8103']);
  assert.deepEqual(calls, { exec: 0, spawnNode: 1 }, 'an ESM launcher is read before its rewrite');
}

// ── what is not a server launch ─────────────────────────────────────────────
{
  const calls = await run({
    [`${NPX}/degit/package.json`]: JSON.stringify({ name: 'degit', bin: { degit: 'degit' } }),
    [`${NPX}/degit/degit`]: "#!/usr/bin/env node\nrequire('./dist/bin.js');\n",
    [`${NPX}/degit/dist/bin.js`]: 'start(){ this.stop = a.listen(this, this.keypress.bind(this)); }\n',
  }, `/${NPX}/degit/degit`, ['user/repo', 'my-app']);
  assert.deepEqual(calls, { exec: 1, spawnNode: 0 }, 'a keypress `.listen(` does not make degit a server');
}
{
  const calls = await run({
    'home/user/node_modules/cli/package.json': JSON.stringify({ name: 'cli' }),
    'home/user/node_modules/cli/bin.js': "require('../other/server.js');\n",
    'home/user/node_modules/other/package.json': JSON.stringify({ name: 'other' }),
    'home/user/node_modules/other/server.js': 'require("http").createServer().listen(1);\n',
  }, '/home/user/node_modules/cli/bin.js');
  assert.deepEqual(calls, { exec: 1, spawnNode: 0 }, 'another package\'s module is not the entry\'s own');
}

// ── a serving CLI asked for something that ends ─────────────────────────────
for (const args of [['--version'], ['-h'], ['build']]) {
  const calls = await run(STATIC_SERVER, STATIC_BIN, args);
  assert.deepEqual(calls, { exec: 1, spawnNode: 0 }, `static-server ${args.join(' ')} answers and exits`);
}

// ── a .bin wrapper keeps its own rule ───────────────────────────────────────
{
  const calls = await run(STATIC_SERVER, STATIC_BIN, [], {
    __nimbusBinSpawn: { callerPid: 9, command: 'static-server', forceLongRunning: false },
  });
  assert.deepEqual(calls, { exec: 1, spawnNode: 0 }, 'the bin wrapper decided; the handler does not second-guess it');
}

console.log('runtime-server-launcher: ok');
