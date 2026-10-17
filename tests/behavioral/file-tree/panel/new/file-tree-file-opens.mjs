#!/usr/bin/env bun
// file-tree/panel/new/file-tree-file-opens — the fs-read a tree click
// opens a file with, and, in a real Chrome, switching files with unsaved
// changes: the shell asks, OK saves the edit and switches, Cancel discards
// it and switches. Opening a clicked file and selecting its row are
// monaco-polish/regression/existing-monaco-probes-preserved's.

import WebSocket from 'ws';
import { mintSession, deleteSession, BASE, WS_BASE, makeAsserter, sleep, wsHeaders, requestHeaders } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree/panel/new/file-tree-file-opens');
console.log(`file-tree/panel/new/file-tree-file-opens — ${process.env.BASE}`);

const sid = await mintSession();

// Protocol-level — fs-read on a known starter file.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders(sid));
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

// First list root to find a file we can read.
ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 8000 }));
let listRes = null;
const tList = Date.now();
while (Date.now() - tList < 8_000) {
  listRes = messages.find(m => m.reqId === 8000 && m.type === 'fs-list-result');
  if (listRes) break;
  await sleep(40);
}
a.check('fs-list root succeeded',
  listRes && Array.isArray(listRes.entries),
  `result=${JSON.stringify(listRes)}`);

const file = (listRes?.entries || []).find(e => e.type === 'file');
if (file) {
  ws.send(JSON.stringify({ type: 'fs-read', path: file.path, reqId: 8001 }));
  let readRes = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    readRes = messages.find(m => m.reqId === 8001 && m.type === 'fs-read-result');
    if (readRes) break;
    await sleep(40);
  }
  a.check('fs-read on tree-clicked file returns content (or binary marker)',
    readRes && (readRes.content !== undefined || readRes.binary === true),
    `result=${JSON.stringify(readRes)}`);
}

ws.close();

const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const first = '/home/user/switch-first.txt';
const second = '/home/user/switch-second.txt';
await box.files.write(first, 'first\n');
await box.files.write(second, 'second\n');
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor, { timeout: 60_000 });
  const open = async (path, content) => {
    await page.locator(`.tree-node[data-path="${path}"]`).click();
    await page.waitForFunction((text) => window.__nimbusMonacoEditor.getValue() === text, { timeout: 30_000 }, content);
  };
  /** Type `text` at the start of the open file, then switch to `second`, answering the shell's question with `accept`. */
  const editAndSwitch = async (text, accept) => {
    await page.click('#editorPanel .monaco-editor .view-lines');
    await page.keyboard.down('Control');
    await page.keyboard.press('Home');
    await page.keyboard.up('Control');
    await page.keyboard.type(text);
    const asked = new Promise((resolve) => page.once('dialog', async (dialog) => {
      resolve(dialog.message());
      await (accept ? dialog.accept() : dialog.dismiss());
    }));
    await page.locator(`.tree-node[data-path="${second}"]`).click();
    const question = await Promise.race([asked, sleep(10_000).then(() => null)]);
    await page.waitForFunction((content) => window.__nimbusMonacoEditor.getValue() === content, { timeout: 30_000 }, 'second\n');
    return question;
  };

  await open(first, 'first\n');
  const saveQuestion = await editAndSwitch('saved-', true);
  a.check('switching away from unsaved changes asks about them', /Unsaved changes in \/home\/user\/switch-first\.txt/.test(saveQuestion ?? ''), JSON.stringify(saveQuestion));
  a.check('OK saves the edit and switches', await box.files.read(first) === 'saved-first\n'
    && await page.$eval(`.tree-node[data-path="${second}"]`, (row) => row.classList.contains('selected')), await box.files.read(first));

  await open(first, 'saved-first\n');
  const discardQuestion = await editAndSwitch('dropped-', false);
  a.check('Cancel discards the edit and switches', discardQuestion !== null && await box.files.read(first) === 'saved-first\n', await box.files.read(first));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
