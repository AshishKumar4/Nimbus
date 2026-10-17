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
 *   NIMBUS_OPENCODE_DIST, and only that: a new opencode build is staged
 *   only when the caller names its output (build-node.ts writes to
 *   /tmp/opencode-research/dist-nimbus). A named directory that does not
 *   exist is an error. Without the variable, staging is re-derived from the
 *   committed public/_assets/opencode/<version>/ assets — they are the
 *   deterministic build output (content-addressed via
 *   OPENCODE_ARTIFACT_BUILD_ID) — so a leftover build on this host can
 *   never change what a routine rebuild stages. Only when nothing is staged
 *   either does the script skip with a clear notice, so a fresh checkout
 *   still builds the worker.
 *
 * Output:
 *   src/opencode-artifact.generated.ts
 *     export const OPENCODE_ARTIFACT_VERSION: string;
 *     export const OPENCODE_ARTIFACT_ENTRY: string;   // asset path of index.js
 *     export const OPENCODE_ARTIFACT_FILES: readonly string[]; // sidecar names
 *     export const OPENCODE_ARTIFACT_DIGESTS: Readonly<Record<string, string>>;
 *
 *   public/_assets/opencode/<version>/*
 *
 * Run via: node scripts/bundle-opencode.mjs (wired into bundle/predeploy).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildOpencodeAttachEntryFromSources, chunkClosure } from './build-opencode-attach-entry.mjs';
import { readCorePin, sha256Hex } from './stage-asset.mjs';
import { assertCurrentInputs, digestInputs } from './artifact-inputs.mjs';
import { OPENCODE_SOURCE, opencodeInputs } from './opencode/inputs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_TS = path.join(ROOT, 'src', 'opencode-artifact.generated.ts');

const DIST_DIR = process.env.NIMBUS_OPENCODE_DIST || null;

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

// OpenTUI runs its syntax-highlight parser as `new Worker("./parser.worker.js")`.
// It is staged as its own self-contained ESM bundle (build-node.ts) and rides
// into the facet module map so the in-isolate Worker polyfill
// (opencode-facet-runner.ts) can import it.
// OpenTUI lays out every TUI frame with yoga-layout (an Emscripten wasm). The
// runner pre-registers it as a pre-compiled WebAssembly.Module on
// globalThis.__nimbusYogaModule (request-time WebAssembly.instantiate of bytes
// is blocked in facets); build-node.ts extracts it from @opentui/core's inlined
// base64 into yoga.wasm. Null when the artifact is unstaged or yoga absent.
function resolveYogaWasm(sidecars) {
  return sidecars.includes('yoga.wasm') ? 'yoga.wasm' : null;
}

// Split-build chunks: index.js imports chunk-<hash>.js ESM modules from its
// lazy command handlers (build-node.ts splitting). The
// supervisor needs every chunk as a facet module-map entry; staging them as
// ~250 individual assets would cost that many subrequests per spawn, so they
// are aggregated into ONE pack asset (name → source JSON) fetched and expanded
// per spawn (L2-cached like the entry bundle).
const CHUNK_RE = /^chunk-[a-z0-9]+\.js$/;
const CHUNKS_PACK = 'chunks.json';

function resolveChunksPack(sidecars) {
  return sidecars.includes(CHUNKS_PACK) ? CHUNKS_PACK : null;
}

/**
 * Where each chunk's source is in the pack's bytes: the [start, end) of its
 * JSON string literal, so the supervisor decodes the chunks one at a time
 * from the fetched bytes rather than the whole pack as one text first.
 * Found by writing the pack again as JSON.stringify writes it, entry by
 * entry, which must give back its bytes exactly.
 */
function chunkPackRanges(bytes) {
  const pack = JSON.parse(bytes.toString('utf8'));
  const ranges = {};
  const parts = [Buffer.from('{')];
  let at = 1;
  for (const [index, [name, source]] of Object.entries(pack).entries()) {
    const head = Buffer.from(`${index > 0 ? ',' : ''}${JSON.stringify(name)}:`, 'utf8');
    const literal = Buffer.from(JSON.stringify(source), 'utf8');
    parts.push(head, literal);
    at += head.length;
    ranges[name] = [at, at + literal.length];
    at += literal.length;
  }
  parts.push(Buffer.from('}'));
  if (!Buffer.concat(parts).equals(bytes)) {
    throw new Error(`[bundle-opencode] ${CHUNKS_PACK} is not written as JSON.stringify writes it, so its chunk ranges cannot be found`);
  }
  return ranges;
}

// The OpenTUI parser is the only worker bundle Nimbus stages. opencode's own
// API-server worker is not built (build-node.ts entrypoints): a Nimbus TUI
// attaches to an `opencode serve` facet over HTTP, and importing that worker's
// chunk graph into a live facet kills the production workerd process. A dist
// that still carries it is a stale build — fail loud rather than ship a bundle
// the runner's Worker polyfill would refuse at runtime.
function resolveParserWorker(sidecars) {
  if (sidecars.includes('worker.js')) {
    throw new Error(
      '[bundle-opencode] worker.js is present in the dist — opencode\'s API-server ' +
        'worker is no longer built or staged; rebuild with the current build-node.ts',
    );
  }
  return sidecars.includes('parser.worker.js') ? 'parser.worker.js' : null;
}

async function emitGenerated({
  version,
  entryPath,
  sidecars,
  digests,
  buildId,
  treeSitterWasms,
  parserWorker,
  yogaWasm,
  chunksPack,
  chunkRanges,
}) {
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
 * SHA-256 of every staged file, entry bundle included — the sidecar list omits
 * index.js. runtime/opencode-artifact.ts verifies each fetch against this map
 * (the L2 tier included) before the bytes are compiled as a wasm module or
 * evaluated as facet ESM; a file with no entry here is a loud throw.
 */
export const OPENCODE_ARTIFACT_DIGESTS: Readonly<Record<string, string>> = ${JSON.stringify(digests)};

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
 * Staged OpenTUI parser worker bundle. OpenTUI spawns its syntax-highlight
 * parser via \`new Worker(...)\`; the in-isolate Worker polyfill imports it from
 * the facet module map. opencode's own API-server worker is never built — a
 * Nimbus TUI attaches to an \`opencode serve\` facet over HTTP — and the polyfill
 * fails loud if anything spawns it. Null when the artifact is unstaged.
 */
export const OPENCODE_TUI_PARSER_WORKER: string | null = ${
    parserWorker ? JSON.stringify(parserWorker) : 'null'
  };

/**
 * Staged yoga-layout wasm filename. OpenTUI lays out every TUI frame with
 * yoga; the runner pre-registers this as a pre-compiled WebAssembly.Module on
 * \`globalThis.__nimbusYogaModule\` (request-time WebAssembly.instantiate of
 * bytes is blocked in facets). Null when the artifact is unstaged.
 */
export const OPENCODE_YOGA_WASM: string | null = ${
    yogaWasm ? JSON.stringify(yogaWasm) : 'null'
  };

/**
 * Staged chunk-pack filename: one JSON asset mapping every split-build
 * \`chunk-<hash>.js\` module name to its ESM source. index.js imports these
 * chunks from its lazy command handlers; the supervisor expands the pack into
 * facet module-map entries per spawn. Null
 * when the artifact is unstaged.
 */
export const OPENCODE_CHUNKS_PACK: string | null = ${
    chunksPack ? JSON.stringify(chunksPack) : 'null'
  };

/**
 * Where each chunk's source is in the pack: the byte range [start, end) of
 * its JSON string literal, decoded one chunk at a time. Null when the
 * artifact is unstaged.
 */
export const OPENCODE_CHUNK_RANGES: Readonly<Record<string, readonly [number, number]>> | null = ${
    chunkRanges ? JSON.stringify(chunkRanges) : 'null'
  };
`;
  await fs.writeFile(OUT_TS, header, 'utf8');
}

async function main() {
  const version = readCorePin('OPENCODE_VERSION');
  const assetRel = path.join('_assets', 'opencode', version);
  const assetDir = path.join(ROOT, 'public', assetRel);

  // A named build is staged; otherwise the committed assets for the pinned
  // version are re-derived (byte-identical to the dist they were staged
  // from), so a host without the clone does not silently unstage the artifact.
  let distDir = DIST_DIR;
  if (distDir !== null && !(await exists(distDir))) {
    throw new Error(`[bundle-opencode] NIMBUS_OPENCODE_DIST=${distDir} does not exist`);
  }
  if (distDir === null) {
    if (await exists(path.join(assetDir, 'index.js'))) {
      distDir = assetDir;
      console.log(`[bundle-opencode] re-deriving from staged public/${assetRel}`);
    } else {
      console.warn(
        `[bundle-opencode] nothing staged for opencode ${version}\n` +
          `   skipping staging — set NIMBUS_OPENCODE_DIST to the opencode build output.\n` +
          `   The worker still builds; opencode install will report "artifact not staged".`,
      );
      await emitGenerated({
        version,
        entryPath: null,
        sidecars: [],
        digests: {},
        buildId: '',
        treeSitterWasms: null,
        parserWorker: null,
        yogaWasm: null,
        chunksPack: null,
        chunkRanges: null,
      });
      return;
    }
  }
  const restaging = path.resolve(distDir) === path.resolve(assetDir);
  const provenance = JSON.parse(await fs.readFile(path.join(distDir, 'provenance.json'), 'utf8'));
  if (provenance.source?.commit !== OPENCODE_SOURCE.commit || provenance.source?.version !== version) {
    throw new Error('[bundle-opencode] provenance does not name the pinned upstream source');
  }
  assertCurrentInputs('OpenCode', provenance.source?.inputs, await opencodeInputs(),
    'bun scripts/ci/rebuild-opencode.mjs --out <file> (on armada)');
  if (restaging) {
    assertCurrentInputs('OpenCode output', provenance.outputs,
      await digestInputs(distDir, Object.keys(provenance.outputs ?? {})), 'bun scripts/ci/rebuild-opencode.mjs --out <file> (on armada)');
  }

  const indexSrc = path.join(distDir, 'index.js');
  if (!(await exists(indexSrc))) {
    throw new Error(`[bundle-opencode] ${distDir} has no index.js — not an opencode dist dir`);
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

  if (!restaging) {
    await fs.rm(assetDir, { recursive: true, force: true });
    await fs.mkdir(assetDir, { recursive: true });
  }

  // Stage every file in the dist dir (index.js + tree-sitter .wasm + .scm +
  // the few embedded assets the bundle references by name). A fresh split
  // build's chunk-*.js files are aggregated into the single chunks.json pack;
  // a restage from committed assets already carries the pack.
  const entries = await fs.readdir(distDir, { withFileTypes: true });
  const fileNames = entries.filter((e) => e.isFile() && e.name !== 'provenance.json').map((e) => e.name);
  const chunkNames = fileNames.filter((n) => CHUNK_RE.test(n)).sort();
  const staged = [];
  for (const name of fileNames.filter((n) => !CHUNK_RE.test(n)).sort()) {
    staged.push({ name, bytes: await fs.readFile(path.join(distDir, name)) });
  }
  if (chunkNames.length > 0) {
    if (staged.some((f) => f.name === CHUNKS_PACK)) {
      throw new Error(`[bundle-opencode] dist has both chunk-*.js files and ${CHUNKS_PACK}`);
    }
    const pack = {};
    for (const name of chunkNames) {
      pack[name] = await fs.readFile(path.join(distDir, name), 'utf8');
    }
    staged.push({ name: CHUNKS_PACK, bytes: Buffer.from(JSON.stringify(pack), 'utf8') });
    staged.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[bundle-opencode] packed ${chunkNames.length} split chunks into ${CHUNKS_PACK}`);
  }
  // Fail-loud closure check: the pack must contain EXACTLY the chunk set
  // reachable (statically or dynamically) from index.js + the
  // chunks themselves. A missing chunk is a runtime module-not-found inside
  // the facet; an extra chunk is dead weight shipped into every spawn.
  {
    const packEntry = staged.find((f) => f.name === CHUNKS_PACK);
    if (packEntry) {
      const pack = JSON.parse(packEntry.bytes.toString('utf8'));
      const entries = staged.filter((f) => f.name === 'index.js')
        .map((f) => f.bytes.toString('utf8'));
      const reachable = chunkClosure(entries, (name) => pack[name]);
      const packed = new Set(Object.keys(pack));
      const missing = [...reachable].filter((n) => !packed.has(n));
      const extra = [...packed].filter((n) => !reachable.has(n));
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(
          `[bundle-opencode] ${CHUNKS_PACK} does not match the entry import closure — ` +
            `missing: ${missing.join(', ') || 'none'}; unreachable: ${extra.join(', ') || 'none'}`,
        );
      }
      console.log(`[bundle-opencode] chunk closure verified: ${packed.size} chunks reachable from index.js`);
    }
  }

  // Derive the attach-mode entry (defect #20): index.js with the full TUI
  // runtime closure inlined statically, so the attach facet performs no
  // runtime chunk-graph imports (the production process-killer). Regenerated
  // from the staged sources every run — it is derived output, never edited.
  {
    const packEntry = staged.find((f) => f.name === CHUNKS_PACK);
    if (packEntry) {
      const indexEntry = staged.find((f) => f.name === 'index.js');
      const attachText = await buildOpencodeAttachEntryFromSources(
        indexEntry.bytes.toString('utf8'),
        JSON.parse(packEntry.bytes.toString('utf8')),
      );
      const attachFile = { name: 'index-attach.js', bytes: Buffer.from(attachText, 'utf8') };
      const existing = staged.findIndex((f) => f.name === 'index-attach.js');
      if (existing >= 0) staged[existing] = attachFile;
      else staged.push(attachFile);
      staged.sort((a, b) => a.name.localeCompare(b.name));
      await fs.mkdir(assetDir, { recursive: true });
      await fs.writeFile(path.join(assetDir, 'index-attach.js'), attachFile.bytes);
    }
  }

  const sidecars = [];
  const digests = {};
  let totalBytes = 0;
  const hash = createHash('sha256');
  for (const { name, bytes } of staged) {
    if (!restaging) await fs.writeFile(path.join(assetDir, name), bytes);
    totalBytes += bytes.length;
    hash.update(name);
    hash.update(bytes);
    digests[name] = sha256Hex(bytes);
    if (name !== 'index.js') sidecars.push(name);
    console.log(
      `[bundle-opencode] staged ${name} (${(bytes.length / 1024).toFixed(1)} KiB)`,
    );
  }
  sidecars.sort();
  const buildId = hash.digest('hex').slice(0, 16);
  if (!restaging) {
    provenance.outputs = Object.fromEntries(staged.filter(file => file.name !== 'index-attach.js').map(file => [file.name, digests[file.name]]));
    await fs.writeFile(path.join(assetDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  }

  const entryPath = `/${assetRel.split(path.sep).join('/')}/index.js`;
  await emitGenerated({
    version,
    entryPath,
    sidecars,
    digests,
    buildId,
    treeSitterWasms: resolveTreeSitterWasms(sidecars),
    parserWorker: resolveParserWorker(sidecars),
    yogaWasm: resolveYogaWasm(sidecars),
    chunksPack: resolveChunksPack(sidecars),
    chunkRanges: resolveChunksPack(sidecars) ? chunkPackRanges(staged.find((f) => f.name === CHUNKS_PACK).bytes) : null,
  });

  console.log(
    `[bundle-opencode] staged opencode ${version}: ${staged.length} files, ` +
      `${(totalBytes / 1024 / 1024).toFixed(1)} MiB → public/${assetRel}`,
  );
}

main().catch((e) => {
  console.error('[bundle-opencode] failed:', e);
  process.exit(1);
});
