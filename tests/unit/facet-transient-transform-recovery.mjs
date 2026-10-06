#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';
import { supervisorDouble } from './lib/supervisor-double.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

const { host, rawVfs, kfs } = createAuthority();
const root = 'home/user/transient-transform';
kfs.mkdir(root, { recursive: true });
kfs.writeFile(root + '/value.mjs', 'export const value = "recovered after transient transform failure";');
const program = 'console.log(require("./value.mjs").value);';
kfs.writeFile(root + '/entry.cjs', program);
const native = new EsbuildService();
native.ensureInit = async () => {};
native._esbuild = (await import('./lib/oxc-engine.mjs')).oxcEngine;
let attempts = 0;
let fault = 'outcome';
const evalProgram = 'import("node:path").then(path => console.log(path.default.basename("/tmp/eval-entry")));';
const badEval = 'import("node:path").then(() => console.log("must not run after transform rejection"));';
let evalAttempts = 0;
const service = new EsbuildService(undefined, {
  transformHost: async requests => {
    attempts++;
    if (requests.some(request => request.code === evalProgram)) {
      evalAttempts++;
      if (fault === 'eval-transient') {
        fault = 'none';
        return requests.map(() => ({ error: 'injected eval-only transform loss', transient: true }));
      }
    }
    if (fault === 'eval-permanent' && requests.some(request => request.code === badEval)) return requests.map(() => ({ error: 'precise eval parser rejection' }));
    if (attempts === 1 && fault === 'outcome') return requests.map(() => ({ error: 'injected temporary transform-isolate loss', transient: true }));
    if (attempts === 1 && fault === 'throw') throw new Error('injected transform transport failure');
    return native.transformMany(requests);
  },
});
let stdout = '', loaderPublications = 0;
adoptCtxExports({ SupervisorRPC: ({ props }) => supervisorDouble(async (name, args) => {
  if (name === 'stdout') { stdout += new TextDecoder().decode(args[0]); return; }
  if (name === 'stderr' || name === 'reportExit') return;
  return host.supervisorOp({ op: name, args, pid: props?.pid });
}) });
const directory = mkdtempSync(join(tmpdir(), 'transient-transform-'));
const env = {
  LOADER: {
    load(config) {
      loaderPublications++;
      const file = writeModuleSet(join(directory, String(loaderPublications)), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      return { getEntrypoint: () => ({ fetch: async request => (await loaded).default.fetch(request, { SUPERVISOR: config.env?.SUPERVISOR }), [Symbol.dispose]() {} }), [Symbol.dispose]() {} };
    },
    get() { throw new Error('unexpected keyed loader publication'); },
  },
  ASSETS: stagedAssets,
};
const manager = new FacetManager(createFacetCtx(createFacetWorld(() => ({})), 'transient-transform-recovery'), env, host.processes, new PortRegistry(), processHostFor, {});
manager.setVfs(rawVfs, processFiles(rawVfs));
manager.setEsbuildService(service);
const opts = { cwd: '/' + root, dirname: '/' + root, filename: '/' + root + '/entry.cjs', captureOutput: true };
const globals = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
async function launch(code = program, options = opts) {
  try { return await manager.exec(code, options); }
  finally { Object.assign(globalThis, globals); }
}
try {
  await assert.rejects(launch(), /injected temporary transform-isolate loss/, 'transient infrastructure failure aborts launch, not a cached source verdict');
  assert.equal(loaderPublications, 0, 'no diagnostic worker image was published');
  const second = await launch();
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal((second.stdout + stdout).trim(), 'recovered after transient transform failure');
  assert.equal(attempts, 2, 'the next public launch transforms the source again');
  assert.equal(loaderPublications, 1);
  fault = 'throw';
  attempts = 0;
  stdout = '';
  kfs.writeFile(root + '/value.mjs', 'export const value = "recovered after thrown transform failure";');
  await assert.rejects(launch(), /injected transform transport failure/);
  assert.equal(loaderPublications, 1, 'a rejected transform RPC also publishes no image');
  const retry = await launch();
  assert.equal(retry.exitCode, 0, retry.stderr);
  assert.equal((retry.stdout + stdout).trim(), 'recovered after thrown transform failure');
  assert.equal(attempts, 2);
  assert.equal(loaderPublications, 2);
  // This is an eval-only entry, not a staged .cjs file. Its own rewrite runs
  // at worker generation, after the module-map build; it must also fail
  // before LOADER publication rather than leaking native import().
  fault = 'eval-transient';
  stdout = '';
  const evalOpts = { ...opts, filename: '<eval>' };
  const failedEval = await launch(evalProgram, evalOpts);
  assert.equal(failedEval.exitCode, 1, 'eval-only transform failure fails the process');
  assert.match(failedEval.stderr, /injected eval-only transform loss/);
  assert.equal(loaderPublications, 2, 'transient eval entry publishes no worker');
  const evalRetry = await launch(evalProgram, evalOpts);
  assert.equal(evalRetry.exitCode, 0, evalRetry.stderr);
  assert.equal((evalRetry.stdout + stdout).trim(), 'eval-entry');
  assert.equal(evalAttempts, 2, 'eval entry is rewritten again after recovery');
  assert.equal(loaderPublications, 3);
  fault = 'eval-permanent';
  const rejectedEval = await launch(badEval, evalOpts);
  assert.equal(rejectedEval.exitCode, 1);
  assert.match(rejectedEval.stderr, /precise eval parser rejection/);
  assert.equal(loaderPublications, 3, 'a permanent entry rejection also cannot escape to native host import');
  // A permanent source error remains lazy: merely staging an optional module
  // must not prevent a program that never requires it from running.
  fault = 'none';
  stdout = '';
  kfs.writeFile(root + '/invalid.mjs', 'export const broken = ;');
  const lazy = 'function unused() { return require("./invalid.mjs"); } console.log("optional module not loaded");';
  kfs.writeFile(root + '/lazy.cjs', lazy);
  let lazyResult;
  try { lazyResult = await manager.exec(lazy, { ...opts, filename: '/' + root + '/lazy.cjs' }); }
  finally { Object.assign(globalThis, globals); }
  assert.equal(lazyResult.exitCode, 0, lazyResult.stderr);
  assert.equal((lazyResult.stdout + stdout).trim(), 'optional module not loaded');
  // Attached launch returns a pid before its bundle builds. A transform
  // failure must still exit that pid and reach its terminal, not leave the
  // process table saying "running" while an empty TUI waits forever.
  const pending = [];
  const ctx = createFacetCtx(createFacetWorld(() => ({})), "attached-transform-failure");
  ctx.waitUntil = (task) => pending.push(task);
  const notices = [];
  const attached = new FacetManager(ctx, env, host.processes, new PortRegistry(), processHostFor, { onExternalExit: (_pid, _code, reason) => notices.push(reason) });
  attached.setVfs(rawVfs, processFiles(rawVfs));
  attached.setEsbuildService(new EsbuildService(undefined, {
    transformHost: async requests => requests.map(() => ({ error: "Worker exceeded CPU time limit.", transient: true })),
  }));
  kfs.writeFile(root + "/attached.mjs", "export const uniqueAttachedFailure = 431;");
  const started = await attached.spawnNode('require("./attached.mjs");', {
    ...opts, filename: "/" + root + "/attached.cjs", attachedTty: true, argv: ["node", "attached.cjs"],
  });
  for (let i = 0; i < pending.length; i++) await pending[i].catch(() => {});
  assert.equal(host.processes.get(started.pid)?.exitCode, 1, "pre-build failure exits an attached pid");
  assert.match(notices.join(""), /Worker exceeded CPU time limit/, "the terminal is told why before any guest is loaded");
  console.log('facet-transient-transform-recovery: failed launch publishes no image; next launch transforms and runs');
} finally {
  Object.assign(globalThis, globals);
  rmSync(directory, { recursive: true, force: true });
}
