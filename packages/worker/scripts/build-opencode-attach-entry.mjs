#!/usr/bin/env node
/**
 * build-opencode-attach-entry.mjs — derive the attach-mode opencode entry
 * (`index-attach.js`) from the split-build staging (index.js + the chunk set).
 *
 * WHY (defect #20): a runtime dynamic import of a chunk graph inside a live
 * facet can kill the entire production workerd process (supervisor DO
 * included). The `opencode attach <url>` command lazy-imports its TUI at
 * handler time — exactly that fatal shape. The attach facet therefore boots
 * an entry with the FULL attach-TUI runtime closure (the transitive static +
 * dynamic edges of the chunks the `attach` command handler imports) inlined
 * into the boot-time static graph — the one shape never observed to kill —
 * and its module map carries no chunk modules at all. Dynamic chunk imports
 * OUTSIDE that closure (CLI command paths unreachable from `opencode attach`)
 * compile to fail-loud throw stubs. The closure seeds are derived from the
 * `attach <url>` command handler in index.js (not a pinned chunk name), so a
 * chunk rename in a new opencode build re-resolves automatically.
 * See scratchpad/oc-attach-reset-rootcause.md (§JSPI bisect, B3–B8).
 *
 * Invoked by scripts/bundle-opencode.mjs during staging; also runnable
 * standalone: node scripts/build-opencode-attach-entry.mjs <assetDir>.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The command whose handler lazy-imports the attach TUI (`opencode attach <url>`). */
const ATTACH_COMMAND = 'command:"attach <url>"';

const STATIC_RE = /from\s*["']\.\/(chunk-[a-z0-9]+\.js)["']|import\s*["']\.\/(chunk-[a-z0-9]+\.js)["']/g;
const DYN_RE = /import\(\s*["']\.\/(chunk-[a-z0-9]+\.js)["']\s*\)/g;

function edges(src) {
  const out = new Set();
  for (const m of src.matchAll(STATIC_RE)) out.add(m[1] || m[2]);
  for (const m of src.matchAll(DYN_RE)) out.add(m[1]);
  return out;
}

/**
 * The chunks the `attach` command handler dynamically imports — the seeds of
 * the attach-mode TUI closure. Scoped to the command's own registration block
 * so sibling commands' lazy imports never leak into the attach closure.
 */
function attachSeedChunks(entry) {
  const start = entry.indexOf(ATTACH_COMMAND);
  if (start < 0) {
    throw new Error(
      `[build-opencode-attach-entry] ${ATTACH_COMMAND} not found in index.js — the attach ` +
        'command name changed with this opencode build; update ATTACH_COMMAND',
    );
  }
  const next = entry.indexOf('command:"', start + ATTACH_COMMAND.length);
  const region = entry.slice(start, next > start ? next : entry.length);
  const seeds = new Set([...region.matchAll(DYN_RE)].map((m) => m[1]));
  if (seeds.size === 0) {
    throw new Error(
      '[build-opencode-attach-entry] the attach command handler issued no dynamic chunk ' +
        'imports — the lazy-TUI structure changed; re-derive the attach closure seeds',
    );
  }
  return seeds;
}

/**
 * Build the attach entry text from in-memory sources.
 * @param entry index.js source text.
 * @param pack chunk name → source map (the chunks.json content).
 * @returns the bundled index-attach.js text.
 */
export async function buildOpencodeAttachEntryFromSources(entry, pack) {
  const seeds = attachSeedChunks(entry);
  for (const seed of seeds) {
    if (!pack[seed]) {
      throw new Error(
        `[build-opencode-attach-entry] attach seed chunk ${seed} not in the pack — ` +
          'the staged chunk set is inconsistent with index.js',
      );
    }
  }

  // Full attach-TUI runtime closure: static AND dynamic edges from the seeds.
  const tui = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop();
    if (tui.has(name) || !pack[name]) continue;
    tui.add(name);
    for (const e of edges(pack[name])) queue.push(e);
  }

  const esbuild = require('esbuild');
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: '/', sourcefile: 'index.js', loader: 'js' },
    bundle: true,
    splitting: false,
    format: 'esm',
    platform: 'node',
    write: false,
    minify: true,
    legalComments: 'none',
    logLevel: 'error',
    external: ['node:*'],
    plugins: [
      {
        name: 'opencode-chunk-pack',
        setup(b) {
          b.onResolve({ filter: /chunk-[a-z0-9]+\.js$/ }, (args) => {
            const name = args.path.replace(/^\.\//, '');
            if (!pack[name]) return { errors: [{ text: `chunk not in pack: ${name}` }] };
            if (args.kind === 'dynamic-import' && !tui.has(name)) {
              return { path: name, namespace: 'opencode-chunk-stub' };
            }
            return { path: name, namespace: 'opencode-chunk' };
          });
          b.onLoad({ filter: /.*/, namespace: 'opencode-chunk' }, (args) => ({
            contents: pack[args.path],
            loader: 'js',
            resolveDir: '/',
          }));
          b.onLoad({ filter: /.*/, namespace: 'opencode-chunk-stub' }, (args) => ({
            contents:
              `throw new Error("Nimbus attach entry: chunk ${args.path} is outside the ` +
              `attach-mode closure — this CLI path is not reachable from 'opencode attach'");`,
            loader: 'js',
            resolveDir: '/',
          }));
        },
      },
    ],
  });
  const out = result.outputFiles[0].text;
  const residual = [...out.matchAll(/import\(\s*["'](?:\.\/)?(chunk-[a-z0-9]+\.js)["']\s*\)/g)];
  if (residual.length > 0) {
    throw new Error(
      `[build-opencode-attach-entry] ${residual.length} runtime chunk import(s) survived the ` +
        `rebuild (${residual.slice(0, 3).map((m) => m[1]).join(', ')}) — the attach facet map is ` +
        'packless, these would fail at runtime; fix the closure',
    );
  }
  console.log(
    `[build-opencode-attach-entry] index-attach.js: ${(out.length / 1024 / 1024).toFixed(1)} MiB ` +
      `(TUI closure ${tui.size} chunks inlined; out-of-closure dynamic imports stubbed fail-loud)`,
  );
  return out;
}

/** Disk wrapper: derive index-attach.js inside a staged asset directory. */
export async function buildOpencodeAttachEntry(assetDir) {
  const entry = await fs.readFile(path.join(assetDir, 'index.js'), 'utf8');
  const pack = JSON.parse(await fs.readFile(path.join(assetDir, 'chunks.json'), 'utf8'));
  const out = await buildOpencodeAttachEntryFromSources(entry, pack);
  await fs.writeFile(path.join(assetDir, 'index-attach.js'), out, 'utf8');
  return out.length;
}

// Standalone invocation: node scripts/build-opencode-attach-entry.mjs <assetDir>
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: build-opencode-attach-entry.mjs <staged-asset-dir>');
    process.exit(2);
  }
  buildOpencodeAttachEntry(path.resolve(dir)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
