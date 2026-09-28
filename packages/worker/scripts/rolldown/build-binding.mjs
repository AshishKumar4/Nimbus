#!/usr/bin/env bun
/**
 * build-binding.mjs — build rolldown's single-threaded wasm32-wasip1 binding
 * from pinned upstream source, reproducibly, and write the staged artifact.
 *
 *   bun packages/worker/scripts/rolldown/build-binding.mjs --work <dir> --out <dir>
 *
 * Run it inside a bounded cgroup (the release link is fat LTO, ~4 GB peak):
 *   NIMBUS_TEST_MEMORY_MAX=16G NIMBUS_TEST_TIMEOUT=3600 run-bounded bun .../build-binding.mjs ...
 *
 * What it does, in order, failing loudly at the first mismatch:
 *   1. Downloads rolldown's v<version> source archive and checks its SHA-256.
 *   2. Checks the toolchain is exactly the one upstream's rust-toolchain.toml
 *      pins, with the wasm32-wasip1 target.
 *   3. Downloads the npm packages the build links or bundles (emnapi's C
 *      archives, @emnapi/core|runtime|wasi-threads) and checks each tarball
 *      against the integrity rolldown's own pnpm-lock.yaml records.
 *   4. Builds `binding/` (a cdylib wrapping upstream `rolldown_binding`
 *      unmodified, see binding/Cargo.toml) with `cargo --locked` against the
 *      committed Cargo.lock, which is upstream's lockfile pruned to this build:
 *      every package version must equal upstream's, and the script checks it.
 *   5. Emits the wasi trampoline and bundles the loader.
 *   6. Verifies the binary is threadless (no shared memory, no thread-spawn)
 *      and writes provenance.json with every input and output digest.
 *
 * Upstream source is never patched. The one build-line change is the shadow
 * stack size, made by binding/link-wasm.sh (see its header for why and for
 * the exact-match check that guards it).
 *
 * Output (--out): rolldown-binding.wasm, wasi-trampoline.wasm,
 * rolldown-binding-loader.mjs, provenance.json. Stage it into the worker with
 * `NIMBUS_ROLLDOWN_ARTIFACT=<out> node packages/worker/scripts/bundle-rolldown.mjs`.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { buildWasiTrampoline, DISPATCHED_WASI_IMPORTS } from './loader/wasi-trampoline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Pins ────────────────────────────────────────────────────────────────
const ROLLDOWN_VERSION = '1.2.11';
const SOURCE_URL = `https://github.com/rolldown/rolldown/archive/refs/tags/v${ROLLDOWN_VERSION}.tar.gz`;
const SOURCE_SHA256 = 'fb6def184441b75eaf4f5ac24f99d46a29686f61e29af1bc137705f4da018403';
const RUST_TOOLCHAIN = '1.98.1';
const TARGET = 'wasm32-wasip1';
/** Linear-memory bytes the wasm shadow stack takes (link-wasm.sh). */
const WASM_STACK_BYTES = 4 * 1024 * 1024;
const RUSTFLAGS = [
  // rolldown_plugin_utils enables tokio's `fs` feature, which tokio only
  // compiles for wasm under tokio_unstable — upstream sets the same cfg for
  // its wasm32-wasip1-threads build (.cargo/config.toml).
  '--cfg', 'tokio_unstable',
  '-C', 'target-feature=+simd128',
];
/** npm tarballs, integrity as recorded in rolldown v1.2.11's pnpm-lock.yaml. */
const NPM_INPUTS = [
  { name: 'emnapi', version: '2.0.0-alpha.5' },
  { name: '@emnapi/core', version: '2.0.0-alpha.5' },
  { name: '@emnapi/runtime', version: '2.0.0-alpha.5' },
  { name: '@emnapi/wasi-threads', version: '2.1.0' },
];

// ── Arguments ───────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`build-binding: ${name} <dir> is required`);
  return path.resolve(process.argv[i + 1]);
}
const WORK = arg('--work');
const OUT = arg('--out');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512b64 = (bytes) => createHash('sha512').update(bytes).digest('base64');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`build-binding: ${cmd} ${args.join(' ')} exited ${r.status}${r.stderr ? `\n${r.stderr}` : ''}`);
  }
  return r.stdout ?? '';
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`build-binding: GET ${url} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function extractTarGz(bytes, into) {
  await fs.mkdir(into, { recursive: true });
  const archive = path.join(into, '.archive.tgz');
  await fs.writeFile(archive, bytes);
  run('tar', ['xzf', archive, '-C', into]);
  await fs.rm(archive);
}

// ── 1. Source ───────────────────────────────────────────────────────────
async function fetchSource() {
  const dir = path.join(WORK, `rolldown-${ROLLDOWN_VERSION}`);
  const archivePath = path.join(WORK, `rolldown-v${ROLLDOWN_VERSION}.tar.gz`);
  const bytes = existsSync(archivePath) ? new Uint8Array(await fs.readFile(archivePath)) : await download(SOURCE_URL);
  const digest = sha256(bytes);
  if (digest !== SOURCE_SHA256) {
    throw new Error(`build-binding: ${SOURCE_URL} sha256 ${digest}, pinned ${SOURCE_SHA256}`);
  }
  await fs.writeFile(archivePath, bytes);
  await fs.rm(dir, { recursive: true, force: true });
  await extractTarGz(bytes, WORK);
  if (!existsSync(path.join(dir, 'crates', 'rolldown_binding', 'Cargo.toml'))) {
    throw new Error(`build-binding: ${dir} is not a rolldown source tree`);
  }
  return dir;
}

// ── 2. Toolchain ────────────────────────────────────────────────────────
function checkToolchain(sourceDir, env) {
  const pinned = run('sed', ['-n', 's/^channel = "\\(.*\\)"$/\\1/p', path.join(sourceDir, 'rust-toolchain.toml')], { capture: true }).trim();
  if (pinned !== RUST_TOOLCHAIN) {
    throw new Error(`build-binding: upstream pins rust ${pinned}, this script pins ${RUST_TOOLCHAIN}; update both together`);
  }
  const rustc = run('rustc', ['-vV'], { capture: true, env });
  const release = rustc.match(/^release: (.+)$/m)?.[1];
  if (release !== RUST_TOOLCHAIN) {
    throw new Error(`build-binding: rustc on PATH is ${release}; install ${RUST_TOOLCHAIN} with the ${TARGET} target (rustup toolchain install ${RUST_TOOLCHAIN} --target ${TARGET}) and put it first on PATH`);
  }
  const sysroot = run('rustc', ['--print', 'sysroot'], { capture: true, env }).trim();
  if (!existsSync(path.join(sysroot, 'lib', 'rustlib', TARGET))) {
    throw new Error(`build-binding: rustc ${RUST_TOOLCHAIN} has no ${TARGET} target (rustup target add ${TARGET})`);
  }
  const rustLld = path.join(sysroot, 'lib', 'rustlib', run('rustc', ['-vV'], { capture: true, env }).match(/^host: (.+)$/m)[1], 'bin', 'rust-lld');
  if (!existsSync(rustLld)) throw new Error(`build-binding: ${rustLld} not found`);
  return { rustc: rustc.trim(), rustLld };
}

// ── 3. npm inputs ───────────────────────────────────────────────────────
async function fetchNpmInputs(sourceDir) {
  const lock = await fs.readFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'utf8');
  const out = {};
  for (const { name, version } of NPM_INPUTS) {
    const key = name.startsWith('@') ? `'${name}@${version}'` : `${name}@${version}`;
    const at = lock.indexOf(`\n  ${key}:\n`);
    const integrity = at < 0 ? null : lock.slice(at).match(/resolution: \{integrity: (sha512-[^}]+)\}/)?.[1];
    if (!integrity) throw new Error(`build-binding: ${name}@${version} not found in rolldown's pnpm-lock.yaml`);
    const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    const bytes = await download(tarball);
    const got = `sha512-${sha512b64(bytes)}`;
    if (got !== integrity) throw new Error(`build-binding: ${tarball} integrity ${got}, lockfile ${integrity}`);
    const dir = path.join(WORK, 'npm', 'node_modules', name);
    await fs.rm(dir, { recursive: true, force: true });
    const staging = path.join(WORK, 'npm', '.staging');
    await fs.rm(staging, { recursive: true, force: true });
    await extractTarGz(bytes, staging);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rename(path.join(staging, 'package'), dir);
    out[`${name}@${version}`] = { tarball, integrity };
  }
  return out;
}

// ── 4. Lockfile + cargo ─────────────────────────────────────────────────
function lockPackages(text) {
  const map = new Map();
  for (const block of text.split('\n[[package]]\n').slice(1)) {
    const name = block.match(/^name = "(.+)"$/m)?.[1];
    const version = block.match(/^version = "(.+)"$/m)?.[1];
    const source = block.match(/^source = "(.+)"$/m)?.[1] ?? 'path';
    if (name && version) map.set(`${name} ${version}`, source);
  }
  return map;
}

async function checkLockfile(sourceDir, lockText) {
  const upstream = lockPackages(await fs.readFile(path.join(sourceDir, 'Cargo.lock'), 'utf8'));
  const ours = lockPackages(lockText);
  for (const [pkg, source] of ours) {
    if (pkg.startsWith('nimbus_rolldown_binding ')) continue;
    if (upstream.get(pkg) !== source) {
      throw new Error(`build-binding: Cargo.lock has ${pkg} (${source}) that upstream's lockfile does not pin`);
    }
  }
  return { packages: ours.size, upstreamPackages: upstream.size };
}

async function buildCargo(sourceDir, toolchain, baseEnv) {
  // The workspace root is WORK itself, holding binding/ and upstream's tree
  // side by side (see Cargo.toml for why).
  const crateDir = path.join(WORK, 'binding');
  await fs.rm(crateDir, { recursive: true, force: true });
  await fs.cp(path.join(HERE, 'binding'), crateDir, { recursive: true });
  for (const file of ['Cargo.toml', 'Cargo.lock']) await fs.copyFile(path.join(HERE, file), path.join(WORK, file));
  // The wrapper names upstream by a path relative to itself, and the
  // workspace excludes that same directory.
  const manifest = await fs.readFile(path.join(crateDir, 'Cargo.toml'), 'utf8');
  const workspace = await fs.readFile(path.join(WORK, 'Cargo.toml'), 'utf8');
  if (!manifest.includes(`path = "../rolldown-${ROLLDOWN_VERSION}/crates/rolldown_binding"`)
    || !workspace.includes(`exclude = ["rolldown-${ROLLDOWN_VERSION}"]`)) {
    throw new Error(`build-binding: Cargo.toml / binding/Cargo.toml do not name rolldown-${ROLLDOWN_VERSION}`);
  }
  const lockText = await fs.readFile(path.join(WORK, 'Cargo.lock'), 'utf8');
  const lockCheck = await checkLockfile(sourceDir, lockText);
  const targetDir = path.join(WORK, 'target');
  const cargoHome = baseEnv.CARGO_HOME ?? path.join(process.env.HOME ?? '/', '.cargo');
  const env = {
    ...baseEnv,
    CARGO_TARGET_DIR: targetDir,
    EMNAPI_LINK_DIR: path.join(WORK, 'npm', 'node_modules', 'emnapi', 'lib', TARGET),
    CARGO_TARGET_WASM32_WASIP1_LINKER: path.join(crateDir, 'link-wasm.sh'),
    NIMBUS_RUST_LLD: toolchain.rustLld,
    NIMBUS_WASM_STACK: String(WASM_STACK_BYTES),
    CARGO_ENCODED_RUSTFLAGS: RUSTFLAGS.join('\x1f'),
    // Machine paths out of panic messages (see rustc-remap.sh for why these
    // are not RUSTFLAGS): the same bytes from any work directory.
    RUSTC_WRAPPER: path.join(crateDir, 'rustc-remap.sh'),
    NIMBUS_REMAP_WORK: WORK,
    NIMBUS_REMAP_CARGO_HOME: cargoHome,
    SOURCE_DATE_EPOCH: '0',
  };
  delete env.RUSTFLAGS;
  const jobs = process.env.NIMBUS_CARGO_JOBS ?? '12';
  run('cargo', ['build', '--release', '--locked', '--target', TARGET, '-j', jobs], { cwd: WORK, env });
  const wasmPath = path.join(targetDir, TARGET, 'release', 'nimbus_rolldown_binding.wasm');
  return { wasm: new Uint8Array(await fs.readFile(wasmPath)), lockText, lockCheck, rustflags: RUSTFLAGS };
}

// ── 5. Wasm facts ───────────────────────────────────────────────────────
/** The import section, parsed just far enough to check the threading ABI. */
function wasmImports(bytes) {
  let at = 8;
  const u = () => {
    let result = 0, shift = 0, byte;
    do { byte = bytes[at++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return result >>> 0;
  };
  const str = () => { const n = u(); const s = new TextDecoder().decode(bytes.subarray(at, at + n)); at += n; return s; };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = u();
    const end = at + size;
    if (id !== 2) { at = end; continue; }
    const imports = [];
    for (let i = u(); i > 0; i--) {
      const module = str(), name = str(), kind = bytes[at++];
      const entry = { module, name, kind };
      if (kind === 0) u();
      else if (kind === 1) { at++; const f = bytes[at++]; u(); if (f & 1) u(); }
      else if (kind === 2) { const f = bytes[at++]; entry.flags = f; entry.minPages = u(); if (f & 1) entry.maxPages = u(); }
      else if (kind === 3) { at += 2; }
      imports.push(entry);
    }
    return imports;
  }
  return [];
}

// ── Main ────────────────────────────────────────────────────────────────
await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(OUT, { recursive: true });
const env = { ...process.env };
const sourceDir = await fetchSource();
const toolchain = checkToolchain(sourceDir, env);
const npmInputs = await fetchNpmInputs(sourceDir);
const cargo = await buildCargo(sourceDir, toolchain, env);

const imports = wasmImports(cargo.wasm);
const memory = imports.find((i) => i.kind === 2);
if (!memory || memory.module !== 'env' || memory.name !== 'memory') throw new Error('build-binding: binding does not import env.memory');
if (memory.flags & 2) throw new Error('build-binding: binding imports a SHARED memory — this is the threaded ABI');
if (imports.some((i) => i.module === 'wasi')) throw new Error('build-binding: binding imports wasi thread-spawn — this is the threaded ABI');
const wasiNames = imports.filter((i) => i.module === 'wasi_snapshot_preview1').map((i) => i.name);
const trampoline = buildWasiTrampoline();

const loaderPath = path.join(OUT, 'rolldown-binding-loader.mjs');
await esbuild({
  entryPoints: [path.join(HERE, 'loader', 'rolldown-binding.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  nodePaths: [path.join(WORK, 'npm', 'node_modules')],
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  external: ['node:*'],
  define: {
    __NIMBUS_ROLLDOWN_MEMORY_PAGES__: String(memory.minPages),
    __NIMBUS_ROLLDOWN_DISPATCHED__: JSON.stringify(Object.keys(DISPATCHED_WASI_IMPORTS).sort()),
  },
  outfile: loaderPath,
  logLevel: 'warning',
});

await fs.writeFile(path.join(OUT, 'rolldown-binding.wasm'), cargo.wasm);
await fs.writeFile(path.join(OUT, 'wasi-trampoline.wasm'), trampoline);
const loader = await fs.readFile(loaderPath);
const provenance = {
  artifact: 'rolldown-binding',
  rolldownVersion: ROLLDOWN_VERSION,
  target: TARGET,
  source: { url: SOURCE_URL, sha256: SOURCE_SHA256 },
  toolchain: toolchain.rustc,
  cargo: {
    command: `cargo build --release --locked --target ${TARGET}`,
    rustflags: cargo.rustflags,
    rustcWrapper: 'binding/rustc-remap.sh (--remap-path-prefix <work>=/build <CARGO_HOME>=/cargo)',
    linker: 'binding/link-wasm.sh (rust-lld; -zstack-size=64000000 -> ' + WASM_STACK_BYTES + ')',
    lockfileSha256: sha256(cargo.lockText),
    lockfilePackages: cargo.lockCheck.packages,
    upstreamLockfilePackages: cargo.lockCheck.upstreamPackages,
  },
  npm: npmInputs,
  wasm: {
    memoryMinPages: memory.minPages,
    sharedMemory: false,
    wasiImports: wasiNames,
    trampolineDispatches: Object.keys(DISPATCHED_WASI_IMPORTS).sort(),
  },
  outputs: {
    'rolldown-binding.wasm': { bytes: cargo.wasm.length, sha256: sha256(cargo.wasm) },
    'wasi-trampoline.wasm': { bytes: trampoline.length, sha256: sha256(trampoline) },
    'rolldown-binding-loader.mjs': { bytes: loader.length, sha256: sha256(loader) },
  },
};
await fs.writeFile(path.join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance.outputs, null, 2));
