#!/usr/bin/env node
/**
 * bundle-opencode.mjs — stage the opencode CLI JS artifact for Nimbus.
 *
 * Why this exists
 * ───────────────
 * `npm install opencode-ai` is a native-shard package: its bin is
 * `bin/opencode.exe` (a native launcher) and a postinstall selects one of
 * 12 platform-native shards (~149 MiB). None of that runs in workerd.
 *
 * Upstream opencode is a Bun program. The Nimbus-runnable artifact is a
 * single-file ESM bundle produced from the opencode source with five
 * resolve hooks (bun→node:url, bun:ffi/bun:sqlite→throwing stubs,
 * @lydell/node-pty + bun-pty→throwing stub, @opentui/core native→stub,
 * jsonc-parser→its ESM build) targeting Node/workerd conditions. The build
 * recipe lives at the opencode clone's packages/opencode/build-node.ts; see
 * docs/architecture/nimbus-os-runtime-spec.md.
 *
 * This script does NOT rebuild opencode (that needs the upstream git clone
 * + Bun + a SolidJS transform plugin). It stages a pre-built dist directory
 * — the deterministic output of the documented recipe — into the static
 * assets layer, the same way runtime blobs are synced rather than rebuilt
 * on every install:
 *
 *   public/_assets/opencode/<version>/index.js      ← the CLI bundle
 *   public/_assets/opencode/<version>/<sidecar>     ← tree-sitter .wasm,
 *                                                     highlight .scm, etc.
 *
 * The install policy (PACKAGE_ABI_POLICY.stagedArtifacts) maps
 * `opencode-ai` to this staged bundle: the resolver drops the native
 * shards/postinstall and rewrites the package `bin` to the staged index.js,
 * which the node runtime executes with the Bun-global polyfill injected.
 *
 * Source dir:
 *   NIMBUS_OPENCODE_DIST env var, else /tmp/opencode-research/dist-nimbus
 *   (the research build output). Skips with a clear notice if absent so a
 *   fresh checkout without the clone still builds the worker.
 *
 * Output:
 *   src/opencode-artifact.generated.ts
 *     export const OPENCODE_ARTIFACT_VERSION: string;
 *     export const OPENCODE_ARTIFACT_ENTRY: string;   // asset path of index.js
 *     export const OPENCODE_ARTIFACT_FILES: readonly string[]; // sidecar names
 *
 *   public/_assets/opencode/<version>/*
 *
 * Run via: node scripts/bundle-opencode.mjs (wired into bundle/predeploy).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_TS = path.join(ROOT, 'src', 'opencode-artifact.generated.ts');

const DIST_DIR =
  process.env.NIMBUS_OPENCODE_DIST || '/tmp/opencode-research/dist-nimbus';

async function readPinnedVersion() {
  const src = await fs.readFile(path.join(ROOT, 'src', 'constants.ts'), 'utf8');
  const m = src.match(/OPENCODE_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('[bundle-opencode] OPENCODE_VERSION not found in constants.ts');
  return m[1];
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// The facet runner pre-registers these wasm sidecars as pre-compiled
// WebAssembly.Modules (request-time WebAssembly.compile is blocked in
// facets). Core + bash + powershell cover opencode's bash tool — its parser
// lazy-init loads the bash AND powershell grammars unconditionally. The
// other staged grammars (javascript/markdown/typescript/zig — TUI syntax
// highlighting) stay in _assets, available but not attached.
function resolveTreeSitterWasms(sidecars) {
  const find = (label, re) => {
    const matches = sidecars.filter((f) => re.test(f));
    if (matches.length !== 1) {
      throw new Error(
        `[bundle-opencode] expected exactly one ${label} sidecar, got: ` +
          `${matches.join(', ') || 'none'}`,
      );
    }
    return matches[0];
  };
  return {
    core: find('tree-sitter core wasm', /^tree-sitter-[a-z0-9]+\.wasm$/),
    bash: find('tree-sitter-bash grammar wasm', /^tree-sitter-bash-[a-z0-9]+\.wasm$/),
    powershell: find(
      'tree-sitter-powershell grammar wasm',
      /^tree-sitter-powershell-[a-z0-9]+\.wasm$/,
    ),
  };
}

// The opencode TUI is a client/server split: the bare `opencode` TUI client
// spawns its API server as `new Worker("./worker.js")` and OpenTUI its
// syntax-highlight parser as `new Worker("./parser.worker.js")`. Both are
// staged as their own self-contained ESM bundles (build-node.ts) and ride into
// the facet module map (FacetManager.opencodeWorkerModuleEntries) so the
// in-isolate Worker polyfill (opencode-facet-runner.ts) can import them.
function resolveTuiWorkers(sidecars) {
  const has = (f) => sidecars.includes(f);
  if (!has('worker.js') && !has('parser.worker.js')) return null;
  if (!has('worker.js')) {
    throw new Error('[bundle-opencode] worker.js missing from dist — the TUI server worker was not built (build-node.ts entrypoints)');
  }
  if (!has('parser.worker.js')) {
    throw new Error('[bundle-opencode] parser.worker.js missing from dist — the OpenTUI parser worker was not built (build-node.ts entrypoints)');
  }
  return { server: 'worker.js', parser: 'parser.worker.js' };
}

async function emitGenerated(version, entryPath, sidecars, buildId, treeSitterWasms, tuiWorkers) {
  const header = `/**
 * opencode-artifact.generated.ts — AUTO-GENERATED by scripts/bundle-opencode.mjs
 * DO NOT EDIT.
 *
 * Staged opencode-ai ${version} JS bundle. The CLI bundle and its sidecar
 * assets (tree-sitter .wasm, highlight .scm) live in the static-assets layer
 * under public/_assets/opencode/${version}/ and are fetched on demand by
 * runtime/opencode-artifact.ts. PACKAGE_ABI_POLICY.stagedArtifacts maps
 * \`opencode-ai\` to this bundle.
 *
 * OPENCODE_ARTIFACT_PRESENT is false when the build host had no staged dist
 * directory (the upstream clone build output). The worker still builds; the
 * install policy surfaces a precise "artifact not staged" diagnostic instead
 * of selecting a missing bundle.
 *
 * OPENCODE_ARTIFACT_BUILD_ID is a content hash over the staged files. The
 * supervisor's L2 (caches.default) layer keys on it so a same-version rebuild
 * with different content never serves stale bytes from a warm colo cache.
 */

export const OPENCODE_ARTIFACT_VERSION: string = ${JSON.stringify(version)};
export const OPENCODE_ARTIFACT_BUILD_ID: string = ${JSON.stringify(buildId)};
export const OPENCODE_ARTIFACT_PRESENT: boolean = ${JSON.stringify(entryPath !== null)};
export const OPENCODE_ARTIFACT_ENTRY: string = ${JSON.stringify(entryPath ?? '')};
export const OPENCODE_ARTIFACT_FILES: readonly string[] = ${JSON.stringify(sidecars)};

/**
 * Staged wasm sidecar filenames the facet runner pre-registers as
 * pre-compiled WebAssembly.Modules on \`globalThis.__nimbusTreeSitterModules\`
 * (request-time WebAssembly.compile is blocked in facets). Core + bash +
 * powershell cover opencode's bash tool. Null when the artifact is unstaged.
 */
export interface OpencodeTreeSitterWasms {
  readonly core: string;
  readonly bash: string;
  readonly powershell: string;
}
export const OPENCODE_TREE_SITTER_WASMS: OpencodeTreeSitterWasms | null = ${
    treeSitterWasms ? JSON.stringify(treeSitterWasms) : 'null'
  };

/**
 * Staged TUI worker bundle filenames. The opencode TUI client spawns its API
 * server (\`server\`) and OpenTUI its syntax-highlight parser (\`parser\`) via
 * \`new Worker(...)\`; the in-isolate Worker polyfill imports these from the
 * facet module map (FacetManager.opencodeWorkerModuleEntries). Null when the
 * artifact is unstaged or the workers were not built.
 */
export interface OpencodeTuiWorkers {
  readonly server: string;
  readonly parser: string;
}
export const OPENCODE_TUI_WORKERS: OpencodeTuiWorkers | null = ${
    tuiWorkers ? JSON.stringify(tuiWorkers) : 'null'
  };
`;
  await fs.writeFile(OUT_TS, header, 'utf8');
}

async function main() {
  const version = await readPinnedVersion();
  const assetRel = path.join('_assets', 'opencode', version);
  const assetDir = path.join(ROOT, 'public', assetRel);

  if (!(await exists(DIST_DIR))) {
    console.warn(
      `[bundle-opencode] dist dir not found: ${DIST_DIR}\n` +
        `   skipping staging — set NIMBUS_OPENCODE_DIST to the opencode build output.\n` +
        `   The worker still builds; opencode install will report "artifact not staged".`,
    );
    await emitGenerated(version, null, [], '', null, null);
    return;
  }

  const indexSrc = path.join(DIST_DIR, 'index.js');
  if (!(await exists(indexSrc))) {
    throw new Error(`[bundle-opencode] ${DIST_DIR} has no index.js — not an opencode dist dir`);
  }

  // Clean stale-versioned dirs.
  const parentDir = path.join(ROOT, 'public', '_assets', 'opencode');
  await fs.mkdir(parentDir, { recursive: true });
  for (const entry of await fs.readdir(parentDir)) {
    if (entry !== version) {
      await fs.rm(path.join(parentDir, entry), { recursive: true, force: true });
      console.log(`[bundle-opencode] removed stale staged version: ${entry}`);
    }
  }

  await fs.rm(assetDir, { recursive: true, force: true });
  await fs.mkdir(assetDir, { recursive: true });

  // Stage every file in the dist dir (index.js + tree-sitter .wasm + .scm +
  // the few embedded assets the bundle references by name).
  const entries = await fs.readdir(DIST_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  const sidecars = [];
  let totalBytes = 0;
  const hash = createHash('sha256');
  for (const e of files) {
    const bytes = await fs.readFile(path.join(DIST_DIR, e.name));
    await fs.writeFile(path.join(assetDir, e.name), bytes);
    totalBytes += bytes.length;
    hash.update(e.name);
    hash.update(bytes);
    if (e.name !== 'index.js') sidecars.push(e.name);
    console.log(
      `[bundle-opencode] staged ${e.name} (${(bytes.length / 1024).toFixed(1)} KiB)`,
    );
  }
  sidecars.sort();
  const buildId = hash.digest('hex').slice(0, 16);

  const entryPath = `/${assetRel.split(path.sep).join('/')}/index.js`;
  await emitGenerated(
    version,
    entryPath,
    sidecars,
    buildId,
    resolveTreeSitterWasms(sidecars),
    resolveTuiWorkers(sidecars),
  );

  console.log(
    `[bundle-opencode] staged opencode ${version}: ${entries.length} files, ` +
      `${(totalBytes / 1024 / 1024).toFixed(1)} MiB → public/${assetRel}`,
  );
}

main().catch((e) => {
  console.error('[bundle-opencode] failed:', e);
  process.exit(1);
});
