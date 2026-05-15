#!/usr/bin/env bun
// monaco-wave-a/new/monaco-lazy-not-on-cold — perf invariant.
//
// Charter: "Monaco 5MB. MUST lazy-load on first editor activation
// only. Cold session terminal-only MUST NOT download Monaco."
//
// The cold-session HTML is served by the asset binding. This probe
// fetches /s/<sid>/ AND /index.html, asserts:
//   1. Monaco's loader script URL is NOT in any <script src=...> tag
//      that would auto-fetch (i.e. no top-level <script src="...monaco...">).
//   2. The Editor module IS present in the page (so the lazy hook
//      exists and will fire on user demand).
//   3. The new layout-mode buttons (#btnEditor, #btnEditorTerm) ARE
//      present.
//   4. The fs-* WS protocol surface is referenced (sanity that the
//      JS side has the hooks).
//
// What this DOESN'T cover (deferred to puppeteer probe): actual
// runtime fetch of Monaco only on click. The HTML-shape assertions
// here catch the bug at the source-file level — if Monaco script is
// in a top-level <script src> tag, it WILL load on page render.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/monaco-lazy-not-on-cold');
console.log(`monaco-wave-a/new/monaco-lazy-not-on-cold — ${process.env.BASE}`);

const sid = await mintSession();

// Fetch the page HTML. Asset binding serves /s/<sid>/index.html.
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
a.check('session page HTTP 200', r.status === 200, `status=${r.status}`);
const html = await r.text();

// Invariant 1: NO eager <script src="..."> for Monaco assets.
// Match <script src="..."> tags only. Comments/JS-string literals are
// not script tags so they don't auto-fetch.
const eagerScripts = Array.from(html.matchAll(/<script\s+[^>]*src=["']([^"']+)["']/gi)).map(m => m[1]);
const eagerMonaco = eagerScripts.filter(s => /monaco/i.test(s));
a.check('NO eager <script src> for Monaco (cold-start invariant)',
  eagerMonaco.length === 0,
  `eagerMonacoUrls=${JSON.stringify(eagerMonaco)} allEager=${JSON.stringify(eagerScripts)}`);

// Invariant 2: the Editor module DOES exist in inline JS (so lazy
// hook is wired). The string 'monaco-editor' (in the cdnjs path) or
// 'ensureLoaded' (Editor module method) should be present.
a.check('Editor module is wired (inline JS references Monaco)',
  /monaco-editor|ensureLoaded\s*\(/.test(html),
  `Editor.ensureLoaded() not found in page source`);

// Invariant 3: new toolbar buttons present.
a.check('toolbar has #btnEditor button',
  /id=["']btnEditor["']/.test(html),
  `btnEditor missing`);
a.check('toolbar has #btnEditorTerm button',
  /id=["']btnEditorTerm["']/.test(html),
  `btnEditorTerm missing`);

// Invariant 4: fs-* WS protocol references in inline JS.
a.check('JS references fs-read protocol',
  /fs-read/.test(html),
  `'fs-read' not in HTML`);
a.check('JS references fs-write protocol',
  /fs-write/.test(html),
  `'fs-write' not in HTML`);
a.check('JS references fs-list protocol',
  /fs-list/.test(html),
  `'fs-list' not in HTML`);

// Invariant 5: Ctrl+P palette wiring.
a.check('Ctrl+P keydown handler present',
  /isCtrlP|ctrlKey.*?'p'/i.test(html),
  `Ctrl+P binding missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
