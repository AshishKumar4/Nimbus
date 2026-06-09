#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { rewriteAllImports } from '../../packages/worker/src/facets/vite-dev-server.ts';

const rewritten = rewriteAllImports(`
  import "@/index.css?import";
  import "@/theme.css";
  import "./local.css";
  import React from "react";
  import { ErrorFallback } from "./ErrorFallback";
  export { clsx } from "clsx";
  const diagnostic = "called from \\"react\\" and import \\"left-alone\\";";
`, { '@': './src' }, '/preview');

assert.ok(rewritten.includes('import "/preview/src/index.css?import";'));
assert.ok(rewritten.includes('import "/preview/src/theme.css?import";'));
assert.ok(rewritten.includes('import "./local.css?import";'));
assert.ok(rewritten.includes('from "/preview/@modules/react"'));
assert.ok(rewritten.includes('from "./ErrorFallback"'));
assert.ok(rewritten.includes('from "/preview/@modules/clsx"'));
assert.ok(rewritten.includes('called from \\"react\\" and import \\"left-alone\\"'));
assert.ok(!rewritten.includes('"/preview/@modules/left-alone"'));
assert.ok(!rewritten.includes('"/preview/@modules/./ErrorFallback"'));
assert.ok(!rewritten.includes('?import?import'));

console.log('vite-import-rewriter: ok');
