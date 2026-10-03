#!/usr/bin/env bun
// A node program runs as a child of the command that ran it, under that
// command's credential.
//
// FacetManager registered each node run at the top of the process table, so
// it ran as the table's default credential (the session user, uid 1000)
// whoever started it: its file syscalls answer under the credential the table
// holds for its pid (SupervisorRPC stamps the pid; core supervisor-op.ts
// credFor resolves it), and a program a confined principal ran wrote where
// only the session user may. What has to hold: a run started by a process of
// another principal is that process's child, carries its credential, and is
// refused where that principal is.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';
import { supervisorDouble } from './lib/supervisor-double.mjs';

const { host, rawVfs } = createAuthority();
const dec = new TextDecoder();

let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => supervisorDouble(async (name, args) => {
    if (name === 'stdout' || name === 'stderr') { out += dec.decode(args[0]); return; }
    if (name === 'reportExit') return;
    return host.supervisorOp({ op: name, args, pid: props?.pid });
  }),
});

// The Worker Loader stands in for workerd: the generated one-shot runner,
// written out and imported, running the real shims and store.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-node-identity-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = writeModuleSet(join(runnerDir, `runner-${runnerN++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      const supervisor = config.env?.SUPERVISOR;
      return {
        getEntrypoint: () => ({
          async fetch(request) { return (await loaded).default.fetch(request, { SUPERVISOR: supervisor }); },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('a one-shot exec never takes the keyed loader path'); },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
};

const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'node-process-identity'),
  env, host.processes, new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, processFiles(rawVfs));

// A directory only the session user may write in.
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home/user/locked', { mode: 0o755 });
root.chown('home/user/locked', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const AGENT = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };

const PROGRAM = "const fs = require('fs'); const name = process.argv.at(-1); "
  + "try { fs.writeFileSync('/home/user/locked/' + name, 'x'); console.log('WROTE'); } "
  + "catch (e) { console.log('REFUSED ' + e.code); }";

async function runAs(cred, name) {
  const invoker = host.processes.spawn('sh', ['sh'], '/home/user', { cred });
  const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
  out = '';
  let result;
  try {
    result = await manager.exec(PROGRAM, {
      filename: '<eval>', dirname: '/home/user', cwd: '/home/user', argv: [name], captureOutput: true, invokerPid: invoker.pid,
    });
  } finally { Object.assign(globalThis, real); }
  assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
  const run = host.processes.descendantsOf(invoker.pid).at(-1);
  return { said: (result.stdout + out).trim().split('\n').at(-1), run };
}

{
  const { said } = await runAs(CRED_SESSION_USER, 'by-user');
  assert.equal(said, 'WROTE', 'the session user may write there');
  assert.ok(root.exists('home/user/locked/by-user'));
}
{
  const { said, run } = await runAs(AGENT, 'by-agent');
  assert.ok(run, 'the run is a child of the command that started it');
  assert.equal(run.cred.uid, AGENT.uid, 'and carries its credential');
  assert.equal(said, 'REFUSED EACCES', 'so it is refused where the agent is');
  assert.equal(root.exists('home/user/locked/by-agent'), false);
}

console.log('ok - node-process-identity (a node run is its command\'s child, under its credential)');
