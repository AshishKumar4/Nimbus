/**
 * ruby-resident.ts — a Ruby program that keeps serving, as a Durable Object
 * facet.
 *
 * The half of the Ruby runtime that names workerd. Everything about running
 * the interpreter is in `@nimbus-sh/core`; this is the substrate a program
 * that outlives its invocation needs — an actor that stays alive between
 * requests, with inbound HTTP routed into the socket the program bound. A
 * host without one supplies no {@link RubyResidentStart}, and such a program
 * is refused rather than quietly run as a one-shot that dies with the call.
 */

import { z } from 'zod';
import {
  buildRubyPreamble,
  normalizeRubyFacetResult,
  type RubyFacetResult,
  type RubyResidentStart,
} from '@nimbus-sh/core/runtime/ruby-runner.js';
import { VIRTUAL_SOCKET_KERNEL_SRC } from '@nimbus-sh/core/runtime/virtual-socket-kernel.generated.js';
import type { FacetManager } from '../facets/manager.js';

const RubySocketProcessBootResponseSchema = z.object({
  state: z.string().optional(),
  port: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  result: z.unknown().optional(),
}).passthrough();

interface RubySocketProcessResult extends RubyFacetResult {
  spawnedPid?: number;
  port?: number;
}

/**
 * Start a Ruby program that binds a port as its own process, so it outlives
 * the invocation that started it.
 */
export function rubyResidentStart(facetMgr: FacetManager): RubyResidentStart {
  return async function startResidentRuby(args): Promise<RubySocketProcessResult> {
    const command = args.command;
    const workerCode = buildRubySocketProcessWorker(buildRubyPreamble());
    const spawned = await facetMgr.spawnWorker(workerCode, command, args.cwd, {
      compatibilityFlags: ['nodejs_compat'],
      // By path, not by value: the image is 34.3 MiB — more than a single RPC
      // value may carry — so whichever host runs this process reads it itself.
      vfsWasmModules: { 'ruby+stdlib.wasm': args.wasmVfsPath },
      startArgs: args.startArgs,
    }).catch(() => null);
    if (!spawned) {
      return { exitCode: 1, stdout: '', stderr: 'ruby process boot failed\n' };
    }
    const parsed = RubySocketProcessBootResponseSchema.safeParse(spawned.boot);
    if (!parsed.success) {
      facetMgr.finishProcess(spawned.pid, 1, 'ruby process boot failed');
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'ruby process boot failed\n',
      };
    }

    const boot = parsed.data;
    if (boot.state === 'listening' && typeof boot.port === 'number' && boot.port > 0) {
      facetMgr.registerPort(spawned.pid, Number(boot.port));
      const routeablePorts = await facetMgr.waitForRouteablePorts(spawned.pid);
      const routeablePort = routeablePorts.includes(Number(boot.port)) ? Number(boot.port) : routeablePorts[0];
      if (!routeablePort) {
        facetMgr.kill(spawned.pid);
        return {
          exitCode: 1,
          stdout: boot.stdout || '',
          stderr: `${boot.stderr || ''}ruby: virtual socket port ${boot.port} failed to attach a route handler\n`,
        };
      }
      return {
        exitCode: 0,
        stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${routeablePort}]\x1b[0m\n`,
        stderr: boot.stderr || '',
        spawnedPid: spawned.pid,
        port: routeablePort,
      };
    }

    const reservedPorts = await facetMgr.waitForRouteablePorts(spawned.pid);
    if (reservedPorts.length > 0) {
      return {
        exitCode: 0,
        stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${reservedPorts[0]}]\x1b[0m\n`,
        stderr: boot.stderr || '',
        spawnedPid: spawned.pid,
        port: reservedPorts[0],
      };
    }

    if (boot.state === 'exited') {
      const result = normalizeRubyFacetResult(boot.result) || {
        exitCode: 1,
        stdout: '',
        stderr: 'ruby process returned an invalid exit payload\n',
      };
      facetMgr.finishProcess(spawned.pid, result.exitCode, result.stderr || 'ruby process exited');
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr || result.error || '',
      };
    }

    return {
      exitCode: 0,
      stdout: `${boot.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}"]\x1b[0m\n`,
      stderr: boot.stderr || '',
      spawnedPid: spawned.pid,
    };
  };
}

export function buildRubySocketProcessWorker(preamble: string): string {
  return [
    'import { DurableObject } from "cloudflare:workers";',
    "import __NIMBUS_WASM_ruby_stdlib from './ruby+stdlib.wasm';",
    'globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};',
    "globalThis.__NIMBUS_WASM['ruby+stdlib.wasm'] = __NIMBUS_WASM_ruby_stdlib;",
    '',
    VIRTUAL_SOCKET_KERNEL_SRC,
    '',
    // Listener lifecycle only. Socket bytes never cross this bridge: Ruby opens
    // both accepted and dialed connections as file descriptors and reads and
    // writes them as ordinary IO.
    'globalThis.__nimbusRubySockets = {',
    '  listen(port) { return globalThis.__nimbusVirtualSockets.listen(Number(port)); },',
    '  closeListener(port) { globalThis.__nimbusVirtualSockets.closeListener(Number(port)); return true; },',
    '  pending(port) { return globalThis.__nimbusVirtualSockets.pending(Number(port)); },',
    '  acceptNowJson(port) { const conn = globalThis.__nimbusVirtualSockets.acceptNow(Number(port)); return conn ? JSON.stringify(conn) : ""; },',
    '};',
    '',
    // Outbound half of the same loopback the shell's curl and node's patched
    // fetch use: one mechanism, reached here through the supervisor RPC.
    'globalThis.__nimbusVirtualSocketRouteLoopback = function __nimbusVirtualSocketRouteLoopback(port, request) {',
    '  const supervisor = globalThis.__nimbusRubySupervisor;',
    '  if (!supervisor || typeof supervisor.routeLoopback !== "function") {',
    '    return Promise.reject(new Error("this Ruby process has no supervisor binding for loopback routing"));',
    '  }',
    '  return Promise.resolve(supervisor.routeLoopback(Number(port), request));',
    '};',
    '',
    'globalThis.__nimbusVirtualPortRegistrationPromises = globalThis.__nimbusVirtualPortRegistrationPromises || [];',
    'globalThis.__nimbusVirtualSocketDidListen = function __nimbusVirtualSocketDidListen(port) {',
    '  const supervisor = globalThis.__nimbusRubySupervisor;',
    '  if (!supervisor || typeof supervisor.registerPort !== "function") return;',
    '  try {',
    '    const p = supervisor.registerPort(Number(port)).catch((e) => {',
    '      const msg = e && e.message ? e.message : String(e);',
    '      (globalThis.__nimbusRubyStderr || (globalThis.__nimbusRubyStderr = [])).push("[ruby-runner] port registration failed: " + msg + "\\n");',
    '    });',
    '    globalThis.__nimbusVirtualPortRegistrationPromises.push(p);',
    '  } catch (e) {',
    '    const msg = e && e.message ? e.message : String(e);',
    '    (globalThis.__nimbusRubyStderr || (globalThis.__nimbusRubyStderr = [])).push("[ruby-runner] port registration failed: " + msg + "\\n");',
    '  }',
    '};',
    '',
    preamble,
    '',
    // Drive the process when a connection is queued. This is the whole of the
    // runtime's involvement in serving: it knows nothing about what is
    // listening, only that the process should run until it parks.
    //
    // Steps go through the shared resume queue in the preamble, so a handler
    // that parks does not stall other connections and no two drivers can enter
    // a live fiber at once.
    // Timed work the process still owes: the wall-clock moment its earliest
    // sleeper is due. It lives on the global rather than in one driver's
    // closure because no single request may own it. A timer belongs to the
    // request context that created it, and workerd cancels that timer without
    // a word when the request ends - so a driver anchored to the first
    // connection stops dead the moment that connection answers, and every
    // other connection waits out the response timeout instead.
    'globalThis.__nimbusRubyWakeAt = globalThis.__nimbusRubyWakeAt || null;',
    'globalThis.__nimbusRubyIdleDrivers = globalThis.__nimbusRubyIdleDrivers || new Set();',
    'function __nimbusRubyNoteWake(wakeAfter) {',
    '  globalThis.__nimbusRubyWakeAt = (wakeAfter === null || wakeAfter === undefined)',
    '    ? null',
    '    : Date.now() + Math.max(0, wakeAfter) * 1000;',
    '  if (globalThis.__nimbusRubyWakeAt === null) return;',
    '  const waiting = Array.from(globalThis.__nimbusRubyIdleDrivers);',
    '  globalThis.__nimbusRubyIdleDrivers.clear();',
    '  for (const wake of waiting) wake();',
    '}',
    // So instead every live request drives, for as long as it is live, and the
    // moment one of them answers the others are already carrying the work.
    // Steps are serialized by the resume queue, and a driver that wakes to
    // find the deadline already moved knows another one got there first.
    'async function __nimbusRubyDrive() {',
    '  for (;;) {',
    '    const due = globalThis.__nimbusRubyWakeAt;',
    '    if (due === null) {',
    '      // Nothing is due yet. Stay available anyway: this request holds a',
    '      // live context, and whichever request discovers the next piece of',
    '      // timed work may answer and be gone before that work comes due.',
    '      await new Promise((resolve) => globalThis.__nimbusRubyIdleDrivers.add(resolve));',
    '      continue;',
    '    }',
    '    const delay = due - Date.now();',
    '    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));',
    '    if (globalThis.__nimbusRubyWakeAt !== due) continue;',
    '    const step = await globalThis.__nimbusRubyStep();',
    '    if (!step.resumed || !step.alive) { globalThis.__nimbusRubyWakeAt = null; return; }',
    '    __nimbusRubyNoteWake(step.wakeAfter);',
    '  }',
    '}',
    'globalThis.__nimbusVirtualSocketRequestQueued = async function __nimbusVirtualSocketRequestQueued(port) {',
    '  const step = await globalThis.__nimbusRubyStep();',
    '  if (!step.resumed) return false;',
    '  __nimbusRubyNoteWake(step.wakeAfter);',
    '  __nimbusRubyDrive().catch((e) => {',
    '    (globalThis.__nimbusRubyStderr || (globalThis.__nimbusRubyStderr = [])).push(',
    '      "[ruby-runner] driving the process failed: " + ((e && e.message) || e) + "\\n");',
    '  });',
    '  return true;',
    '};',
    '',
    'async function __nimbusStartRubyProcess(args) {',
    '  if (!globalThis.__nimbusRubyProcessPromise) {',
    '    const stdoutStart = (globalThis.__nimbusRubyStdout || []).length;',
    '    const stderrStart = (globalThis.__nimbusRubyStderr || []).length;',
    '    globalThis.__nimbusRubyProcessOutputStart = { stdoutStart, stderrStart };',
    '    globalThis.__nimbusRubyProcessArgs = {',
    '      userCode: args.userCode,',
    '      rbArgv: args.rbArgv || [],',
    '      userEnv: args.userEnv || {},',
    '      progName: args.progName || "ruby",',
    '      cwd: args.cwd || "/home/user",',
    '      fsSnapshot: args.fsSnapshot,',
    '    };',
    '    globalThis.__nimbusRubyProcessPromise = globalThis.__rubyRun(globalThis.__nimbusRubyProcessArgs).then((result) => {',
    '      globalThis.__nimbusRubyProcessResult = result;',
    '      return result;',
    '    });',
    '  }',
    '  const started = globalThis.__nimbusRubyProcessOutputStart || { stdoutStart: 0, stderrStart: 0 };',
    '  const listen = globalThis.__nimbusVirtualSockets.waitForListen(10_000).then((port) => ({ state: port ? "listening" : "pending", port }));',
    '  const exit = globalThis.__nimbusRubyProcessPromise.then((result) => ({ state: "exited", result }));',
    '  const first = await Promise.race([listen, exit]);',
    '  const registrations = globalThis.__nimbusVirtualPortRegistrationPromises || [];',
    '  if (registrations.length > 0) await Promise.allSettled(registrations.splice(0));',
    '  const stdout = (globalThis.__nimbusRubyStdout || []).slice(started.stdoutStart).join("");',
    '  const stderr = (globalThis.__nimbusRubyStderr || []).slice(started.stderrStart).join("");',
    '  if (first.state === "listening") return { state: "listening", port: first.port, stdout, stderr };',
    '  if (first.state === "exited") return { state: "exited", result: first.result, stdout, stderr };',
    '  const currentPort = globalThis.__nimbusVirtualSockets.firstListeningPort();',
    '  if (currentPort) return { state: "listening", port: currentPort, stdout, stderr };',
    '  return { state: "running", stdout, stderr };',
    '}',
    '',
    // Only adopt a real binding: routed handleHttpRequest/fetch hops resolve
    // the entrypoint without a supervisor, and overwriting with undefined
    // would drop the live stub the process needs for its whole lifetime.
    'function __nimbusAdoptRubySupervisor(env) {',
    '  const supervisor = env && env.SUPERVISOR;',
    '  if (supervisor) globalThis.__nimbusRubySupervisor = supervisor;',
    // The WASI filesystem takes the same stub. That is what turns the
    // spawn-time seed into a cache over the session VFS, so a server that
    // never exits still persists its writes instead of losing them entirely.
    '  __wasiAdoptSupervisor(supervisor);',
    '}',
    // A resident process parks between requests, and parking is the only
    // moment "durable while running" can be made true: by the time the caller
    // holds a response, everything the request wrote has reached the VFS.
    'async function __nimbusParkRuby(value) {',
    // Revalidate drains first, then spends ONE round trip on the subtree
    // revision. An unchanged subtree keeps the whole cache; a changed one
    // drops the clean half so the next read sees another process's writes.
    '  await __wasiRevalidateFS();',
    '  return value;',
    '}',
    'export class NimbusProcess extends DurableObject {',
    '  async startProcess(args) {',
    '    __nimbusAdoptRubySupervisor(this.env);',
    '    return __nimbusParkRuby(await __nimbusStartRubyProcess(args || {}));',
    '  }',
    '  async fetch(request) {',
    '    __nimbusAdoptRubySupervisor(this.env);',
    '    return this.handleHttpRequest(request);',
    '  }',
    '  async handleHttpRequest(request) {',
    '    __nimbusAdoptRubySupervisor(this.env);',
    '    const hinted = Number(request.headers.get("X-Nimbus-Port") || 0);',
    '    const port = hinted || Array.from(globalThis.__nimbusVirtualSockets.listeners.keys())[0];',
    '    if (!port) return new Response("Nimbus Ruby process has no listening virtual socket", { status: 502 });',
    '    return __nimbusParkRuby(await globalThis.__nimbusVirtualSockets.handleHttpRequest(port, request));',
    '  }',
    '}',
  ].join('\n');
}
