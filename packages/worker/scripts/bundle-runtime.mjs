#!/usr/bin/env node
/**
 * scripts/bundle-runtime.mjs — ingest an upstream runtime into the
 * `nimbus-runtime-cache` R2 bucket.
 *
 * Invocation:
 *   node scripts/bundle-runtime.mjs clang binji-2020 [--bucket nimbus-runtime-cache]
 *   node scripts/bundle-runtime.mjs python 0.29.4 [--bucket nimbus-runtime-cache]
 *
 * Per `2026-05-10-true-os/plan.md` §2.4:
 *   - Blobs are content-addressed under `blobs/<name>-<version>/<sha256>/<file>`.
 *   - Per-version manifest at `manifests/<name>-<version>.json` lists
 *     the files (path-in-VFS, content R2 key, sha256, size, mode).
 *   - Top-level `catalog/v1.json` lists known runtimes.
 *
 * For `clang binji-2020`, the upstream is:
 *   https://raw.githubusercontent.com/binji/wasm-clang/master/{clang,lld,sysroot.tar}
 *
 * The script:
 *   1. Downloads each upstream file to /tmp.
 *   2. Computes sha256.
 *   3. Uploads to R2 via `wrangler r2 object put`.
 *   4. Writes a per-version manifest + appends to catalog/v1.json.
 *
 * Idempotent: re-running compares sha256 with what's currently
 * uploaded; skips re-upload on match. Re-run is safe at any time.
 *
 * Requires CLOUDFLARE_ACCOUNT_ID env var + a wrangler login already
 * established at the host. Anti-req: no `--force` / no destructive
 * fallthrough.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID env var required');
  process.exit(1);
}
// Resolve the wrangler bin from either the package-local or the
// repo-root node_modules (this script runs from packages/worker but
// the bin is hoisted to the workspace root).
const WRANGLER = [
  './node_modules/.bin/wrangler',
  '../../node_modules/.bin/wrangler',
].find((p) => existsSync(p)) || 'wrangler';
const PYODIDE_WORKERD_ADAPTER = JSON.parse(
  readFileSync(new URL('../runtime-contracts/pyodide-workerd-adapter.json', import.meta.url), 'utf8'),
);

const rawArgs = process.argv.slice(2);
const positionalArgs = [];
let BUCKET = process.env.NIMBUS_RUNTIME_BUCKET || 'nimbus-runtime-cache';
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--bucket') {
    const value = rawArgs[++i];
    if (!value) {
      console.error('usage: bundle-runtime.mjs <name> <version> [--bucket <bucket>]');
      process.exit(2);
    }
    BUCKET = value;
    continue;
  }
  if (arg.startsWith('--bucket=')) {
    BUCKET = arg.slice('--bucket='.length);
    continue;
  }
  positionalArgs.push(arg);
}

if (!positionalArgs[0] || !positionalArgs[1]) {
  console.error('usage: bundle-runtime.mjs <name> <version> [--bucket <bucket>]');
  process.exit(2);
}

const RUNTIME = positionalArgs[0];
const VERSION = positionalArgs[1];

/**
 * Static per-runtime spec. Each entry says where to fetch the upstream
 * file from and how to map it into the per-user VFS at install time.
 *
 * For `clang binji-2020`:
 *   - VFS path `bin/clang`          ← upstream `clang`         (31.2 MB)
 *   - VFS path `bin/wasm-ld`        ← upstream `lld`           (19.5 MB)
 *   - VFS path `share/clang/sysroot.tar`← upstream `sysroot.tar` (9.3 MB)
 *   - VFS path `LICENSE`            ← bundled APACHE-2.0 text
 */
const SPECS = {
  'clang/binji-2020': {
    license: 'Apache-2.0-with-LLVM-exception',
    wasi_namespace: 'wasi_unstable',
    upstream_base: 'https://raw.githubusercontent.com/binji/wasm-clang/master',
    files: [
      { src: 'clang',       vfs: 'bin/clang',                  mode: 'exec',   runner: 'clang-runner', binName: 'clang' },
      { src: 'lld',         vfs: 'bin/wasm-ld',                mode: 'exec',   runner: 'clang-runner', binName: 'wasm-ld', kind: 'linker' },
      { src: 'sysroot.tar', vfs: 'share/clang/sysroot.tar' },
    ],
    // Bundled LICENSE text — Apache 2.0 with LLVM exception (full text below).
    // Source: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT
    license_text: APACHE_2_LLVM_LICENSE_TEXT(),
  },
  // ── Ruby (v1, 2026-05-11) ────────────────────────────────────────
  // ruby.wasm 2.9.3-2.9.4 from npm @ruby/3.3-wasm-wasi (Ruby 3.3.x
  // built on WASI). We bundle ONLY the `ruby+stdlib.wasm` artifact
  // (34.3 MiB) — it's self-contained, stdlib is packed via wasi-vfs
  // into the wasm. No separate stdlib zip transport needed (unlike
  // Pyodide which ships python_stdlib.zip alongside the asm.js).
  //
  // Upstream channel: npm tarball — the script downloads the tarball
  // (`upstream_base + '/' + src`) and extracts the wasm by file
  // name via the `tarball_extract` flag. Each spec.files entry's
  // `src` is interpreted as the path INSIDE the extracted tarball.
  //
  // See /workspace/.seal-internal/2026-05-11-ruby-v1/audit.md for
  // the full artifact audit + import/export breakdown.
  'ruby/3.3.4': {
    license: 'Ruby+BSD-2-Clause',
    wasi_namespace: 'wasi_snapshot_preview1',
    upstream_base: 'https://registry.npmjs.org/@ruby/3.3-wasm-wasi/-/3.3-wasm-wasi-2.9.3-2.9.4.tgz',
    tarball_extract: 'package/dist',  // strip this prefix from src paths inside the tarball
    files: [
      // The Ruby wasm — includes Ruby 3.3.x interpreter + stdlib packed
      // via wasi-vfs. ruby-runner instantiates this at child-facet
      // module-init time and drives it via the Ruby ABI exports
      // (`ruby-init`, `ruby-init-loadpath`, `rb-eval-string-protect`).
      { src: 'ruby+stdlib.wasm', vfs: 'share/ruby/ruby+stdlib.wasm' },
      // User-facing bin entries. The shell registry dispatches `ruby`
      // and `ruby3` to ruby-runner; this file is a marker, not exec.
      { src: 'BIN_MARKER', vfs: 'bin/ruby',  mode: 'exec', runner: 'ruby-runner', binName: 'ruby' },
      { src: 'BIN_MARKER', vfs: 'bin/ruby3', mode: 'exec', runner: 'ruby-runner', binName: 'ruby3' },
    ],
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus ruby-runner launcher marker. The actual Ruby wasm\n' +
        '# lives in share/ruby/. This file is here only so `which ruby`\n' +
        '# and `ls bin/` find a regular file at the expected path. The\n' +
        '# shell-registry dispatches `ruby` directly to the ruby-runner\n' +
        '# factory; this file is not read or executed by Nimbus.\n',
        'utf8',
      ),
    },
    license_text: RUBY_LICENSE_TEXT(),
  },
  // ── GNU bash (fork runtime, 2026-07-20) ──────────────────────────
  // bash 5.2.37 cross-compiled to wasm32-wasi with the Nimbus process
  // overlay (nimbus-proc.{h,c}: fork/exec/wait/pipe over nimbus_proc.*
  // imports + asyncify-native setjmp) and asyncify-instrumented.
  // There is NO upstream binary channel — the artifacts are built from
  // source by packages/worker/wasm/bash/build-bash.sh (bash) and
  // coreutils/build-busybox.sh (BusyBox 1.37.0, the plain-WASI multicall
  // exec target providing ls/cat/cp/mv/rm/grep/sed/awk/find/... — see
  // busybox.applets), then staged from the local build tree via
  // `local_base`. The bash-runner aliases every applet name in
  // busybox.applets onto the busybox module so bash's PATH lookup finds
  // them in /bin and /usr/bin.
  'bash/5.2.37': {
    license: 'GPL-3.0-or-later AND GPL-2.0-only',
    wasi_namespace: 'wasi_snapshot_preview1',
    local_base: '../wasm/bash',
    files: [
      { src: 'bash.async.wasm',           vfs: 'share/bash/bash.async.wasm' },
      { src: 'coreutils/busybox.wasm',    vfs: 'share/bash/coreutils/busybox.wasm' },
      { src: 'coreutils/busybox.applets', vfs: 'share/bash/coreutils/busybox.applets' },
      { src: 'BIN_MARKER', vfs: 'bin/bash', mode: 'exec', runner: 'bash-runner', binName: 'bash' },
    ],
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus bash-runner launcher marker. The real GNU bash wasm\n' +
        '# lives in share/bash/. The shell registry dispatches `bash`\n' +
        '# (and #!/bin/bash shebangs) to the bash-runner factory; this\n' +
        '# file exists so `which bash` and `ls bin/` find a regular,\n' +
        '# executable file at the expected path.\n',
        'utf8',
      ),
    },
    license_text: GPL_3_LICENSE_NOTICE(),
  },
  'python/0.29.4': {
    license: 'MPL-2.0',
    wasi_namespace: null,        // Pyodide is Emscripten, not WASI
    upstream_base: 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full',
    files: [
      // The wasm module Pyodide instantiates. Goes to share/ so the
      // user-VFS layout matches binji-clang's convention (bin/ for
      // exec entry, share/<name>/ for runtime-private blobs).
      { src: 'pyodide.asm.wasm', vfs: 'share/pyodide/pyodide.asm.wasm' },
      // The Emscripten JS half. Runtime sync adapts it once for
      // workerd and records that contract in manifest metadata; the
      // Python runner consumes the resulting artifact without patching
      // it during session boot.
      { src: 'pyodide.asm.js',   vfs: 'share/pyodide/pyodide.asm.js', transform: 'pyodide-workerd-adapter' },
      // Python 3.13 stdlib. Pyodide writes this into its Emscripten
      // MEMFS at /lib/python313.zip and CPython imports from there
      // via the ZipImporter on sys.path.
      { src: 'python_stdlib.zip', vfs: 'share/pyodide/python_stdlib.zip' },
      // Lockfile — only used by pyodide.loadPackage / micropip (v3
      // scope). We ship it so v3 doesn't need to re-bundle from
      // scratch; v1 ignores its contents.
      { src: 'pyodide-lock.json', vfs: 'share/pyodide/pyodide-lock.json' },
      // The user-facing "bin" — a tiny launcher marker. We don't
      // actually exec this file; the python-runner factory pulls
      // bytes from the share/ entries and ignores bin/python's
      // content. The presence of the entry in entrypoints[] is what
      // wires `python` into the shell registry.
      { src: 'BIN_MARKER',       vfs: 'bin/python',  mode: 'exec', runner: 'python-runner', binName: 'python' },
      // Second entrypoint — `python3` is conventional on Linux.
      { src: 'BIN_MARKER',       vfs: 'bin/python3', mode: 'exec', runner: 'python-runner', binName: 'python3' },
    ],
    license_text: MPL_2_LICENSE_TEXT(),
    /** Source 'BIN_MARKER' is synthesised, not fetched. */
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus python-runner launcher marker. The actual Pyodide\n' +
        '# bootstrap lives in share/pyodide/. This file is here only so\n' +
        '# `which python` and `ls bin/` find a regular file at the\n' +
        '# expected path. The shell-registry dispatches `python`\n' +
        '# directly to the python-runner factory; this file is not\n' +
        '# read or executed by Nimbus.\n',
        'utf8',
      ),
    },
    python_packages: ['numpy', 'markupsafe'],
  },

  // CPython 3.13 cross-built for wasm32-wasi by packages/worker/wasm/python/
  // build-python.sh, with the C libraries the published wasm32-wasi artifacts
  // leave out (zlib, bzip2, xz, sqlite, OpenSSL). Unlike the Pyodide entry
  // above this is a real WASI module: it talks to runtime/wasi/preamble.ts, so
  // it has no filesystem of its own to copy in and diff back out.
  //
  // Additive alongside python/0.29.4. Nothing reads these keys until
  // session/init.ts routes `python` at the cpython-runner factory.
  'cpython/3.13.14': {
    license: 'PSF-2.0',
    wasi_namespace: 'wasi_snapshot_preview1',
    local_base: '../wasm/python',
    files: [
      { src: 'python.wasm',   vfs: 'share/cpython/python.wasm' },
      // The stdlib, pyc-only. Read straight out of the session filesystem by
      // zipimport, which is why it needs no separate transport.
      { src: 'python313.zip', vfs: 'share/cpython/python313.zip' },
      { src: 'BIN_MARKER', vfs: 'bin/python',  mode: 'exec', runner: 'cpython-runner', binName: 'python' },
      { src: 'BIN_MARKER', vfs: 'bin/python3', mode: 'exec', runner: 'cpython-runner', binName: 'python3' },
    ],
    license_text: PSF_LICENSE_NOTICE(),
    /** Source 'BIN_MARKER' is synthesised, not fetched. */
    synthetic_files: {
      'BIN_MARKER': Buffer.from(
        '# Nimbus cpython-runner launcher marker. The interpreter itself\n' +
        '# lives in share/cpython/. This file exists so `which python` and\n' +
        '# `ls bin/` find a regular, executable file at the expected path;\n' +
        '# the shell registry dispatches `python` directly to the\n' +
        '# cpython-runner factory and never reads this content.\n',
        'utf8',
      ),
    },
  },

  // 2026-05-11 sysroot-prep Phase 0 — R2 ingestion ONLY for the
  // clang-sysroot-swap wave. This entry stages the upstream wasi-sdk-19
  // sysroot in R2 (binji-shape: rootless `include/lib/share` layout) so
  // when the swap wave dispatches, the blob is already present.
  //
  // `ingest_only: true` SUPPRESSES the manifest write AND the catalog
  // auto-flip at the bottom of the script. The swap wave owns those
  // operations (it composes a new manifest that inherits bin/clang,
  // bin/wasm-ld from binji-2020 and references this
  // prep'd sysroot.tar blob, then flips `clang.default`).
  //
  // `repackage` describes a download+extract+retar pre-step that
  // produces a single local `sysroot.tar` file BEFORE the upload loop.
  // The file's `src` value is used as both the cached download filename
  // and (after repackage) the upload basename.
  'clang/wasi-sdk-19': {
    license: 'Apache-2.0-with-LLVM-exception',
    ingest_only: true,
    files: [
      // The upload loop sees one logical "file" with src='sysroot.tar'.
      // The repackage step below produces it from the upstream tarball
      // and writes it to <workDir>/sysroot.tar before the upload loop
      // runs. `vfs` mirrors the binji-2020 path for the swap wave's
      // manifest composer (kept for documentation only; ignored in
      // ingest_only mode since no manifest is written).
      { src: 'sysroot.tar', vfs: 'share/clang/sysroot.tar' },
    ],
    // Build-time step: fetch the upstream wasi-sdk-19 sysroot tarball,
    // extract, and re-tar in binji-2020 layout (rootless: include/, lib/,
    // share/ as top-level entries, no `wasi-sysroot/` prefix). Runs
    // BEFORE the existing fetch loop sees `sysroot.tar`.
    repackage: {
      upstream_url:
        'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-19/wasi-sysroot-19.0.tar.gz',
      // sha256 of the upstream .tar.gz, captured 2026-05-11.
      // Falsification: bundle-runtime.mjs verifies this on every run.
      upstream_sha256:
        'd601c901a26d6cdb158e60c8a981caa189e87875abc23bb071c2c533a39fd143',
      // Subdir inside the extracted tarball whose children become the
      // top-level entries of the produced sysroot.tar.
      strip_prefix: 'wasi-sysroot',
      // Directories at strip_prefix to include in the produced sysroot.tar.
      // Anything else under wasi-sysroot/ is dropped.
      include_dirs: ['include', 'lib', 'share'],
      // Expected sha256 of the *produced* sysroot.tar. Captured from a
      // dry-run inspection at /tmp/sysroot-prep-work/ (see prep audit).
      // Verified before upload; abort on mismatch.
      output_sha256:
        '82f30ed81d39072d54e3ba207305c26bfc29a7726e500230db3cad8abe828be3',
      // Expected raw byte size of the produced sysroot.tar.
      output_size: 11898880,
    },
    // license_text intentionally omitted — ingest_only mode skips the
    // bundled LICENSE write. The swap wave composes a concat-license
    // (binji + wasi-libc) at manifest time.
  },
};

const key = `${RUNTIME}/${VERSION}`;
const spec = SPECS[key];
if (!spec) {
  console.error(`unknown spec: ${key}`);
  console.error(`known: ${Object.keys(SPECS).join(', ')}`);
  process.exit(2);
}

const workDir = join(tmpdir(), `bundle-runtime-${RUNTIME}-${VERSION}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

console.log(`[bundle-runtime] ${RUNTIME} ${VERSION}`);
console.log(`[bundle-runtime] work dir: ${workDir}`);
console.log(`[bundle-runtime] bucket:   ${BUCKET}`);
console.log(`[bundle-runtime] account:  ${ACCOUNT}`);

// ── 0. Optional repackage step (sysroot-prep wave) ──────────────────
// Runs BEFORE the fetch loop. Produces one or more local files inside
// workDir that the fetch loop then sees as "already downloaded" (its
// `!existsSync` check passes through). Spec entries that don't need
// repackaging (e.g. clang/binji-2020) omit this field entirely.
if (spec.repackage) {
  runRepackage(spec.repackage, workDir);
}

// ── 1. Fetch upstream artifacts (or generate synthetic ones) ───────
const downloaded = [];
const seenSrc = new Set();  // dedupe — `python` and `python3` share BIN_MARKER
for (const f of spec.files) {
  const local = join(workDir, f.src);
  // First time we see this `src`: fetch or synthesise, then write
  // local file. Repeated `src` (e.g. BIN_MARKER for python + python3)
  // skips the IO but still appends a manifest row pointing at the
  // same content blob.
  if (!seenSrc.has(f.src)) {
    seenSrc.add(f.src);
    const synthetic = spec.synthetic_files && spec.synthetic_files[f.src];
    if (synthetic !== undefined) {
      writeFileSync(local, synthetic);
      console.log(`[bundle-runtime] synth ${f.src} (${synthetic.length} bytes)`);
    } else if (spec.tarball_extract) {
      // Tarball extraction path: download the tarball ONCE (cached
      // across files), then extract `<tarball_extract>/<src>` into
      // `<workDir>/<src>` (basename only). Used by ruby-3.3.x where
      // the upstream channel is a single npm tarball containing
      // multiple files.
      const tarballLocal = join(workDir, '_tarball.tgz');
      if (!existsSync(tarballLocal)) {
        console.log(`[bundle-runtime] fetch tarball ${spec.upstream_base}`);
        execSync(`curl -sS -L -k -o "${tarballLocal}" "${spec.upstream_base}"`, { stdio: 'inherit' });
      }
      console.log(`[bundle-runtime] extract ${spec.tarball_extract}/${f.src}`);
      execSync(
        `tar -xzf "${tarballLocal}" -C "${workDir}" --strip-components=2 "${spec.tarball_extract}/${f.src}"`,
        { stdio: 'inherit' },
      );
    } else if (spec.local_base) {
      // Locally-built runtime (no upstream binary channel): stage the
      // artifact from the repo build tree, resolved against this script.
      const from = new URL(`${spec.local_base}/${f.src}`, import.meta.url);
      if (!existsSync(from)) {
        console.error(`[bundle-runtime] missing local artifact: ${from.pathname}`);
        console.error(`[bundle-runtime] build it first (see ${spec.local_base}/BRINGUP.md)`);
        process.exit(1);
      }
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, readFileSync(from));
      console.log(`[bundle-runtime] local ${f.src} ← ${from.pathname}`);
    } else if (!existsSync(local)) {
      const url = `${spec.upstream_base}/${f.src}`;
      console.log(`[bundle-runtime] fetch ${url}`);
      execSync(`curl -sS -L -o "${local}" "${url}"`, { stdio: 'inherit' });
    }
  }
  const sourceBytes = readFileSync(local);
  const transformed = applyRuntimeTransform(f, sourceBytes);
  if (transformed.bytes !== sourceBytes) {
    writeFileSync(local, transformed.bytes);
    console.log(`[bundle-runtime] transform ${f.src}: ${transformed.metadata.id}`);
  }
  const bytes = transformed.bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const r2Key = runtimeBlobKey(f.src, sha256);
  downloaded.push({ ...f, local, bytes, sha256, size: bytes.length, r2Key, transformMetadata: transformed.metadata });
  console.log(`[bundle-runtime]   ${f.vfs} (← ${f.src}) → ${(bytes.length / 1024 / 1024).toFixed(2)} MiB sha256=${sha256.slice(0, 16)}…`);
}

const packageRuntimeArtifacts = stagePythonPackages(spec, workDir, downloaded);

// Bundled LICENSE file. Skipped in ingest_only mode — the swap wave
// composes the final LICENSE at manifest-compose time.
if (!spec.ingest_only) {
  const licenseLocal = join(workDir, 'LICENSE');
  writeFileSync(licenseLocal, spec.license_text);
  const licenseBytes = readFileSync(licenseLocal);
  const licenseSha256 = createHash('sha256').update(licenseBytes).digest('hex');
  downloaded.push({
    src: 'LICENSE', vfs: 'LICENSE', local: licenseLocal, bytes: licenseBytes,
    sha256: licenseSha256, size: licenseBytes.length, r2Key: runtimeBlobKey('LICENSE', licenseSha256),
  });
  console.log(`[bundle-runtime]   LICENSE → ${licenseBytes.length} bytes sha256=${licenseSha256.slice(0, 16)}…`);
}

// ── 2. Upload each file as a content-addressed blob (deduped) ──────
// Content path: blobs/<name>-<version>/<sha256>/<src-name>. Multiple
// manifest entries pointing at identical content share one R2 upload.
const uploadedBlobKeys = new Set();
for (const f of downloaded) {
  if (uploadedBlobKeys.has(f.r2Key)) continue;
  uploadedBlobKeys.add(f.r2Key);
  console.log(`[bundle-runtime] put r2://${BUCKET}/${f.r2Key}`);
  execSync(
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} ${WRANGLER} r2 object put ${BUCKET}/${f.r2Key} --file "${f.local}" --remote`,
    { stdio: 'inherit' },
  );
}

// ── 3 + 4. Manifest + catalog. Skipped in ingest_only mode (the swap
// wave composes those at manifest-compose time; this prep pass only
// stages the upstream blobs).
const totalMb = (downloaded.reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(2);

if (spec.ingest_only) {
  console.log(`\n[bundle-runtime] DONE (ingest_only)`);
  console.log(`[bundle-runtime] uploaded ${downloaded.length} file(s) (${totalMb} MiB) for ${RUNTIME}@${VERSION}`);
  console.log(`[bundle-runtime] blobs:    r2://${BUCKET}/blobs/${RUNTIME}-${VERSION}/`);
  console.log(`[bundle-runtime] manifest: SKIPPED (swap wave will compose)`);
  console.log(`[bundle-runtime] catalog:  UNCHANGED (swap wave will flip default)`);
} else {
  // ── 3. Write the per-version manifest ────────────────────────────
  const runtimeArtifacts = downloaded
    .filter((f) => f.transformMetadata)
    .map((f) => ({
      path: f.vfs,
      kind: f.transformMetadata.kind,
      id: f.transformMetadata.id,
      source_sha256: f.transformMetadata.source_sha256,
      sha256: f.sha256,
    }));
  runtimeArtifacts.push(...packageRuntimeArtifacts);

  const manifest = {
    name: RUNTIME,
    version: VERSION,
    license: spec.license,
    wasi_namespace: spec.wasi_namespace || null,
    files: downloaded.map((f) => ({
      path: f.vfs,
      content: f.r2Key,
      sha256: f.sha256,
      size: f.size,
      ...(f.mode ? { mode: f.mode } : {}),
    })),
    entrypoints: spec.files
      .filter((f) => f.runner)
      .map((f) => ({
        binName: f.binName,
        runner: f.runner,
        args: [],
        ...(f.kind ? { kind: f.kind } : {}),
      })),
    ...(runtimeArtifacts.length ? { runtime_artifacts: runtimeArtifacts } : {}),
  };

  const manifestLocal = join(workDir, 'manifest.json');
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(manifestLocal, manifestText);
  const manifestR2Key = `manifests/${RUNTIME}-${VERSION}.json`;
  console.log(`[bundle-runtime] put r2://${BUCKET}/${manifestR2Key}`);
  execSync(
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} ${WRANGLER} r2 object put ${BUCKET}/${manifestR2Key} --file "${manifestLocal}" --content-type application/json --remote`,
    { stdio: 'inherit' },
  );

  // ── 4. Update the top-level catalog ──────────────────────────────
  const catalogR2Key = 'catalog/v1.json';
  const catalog = readCatalogForUpdate(catalogR2Key);
  const knownRuntimesBefore = Object.keys(catalog.runtimes);

  if (!catalog.runtimes[RUNTIME]) catalog.runtimes[RUNTIME] = { default: VERSION, versions: {} };
  // Catalog size_bytes counts unique blob content, not duplicate
  // manifest entries.
  const catalogSize = (() => {
    const seen = new Set();
    let total = 0;
    for (const f of downloaded) {
      if (seen.has(f.r2Key)) continue;
      seen.add(f.r2Key);
      total += f.size;
    }
    return total;
  })();
  catalog.runtimes[RUNTIME].versions[VERSION] = {
    manifest: manifestR2Key,
    size_bytes: catalogSize,
    license: spec.license,
  };
  // Update default to the just-uploaded version (idempotent — if it was
  // already the default, no-op).
  catalog.runtimes[RUNTIME].default = VERSION;

  // The catalog indexes every runtime, so an update that drops one is a
  // publish that unregisters somebody else's. Cheap to assert, and it catches
  // a future edit to this function as well as a bad read.
  for (const name of knownRuntimesBefore) {
    if (!catalog.runtimes[name]) {
      console.error(`ERROR: refusing to publish a catalog that lost runtime '${name}'`);
      process.exit(1);
    }
  }

  const catalogLocal = join(workDir, 'catalog.json');
  writeFileSync(catalogLocal, JSON.stringify(catalog, null, 2));
  console.log(`[bundle-runtime] put r2://${BUCKET}/${catalogR2Key}`);
  execSync(
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} ${WRANGLER} r2 object put ${BUCKET}/${catalogR2Key} --file "${catalogLocal}" --content-type application/json --remote`,
    { stdio: 'inherit' },
  );

  console.log(`\n[bundle-runtime] DONE`);
  console.log(`[bundle-runtime] uploaded ${downloaded.length} files (${totalMb} MiB) for ${RUNTIME}@${VERSION}`);
  console.log(`[bundle-runtime] manifest:  r2://${BUCKET}/${manifestR2Key}`);
  console.log(`[bundle-runtime] catalog:   r2://${BUCKET}/${catalogR2Key}`);
}

/**
 * Read catalog/v1.json for a read-modify-write.
 *
 * catalog/v1.json is a single shared index over every runtime, and this read is
 * the only thing between a transient R2 failure and publishing an empty catalog
 * over the top of a populated one. The previous version swallowed stderr and
 * fell back to `{ runtimes: {} }` on ANY failure, then wrote that back — so a
 * network blip during a `bundle-runtime.mjs clang ...` would have silently
 * unregistered python, ruby and bash, and said "no existing catalog; creating
 * fresh" while doing it.
 *
 * A genuinely absent object is the one recoverable case, and it is
 * distinguishable: wrangler says so in as many words. Everything else stops.
 */
function readCatalogForUpdate(catalogR2Key) {
  const result = spawnSync(
    WRANGLER,
    ['r2', 'object', 'get', `${BUCKET}/${catalogR2Key}`, '--pipe', '--remote'],
    { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } },
  );
  const stderr = result.stderr || '';
  const missing = /The specified key does not exist|NoSuchKey|Object not found/i.test(stderr);
  const body = (result.stdout || '').trim();

  if (missing && !body) {
    console.log('[bundle-runtime] no existing catalog; creating the first one');
    return { version: 1, runtimes: {} };
  }
  if (result.error || !body) {
    console.error('ERROR: could not read the existing catalog, and overwriting it blind would');
    console.error('       unregister every runtime already published. Nothing was written.');
    if (result.error) console.error(`       ${result.error.message}`);
    if (stderr.trim()) console.error(`       ${stderr.trim().split('\n').slice(-3).join('\n       ')}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    console.error(`ERROR: the existing catalog is not valid JSON (${e.message}); refusing to replace it`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.runtimes !== 'object' || parsed.runtimes === null) {
    console.error('ERROR: the existing catalog has no runtimes object; refusing to replace it');
    process.exit(1);
  }
  console.log(`[bundle-runtime] existing catalog lists: ${Object.keys(parsed.runtimes).join(', ') || '(none)'}`);
  return parsed;
}

// ── Runtime transforms ───────────────────────────────────────────────

function runtimeBlobKey(src, sha256) {
  return `blobs/${RUNTIME}-${VERSION}/${sha256}/${src}`;
}

function applyRuntimeTransform(fileSpec, sourceBytes) {
  if (!fileSpec.transform) return { bytes: sourceBytes, metadata: null };
  if (fileSpec.transform !== 'pyodide-workerd-adapter') {
    throw new Error(`unknown transform '${fileSpec.transform}' for ${fileSpec.src}`);
  }
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const sourceText = sourceBytes.toString('utf8');
  const transformedText = applyPyodideWorkerdAdapter(sourceText, fileSpec.src);
  const bytes = Buffer.from(transformedText, 'utf8');
  return {
    bytes,
    metadata: {
      kind: 'workerd-adapter',
      id: PYODIDE_WORKERD_ADAPTER.id,
      source_sha256: sourceSha256,
    },
  };
}

function applyPyodideWorkerdAdapter(sourceText, label) {
  if (sourceText.startsWith(PYODIDE_WORKERD_ADAPTER.sentinel)) {
    throw new Error(`${label} already contains ${PYODIDE_WORKERD_ADAPTER.id}; expected pristine upstream source`);
  }
  let out = sourceText;
  for (const patch of PYODIDE_WORKERD_ADAPTER.patches) {
    const matches = countOccurrences(out, patch.find);
    if (matches !== 1) {
      throw new Error(
        `${label}: adapter ${PYODIDE_WORKERD_ADAPTER.id} expected exactly one ` +
        `'${patch.name}' target, found ${matches}`,
      );
    }
    out = out.replace(patch.find, patch.replace);
  }
  return `${PYODIDE_WORKERD_ADAPTER.sentinel}\n${out}`;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = haystack.indexOf(needle, offset);
    if (idx < 0) return count;
    count++;
    offset = idx + needle.length;
  }
}

function stagePythonPackages(spec, workDir, downloaded) {
  if (!spec.python_packages || spec.python_packages.length === 0) return [];
  const lockfileLocal = join(workDir, 'pyodide-lock.json');
  if (!existsSync(lockfileLocal)) {
    throw new Error('python_packages requires pyodide-lock.json in the runtime spec');
  }
  const lockfile = JSON.parse(readFileSync(lockfileLocal, 'utf8'));
  const packages = lockfile && typeof lockfile === 'object' && lockfile.packages && typeof lockfile.packages === 'object'
    ? lockfile.packages
    : null;
  if (!packages) throw new Error('pyodide-lock.json has no packages object');

  const artifacts = [];
  for (const requested of spec.python_packages) {
    const entry = findPyodideLockPackage(packages, requested);
    if (!entry) throw new Error(`pyodide package '${requested}' not found in lockfile`);
    const wheelFileName = entry.file_name;
    const wheelUrl = `${spec.upstream_base}/${wheelFileName}`;
    const packageDir = join(workDir, 'python-packages', entry.name.toLowerCase());
    mkdirSync(packageDir, { recursive: true });
    const wheelLocal = join(packageDir, wheelFileName);
    if (!existsSync(wheelLocal)) {
      console.log(`[bundle-runtime] fetch python package ${wheelUrl}`);
      execFileSync('curl', ['-sS', '-L', '-o', wheelLocal, wheelUrl], { stdio: 'inherit' });
    }
    const wheelBytes = readFileSync(wheelLocal);
    const wheelSha256 = createHash('sha256').update(wheelBytes).digest('hex');
    if (wheelSha256 !== String(entry.sha256).toLowerCase()) {
      throw new Error(`${entry.name}: wheel sha256 mismatch: expected ${entry.sha256} got ${wheelSha256}`);
    }
    const wheelVfs = `share/pyodide/packages/${wheelFileName}`;
    downloaded.push({
      src: `python-packages/${entry.name}/${wheelFileName}`,
      vfs: wheelVfs,
      local: wheelLocal,
      bytes: wheelBytes,
      sha256: wheelSha256,
      size: wheelBytes.length,
      r2Key: runtimeBlobKey(`python-packages/${entry.name}/${wheelFileName}`, wheelSha256),
    });

    const extensionModules = [];
    const members = execFileSync('zipinfo', ['-1', wheelLocal], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.so'));
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const runtimePath = `share/pyodide/packages/${entry.name}/side-modules/${member}`;
      const sideLocal = join(packageDir, 'side-modules', member);
      extractZipMemberToFile(wheelLocal, member, sideLocal);
      const sideBytes = readFileSync(sideLocal);
      const sideSha256 = createHash('sha256').update(sideBytes).digest('hex');
      downloaded.push({
        src: `python-packages/${entry.name}/side-modules/${member}`,
        vfs: runtimePath,
        local: sideLocal,
        bytes: sideBytes,
        sha256: sideSha256,
        size: sideBytes.length,
        r2Key: runtimeBlobKey(`python-packages/${entry.name}/side-modules/${member}`, sideSha256),
      });
      extensionModules.push({
        path: member,
        runtimePath,
        sha256: sideSha256,
      });
    }
    artifacts.push({
      path: wheelVfs,
      kind: 'python-package',
      id: `pyodide-package:${entry.name.toLowerCase()}@${entry.version}`,
      sha256: wheelSha256,
      language: 'python',
      packageName: entry.name,
      version: entry.version,
      abi: 'pyodide-emscripten-2025_0-wasm32',
      pyodideVersion: VERSION,
      pythonVersion: lockfile.info?.python || '3.13.2',
      wheelFileName,
      wheelSha256,
      loadMode: 'startup-module',
      imports: Array.isArray(entry.imports) ? entry.imports : [],
      dependencies: Array.isArray(entry.depends) ? entry.depends : [],
      extensionModules,
    });
    console.log(`[bundle-runtime] python package ${entry.name} ${entry.version}: ${members.length} startup module(s)`);
  }
  return artifacts;
}

function extractZipMemberToFile(zipPath, member, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const fd = openSync(outPath, 'w');
  let result;
  try {
    result = spawnSync('unzip', ['-p', zipPath, member], {
      stdio: ['ignore', fd, 'pipe'],
    });
  } finally {
    closeSync(fd);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? Buffer.from(result.stderr).toString('utf8').trim() : '';
    throw new Error(`unzip failed for ${member}: ${stderr || `exit ${result.status ?? 'unknown'}`}`);
  }
}

function findPyodideLockPackage(packages, requested) {
  const canonicalRequested = canonicalPythonPackageName(requested);
  for (const entry of Object.values(packages)) {
    if (!entry || typeof entry !== 'object') continue;
    if (canonicalPythonPackageName(entry.name) === canonicalRequested) return entry;
  }
  return null;
}

function canonicalPythonPackageName(name) {
  return String(name).replace(/[_.]+/g, '-').toLowerCase();
}

// ── Repackage step (sysroot-prep wave) ──────────────────────────────
//
// Downloads an upstream `.tar.gz`, extracts it, and re-tars a subset of
// the contents in a flat (rootless) layout. The produced tarball is
// dropped into <workDir>/sysroot.tar (matching the SPECS file entry's
// `src` value), where the existing fetch loop picks it up via its
// `!existsSync` short-circuit.
//
// Verifies sha256 of BOTH the upstream download AND the produced
// tarball against expectations in the spec. Aborts on mismatch — no
// retries, no defensive recovery (anti-req: no retry/defensive logic).
//
// The extracted directory is `<workDir>/<strip_prefix>/` per the
// upstream tarball's natural top-level entry. `include_dirs` selects
// which children become top-level entries in the produced tarball.
function runRepackage(rep, workDir) {
  const upstreamLocal = join(workDir, basename(rep.upstream_url));
  if (!existsSync(upstreamLocal)) {
    console.log(`[bundle-runtime] fetch (repackage) ${rep.upstream_url}`);
    // `-fsSL` would suppress the SSL-expired-CA error on some sandboxes;
    // bundle-runtime.mjs is host-side so we use plain `-sSL`. If the host
    // has a broken CA bundle the user must fix their CA store; no `-k`
    // fallback (anti-req: no defensive workaround).
    execSync(`curl -sSL -o "${upstreamLocal}" "${rep.upstream_url}"`, { stdio: 'inherit' });
  }
  const upstreamBytes = readFileSync(upstreamLocal);
  const upstreamSha = createHash('sha256').update(upstreamBytes).digest('hex');
  console.log(`[bundle-runtime] upstream sha256 = ${upstreamSha}`);
  if (rep.upstream_sha256 && upstreamSha !== rep.upstream_sha256) {
    console.error(`[bundle-runtime] FATAL upstream sha256 mismatch`);
    console.error(`  expected ${rep.upstream_sha256}`);
    console.error(`  actual   ${upstreamSha}`);
    process.exit(3);
  }

  // Extract into a dedicated subdir so re-runs don't accumulate stale
  // files. `tar` happens to be idempotent here but rm -rf first is
  // cheaper than reasoning about tar's overwrite semantics.
  const extractRoot = join(workDir, 'extract');
  execSync(`rm -rf "${extractRoot}" && mkdir -p "${extractRoot}"`, { stdio: 'inherit' });
  execSync(`tar xzf "${upstreamLocal}" -C "${extractRoot}"`, { stdio: 'inherit' });

  const extractedDir = join(extractRoot, rep.strip_prefix);
  if (!existsSync(extractedDir)) {
    console.error(`[bundle-runtime] FATAL: expected ${rep.strip_prefix}/ at tarball root, not found`);
    process.exit(3);
  }

  // Re-tar in rootless layout: tar cf out.tar -C extractedDir <include_dirs...>
  // produces a tarball whose entries are `include/...`, `lib/...`, `share/...`
  // — no `wasi-sysroot/` prefix. Matches binji-2020 sysroot.tar shape.
  const outLocal = join(workDir, 'sysroot.tar');
  const dirArgs = rep.include_dirs.map((d) => `"${d}"`).join(' ');
  execSync(`tar cf "${outLocal}" -C "${extractedDir}" ${dirArgs}`, { stdio: 'inherit' });

  const outBytes = readFileSync(outLocal);
  const outSha = createHash('sha256').update(outBytes).digest('hex');
  console.log(`[bundle-runtime] repackage → ${outLocal}`);
  console.log(`[bundle-runtime]   size=${outBytes.length} bytes (${(outBytes.length / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`[bundle-runtime]   sha256=${outSha}`);

  if (rep.output_sha256 && outSha !== rep.output_sha256) {
    console.error(`[bundle-runtime] FATAL produced sysroot.tar sha256 mismatch`);
    console.error(`  expected ${rep.output_sha256}`);
    console.error(`  actual   ${outSha}`);
    console.error(`(deterministic tar order is sensitive to GNU tar version + locale;`);
    console.error(` if the file is byte-identical except for ordering, update the`);
    console.error(` spec entry's output_sha256 to the new value.)`);
    process.exit(3);
  }
  if (rep.output_size && outBytes.length !== rep.output_size) {
    console.error(`[bundle-runtime] FATAL produced sysroot.tar size mismatch`);
    console.error(`  expected ${rep.output_size}`);
    console.error(`  actual   ${outBytes.length}`);
    process.exit(3);
  }
}

// ── Bundled LICENSE text generator ────────────────────────────────
function GPL_3_LICENSE_NOTICE() {
  return `GNU bash 5.2.37 — GPL-3.0-or-later
Copyright (C) Free Software Foundation, Inc.

This runtime bundles GNU bash cross-compiled to wasm32-wasi. Full
license text: https://www.gnu.org/licenses/gpl-3.0.txt
Corresponding source: https://ftp.gnu.org/gnu/bash/bash-5.2.37.tar.gz
plus the Nimbus build overlay (packages/worker/wasm/bash/ in the
Nimbus repository: nimbus-proc.{h,c}, build-bash.sh, coreutils/).

BusyBox 1.37.0 — GPL-2.0-only
Copyright (C) many authors, 1998-2015. See the source distribution.

The coreutils exec targets (ls, cat, grep, sed, awk, find, ...) are
BusyBox cross-compiled to wasm32-wasi as one multicall binary. Full
license text: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
Corresponding source: https://busybox.net/downloads/busybox-1.37.0.tar.bz2
plus the Nimbus build overlay (packages/worker/wasm/bash/coreutils/ in
the Nimbus repository: build-busybox.sh, wasi-shim.c, overlay/).
`;
}

function PSF_LICENSE_NOTICE() {
  return [
    'Python is distributed under the Python Software Foundation License',
    'Version 2. The full text is at https://docs.python.org/3/license.html',
    'and is included in the interpreter as Lib/LICENSE.txt.',
    '',
    'Copyright (c) 2001-2026 Python Software Foundation. All Rights Reserved.',
    '',
    'This build is CPython 3.13.14 cross-compiled for wasm32-wasi and',
    'statically linked against zlib (zlib licence), bzip2 (BSD-like), xz',
    'liblzma (0BSD), SQLite (public domain) and OpenSSL 3.5 (Apache-2.0).',
    'Each of those carries its own licence, reproduced by its upstream.',
    '',
  ].join('\n');
}

function MPL_2_LICENSE_TEXT() {
  // Mozilla Public License 2.0 — Pyodide is MPL-2.0-licensed. We
  // ship an abbreviated header pointing at the canonical text; the
  // LICENSE file lives next to the runtime install dir as a
  // disclosure to the user.
  return [
    '==============================================================================',
    'Pyodide is licensed under the Mozilla Public License Version 2.0:',
    '==============================================================================',
    '',
    'Copyright (c) 2018-present Pyodide contributors.',
    '',
    'Full license: https://www.mozilla.org/en-US/MPL/2.0/',
    '',
    'Pyodide source: https://github.com/pyodide/pyodide',
    'Release tarball: https://cdn.jsdelivr.net/pyodide/v0.29.4/full/',
    '',
    'Bundled in Nimbus for the `nimbus install python` runtime. Python',
    'itself is under the PSF License Agreement (https://docs.python.org/3/',
    'license.html); pyodide.asm.wasm contains CPython 3.13 + selected',
    'standard-library modules statically linked to wasm32-unknown-emscripten.',
    '',
  ].join('\n');
}

function APACHE_2_LLVM_LICENSE_TEXT() {
  // Apache 2.0 with LLVM exception — abbreviated header pointing at
  // the canonical upstream LICENSE.TXT. We don't redistribute the
  // entire license verbatim here; the LICENSE file in the runtime
  // install dir tells the user where to find the full text.
  return [
    '==============================================================================',
    'The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:',
    '==============================================================================',
    '',
    'Copyright (c) The LLVM Project authors.',
    'Copyright (c) Ben Smith (binji) and contributors to wasm-clang.',
    '',
    'Full license: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT',
    '',
    'binji/wasm-clang source: https://github.com/binji/wasm-clang',
    'Original CppCon 2019 talk: https://www.youtube.com/watch?v=5N4b-rU-OAA',
    '',
    'This artifact is a frozen build of LLVM 8.0 from 2018-2020. It is bundled',
    'in Nimbus under the original LLVM Apache 2.0 + LLVM Exception license.',
    'See the canonical LICENSE.TXT for the full text including the WebAssembly',
    'runtime exception clauses.',
    '',
  ].join('\n');
}

function RUBY_LICENSE_TEXT() {
  // Ruby is dual-licensed under the Ruby License + BSD-2-Clause.
  // ruby.wasm packaging adds MIT for the JS bindings (which we
  // re-implement, so we don't redistribute their JS — only the wasm).
  // The wasm itself carries: Ruby License + BSD-2-Clause for the
  // interpreter, plus various permissive licenses for bundled gems
  // and the C extensions in stdlib.
  return [
    '==============================================================================',
    'Ruby is dual-licensed under the Ruby License (2-clause variant) and BSD-2-Clause:',
    '==============================================================================',
    '',
    'Copyright (c) Yukihiro Matsumoto. All rights reserved.',
    '',
    'Ruby License full text: https://www.ruby-lang.org/en/about/license.txt',
    'BSD-2-Clause full text: https://opensource.org/license/bsd-2-clause/',
    '',
    'Ruby source: https://github.com/ruby/ruby',
    'ruby.wasm source: https://github.com/ruby/ruby.wasm',
    'Release tarball: https://registry.npmjs.org/@ruby/3.3-wasm-wasi/-/3.3-wasm-wasi-2.9.3-2.9.4.tgz',
    '',
    'Bundled in Nimbus for the `nimbus install ruby` runtime. ruby+stdlib.wasm',
    'contains Ruby 3.3.x + the standard library packed via wasi-vfs, compiled',
    'to wasm32-unknown-wasi. The full Ruby standard library license list is in',
    'the upstream LEGAL file: https://github.com/ruby/ruby/blob/master/LEGAL.',
    '',
  ].join('\n');
}
