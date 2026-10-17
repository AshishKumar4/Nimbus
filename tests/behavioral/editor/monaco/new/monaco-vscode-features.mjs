#!/usr/bin/env bun
// editor/monaco/new/monaco-vscode-features — the editor runs with the full
// VSCode-like options (not the bare initial config the first editor draft
// shipped, which the user flagged as "useless"), read from the live editor
// in a real Chrome after it opens a JavaScript file: minimap on the right,
// line numbers, bracket pair colors and guides, indent guides, full
// auto-indent, language-defined auto-closing, format on paste and type,
// smooth scrolling and caret, sticky scroll, two-space indentation in the
// opened file's model, Menlo/Monaco 14px, automatic layout, the dark theme.

import { BASE, mintSession, deleteSession, makeAsserter, requestHeaders } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

const a = makeAsserter('editor/monaco/new/monaco-vscode-features');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/features.js';
const browser = await launchBrowser();
try {
  // No indented line, so the model's indentation is the configured default, not one detected from the file.
  await box.files.write(path, 'const answer = 42;\n');
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor, { timeout: 60_000 });
  await page.locator(`.tree-node[data-path="${path}"]`).click();
  await page.waitForFunction(() => window.__nimbusMonacoEditor.getValue().startsWith('const answer'), { timeout: 30_000 });

  const live = await page.evaluate(() => {
    const editor = window.__nimbusMonacoEditor;
    const { EditorOption } = window.monaco.editor;
    const option = (name) => editor.getOption(EditorOption[name]);
    const raw = editor.getRawOptions();
    const model = editor.getModel().getOptions();
    return {
      minimap: option('minimap'),
      lineNumbers: raw.lineNumbers,
      bracketPairColorization: option('bracketPairColorization'),
      guides: option('guides'),
      autoIndent: raw.autoIndent,
      autoClosingBrackets: option('autoClosingBrackets'),
      autoClosingQuotes: option('autoClosingQuotes'),
      formatOnPaste: option('formatOnPaste'),
      formatOnType: option('formatOnType'),
      smoothScrolling: option('smoothScrolling'),
      cursorSmoothCaretAnimation: option('cursorSmoothCaretAnimation'),
      stickyScroll: option('stickyScroll'),
      tabSize: model.tabSize,
      insertSpaces: model.insertSpaces,
      fontFamily: option('fontFamily'),
      fontSize: option('fontSize'),
      automaticLayout: option('automaticLayout'),
      darkTheme: document.querySelector('#editorPanel .monaco-editor').classList.contains('vs-dark'),
    };
  });
  const expect = (name, ok) => a.check(`the editor runs with ${name}`, ok, JSON.stringify(live));
  expect('the minimap enabled, on the right', live.minimap.enabled === true && live.minimap.side === 'right');
  expect('line numbers on', live.lineNumbers === 'on');
  expect('bracket pair colorization', live.bracketPairColorization.enabled === true);
  expect('active bracket pair and indentation guides', live.guides.bracketPairs === 'active' && live.guides.indentation === true);
  expect('full auto-indent', live.autoIndent === 'full');
  expect('language-defined auto-closing brackets and quotes', live.autoClosingBrackets === 'languageDefined' && live.autoClosingQuotes === 'languageDefined');
  expect('format on paste and on type', live.formatOnPaste === true && live.formatOnType === true);
  expect('smooth scrolling and caret animation', live.smoothScrolling === true && live.cursorSmoothCaretAnimation === 'on');
  expect('sticky scroll', live.stickyScroll.enabled === true);
  expect('two-space indentation in a newly opened file', live.tabSize === 2 && live.insertSpaces === true);
  expect('Menlo, then Monaco, at 14px', /^Menlo,\s*Monaco/.test(live.fontFamily) && live.fontSize === 14);
  expect('automatic layout', live.automaticLayout === true);
  expect('the dark theme', live.darkTheme);
  a.check('no page errors while the editor opened the file', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
