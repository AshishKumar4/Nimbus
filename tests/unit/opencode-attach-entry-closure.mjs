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

// Seed derivation is fail-loud when the attach command is gone.
await assert.rejects(
  () => buildOpencodeAttachEntryFromSources('export async function nimbusMain(){}', pack),
  /attach.*not found|command name changed/,
  'must fail loud when the attach command is absent',
);

console.log('opencode-attach-entry-closure OK: attach closure inlined, sibling commands stubbed');
