#!/usr/bin/env bun
// A one-shot `node script.js` sees the filesystem through the namespace, as a
// resident process does (CUTOVER §2.8, #13). It boots the same store,
// namespace and data-plan code, over its own heap (runOnce hosts no SQLite),
// against the session's real supervisor ops. So:
// - existsSync, statSync and readdirSync answer for any name its credential
//   can see, not only the names the launch staged, and a file it did not
//   stage reads asynchronously;
// - a peer's write between two runs (another process, the shell) is what
//   the next run sees;
// - a name under a directory the credential cannot search does not exist for
//   it.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';

const authority = createAuthority();
const { host, rawVfs, kfs } = authority;
const dec = new TextDecoder();

// SUPERVISOR as the session serves it: every op for the process's own pid
// through the session's supervisor-op handler. Output is collected per run.
let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'stdout' || name === 'stderr') return async (bytes) => { out += dec.decode(bytes); };
      if (name === 'reportExit') return async () => {};
      if (name === Symbol.dispose) return () => {};
      return (...args) => host.supervisorOp({ op: name, args, pid: props?.pid });
    },
  }),
});

// The Worker Loader stands in for workerd: the generated one-shot runner,
// written out and imported, running the real shims and store.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-one-shot-ns-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = join(runnerDir, `runner-${runnerN++}.mjs`);
      writeFileSync(file, config.modules['runner.js']);
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
  createFacetCtx(createFacetWorld(() => ({})), 'one-shot-namespace'),
  env, host.processes, new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, processFiles(rawVfs));

kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
kfs.mkdir('home/user/elsewhere', { recursive: true, mode: 0o755 });
kfs.writeFile('home/user/elsewhere/x.txt', 'one');
// A directory the session user may not search, holding a name.
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home/user/closed', { recursive: true, mode: 0o700 });
root.writeFile('home/user/closed/secret.txt', 'hidden');

// Nothing here names the files the program asks about, so no launch stages
// them: what it learns about them comes from the namespace, and their bytes
// from an asynchronous read.
const PROGRAM = `
const fs = require('fs');
const where = ['', 'home', 'user', 'else' + 'where'].join('/');
(async () => {
  const report = {
    exists: fs.existsSync(where + '/x.txt'),
    size: fs.existsSync(where + '/x.txt') ? fs.statSync(where + '/x.txt').size : null,
    names: fs.readdirSync(where).sort(),
    bytes: await fs.promises.readFile(where + '/x.txt', 'utf8'),
    closed: fs.existsSync(['', 'home', 'user', 'closed', 'secret.txt'].join('/')),
  };
  console.log(JSON.stringify(report));
})();
`;
const OPTS = { filename: '/home/user/app/script.js', cwd: '/home/user/app' };

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
async function run() {
  out = '';
  const result = await manager.exec(PROGRAM, OPTS);
  globalThis.console = real.console;
  globalThis.process = real.process;
  globalThis.Buffer = real.Buffer;
  assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
  const line = (out + result.stdout).trim().split('\n').at(-1);
  return JSON.parse(line);
}

const first = await run();
assert.deepEqual(first, { exists: true, size: 3, names: ['x.txt'], bytes: 'one', closed: false },
  'a one-shot sees every name its credential can see, and none it cannot');

// A peer's writes between two runs.
kfs.writeFile('home/user/elsewhere/x.txt', 'two!!');
kfs.writeFile('home/user/elsewhere/y.txt', 'y');
const second = await run();
assert.deepEqual(second, { exists: true, size: 5, names: ['x.txt', 'y.txt'], bytes: 'two!!', closed: false },
  'the next one-shot sees what a peer wrote between the runs');

console.log('one-shot-node-namespace: a one-shot answers stat, exists and readdir from the namespace, and sees a peer\'s writes between runs');
