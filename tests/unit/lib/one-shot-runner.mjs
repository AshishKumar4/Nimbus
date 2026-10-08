// A one-shot `node` in a session, without workerd: the Worker Loader writes
// the generated runner out and imports it (the real shims and store run),
// SUPERVISOR is the session's own supervisor-op handler, and a FacetManager
// runs the exec.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports, supervisorEntrypoint } from '../../../packages/fabric/src/composition.ts';
import { createFacetCtx, createFacetWorld } from '../facet-host-harness.mjs';
import { writeModuleSet } from './module-map-bundle.mjs';
import { processFiles } from './process-bridge.mjs';
import { stagedAssets } from './staged-assets.mjs';
import { opSender, supervisorDouble } from './supervisor-double.mjs';

/**
 * The Worker Loader as a one-shot exec uses it: each load writes the
 * generated runner (after `rewrite`, when given) to a fresh directory under
 * one tmpdir, removed at exit, and serves its run as the entry module does,
 * with the capability it is handed as SUPERVISOR. `get` is the keyed path,
 * which a one-shot never takes.
 *
 * @param {string} name
 * @param {{ rewrite?: (config: any) => any, get?: (...args: any[]) => any }} [options]
 */
export function runnerLoader(name, { rewrite = (config) => config, get } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `nimbus-${name}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  let loads = 0;
  return {
    load(config) {
      config = rewrite(config);
      const file = writeModuleSet(join(dir, `runner-${loads++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      return {
        getEntrypoint: () => ({
          async run(request, supervisor) { return (await loaded).default.fetch(request, { SUPERVISOR: supervisor }); },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get: get ?? (() => { throw new Error('a one-shot exec never takes the keyed loader path'); }),
  };
}

/**
 * SUPERVISOR as the session serves it, as binding and capability alike:
 * every op for the process's own pid through `host`'s supervisor-op handler;
 * stdout and stderr go to `onOutput` as text, and reportExit is dropped.
 */
export function adoptSessionSupervisor(host, onOutput) {
  const dec = new TextDecoder();
  adoptCtxExports({
    // The binding's factory is generic over its stub; this one answers every op.
    SupervisorRPC: /** @type {any} */ (({ props }) => {
      const send = opSender((envelope) => host.supervisorOp({ ...envelope, pid: props?.pid }));
      return supervisorDouble(async (op, args) => {
        if (op === 'stdout' || op === 'stderr') { onOutput(dec.decode(/** @type {Uint8Array} */ (args[0]))); return; }
        if (op === 'reportExit') return;
        return send(op, args);
      });
    }),
  });
}

/** A FacetManager named `name` over `rawVfs`, loading runners through `loader`. */
export function oneShotManager(name, { host, rawVfs, loader }) {
  const manager = new FacetManager(
    createFacetCtx(createFacetWorld(() => ({})), name),
    { LOADER: loader, ASSETS: stagedAssets }, host.processes, new PortRegistry(), processHostFor,
    { supervise: (props) => supervisorEntrypoint()({ props }) },
  );
  manager.setVfs(rawVfs, processFiles(rawVfs));
  return manager;
}
