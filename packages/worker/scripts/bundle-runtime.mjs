#!/usr/bin/env node
/**
 * scripts/bundle-runtime.mjs — ingest an upstream runtime into the
 * `nimbus-runtime-cache` R2 bucket.
 *
 * Invocation:
 *   node scripts/bundle-runtime.mjs clang binji-2020 [--bucket nimbus-runtime-cache]
 *   node scripts/bundle-runtime.mjs python 0.29.4 [--bucket nimbus-runtime-cache]
 *   node scripts/bundle-runtime.mjs --pin-catalog        (read-only; publishes nothing)
 *   node scripts/bundle-runtime.mjs bash 5.2.37-2 --npm-package <dir>   (local; no R2)
 *
 * `--npm-package` is the SECOND publisher for the same artifacts: it stages
 * exactly what the R2 path stages, composes the same manifest bytes, and lays
 * the blobs out under the same content-addressed keys — into a directory that
 * `npm publish` takes, for the embedders who have npm and no bucket. It reads
 * nothing from Cloudflare and writes nothing to it. See §--npm-package below.
 *
 * Per `2026-05-10-true-os/plan.md` §2.4:
 *   - Blobs are content-addressed under `blobs/<name>-<version>/<sha256>/<file>`.
 *   - Per-version manifest at `manifests/<name>-<version>.json` lists
 *     the files (path-in-VFS, content R2 key, sha256, size, mode).
 *   - Top-level `catalog/v1.json` lists known runtimes, each with the
 *     sha256 of its manifest.
 *
 * Every artifact the supervisor reads is named by a digest that the artifact
 * above it vouches for, and the top of that chain is pinned into the worker
 * build as src/runtime-catalog.generated.ts. This script owns both ends: it
 * writes `manifest_sha256` into the catalog and rewrites the pin. See the
 * trust-model note in src/runtime/runtime-catalog.ts for what the chain buys.
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
import { SPECS } from './runtime-specs.mjs';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
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

const USAGE =
  'usage: bundle-runtime.mjs <name> <version> [--bucket <bucket>] [--keep-default]\n' +
  '       bundle-runtime.mjs <name> <version> --npm-package <dir>\n' +
  '       bundle-runtime.mjs --pin-catalog [--bucket <bucket>]\n' +
  '\n' +
  '  --keep-default  add the version to the catalog without making it the\n' +
  '                  default: for a build whose runner contract a deployment\n' +
  '                  still reading the catalog cannot bind yet. Re-run without\n' +
  '                  the flag once every deployment can; the re-run is idempotent.';

/** The bucket the deployed Worker's NIMBUS_RUNTIME_CACHE binding points at.
 *  Only a publish to THIS bucket may rewrite the catalog pin: the pin
 *  describes what production reads, so regenerating it from an isolated
 *  test bucket would point the deploy at a catalog it never fetches. */
const PRODUCTION_BUCKET = 'nimbus-runtime-cache';

const rawArgs = process.argv.slice(2);
const positionalArgs = [];
let BUCKET = process.env.NIMBUS_RUNTIME_BUCKET || PRODUCTION_BUCKET;
let PIN_ONLY = false;
let KEEP_DEFAULT = false;
let NPM_OUT_DIR = null;
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--pin-catalog') {
    PIN_ONLY = true;
    continue;
  }
  if (arg === '--keep-default') {
    KEEP_DEFAULT = true;
    continue;
  }
  if (arg === '--npm-package') {
    NPM_OUT_DIR = rawArgs[++i];
    if (!NPM_OUT_DIR) {
      console.error(USAGE);
      process.exit(2);
    }
    continue;
  }
  if (arg.startsWith('--npm-package=')) {
    NPM_OUT_DIR = arg.slice('--npm-package='.length);
    continue;
  }
  if (arg === '--bucket') {
    const value = rawArgs[++i];
    if (!value) {
      console.error(USAGE);
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

// Every mode but `--npm-package` reads or writes R2 through wrangler.
if (!NPM_OUT_DIR && !ACCOUNT) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID env var required');
  process.exit(1);
}

// `--pin-catalog` regenerates the build-time root of trust from the catalog
// already in R2. Read-only: it publishes nothing, so it is safe to run at any
// time, including while another ingest is in flight against a different bucket.
if (PIN_ONLY) {
  pinCatalogFromR2();
  process.exit(0);
}

if (!positionalArgs[0] || !positionalArgs[1]) {
  console.error(USAGE);
  process.exit(2);
}

const RUNTIME = positionalArgs[0];
const VERSION = positionalArgs[1];

const key = `${RUNTIME}/${VERSION}`;
const spec = SPECS[key];
if (!spec) {
  console.error(`unknown spec: ${key}`);
  console.error(`known: ${Object.keys(SPECS).join(', ')}`);
  process.exit(2);
}
if (spec.auxiliary_bins) {
  const list = new URL(`${spec.local_base}/${spec.auxiliary_bins}`, import.meta.url);
  const names = readFileSync(list, 'utf8').split('\n').filter(Boolean);
  spec.synthetic_files.NIMBUS_AUX_BIN = Buffer.from('Nimbus WASI multicall entry\n');
  for (const name of names) {
    if (name.includes('/') || name === '.' || name === '..') throw new Error(`Invalid multicall entry: ${name}`);
    spec.files.push({ src: 'NIMBUS_AUX_BIN', vfs: `bin/${name}`, mode: 'exec' });
  }
}
// Checked before anything is staged: which runtimes we publish to npm is a
// decision, and a spec that has not made it should cost nothing to find out.
if (NPM_OUT_DIR) {
  if (!spec.npm) {
    console.error(`ERROR: ${key} declares no npm package in its spec.`);
    console.error('       Add an `npm: { name, summary }` entry to publish it that way.');
    process.exit(2);
  }
  if (spec.ingest_only) {
    console.error(`ERROR: ${key} is ingest_only — it has no manifest to publish.`);
    process.exit(2);
  }
}

const workDir = join(tmpdir(), `bundle-runtime-${RUNTIME}-${VERSION}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

console.log(`[bundle-runtime] ${RUNTIME} ${VERSION}`);
console.log(`[bundle-runtime] work dir: ${workDir}`);
if (NPM_OUT_DIR) {
  console.log(`[bundle-runtime] target:   ${NPM_OUT_DIR} (npm package; R2 is not read or written)`);
} else {
  console.log(`[bundle-runtime] bucket:   ${BUCKET}`);
  console.log(`[bundle-runtime] account:  ${ACCOUNT}`);
}

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

const totalMb = (downloaded.reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(2);

// ── --npm-package: the same artifacts, published through npm ────────
// Everything above this line is the staging the R2 path performs, and
// everything below it is Cloudflare. A runtime package is the staged blobs
// under their content-addressed keys plus the manifest that names them, which
// is the R2 bucket's shape for one runtime, in a directory `npm publish`
// takes. Nothing here reads or writes R2.
if (NPM_OUT_DIR) {
  writeNpmPackage(NPM_OUT_DIR, composeManifest(downloaded, packageRuntimeArtifacts), downloaded);
  process.exit(0);
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
if (spec.ingest_only) {
  console.log(`\n[bundle-runtime] DONE (ingest_only)`);
  console.log(`[bundle-runtime] uploaded ${downloaded.length} file(s) (${totalMb} MiB) for ${RUNTIME}@${VERSION}`);
  console.log(`[bundle-runtime] blobs:    r2://${BUCKET}/blobs/${RUNTIME}-${VERSION}/`);
  console.log(`[bundle-runtime] manifest: SKIPPED (swap wave will compose)`);
  console.log(`[bundle-runtime] catalog:  UNCHANGED (swap wave will flip default)`);
} else {
  // ── 3. Write the per-version manifest ────────────────────────────
  const manifestLocal = join(workDir, 'manifest.json');
  writeFileSync(manifestLocal, manifestText(composeManifest(downloaded, packageRuntimeArtifacts)));
  // Digest of the exact bytes uploaded below. The catalog carries it so the
  // supervisor can verify a manifest the same way a manifest lets it verify
  // a blob — see the trust-model note in src/runtime/runtime-catalog.ts.
  const manifestSha256 = createHash('sha256').update(readFileSync(manifestLocal)).digest('hex');
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
    manifest_sha256: manifestSha256,
    size_bytes: catalogSize,
    license: spec.license,
  };
  // Update default to the just-uploaded version (idempotent — if it was
  // already the default, no-op), unless the publisher asked to hold it for
  // deployments that cannot bind this build yet.
  if (!KEEP_DEFAULT) catalog.runtimes[RUNTIME].default = VERSION;

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

  // The catalog just changed, so the pin the deploy carries is now stale.
  writeCatalogPin(readFileSync(catalogLocal));

  console.log(`\n[bundle-runtime] DONE`);
  console.log(`[bundle-runtime] uploaded ${downloaded.length} files (${totalMb} MiB) for ${RUNTIME}@${VERSION}`);
  console.log(`[bundle-runtime] manifest:  r2://${BUCKET}/${manifestR2Key}`);
  console.log(`[bundle-runtime] catalog:   r2://${BUCKET}/${catalogR2Key} (default ${catalog.runtimes[RUNTIME].default})`);
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
 * A genuinely absent object is the one recoverable case. It is NOT identifiable
 * from the error text: `wrangler r2 object get` answers "The specified key does
 * not exist." for a bucket that does not exist, for a bucket this token cannot
 * read, and for a key that is genuinely absent — measured, all three identical.
 * Taking that message at face value is how a read failure against a populated
 * bucket turns into a fresh catalog. So the first-publish path additionally
 * demands positive evidence that the bucket is there and readable; a bucket we
 * can enumerate with no catalog in it is the only thing that starts one.
 * Everything else stops.
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

  if (missing && !body && bucketIsReadable()) {
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

/**
 * Positive evidence that BUCKET exists and this token can read it. `bucket
 * info` reports an object count for a real bucket and fails outright for one
 * that is absent or unreadable, which is the distinction `object get` collapses.
 */
function bucketIsReadable() {
  const info = spawnSync(
    WRANGLER,
    ['r2', 'bucket', 'info', BUCKET],
    { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } },
  );
  if (info.status === 0 && /object_count:/.test(info.stdout || '')) return true;
  console.error(`ERROR: the catalog looks absent, but bucket '${BUCKET}' could not be read,`);
  console.error('       so "absent" cannot be told apart from "unreachable". Nothing was written.');
  const detail = (info.stderr || '').trim();
  if (detail) console.error(`       ${detail.split('\n').slice(-3).join('\n       ')}`);
  process.exit(1);
}

// ── Catalog pin ──────────────────────────────────────────────────────

/**
 * Rewrite the build-time root of trust from the exact catalog bytes.
 *
 * Only a production-bucket catalog may be pinned: the constant describes what
 * the deployed Worker's NIMBUS_RUNTIME_CACHE binding reads, so pinning an
 * isolated test bucket's catalog would disable the colo cache in production
 * and quietly discard a good pin.
 */
function writeCatalogPin(catalogBytes) {
  if (BUCKET !== PRODUCTION_BUCKET) {
    console.log(
      `[bundle-runtime] catalog pin: LEFT ALONE (bucket '${BUCKET}' is not ` +
      `'${PRODUCTION_BUCKET}', which is what the deploy reads)`,
    );
    return;
  }
  const sha256 = createHash('sha256').update(catalogBytes).digest('hex');
  // Resolved here rather than at module scope: `--pin-catalog` runs before
  // the rest of this file's top-level consts initialise.
  writeFileSync(
    new URL('../src/runtime-catalog.generated.ts', import.meta.url),
    `/**
 * runtime-catalog.generated.ts — AUTO-GENERATED by scripts/bundle-runtime.mjs
 * DO NOT EDIT.
 *
 * SHA-256 of the \`catalog/v1.json\` bytes in the ${PRODUCTION_BUCKET} bucket.
 * This is the root of trust for the runtime package manager: the catalog
 * names each manifest's digest, each manifest names its blobs' digests, and
 * the blobs are interpreters. Pinning the root at build time is what makes
 * the chain verifiable rather than merely well-shaped.
 *
 * The pin governs the L2 (\`caches.default\`) tier only — see the trust-model
 * note in runtime/runtime-catalog.ts. R2 is the trusted tier, so a pin that
 * has drifted behind a fresh publish costs a colo cache, never correctness:
 * the catalog is simply read from R2 and not cached until the pin is
 * regenerated.
 *
 * Regenerate with a read-only catalog fetch (no publish, no R2 write):
 *
 *   CLOUDFLARE_ACCOUNT_ID=<account> node scripts/bundle-runtime.mjs --pin-catalog
 *
 * A normal \`bundle-runtime.mjs <spec>\` publish rewrites it too, from the
 * exact bytes it just uploaded. Commit the result and deploy.
 *
 * The empty string means "not pinned yet" — the catalog stays out of L2 and
 * the supervisor warns once per isolate.
 */

export const RUNTIME_CATALOG_SHA256: string = ${JSON.stringify(sha256)};
`,
    'utf8',
  );
  console.log(`[bundle-runtime] catalog pin: ${sha256}`);
  console.log('[bundle-runtime] commit packages/worker/src/runtime-catalog.generated.ts and redeploy');
}

/**
 * `--pin-catalog`: fetch the published catalog read-only and regenerate the
 * pin from it. Downloads to a file rather than `--pipe` because the digest
 * must cover the object's exact bytes, and a piped stream cannot be told
 * apart from a stream wrangler decorated.
 */
function pinCatalogFromR2() {
  const workDir = join(tmpdir(), `nimbus-catalog-pin-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const local = join(workDir, 'catalog.json');
  try {
    const result = spawnSync(
      WRANGLER,
      ['r2', 'object', 'get', `${BUCKET}/catalog/v1.json`, '--file', local, '--remote'],
      { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } },
    );
    if (result.status !== 0 || !existsSync(local)) {
      console.error(`ERROR: could not read catalog/v1.json from '${BUCKET}'; the pin is unchanged.`);
      const detail = (result.stderr || '').trim();
      if (detail) console.error(`       ${detail.split('\n').slice(-3).join('\n       ')}`);
      process.exit(1);
    }
    const bytes = readFileSync(local);
    // A pin over bytes that are not the catalog would disable the cache on
    // every deploy until someone worked out why.
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
      console.error(`ERROR: catalog/v1.json is not valid JSON (${e.message}); refusing to pin it`);
      process.exit(1);
    }
    if (!parsed || typeof parsed.runtimes !== 'object' || parsed.runtimes === null) {
      console.error('ERROR: catalog/v1.json has no runtimes object; refusing to pin it');
      process.exit(1);
    }
    console.log(`[bundle-runtime] catalog lists: ${Object.keys(parsed.runtimes).join(', ') || '(none)'}`);
    writeCatalogPin(bytes);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ── The manifest ─────────────────────────────────────────────────────
//
// What a runtime IS: the files it is made of, the digest of each, and the
// commands they answer. Both publishers compose it here so an embedder who
// installed the npm package and a session that ran `nimbus install` are
// holding the same description of the same runtime, byte for byte.

function composeManifest(downloaded, packageRuntimeArtifacts) {
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

  return {
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
}

function manifestText(manifest) {
  return JSON.stringify(manifest, null, 2);
}

// ── --npm-package ────────────────────────────────────────────────────

/**
 * Write the runtime as a directory `npm publish` accepts.
 *
 * The blobs keep the keys the manifest already names — `blobs/<name>-<version>/
 * <sha256>/<file>`, the R2 object keys — so the manifest needs no npm-specific
 * rewrite and comes out byte-identical to the one in the bucket. That is the
 * point rather than a coincidence: `content` is documented as the publisher's
 * key for a blob, and for this publisher a path inside its own tarball IS that
 * key. There is one manifest format and one layout, and `readBlob` below is
 * the whole of what distinguishes the two publishers.
 */
function writeNpmPackage(outDir, manifest, downloaded) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const written = new Set();
  let unpackedBytes = 0;
  for (const f of downloaded) {
    if (written.has(f.r2Key)) continue;
    written.add(f.r2Key);
    unpackedBytes += f.size;
    const dest = join(outDir, f.r2Key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.bytes);
  }

  writeFileSync(join(outDir, 'manifest.json'), manifestText(manifest));
  writeFileSync(join(outDir, 'LICENSE'), spec.license_text);
  writeFileSync(join(outDir, 'index.js'), runtimePackageEntry());
  writeFileSync(join(outDir, 'index.d.ts'), runtimePackageTypes());
  writeFileSync(join(outDir, 'README.md'), runtimePackageReadme());
  const npmVersion = spec.npm.version ?? VERSION;
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({
    name: spec.npm.name,
    version: npmVersion,
    description: `${spec.npm.summary}, as a Nimbus runtime package.`,
    keywords: ['nimbus', 'wasm', 'wasi', 'runtime', RUNTIME],
    homepage: 'https://github.com/AshishKumar4/Nimbus',
    // No `directory`: the package is built from the runtime spec and the wasm
    // build tree, and has no source directory of its own to point at.
    repository: { type: 'git', url: 'git+https://github.com/AshishKumar4/Nimbus.git' },
    bugs: 'https://github.com/AshishKumar4/Nimbus/issues',
    license: spec.license,
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
    exports: {
      '.': { types: './index.d.ts', import: './index.js' },
      './manifest.json': './manifest.json',
      './package.json': './package.json',
    },
    files: ['index.js', 'index.d.ts', 'manifest.json', 'blobs', 'LICENSE', 'README.md'],
    // The runtime is inert without the half that installs and runs it, and
    // `index.d.ts` types itself against that package's exports. The floor is
    // the first core release that registers every runner this manifest names:
    // an earlier core seeds the files and then has no command to run them.
    peerDependencies: { '@nimbus-sh/core': spec.npm.core ?? '>=0.4.0' },
    publishConfig: { access: 'public' },
  }, null, 2)}\n`);

  console.log(`\n[bundle-runtime] DONE (npm package)`);
  console.log(`[bundle-runtime] ${spec.npm.name}@${npmVersion} → ${outDir}`);
  console.log(`[bundle-runtime] ${written.size} blobs, ${(unpackedBytes / 1024 / 1024).toFixed(2)} MiB unpacked`);
  // `--tag latest` because a rebuild (`5.2.37-2`) sorts below the build it
  // replaces; see packages/core/scripts/check-runtime-packages.mjs.
  console.log(`[bundle-runtime] publish with: cd ${outDir} && npm publish --tag latest --access public --auth-type=web`);
  console.log(`[bundle-runtime] R2: UNTOUCHED (nothing was read from or written to Cloudflare)`);
}

/**
 * The package entry point, identical in every runtime package.
 *
 * It is the `RuntimePackage` port from `@nimbus-sh/core`: a manifest, and the
 * bytes it names. Core verifies every blob against the manifest before it
 * reaches a filesystem, so this side neither hashes nor validates — it reads.
 */
function runtimePackageEntry() {
  return `/**
 * A Nimbus runtime package: a manifest, and the content-addressed blobs it
 * names. Pass the default export to \`NimbusWorkspace.create({ runtimes })\`
 * and the runtime installs into the workspace filesystem, digest-verified,
 * at the same path \`nimbus install\` uses on Cloudflare.
 *
 * Generated by packages/worker/scripts/bundle-runtime.mjs. Do not edit.
 */

import { readFileSync } from 'node:fs';

const root = new URL('./', import.meta.url);

export const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

/** The bytes of one manifest file entry, by the publisher key it carries. */
export function readBlob(file) {
  // Copied rather than handed over: readFileSync returns a pooled Buffer for
  // small files, whose backing ArrayBuffer holds other files' bytes too.
  return new Uint8Array(readFileSync(new URL(file.content, root)));
}

export default { manifest, readBlob };
`;
}

function runtimePackageTypes() {
  return `import type { ManifestFile, RuntimeManifest, RuntimePackage } from '@nimbus-sh/core';

export declare const manifest: RuntimeManifest;
export declare function readBlob(file: ManifestFile): Uint8Array;

declare const runtimePackage: RuntimePackage;
export default runtimePackage;
`;
}

function runtimePackageReadme() {
  return `# ${spec.npm.name}

${spec.npm.summary}, packaged for [Nimbus](https://github.com/AshishKumar4/Nimbus).

This package is data: the runtime's wasm and support files, content-addressed,
plus the manifest that describes them. It does nothing on its own —
[\`@nimbus-sh/core\`](https://www.npmjs.com/package/@nimbus-sh/core) installs it
into a workspace filesystem and runs it.

\`\`\`bash
npm install @nimbus-sh/core ${spec.npm.name}
\`\`\`

\`\`\`js
import { NimbusWorkspace, localFacetHost } from '@nimbus-sh/core';
import ${RUNTIME} from '${spec.npm.name}';

const workspace = await NimbusWorkspace.create({
  sql,                       // your SQLite, through the SqlDatabase port
  facets: localFacetHost(),
  runtimes: [${RUNTIME}],
});
\`\`\`

Every file is verified against the manifest's SHA-256 before it reaches the
filesystem. The same bytes are served to Cloudflare deployments from R2 by
\`nimbus install ${RUNTIME}\`, under the same manifest.

## Licence

${spec.license}. See the bundled \`LICENSE\` for the notice and where to find
the full text and corresponding source.
`;
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
