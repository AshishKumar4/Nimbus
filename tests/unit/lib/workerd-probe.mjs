// The production engine, locally: apps/probe under `wrangler dev --local`.
//
// This is workerd (the same build production runs, from the repo's own
// wrangler) running the real embedder: the session Durable Object, its
// SQLite, the LOADER binding that makes each facet a dynamic worker, and
// JSPI parking, which bun and node 22 do not have. A unit test that needs
// what only workerd does (a guest that parks mid-syscall) drives it through
// here, over the same HTTP and terminal API the behavioral probes use.
//
// startLocalProbe() stages the requested runtimes the way the publisher
// does (scripts/bundle-runtime.mjs --npm-package, from the repo's own wasm,
// no network), seeds them into the local R2 the worker installs from, boots
// the worker on a free port with a fresh JWT secret, and returns its base
// URL and a probe token. stop() ends the worker and removes every file the
// harness made. The worker runs the build in the tree: a test of changed
// runner code needs the generated artifacts rebuilt first (dist-integrity,
// or packages/worker/scripts/bundle-facet-workers.mjs).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { mintProbeToken } from '../../behavioral/_mint-probe-token.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const PROBE_APP = join(REPO, 'apps/probe');
const WRANGLER = join(REPO, 'node_modules/.bin/wrangler');
const BUNDLE_RUNTIME = join(REPO, 'packages/worker/scripts/bundle-runtime.mjs');
/** The runtimes a local probe can stage, as the publisher names them. */
const RUNTIME_VERSIONS = { bash: '5.2.37-3' };
const BUCKET = 'nimbus-runtime-cache';

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolvePort(port));
    });
  });
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} exited ${result.status}: ${(result.stderr || result.stdout).slice(-1200)}`);
  }
  return result;
}

/**
 * The objects `nimbus install <name>` reads, from the publisher's own npm
 * package: each blob at its content key, the manifest, and a catalog entry
 * carrying the manifest's digest.
 */
function stageRuntime(name, work) {
  const version = RUNTIME_VERSIONS[name];
  if (!version) throw new Error(`workerd-probe: no local staging for runtime '${name}'`);
  const pkg = join(work, `pkg-${name}`);
  run(process.execPath.endsWith('bun') ? 'node' : process.execPath, [BUNDLE_RUNTIME, name, version, '--npm-package', pkg], {
    cwd: join(REPO, 'packages/worker'),
    env: { ...process.env, TMPDIR: work },
  });
  const manifestPath = join(pkg, 'manifest.json');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const puts = [];
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.content)) continue;
    seen.add(file.content);
    puts.push({ key: file.content, file: join(pkg, file.content) });
  }
  const manifestKey = `manifests/${name}-${version}.json`;
  puts.push({ key: manifestKey, file: manifestPath, contentType: 'application/json' });
  const entry = {
    manifest: manifestKey,
    manifest_sha256: new Bun.CryptoHasher('sha256').update(manifestBytes).digest('hex'),
    size_bytes: [...new Map(manifest.files.map((f) => [f.content, f.size])).values()].reduce((a, b) => a + b, 0),
    license: manifest.license,
  };
  return { name, version, entry, puts };
}

async function putObjects(puts, persist, work, wrangler) {
  // One at a time: each is a wrangler process with its own workerd over the
  // same local store, and two at once crash it.
  const queue = [...puts];
  const worker = async () => {
    while (queue.length) {
      const { key, file, contentType } = queue.shift();
      console.log(`workerd-probe: staging ${key} (${queue.length} remaining)`);
      await new Promise((done, fail) => {
        const args = ['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--local', '--persist-to', persist];
        if (contentType) args.push('--content-type', contentType);
        // wrangler writes its own files (an update check) under TMPDIR: the harness's, which stop() removes.
        const child = spawn(wrangler, args, { cwd: PROBE_APP, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: work } });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? done() : fail(new Error(`r2 put ${key}: ${err.slice(-600)}`))));
      });
    }
  };
  await worker();
}

/**
 * End a wrangler dev process and its whole group: wrangler spawns workerd
 * and an esbuild service beneath it, and they outlive it. One left behind
 * holds the stderr this process reads, so this process never exits
 * (measured: an esbuild service, reparented to init, 3 of 48 copies of a
 * test at eight at once, each after its first wrangler lost its bind).
 * @param {import('node:child_process').ChildProcess} child
 */
async function endGroup(child) {
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((done) => { child.once('close', done); setTimeout(done, 5000); });
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
}

/**
 * Boot apps/probe on workerd with `runtimes` installable, and `vars` over
 * its config vars (`wrangler dev --var`). `wrangler` is the binary to run
 * (this lib's own test passes a stand-in).
 * @returns {Promise<{ base: string, token: string, stop: () => Promise<void>, log: () => string, pid: number }>}
 */
export async function startLocalProbe({ runtimes = ['bash'], bootTimeoutMs = 180_000, vars = {}, wrangler = WRANGLER } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'workerd-probe-'));
  const persist = join(work, 'state');
  let child = null;
  const stop = async () => {
    if (child) await endGroup(child);
    rmSync(work, { recursive: true, force: true });
  };
  try {
    const staged = runtimes.map((name) => stageRuntime(name, work));
    const catalog = { version: 1, runtimes: {} };
    for (const { name, version, entry } of staged) catalog.runtimes[name] = { default: version, versions: { [version]: entry } };
    const catalogPath = join(work, 'catalog.json');
    await Bun.write(catalogPath, JSON.stringify(catalog, null, 2));
    // The worker reads the catalog its NIMBUS_RUNTIME_CATALOG_SHA256 var
    // names, by that digest: this one, staged under it and passed below.
    const catalogSha256 = createHash('sha256').update(readFileSync(catalogPath)).digest('hex');
    await putObjects([...staged.flatMap((s) => s.puts), { key: `catalog/sha256/${catalogSha256}.json`, file: catalogPath, contentType: 'application/json' }], persist, work, wrangler);

    const secret = randomBytes(24).toString('hex');
    const deadline = Date.now() + bootTimeoutMs;
    let log = '';
    let base = null;
    // The free port can be taken by another test's server before wrangler
    // binds it. That server would answer a probe of the port, and wrangler
    // exits on the bind: so the address is the one wrangler says it is ready
    // on, and a lost bind is retried on another port.
    for (let attempt = 1; base === null; attempt++) {
      const port = await freePort();
      console.log('workerd-probe: starting wrangler dev');
      log = '';
      child = spawn(wrangler, [
        'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
        '--show-interactive-dev-session=false', '--var', `JWT_SECRET:${secret}`,
        '--var', `NIMBUS_RUNTIME_CATALOG_SHA256:${catalogSha256}`,
        ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`]),
      ], { cwd: PROBE_APP, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, TMPDIR: work } });
      // wrangler dev rebuilds and reloads the worker when a file it bundles
      // changes, which resets every session it serves: a test running then
      // fails on a socket closed with 1006 and nothing else to say why
      // (measured: touching one file under packages/worker/dist mid-test).
      // So the reload is named where the failing test prints.
      const watchReload = (d) => {
        log += d;
        if (base !== null && /Reloading local server/.test(String(d))) {
          console.error('workerd-probe: wrangler dev reloaded the worker because a file it bundles changed '
            + '(this tree was rebuilt while the probe ran); every session it served was reset, so a '
            + 'command running now fails with a 1006 close');
        }
      };
      child.stdout.on('data', watchReload);
      child.stderr.on('data', watchReload);
      for (;;) {
        if (child.exitCode !== null) {
          if (attempt < 3 && /Address already in use/.test(log)) {
            await endGroup(child);
            break;
          }
          throw new Error(`wrangler dev exited ${child.exitCode}:\n${log.slice(-2000)}`);
        }
        const ready = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
        if (ready) {
          try {
            const response = await fetch(`${ready[1]}/`, { signal: AbortSignal.timeout(2000) });
            await response.arrayBuffer();
            base = ready[1];
            break;
          } catch { /* not answering yet */ }
        }
        if (Date.now() > deadline) throw new Error(`wrangler dev did not answer within ${bootTimeoutMs} ms:\n${log.slice(-2000)}`);
        await Bun.sleep(250);
      }
    }
    const token = await mintProbeToken(secret, 3_600_000);
    // pid: the wrangler dev process group, whose members serve the probe.
    return { base, token, stop, log: () => log, pid: child.pid };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * A terminal session on a local probe with `nimbus install <runtime>` done,
 * running commands through the real shell. `run(command)` returns the
 * command's own output (the echo and prompts stripped) and its exit status.
 *
 * A command is done when its completion marker has printed its status and
 * the prompt is back, not at the first output that ends like a prompt.
 * `timeoutMs` bounds the wait. Work a loaded machine can stretch past any
 * bound passes `{ progress, stalledMs }` too: `progress()` fingerprints what
 * the command is doing (the session's Dynamic Worker ledger, say), and the
 * wait then fails once neither it nor the terminal's output has changed for
 * `stalledMs`, or at `timeoutMs` however it moves.
 */
export async function localTerminal(probe, { install = ['bash'] } = {}) {
  process.env.BASE = probe.base;
  process.env.NIMBUS_PROBE_TOKEN = probe.token;
  const { mintSession, deleteSession, Terminal, requestHeaders } = await import('../../behavioral/_driver.mjs');
  const sid = await mintSession();
  const terminal = new Terminal(sid);
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  /** Its answer, or `undefined` if it has none within `ms` (a session too busy to answer has not moved). */
  const within = (promise, ms) => {
    let timer;
    return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
  };
  const wait = async (line, done, timeoutMs, progress, stalledMs) => {
    if (!progress) return terminal.waitFor(done, timeoutMs, line.slice(0, 80));
    const started = Date.now();
    const look = async () => JSON.stringify([await within(progress().catch((error) => `progress: ${error.message}`), 30_000), terminal.buf.length]);
    let seen = await look();
    let moved = Date.now();
    for (;;) {
      try {
        return await terminal.waitFor(done, Math.max(1, Math.min(5_000, timeoutMs - (Date.now() - started))), line.slice(0, 80));
      } catch (error) {
        if (!/timeout after/.test(error.message)) throw error;
      }
      const now = await look();
      if (now !== seen) { seen = now; moved = Date.now(); }
      const still = Date.now() - moved;
      if (still >= stalledMs || Date.now() - started >= timeoutMs) {
        throw new Error(`${line}: ${still >= stalledMs ? `nothing moved for ${still} ms` : `not done after ${timeoutMs} ms, still moving`}; `
          + `progress ${seen.slice(0, 1500)}; tail: ${JSON.stringify(strip(terminal.buf).slice(-400))}`);
      }
    }
  };
  let serial = 0;
  /**
   * @param {string} command
   * @param {number} [timeoutMs]
   * @param {{ progress?: () => Promise<unknown>, stalledMs?: number }} [options]
   */
  const run = async (command, timeoutMs = 120_000, { progress, stalledMs = 120_000 } = {}) => {
    const mark = `__NIMBUS_DONE_${++serial}__`;
    const line = `${command}; echo "${mark}$?"`;
    // The echoed line carries the marker too, followed by `$?`, never by
    // digits. The prompt after the marker's line is the shell's; it need not
    // end the buffer, where a background job's banner may follow it.
    const done = new RegExp(`${mark}\\d+\\s*\\n[\\s\\S]*?[$#>](\\s|$)`);
    terminal.reset();
    terminal.cmd(line);
    await wait(line, (b) => done.test(b), timeoutMs, progress, stalledMs);
    const text = strip(terminal.buf);
    const end = text.lastIndexOf(mark);
    if (end < 0) throw new Error(`${command}: no completion marker within ${timeoutMs} ms:\n${text.slice(-800)}`);
    const status = Number(/^\d+/.exec(text.slice(end + mark.length))?.[0]);
    // What the command printed: after the echoed command line, before the marker.
    const echoed = text.lastIndexOf(`echo "${mark}$?"`);
    const start = text.indexOf('\n', echoed) + 1;
    return { stdout: text.slice(start, end), status };
  };
  for (const name of install) {
    const r = await run(`nimbus install ${name}`, 240_000);
    if (r.status !== 0) throw new Error(`nimbus install ${name} failed (${r.status}):\n${r.stdout.slice(-800)}`);
  }
  return {
    run,
    /** The session's id, and its terminal as the driver holds it (raw input, waitFor). */
    sid,
    terminal,
    /** Write `content` to `path` in the session (base64 through node, no quoting hazards). */
    writeFile: async (path, content) => {
      const b64 = Buffer.from(content).toString('base64');
      const r = await run(`node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}', 'base64'))"`);
      if (r.status !== 0) throw new Error(`writing ${path} failed (${r.status}):\n${r.stdout.slice(-800)}`);
    },
    /** The session's /api/_diag/memory: its counters, VFS cache and heap estimate. */
    memory: async () => {
      const response = await fetch(`${probe.base}/s/${sid}/api/_diag/memory`, { cache: 'no-store', headers: requestHeaders() });
      if (!response.ok) throw new Error(`_diag/memory: HTTP ${response.status}`);
      return response.json();
    },
    close: async () => { await terminal.close(); await deleteSession(sid); },
  };
}

/**
 * A scenario's stdout: its lines, with the session's own banners (a facet's
 * start, an npm script's), which go to the terminal, dropped and its timing
 * lines (`T <ms> <label>`) set aside by label.
 */
export function splitScenarioOutput(text) {
  const lines = text.split('\n').map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith('[facet started') && !l.startsWith('[shell started'));
  const timings = {};
  for (const line of lines) {
    const m = /^T (\d+) (.+)$/.exec(line);
    if (m) timings[m[2]] = Number(m[1]);
  }
  return { lines: lines.filter((l) => !/^T \d+ /.test(l)), timings };
}
