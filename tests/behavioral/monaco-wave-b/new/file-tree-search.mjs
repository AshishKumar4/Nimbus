#!/usr/bin/env bun
// monaco-wave-b/new/file-tree-search — search input filters the
// tree client-side. We assert the JS wiring (input event → rerender
// with filter applied to node.path).

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/new/file-tree-search');
console.log(`monaco-wave-b/new/file-tree-search — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('searchInput input event wired to rerender',
  /searchInput\.addEventListener\(['"]input['"]\s*,\s*rerender\)/.test(html),
  `search wiring missing`);
a.check('rerender() reads filter from searchInput.value',
  /function rerender[\s\S]{0,500}searchInput\.value/.test(html),
  `rerender filter logic missing`);
a.check('rerender() applies substring filter on node.path',
  /function rerender[\s\S]{0,800}n\.path\.toLowerCase\(\)\.includes\(filter\)/.test(html),
  `path-substring filter missing`);
a.check('No-matches empty state present',
  /No matches for/.test(html),
  `empty-state message missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
