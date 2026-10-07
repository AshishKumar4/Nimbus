#!/usr/bin/env bun
// Guard: the attach-mode entry (index-attach.js) must inline EXACTLY the chunk
// closure the `opencode attach <url>` command handler reaches — its lazy TUI
// imports and their transitive deps — and stub every other command's lazy
// chunk import fail-loud. A closure seeded from the wrong command (e.g. the
// bare `opencode` interactive TUI) stubs the very chunks `opencode attach`
// imports first, so the attach process throws before painting a frame (defect
// #20 regression). This test pins the seed derivation to the attach command.

import assert from 'node:assert/strict';
import { buildOpencodeAttachEntryFromSources } from '../../packages/worker/scripts/build-opencode-attach-entry.mjs';

// Synthetic opencode split build: the attach command lazy-imports the attach
// TUI (which statically pulls a dep); a sibling command lazy-imports its own
// chunk; a bare-TUI chunk exists but is unreachable from attach.
const entry = [
  'export async function nimbusMain() {}',
  'export const cli = [',
  '  { command:"attach <url>", handler: async () => {',
  '      const { TuiConfig } = await import("./chunk-attachtui.js");',
  '      const { createTuiRenderer } = await import("./chunk-attachrender.js");',
  '      return [TuiConfig, createTuiRenderer];',
  '  } },',
  '  { command:"run", handler: async () => import("./chunk-run.js") },',
  '  { command:"$0", handler: async () => import("./chunk-baretui.js") },',
  '];',
].join('\n');

const pack = {
  'chunk-attachtui.js': 'import "./chunk-shared.js";\nexport const TuiConfig = {};',
  'chunk-attachrender.js': 'export const createTuiRenderer = () => {};',
  'chunk-shared.js': 'export const shared = 1;',
  'chunk-run.js': 'export const run = 1;',
  'chunk-baretui.js': 'export const bare = 1;',
};

const out = await buildOpencodeAttachEntryFromSources(entry, pack);

// No runtime chunk import survives — the attach map is packless.
assert.equal(
  [...out.matchAll(/import\(\s*["'](?:\.\/)?chunk-[a-z0-9]+\.js["']\s*\)/g)].length,
  0,
  'a runtime chunk import survived the rebuild',
);

// The attach closure (both lazy imports + the transitive static dep) is inlined
// as real code, NOT replaced by the fail-loud stub.
for (const inClosure of ['chunk-attachtui.js', 'chunk-attachrender.js', 'chunk-shared.js']) {
  assert.ok(
    !out.includes(`${inClosure} is outside`),
    `${inClosure} must be inlined (attach needs it), not stubbed`,
  );
}

// Sibling-command chunks unreachable from attach are stubbed fail-loud.
for (const stubbed of ['chunk-run.js', 'chunk-baretui.js']) {
  assert.ok(out.includes(`${stubbed} is outside`), `${stubbed} must be a fail-loud stub`);
}

// A closure chunk that loads an asset chunk through a dynamic import with
// import attributes (opencode's tree-sitter wasm and highlight queries:
// `import("./chunk-….js", {with:{type:"wasm"}})`) reaches it: it is inlined
// and loads, not stubbed.
{
  const assetPack = {
    ...pack,
    'chunk-attachtui.js':
      'import "./chunk-shared.js";\n' +
      'export const TuiConfig = { wasm: async () => (await import("./chunk-grammar.js", {with:{type:"wasm"}})).default };',
    'chunk-grammar.js': 'var t = "./tree-sitter-grammar.wasm"; export { t as default };',
  };
  const withAssets = await buildOpencodeAttachEntryFromSources(entry, assetPack);
  assert.ok(!withAssets.includes('chunk-grammar.js is outside'), 'an attribute-carrying dynamic import is in the closure');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(withAssets).toString('base64')}`);
  const [TuiConfig] = await mod.cli[0].handler();
  assert.equal(await TuiConfig.wasm(), './tree-sitter-grammar.wasm');
}

// Seed derivation is fail-loud when the attach command is gone.
await assert.rejects(
  () => buildOpencodeAttachEntryFromSources('export async function nimbusMain(){}', pack),
  /attach.*not found|command name changed/,
  'must fail loud when the attach command is absent',
);

// The attach entry is pure ASCII, so the session assembling the facet and the
// facet running it hold its ~14 MB source as a one-byte string, not a two-byte
// one. opencode's regexes carry typographic quotes that esbuild's ASCII
// charset leaves alone; they must still match what they matched.
{
  const quotePack = {
    ...pack,
    'chunk-attachtui.js':
      'import "./chunk-shared.js";\n' +
      'export const TuiConfig = { norm: (s) => s.replace(/[\u2018\u2019]/g, "\'").replace(/\\\u2026/g, "...") };',
  };
  const ascii = await buildOpencodeAttachEntryFromSources(entry, quotePack);
  assert.equal(ascii.search(/[^\x00-\x7f]/), -1, 'the attach entry must be ASCII-only');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(ascii).toString('base64')}`);
  const [TuiConfig] = await mod.cli[0].handler();
  assert.equal(TuiConfig.norm('\u2018hi\u2019 \u2026'), "'hi' ...", 'escaped regexes match what the originals matched');
}

console.log('opencode-attach-entry-closure OK: attach closure inlined, sibling commands stubbed');
