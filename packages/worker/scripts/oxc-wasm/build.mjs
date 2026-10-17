#!/usr/bin/env bun
/**
 * build.mjs — build Nimbus's Oxc transform (this crate) as wasm, reproducibly.
 *
 *   bun packages/worker/scripts/oxc-wasm/build.mjs --work <dir> --out <dir>
 *
 * Cargo may run in its own bounded cgroup (keep this Bun orchestrator small):
 * NIMBUS_CARGO_RUNNER names a command that runs its arguments bounded
 * (`<runner> cargo build …`), and NIMBUS_CARGO_JOBS sets Cargo's jobs.
 *
 * Every input is pinned and every check fails loudly:
 *   1. The crate (Cargo.toml, Cargo.lock, rust-toolchain.toml, src/) is copied
 *      into <work>/nimbus-oxc, so the build path is the work directory's, and
 *      built with `cargo --locked` (crates.io checksums in Cargo.lock) by the
 *      exact rustc rust-toolchain.toml names, for wasm32-unknown-unknown.
 *   2. binaryen's release archive is checked against its pinned SHA-256, and
 *      its wasm-opt drops the wasm-bindgen exports oxc-browserslist's js-sys
 *      dependency leaves (no code path here calls into JavaScript), replaces
 *      the one import they keep, a diverging `throw`, with a trap, and
 *      optimizes (-O3).
 *   3. The result must import nothing, export exactly the ABI (src/abi.rs),
 *      and define an unshared memory of at most OXC_MAX_INITIAL_PAGES.
 * Output (--out): nimbus-oxc.wasm and provenance.json (inputs, toolchain,
 * flags, digests). Stage it with
 *   NIMBUS_OXC_WASM_ARTIFACTS=<out> node packages/worker/scripts/bundle-oxc-wasm.mjs
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedInputs, oxcWasmInputs } from './inputs.mjs';
import { rustBuildEnv } from '../rust-build-env.mjs';
import { WASM_SECTION, WasmReader, wasmInterface, wasmSections } from '@nimbus-sh/core/runtime/wasm-binary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = 'wasm32-unknown-unknown';
/**
 * Bytes of linear memory the wasm shadow stack takes. Call frames live on the
 * host's native stack; this one holds what they spill, and at 4 MiB it is not
 * what limits nesting depth under workerd's or Node's default stack.
 */
const WASM_STACK_BYTES = 4 * 1024 * 1024;
/**
 * The ceiling on the module's floor, the stack plus static data, in 64 KiB
 * pages: 5 MiB. Napi-rs's wasm builds start at 981 pages (a 64 MB stack).
 */
const OXC_MAX_INITIAL_PAGES = 80;
const RUSTFLAGS = ['-Ctarget-feature=+simd128', `-Clink-arg=-zstack-size=${WASM_STACK_BYTES}`];
const BINARYEN = {
  version: 'version_133',
  url: 'https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz',
  sha256: '2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489',
};
const WASM_OPT_ARGS = [
  // The features rustc 1.98 enables for wasm32-unknown-unknown, plus simd128.
  '--enable-simd', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '--enable-sign-ext',
  '--enable-mutable-globals', '--enable-reference-types', '--enable-multivalue',
  '--remove-exports', '--pass-arg=remove-exports@__*',
  '--remove-imports',
  '-O3',
];
const EXPORTS = ['memory', 'nimbus_oxc_alloc', 'nimbus_oxc_realloc', 'nimbus_oxc_release', 'nimbus_oxc_transform'];
const CRATE_FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'src'];

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`oxc-wasm: ${name} <value> is required`);
  return path.resolve(process.argv[i + 1]);
}
const WORK = arg('--work');
const OUT = arg('--out');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`oxc-wasm: ${cmd} ${args.join(' ')} exited ${r.status}${r.stderr ? `\n${r.stderr}` : ''}`);
  return r.stdout ?? '';
}

async function copyCrate(into) {
  await fs.rm(into, { recursive: true, force: true });
  await fs.mkdir(into, { recursive: true });
  for (const entry of CRATE_FILES) await fs.cp(path.join(HERE, entry), path.join(into, entry), { recursive: true });
}

function toolchain(crateDir, text) {
  const pinned = text.match(/^channel = "(.+)"$/m)?.[1];
  if (!pinned) throw new Error('oxc-wasm: rust-toolchain.toml names no channel');
  // rustup, when present, owns the pinned toolchain; otherwise the rustc on PATH must be it.
  const which = spawnSync('rustup', ['which', '--toolchain', pinned, 'rustc'], { encoding: 'utf8', cwd: crateDir });
  const binDir = which.status === 0 ? path.dirname(which.stdout.trim()) : null;
  // Every rustc and cargo this build runs sees no ambient Cargo or rustc setting (rust-build-env.mjs).
  const env = rustBuildEnv(process.env, { PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH, RUSTUP_TOOLCHAIN: pinned });
  const rustc = run('rustc', ['-vV'], { capture: true, env });
  const release = rustc.match(/^release: (.+)$/m)?.[1];
  if (release !== pinned) {
    throw new Error(`oxc-wasm: needs rustc ${pinned} with ${TARGET} (rustup toolchain install ${pinned} --target ${TARGET}); found ${release}`);
  }
  const sysroot = run('rustc', ['--print', 'sysroot'], { capture: true, env }).trim();
  if (!existsSync(path.join(sysroot, 'lib', 'rustlib', TARGET))) {
    throw new Error(`oxc-wasm: rustc ${pinned} has no ${TARGET} target (rustup target add --toolchain ${pinned} ${TARGET})`);
  }
  // The compiler itself, not a rustup proxy: cargo is told to use exactly this.
  const compiler = path.join(sysroot, 'bin', 'rustc');
  if (run(compiler, ['-vV'], { capture: true }) !== rustc) throw new Error(`oxc-wasm: ${compiler} is not the rustc ${pinned} checked`);
  return { rustc: rustc.trim(), compiler, env };
}

async function wasmOpt() {
  const archives = path.join(WORK, '_archives');
  await fs.mkdir(archives, { recursive: true });
  const archive = path.join(archives, path.basename(BINARYEN.url));
  if (!existsSync(archive)) {
    const res = await fetch(BINARYEN.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`oxc-wasm: GET ${BINARYEN.url} -> ${res.status}`);
    await fs.writeFile(archive, new Uint8Array(await res.arrayBuffer()));
  }
  const digest = sha256(await fs.readFile(archive));
  if (digest !== BINARYEN.sha256) throw new Error(`oxc-wasm: ${BINARYEN.url} sha256 ${digest}, pinned ${BINARYEN.sha256}`);
  const dir = path.join(WORK, 'binaryen');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  run('tar', ['xzf', archive, '-C', dir]);
  const bin = path.join(dir, `binaryen-${BINARYEN.version}`, 'bin', 'wasm-opt');
  const version = run(bin, ['--version'], { capture: true }).trim();
  if (!version.includes(BINARYEN.version)) throw new Error(`oxc-wasm: ${bin} reports ${version}`);
  return { bin, version };
}

/** The memories a wasm binary defines (its memory section), as their limits. */
function definedMemories(bytes) {
  return [...wasmSections(bytes)].filter((section) => section.id === WASM_SECTION.memory).flatMap((section) => {
    const reader = new WasmReader(bytes.subarray(0, section.payload + section.size), section.payload);
    const count = reader.varuint();
    return Array.from({ length: count }, () => reader.limits());
  });
}

// ── Main ────────────────────────────────────────────────────────────────
await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(OUT, { recursive: true });
const crateDir = path.join(WORK, 'nimbus-oxc');
const inputs = await oxcWasmInputs();
await copyCrate(crateDir);
const toolchainText = await fs.readFile(path.join(crateDir, 'rust-toolchain.toml'), 'utf8');
const rust = toolchain(crateDir, toolchainText);
const optimizer = await wasmOpt();

const cargoHome = process.env.CARGO_HOME ?? path.join(process.env.HOME ?? '/', '.cargo');
// The compiler is the one toolchain() checked.
const env = {
  ...rust.env,
  RUSTC: rust.compiler,
  CARGO_TARGET_DIR: path.join(WORK, 'target'),
  CARGO_ENCODED_RUSTFLAGS: RUSTFLAGS.join('\x1f'),
  // Machine paths out of panic messages without entering cargo's metadata
  // hash (napi-wasm/rustc-remap.sh explains why not RUSTFLAGS).
  RUSTC_WRAPPER: path.join(HERE, '..', 'napi-wasm', 'rustc-remap.sh'),
  NIMBUS_REMAP_WORK: WORK,
  NIMBUS_REMAP_CARGO_HOME: cargoHome,
  SOURCE_DATE_EPOCH: '0',
};
const jobs = Number(process.env.NIMBUS_CARGO_JOBS ?? '4');
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 12) throw new Error('oxc-wasm: NIMBUS_CARGO_JOBS must be an integer from 1 to 12');
const cargoArgs = ['build', '--release', '--locked', '--lib', '--target', TARGET, '-j', String(jobs)];
const runner = process.env.NIMBUS_CARGO_RUNNER;
if (runner) run(runner, ['cargo', ...cargoArgs], { cwd: crateDir, env });
else run('cargo', cargoArgs, { cwd: crateDir, env });

const linked = path.join(WORK, 'target', TARGET, 'release', 'nimbus_oxc.wasm');
const output = path.join(OUT, 'nimbus-oxc.wasm');
run(optimizer.bin, [linked, ...WASM_OPT_ARGS, '-o', output]);
const wasm = new Uint8Array(await fs.readFile(output));
if (!WebAssembly.validate(wasm)) throw new Error('oxc-wasm: the module is not a valid wasm module');
const { imports, exports } = wasmInterface(wasm);
const exported = exports.map((entry) => entry.name);
if (imports.length !== 0) throw new Error(`oxc-wasm: the module imports ${imports.map((entry) => `${entry.module}.${entry.name}`).join(', ')}; it must import nothing`);
if (JSON.stringify([...exported].sort()) !== JSON.stringify(EXPORTS)) {
  throw new Error(`oxc-wasm: the module exports ${exported.join(', ')}; the ABI is ${EXPORTS.join(', ')}`);
}
const memories = definedMemories(wasm);
const [memory] = memories;
if (memories.length !== 1 || (memory.flags & 2) !== 0) throw new Error('oxc-wasm: the module must define one unshared memory');
if (memory.min > OXC_MAX_INITIAL_PAGES) {
  throw new Error(`oxc-wasm: the module's memory starts at ${memory.min} pages, over OXC_MAX_INITIAL_PAGES (${OXC_MAX_INITIAL_PAGES})`);
}

const drifted = changedInputs(inputs, await oxcWasmInputs());
if (drifted.length) throw new Error(`oxc-wasm: inputs changed during the build: ${drifted.join(', ')}`);
const cargoToml = await fs.readFile(path.join(crateDir, 'Cargo.toml'), 'utf8');
const lock = await fs.readFile(path.join(crateDir, 'Cargo.lock'), 'utf8');
const provenance = {
  artifact: 'nimbus-oxc',
  oxc: lock.match(/\nname = "oxc"\nversion = "(.+)"/)?.[1],
  target: TARGET,
  source: {
    crate: 'packages/worker/scripts/oxc-wasm',
    manifestVersion: cargoToml.match(/^version = "(.+)"$/m)?.[1],
    // Every input's sha256 (inputs.mjs); bundle-oxc-wasm.mjs stages this wasm
    // only while they are the tree's.
    inputs,
  },
  toolchain: rust.rustc,
  cargo: {
    command: `cargo ${cargoArgs.slice(0, -2).join(' ')}`,
    rustflags: RUSTFLAGS,
    rustcWrapper: 'napi-wasm/rustc-remap.sh (--remap-path-prefix <work>=/build <CARGO_HOME>=/cargo)',
  },
  wasmOpt: { binaryen: BINARYEN, version: optimizer.version, args: WASM_OPT_ARGS },
  wasm: { imports: [], exports: EXPORTS, memoryInitialPages: memory.min, stackBytes: WASM_STACK_BYTES },
  outputs: { 'nimbus-oxc.wasm': { bytes: wasm.length, sha256: sha256(wasm) } },
};
await fs.writeFile(path.join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance.outputs, null, 2));
