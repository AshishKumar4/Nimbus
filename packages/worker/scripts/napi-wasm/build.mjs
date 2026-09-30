#!/usr/bin/env bun
/**
 * build.mjs — build napi-rs bindings for single-threaded wasm32-wasip1 from
 * pinned upstream source, reproducibly, with the shared loader they run on.
 *
 *   bun packages/worker/scripts/napi-wasm/build.mjs --work <dir> --out <dir> [--spec rolldown,satteri]
 *
 * Keep this Bun orchestrator at <=4 GiB. If Cargo needs a separate 16 GiB
 * cgroup, name the bounded runner explicitly; builds remain serial:
 *   NIMBUS_CARGO_RUNNER=/mnt/scratch/nimbus/run-bounded \
 *   NIMBUS_TEST_MEMORY_MAX=4G NIMBUS_TEST_TIMEOUT=3600 run-bounded bun .../build.mjs ...
 *
 * specs.mjs holds every pin. For each spec, failing loudly at the first
 * mismatch:
 *   1. Downloads upstream's tag archive and checks its SHA-256.
 *   2. Resolves the exact toolchain upstream's rust-toolchain.toml pins (from
 *      rustup, or the rustc on PATH) with the wasm32-wasip1 target.
 *   3. Builds the cdylib with `cargo --locked`: in upstream's workspace, or in
 *      our wrapper workspace for a binding that needs the event-loop runtime.
 *      A lockfile other than upstream's is either upstream's pruned (every
 *      version checked against it) or a committed pin. A seam is an exact
 *      edit to one upstream line, applied only if that line occurs once.
 *   4. Checks the binary is threadless (no shared memory, no thread-spawn).
 * Then it bundles the one loader every binding runs on (emnapi pinned by
 * lockfile integrity) and emits the wasi trampoline, and writes provenance
 * for every output: inputs, toolchain, flags, seams and digests.
 *
 * The one build-line change every binding shares is the shadow stack size,
 * made by link-wasm.sh (see its header for why and for its exact-match check).
 *
 * Output (--out):
 *   <spec>/<spec>.wasm, <spec>/provenance.json            one per spec
 *   napi-wasm/napi-wasm-loader.mjs, wasi-trampoline.wasm, provenance.json
 * Stage it into the worker with
 *   NIMBUS_NAPI_WASM_ARTIFACTS=<out> node packages/worker/scripts/bundle-napi-wasm.mjs
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { buildWasiTrampoline, DISPATCHED_WASI_IMPORTS } from './loader/wasi-trampoline.mjs';
import { EMNAPI, SPECS } from './specs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = 'wasm32-wasip1';
/** Linear-memory bytes the wasm shadow stack takes (link-wasm.sh). */
const WASM_STACK_BYTES = 4 * 1024 * 1024;

// ── Arguments ───────────────────────────────────────────────────────────
function arg(name, required = true) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) {
    if (required) throw new Error(`napi-wasm: ${name} <value> is required`);
    return null;
  }
  return process.argv[i + 1];
}
const WORK = path.resolve(arg('--work'));
const OUT = path.resolve(arg('--out'));
const SELECTED = (arg('--spec', false) ?? Object.keys(SPECS).join(',')).split(',');
for (const name of SELECTED) if (!SPECS[name]) throw new Error(`napi-wasm: no spec named ${name}`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512b64 = (bytes) => createHash('sha512').update(bytes).digest('base64');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`napi-wasm: ${cmd} ${args.join(' ')} exited ${r.status}${r.stderr ? `\n${r.stderr}` : ''}`);
  }
  return r.stdout ?? '';
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`napi-wasm: GET ${url} -> ${res.status}`);
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
/** The spec's pinned tag archive, from the work cache or the network. */
async function sourceArchive(spec) {
  const archives = path.join(WORK, '_archives');
  await fs.mkdir(archives, { recursive: true });
  const cached = path.join(archives, `${spec.name}-${spec.version}.tar.gz`);
  const bytes = existsSync(cached) ? new Uint8Array(await fs.readFile(cached)) : await download(spec.source.url);
  const digest = sha256(bytes);
  if (digest !== spec.source.sha256) {
    throw new Error(`napi-wasm: ${spec.source.url} sha256 ${digest}, pinned ${spec.source.sha256}`);
  }
  await fs.writeFile(cached, bytes);
  return bytes;
}

/** A fresh tree of the spec's source under its own work directory. */
async function extractSource(spec, root) {
  const dir = path.join(root, spec.source.dir);
  await fs.rm(dir, { recursive: true, force: true });
  await extractTarGz(await sourceArchive(spec), root);
  if (!existsSync(path.join(dir, 'Cargo.toml'))) throw new Error(`napi-wasm: ${dir} is not a cargo source tree`);
  return dir;
}

// ── 2. Toolchain ────────────────────────────────────────────────────────
function toolchainFor(spec, sourceDir) {
  const pinned = run('sed', ['-n', 's/^channel = "\\(.*\\)"$/\\1/p', path.join(sourceDir, 'rust-toolchain.toml')], { capture: true }).trim();
  if (pinned !== spec.toolchain) {
    throw new Error(`napi-wasm: ${spec.name} upstream pins rust ${pinned}, specs.mjs pins ${spec.toolchain}; update both together`);
  }
  // rustup, when present, owns every pinned toolchain; otherwise the rustc on
  // PATH must be the pinned one.
  const which = spawnSync('rustup', ['which', '--toolchain', spec.toolchain, 'rustc'], { encoding: 'utf8' });
  const binDir = which.status === 0 ? path.dirname(which.stdout.trim()) : null;
  const env = { ...process.env, PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH };
  const rustc = run('rustc', ['-vV'], { capture: true, env });
  const release = rustc.match(/^release: (.+)$/m)?.[1];
  if (release !== spec.toolchain) {
    throw new Error(`napi-wasm: ${spec.name} needs rustc ${spec.toolchain} with ${TARGET} (rustup toolchain install ${spec.toolchain} --target ${TARGET}); found ${release}`);
  }
  const sysroot = run('rustc', ['--print', 'sysroot'], { capture: true, env }).trim();
  if (!existsSync(path.join(sysroot, 'lib', 'rustlib', TARGET))) {
    throw new Error(`napi-wasm: rustc ${spec.toolchain} has no ${TARGET} target (rustup target add --toolchain ${spec.toolchain} ${TARGET})`);
  }
  const host = rustc.match(/^host: (.+)$/m)[1];
  const rustLld = path.join(sysroot, 'lib', 'rustlib', host, 'bin', 'rust-lld');
  if (!existsSync(rustLld)) throw new Error(`napi-wasm: ${rustLld} not found`);
  return { rustc: rustc.trim(), rustLld, env };
}

// ── 3. Lockfile, seams, cargo ───────────────────────────────────────────
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

/** A pruned copy of upstream's lockfile may only drop packages, never change one. */
async function checkAgainstUpstream(sourceDir, lockText, ownCrate) {
  const upstream = lockPackages(await fs.readFile(path.join(sourceDir, 'Cargo.lock'), 'utf8'));
  const ours = lockPackages(lockText);
  for (const [pkg, source] of ours) {
    if (pkg.startsWith(`${ownCrate} `)) continue;
    if (upstream.get(pkg) !== source) {
      throw new Error(`napi-wasm: Cargo.lock has ${pkg} (${source}) that upstream's lockfile does not pin`);
    }
  }
  return { packages: ours.size, upstreamPackages: upstream.size };
}

async function applySeams(spec, sourceDir) {
  for (const seam of spec.seams) {
    const file = path.join(sourceDir, seam.file);
    const text = await fs.readFile(file, 'utf8');
    const hits = text.split(seam.from).length - 1;
    if (hits !== 1) {
      throw new Error(`napi-wasm: ${spec.name} seam expects \`${seam.from}\` once in ${seam.file}, found ${hits}: upstream changed; re-derive the seam`);
    }
    await fs.writeFile(file, text.replace(seam.from, seam.to));
  }
  return spec.seams.map(({ file, from, to, reason }) => ({ file, from, to, reason }));
}

async function buildSpec(spec, npmDir) {
  const root = path.join(WORK, spec.name);
  await fs.mkdir(root, { recursive: true });
  const sourceDir = await extractSource(spec, root);
  const toolchain = toolchainFor(spec, sourceDir);
  const seams = await applySeams(spec, sourceDir);
  const crate = spec.output.replace(/\.wasm$/, '');

  let cwd;
  let cargoArgs;
  let lock;
  if (spec.build.mode === 'wrapper') {
    // Our workspace holds the wrapper and upstream's tree side by side (see
    // <wrapper>/Cargo.toml for why that makes the build path-independent).
    const wrapperDir = path.join(HERE, spec.build.wrapper);
    await fs.rm(path.join(root, 'binding'), { recursive: true, force: true });
    await fs.cp(path.join(wrapperDir, 'binding'), path.join(root, 'binding'), { recursive: true });
    for (const file of ['Cargo.toml', 'Cargo.lock']) await fs.copyFile(path.join(wrapperDir, file), path.join(root, file));
    const workspace = await fs.readFile(path.join(root, 'Cargo.toml'), 'utf8');
    const manifest = await fs.readFile(path.join(root, 'binding', 'Cargo.toml'), 'utf8');
    if (!workspace.includes(`exclude = ["${spec.source.dir}"]`) || !manifest.includes(`path = "../${spec.source.dir}/`)) {
      throw new Error(`napi-wasm: ${spec.build.wrapper}/Cargo.toml and binding/Cargo.toml must name ${spec.source.dir}`);
    }
    const lockText = await fs.readFile(path.join(root, 'Cargo.lock'), 'utf8');
    lock = {
      origin: `scripts/napi-wasm/${spec.build.lockfile} (upstream's, pruned to this build)`,
      sha256: sha256(lockText),
      ...(spec.build.checkAgainstUpstreamLock ? await checkAgainstUpstream(sourceDir, lockText, crate) : { packages: lockPackages(lockText).size }),
    };
    cwd = root;
    cargoArgs = ['build', '--release', '--locked', '--target', TARGET];
  } else {
    if (spec.build.lockfile !== 'upstream') {
      await fs.copyFile(path.join(HERE, spec.build.lockfile), path.join(sourceDir, 'Cargo.lock'));
    }
    const lockText = await fs.readFile(path.join(sourceDir, 'Cargo.lock'), 'utf8');
    lock = {
      origin: spec.build.lockfile === 'upstream' ? 'upstream Cargo.lock' : `scripts/napi-wasm/${spec.build.lockfile} (committed pin)`,
      sha256: sha256(lockText),
      packages: lockPackages(lockText).size,
    };
    cwd = sourceDir;
    cargoArgs = ['build', '--release', '--locked', '--target', TARGET, '-p', spec.build.package];
  }

  const targetDir = path.join(root, 'target');
  const cargoHome = process.env.CARGO_HOME ?? path.join(process.env.HOME ?? '/', '.cargo');
  const env = {
    ...toolchain.env,
    CARGO_TARGET_DIR: targetDir,
    EMNAPI_LINK_DIR: path.join(npmDir, 'node_modules', 'emnapi', 'lib', TARGET),
    CARGO_TARGET_WASM32_WASIP1_LINKER: path.join(HERE, 'link-wasm.sh'),
    NIMBUS_RUST_LLD: toolchain.rustLld,
    NIMBUS_WASM_STACK: String(WASM_STACK_BYTES),
    NIMBUS_WASM_CRATE: crate,
    CARGO_ENCODED_RUSTFLAGS: spec.rustflags.join('\x1f'),
    // Machine paths out of panic messages (see rustc-remap.sh for why these
    // are not RUSTFLAGS): the same bytes from any work directory.
    RUSTC_WRAPPER: path.join(HERE, 'rustc-remap.sh'),
    NIMBUS_REMAP_WORK: root,
    NIMBUS_REMAP_CARGO_HOME: cargoHome,
    SOURCE_DATE_EPOCH: '0',
  };
  delete env.RUSTFLAGS;
  const jobs = Number(process.env.NIMBUS_CARGO_JOBS ?? '12');
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 12) throw new Error('napi-wasm: NIMBUS_CARGO_JOBS must be an integer from 1 to 12');
  cargoArgs.push('-j', String(jobs));
  const runner = process.env.NIMBUS_CARGO_RUNNER;
  if (runner) {
    run(runner, ['cargo', ...cargoArgs], { cwd, env: { ...env, NIMBUS_TEST_MEMORY_MAX: '16G', NIMBUS_TEST_TIMEOUT: '3600' } });
  } else run('cargo', cargoArgs, { cwd, env });
  const wasm = new Uint8Array(await fs.readFile(path.join(targetDir, TARGET, 'release', spec.output)));

  const imports = wasmImports(wasm);
  const memory = imports.find((i) => i.kind === 2);
  if (!memory || memory.module !== 'env' || memory.name !== 'memory') throw new Error(`napi-wasm: ${spec.name} does not import env.memory`);
  if (memory.flags & 2) throw new Error(`napi-wasm: ${spec.name} imports a SHARED memory: this is the threaded ABI`);
  if (imports.some((i) => i.module === 'wasi')) throw new Error(`napi-wasm: ${spec.name} imports wasi thread-spawn: this is the threaded ABI`);
  const pumped = wasmExports(wasm).includes('nimbus_napi_pump');
  if (pumped !== (spec.build.mode === 'wrapper')) {
    throw new Error(`napi-wasm: ${spec.name} ${pumped ? 'exports' : 'lacks'} nimbus_napi_pump, but its build mode is ${spec.build.mode}`);
  }

  const outDir = path.join(OUT, spec.name);
  await fs.mkdir(outDir, { recursive: true });
  const file = `${spec.name}.wasm`;
  await fs.writeFile(path.join(outDir, file), wasm);
  const provenance = {
    artifact: spec.name,
    version: spec.version,
    target: TARGET,
    source: { url: spec.source.url, sha256: spec.source.sha256 },
    toolchain: toolchain.rustc,
    cargo: {
      command: `cargo ${cargoArgs.slice(0, -2).join(' ')}`,
      mode: spec.build.mode,
      rustflags: spec.rustflags,
      rustcWrapper: 'napi-wasm/rustc-remap.sh (--remap-path-prefix <work>=/build <CARGO_HOME>=/cargo)',
      linker: `napi-wasm/link-wasm.sh (rust-lld; -zstack-size=64000000 -> ${WASM_STACK_BYTES})`,
      lockfile: lock,
    },
    seams,
    npm: spec.npm,
    wasm: {
      memoryMinPages: memory.minPages,
      sharedMemory: false,
      pumped,
      wasiImports: imports.filter((i) => i.module === 'wasi_snapshot_preview1').map((i) => i.name),
    },
    outputs: { [file]: { bytes: wasm.length, sha256: sha256(wasm) } },
  };
  await fs.writeFile(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

// ── 4. emnapi + the shared loader ───────────────────────────────────────
/** emnapi's packages, checked against the integrity rolldown's pnpm-lock records. */
async function fetchEmnapi() {
  const from = SPECS[EMNAPI.lockfileFrom];
  const scratch = path.join(WORK, '_lock');
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.mkdir(scratch, { recursive: true });
  const archive = path.join(scratch, 'source.tgz');
  await fs.writeFile(archive, await sourceArchive(from));
  run('tar', ['xzf', archive, '-C', scratch, `${from.source.dir}/pnpm-lock.yaml`]);
  const lock = await fs.readFile(path.join(scratch, from.source.dir, 'pnpm-lock.yaml'), 'utf8');
  const npmDir = path.join(WORK, 'npm');
  const out = {};
  for (const { name, version } of EMNAPI.packages) {
    const key = name.startsWith('@') ? `'${name}@${version}'` : `${name}@${version}`;
    const at = lock.indexOf(`\n  ${key}:\n`);
    const integrity = at < 0 ? null : lock.slice(at).match(/resolution: \{integrity: (sha512-[^}]+)\}/)?.[1];
    if (!integrity) throw new Error(`napi-wasm: ${name}@${version} not found in ${from.name}'s pnpm-lock.yaml`);
    const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    const bytes = await download(tarball);
    const got = `sha512-${sha512b64(bytes)}`;
    if (got !== integrity) throw new Error(`napi-wasm: ${tarball} integrity ${got}, lockfile ${integrity}`);
    const dir = path.join(npmDir, 'node_modules', name);
    await fs.rm(dir, { recursive: true, force: true });
    const staging = path.join(npmDir, '.staging');
    await fs.rm(staging, { recursive: true, force: true });
    await extractTarGz(bytes, staging);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rename(path.join(staging, 'package'), dir);
    out[`${name}@${version}`] = { tarball, integrity };
  }
  return { npmDir, packages: out };
}

async function buildLoader(emnapi) {
  const outDir = path.join(OUT, 'napi-wasm');
  await fs.mkdir(outDir, { recursive: true });
  const loaderPath = path.join(outDir, 'napi-wasm-loader.mjs');
  await esbuild({
    entryPoints: [path.join(HERE, 'loader', 'napi-wasm-loader.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    nodePaths: [path.join(emnapi.npmDir, 'node_modules')],
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    external: ['node:*'],
    define: { __NIMBUS_NAPI_WASM_DISPATCHED__: JSON.stringify(Object.keys(DISPATCHED_WASI_IMPORTS).sort()) },
    outfile: loaderPath,
    logLevel: 'warning',
  });
  const trampoline = buildWasiTrampoline();
  await fs.writeFile(path.join(outDir, 'wasi-trampoline.wasm'), trampoline);
  const loader = await fs.readFile(loaderPath);
  const provenance = {
    artifact: 'napi-wasm',
    npm: emnapi.packages,
    trampolineDispatches: Object.keys(DISPATCHED_WASI_IMPORTS).sort(),
    outputs: {
      'napi-wasm-loader.mjs': { bytes: loader.length, sha256: sha256(loader) },
      'wasi-trampoline.wasm': { bytes: trampoline.length, sha256: sha256(trampoline) },
    },
  };
  await fs.writeFile(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

// ── Wasm facts ──────────────────────────────────────────────────────────
function sections(bytes) {
  let at = 8;
  const u = () => {
    let result = 0, shift = 0, byte;
    do { byte = bytes[at++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return result >>> 0;
  };
  const str = () => { const n = u(); const s = new TextDecoder().decode(bytes.subarray(at, at + n)); at += n; return s; };
  const found = {};
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = u();
    const end = at + size;
    if (id === 2) {
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
      found.imports = imports;
    } else if (id === 7) {
      const exports = [];
      for (let i = u(); i > 0; i--) { exports.push(str()); at++; u(); }
      found.exports = exports;
    }
    at = end;
  }
  return found;
}
const wasmImports = (bytes) => sections(bytes).imports ?? [];
const wasmExports = (bytes) => sections(bytes).exports ?? [];

// ── Main ────────────────────────────────────────────────────────────────
await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(OUT, { recursive: true });
const emnapi = await fetchEmnapi();
const results = {};
for (const name of SELECTED) results[name] = (await buildSpec(SPECS[name], emnapi.npmDir)).outputs;
results['napi-wasm'] = (await buildLoader(emnapi)).outputs;
console.log(JSON.stringify(results, null, 2));
