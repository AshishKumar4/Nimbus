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
import { modelsCatalogs } from './opencode/models-catalog.mjs';

const require = createRequire(import.meta.url);

/** The command whose handler lazy-imports the attach TUI (`opencode attach <url>`). */
const ATTACH_COMMAND = 'command:"attach <url>"';

const STATIC_RE = /from\s*["']\.\/(chunk-[a-z0-9]+\.js)["']|import\s*["']\.\/(chunk-[a-z0-9]+\.js)["']/g;
// A dynamic import may carry import attributes: opencode loads its
// tree-sitter wasm and highlight queries as `import("./chunk-….js", {with:{type:"wasm"}})`.
const DYN_RE = /import\(\s*["']\.\/(chunk-[a-z0-9]+\.js)["']\s*[,)]/g;

/** The chunks `src` imports, statically or dynamically: the split build's only edges. */
export function edges(src) {
  const out = new Set();
  for (const m of src.matchAll(STATIC_RE)) out.add(m[1] || m[2]);
  for (const m of src.matchAll(DYN_RE)) out.add(m[1]);
  return out;
}

/**
 * Every chunk reachable from the `roots` sources through `edges`, whether
 * or not `sourceOf` has it (a name with no source is reached, not walked).
 *
 * @param {Iterable<string>} roots  source texts
 * @param {(chunk: string) => string | undefined} sourceOf
 * @returns {Set<string>}
 */
export function chunkClosure(roots, sourceOf) {
  const reached = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    for (const chunk of edges(queue.pop())) {
      if (reached.has(chunk)) continue;
      reached.add(chunk);
      const src = sourceOf(chunk);
      if (src !== undefined) queue.push(src);
    }
  }
  return reached;
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
 * Strip the embedded models.dev catalog literal from the ModelsDev chunk for
 * the ATTACH build. The multi-MB literal lives inside an Effect thunk that only
 * `ModelsDev.populate` — server-side code the attach TUI client never runs —
 * would evaluate; models reach the client from the opencode server's API.
 * Carrying the literal costs the attach facet that much retained source plus
 * parse work at boot, which matters on memory-tight placed machines (#35). The
 * thunk body becomes a fail-loud throw, so an unforeseen client-side evaluation
 * surfaces as a clear error, never silent empty data.
 *
 * The thunk is found from the syntax tree (opencode/models-catalog.mjs), folded
 * guard or not. If no chunk has exactly one, the literal is KEPT (correctness
 * over optimization) with a loud build warning.
 */
function stripEmbeddedModelsCatalog(pack) {
  for (const [name, src] of Object.entries(pack)) {
    const catalogs = modelsCatalogs(src);
    if (catalogs.length === 0) continue;
    if (catalogs.length > 1) {
      console.warn(
        `[build-opencode-attach-entry] WARNING: ${catalogs.length} catalog-sized literals in ${name} — ` +
          'keeping them (no size win)',
      );
      return pack;
    }
    const [{ start, end }] = catalogs;
    const replacement =
      '()=>{throw new Error("Nimbus attach entry: the embedded models.dev catalog ' +
      'is stripped from the attach client (models come from the opencode server API); ' +
      'client-side ModelsDev.populate is not expected to run")}';
    const stripped = src.slice(0, start) + replacement + src.slice(end);
    console.log(
      `[build-opencode-attach-entry] stripped embedded models catalog from ${name}: ` +
        `${((end - start) / 1024 / 1024).toFixed(2)} MiB of source removed`,
    );
    return { ...pack, [name]: stripped };
  }
  console.warn(
    '[build-opencode-attach-entry] WARNING: no chunk carries the embedded models catalog ' +
      '— embedded-catalog strip skipped (no size win)',
  );
  return pack;
}

const unicodeEscape = (code) => '\\u' + code.toString(16).padStart(4, '0');

/** One regex literal with every non-ASCII code unit written as `\uXXXX`; `\…` is an identity escape of `…`. */
function escapeRegexLiteral(literal) {
  let out = '';
  for (let i = 0; i < literal.length; i++) {
    const code = literal.charCodeAt(i);
    if (code === 0x5c && i + 1 < literal.length) {
      const next = literal.charCodeAt(i + 1);
      out += next > 0x7f ? unicodeEscape(next) : literal.slice(i, i + 2);
      i++;
    } else {
      out += code > 0x7f ? unicodeEscape(code) : literal[i];
    }
  }
  return out;
}

/** A comment with every non-ASCII code unit written as `\uXXXX`: text, so any spelling of it is the same comment. */
const escapeComment = (comment) => comment.replace(/[^\x00-\x7f]/g, (c) => unicodeEscape(c.charCodeAt(0)));

/**
 * Make esbuild output pure ASCII. esbuild's ASCII charset escapes every
 * literal except regular expressions, and keeps legal comments as written,
 * so opencode's typographic-quote regexes (`/[‘’‚‛]/g`, `/…/g`) and its
 * dependencies' license lines survive; one character above U+00FF makes V8
 * hold the whole source as a two-byte string, twice its size, in the session
 * that assembles the facet's module map and again in the facet that runs it.
 * Fails loud if non-ASCII remains anywhere else; `what` names the source.
 */
function asciiOnlyEsbuildOutput(src, what) {
  const acorn = require('acorn');
  const spans = [];
  const onComment = (_block, _text, start, end) => {
    if (/[^\x00-\x7f]/.test(src.slice(start, end))) spans.push({ start, end, escape: escapeComment });
  };
  for (const token of acorn.tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', onComment })) {
    if (token.type !== acorn.tokTypes.regexp) continue;
    if (/[^\x00-\x7f]/.test(src.slice(token.start, token.end))) spans.push({ start: token.start, end: token.end, escape: escapeRegexLiteral });
  }
  const parts = [];
  let last = 0;
  for (const { start, end, escape } of spans.sort((a, b) => a.start - b.start)) {
    parts.push(src.slice(last, start), escape(src.slice(start, end)));
    last = end;
  }
  parts.push(src.slice(last));
  const out = parts.join('');
  const residual = out.search(/[^\x00-\x7f]/);
  if (residual >= 0) {
    throw new Error(
      `[build-opencode-attach-entry] ${what}: non-ASCII outside a regex literal or a comment at offset ` +
        `${residual} (${JSON.stringify(out.slice(Math.max(0, residual - 40), residual + 10))}) — ` +
        'escape it here, or the source is held as a two-byte string',
    );
  }
  return out;
}

/**
 * A split-build chunk's source as pure ASCII (asciiOnlyEsbuildOutput): one
 * already ASCII as it is, any other reprinted by esbuild with its ASCII
 * charset, which writes every other character as an escape where the language
 * allows one. A chunk holding one character above U+00FF is otherwise held as
 * a two-byte string: 52 of opencode 1.16.2's 283 chunks, 16.2M characters.
 */
export async function asciiChunkSource(src, name) {
  if (!/[^\x00-\x7f]/.test(src)) return src;
  const { code } = await require('esbuild').transform(src, { loader: 'js', charset: 'ascii', sourcefile: name, logLevel: 'error' });
  return asciiOnlyEsbuildOutput(code, name);
}

/**
 * Build the attach entry text from in-memory sources.
 * @param entry index.js source text.
 * @param pack chunk name → source map (the chunks.json content).
 * @returns the bundled index-attach.js text.
 */
export async function buildOpencodeAttachEntryFromSources(entry, packInput) {
  const pack = stripEmbeddedModelsCatalog(packInput);
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
  const tui = new Set([...seeds, ...chunkClosure([...seeds].map((seed) => pack[seed]), (name) => pack[name])]);

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
  const out = asciiOnlyEsbuildOutput(result.outputFiles[0].text, 'index-attach.js');
  const residual = [...out.matchAll(/import\(\s*["'](?:\.\/)?(chunk-[a-z0-9]+\.js)["']\s*[,)]/g)];
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
