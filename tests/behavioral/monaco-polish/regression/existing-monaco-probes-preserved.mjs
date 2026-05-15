#!/usr/bin/env bun
// monaco-polish/regression/existing-monaco-probes-preserved —
// sample critical assertions from Wave-A/B/file-tree-fix:
//   - FileTree IIFE intact
//   - fs-* WS protocol references intact
//   - Monaco config (minimap, bracketPairColorization, font, theme)
//   - Editor return-shape: {ensureLoaded, openFile, save, openPalette,
//     tryHandleFsResult, drainFsQueue}
//   - FileTree return-shape: {ensureLoaded, tryHandleFsResult,
//     markDirty, setSelected, drainFsQueue}
//   - Ctrl+P keydown + Ctrl+S keydown
//   - Editor-mode CSS rules (file-tree | editor-stack | preview)

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/regression/existing-monaco-probes-preserved');
console.log(`monaco-polish/regression/existing-monaco-probes-preserved — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// Module presence.
a.check('Editor IIFE present',
  /const Editor\s*=\s*\(function\(\)/.test(html),
  `Editor IIFE missing`);
a.check('FileTree IIFE present',
  /const FileTree\s*=\s*\(function\(\)/.test(html),
  `FileTree IIFE missing`);

// fs-* protocol.
a.check('fs-read referenced', /fs-read/.test(html), `fs-read missing`);
a.check('fs-write referenced', /fs-write/.test(html), `fs-write missing`);
a.check('fs-list referenced', /fs-list/.test(html), `fs-list missing`);

// Editor return-shape.
a.check('Editor returns ensureLoaded + openFile + save + openPalette + tryHandleFsResult + drainFsQueue',
  /return\s*\{\s*ensureLoaded\s*,\s*openFile\s*,\s*save\s*,\s*openPalette\s*,\s*tryHandleFsResult\s*,\s*drainFsQueue\s*\}/.test(html),
  `Editor return-shape changed`);

// FileTree return-shape.
a.check('FileTree returns ensureLoaded + tryHandleFsResult + markDirty + setSelected + drainFsQueue',
  /return\s*\{\s*ensureLoaded\s*,\s*tryHandleFsResult\s*,\s*markDirty\s*,\s*setSelected\s*,\s*drainFsQueue\s*\}/.test(html),
  `FileTree return-shape changed`);

// Monaco config.
a.check('Monaco minimap enabled',
  /minimap:\s*\{[^}]*enabled:\s*true/.test(html),
  `minimap regressed`);
a.check('Monaco bracketPairColorization',
  /bracketPairColorization:\s*\{[^}]*enabled:\s*true/.test(html),
  `bracket-pair-color regressed`);
a.check('Monaco fontFamily Menlo first',
  /fontFamily:\s*["']Menlo[^"']*Monaco/.test(html),
  `font regressed`);
a.check('Monaco fontSize 14',
  /fontSize:\s*14\b/.test(html),
  `fontSize regressed`);
a.check('Monaco theme vs-dark',
  /theme:\s*['"]vs-dark['"]/.test(html),
  `theme regressed`);
a.check('Monaco automaticLayout true',
  /automaticLayout:\s*true/.test(html),
  `automaticLayout regressed`);

// Keybindings.
a.check('Ctrl+P keydown handler',
  /isCtrlP\s*=\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*['"]p['"]/.test(html),
  `Ctrl+P regressed`);
a.check('Ctrl+S keydown handler',
  /isCtrlS\s*=\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*['"]s['"]/.test(html),
  `Ctrl+S regressed`);
a.check('Monaco editor.addCommand(Ctrl+S) → save',
  /addCommand\(window\.monaco\.KeyMod\.CtrlCmd\s*\|\s*window\.monaco\.KeyCode\.KeyS,\s*\(\)\s*=>\s*save\(\)\)/.test(html),
  `Monaco Ctrl+S binding regressed`);

// Editor-mode CSS — file tree | editor-stack | preview.
a.check('.main.editor shows .panel-tree',
  /\.main\.editor\s+\.panel-tree\s*\{[^}]*display:\s*flex/.test(html),
  `panel-tree rule regressed`);
a.check('.main.editor .panel-left-stack flex column',
  /\.main\.editor\s+\.panel-left-stack\s*\{[^}]*display:\s*flex/.test(html) &&
  /\.main\.editor\s+\.panel-left-stack\s*\{[^}]*flex-direction:\s*column/.test(html),
  `left-stack regressed`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
