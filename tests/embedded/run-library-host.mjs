#!/usr/bin/env node
// Acceptance runner for the library-host recipe. Node, not Bun: Wrangler's
// unstable_startWorker owns a proxy whose event loop a synchronous child
// spawn would freeze, so every child here is spawned async on purpose.
//
// Lifecycle, in order:
//   1. pack-consumer.mjs packs the workspace into a consumer fixture and
//      prints PACKED_CONSUMER=<dir>;
//   2. unstable_startWorker serves that fixture (port 0, inspector/watch off);
//   3. await worker.ready, spawn the Bun probe (hosted-runtime.mjs) async;
//   4. pass/fail on the probe's exit; worker.dispose() in finally either way.
// Packed dir + probe/runner logs are retained under one directory — never
// removed, whatever the verdict.
//
// Env overrides the lifecycle harness uses to drive pass/fail/cleanup without
// the full stack:
//   LIBRARY_HOST_CONSUMER_DIR — skip packing; serve this fixture dir instead
//   LIBRARY_HOST_PROBE        — spawn this probe instead of hosted-runtime.mjs
//   RUNNER_LOG_DIR            — logs dir (default: mktemp library-host-runner-*)

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let activeChild;
let interrupted = false;
const stop = () => {
  interrupted = true;
  activeChild?.kill('SIGTERM');
  void disposeWorker().catch(() => {});
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const logDir = process.env.RUNNER_LOG_DIR
  || mkdtempSync(join(tmpdir(), 'library-host-runner-'));
mkdirSync(logDir, { recursive: true });
const log = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  appendFileSync(join(logDir, 'runner.log'), `${stamped}\n`);
  console.log(stamped);
};

/** Run a script async, tee output to <name>.log, resolve to its exit code. */
function runLogged(name, command, args, env, cwd) {
  const path = join(logDir, `${name}.log`);
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    child.stdout.on('data', (d) => appendFileSync(path, d));
    child.stderr.on('data', (d) => appendFileSync(path, d));
    child.on('close', (code) => {
      if (activeChild === child) activeChild = undefined;
      resolvePromise(code ?? 1);
    });
    child.on('error', (err) => { appendFileSync(path, `${err}\n`); resolvePromise(1); });
  });
}

const token = randomBytes(32).toString('hex');
let worker;
let disposal;
let exitCode = 1;

function disposeWorker() {
  if (!worker) return Promise.resolve();
  disposal ??= worker.dispose();
  return disposal;
}

try {
  // ── 1. packed consumer dir (or a caller-supplied fixture) ──────────────────
  let consumerDir = process.env.LIBRARY_HOST_CONSUMER_DIR;
  if (!consumerDir) {
    log('packing consumer (bun tests/embedded/pack-consumer.mjs)');
    const packExit = await runLogged('pack-consumer', 'bun', [join(here, 'pack-consumer.mjs')], {}, here);
    const packOut = readFileSync(join(logDir, 'pack-consumer.log'), 'utf8');
    const match = packOut.match(/PACKED_CONSUMER=(\S+)/);
    if (packExit !== 0 || !match) {
      throw new Error(`pack-consumer failed (exit ${packExit}); see ${logDir}/pack-consumer.log`);
    }
    consumerDir = match[1];
    log(`packed consumer at ${consumerDir}`);
  } else {
    consumerDir = resolve(consumerDir);
    log(`using supplied consumer dir ${consumerDir}`);
  }

  // ── 2. workerd through Wrangler: port 0, no inspector, no watch ────────────
  if (interrupted) throw new Error('Acceptance interrupted');
  const requireConsumer = createRequire(join(consumerDir, 'package.json'));
  const { unstable_startWorker } = requireConsumer('wrangler');
  log('starting worker (port 0, inspector off, watch off)');
  worker = await unstable_startWorker({
    config: join(consumerDir, 'wrangler.jsonc'),
    entrypoint: join(consumerDir, 'index.ts'),
    name: 'library-host-acceptance',
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      liveReload: false,
      watch: false,
      logLevel: 'warn',
    },
    bindings: { TEST_TOKEN: { type: 'plain_text', value: token } },
  });
  await worker.ready;
  if (interrupted) throw new Error('Acceptance interrupted');
  const url = await worker.url;
  log(`worker ready at ${url}`);
  writeFileSync(join(logDir, 'worker.url'), `${url}\n`);

  // ── 3. async Bun probe — sync spawn would freeze the Wrangler proxy loop ───
  const probe = resolve(process.env.LIBRARY_HOST_PROBE || join(here, 'hosted-runtime.mjs'));
  // The probe's contract with the runner is BASE + NIMBUS_PROBE_TOKEN.
  log(`spawning probe: bun ${probe} (BASE=${url})`);
  const probeExit = await runLogged('probe', 'bun', [probe, '--require-shared-isolate'], {
    BASE: url.origin,
    NIMBUS_PROBE_TOKEN: token,
  }, here);

  exitCode = !interrupted && probeExit === 0 ? 0 : 1;
  log(`probe exited ${probeExit} → ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
} catch (err) {
  log(`runner error: ${err?.stack || err}`);
  exitCode = 1;
} finally {
  // ── 4. dispose always; keep everything for postmortem ──────────────────────
  if (worker) {
    try {
      await disposeWorker();
      log('worker disposed');
    } catch (err) {
      log(`worker.dispose failed: ${err}`);
      exitCode = 1;
    }
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  log(`logs retained at ${logDir}`);
  writeFileSync(join(logDir, 'verdict'), `${exitCode}\n`);
}

process.exit(exitCode);
