#!/usr/bin/env bun
// file-tree/panel/new/file-tree-folder-expands — the lazy fs-list a
// folder click lists with (a directory at the root, its children, the
// reqId echoed), and, in a real Chrome, clicking a folder: its children
// show, a second click hides them, and a child opens in the editor.

import WebSocket from 'ws';
import { mintSession, deleteSession, BASE, WS_BASE, makeAsserter, sleep, wsHeaders, requestHeaders } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../../packages/sdk/src/index.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree/panel/new/file-tree-folder-expands');
console.log(`file-tree/panel/new/file-tree-folder-expands — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders(sid));
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

async function waitFor(reqId, type, timeoutMs = 8_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = messages.find(m => m.reqId === reqId && m.type === type);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

// Probe 1: root listing returns entries (incl. at least one dir).
ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 9000 }));
const rootRes = await waitFor(9000, 'fs-list-result');
a.check('root fs-list returns entries array',
  rootRes && Array.isArray(rootRes.entries) && rootRes.entries.length > 0,
  `result=${JSON.stringify(rootRes)}`);
const dirEntry = (rootRes?.entries || []).find(e => e.type === 'directory');
a.check('root listing contains at least one directory',
  dirEntry !== undefined,
  `entries=${JSON.stringify(rootRes?.entries?.slice(0, 5))}`);

// Probe 2: subdir listing returns children (or empty array if dir is empty).
if (dirEntry) {
  ws.send(JSON.stringify({ type: 'fs-list', dir: dirEntry.path, recursive: false, reqId: 9001 }));
  const subRes = await waitFor(9001, 'fs-list-result');
  a.check('subdir fs-list returns valid result shape',
    subRes && Array.isArray(subRes.entries),
    `result=${JSON.stringify(subRes)}`);
  a.check('subdir reqId echoed correctly',
    subRes && subRes.reqId === 9001,
    `reqId=${subRes?.reqId}`);
}

ws.close();

const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const folder = '/home/user/expand-dir';
const child = `${folder}/child.txt`;
await box.files.write(child, 'inside the folder\n');
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor, { timeout: 60_000 });
  const row = (path) => `.tree-node[data-path="${path}"]`;
  await page.locator(row(folder)).click();
  await page.waitForSelector(row(child), { visible: true, timeout: 30_000 });
  a.check('clicking a folder lists its children', true);
  await page.locator(row(folder)).click();
  await page.waitForSelector(row(child), { hidden: true, timeout: 10_000 });
  a.check('clicking it again hides them', true);
  await page.locator(row(folder)).click();
  await page.locator(row(child)).click();
  await page.waitForFunction((text) => window.__nimbusMonacoEditor.getValue() === text, { timeout: 30_000 }, 'inside the folder\n');
  a.check('a child of a reopened folder opens in the editor', true);
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
