#!/usr/bin/env bun
// monaco-polish/new/monaco-still-lazy-script — narrower invariant
// after the editor-default switch.
//
// Pre-polish: "Cold session terminal-only MUST NOT download Monaco."
// Post-polish: editor IS default, so Monaco WILL be fetched on cold.
// What survives: NO <script src="...monaco..."> tag in initial HTML.
// Monaco loader is appended via document.head at runtime.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/monaco-still-lazy-script');
console.log(`monaco-polish/new/monaco-still-lazy-script — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// Invariant: no eager <script src> for Monaco assets.
const eagerScripts = Array.from(html.matchAll(/<script\s+[^>]*src=["']([^"']+)["']/gi)).map(m => m[1]);
const eagerMonaco = eagerScripts.filter(s => /monaco/i.test(s));
a.check('NO eager <script src> referencing Monaco',
  eagerMonaco.length === 0,
  `eagerMonacoUrls=${JSON.stringify(eagerMonaco)} allEager=${JSON.stringify(eagerScripts)}`);

// Monaco is referenced inline (string literal) inside Editor.ensureLoaded()
// — that runs ONLY when setLayout('editor') fires (which now fires at
// page-load default, but the loader is still NOT pre-fetched by a
// <script src> tag). Asserting Monaco loader URL is in inline JS but
// NOT a top-level src.
a.check('Monaco loader URL present in inline JS (runtime-appended)',
  /cdnjs\.cloudflare\.com\/ajax\/libs\/monaco-editor/.test(html),
  `Monaco CDN reference missing`);

// document.head.appendChild path is the loader mechanism.
a.check('Monaco loader via document.head.appendChild (runtime, not eager)',
  /document\.head\.appendChild\(script\)/.test(html),
  `appendChild loader missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
