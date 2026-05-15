#!/usr/bin/env bun
// file-tree-watch/regression/monaco-lazy-preserved — the index.html
// shell still serves cleanly with the editor pane markers intact.
// The wave only added IIFE-internal methods + IIFE-exposed methods;
// it did NOT touch Monaco lazy-load logic. This probe is a guardrail
// against accidental indentation / parse breakage in the surgery
// (the FileTree IIFE grew by ~170 lines).

import { mintSession, sleep, makeAsserter, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/monaco-lazy-preserved');
console.log(`file-tree-watch/regression/monaco-lazy-preserved — ${BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`);
a.check('GET /s/<sid>/ returns 200', r.status === 200, `status=${r.status}`);
const html = await r.text();
a.check('html includes Editor IIFE marker',
  html.includes('Editor.ensureLoaded') || html.includes('const Editor = (function()'),
  `len=${html.length} hasEditorMarker=${html.includes('Editor')}`);
a.check('html includes FileTree IIFE marker',
  html.includes('FileTree.ensureLoaded') || html.includes('const FileTree = (function()'),
  `hasFileTreeMarker=${html.includes('FileTree')}`);
// New wave markers must be present.
a.check('html includes new FileTree.subscribeOnce export',
  html.includes('FileTree.subscribeOnce') || html.includes('subscribeOnce'),
  `hasSubscribeOnce=${html.includes('subscribeOnce')}`);
a.check('html includes new FileTree.applyWatchEvent dispatcher',
  html.includes('FileTree.applyWatchEvent') || html.includes('applyWatchEvent'),
  `hasApplyWatchEvent=${html.includes('applyWatchEvent')}`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
