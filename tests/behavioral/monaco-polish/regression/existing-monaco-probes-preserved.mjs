// monaco-polish/regression/existing-monaco-probes-preserved — after the
// monaco-polish wave, in a real Chrome:
//   - Editor public contract: ensureLoaded, openFile, save, openPalette,
//     tryHandleFsResult, drainFsQueue
//   - FileTree public contract: ensureLoaded, tryHandleFsResult,
//     markDirty, setSelected, drainFsQueue
//   - Ctrl+P opens the command palette
//
// The served-HTML shapes it once also sampled have one owner each: the
// Monaco options are editor/monaco/new/monaco-vscode-features'; the
// Ctrl+P / Ctrl+S handlers are ctrl-p-opens-file's and ctrl-s-saves-file's;
// the FileTree module and the editor-mode tree CSS are
// file-tree/panel/new/file-tree-renders'; the left-stack layout is
// file-tree/panel/regression/editor-with-term-layout-still-works'; the fs-*
// protocol is driven live by editor/monaco/new/fs-protocol-read-write.
//
// The Editor and FileTree public-method contract is asserted as OBSERVABLE
// behavior: the factories produce live runtime objects exposing the
// required methods as functions, and Ctrl+P actually opens the command
// palette via Editor.openPalette. An exact-closing-brace source regex was
// brittle here — the real returns carry a superset of methods
// (Editor also exposes invalidateFileListCache / openDefaultWelcome /
// refreshMarkdownPreview; FileTree also exposes subscribeOnce /
// applyWatchEvent / getWatchStats), so the brace regex missed them even
// though the asserted methods are all present and wired. The live check
// is the source of truth for the public contract.

import { mintSession, BASE, makeAsserter, deleteSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/regression/existing-monaco-probes-preserved');
console.log(`monaco-polish/regression/existing-monaco-probes-preserved — ${process.env.BASE}`);

const sid = await mintSession();

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
