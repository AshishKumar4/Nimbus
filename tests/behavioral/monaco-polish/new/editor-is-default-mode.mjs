#!/usr/bin/env bun
// monaco-polish/new/editor-is-default-mode — page-load default
// layout is 'editor' (not 'split').
//
// User: "Make the editor tab the default view"

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/editor-is-default-mode');
console.log(`monaco-polish/new/editor-is-default-mode — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// The boot sequence ends with: term.focus(); setLayout('editor'); connect();
a.check("Initial setLayout call uses 'editor'",
  /term\.focus\(\);[\s\S]{0,500}setLayout\(['"]editor['"]\)/.test(html),
  `default-mode is not 'editor'`);

// Old default 'split' must NOT be the initial call (it can still be
// referenced as a mode handler for the toolbar button).
const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
// Negative form: there should NOT be a stray `setLayout('split');` at
// the boot trailing position. We accept the toolbar onclick
// `setLayout('split')` because that's user-driven.
a.check("Boot does NOT call setLayout('split') at startup",
  !/term\.focus\(\);[\s\S]{0,500}setLayout\(['"]split['"]\)/.test(stripped),
  `boot still calls setLayout('split')`);

// PaneResizer module wired before initial setLayout (so persisted
// dims are restored before first paint).
a.check('PaneResizer.restoreDims called before setLayout',
  /PaneResizer\.restoreDims\(\);[\s\S]{0,200}setLayout\(['"]editor['"]\)/.test(html),
  `dims restore not wired pre-layout`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
