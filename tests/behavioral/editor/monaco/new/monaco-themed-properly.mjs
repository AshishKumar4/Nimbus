#!/usr/bin/env bun
// editor/monaco/new/monaco-themed-properly — VSCode-equivalent chrome
// around the editor, in a real Chrome: the dark editor panel, the blue
// status bar with its cursor and language labels, and both labels
// following the editor (the user said "current is useless — make it
// nice"). The editor's own options are monaco-vscode-features'.

import { BASE, mintSession, deleteSession, makeAsserter, requestHeaders } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

const a = makeAsserter('editor/monaco/new/monaco-themed-properly');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/themed.js';
const browser = await launchBrowser();
try {
  await box.files.write(path, 'const a = 1;\nconst bc = 2;\n');
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor, { timeout: 60_000 });

  const chrome = await page.evaluate(() => {
    const visible = (id) => {
      const element = document.getElementById(id);
      const box = element?.getBoundingClientRect();
      return Boolean(box && box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden');
    };
    return {
      panel: getComputedStyle(document.getElementById('editorPanel')).backgroundColor,
      bar: getComputedStyle(document.getElementById('editorStatusBar')).backgroundColor,
      shown: ['editorStatusBar', 'editorStatusPos', 'editorStatusLang'].filter(visible),
    };
  });
  a.check('the editor panel is VSCode dark (#1e1e1e)', chrome.panel === 'rgb(30, 30, 30)', chrome.panel);
  a.check('the status bar is VSCode blue (#007acc)', chrome.bar === 'rgb(0, 122, 204)', chrome.bar);
  a.check('the status bar shows its cursor and language labels', chrome.shown.length === 3, JSON.stringify(chrome.shown));

  await page.locator(`.tree-node[data-path="${path}"]`).click();
  await page.waitForFunction(() => document.getElementById('editorStatusLang').textContent === 'javascript', { timeout: 30_000 });
  a.check('opening a JavaScript file shows its language', true);
  await page.evaluate(() => window.__nimbusMonacoEditor.setPosition({ lineNumber: 2, column: 3 }));
  await page.waitForFunction(() => document.getElementById('editorStatusPos').textContent === 'Ln 2, Col 3', { timeout: 10_000 });
  a.check('moving the cursor shows its line and column', true);
  await page.evaluate(() => window.monaco.editor.setModelLanguage(window.__nimbusMonacoEditor.getModel(), 'json'));
  await page.waitForFunction(() => document.getElementById('editorStatusLang').textContent === 'json', { timeout: 10_000 });
  a.check('changing the model\'s language shows the new one', true);
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
