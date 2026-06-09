#!/usr/bin/env bun
// monaco-polish/new/editor-is-default-mode — page-load default is the
// editor workspace.
//
// User: "Make the editor tab the default view"

import { mintSession, BASE, makeAsserter, requestHeaders } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/editor-is-default-mode');
console.log(`monaco-polish/new/editor-is-default-mode — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow', headers: requestHeaders() });
const html = await r.text();

// The shell has one workspace. The center surface defaults to editor and
// only switches to agent when the URL explicitly asks for it.
a.check("Work surface defaults to 'editor'",
  /let\s+workSurface\s*=\s*['"]editor['"]/.test(html),
  `workSurface default is not editor`);

a.check("Initial mode defaults to 'editor'",
  /const\s+initialMode\s*=\s*new URLSearchParams\(location\.search\)\.get\(['"]agent['"]\)\s*===\s*['"]1['"][\s\S]{0,120}\?\s*['"]agent['"]\s*:\s*['"]editor['"]/.test(html)
  && /setLayout\(initialMode\)/.test(html),
  `initialMode no longer defaults to editor`);

const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
a.check('Boot has no legacy workspace mode call',
  !/term\.focus\(\);[\s\S]{0,500}setLayout\(['"](split|terminal-only|preview-only)['"]\)/.test(stripped),
  `boot still calls a legacy mode`);

// PaneResizer module wired before initial setLayout (so persisted dims
// are restored before first paint).
a.check('PaneResizer.restoreDims called before initial setLayout',
  /PaneResizer\.restoreDims\(\);[\s\S]{0,240}setLayout\(initialMode\)/.test(html),
  `dims restore not wired pre-layout`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
