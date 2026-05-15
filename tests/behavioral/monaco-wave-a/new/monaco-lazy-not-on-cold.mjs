#!/usr/bin/env bun
// monaco-wave-a/new/monaco-lazy-not-on-cold — structural perf invariant.
//
// monaco-polish (2026-05-14): contract narrowed. Editor is now the
// DEFAULT mode on cold session, so Monaco WILL be requested via
// document.head.appendChild on every fresh page load. The preserved
// invariant is purely STRUCTURAL: no <script src="...monaco..."> in
// the served HTML. Monaco loader is appended at runtime, never as
// a top-level pre-fetched script.
//
// We assert:
//   1. NO <script src="...monaco..."> tag in initial HTML.
//   2. Editor module present (so the runtime hook exists).
//   3. #btnEditor present (single canonical mode).
//   4. fs-* protocol references present.
//   5. Ctrl+P keydown handler present.

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
