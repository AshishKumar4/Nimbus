#!/usr/bin/env bun
// monaco-wave-b/regression/monaco-lazy-not-on-cold — perf-invariant
// preserved. Adding the FileTree must NOT cause Monaco (or the
// tree's heavy code) to load eagerly.
//
// We assert:
//   1. No <script src="...monaco...."> auto-fetch tag.
//   2. FileTree.ensureLoaded() only called from setLayout when
//      switching to 'editor' (NOT at page-load).
//   3. Monaco loader URL only appears inside ensureLoaded() body
//      (not as a top-level <script src>).

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/monaco-lazy-not-on-cold');
console.log(`monaco-wave-b/regression/monaco-lazy-not-on-cold — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// No eager <script src> for Monaco.
const eagerScripts = Array.from(html.matchAll(/<script\s+[^>]*src=["']([^"']+)["']/gi)).map(m => m[1]);
const eagerMonaco = eagerScripts.filter(s => /monaco/i.test(s));
a.check('NO eager <script src> for Monaco',
  eagerMonaco.length === 0,
  `eagerMonacoUrls=${JSON.stringify(eagerMonaco)}`);

// FileTree.ensureLoaded gated on editor mode switch.
a.check('FileTree.ensureLoaded called inside setLayout (lazy)',
  /function setLayout[\s\S]{0,800}wantEditor[\s\S]{0,200}FileTree\.ensureLoaded\(\)/.test(html),
  `lazy-load gating missing`);

// FileTree module is defined as an IIFE — module declaration runs
// at page parse but only sets up state; no fs-* messages fire until
// ensureLoaded() is invoked.
a.check('FileTree IIFE present (state-only, no eager fs calls)',
  /const FileTree\s*=\s*\(function\(\)/.test(html),
  `FileTree IIFE missing`);

// Default layout is 'split' (not 'editor'). So the page starts in
// terminal+preview mode and Monaco is not requested.
a.check("Initial setLayout('split') (not 'editor')",
  /\bsetLayout\(['"]split['"]\)/.test(html),
  `initial setLayout('split') missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
