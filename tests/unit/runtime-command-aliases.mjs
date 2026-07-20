#!/usr/bin/env bun
// runtime-command-aliases — `nimbus install` command aliasing is
// catalog-driven: every command a runtime provides (manifest entrypoints
// plus RUNTIME_EXTRA_ENTRYPOINTS) resolves to that runtime. This test
// mechanically validates the one remaining hand-maintained table against
// the runtime ABI map in os-contracts, then proves alias resolution and
// command hints end-to-end against a fake runtime catalog.

import assert from 'node:assert/strict';
import {
  RUNTIME_EXTRA_ENTRYPOINTS,
  createRuntimeCommandHintResolver,
  installRuntimeProgrammatic,
  registerRunnerFactory,
} from '../../packages/worker/src/runtime/package-manager.ts';
import { NIMBUS_RUNTIME_ABIS } from '../../packages/worker/src/runtime/os-contracts.ts';

// ── 1. Mechanical validation against the runtime catalog contracts ─────

{
  const knownRuntimes = new Set(Object.keys(NIMBUS_RUNTIME_ABIS));
  const seenBins = new Set();
  for (const [runtime, entrypoints] of Object.entries(RUNTIME_EXTRA_ENTRYPOINTS)) {
    assert.ok(
      knownRuntimes.has(runtime),
      `RUNTIME_EXTRA_ENTRYPOINTS declares unknown runtime '${runtime}' — not in NIMBUS_RUNTIME_ABIS`,
    );
    for (const ep of entrypoints) {
      assert.ok(!seenBins.has(ep.binName), `duplicate extra command '${ep.binName}'`);
      seenBins.add(ep.binName);
      assert.equal(
        ep.runner,
        `${runtime}-runner`,
        `extra command '${ep.binName}' must dispatch to the ${runtime} runner`,
      );
      assert.deepEqual(ep.args, [], `extra command '${ep.binName}' must not inject args`);
    }
  }
}

// ── 2. Catalog-driven alias resolution against a fake catalog ──────────

const encoder = new TextEncoder();
const blobBytes = encoder.encode('#!nimbus-runtime-blob');
const blobSha = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', blobBytes)),
  (b) => b.toString(16).padStart(2, '0'),
).join('');

const manifests = {
  'manifests/python-0.29.4.json': {
    name: 'python',
    version: '0.29.4',
    license: 'PSF',
    wasi_namespace: null,
    files: [{ path: 'bin/python', content: 'blobs/python-0.29.4/bin', sha256: blobSha, size: blobBytes.length, mode: 'exec' }],
    entrypoints: [
      { binName: 'python', runner: 'python-runner', args: [] },
      { binName: 'python3', runner: 'python-runner', args: [] },
    ],
  },
  'manifests/clang-binji-2020.json': {
    name: 'clang',
    version: 'binji-2020',
    license: 'Apache-2.0',
    wasi_namespace: 'wasi_unstable',
    files: [{ path: 'bin/clang', content: 'blobs/clang-binji-2020/bin', sha256: blobSha, size: blobBytes.length, mode: 'exec' }],
    entrypoints: [
      { binName: 'clang', runner: 'clang-runner', args: [] },
      { binName: 'wasm-ld', runner: 'clang-runner', args: [], kind: 'linker' },
    ],
  },
};

const catalog = {
  version: 1,
  runtimes: {
    python: { default: '0.29.4', versions: { '0.29.4': { manifest: 'manifests/python-0.29.4.json', size_bytes: blobBytes.length, license: 'PSF' } } },
    clang: { default: 'binji-2020', versions: { 'binji-2020': { manifest: 'manifests/clang-binji-2020.json', size_bytes: blobBytes.length, license: 'Apache-2.0' } } },
  },
};

const fakeEnv = {
  NIMBUS_RUNTIME_CACHE: {
    async get(key) {
      let body = null;
      if (key === 'catalog/v1.json') body = JSON.stringify(catalog);
      else if (manifests[key]) body = JSON.stringify(manifests[key]);
      else if (key.startsWith('blobs/')) body = blobBytes;
      if (body === null) return null;
      return {
        async text() { return typeof body === 'string' ? body : new TextDecoder().decode(body); },
        async arrayBuffer() {
          const bytes = typeof body === 'string' ? encoder.encode(body) : body;
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  },
};

{
  const hint = createRuntimeCommandHintResolver(fakeEnv);
  // Runtime names resolve to themselves.
  assert.deepEqual(await hint('python'), { command: 'python', runtimeName: 'python', installSpec: 'python' });
  // Manifest-declared aliases are catalog-driven.
  assert.equal((await hint('python3'))?.runtimeName, 'python');
  assert.equal((await hint('wasm-ld'))?.runtimeName, 'clang');
  // Extra runner-provided commands resolve through the same path.
  assert.equal((await hint('pip'))?.runtimeName, 'python');
  assert.equal((await hint('pip3'))?.runtimeName, 'python');
  // Unknown commands and paths produce no hint.
  assert.equal(await hint('not-a-runtime'), null);
  assert.equal(await hint('./pip'), null);
  // Ruby is not in this catalog, so its extra commands must not hint.
  assert.equal(await hint('gem'), null);
}

// ── 3. `nimbus install <alias>` installs the providing runtime ─────────

class FakeVfs {
  constructor() {
    this.files = new Map();
    this.dirs = new Set(['']);
  }
  exists(path) { return this.files.has(path) || this.dirs.has(path); }
  mkdir(path) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }
  writeFile(path, content) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) this.mkdir(parent);
    this.files.set(path, content);
  }
  readFileString(path) {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`missing file: ${path}`);
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
  }
  readdir(path) {
    const prefix = `${path}/`;
    const out = new Map();
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest && !rest.includes('/')) out.set(rest, 'directory');
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes('/')) out.set(rest, 'file');
    }
    return [...out.entries()].map(([name, type]) => ({ name, type }));
  }
  unlink(path) { this.files.delete(path); }
  rmdir(path) { this.dirs.delete(path); }
}

{
  const registered = [];
  registerRunnerFactory('python-runner', (_manifest, _root, binName) => async () => {
    void binName;
    return 0;
  });
  const vfs = new FakeVfs();
  const registry = {
    register(name) { registered.push(name); },
  };
  const deps = { env: fakeEnv, vfs, registry, getHome: () => '/home/user' };

  const result = await installRuntimeProgrammatic(deps, 'pip');
  assert.equal(result.exitCode, 0, `install failed: ${result.stderr}`);
  assert.match(result.stdout, /\[python\] installed at home\/user\/\.nimbus\/runtimes\/python\/0\.29\.4/);
  assert.ok(vfs.exists('home/user/.nimbus/runtimes/python/0.29.4/manifest.json'));
  for (const bin of ['python', 'python3', 'pip', 'pip3']) {
    assert.ok(registered.includes(bin), `expected '${bin}' to be registered`);
  }

  // Unknown specs still fail loudly with the catalog hint.
  const missing = await installRuntimeProgrammatic(deps, 'gem');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /'gem' is not in catalog/);
}

console.log('runtime-command-aliases: ok');
