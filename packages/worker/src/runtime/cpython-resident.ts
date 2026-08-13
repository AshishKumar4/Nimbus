/**
 * cpython-resident.ts — a Python program that keeps serving, as a Durable
 * Object facet.
 *
 * The half of the CPython runtime that names workerd. Everything about running
 * the interpreter is in `@nimbus-sh/core`; this is the substrate a program that
 * outlives its invocation needs — an actor that stays alive between requests,
 * with inbound HTTP routed into the socket the program bound. A host without
 * one supplies no {@link CPythonResidentStart} and such a program is refused
 * rather than quietly run as a one-shot that dies with the call.
 */

import { z } from 'zod/v4';
import {
  buildCPythonPreamble,
  type CPythonFacetResult,
  type CPythonResidentStart,
} from '@nimbus-sh/core/runtime/cpython-runner.js';
import type { FacetManager } from '../facets/manager.js';

/**
 * The worker source for a resident Python process. Same shape as
 * buildRubySocketProcessWorker: the socket kernel and the interpreter live in a
 * DurableObject, startProcess runs the program until it stops, and inbound
 * requests arrive on handleHttpRequest and are dispatched into the server the
 * program registered before exiting.
 */
export function buildCPythonSocketProcessWorker(preamble: string): string {
  return [
    'import { DurableObject } from "cloudflare:workers";',
    // The module arrives by path (vfsWasmModules) and has to be published where
    // the preamble looks for it. Without this the facet boots and the first
    // thing it says is "python.wasm was not supplied to this facet".
    "import __NIMBUS_WASM_python from './python.wasm';",
    'globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};',
    "globalThis.__NIMBUS_WASM['python.wasm'] = __NIMBUS_WASM_python;",
    '',
    preamble,
    '',
    // Only adopt a real binding: routed fetch hops resolve the entrypoint
    // without a supervisor, and overwriting with undefined would drop the live
    // stub the process needs for its whole lifetime.
    'function __nimbusAdoptPySupervisor(env) {',
    '  const supervisor = env && env.SUPERVISOR;',
    '  if (supervisor) globalThis.__nimbusPySupervisor = supervisor;',
    '  __wasiAdoptSupervisor(supervisor);',
    '}',
    // A resident process answers between requests, and that is the only moment
    // "durable while running" can be made true: by the time the caller holds a
    // response, everything the request wrote has reached the VFS.
    'async function __nimbusParkPy(value) {',
    '  await __wasiDrainPersist();',
    '  await __wasiRevalidateFS();',
    '  return value;',
    '}',
    'async function __nimbusStartPyProcess(args) {',
    '  const result = await globalThis.__cpythonStartProcess(args || {});',
    '  const ports = await globalThis.__cpythonListeningPorts();',
    '  const registrations = globalThis.__nimbusVirtualPortRegistrationPromises || [];',
    '  if (registrations.length > 0) await Promise.allSettled(registrations.splice(0));',
    '  if (ports.length > 0) {',
    '    return { state: "listening", port: ports[0], stdout: result.stdout, stderr: result.stderr };',
    '  }',
    '  return { state: "exited", result, stdout: result.stdout, stderr: result.stderr };',
    '}',
    'export class NimbusProcess extends DurableObject {',
    '  async startProcess(args) {',
    '    __nimbusAdoptPySupervisor(this.env);',
    '    return __nimbusParkPy(await __nimbusStartPyProcess(args || {}));',
    '  }',
    '  async fetch(request) {',
    '    __nimbusAdoptPySupervisor(this.env);',
    '    return this.handleHttpRequest(request);',
    '  }',
    '  async handleHttpRequest(request) {',
    '    __nimbusAdoptPySupervisor(this.env);',
    '    const hinted = Number(request.headers.get("X-Nimbus-Port") || 0);',
    '    const port = hinted || Array.from(globalThis.__nimbusVirtualSockets.listeners.keys())[0];',
    '    if (!port) return new Response("Nimbus Python process has no listening virtual socket", { status: 502 });',
    '    return __nimbusParkPy(await globalThis.__nimbusVirtualSockets.handleHttpRequest(port, request));',
    '  }',
    '}',
  ].join('\n');
}

const CPythonBootSchema = z.object({
  state: z.string().optional(),
  port: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  result: z.object({ exitCode: z.number().optional() }).passthrough().optional(),
}).passthrough();

interface CPythonSpawnResult extends CPythonFacetResult {
  spawnedPid?: number;
  port?: number;
}

/**
 * Start a program that binds a port as its own process, so it outlives the
 * invocation that started it. Mirrors spawnRubySocketProcess.
 */
export function cpythonResidentStart(facetMgr: FacetManager): CPythonResidentStart {
  return async function startResidentCPython(args): Promise<CPythonSpawnResult> {
    const command = args.command;
    const workerCode = buildCPythonSocketProcessWorker(buildCPythonPreamble());
    const spawned = await facetMgr.spawnWorker(workerCode, command, args.cwd, {
      compatibilityFlags: ['nodejs_compat'],
      // By path, not by value: the interpreter is 10.6 MiB, more than a single
      // RPC value may carry, so whichever host runs this process reads it itself.
      vfsWasmModules: { 'python.wasm': args.wasmVfsPath },
      startArgs: args.startArgs,
    }).catch(() => null);
    if (!spawned) return { exitCode: 1, stdout: '', stderr: 'python process boot failed\n' };

    const boot = CPythonBootSchema.safeParse(spawned.boot);
    if (!boot.success) {
      facetMgr.finishProcess(spawned.pid, 1, 'python process boot failed');
      return { exitCode: 1, stdout: '', stderr: 'python process boot failed\n' };
    }
    const data = boot.data;

    if (data.state === 'listening' && typeof data.port === 'number' && data.port > 0) {
      facetMgr.registerPort(spawned.pid, data.port);
      const routeable = await facetMgr.waitForRouteablePorts(spawned.pid);
      const port = routeable.includes(data.port) ? data.port : routeable[0];
      if (!port) {
        facetMgr.kill(spawned.pid);
        return {
          exitCode: 1,
          stdout: data.stdout || '',
          stderr: `${data.stderr || ''}python: virtual socket port ${data.port} failed to attach a route handler\n`,
        };
      }
      return {
        exitCode: 0,
        stdout: `${data.stdout || ''}\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}" port=${port}]\x1b[0m\n`,
        stderr: data.stderr || '',
        spawnedPid: spawned.pid,
        port,
      };
    }

    const result = data.result;
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : 0;
    facetMgr.finishProcess(spawned.pid, exitCode, data.stderr || 'python process exited');
    return { exitCode, stdout: data.stdout || '', stderr: data.stderr || '' };
  };
}
