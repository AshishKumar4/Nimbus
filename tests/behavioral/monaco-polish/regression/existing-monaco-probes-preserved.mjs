#!/usr/bin/env bun
// monaco-polish/regression/existing-monaco-probes-preserved —
// sample critical assertions from editor/B/file-tree-fix:
//   - FileTree IIFE intact
//   - fs-* WS protocol references intact
//   - Monaco config (minimap, bracketPairColorization, font, theme)
//   - Editor public contract: ensureLoaded, openFile, save, openPalette,
//     tryHandleFsResult, drainFsQueue
//   - FileTree public contract: ensureLoaded, tryHandleFsResult,
//     markDirty, setSelected, drainFsQueue
//   - Ctrl+P keydown + Ctrl+S keydown
//   - Editor-mode CSS rules (file-tree | editor-stack | preview)
//
// Category: H (hybrid). The Monaco config / keybinding / CSS checks are
// structural contracts (the source string IS the wiring). The Editor and
// FileTree public-method contract is asserted as OBSERVABLE behavior in a
// real Chrome: the factories produce live runtime objects exposing the
// required methods as functions, and Ctrl+P actually opens the command
// palette via Editor.openPalette. An exact-closing-brace source regex was
// brittle here — the real returns carry a superset of methods
// (Editor also exposes invalidateFileListCache / openDefaultWelcome /
// refreshMarkdownPreview; FileTree also exposes subscribeOnce /
// applyWatchEvent / getWatchStats), so the brace regex missed them even
// though the asserted methods are all present and wired. The live check
// is the source of truth for the public contract.

import { mintSession, BASE, makeAsserter, requestHeaders, deleteSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/regression/existing-monaco-probes-preserved');
console.log(`monaco-polish/regression/existing-monaco-probes-preserved — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow', headers: requestHeaders() });
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

// Editor + FileTree public contract — asserted live, not by source regex.
const EDITOR_METHODS = ['ensureLoaded', 'openFile', 'save', 'openPalette', 'tryHandleFsResult', 'drainFsQueue'];
const FILETREE_METHODS = ['ensureLoaded', 'tryHandleFsResult', 'markDirty', 'setSelected', 'drainFsQueue'];

const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Editor is the default mode; both factories run during boot.
  await page.waitForFunction(
    () => typeof Editor === 'object' && Editor && typeof FileTree === 'object' && FileTree,
    { timeout: 30_000 },
  );

  // Editor / FileTree are top-level `const` in a classic <script>, i.e.
  // lexical bindings — not properties of globalThis. Reference the bare
  // identifiers so the live runtime objects resolve.
  const contract = await page.evaluate((editorMethods, fileTreeMethods) => {
    const shape = (obj, methods) => Object.fromEntries(
      methods.map((m) => [m, typeof obj?.[m]]),
    );
    return {
      editor: shape(Editor, editorMethods),
      fileTree: shape(FileTree, fileTreeMethods),
    };
  }, EDITOR_METHODS, FILETREE_METHODS);

  for (const m of EDITOR_METHODS) {
    a.check(`Editor.${m} is a function`,
      contract.editor[m] === 'function',
      `Editor.${m} is ${contract.editor[m]} (return-shape changed)`);
  }
  for (const m of FILETREE_METHODS) {
    a.check(`FileTree.${m} is a function`,
      contract.fileTree[m] === 'function',
      `FileTree.${m} is ${contract.fileTree[m]} (return-shape changed)`);
  }

  // Observable wiring: the Ctrl+P keystroke opens the command palette via
  // the document keydown handler → Editor.openPalette() →
  // #paletteOverlay.active. We dispatch the exact DOM keydown the user's
  // Ctrl+P produces (real page.keyboard input is intercepted by Monaco's
  // own CtrlCmd|KeyP command when its textarea holds focus, so it never
  // bubbles to the document handler — dispatching the keydown drives the
  // same handler the user's keystroke reaches when focus is outside the
  // editor, which is the path this assertion covers).
  const overlayBefore = await page.evaluate(
    () => document.getElementById('paletteOverlay')?.classList.contains('active') === true);
  a.check('command palette closed before Ctrl+P', overlayBefore === false,
    `paletteOverlay already active before Ctrl+P`);

  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForFunction(
    () => document.getElementById('paletteOverlay')?.classList.contains('active') === true,
    { timeout: 10_000 },
  ).catch(() => {});
  const overlayAfter = await page.evaluate(
    () => document.getElementById('paletteOverlay')?.classList.contains('active') === true);
  a.check('Ctrl+P opens the command palette (Editor.openPalette wired)',
    overlayAfter === true,
    `paletteOverlay did not activate after Ctrl+P keydown`);

  a.check('no page errors during editor boot + palette open',
    pageErrors.length === 0,
    JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
