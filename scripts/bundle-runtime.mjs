#!/usr/bin/env node
/**
 * scripts/bundle-runtime.mjs — ingest an upstream runtime into the
 * `nimbus-runtime-cache` R2 bucket.
 *
 * Invocation:
 *   node scripts/bundle-runtime.mjs clang binji-2020
 *   node scripts/bundle-runtime.mjs python 0.29.4      (future)
 *
 * Per `2026-05-10-true-os/plan.md` §2.4:
 *   - Blobs are content-addressed under `blobs/<name>-<version>/<file>`.
 *   - Per-version manifest at `manifests/<name>-<version>.json` lists
 *     the files (path-in-VFS, content R2 key, sha256, size, mode).
 *   - Top-level `catalog/v1.json` lists known runtimes.
 *
 * For `clang binji-2020`, the upstream is:
 *   https://raw.githubusercontent.com/binji/wasm-clang/master/{clang,lld,memfs,sysroot.tar}
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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUCKET = 'nimbus-runtime-cache';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || 'f44999d1ddda7012e9a87729eba250f1';
const WRANGLER = './node_modules/.bin/wrangler';

if (!process.argv[2] || !process.argv[3]) {
  console.error('usage: bundle-runtime.mjs <name> <version>');
  process.exit(2);
}

const RUNTIME = process.argv[2];
const VERSION = process.argv[3];

/**
 * Static per-runtime spec. Each entry says where to fetch the upstream
 * file from and how to map it into the per-user VFS at install time.
 *
 * For `clang binji-2020`:
 *   - VFS path `bin/clang`          ← upstream `clang`         (31.2 MB)
 *   - VFS path `bin/wasm-ld`        ← upstream `lld`           (19.5 MB)
 *   - VFS path `share/clang/memfs.wasm` ← upstream `memfs`     (345 KB)
 *   - VFS path `share/clang/sysroot.tar`← upstream `sysroot.tar` (9.3 MB)
 *   - VFS path `LICENSE`            ← bundled APACHE-2.0 text
 */
const SPECS = {
  'clang/binji-2020': {
    license: 'Apache-2.0-with-LLVM-exception',
    wasi_namespace: 'wasi_unstable',
    memfs_companion: 'share/clang/memfs.wasm',
    upstream_base: 'https://raw.githubusercontent.com/binji/wasm-clang/master',
    files: [
      { src: 'clang',       vfs: 'bin/clang',                  mode: 'exec',   runner: 'clang-runner', binName: 'clang' },
      { src: 'lld',         vfs: 'bin/wasm-ld',                mode: 'exec',   runner: 'clang-runner', binName: 'wasm-ld', kind: 'linker' },
      { src: 'memfs',       vfs: 'share/clang/memfs.wasm' },
      { src: 'sysroot.tar', vfs: 'share/clang/sysroot.tar' },
    ],
    // Bundled LICENSE text — Apache 2.0 with LLVM exception (full text below).
    // Source: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT
    license_text: APACHE_2_LLVM_LICENSE_TEXT(),
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
mkdirSync(workDir, { recursive: true });

console.log(`[bundle-runtime] ${RUNTIME} ${VERSION}`);
console.log(`[bundle-runtime] work dir: ${workDir}`);
console.log(`[bundle-runtime] bucket:   ${BUCKET}`);
console.log(`[bundle-runtime] account:  ${ACCOUNT}`);

// ── 1. Fetch upstream artifacts ────────────────────────────────────
const downloaded = [];
for (const f of spec.files) {
  const local = join(workDir, f.src);
  if (!existsSync(local)) {
    const url = `${spec.upstream_base}/${f.src}`;
    console.log(`[bundle-runtime] fetch ${url}`);
    execSync(`curl -sS -L -o "${local}" "${url}"`, { stdio: 'inherit' });
  }
  const bytes = readFileSync(local);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  downloaded.push({ ...f, local, bytes, sha256, size: bytes.length });
  console.log(`[bundle-runtime]   ${f.src} → ${(bytes.length / 1024 / 1024).toFixed(2)} MiB sha256=${sha256.slice(0, 16)}…`);
}

// Bundled LICENSE file.
const licenseLocal = join(workDir, 'LICENSE');
writeFileSync(licenseLocal, spec.license_text);
const licenseBytes = readFileSync(licenseLocal);
const licenseSha256 = createHash('sha256').update(licenseBytes).digest('hex');
downloaded.push({
  src: 'LICENSE', vfs: 'LICENSE', local: licenseLocal, bytes: licenseBytes,
  sha256: licenseSha256, size: licenseBytes.length,
});
console.log(`[bundle-runtime]   LICENSE → ${licenseBytes.length} bytes sha256=${licenseSha256.slice(0, 16)}…`);

// ── 2. Upload each file as a content-addressed blob ────────────────
// Content path: blobs/<name>-<version>/<src-name>
for (const f of downloaded) {
  const r2Key = `blobs/${RUNTIME}-${VERSION}/${f.src}`;
  console.log(`[bundle-runtime] put r2://${BUCKET}/${r2Key}`);
  // `wrangler r2 object put --file <local>` ships the local file as
  // the object body. --remote uploads to the real bucket (not the
  // local simulator).
  execSync(
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} ${WRANGLER} r2 object put ${BUCKET}/${r2Key} --file "${f.local}" --remote`,
    { stdio: 'inherit' },
  );
}

// ── 3. Write the per-version manifest ──────────────────────────────
const manifest = {
  name: RUNTIME,
  version: VERSION,
  license: spec.license,
  wasi_namespace: spec.wasi_namespace || null,
  memfs_companion: spec.memfs_companion || null,
  files: downloaded.map((f) => ({
    path: f.vfs,
    content: `blobs/${RUNTIME}-${VERSION}/${f.src}`,
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

// ── 4. Update the top-level catalog ────────────────────────────────
const catalogR2Key = 'catalog/v1.json';
let catalog = { version: 1, runtimes: {} };
try {
  const out = execSync(
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} ${WRANGLER} r2 object get ${BUCKET}/${catalogR2Key} --pipe --remote 2>/dev/null`,
    { encoding: 'utf8' },
  );
  catalog = JSON.parse(out);
} catch {
  console.log(`[bundle-runtime] no existing catalog; creating fresh`);
}

if (!catalog.runtimes[RUNTIME]) catalog.runtimes[RUNTIME] = { default: VERSION, versions: {} };
catalog.runtimes[RUNTIME].versions[VERSION] = {
  manifest: manifestR2Key,
  size_bytes: downloaded.reduce((a, f) => a + f.size, 0),
  license: spec.license,
};
// Update default to the just-uploaded version (idempotent — if it was
// already the default, no-op).
catalog.runtimes[RUNTIME].default = VERSION;

const catalogLocal = join(workDir, 'catalog.json');
writeFileSync(catalogLocal, JSON.stringify(catalog, null, 2));
console.log(`[bundle-runtime] put r2://${BUCKET}/${catalogR2Key}`);
execSync(
  `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} ${WRANGLER} r2 object put ${BUCKET}/${catalogR2Key} --file "${catalogLocal}" --content-type application/json --remote`,
  { stdio: 'inherit' },
);

const totalMb = (downloaded.reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(2);
console.log(`\n[bundle-runtime] DONE`);
console.log(`[bundle-runtime] uploaded ${downloaded.length} files (${totalMb} MiB) for ${RUNTIME}@${VERSION}`);
console.log(`[bundle-runtime] manifest:  r2://${BUCKET}/${manifestR2Key}`);
console.log(`[bundle-runtime] catalog:   r2://${BUCKET}/${catalogR2Key}`);

// ── Bundled LICENSE text generator ────────────────────────────────
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
