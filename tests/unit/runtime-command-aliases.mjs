#!/usr/bin/env bun
// runtime-command-aliases — `nimbus install` command aliasing is
// catalog-driven: every command a runtime provides (manifest entrypoints
// plus RUNTIME_EXTRA_ENTRYPOINTS) resolves to that runtime. This test
// mechanically validates the one remaining hand-maintained table against
// the runtime ABI map in os-contracts, then proves alias resolution and
// command hints end-to-end against a fake runtime catalog.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createRuntimeCommandHintResolver,
  installRuntimeProgrammatic,
  runtimeCatalogSource,
} from '../../packages/worker/src/runtime/package-manager.ts';
import { RuntimeManager } from '../../packages/core/src/runtime/runtime-manager.ts';
import {
  RUNTIME_EXTRA_ENTRYPOINTS,
} from '../../packages/core/src/runtime/installed-runtimes.ts';
import { NIMBUS_RUNTIME_ABIS } from '../../packages/core/src/runtime/os-contracts.ts';

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
      // `<runtime>-runner`, with `@<contract>` once a rebuild has changed
      // the artifact contract the runner binds (see BASH_RUNNER).
      assert.match(
        ep.runner,
        new RegExp(`^${runtime}-runner(@\\d+)?$`),
        `extra command '${ep.binName}' must dispatch to the ${runtime} runner`,
      );
      assert.deepEqual(ep.args, [], `extra command '${ep.binName}' must not inject args`);
    }
  }
  assert.deepEqual(
    RUNTIME_EXTRA_ENTRYPOINTS.bash?.map((entrypoint) => entrypoint.binName),
    ['/bin/bash', '/usr/bin/bash'],
    'the real bash runtime must own every absolute bash alias',
  );
}

// ── 2. Catalog-driven alias resolution against a fake catalog ──────────

const encoder = new TextEncoder();
const blobBytes = encoder.encode('#!nimbus-runtime-blob');
const blobSha = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', blobBytes)),
  (b) => b.toString(16).padStart(2, '0'),
).join('');

const manifests = {
  'manifests/cpython-3.13.14.json': {
    name: 'cpython',
    version: '3.13.14',
    license: 'PSF-2.0',
    wasi_namespace: 'wasi_snapshot_preview1',
    files: [{ path: 'bin/python', content: 'blobs/cpython-3.13.14/bin', sha256: blobSha, size: blobBytes.length, mode: 'exec' }],
    entrypoints: [
      { binName: 'python', runner: 'cpython-runner', args: [] },
      { binName: 'python3', runner: 'cpython-runner', args: [] },
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
    cpython: { default: '3.13.14', versions: { '3.13.14': { manifest: 'manifests/cpython-3.13.14.json', size_bytes: blobBytes.length, license: 'PSF-2.0' } } },
    clang: { default: 'binji-2020', versions: { 'binji-2020': { manifest: 'manifests/clang-binji-2020.json', size_bytes: blobBytes.length, license: 'Apache-2.0' } } },
  },
};

/**
 * An R2 binding serving `catalogJson` and `manifestsByKey`, with the
 * deployment's pin: it names its catalog by digest, and the bucket holds it
 * under that digest.
 */
const catalogEnv = (catalogJson, manifestsByKey) => {
  const catalogText = JSON.stringify(catalogJson);
  const catalogSha256 = createHash('sha256').update(catalogText).digest('hex');
  return {
    NIMBUS_RUNTIME_CATALOG_SHA256: catalogSha256,
    NIMBUS_RUNTIME_CACHE: {
      async get(key) {
        let body = null;
        if (key === `catalog/sha256/${catalogSha256}.json`) body = catalogText;
        else if (manifestsByKey[key]) body = JSON.stringify(manifestsByKey[key]);
        else if (key.startsWith('blobs/')) body = blobBytes;
        if (body === null) return null;
        const bytes = typeof body === 'string' ? encoder.encode(body) : body;
        return {
          async text() { return new TextDecoder().decode(bytes); },
          async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
          get body() { return new Response(bytes).body; },
        };
      },
    },
  };
};
const fakeEnv = catalogEnv(catalog, manifests);

{
  const hint = createRuntimeCommandHintResolver(fakeEnv);
  // Runtime names resolve to themselves. `python` is provided by the cpython
  // runtime now, and the hint names the runtime that will actually serve it.
  assert.equal((await hint('python'))?.runtimeName, 'cpython');
  // Manifest-declared aliases are catalog-driven.
  assert.equal((await hint('python3'))?.runtimeName, 'cpython');
  assert.equal((await hint('wasm-ld'))?.runtimeName, 'clang');
  // Extra runner-provided commands resolve through the same path.
  assert.equal((await hint('pip'))?.runtimeName, 'cpython');
  assert.equal((await hint('pip3'))?.runtimeName, 'cpython');
  // Unknown commands and paths produce no hint.
  assert.equal(await hint('not-a-runtime'), null);
  assert.equal(await hint('./pip'), null);
  // Ruby is not in this catalog, so its extra commands must not hint.
  assert.equal(await hint('gem'), null);
}

// ── 2b. A superseded runtime answers hints as it answers installs ──────
// The shared catalog still lists Pyodide's `python` beside `cpython`. A bare
// `python` installs cpython, and a command only `python` provides installs
// nothing, so neither may be hinted at otherwise.
{
  const withPyodide = {
    ...catalog,
    runtimes: {
      python: { default: '0.27.0', versions: { '0.27.0': { manifest: 'manifests/python-0.27.0.json', size_bytes: blobBytes.length, license: 'MPL-2.0' } } },
      ...catalog.runtimes,
    },
  };
  const pyodideManifest = {
    name: 'python',
    version: '0.27.0',
    license: 'MPL-2.0',
    wasi_namespace: 'wasi_snapshot_preview1',
    files: [{ path: 'bin/python', content: 'blobs/python-0.27.0/bin', sha256: blobSha, size: blobBytes.length, mode: 'exec' }],
    entrypoints: [
      { binName: 'python', runner: 'python-runner', args: [] },
      { binName: 'python3', runner: 'python-runner', args: [] },
      { binName: 'pyodide-only', runner: 'python-runner', args: [] },
    ],
  };
  const env = catalogEnv(withPyodide, { ...manifests, 'manifests/python-0.27.0.json': pyodideManifest });
  const hint = createRuntimeCommandHintResolver(env);
  const source = runtimeCatalogSource(env);
  for (const command of ['python', 'python3', 'pip', 'wasm-ld', 'pyodide-only']) {
    const resolved = await source.resolve(command);
    const hinted = await hint(command);
    assert.equal(hinted?.runtimeName ?? null, resolved?.manifest.name ?? null,
      `'${command}' is hinted at ${hinted?.runtimeName ?? 'nothing'} but installs ${resolved?.manifest.name ?? 'nothing'}`);
  }
  assert.equal((await hint('python'))?.runtimeName, 'cpython');
  assert.equal(await hint('pyodide-only'), null);
  // An explicit version is a deliberate request for the superseded runtime.
  assert.equal((await source.resolve('pyodide-only@0.27.0'))?.manifest.name, 'python');
}

// ── 3. `nimbus install <alias>` installs the providing runtime ─────────

class FakeVfs {
  get authority() { return { acquire: async () => ({ epoch: this.epoch, rev: this.revision() }), stat: async path => this.lstat(path) }; }

  constructor() {
    this.files = new Map();
    this.dirs = new Set(['']);
  }
  as() { return this; }
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
  async writeFileFrom(path, size, source) {
    const data = new Uint8Array(size);
    let at = 0;
    for await (const piece of source) { data.set(piece, at); at += piece.length; }
    this.files.set(path, data);
  }
  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
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
  const vfs = new FakeVfs();
  const registry = {
    register(name) { registered.push(name); },
  };
  const runtimes = new RuntimeManager({
    vfs,
    registry,
    getHome: () => '/home/user',
    source: runtimeCatalogSource(fakeEnv),
  });
  runtimes.registerRunner('cpython-runner', (_manifest, _root, binName) => async () => {
    void binName;
    return 0;
  });
  const deps = { runtimes, registry, vfs, getHome: () => '/home/user' };

  const result = await installRuntimeProgrammatic(deps, 'pip');
  assert.equal(result.exitCode, 0, `install failed: ${result.stderr}`);
  assert.match(result.stdout, /\[cpython\] installed at home\/user\/\.nimbus\/runtimes\/cpython\/3\.13\.14/);
  assert.ok(vfs.exists('home/user/.nimbus/runtimes/cpython/3.13.14/manifest.json'));
  for (const bin of ['python', 'python3', 'pip', 'pip3']) {
    assert.ok(registered.includes(bin), `expected '${bin}' to be registered`);
  }

  // Unknown specs still fail loudly with the catalog hint.
  const missing = await installRuntimeProgrammatic(deps, 'gem');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /'gem' is not in catalog/);
}

console.log('runtime-command-aliases: ok');
