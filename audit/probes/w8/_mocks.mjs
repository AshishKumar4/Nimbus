// Mocks for FacetProcessManager unit tests.
//
// Approach: we don't run real workerd; we exercise FacetProcessManager directly
// with a fake FacetManager that simulates "spawn a facet that runs `command
// args`" via a small interpreter. The interpreter understands a tiny set of
// pure-builtin commands (echo, cat, true, false, sleep, exit-code, env-print,
// fail-after, slow-output) sufficient for the state-machine tests. Real
// command execution is exercised in e2e probes.

import { EventEmitter } from 'node:events';

// ── Mock ProcessTable ─────────────────────────────────────────────────────
//
// Mirror src/process-table.ts shape closely enough that
// FacetProcessManager (which constructs ChildEntry independently) can also
// reuse the spawn/exit/kill methods.

export class MockProcessTable {
  constructor() {
    this.nextPid = 100;
    this.processes = new Map();
    this.facetToPid = new Map();
  }
  spawn(command, argv, cwd) {
    const pid = this.nextPid++;
    const facetName = `mock-proc-${pid}`;
    const entry = {
      pid, facetName, command, argv, cwd,
      state: 'running', exitCode: null,
      startTime: Date.now(), endTime: null,
    };
    this.processes.set(pid, entry);
    this.facetToPid.set(facetName, pid);
    return entry;
  }
  exit(pid, exitCode) {
    const e = this.processes.get(pid);
    if (!e) return;
    if (e.state !== 'running') return;
    e.state = 'exited';
    e.exitCode = exitCode;
    e.endTime = Date.now();
  }
  kill(pid) {
    const e = this.processes.get(pid);
    if (!e || e.state !== 'running') return false;
    e.state = 'killed'; e.exitCode = 137; e.endTime = Date.now();
    return true;
  }
  get(pid) { return this.processes.get(pid); }
  reap() { return 0; }
  get stats() {
    const all = [...this.processes.values()];
    return {
      total: all.length,
      running: all.filter(p => p.state === 'running').length,
      exited: all.filter(p => p.state === 'exited').length,
      killed: all.filter(p => p.state === 'killed').length,
      nextPid: this.nextPid,
    };
  }
}

// ── Mock ProcessLogStore ──────────────────────────────────────────────────
//
// Minimal: append + getExit.

export class MockProcessLogStore {
  constructor() { this.logs = new Map(); this.exits = new Map(); }
  append(pid, stream, data) {
    const arr = this.logs.get(pid) || [];
    arr.push({ stream, data, t: Date.now() });
    this.logs.set(pid, arr);
  }
  getExit(pid) { return this.exits.get(pid); }
  markExit(pid, code) { this.exits.set(pid, code); }
  read(pid, stream) {
    return (this.logs.get(pid) || [])
      .filter(e => !stream || e.stream === stream)
      .map(e => e.data).join('');
  }
}

// ── Mock FacetManager ─────────────────────────────────────────────────────
//
// Provides execStream(code, opts, hooks): Promise<exitCode>
// that runs a tiny test-only interpreter. Code shape: a JSON string with
// {command, args, env, cwd, stdin}. Output is written via hooks.onStdout/
// onStderr; exitCode returned via the promise.

const TEST_INTERPRETER = (() => {
  const fns = {
    echo: ({ args, hooks }) => { hooks.onStdout(args.join(' ') + '\n'); return 0; },
    'echo-no-newline': ({ args, hooks }) => { hooks.onStdout(args.join(' ')); return 0; },
    cat: ({ args, hooks, stdin }) => { hooks.onStdout(stdin || ''); return 0; },
    true: () => 0,
    false: () => 1,
    'exit-code': ({ args }) => parseInt(args[0]) || 0,
    'env-print': ({ env, hooks }) => {
      const k = arguments.length ? null : null;
      // Print specific env var if given, else all
      hooks.onStdout(JSON.stringify(env) + '\n');
      return 0;
    },
    'sleep-ms': async ({ args }) => {
      const ms = parseInt(args[0]) || 0;
      await new Promise(r => setTimeout(r, ms));
      return 0;
    },
    'slow-output': async ({ args, hooks }) => {
      // Emit chunks at intervals: arg0 = chunkCount, arg1 = chunkMs
      const n = parseInt(args[0]) || 3;
      const ms = parseInt(args[1]) || 50;
      for (let i = 0; i < n; i++) {
        await new Promise(r => setTimeout(r, ms));
        hooks.onStdout(`chunk${i}\n`);
      }
      return 0;
    },
    'split-streams': ({ hooks }) => {
      hooks.onStdout('out-line\n');
      hooks.onStderr('err-line\n');
      return 0;
    },
    'crash-after': async ({ args, hooks }) => {
      const n = parseInt(args[0]) || 1;
      for (let i = 0; i < n; i++) {
        hooks.onStdout(`pre-crash-${i}\n`);
      }
      throw new Error('synthetic crash');
    },
  };
  return { fns };
})();

export class MockFacetManager {
  constructor() {
    this.spawned = [];                  // log of all spawn calls
    this.activeFacets = new Map();      // facetName → { abortFn, killed }
  }

  /**
   * Run a child-facet command via the interpreter and stream output back.
   * Returns a promise that resolves when the command completes naturally
   * OR when killed via `kill(facetName)`.
   *
   * Shape mirrors the planned FacetManager.execStream(code, opts, hooks).
   */
  async execStream(code, opts, hooks) {
    // code is a JSON-ish payload describing command/args/env/cwd
    let payload;
    try { payload = typeof code === 'string' ? JSON.parse(code) : code; }
    catch { payload = { command: 'unknown', args: [], env: {}, cwd: '/' }; }

    this.spawned.push(payload);
    const facetName = opts.facetName || `mock-facet-${this.spawned.length}`;
    const slot = { killed: false, signal: null, abortFn: null };
    this.activeFacets.set(facetName, slot);

    const fn = TEST_INTERPRETER.fns[payload.command];
    if (!fn) {
      hooks.onStderr?.(`mock: command not found: ${payload.command}\n`);
      this.activeFacets.delete(facetName);
      return 127;
    }

    // If the command is async, race with kill
    let result;
    try {
      const runPromise = (async () => fn({
        args: payload.args || [],
        env: payload.env || {},
        cwd: payload.cwd || '/',
        stdin: payload.stdin || '',
        hooks,
      }))();
      const killPromise = new Promise((resolve) => {
        slot.abortFn = () => resolve({ killed: true });
      });
      result = await Promise.race([runPromise, killPromise]);
      if (result && typeof result === 'object' && result.killed) {
        // Killed mid-execution — supervisor stamps; we just return 137.
        return 137;
      }
    } catch (e) {
      hooks.onStderr?.(`Error: ${e.message}\n`);
      this.activeFacets.delete(facetName);
      return 1;
    }
    this.activeFacets.delete(facetName);
    return typeof result === 'number' ? result : 0;
  }

  /** Abort a running facet — invokes the registered abortFn. */
  abort(facetName, signal) {
    const slot = this.activeFacets.get(facetName);
    if (!slot) return false;
    slot.killed = true;
    slot.signal = signal;
    if (slot.abortFn) slot.abortFn();
    return true;
  }
}

// ── Mock SqliteVFS ────────────────────────────────────────────────────────
//
// Just enough surface for FacetProcessManager + e2e probes.

export class MockVfs {
  constructor() { this.files = new Map(); this.dirs = new Set(['']); }
  exists(p) {
    const s = p.replace(/^\/+/, '');
    return this.files.has(s) || this.dirs.has(s);
  }
  isDirectory(p) {
    return this.dirs.has(p.replace(/^\/+/, ''));
  }
  readFileString(p) {
    const s = p.replace(/^\/+/, '');
    if (!this.files.has(s)) throw new Error(`ENOENT: ${p}`);
    return this.files.get(s);
  }
  writeFile(p, content) {
    const s = p.replace(/^\/+/, '');
    this.files.set(s, content);
    // ensure parent dirs
    const parts = s.split('/');
    for (let i = 1; i < parts.length; i++) {
      this.dirs.add(parts.slice(0, i).join('/'));
    }
  }
  mkdir(p, _opts) {
    this.dirs.add(p.replace(/^\/+/, ''));
  }
  readdir(p) {
    const s = p.replace(/^\/+/, '');
    const out = [];
    const seen = new Set();
    const prefix = s ? s + '/' : '';
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const head = rest.split('/')[0];
      if (!head || seen.has(head)) continue;
      seen.add(head);
      const isDir = rest.includes('/');
      out.push({ name: head, type: isDir ? 'directory' : 'file' });
    }
    for (const d of this.dirs) {
      if (d === s) continue;
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      const head = rest.split('/')[0];
      if (!head || seen.has(head)) continue;
      seen.add(head);
      out.push({ name: head, type: 'directory' });
    }
    return out;
  }
  unlink(p) { this.files.delete(p.replace(/^\/+/, '')); }
  stat(p) {
    const s = p.replace(/^\/+/, '');
    if (this.files.has(s)) {
      const c = this.files.get(s);
      return { type: 'file', size: c.length, mtime: Date.now(), mode: 0o644 };
    }
    if (this.dirs.has(s)) {
      return { type: 'directory', size: 0, mtime: Date.now(), mode: 0o755 };
    }
    throw new Error(`ENOENT: ${p}`);
  }
}

// ── Construct a FacetProcessManager bound to mocks ────────────────────────

export function makeFpm(commandRegistry = null) {
  // Lazy-import here so importing this module doesn't require the impl
  // to exist (tests are written before src). We re-import per call so a
  // hot-edit in the impl is picked up by the next probe run.
  return import('../../../src/facet-process.js').then(({ FacetProcessManager }) => {
    const facetMgr = new MockFacetManager();
    const processTable = new MockProcessTable();
    const processLogs = new MockProcessLogStore();
    const vfs = new MockVfs();
    const registry = commandRegistry || new MockCommandRegistry();
    const fpm = new FacetProcessManager({
      facetMgr, processTable, processLogs, vfs, commandRegistry: registry,
    });
    return { fpm, facetMgr, processTable, processLogs, vfs, registry };
  });
}

// ── Mock command registry ─────────────────────────────────────────────────
//
// Mirrors the shape of the shell registry — just enough that
// FacetProcessManager can resolve "echo", "true", etc. as pure builtins.

export class MockCommandRegistry {
  constructor() {
    this._cmds = new Map();
    // Pure-builtin commands the supervisor can run inline.
    this._cmds.set('echo', { kind: 'pure-builtin' });
    this._cmds.set('echo-no-newline', { kind: 'pure-builtin' });
    this._cmds.set('cat', { kind: 'pure-builtin' });
    this._cmds.set('true', { kind: 'pure-builtin' });
    this._cmds.set('false', { kind: 'pure-builtin' });
    this._cmds.set('exit-code', { kind: 'pure-builtin' });
    this._cmds.set('env-print', { kind: 'pure-builtin' });
    this._cmds.set('split-streams', { kind: 'pure-builtin' });
    this._cmds.set('sleep-ms', { kind: 'pure-builtin' });
    this._cmds.set('slow-output', { kind: 'pure-builtin' });
    this._cmds.set('crash-after', { kind: 'pure-builtin' });
    // Facet-direct: would be node, npm, npx, git, sh, bash in real life
    this._cmds.set('node', { kind: 'facet-direct' });
    this._cmds.set('sh', { kind: 'facet-direct' });
    this._cmds.set('bash', { kind: 'facet-direct' });
  }
  /** Returns { kind } or null. */
  resolve(name) { return this._cmds.get(name) || null; }
  /** Run a pure-builtin synchronously, return {exitCode, stdout, stderr}. */
  async runPureBuiltin(name, args, env, cwd, stdin, hooks) {
    const fn = (await import('./_test-interpreter.mjs')).TEST_INTERPRETER.fns[name];
    if (!fn) {
      hooks?.onStderr?.(`mock-registry: ${name}: not found\n`);
      return 127;
    }
    return await fn({ args, env, cwd, stdin, hooks: hooks || {
      onStdout: () => {}, onStderr: () => {},
    } });
  }
}
