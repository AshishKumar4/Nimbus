#!/usr/bin/env bun
// A resident process's exit report delivers the code it produced at runtime,
// and the next launch of the same command carries it.
//
// A resident process (a dev server, any node server, an attached CLI) reports
// its runtime code in its exit report, which travels as a supervisor op
// envelope and is routed onto the session's _rpcReportExit by the op table
// (core/workspace/supervisor-op.ts). A route that drops the argument loses the
// code silently: the next launch fails again with ERR_NIMBUS_CODE_NEXT_LAUNCH.
// So this drives the whole path — envelope, route, _rpcReportExit, the
// manager's store — and asserts on the next launch's module map.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { _rpcReportExit, _rpcReportRuntimeCode } from '../../packages/worker/src/session/rpc.ts';
import { runtimeCodeKey, runtimeCodeModuleName } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const { world, processes, manager, vfs } = launchManager('runtime-code-report');

const PROGRAM = 'require("http").createServer(() => {}).listen(3000);';
const spawn = () => manager.spawnNode(PROGRAM, { command: 'node server.js', filename: '/home/user/server.js', cwd: '/home/user' });
const lastMap = () => world.boots.at(-1).config.modules;

// The session side of the op, as the session composes it.
const session = { processes, facetManager: manager, terminal: null, nimbusDebug: false, _emitExitDump() {} };
const dispatch = createSupervisorOpHandler({ vfs, host: {
  _rpcReportExit: (...args) => _rpcReportExit(session, ...args),
  _rpcReportRuntimeCode: (...args) => _rpcReportRuntimeCode(session, ...args),
} });

const first = await spawn();
const produced = { kind: 'async', params: ['a'], body: 'return a + 1;' };
await dispatch({ op: 'reportExit', pid: first.pid, args: [0, '', [], null, [produced]] });

const second = await spawn();
assert.notEqual(second.pid, first.pid);
const name = runtimeCodeModuleName(runtimeCodeKey(produced));
assert.ok(name in lastMap(), `the next launch carries ${name}: ${Object.keys(lastMap()).filter((n) => n.startsWith('gen/')).join(', ') || 'no gen/ modules'}`);
/** The staged constructor's function, from an origin whose import() nothing calls here. */
function compiled(name) {
  const mod = {exports: {}};
  new Function('module', lastMap()[name].cjs)(mod);
  return mod.exports(() => Promise.reject(new Error('no import here')), Function);
}
assert.equal(await compiled(name)(41), 42, 'the next launch can execute the reported constructor with its arguments');

// A server catches a generated-code miss and continues serving an error page.
// It need not exit to teach the next launch: the live report is durable before
// acknowledgement, even when the supervisor subsequently kills the server.
const caught = { kind: 'async', params: [], body: 'return "rendered page";' };
await dispatch({ op: 'reportRuntimeCode', pid: second.pid, args: [[caught]] });
assert.equal(processes.get(second.pid).state, 'running', 'learning code does not terminate the server');
manager.kill(second.pid, 'SIGKILL');
await spawn();
const caughtName = runtimeCodeModuleName(runtimeCodeKey(caught));
assert.ok(caughtName in lastMap(), 'a caught SSR compile miss survives a kill without an exit ledger');
assert.equal(await compiled(caughtName)(), 'rendered page', 'the caught SSR function executes after its producer was killed');
await assert.rejects(dispatch({ op: 'reportRuntimeCode', pid: second.pid, args: [[caught]] }), /live launch/);

console.log('resident-runtime-code-report: ok');
