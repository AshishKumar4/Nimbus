#!/usr/bin/env node
/**
 * build-wasm.mjs — reproducible wasm32-wasi build of OpenTUI's Zig core.
 *
 * Why this exists
 * ───────────────
 * opencode's TUI links @opentui/core, whose render core is a Zig dynamic
 * library loaded over Bun FFI — a native shard Nimbus cannot execute.
 * Upstream OpenTUI does not ship a wasm build. This script produces one:
 * a wasm32-wasi REACTOR (entry disabled, `_initialize` + rdynamic FFI
 * exports, resident after init — the same lifecycle the dylib has under
 * Bun FFI) built from the pinned OpenTUI source with the patch set in this
 * directory (see README.md for per-patch provenance):
 *
 *   1. nimbus-wasm-reactor-target.patch — `-Dtarget=wasm32-wasi` build
 *      wiring, audio stub, single-threaded comptime fences, u64→usize cast.
 *   2. nimbus-wasm-ffi-abi.patch — host-token callback imports
 *      (`opentui::logCallback` / `eventSinkCallback` / `streamCallback`)
 *      and the `nimbus_alloc`/`nimbus_free` copy-in/copy-back arena exports.
 *
 * Pins and inputs (all fail loud)
 * ───────────────────────────────
 *   - OpenTUI source: NIMBUS_OPENTUI_SRC env var, dev default
 *     /tmp/opentui-research/opentui. Must be the v0.3.2 checkout (the
 *     version opencode 1.16.2 pins); verified against packages/core
 *     package.json and, when the checkout has git metadata, the pinned
 *     commit. The checkout is never mutated: the zig tree is copied to a
 *     temp dir and patched there.
 *   - Zig toolchain: NIMBUS_ZIG env var (the zig binary, or a directory
 *     containing it directly or inside an extracted zig-<triple> dir),
 *     dev default /tmp/opentui-research/zig-toolchain. Must be exactly
 *     0.15.2 — the version OpenTUI's build.zig itself enforces.
 *   - Patches are applied with `git apply --check` first, so source drift
 *     fails before anything builds.
 *   - First build fetches OpenTUI's `uucode` Zig dependency into the Zig
 *     global cache (content-hash pinned by build.zig.zon).
 *
 * Output
 * ──────
 *   public/_assets/opentui/<version>/opentui.wasm   ← staged artifact
 *   public/_assets/opentui/<version>/manifest.json  ← shas, sizes, counts
 *   src/opentui-wasm-artifact.generated.ts          ← version/entry/build id
 *
 * The build is byte-reproducible: same source + patches + Zig 0.15.2 (+
 * same wasm-opt version when present) yield an identical artifact, and the
 * manifest carries every sha needed to prove it. `wasm-opt -Oz` is applied
 * when binaryen is on PATH (the manifest records the version used and the
 * pre-opt sha); without it the ReleaseSmall output is staged as-is.
 *
 * Stage A scope: nothing imports the generated constants yet — the worker
 * runtime is unaffected until the facet attach path lands.
 *
 * Run via: node packages/worker/scripts/opentui/build-wasm.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(__dirname, '..', '..');

export const OPENTUI_VERSION = '0.3.2';
const OPENTUI_COMMIT = '0d449d4c170a703197f0321f48c7e3bd38dcbd31';
const ZIG_VERSION = '0.15.2';
const ZIG_SUBPATH = 'packages/core/src/zig';
const PATCHES = ['nimbus-wasm-reactor-target.patch', 'nimbus-wasm-ffi-abi.patch'];

const SRC_DIR = process.env.NIMBUS_OPENTUI_SRC || '/tmp/opentui-research/opentui';
const ZIG_ROOT = process.env.NIMBUS_ZIG || '/tmp/opentui-research/zig-toolchain';

const ASSET_DIR = path.join(WORKER_ROOT, 'public', '_assets', 'opentui', OPENTUI_VERSION);
const OUT_TS = path.join(WORKER_ROOT, 'src', 'opentui-wasm-artifact.generated.ts');

function fail(message) {
  throw new Error(`[opentui-build-wasm] ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveZig() {
  const candidates = [ZIG_ROOT, path.join(ZIG_ROOT, 'zig')];
  try {
    for (const entry of await fs.readdir(ZIG_ROOT)) {
      if (entry.startsWith('zig-')) candidates.push(path.join(ZIG_ROOT, entry, 'zig'));
    }
  } catch {
    // ZIG_ROOT may itself be the zig binary; candidates[0] covers it.
  }
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const { stdout } = await execFile(candidate, ['version']).catch(() => ({ stdout: '' }));
    const version = stdout.trim();
    if (version !== ZIG_VERSION) {
      fail(`zig at ${candidate} is version '${version}', need exactly ${ZIG_VERSION}`);
    }
    return candidate;
  }
  fail(
    `no zig ${ZIG_VERSION} found under NIMBUS_ZIG=${ZIG_ROOT} ` +
      '(expected the zig binary, or a directory containing zig or zig-*/zig)',
  );
}

async function verifySource() {
  const pkgPath = path.join(SRC_DIR, 'packages', 'core', 'package.json');
  if (!(await exists(pkgPath))) {
    fail(
      `OpenTUI source not found at NIMBUS_OPENTUI_SRC=${SRC_DIR} ` +
        `(need the upstream checkout at v${OPENTUI_VERSION})`,
    );
  }
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  if (pkg.version !== OPENTUI_VERSION) {
    fail(`OpenTUI source at ${SRC_DIR} is @opentui/core ${pkg.version}, need ${OPENTUI_VERSION}`);
  }
  if (await exists(path.join(SRC_DIR, '.git'))) {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: SRC_DIR });
    const head = stdout.trim();
    if (head !== OPENTUI_COMMIT) {
      fail(`OpenTUI checkout at ${SRC_DIR} is at ${head}, pinned commit is ${OPENTUI_COMMIT}`);
    }
  }
}

async function stagePatchedTree() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opentui-wasm-'));
  const dest = path.join(tmpRoot, ZIG_SUBPATH);
  await fs.cp(path.join(SRC_DIR, ZIG_SUBPATH), dest, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '.zig-cache' && base !== 'zig-out' && base !== 'lib';
    },
  });

  const patches = [];
  for (const name of PATCHES) {
    const patchPath = path.join(__dirname, name);
    const bytes = await fs.readFile(patchPath);
    try {
      await execFile('git', ['apply', '--check', patchPath], { cwd: tmpRoot });
      await execFile('git', ['apply', patchPath], { cwd: tmpRoot });
    } catch (error) {
      fail(
        `patch ${name} does not apply to OpenTUI v${OPENTUI_VERSION} sources ` +
          `(upstream drift?): ${error.stderr || error.message}`,
      );
    }
    patches.push({ file: name, sha256: sha256(bytes) });
    console.log(`[opentui-build-wasm] applied ${name}`);
  }
  return { tmpRoot, zigDir: dest, patches };
}

async function build(zig, zigDir) {
  console.log('[opentui-build-wasm] zig build -Dtarget=wasm32-wasi -Doptimize=ReleaseSmall …');
  try {
    await execFile(zig, ['build', '-Dtarget=wasm32-wasi', '-Doptimize=ReleaseSmall'], {
      cwd: zigDir,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    fail(`zig build failed:\n${error.stderr || error.message}`);
  }
  const artifact = path.join(zigDir, 'lib', 'wasm32-wasi', 'opentui.wasm');
  if (!(await exists(artifact))) fail(`zig build produced no artifact at ${artifact}`);
  return fs.readFile(artifact);
}

async function wasmOpt(rawBytes, tmpRoot) {
  let version;
  try {
    const { stdout } = await execFile('wasm-opt', ['--version']);
    version = stdout.trim();
  } catch {
    console.log(
      '[opentui-build-wasm] wasm-opt not on PATH — staging the ReleaseSmall output as-is. ' +
        'Install binaryen for the size-optimized artifact.',
    );
    return { bytes: rawBytes, version: null };
  }
  const inPath = path.join(tmpRoot, 'opentui.raw.wasm');
  const outPath = path.join(tmpRoot, 'opentui.opt.wasm');
  await fs.writeFile(inPath, rawBytes);
  try {
    // Zig's wasm32-wasi baseline CPU features; the binary carries no
    // target_features section, so they must be enabled explicitly.
    await execFile('wasm-opt', [
      '-Oz',
      '--enable-mutable-globals',
      '--enable-sign-ext',
      '--enable-bulk-memory',
      '--enable-nontrapping-float-to-int',
      '--strip-debug',
      '--strip-producers',
      inPath,
      '-o',
      outPath,
    ]);
  } catch (error) {
    fail(`wasm-opt failed:\n${error.stderr || error.message}`);
  }
  return { bytes: await fs.readFile(outPath), version };
}

function validateModule(bytes) {
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module);

  const importModules = new Set(imports.map((entry) => entry.module));
  for (const moduleName of importModules) {
    if (moduleName !== 'wasi_snapshot_preview1' && moduleName !== 'opentui') {
      fail(`unexpected import module '${moduleName}' — host surface drifted`);
    }
  }
  const exportNames = new Set(exports.map((entry) => entry.name));
  for (const required of ['_initialize', 'memory', 'createRenderer', 'render', 'nimbus_alloc', 'nimbus_free']) {
    if (!exportNames.has(required)) fail(`required export '${required}' missing from artifact`);
  }
  const callbackImports = imports
    .filter((entry) => entry.module === 'opentui')
    .map((entry) => entry.name)
    .sort();
  const expectedCallbacks = ['eventSinkCallback', 'logCallback', 'streamCallback'];
  if (JSON.stringify(callbackImports) !== JSON.stringify(expectedCallbacks)) {
    fail(`opentui callback imports drifted: ${callbackImports.join(', ')}`);
  }
  return {
    wasiImports: imports
      .filter((entry) => entry.module === 'wasi_snapshot_preview1')
      .map((entry) => entry.name)
      .sort(),
    callbackImports,
    exportCount: exports.length,
  };
}

async function emitGenerated(buildId, artifactSha) {
  const content = `/**
 * opentui-wasm-artifact.generated.ts — AUTO-GENERATED by
 * scripts/opentui/build-wasm.mjs. DO NOT EDIT.
 *
 * Staged OpenTUI ${OPENTUI_VERSION} Zig core, built as a wasm32-wasi reactor
 * for the opencode TUI path. The artifact and its build manifest live in the
 * static-assets layer under public/_assets/opentui/${OPENTUI_VERSION}/.
 * See scripts/opentui/README.md for the build recipe and FFI ABI.
 *
 * Stage A: nothing consumes these constants yet; the facet module-map attach
 * path lands separately.
 *
 * OPENTUI_WASM_BUILD_ID is a content-hash prefix over the staged artifact so
 * cache layers keyed on it never serve stale bytes after a same-version
 * rebuild; OPENTUI_WASM_SHA256 is the full digest for integrity checks at
 * attach time.
 */

export const OPENTUI_WASM_VERSION: string = ${JSON.stringify(OPENTUI_VERSION)};
export const OPENTUI_WASM_BUILD_ID: string = ${JSON.stringify(buildId)};
export const OPENTUI_WASM_ENTRY: string = ${JSON.stringify(`/_assets/opentui/${OPENTUI_VERSION}/opentui.wasm`)};
export const OPENTUI_WASM_SHA256: string = ${JSON.stringify(artifactSha)};
`;
  await fs.writeFile(OUT_TS, content);
}

async function main() {
  const [zig] = await Promise.all([resolveZig(), verifySource()]);
  const { tmpRoot, zigDir, patches } = await stagePatchedTree();
  try {
    const rawBytes = await build(zig, zigDir);
    const { bytes, version: wasmOptVersion } = await wasmOpt(rawBytes, tmpRoot);
    const shape = validateModule(bytes);

    const artifactSha = sha256(bytes);
    const buildId = artifactSha.slice(0, 16);

    await fs.rm(ASSET_DIR, { recursive: true, force: true });
    await fs.mkdir(ASSET_DIR, { recursive: true });
    await fs.writeFile(path.join(ASSET_DIR, 'opentui.wasm'), bytes);

    const manifest = {
      name: '@opentui/core zig renderer (wasm32-wasi reactor)',
      version: OPENTUI_VERSION,
      sourceCommit: OPENTUI_COMMIT,
      zigVersion: ZIG_VERSION,
      target: 'wasm32-wasi',
      optimize: 'ReleaseSmall',
      patches,
      wasmOpt: wasmOptVersion,
      artifact: {
        file: 'opentui.wasm',
        sha256: artifactSha,
        size: bytes.length,
        gzipSize: gzipSync(bytes, { level: 9 }).length,
        preWasmOptSha256: sha256(rawBytes),
        preWasmOptSize: rawBytes.length,
      },
      imports: {
        wasi_snapshot_preview1: shape.wasiImports,
        opentui: shape.callbackImports,
      },
      exportCount: shape.exportCount,
    };
    await fs.writeFile(path.join(ASSET_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await emitGenerated(buildId, artifactSha);

    console.log(
      `[opentui-build-wasm] staged opentui ${OPENTUI_VERSION} → ${path.relative(WORKER_ROOT, ASSET_DIR)}/opentui.wasm ` +
        `(${bytes.length} bytes, gzip ${manifest.artifact.gzipSize}, ${shape.exportCount} exports, build ${buildId})`,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

await main();
