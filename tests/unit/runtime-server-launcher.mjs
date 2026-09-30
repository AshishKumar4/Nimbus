#!/usr/bin/env bun
// A program runs resident exactly when the code this invocation runs starts
// a server (core/runtime/server-launch.ts).
//
// A port is reachable only from the keyed long-running facet, and that has to
// be chosen before the program runs, so `node <file>` is judged by its code.
// A program that finishes in that facet is never reported ended, so a CLI
// wrongly judged a server returns "started (long-running)" and keeps running.
// The judgement used to be text: `.listen(`/`createServer(`/`serve(` anywhere
// in the entry, or `createServer(` in a module it names. So a comment, a
// server started only for another subcommand, or a factory that is exported
// and never called made a one-shot script resident, while a creator reached
// through an alias or a re-exporting module was missed. An argument decides
// only where the program branches on it (its own process.argv tests, a CLI
// parser's queries and commands), as in Node: a server handed `--help` or
// `build` that does not read them still binds.
//
// Through the public entry: the runtime handler (buildRuntimeHandler) over the
// real runFresh, with a FacetManager that records which facet it was asked for.

import assert from 'node:assert/strict';
import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';
import { runFresh } from '../../packages/worker/src/runtime/node-runner.ts';
import { runBunScript } from '../../packages/worker/src/runtime/bun-runner.ts';

function facetMgr() {
  const calls = { exec: 0, spawnNode: 0 };
  return {
    calls,
    async exec() { calls.exec++; return { exitCode: 0, stdout: '', stderr: '' }; },
    async spawnNode() { calls.spawnNode++; return { pid: 4242 }; },
    processExitCode: () => null,
  };
}

async function invoke(files, args, { runtime = 'node', stdin = '', ...ctxExtra } = {}) {
  const fm = facetMgr();
  const fs = {
    exists: (p) => Object.hasOwn(files, p),
    isFile: (p) => Object.hasOwn(files, p),
    stat: (p) => (Object.hasOwn(files, p) ? { type: 'file', size: files[p].length } : null),
    readFileString: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error('ENOENT ' + p);
      return files[p];
    },
  };
  const handler = buildRuntimeHandler(
    {
      name: runtime, version: 'v22.0.0', helpText: 'help', supportsBinSpawn: runtime === 'node', routesServers: true,
      run: (code, opts) => (runtime === 'bun' ? runBunScript(fm, code, opts) : runFresh(fm, code, opts)),
    },
    {
      getEsbuild: () => ({ async transform(code) { return { code }; } }),
      registry: { resolve: () => undefined },
    },
  );
  const stderr = [];
  const exitCode = await handler({
    vfs: fs, args, cwd: '/home/user', env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdin: { readAll: async () => stdin },
    stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) },
    ...ctxExtra,
  });
  assert.equal(exitCode, 0, stderr.join(''));
  return fm.calls.spawnNode === 1 && fm.calls.exec === 0 ? 'resident' : fm.calls.exec === 1 ? 'one-shot' : JSON.stringify(fm.calls);
}

/** A package at home/user/app with these files; `node app/<entry> ...args`. */
const app = (files) => Object.fromEntries([
  ['home/user/app/package.json', '{"name":"app"}'],
  ...Object.entries(files).map(([name, text]) => [`home/user/app/${name}`, text]),
]);
const run = (files, entry, args = [], options) => invoke(app(files), [`/home/user/app/${entry}`, ...args], options);
const SERVER_FACTORY = "module.exports = () => require('http').createServer().listen(9080);\n";

// ── a program that starts a server itself ───────────────────────────────────
for (const [what, source] of [
  ['http.createServer().listen', "const http = require('http'); http.createServer((q, s) => s.end('hi')).listen(5000);"],
  ['express app.listen(PORT)', "const app = require('express')(); const PORT = process.env.PORT || 3000; app.listen(PORT, () => console.log('up'));"],
  ['net.createServer(...).listen', "const net = require('net'); net.createServer(onConnection).listen(9000);"],
  ['a server started once its entry guard holds', "const app = require('./app-module'); if (require.main === module) app.listen(3000);"],
  ['a server started in a called function', 'async function main() { await setup(); server.listen(8080); }\nmain().catch(console.error);'],
  ['an aliased creator', "const { createServer: make } = require('node:http'); make(handler);"],
  ['a creator bound off its module', "const http = require('http'); const make = http.createServer; make(handler);"],
  ['a port in a constant', "const p = 3000;\nrequire('express')().listen(p);"],
  ['a port with an environment default', "const p = process.env.APP_BIND || 8080;\napp.listen(p, () => console.log('up'));"],
  ['a port a function is given', "function start(p) { app.listen(p); }\nstart(Number(process.argv[2]));"],
]) {
  assert.equal(await run({ 'server.js': source }, 'server.js'), 'resident', what);
}
for (const args of [['--help'], ['--version'], ['build']]) {
  assert.equal(await run({ 'server.js': "require('http').createServer((q, s) => s.end('hi')).listen(5000);" }, 'server.js', args),
    'resident', `a server that does not read ${args[0]} still binds`);
}
{
  const USAGE = "if (process.argv.includes('--help')) { console.log('usage: server'); process.exit(0); }\nrequire('http').createServer().listen(3000);";
  assert.equal(await run({ 'server.js': USAGE }, 'server.js', ['--help']), 'one-shot', 'a server that answers its own --help and exits');
  assert.equal(await run({ 'server.js': USAGE }, 'server.js'), 'resident');
}
assert.equal(await invoke({}, ['-e', "require('http').createServer().listen(3000)"]), 'resident', 'node -e starts a server');
assert.equal(await invoke({}, ['-'], { stdin: "require('http').createServer().listen(3000)" }), 'resident', 'node - starts a server');
assert.equal(await invoke({ 'home/user/b.js': 'Bun.serve({ port: 4000, fetch() { return new Response("ok"); } });' }, ['/home/user/b.js'], { runtime: 'bun' }),
  'resident', 'bun: Bun.serve');

// ── a program that finishes ─────────────────────────────────────────────────
for (const [what, source] of [
  ['a build script', "console.log('build done'); process.exit(0);"],
  ['prose and comments about servers', "// app.listen(3000); createServer(handler)\nconst s = 'the server listens: serve(it)'; console.log(s);"],
  ['an emitter\'s listen(handler)', "const messenger = connect(); messenger.listen((message) => handle(message)); messenger.listen(this, onKey);"],
  ['a server only in a function never called', "function serve() { require('http').createServer().listen(1); }\nmodule.exports = serve;"],
  ['a server only after the program exited', "console.log('usage'); process.exit(1);\nrequire('http').createServer().listen(1);"],
  ['listen on a socket path', "const sock = '/tmp/app.sock';\nrequire('net').Server.prototype.x; server.listen(sock);"],
  ['listen given a callback', "function onMessage(m) { handle(m); }\nmessenger.listen(onMessage); bus.listen(handler.bind(bus));"],
]) {
  assert.equal(await run({ 'script.js': source }, 'script.js'), 'one-shot', what);
}

// ── a program that starts one of its own modules' servers ───────────────────
// `npx static-server`: the bin requires ../server.js and constructs and starts
// the server it exports; sirv-cli hands its module to its CLI as the action.
{
  const STATIC_SERVER = {
    'tmp/.npx-cache/node_modules/static-server/package.json': '{"name":"static-server"}',
    'tmp/.npx-cache/node_modules/static-server/bin/static-server.js': [
      '#!/usr/bin/env node',
      "var program = require('commander');",
      "var StaticServer = require('../server.js');",
      'var server;',
      'program.parse(process.argv);',
      'server = new StaticServer(program);',
      'server.start(function () { console.log("started"); });',
    ].join('\n'),
    'tmp/.npx-cache/node_modules/static-server/server.js': [
      'module.exports = StaticServer;',
      'function StaticServer(options) { this.port = options.port; }',
      'StaticServer.prototype.start = function start(callback) {',
      '  this._socket = http.createServer(requestHandler(this)).listen(this.port, this.host, callback);',
      '};',
      'StaticServer.prototype.stop = function stop() { this._socket.close(); };',
    ].join('\n'),
  };
  const bin = '/tmp/.npx-cache/node_modules/static-server/bin/static-server.js';
  assert.equal(await invoke(STATIC_SERVER, [bin, '-p', '9080', '/home/user/site']), 'resident', 'npx static-server');
  for (const args of [['--version'], ['-h'], ['-p', '9080', '--help']]) {
    assert.equal(await invoke(STATIC_SERVER, [bin, ...args]), 'one-shot', `commander answers static-server ${args.join(' ')} and exits`);
  }
  assert.equal(await invoke(STATIC_SERVER, [bin, 'build']), 'resident', 'static-server build serves a directory named build');
  assert.equal(await invoke(STATIC_SERVER, [bin], { __nimbusBinSpawn: { callerPid: 9, command: 'static-server' } }),
    'one-shot', 'a .bin wrapper decided residency by its own rule');
}
assert.equal(await invoke({
  'home/user/node_modules/sirv-esm/package.json': '{"name":"sirv-esm","type":"module"}',
  'home/user/node_modules/sirv-esm/bin.js': "import sade from 'sade';\nimport { boot } from './lib/index.js';\nsade('sirv [dir]').action(boot).parse(process.argv);\n",
  'home/user/node_modules/sirv-esm/lib/index.js': "export function boot(dir, opts) { require('http').createServer(fn).listen(opts.port); }\nexport function help() {}\n",
}, ['/home/user/node_modules/sirv-esm/bin.js', 'public']), 'resident', 'an ESM launcher handing its module to its CLI');
assert.equal(await invoke({
  'home/user/node_modules/sirv-esm/package.json': '{"name":"sirv-esm","type":"module"}',
  'home/user/node_modules/sirv-esm/bin.js': "import sade from 'sade';\nimport { boot } from './lib/index.js';\nsade('sirv [dir]').action(boot).parse(process.argv);\n",
  'home/user/node_modules/sirv-esm/lib/index.js': "export function boot(dir, opts) { require('http').createServer(fn).listen(opts.port); }\n",
}, ['/home/user/node_modules/sirv-esm/bin.js', '--help']), 'one-shot', 'sade answers --help and exits');
{
  const YARGS = {
    'bin.js': [
      "const run = require('./lib');",
      "require('yargs')",
      "  .command({ command: 'init [path]', handler: (argv) => run.init(argv.path) })",
      "  .command({ command: 'serve [path]', handler: (argv) => run.serve(argv.port) })",
      '  .parse();',
    ].join('\n'),
    'lib/index.js': "module.exports = { init: require('./init'), serve: require('./serve') };\n",
    'lib/init.js': "module.exports = () => console.log('init');\n",
    'lib/serve.js': "module.exports = (port) => require('http').createServer().listen(port);\n",
  };
  assert.equal(await run(YARGS, 'bin.js', ['serve']), 'resident', 'a yargs command serving through an index of commands');
  assert.equal(await run(YARGS, 'bin.js', ['init', 'docs']), 'one-shot', 'another yargs command');
  assert.equal(await run(YARGS, 'bin.js', ['serve', '--help']), 'one-shot', 'yargs answers --help and exits');
}
{
  const COMMANDER = {
    'cli.js': [
      "const { Command } = require('commander');",
      "const { startDev } = require('./dev.js');",
      'const program = new Command();',
      "program.command('dev').option('-p, --port <n>').action((opts) => startDev(opts.port));",
      "program.command('build').action(() => console.log('built'));",
      'program.parse(process.argv);',
    ].join('\n'),
    'dev.js': "exports.startDev = (port) => require('http').createServer().listen(port);\n",
  };
  assert.equal(await run(COMMANDER, 'cli.js', ['dev', '-p', '5173']), 'resident', 'the commander command that serves');
  assert.equal(await run(COMMANDER, 'cli.js', ['build']), 'one-shot', 'the commander command that builds');
}
assert.equal(await run({ 'cli.js': "require('./wrapper.js')();", 'wrapper.js': "module.exports = require('./server.js');", 'server.js': SERVER_FACTORY },
  'cli.js'), 'resident', 'a second hop: a module re-exporting the server module');
assert.equal(await run({
  'cli.js': "import { start } from './index.js';\nstart();\n",
  'index.js': "export { start } from './server.js';\nexport const version = '1';\n",
  'server.js': "export function start() { require('http').createServer().listen(3000); }\n",
}, 'cli.js'), 'resident', 'a second hop through an ESM re-export');
assert.equal(await run({
  'cli.js': "const start = require('./server.js');\nstart();\n",
  'server.js': "const http = require('http');\nconst make = http.createServer;\nmodule.exports = () => make(handler);\n",
}, 'cli.js'), 'resident', 'an aliased creator in the module the entry calls');

// ── a program whose own modules could serve, but not in this invocation ─────
{
  const CLI = {
    'cli.js': "const start = require('./server.js');\nif (process.argv[2] === 'serve') start();\nelse console.log('done');\n",
    'server.js': SERVER_FACTORY,
  };
  assert.equal(await run(CLI, 'cli.js', ['deploy']), 'one-shot', 'a server started only for another subcommand');
  assert.equal(await run(CLI, 'cli.js'), 'one-shot', 'no subcommand: no server');
  assert.equal(await run(CLI, 'cli.js', ['serve']), 'resident', 'the serve subcommand starts it');
}
for (const [what, files] of [
  ['a commented-out require', { 'cli.js': "// require('./server.js')();\nconsole.log('done');", 'server.js': SERVER_FACTORY }],
  ['a server factory required and logged, never called', { 'cli.js': "const value = require('./server.js');\nconsole.log(value);", 'server.js': SERVER_FACTORY }],
  ['a createServer comment in the module', { 'cli.js': "require('./util.js').format();", 'util.js': '// uses http.createServer() elsewhere\nexports.format = () => 1;\n' }],
  ['another export of the server module', { 'cli.js': "const { version } = require('./lib.js');\nversion();", 'lib.js': "exports.version = () => '1.0';\nexports.serve = () => require('http').createServer().listen(1);\n" }],
  ['a server module that starts only as its own entry', { 'cli.js': "require('./server.js');", 'server.js': "const app = makeApp();\nif (require.main === module) app.listen(3000);\nmodule.exports = app;\n" }],
  ['a keypress listener in a module it loads', { 'cli.js': "require('./prompt.js');", 'prompt.js': 'class Prompt { start() { this.stop = keypress.listen(this, this.onKey.bind(this)); } }\nnew Prompt().start();\n' }],
  ['listen on the program\'s own listener class', {
    'cli.js': "const { CompletionListener } = require('./completion.js');\nconst commands = build();\nnew CompletionListener({}).listen(commands, signal);",
    'completion.js': 'class CompletionListener { listen(commands) { return Promise.all(commands.map((c) => c.close)); } }\nexports.CompletionListener = CompletionListener;\n',
  }],
]) {
  assert.equal(await run(files, 'cli.js'), 'one-shot', what);
}
assert.equal(await invoke({
  'home/user/node_modules/cli/package.json': '{"name":"cli"}',
  'home/user/node_modules/cli/bin.js': "require('../other/server.js');\n",
  'home/user/node_modules/other/package.json': '{"name":"other"}',
  'home/user/node_modules/other/server.js': 'require("http").createServer().listen(1);\n',
}, ['/home/user/node_modules/cli/bin.js']), 'one-shot', 'another package\'s module is not the program\'s own');

console.log('runtime-server-launcher: ok');
