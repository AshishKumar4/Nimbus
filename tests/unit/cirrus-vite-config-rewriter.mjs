#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { rewriteCirrusViteConfigBundle } from '../../packages/worker/src/runtime/cirrus-vite-config-rewriter.ts';

const rewritten = rewriteCirrusViteConfigBundle(`
  import { defineConfig } from "vite";
  import react from "@vitejs/plugin-react";
  import { readFileSync } from "node:fs";
  export { normalizePath } from "vite";
  const require = createRequire(import.meta.url);
  const plugin = await import("@vitejs/plugin-react/jsx-runtime");
  export default defineConfig({ plugins: [react()], value: readFileSync, plugin, require });
`);

assert.match(rewritten, /from "\.\/vite-config-helper\.js"/);
assert.match(rewritten, /from "\.\/cirrus-plugin-react\.js"/);
assert.match(rewritten, /from "\.\/cirrus-fs\.js"/);
assert.match(rewritten, /from "\.\/vite-config-helper\.js"/);
assert.match(rewritten, /globalThis\.__cirrusNodeCreateRequire/);
assert.match(rewritten, /__cirrusRealUserspaceRequire\?\.\("@vitejs\/plugin-react\/jsx-runtime"\)/);
assert.doesNotMatch(rewritten, /from "vite"/);
assert.doesNotMatch(rewritten, /from "@vitejs\/plugin-react"/);
assert.doesNotMatch(rewritten, /from "node:fs"/);

console.log('cirrus-vite-config-rewriter: ok');
