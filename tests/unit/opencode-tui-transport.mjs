#!/usr/bin/env bun
// Use OpenCode's committed CLI builders, not a copied option grammar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { classifyStagedArtifact } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import { buildOpenCodeTransportPlan } from '../../packages/worker/src/runtime/opencode-invocation.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
const workerRequire = createRequire(new URL('../../packages/worker/package.json', import.meta.url));
const coreRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { parse } = workerRequire('acorn');
const walk = coreRequire('acorn-walk');
const { default: yargs } = await import(workerRequire.resolve('yargs/yargs'));

const source = fs.readFileSync(new URL('../../packages/worker/public/_assets/opencode/1.16.2/index.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const bindings = new Map();
let globalOptions = [];
const property = (object, name) => object?.properties?.find(p => (p.key.name ?? p.key.value) === name)?.value;
const value = node => Function(`return (${source.slice(node.start, node.end)});`)();
walk.simple(ast, { VariableDeclarator(node) { if (node.id.type === 'Identifier') bindings.set(node.id.name, node.init); } });
const chain = node => {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return [];
  return [...chain(node.callee.object), node];
};
for (const init of bindings.values()) {
  const calls = chain(init);
  if (calls.some(call => call.callee.property.name === 'scriptName' && call.arguments[0]?.value === 'opencode')) {
    globalOptions = calls.filter(call => call.callee.property.name === 'option').map(call => [value(call.arguments[0]), value(call.arguments[1])]);
  }
}
assert.ok(globalOptions.length > 0, 'the actual global option chain was found');
const commands = [...bindings.values()].filter(node => node?.type === 'CallExpression' && node.arguments[0]?.type === 'ObjectExpression')
  .map(node => node.arguments[0]).filter(node => property(node, 'command'));
const command = name => commands.find(node => property(node, 'command')?.value === name);
const tui = command('$0 [project]');
const attach = command('attach <url>');
const serve = command('serve');
assert.ok(tui && attach && serve, 'the staged OpenCode registers its actual TUI, attach and serve commands');
const network = [...bindings.values()].find(node => node?.type === 'ObjectExpression' && property(node, 'port') && property(node, 'hostname') && property(node, 'cors'));
assert.ok(network, 'the staged shared network option object is present');
const networkOptions = value(network);
const builder = object => {
  const node = property(object, 'builder');
  let helper;
  walk.simple(node, { CallExpression(call) { if (call.callee.type === 'Identifier' && call.arguments[0]?.name === node.params[0].name) helper = call.callee.name; } });
  return helper ? Function(helper, `return (${source.slice(node.start, node.end)});`)(argv => argv.options(networkOptions))
    : value(node);
};
const native = (argv, which = tui) => {
  let handled;
  const cli = yargs(argv).exitProcess(false).parserConfiguration({ 'populate--': true })
    .help('help').alias('help', 'h').version('version', 'version', 'fixture').alias('version', 'v');
  for (const [name, options] of globalOptions) cli.option(name, options);
  cli.command({ command: property(which, 'command').value, builder: builder(which), handler(args) { handled = args; } }).strict();
  const parsed = cli.parseSync();
  return handled ?? parsed;
};

const cases = [
  [], ['project'], ['../project'], ['123'], ['--port=4096'], ['--port', '4096'],
  ['--hostname', '0.0.0.0'], ['--pure', '--print-logs', '--log-level=DEBUG'],
  ['-c'], ['--continue=false'], ['--no-continue'], ['-cs=abc'], ['-s', 'abc', '--fork'],
  ['--session=abc', '../project'], ['--cors', 'https://a.test', 'https://b.test'],
  ['--model=provider/model'], ['-m=provider/model'], ['--prompt', 'hello'], ['--agent=build'],
];
for (const argv of cases) {
  const upstream = native(argv);
  assert.equal(classifyStagedArtifact('opencode', argv), 'dual', JSON.stringify(argv));
  const plan = buildOpenCodeTransportPlan(argv, '/home/user/app', { PWD: '/home/user/logical' });
  if (upstream.model !== undefined || upstream.prompt !== undefined || upstream.agent !== undefined) {
    assert.ok('error' in plan, 'an option without an attach counterpart is refused before spawn');
    continue;
  }
  assert.ok(!('error' in plan), `${JSON.stringify(argv)}: ${JSON.stringify(plan)}`);
  const server = native([...plan.serveArgv, '--port', String(plan.port || 4096)], serve);
  const client = native(['attach', 'http://127.0.0.1:4096', '--dir', plan.cwd, ...plan.attachArgv], attach);
  for (const key of ['continue', 'session', 'fork', 'pure', 'print-logs', 'log-level']) assert.deepEqual(client[key], upstream[key], `${JSON.stringify(argv)}: attach ${key}`);
  for (const key of ['hostname', 'cors', 'pure', 'print-logs', 'log-level']) assert.deepEqual(server[key], upstream[key], `${JSON.stringify(argv)}: serve ${key}`);
}
for (const argv of [['--mdns'], ['--mdns-domain=x'], ['--bad-option'], ['-p', 'prompt'], ['--fork'], ['--port=-1'], ['--port=65536']]) {
  assert.ok('error' in buildOpenCodeTransportPlan(argv, '/home/user'), JSON.stringify(argv));
}

// The real pair orchestration; the external facet-launch seam only is recorded.
const calls = [];
const manager = Object.create(FacetManager.prototype);
manager._pairedServeFacet = new Map();
manager._allocateLoopbackPort = () => 4100;
manager._stageOpencodeFacet = async (artifact, opts, mode) => { calls.push({ artifact, opts, mode }); return { pid: 101, stageSpec: {} }; };
manager._startStagedResident = async () => ({ pid: 101 });
manager._awaitOpencodeServerReady = async () => {};
manager.execStagedArtifact = async (artifact, opts) => { calls.push({ artifact, opts, mode: 'attached' }); return { pid: 102 }; };
const argv = ['../project', '-c', '--fork', '--port=4200', '--hostname=0.0.0.0', '--pure', '--log-level=DEBUG'];
await manager.execStagedArtifactDual('opencode', { argv, cwd: '/home/user/app', env: {} });
assert.equal(calls[0].opts.cwd, '/home/user/project');
assert.equal(calls[1].opts.cwd, '/home/user/project');
assert.equal(native(calls[0].opts.argv, serve).port, 4200);
assert.equal(native(calls[1].opts.argv, attach).dir, '/home/user/project');
assert.equal(native(calls[1].opts.argv, attach).continue, true);
assert.equal(manager._pairedServeFacet.get(102), 101);
const count = calls.length;
await assert.rejects(manager.execStagedArtifactDual('opencode', { argv: ['--model=x'], cwd: '/home/user', env: {} }), /--model/);
assert.equal(calls.length, count, 'a transport refusal launches neither half');
console.log('opencode-tui-transport: actual grammar and pair flow passed');
