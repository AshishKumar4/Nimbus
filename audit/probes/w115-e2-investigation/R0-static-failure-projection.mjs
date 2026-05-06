#!/usr/bin/env node
// W11.5-E2 / R0 — Static-analysis projection of the next dev failure
// stack against Nimbus's W8 substrate.
//
// Method: walk Next 14.2.0's known dev-server boot sequence + webpack
// 5's compiler.run() + jest-worker's WorkerPool, and check at each
// callsite whether Nimbus's substrate satisfies the expected POSIX
// behavior. Each row is annotated with the source-of-truth file we'd
// cite in the plan (Next/webpack source on the public GitHub mirrors
// + Nimbus src/ files for the substrate side).
//
// This is a STATIC PROJECTION — we do NOT run next dev. The dynamic
// reproduction is gated on user OAuth (see next-dev-probe-attempted.md).
//
// Output: TAP-style lines + a final summary. Always exits 0.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function tap(name, ok, detail) {
  console.log(`${ok ? 'ok' : 'not ok'} - ${name}${detail ? ' # ' + detail : ''}`);
}
function note(s) { console.log('# ' + s); }

note('R0 — Static failure-stack projection for `next dev` on Nimbus');
note('source-of-truth refs:');
note('  next 14.2.0:       https://github.com/vercel/next.js/tree/v14.2.0/packages/next');
note('  webpack 5.x:       https://github.com/webpack/webpack/tree/v5.90.0/lib');
note('  jest-worker 27/29: https://github.com/jestjs/jest/tree/main/packages/jest-worker');

// ── Next 14.2 dev boot sequence (reconstructed from public source) ──
//
// 1. bin/next               → require('../dist/cli/next-dev')
// 2. dist/cli/next-dev.js   → spawn `node` worker via createWorker()
//                              from lib/worker.ts, args=['__NEXT_DEV_WORKER']
// 3. dist/server/lib/router-utils/setup-dev-bundler.ts
//                            → new HotReloader (webpack-based) OR Turbopack
// 4. dist/server/lib/router-utils/setup-dev-bundler.ts
//                            → ALSO spawns "render-server" + "jest-worker"
//                              pool for SSR (next/dist/compiled/jest-worker)
// 5. webpack 5 compiler.run()
//                            → if (config.parallelism > 1) uses
//                              jest-worker for terser-webpack-plugin
//                              and CssMinimizerPlugin + thread-loader
// 6. terser-webpack-plugin 5.x:
//                            → require('jest-worker'), spawns N workers
//                              via child_process.fork()
// 7. jest-worker:
//                            → child_process.fork(workerPath, [], {
//                                stdio: ['pipe','pipe','pipe','ipc']
//                              })  ← ICP CHANNEL is the load-bearing bit
// 8. Inside each worker: re-imports webpack/loaders to compile chunks
//
// Steps 1-3 give us THREE distinct child_process layers stacked:
//   parent shell → next-dev worker → render-server worker → jest-worker(s)
// Each of those stacks call .fork() + IPC.

// ── Map each step against Nimbus's substrate ────────────────────────
const steps = [
  {
    name: 'S1. shell→`next dev` resolves bin',
    nimbus: '_CP_FACET_DIRECT extension already added in W11 (next is in the list)',
    file: 'src/nimbus-session-helpers.ts',
    lineHint: 'BUNDLER_BIN_PREFIXES @ ~352',
    expectsPass: true,
    note: 'verified GREEN in W11 detect-next.mjs probe',
  },
  {
    name: 'S2. `next dev` does cp.fork(`./dist/server/lib/start-server.js`)',
    nimbus: 'fork() shim (node-shims.ts:1543) does spawn `node modulePath`; IPC over stdin queue + stdout newline-JSON',
    file: 'src/node-shims.ts',
    lineHint: 'fork @ 1543-1648',
    expectsPass: 'partial — fork CALL works; IPC SHAPE will mismatch in S6',
    note: 'this is the gate W11.5-E1 owns; orthogonal to E2 BUT must complete first',
  },
  {
    name: 'S3. start-server.js spawns "render-server" via createWorker → cp.fork(render-server.js)',
    nimbus: 'recursive fork: child_process.fork() called from inside a facet → routes back to SUPERVISOR.cpSpawn',
    file: 'src/facet-process.ts',
    lineHint: 'CHILD_PROCESS_MAX_DEPTH=8 @ 191',
    expectsPass: 'depth budget OK at this layer (depth=2)',
    note: 'W8 NIMBUS_CP_DEPTH propagation is in place (facet-process.ts:232-241)',
  },
  {
    name: 'S4. render-server requires next/dist/compiled/webpack',
    nimbus: 'webpack 5 imports @ load time: terser-webpack-plugin, css-minimizer-webpack-plugin',
    file: 'src/require-resolver.ts',
    lineHint: 'prefetchForRequire',
    expectsPass: 'unverified — webpack is in SKIP_PACKAGES (npm-resolver.ts:886). Parallel skip lists list webpack alongside vite/parcel/typescript. A fresh next install MAY put webpack into node_modules anyway since next bundles its own copy under next/dist/compiled/webpack/',
    note: 'X.5-F retro recorded webpack ✅ install. Confirm via next-dev-probe-attempted.md',
  },
  {
    name: 'S5. webpack runs compiler.run() which spawns terser-webpack-plugin pool',
    nimbus: 'terser internally requires jest-worker',
    file: 'n/a (userspace package)',
    lineHint: 'jest-worker uses child_process.fork',
    expectsPass: 'fork call goes through node-shims → cpSpawn',
    note: 'depth=3 at this layer; still under cap of 8',
  },
  {
    name: 'S6. jest-worker child_process.fork(... stdio: [..., "ipc"])',
    nimbus: 'IPC channel: real Node v8.serialize over Unix domain socket; Nimbus\'s fork() does JSON-newline over stdin queue',
    file: 'src/node-shims.ts',
    lineHint: 'fork @ 1556 — NIMBUS_FORK_IPC=1; stdin/stdout multiplexed',
    expectsPass: false,
    note: 'W11.5-E1 GATE: ipc shape mismatch. jest-worker uses parent.send({type:0, args:[...]}) and child.send({type:1, ok}). Buffers in args become {type:"Buffer", data:[]} — terser-webpack-plugin receives malformed input. Tracked separately.',
  },
  {
    name: 'S7. jest-worker WorkerPool concurrency = os.cpus().length (default)',
    nimbus: 'Nimbus os.cpus() returns synthetic 4-CPU array (node-shims.ts:os shim) → jest-worker spawns 4 children',
    file: 'src/node-shims.ts (os shim)',
    lineHint: 'see os.cpus search',
    expectsPass: 'PARTIALLY — 4 child workers from EACH webpack pool; multiple webpack passes (server bundle, client bundle, edge bundle) → up to 12 concurrent jest-workers',
    note: 'this is the H1 facet-count-cap hypothesis. NimbusFacetPool default concurrency=4 (facet-pool.ts:233). 12+ concurrent fork() calls is the cap-pressure scenario.',
  },
  {
    name: 'S8. Each jest-worker child reloads webpack itself + tries to compile ITS chunks',
    nimbus: 'webpack inside a child cp facet: needs another fork()? NO — it uses worker_threads.Worker for thread-loader OR keeps it inline.',
    file: 'src/node-shims.ts',
    lineHint: 'worker_threads stub @ 1845',
    expectsPass: false,
    note: 'H5 hypothesis: terser+babel may use worker_threads for sub-parallelism. Our worker_threads stub is a NO-OP class (Worker class with terminate() returning Promise.resolve(0)). Anything that postMessage()s and waits for a reply will hang.',
  },
  {
    name: 'S9. webpack writes .next/cache + emits .next/server/* + .next/static/*',
    nimbus: 'fs.writeFileSync from inside facet → __vfsWrites → flushed on facet exit',
    file: 'src/facet-manager.ts',
    lineHint: '_flushVfsWrites @ 1317',
    expectsPass: true,
    note: 'works; but vfs flush is at facet exit, so HMR-style incremental writes during a long-running webpack server are NOT live until exit. Causes the dev server to never see its own emitted bundle.',
  },
  {
    name: 'S10. dev server hibernates if idle 30 s before first request',
    nimbus: 'DO hibernation: facets get torn down; in-flight webpack pool dies mid-build',
    file: 'src/nimbus-session-hib.ts',
    lineHint: 'W9 hibernation surface',
    expectsPass: false,
    note: 'H6 hypothesis: hibernation mid-build kills child facets. webpack first build can take 10-45 s on a non-trivial app; well within idle-window if the user only types `npm run dev` and waits for the URL.',
  },
];

let passes = 0, fails = 0, partial = 0;
for (const s of steps) {
  const ok = s.expectsPass === true;
  if (ok) passes++;
  else if (s.expectsPass === false) fails++;
  else partial++;
  tap(s.name, ok, `${s.file}:${s.lineHint} → ${typeof s.expectsPass === 'string' ? s.expectsPass : (ok ? 'expected pass' : 'expected fail')}`);
  note('   ' + s.note);
}

note('');
note(`Projected outcome: ${passes} pass, ${partial} partial, ${fails} hard-fail steps in the next-dev sequence`);
note('');
note('Failure ordering when next dev is run today (without W11 loud-block):');
note('  1. S6 fires first: jest-worker.fork() ipc=ipc fails because shim has no `ipc` stdio kind.');
note('     → next emits "Error: Channel closed" or hangs at stage "creating an optimized production build…"');
note('  2. With S6 worked-around (E1 lands first), S7 fires: 12 concurrent fork calls saturate facet pool.');
note('     → cpSpawn returns EAGAIN at depth-8 OR parent-side facet count exceeds workerd subrequest budget.');
note('  3. With S7 mitigated (E2 lands), S8 fires: terser uses worker_threads to fan out hashing.');
note('     → silent hang at MessagePort.postMessage (our stub is no-op).');
note('  4. With S8 mitigated, S10 fires after first ~30s idle: hibernation kills mid-build child facets.');
note('     → user sees "Module not found" because half the chunks never wrote back to VFS.');
note('');
note('E2 SCOPE: addresses S7 (and partial S8 if option includes worker_threads coalescing).');
note('E2 OUT-OF-SCOPE: S6 (E1), S10 (W9.5), S4 install pipeline (assumed working, X.5-F evidence).');

console.log('1..' + steps.length);
