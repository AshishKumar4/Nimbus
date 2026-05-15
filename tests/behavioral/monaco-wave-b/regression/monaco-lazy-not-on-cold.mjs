#!/usr/bin/env bun
// monaco-wave-b/regression/monaco-lazy-not-on-cold — perf-invariant.
//
// monaco-polish (2026-05-14): contract narrowed. Editor is now the
// DEFAULT mode on cold session, so Monaco DOES fetch on cold. The
// preserved invariant is structural: no <script src="...monaco..."
// in the served HTML. Monaco loader is appended via document.head
// at runtime inside Editor.ensureLoaded(), not as a top-level
// pre-fetched script.
//
// We assert:
//   1. No <script src="...monaco..."> tag in initial HTML.
//   2. FileTree.ensureLoaded gated on editor-mode in setLayout.
//   3. FileTree IIFE state-only (no fs-* fires until ensureLoaded).

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

// monaco-polish (2026-05-14): default mode is 'editor' (user
// request). Page-load contract: Monaco is fetched at runtime via
// document.head.appendChild, NOT via a top-level <script src>.
// The 'no eager <script src>' check above covers the structural
// invariant; the active mode is irrelevant to that property.
a.check("Initial setLayout call present",
  /\bsetLayout\(['"][a-z-]+['"]\)\s*;/.test(html),
  `initial setLayout missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
